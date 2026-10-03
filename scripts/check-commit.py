#!/usr/bin/env python3
"""Local commit gates. Planning checks never substitute for application coverage."""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tomllib
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
DECLARATION_REASON = "uninstrumented-rust-declarations-v1"
TOOL_PACKAGES = {"ariadne-coverage-inventory": "tools/coverage-inventory", "ariadne-xtask": "tools/xtask"}
REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"
SYN_IDENTITY = ("2.0.119", "872831b642d1a07999a962a351ed35b955ea2cfc8f3862091e2a240a84f17297")
DERIVE_IDENTITIES = {
    "serde": ("1.0.228", "9a8e94ea7f378bd32cbbd37198a4a91436180c5bb472411e48b5ec2e2124ae9e",
              "serde_derive", "d540f220d3187173da220f885ab66608367b6574e925011a9353e4badda91d79"),
    "schemars": ("1.2.2", "687274d293b6cdc6e73e0fee520bf2049650090d7164f87672d212a3c530cf4a",
                 "schemars_derive", "d98c67716b46af2f0b8cf752abc930f6f9aecfbf671ecfb531db8a31dbe4e2ba"),
    "ts-rs": ("12.0.1", "756050066659291d47a554a9f558125db17428b073c5ffce1daf5dcb0f7231d8",
              "ts-rs-macros", "38d90eea51bc7988ef9e674bf80a85ba6804739e535e9cab48e4bb34a8b652aa"),
}
EXCLUDED_PARTS = {"generated", "vendor", "node_modules", "tests", "__tests__"}
TEST_SUFFIXES = (".d.ts", ".d.mts", ".d.cts") + tuple(f".{kind}.{ext}" for kind in ("test", "spec") for ext in ("ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"))


