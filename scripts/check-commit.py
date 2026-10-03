#!/usr/bin/env python3
"""Cheap commit checks; path-scoped quality checks on the pushed head."""
import argparse
import fnmatch
import json
import re
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APPLICATION_ROOTS = ("apps", "crates", "integrations")
SOURCE_EXTENSIONS = {".rs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"}
APPLICATION_REPORTS = ("coverage/rust.lcov", "coverage/web/lcov.info")
EXCLUDED_PARTS = {"generated", "vendor", "node_modules", "tests", "__tests__"}
TEST_SUFFIXES = (".d.ts", ".d.mts", ".d.cts") + tuple(
    f".{kind}.{ext}" for kind in ("test", "spec")
    for ext in ("ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"))
DOC_FILES = {"AGENTS.md", "CONTRIBUTING.md", "ORCHESTRATOR.md", "README.md", "DECISIONS.md", "LICENSE"}
FULL_FILES = {"quality-gates.json", "scripts/check-commit.py", "tests/test_commit_checks.py",
              "tests/test_quality_workflow.py", "scripts/run-native-e2e.mjs",
              "scripts/check-release-boundary.mjs", "tests/test_process_contract.py"}
RELEASE_FILES = FULL_FILES | {"Cargo.toml", "Cargo.lock", "package.json", "package-lock.json",
                            "rust-toolchain.toml", ".node-version", "Makefile", "eslint.config.mjs",
                            "apps/desktop/src/main.tsx"}


def run(*args, capture=False, input=None):
    return subprocess.run(list(map(str, args)), cwd=ROOT, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None, input=input)


def changed_paths(base=None, working_tree=False):
    """No rename collapsing: inspect both old/deleted and new paths."""
    if base is not None:
        try:
            run("git", "rev-parse", "--verify", base + "^{commit}", capture=True)
            raw = run("git", "diff", "--no-renames", "--name-only", "-z", base, "HEAD", capture=True).stdout
        except subprocess.CalledProcessError:
            return None
    else:
        raw = run("git", "diff", "--cached", "--no-renames", "--name-only", "-z", capture=True).stdout
        if working_tree:
            raw += run("git", "diff", "--no-renames", "--name-only", "-z", capture=True).stdout
            raw += run("git", "ls-files", "--others", "--exclude-standard", "-z", capture=True).stdout
    return sorted(set(filter(None, raw.split("\0"))))


def scope_for(paths):
    if paths is None:
        return "application", True
    scope, release = "docs", False
    for name in paths:
        if (name in RELEASE_FILES or name.startswith((".github/", ".githooks/", "apps/desktop/src-tauri/"))
                or (name.startswith(("apps/", "crates/", "integrations/")) and
                    (Path(name).name in {"Cargo.toml", "build.rs", "package.json", "package-lock.json"} or
                     "/capabilities/" in name or "config" in Path(name).name or
                     name.endswith((".json", ".mjs", ".html", ".css"))))):
            release = True
        if name in FULL_FILES or name in RELEASE_FILES or name.startswith(
                ("apps/", "crates/", "integrations/", ".github/", ".githooks/")):
            scope = "application"
        elif name.startswith(("scripts/", "tests/", "tools/")) or name in {"requirements-dev.txt", "pyproject.toml", ".gitignore"}:
            if scope == "docs":
                scope = "tooling"
        elif name in DOC_FILES or name.startswith(("docs/", "designs/")):
            pass
        else:
            return "application", True
    return scope, release


def application_sources(root):
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
    """Explicit reviewed exclusions, not AST or dependency classification."""
    sources = application_sources(root)
    excluded = {name for name in sources if any(
        fnmatch.fnmatchcase(name, pattern) for pattern in config.get("coverage_exclusions", []))}
    return sources, excluded


def coverage_counts(paths, root=None, config=None):
    expected, excluded = coverage_policy(root, config or {}) if root else (set(), set())
    lines, reported = {}, set()
    for path in paths:
        source, record_lines, report_lines = None, 0, 0
        for raw in path.read_text().splitlines():
            if raw.startswith("SF:"):
                if source is not None:
                    raise ValueError(f"Unterminated LCOV record: {path}")
                source, record_lines = raw[3:], 0
                if root:
                    source = str((root / source).resolve().relative_to(root.resolve()))
                    if source not in expected:
                        raise ValueError(f"Coverage source is not application code: {source}")
                    if path.stat().st_mtime_ns < (root / source).stat().st_mtime_ns:
                        raise ValueError(f"Stale coverage report: {source}")
            elif raw.startswith("DA:"):
                if source is None:
                    raise ValueError(f"LCOV line without source: {path}")
                number, hits, *_ = raw[3:].split(",")
                number, hits = int(number), int(hits)
                if number < 1 or hits < 0:
                    raise ValueError(f"Invalid LCOV count: {path}")
                if root and number > len((root / source).read_text().splitlines()):
                    raise ValueError(f"Coverage line exceeds source length: {source}:{number}")
                if source not in excluded:
                    key = (source, number)
                    lines[key] = lines.get(key, False) or hits > 0
                    report_lines += 1
                record_lines += 1
            elif raw == "end_of_record":
                if source is None or not record_lines:
                    raise ValueError(f"Missing executable line data in LCOV record: {path}")
                reported.add(source)
                source = None
        if source is not None or not report_lines:
            raise ValueError(f"Missing executable line data: {path}")
    missing = expected - excluded - reported
    if missing:
        raise ValueError(f"Coverage omits application sources: {', '.join(sorted(missing))}")
    if not lines:
        raise ValueError("No coverage reports supplied")
    return sum(lines.values()), len(lines)


