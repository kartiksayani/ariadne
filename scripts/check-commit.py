#!/usr/bin/env python3
"""Local commit gates. Planning checks never substitute for application coverage."""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APPLICATION_ROOTS = ("apps", "crates", "integrations")
SOURCE_EXTENSIONS = {".rs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"}
COVERAGE_TOOLING = {
    "apps/desktop/vite.config.ts",
    "apps/desktop/wdio.native.conf.mjs",
    "apps/desktop/src-tauri/build.rs",
}
APPLICATION_REPORTS = ("coverage/rust.lcov", "coverage/web/lcov.info")
EXCLUDED_PARTS = {"generated", "vendor", "node_modules", "tests", "__tests__"}
TEST_SUFFIXES = (".d.ts", ".d.mts", ".d.cts") + tuple(f".{kind}.{ext}" for kind in ("test", "spec") for ext in ("ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"))


def run(*args, capture=False):
    return subprocess.run(
        [*(["rtk", "proxy"] if shutil.which("rtk") else []), *map(str, args)], cwd=ROOT, check=True,
        text=True, stdout=subprocess.PIPE if capture else None,
    )


def require_staged_tree():
    unstaged = run("git", "diff", "--name-only", capture=True).stdout
    untracked = run("git", "ls-files", "--others", "--exclude-standard", capture=True).stdout
    if unstaged or untracked:
        raise ValueError("Stage intended changes first. Commit checks require the tested tree to match the index; no automatic stash is used.")


def require_modern_npm():
    version = run("npm", "--version", capture=True).stdout.strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", version) or tuple(map(int, version.split("."))) < (10, 9, 8):
        raise ValueError(f"Application gates require npm >=10.9.8; received {version!r}")


def application_present(root, config):
    if (root / "Cargo.toml").exists():
        return True
    return any(
        path.suffix in SOURCE_EXTENSIONS
        for folder in APPLICATION_ROOTS
        for path in (root / folder).rglob("*")
        if path.is_file()
    )


def application_sources(root):
    """Inventory recursively; never follow a source outside the repository."""
    sources = set()
    for folder in APPLICATION_ROOTS:
        if not (root / folder).resolve().is_relative_to(root.resolve()):
            raise ValueError(f"Application path escapes repository: {folder}")
        for path in (root / folder).rglob("*"):
            relative = path.relative_to(root)
            if any(part in EXCLUDED_PARTS for part in relative.parts):
                continue
            if not path.resolve().is_relative_to(root.resolve()):
                raise ValueError(f"Application path escapes repository: {relative}")
            if path.is_file() and path.suffix in SOURCE_EXTENSIONS and not path.name.endswith(TEST_SUFFIXES):
                sources.add(str(relative))
    return sources


