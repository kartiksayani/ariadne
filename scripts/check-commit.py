#!/usr/bin/env python3
"""Local commit gates. Planning checks never substitute for application coverage."""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APPLICATION_ROOTS = ("apps", "crates", "integrations")
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


def application_present(root, config):
    if (root / "Cargo.toml").exists():
        return True
    extensions = {".rs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"}
    return any(
        path.suffix in extensions
        for folder in APPLICATION_ROOTS
        for path in (root / folder).rglob("*")
        if path.is_file()
    )


def coverage_counts(paths, root=None):
    """Merge by source/line, so duplicated LCOV records never inflate coverage."""
    lines = {}
    for path in paths:
        source = None
        report_lines = 0
        for raw in path.read_text().splitlines():
            if raw.startswith("SF:"):
                source = raw[3:]
                if root is not None:
                    resolved = (root / source).resolve()
                    relative = resolved.relative_to(root.resolve())
                    if (relative.parts[0] not in APPLICATION_ROOTS or not resolved.is_file()
                            or resolved.suffix not in {".rs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"}
                            or any(part in EXCLUDED_PARTS for part in relative.parts)
                            or resolved.name.endswith(TEST_SUFFIXES)):
                        raise ValueError(f"Coverage source is not application code: {source}")
                    source = str(relative)
            elif raw == "end_of_record":
                source = None
            elif raw.startswith("DA:"):
                if not source:
                    raise ValueError(f"LCOV line without source: {path}")
                number, hits, *_ = raw[3:].split(",")
                number, hits = int(number), int(hits)
                if number < 1 or hits < 0:
                    raise ValueError(f"Invalid LCOV count: {path}")
                if root is not None and number > len((root / source).read_text().splitlines()):
                    raise ValueError(f"Coverage line exceeds source length: {source}:{number}")
                key = (source, number)
                lines[key] = lines.get(key, False) or hits > 0
                report_lines += 1
        if not report_lines:
            raise ValueError(f"Missing executable line data: {path}")
    if not lines:
        raise ValueError("No coverage reports supplied")
    if root is not None:
        reported = {source for source, _ in lines}
        expected = {
            str(path.relative_to(root))
            for folder in APPLICATION_ROOTS for path in (root / folder).rglob("*")
            if path.is_file() and path.suffix in {".rs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"}
            and not any(part in EXCLUDED_PARTS for part in path.relative_to(root).parts)
            and not path.name.endswith(TEST_SUFFIXES)
        }
        if expected - reported:
            raise ValueError(f"Coverage omits application sources: {', '.join(sorted(expected - reported))}")
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
    run("git", "diff", "--check")
    run("git", "diff", "--cached", "--check")
    local_ruff = ROOT / ".venv-quality/bin/ruff"
    ruff = str(local_ruff) if local_ruff.exists() else shutil.which("ruff")
    if not ruff:
        raise ValueError("Install requirements-dev.txt into .venv-quality; Ruff is required, not skipped.")
    run(ruff, "check", ".")
    run("npm", "run", "lint:planning")
    python = ROOT / ".venv-quality/bin/python"
    if not python.exists():
        python = sys.executable
    run(python, "-m", "coverage", "run", "--include=scripts/check-commit.py,scripts/check-change.py",
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
        run("npm", "run", "test:coverage")
        run("npm", "run", "test:e2e")
        covered, total = coverage_counts(reports, ROOT)
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