def run(*args, capture=False, input=None):
    return subprocess.run(
        [*(["rtk", "proxy"] if shutil.which("rtk") else []), *map(str, args)], cwd=ROOT, check=True,
        text=True, stdout=subprocess.PIPE if capture else None, input=input,
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


def cargo_metadata(root):
    return json.loads(run("cargo", "metadata", "--format-version=1", "--locked", "--all-features",
                          "--manifest-path", root / "Cargo.toml", capture=True).stdout)


def verify_parser_identity(root, helper, metadata):
    version, checksum = SYN_IDENTITY
    dependencies = [d for d in helper["dependencies"] if d["name"] == "syn" and not d.get("rename")]
    node = next(n for n in metadata["resolve"]["nodes"] if n["id"] == helper["id"])
    bindings = {d["pkg"] for d in node["deps"] if d["name"] == "syn"}
    packages = [p for p in metadata["packages"] if p["id"] in bindings]
    lock = tomllib.loads((root / "Cargo.lock").read_text())["package"]
    if (len(dependencies) != 1 or dependencies[0]["req"] != "=" + version
            or "full" not in dependencies[0]["features"] or len(packages) != 1
            or packages[0]["name"] != "syn" or packages[0]["version"] != version or packages[0]["source"] != REGISTRY
            or not any(p["name"] == "syn" and p["version"] == version and p.get("source") == REGISTRY
                       and p.get("checksum") == checksum for p in lock)):
        raise ValueError("AST helper requires its exact verified syn registry identity")


def tool_packages(root, metadata):
    """Verify exact ownership and every declared dependency before report exclusions."""
    root = root.resolve()
    manifest = root / "Cargo.toml"
    config = tomllib.loads(manifest.read_text()) if manifest.exists() else {}
    overrides = [*config.get("patch", {}).values(), config.get("replace", {})]
    for table in overrides:
        for override in table.values():
            if isinstance(override, dict) and "path" in override:
                target = (root / override["path"]).resolve()
                if any(target.is_relative_to(root / folder) for folder in TOOL_PACKAGES.values()):
                    raise ValueError("Local Cargo override targets coverage-excluded tooling")
                raise ValueError("Local Cargo patch/replace overrides are unsupported by coverage isolation")
    packages = {package["id"]: package for package in metadata["packages"]}
    tools = []
    for identity in metadata["workspace_members"]:
        package = packages[identity]
        manifest = Path(package["manifest_path"])
        if manifest != manifest.resolve() or not manifest.is_file():
            raise ValueError("Workspace manifest is missing or symlinked")
        relative = manifest.relative_to(root)
        production = relative.parts[0] in APPLICATION_ROOTS
        if not production:
            name = package["name"]
            if (name not in TOOL_PACKAGES or relative != Path(TOOL_PACKAGES[name]) / "Cargo.toml"
                    or package["source"] is not None or any(tool["name"] == name for tool in tools)):
                raise ValueError("Workspace tooling must have its exact approved package identity")
            for target in package["targets"]:
                source = Path(target["src_path"])
                if (source != source.resolve() or not source.is_file()
                        or not source.is_relative_to(manifest.parent)
                        or not set(target["kind"]) <= {"lib", "bin", "test"}):
                    raise ValueError("Tool target has unapproved kind or source ownership")
            tools.append(package)
    for package in packages.values():
        if package["name"] in TOOL_PACKAGES and package["id"] not in {tool["id"] for tool in tools}:
            raise ValueError("Duplicate or non-workspace tooling package identity")
    nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
    tool_ids = {p["id"] for p in packages.values() if any(
        Path(p["manifest_path"]).resolve().is_relative_to(root / folder) for folder in TOOL_PACKAGES.values())}
    # Declared metadata includes inactive optional and target/dev/build dependencies.
    # Resolve by exact declared path/source/name/version identity, not active edges alone.
    edges = {}
    for identity, package in packages.items():
        edges[identity] = set()
        for dependency in package["dependencies"]:
            name = (dependency.get("rename") or dependency["name"]).replace("-", "_")
            matches = [edge["pkg"] for edge in nodes.get(identity, {}).get("deps", []) if edge["name"] == name]
            if dependency.get("path"):
                location = Path(dependency["path"]).resolve() / "Cargo.toml"
                candidates = [p["id"] for p in packages.values() if Path(p["manifest_path"]).resolve() == location]
                if not candidates:
                    raise ValueError("Unresolved declared path dependency could reach tooling")
                matches.extend(candidates)
            elif not matches and dependency["name"] in TOOL_PACKAGES:
                raise ValueError("Unresolved dependency could substitute tooling")
            edges[identity].update(matches)
    for identity in metadata["workspace_members"]:
        if identity in tool_ids:
            continue
        pending, visited = [identity], set()
        while pending:
            current = pending.pop()
            if current in tool_ids:
                raise ValueError("Application dependency reaches coverage-excluded tooling")
            if current not in visited:
                visited.add(current)
                pending.extend(edges.get(current, ()))
    for tool in tools:
        if tool["name"] == "ariadne-coverage-inventory":
            verify_parser_identity(root, tool, metadata)
    return tools


def validate_declarations(root, names, sources):
    for name in names:
        if any((root / Path(*Path(name).parts[:index])).is_symlink() for index in range(1, len(Path(name).parts) + 1)):
            raise ValueError("Declaration module chain must not contain symlinks")
    metadata = cargo_metadata(root)
    tools = tool_packages(root, metadata)
    helper = next((tool for tool in tools if tool["name"] == "ariadne-coverage-inventory"), None)
    if helper is None:
        raise ValueError("Rust declaration classification requires the verified AST helper")
    production = [p for p in metadata["packages"] if p["id"] in metadata["workspace_members"]
                  and Path(p["manifest_path"]).relative_to(root.resolve()).parts[0] in APPLICATION_ROOTS]
    roots = [str(Path(t["src_path"]).relative_to(root.resolve())) for p in production for t in p["targets"]
             if set(t["kind"]) & {"lib", "rlib", "cdylib", "staticlib"}]
    request = {"sources": {name: (root / name).read_text() for name in sorted(names)},
               "roots": roots, "inventory": sorted(sources)}
    response = json.loads(run("cargo", "run", "--quiet", "--locked", "--package", helper["id"], "--",
                              capture=True, input=json.dumps(request)).stdout)
    if set(response) != names:
        raise ValueError("AST helper returned incomplete declaration inventory")
    lock = tomllib.loads((root / "Cargo.lock").read_text())["package"]
    packages = {p["id"]: p for p in metadata["packages"]}
    nodes = {n["id"]: n for n in metadata["resolve"]["nodes"]}
    for name, providers in response.items():
        owner = [p for p in production if (root / name).is_relative_to(Path(p["manifest_path"]).parent / "src")]
        if len(owner) != 1:
            raise ValueError("Declaration source lacks an unambiguous production package")
        if any((d.get("rename") or d["name"]) in {"core", "std"} for d in owner[0]["dependencies"]):
            raise ValueError("Cargo dependency replaces protected builtin crate identity")
        for provider in providers:
            key = provider.replace("_", "-") if provider == "ts_rs" else provider
            if key not in DERIVE_IDENTITIES:
                raise ValueError("AST helper requested an unknown derive provider")
            version, checksum, macro, macro_checksum = DERIVE_IDENTITIES[key]
            deps = [d for d in owner[0]["dependencies"] if d["name"] == key and not d.get("rename")]
            binding = [d["pkg"] for d in nodes[owner[0]["id"]]["deps"] if d["name"] == provider]
            if len(deps) != 1 or deps[0]["req"] != "=" + version or len(set(binding)) != 1:
                raise ValueError("Derive dependency binding is not exactly pinned")
            pending, seen = list(binding), set()
            while pending:
                identity = pending.pop()
                if identity not in seen:
                    seen.add(identity)
                    pending.extend(d["pkg"] for d in nodes[identity]["deps"])
            used = [packages[identity] for identity in seen if packages[identity]["name"] == macro]
            for package_name, expected_hash, matches in ((key, checksum, [packages[binding[0]]]),
                                                        (macro, macro_checksum, used)):
                if (len(matches) != 1 or matches[0]["version"] != version or matches[0]["source"] != REGISTRY
                        or not any(p["name"] == package_name and p["version"] == version
                                   and p.get("source") == REGISTRY and p.get("checksum") == expected_hash for p in lock)):
                    raise ValueError("Derive provider or macro package identity differs from the verified pin")


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
                or entry["reason"] not in {"comment-only-rust-package-boundary", DECLARATION_REASON}
                or not re.fullmatch(r"(?:apps|crates|integrations)/(?:[A-Za-z0-9_-]+/)+[A-Za-z0-9_-]+\.rs", entry["path"])
                or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"])):
            raise ValueError("Invalid non-executable source classification")
        name = entry["path"]
        if name in verified or name not in sources:
            raise ValueError(f"Duplicate or missing non-executable source: {name}")
        source = root / name
        if entry["reason"] == "comment-only-rust-package-boundary" and (
                not re.fullmatch(r"crates/[A-Za-z0-9_-]+/src/lib\.rs", name)
                or not (source.parent.parent / "Cargo.toml").is_file()):
            raise ValueError(f"Non-executable source must be a Rust package boundary: {name}")
        contents = source.read_bytes()
        if hashlib.sha256(contents).hexdigest() != entry["sha256"]:
            raise ValueError(f"Non-executable source hash changed: {name}")
        if entry["reason"] == "comment-only-rust-package-boundary" and any(
                line.strip() and not line.lstrip().startswith("//") for line in contents.decode().splitlines()):
            raise ValueError(f"Non-executable source contains Rust code: {name}")
        verified.add(name)
    if any(entry["reason"] == DECLARATION_REASON for entry in boundaries):
        validate_declarations(root, verified, sources)
    if (any(not isinstance(name, str) or name not in COVERAGE_TOOLING or name not in sources for name in tooling)
            or len(set(tooling)) != len(tooling)):
        raise ValueError("Coverage tooling must name distinct existing allowlisted files")
    return sources, verified, set(tooling)


def append_non_executable_records(report, root, config):
    """Add honest zero-line evidence after a fresh Rust report has been produced."""
    _, verified, _ = coverage_policy(root, config)
    # Opening an absent report must fail; do not manufacture an entire report.
    contents = report.read_text()
    seen = set()
    for record in contents.split("end_of_record"):
        fields = record.strip().splitlines()
        sf = [line[3:] for line in fields if line.startswith("SF:")]
        if not sf:
            continue
        name = str((root / sf[0]).resolve().relative_to(root.resolve()))
        if name in verified:
            if name in seen or fields != ["SF:" + sf[0], "LF:0", "LH:0"]:
                raise ValueError("Non-executable source has contradictory or duplicate coverage evidence")
            seen.add(name)
    records = "".join(f"SF:{name}\nLF:0\nLH:0\nend_of_record\n" for name in sorted(verified - seen))
    if records:
        report.write_text(contents + ("\n" if contents and not contents.endswith("\n") else "") + records)


def coverage_counts(paths, root=None, config=None, expected_sources=None):
    """Merge by source/line, so duplicated LCOV records never inflate coverage."""
    expected, verified, tooling = coverage_policy(root, config or {}) if root is not None else (set(), set(), set())
    if expected_sources is not None:
        expected, verified, tooling = expected_sources, set(), set()
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
                if source in verified and source in reported:
                    raise ValueError("Duplicate non-executable coverage evidence")
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
    tools = tool_packages(ROOT, cargo_metadata(ROOT)) if (ROOT / "Cargo.toml").exists() else []
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
        tool_reports = {tool["id"]: ROOT / "coverage/tooling" / (tool["name"] + ".lcov") for tool in tools}
        # A stale report must never pass after a test command failed to emit one.
        for report in [*reports, *tool_reports.values()]:
            report.unlink(missing_ok=True)
        (ROOT / "coverage").mkdir(exist_ok=True)
        run("cargo", "fmt", "--all", "--", "--check")
        run("cargo", "clippy", "--workspace", "--all-targets", "--all-features", "--", "-D", "warnings")
        run("npm", "run", "lint")
        exclusions = [arg for tool in tools for arg in ("--exclude-from-report", tool["id"])]
        run("cargo", "llvm-cov", "--workspace", "--all-features", "--locked", "--lcov", "--output-path", reports[0], *exclusions)
        for tool in tools:
            target = tool_reports[tool["id"]]
            target.parent.mkdir(parents=True, exist_ok=True)
            # 0.9.1 rejects report --all-features; profiles already came from all features.
            run("cargo", "llvm-cov", "report", "--package", tool["id"], "--locked", "--lcov", "--output-path", target)
            folder = Path(tool["manifest_path"]).parent
            inventory = set()
            for source in folder.rglob("*.rs"):
                if source.is_symlink() or not source.resolve().is_relative_to(folder):
                    raise ValueError("Tool source escapes or aliases its verified package")
                if not any(part in EXCLUDED_PARTS for part in source.relative_to(folder).parts):
                    inventory.add(str(source.relative_to(ROOT.resolve())))
            covered, total = coverage_counts([target], ROOT, expected_sources=inventory)
            print(f"{tool['name']} line coverage: {covered}/{total} = {100 * covered / total:.2f}%")
            if 100 * covered < 80 * total:
                raise ValueError("Independent tooling coverage is below 80%")
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