def coverage_policy(root, config):
    """Validate narrow classifications against the actual current source bytes."""
    sources = application_sources(root)
    boundaries = config.get("non_executable_sources", [])
    tooling = config.get("coverage_tooling", [])
    if not isinstance(boundaries, list) or not isinstance(tooling, list):
        raise ValueError("Coverage classifications must be lists")
    verified = set()
    for entry in boundaries:
        if (not isinstance(entry, dict) or set(entry) != {"path", "sha256", "reason"}
                or not all(isinstance(value, str) for value in entry.values())
                or entry["reason"] != "comment-only-rust-package-boundary"
                or not re.fullmatch(r"crates/[A-Za-z0-9_-]+/src/lib\.rs", entry["path"])
                or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"])):
            raise ValueError("Invalid non-executable source classification")
        name = entry["path"]
        if name in verified or name not in sources:
            raise ValueError(f"Duplicate or missing non-executable source: {name}")
        source = root / name
        if not (source.parent.parent / "Cargo.toml").is_file():
            raise ValueError(f"Non-executable source must be a Rust package boundary: {name}")
        contents = source.read_bytes()
        if hashlib.sha256(contents).hexdigest() != entry["sha256"]:
            raise ValueError(f"Non-executable source hash changed: {name}")
        if any(line.strip() and not line.lstrip().startswith("//") for line in contents.decode().splitlines()):
            raise ValueError(f"Non-executable source contains Rust code: {name}")
        verified.add(name)
    if (any(not isinstance(name, str) or name not in COVERAGE_TOOLING or name not in sources for name in tooling)
            or len(set(tooling)) != len(tooling)):
        raise ValueError("Coverage tooling must name distinct existing allowlisted files")
    return sources, verified, set(tooling)


def append_non_executable_records(report, root, config):
    """Add honest zero-line evidence after a fresh Rust report has been produced."""
    _, verified, _ = coverage_policy(root, config)
    # Opening an absent report must fail; do not manufacture an entire report.
    contents = report.read_text()
    records = "".join(f"SF:{name}\nLF:0\nLH:0\nend_of_record\n" for name in sorted(verified))
    if records:
        report.write_text(contents + ("\n" if contents and not contents.endswith("\n") else "") + records)


def coverage_counts(paths, root=None, config=None):
    """Merge by source/line, so duplicated LCOV records never inflate coverage."""
    expected, verified, tooling = coverage_policy(root, config or {}) if root is not None else (set(), set(), set())
    lines, reported = {}, set()
    for path in paths:
        source = None
        report_lines = 0
        record_lines = 0
        fields = []
        for raw in path.read_text().splitlines():
            if raw.startswith("SF:"):
                if source is not None:
                    raise ValueError(f"Unterminated LCOV record: {path}")
                source = raw[3:]
                record_lines, fields = 0, []
                if root is not None:
                    resolved = (root / source).resolve()
                    relative = resolved.relative_to(root.resolve())
                    source = str(relative)
                    if source not in expected or source in tooling:
                        raise ValueError(f"Coverage source is not application code: {source}")
            elif raw == "end_of_record":
                if source is None or (not record_lines and (source not in verified or fields != ["LF:0", "LH:0"])):
                    raise ValueError(f"Missing executable line data in LCOV record: {path}")
                reported.add(source)
                source = None
            elif raw.startswith("DA:"):
                if not source:
                    raise ValueError(f"LCOV line without source: {path}")
                if source in verified:
                    raise ValueError(f"Non-executable source has executable line data: {source}")
                number, hits, *_ = raw[3:].split(",")
                number, hits = int(number), int(hits)
                if number < 1 or hits < 0:
                    raise ValueError(f"Invalid LCOV count: {path}")
                if root is not None and number > len((root / source).read_text().splitlines()):
                    raise ValueError(f"Coverage line exceeds source length: {source}:{number}")
                key = (source, number)
                lines[key] = lines.get(key, False) or hits > 0
                report_lines += 1
                record_lines += 1
            elif source is not None:
                fields.append(raw)
        if source is not None or not report_lines:
            raise ValueError(f"Missing executable line data: {path}")
    if not lines:
        raise ValueError("No coverage reports supplied")
    missing = expected - tooling - reported
    if missing:
        raise ValueError(f"Coverage omits application sources: {', '.join(sorted(missing))}")
    return sum(lines.values()), len(lines)


def validate_phase(config, has_application):
    if config["phase"] not in {"planning", "application"}:
        raise ValueError("Unknown quality gate phase")
    if "production_roots" in config and tuple(config["production_roots"]) != APPLICATION_ROOTS:
        raise ValueError("Canonical production roots cannot be omitted")
    if "application_reports" in config and tuple(config["application_reports"]) != APPLICATION_REPORTS:
        raise ValueError("Both canonical Rust and web coverage reports are required")
    floor = config["minimum_line_coverage"]
    if not isinstance(floor, (int, float)) or not 80 <= floor <= 100:
        raise ValueError("The agreed coverage floor is 80%; configured values must be between 80 and 100")
    if has_application and config["phase"] != "application":
        raise ValueError("Application code detected: activate application gates before committing it.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--working-tree", action="store_true",
                        help="Check local edits without committing; hook never uses this option")
    parser.add_argument("--ci", action="store_true", help="Check an isolated CI checkout")
    args = parser.parse_args(argv)
    if not args.working_tree and not args.ci:
        require_staged_tree()
        run(sys.executable, "scripts/check-change.py", "--staged")
    config = json.loads((ROOT / "quality-gates.json").read_text())
    validate_phase(config, application_present(ROOT, config))
    coverage_policy(ROOT, config)
    if config["phase"] == "application":
        require_modern_npm()
    run("git", "diff", "--check")
    run("git", "diff", "--cached", "--check")
    local_ruff = ROOT / ".venv-quality/bin/ruff"
    ruff = str(local_ruff) if local_ruff.exists() else shutil.which("ruff")
    if not ruff:
        raise ValueError("Install requirements-dev.txt into .venv-quality; Ruff is required, not skipped.")
    run(ruff, "check", ".")
    run("node", ROOT / "node_modules/eslint/bin/eslint.js", ".", "--max-warnings=0")
    python = ROOT / ".venv-quality/bin/python"
    if not python.exists():
        python = sys.executable
    run(python, "-m", "coverage", "run", "--include=scripts/check-commit.py,scripts/check-change.py,scripts/delivery*.py",
        "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py")
    run(python, "-m", "coverage", "report", "--fail-under=80")
    if (ROOT / "docs/planning").exists():
        run(sys.executable, "scripts/validate-planning.py")
    for folder in ("poc/claude-mods", "poc/codex-queue"):
        if not (ROOT / folder).exists():
            continue
        run(sys.executable, "-m", "unittest", "discover", "-s", folder, "-p", "test_*.py")
    if config["phase"] == "application":
        reports = [ROOT / name for name in APPLICATION_REPORTS]
        # A stale report must never pass after a test command failed to emit one.
        for report in reports:
            report.unlink(missing_ok=True)
        (ROOT / "coverage").mkdir(exist_ok=True)
        run("cargo", "fmt", "--all", "--", "--check")
        run("cargo", "clippy", "--workspace", "--all-targets", "--all-features", "--", "-D", "warnings")
        run("npm", "run", "lint")
        run("cargo", "llvm-cov", "--workspace", "--all-features", "--lcov", "--output-path", reports[0])
        append_non_executable_records(reports[0], ROOT, config)
        run("npm", "run", "test:coverage")
        run("npm", "run", "test:e2e")
        covered, total = coverage_counts(reports, ROOT, config)
        percentage = 100 * covered / total
        print(f"Application line coverage: {covered}/{total} = {percentage:.2f}%")
        if 100 * covered < config["minimum_line_coverage"] * total:
            raise ValueError("Application coverage is below the configured minimum")
    else:
        print("Planning checks passed. Application coverage: N/A (no application source yet).")
    if not args.working_tree and not args.ci:
        require_staged_tree()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        print(f"Commit checks failed: {error}", file=sys.stderr)
        sys.exit(1)