class InlineScripts(HTMLParser):
    """Pass maintained inline JavaScript to ordinary ESLint."""
    def __init__(self):
        super().__init__()
        self.active = False
        self.scripts = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script":
            self.active = "src" not in attrs and attrs.get("type", "") not in {"application/json", "application/ld+json"}

    def handle_endtag(self, tag):
        if tag == "script":
            self.active = False

    def handle_data(self, data):
        if self.active:
            self.scripts.append(data)


def lint(paths, full=False):
    existing = [ROOT / name for name in paths if (ROOT / name).is_file()]
    run("git", "diff", "--check")
    run("git", "diff", "--cached", "--check")
    if full or any(path.suffix == ".py" or path.name in {"pyproject.toml", "requirements-dev.txt"} for path in existing):
        ruff = ROOT / ".venv-quality/bin/ruff"
        run(str(ruff) if ruff.exists() else "ruff", "check", ".")
    js = {".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"}
    if full or any(path.suffix in js for path in existing):
        run("node", ROOT / "node_modules/eslint/bin/eslint.js", ".", "--max-warnings=0")
    html = sorted((ROOT / "docs").rglob("*.html")) if full else [p for p in existing if p.suffix == ".html"]
    for path in html:
        parser = InlineScripts()
        parser.feed(path.read_text())
        if parser.scripts:
            run("node", ROOT / "node_modules/eslint/bin/eslint.js", "--stdin",
                "--stdin-filename", "planning-inline.mjs", "--max-warnings=0", input="\n".join(parser.scripts))
    if full or any(path.suffix == ".rs" for path in existing):
        run("cargo", "fmt", "--all", "--", "--check")
    if full or any(path.suffix in {".ts", ".tsx", ".mts", ".cts", ".css"} or path.name.startswith("tsconfig") for path in existing):
        run("npm", "run", "check")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--working-tree", action="store_true")
    parser.add_argument("--ci", action="store_true")
    parser.add_argument("--base", help="CI comparison commit; missing/unavailable means full checks")
    parser.add_argument("--full", action="store_true", help="All tests plus release isolation")
    parser.add_argument("--print-scope", action="store_true")
    args = parser.parse_args(argv)
    paths = changed_paths(args.base, args.working_tree) if args.base or not args.ci else None
    scope, release = scope_for(paths)
    if args.full:
        scope, release = "application", True
    if args.print_scope:
        print(f"{scope} release={str(release).lower()}")
        return
    lint(paths or [], full=(args.ci or args.full) and scope == "application")
    if args.ci or args.full or any(name in {"docs/delivery/tasks.json", "docs/planning/roadmap.html"} for name in paths or []):
        run(sys.executable, "scripts/regenerate-roadmap.py", "--check")
    if not (args.ci or args.full):
        print("Changed-language commit checks passed.")
        return
    print(f"Quality scope: {scope}; release isolation: {release}", flush=True)
    if scope != "docs":
        run(sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py")
    if scope == "application":
        config = json.loads((ROOT / "quality-gates.json").read_text())
        floor = config["minimum_line_coverage"]
        if not isinstance(floor, (int, float)) or not 80 <= floor <= 100:
            raise ValueError("Application coverage floor must be at least 80%")
        reports = [ROOT / name for name in APPLICATION_REPORTS]
        for report in reports:
            report.unlink(missing_ok=True)
        (ROOT / "coverage").mkdir(exist_ok=True)
        run("npm", "run", "build")
        run("cargo", "build", "--workspace", "--locked", "--all-features")
        run("cargo", "clippy", "--workspace", "--all-targets", "--all-features", "--", "-D", "warnings")
        run("env", "CARGO_LLVM_COV_DENY_WARNINGS=1", "cargo", "llvm-cov", "clean", "--workspace", "--locked", "--offline")
        ignored = "(^|/)(tools|generated|vendor|tests|__tests__)/|" + "|".join(
            re.escape(name).replace(r"\*", ".*").replace(r"\?", ".") + "$"
            for name in config["coverage_exclusions"])
        run("cargo", "llvm-cov", "--workspace", "--all-features", "--locked", "--lcov",
            "--ignore-filename-regex", ignored, "--output-path", reports[0])
        run("npm", "run", "test:coverage")
        covered, total = coverage_counts(reports, ROOT, config)
        print(f"Application line coverage: {covered}/{total} = {100 * covered / total:.2f}%", flush=True)
        if 100 * covered < floor * total:
            raise ValueError("Application coverage is below the configured minimum")
        run("npm", "run", "test:e2e" if release else "test:native")
    print(f"Quality checks passed ({scope}).")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        print(f"Quality checks failed: {error}", file=sys.stderr)
        sys.exit(1)
