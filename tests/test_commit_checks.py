"""Unit and orchestration tests for fail-closed commit gates."""
import contextlib
import hashlib
import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("check_commit", ROOT / "scripts/check-commit.py")
commit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(commit)


def report(root, name, source, hits):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"SF:{source}\n" + "".join(
        f"DA:{number},{count}\n" for number, count in enumerate(hits, 1)
    ) + "end_of_record\n")
    return path


class CoverageTests(unittest.TestCase):
    def boundary(self, root, contents="// Package boundary.\n\n"):
        path = root / "crates/core/src/lib.rs"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.parent.parent.joinpath("Cargo.toml").write_text('[package]\nname = "core"\n')
        path.write_text(contents)
        return {"path": str(path.relative_to(root)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "reason": "comment-only-rust-package-boundary"}

    def test_verified_boundaries_need_zero_records_without_changing_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entry = self.boundary(root)
            source = root / "crates/core/src/executable.rs"
            source.write_text("fn run() {}\n")
            rust = report(root, "rust.lcov", str(source.relative_to(root)), [1])
            config = {"non_executable_sources": [entry]}
            with self.assertRaisesRegex(ValueError, "omits application sources"):
                commit.coverage_counts([rust], root, config)
            commit.append_non_executable_records(rust, root, config)
            self.assertIn(f'SF:{entry["path"]}\nLF:0\nLH:0\nend_of_record\n', rust.read_text())
            self.assertEqual(commit.coverage_counts([rust], root, config), (1, 1))
            with self.assertRaisesRegex(ValueError, "Missing executable line data"):
                commit.coverage_counts([rust], root)

    def test_only_verified_boundaries_may_have_exact_zero_records(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entry = self.boundary(root)
            rust = root / "rust.lcov"
            config = {"non_executable_sources": [entry]}
            for fields in ("LF:0\nLH:0\n", "", "LF:1\nLH:0\n", "LF:0\nLH:1\n",
                           "LF:0\nLH:0\nDA:1,1\n", "LF:0\nLH:0\nFN:1,fake\n"):
                rust.write_text(f'SF:{entry["path"]}\n{fields}end_of_record\n')
                with self.subTest(fields=fields), self.assertRaises(ValueError):
                    commit.coverage_counts([rust], root, config)
            with self.assertRaises(FileNotFoundError):
                commit.append_non_executable_records(root / "missing", root, config)

    def test_boundary_configuration_rejects_malformed_stale_and_executable_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entry = self.boundary(root)
            invalid = [None, "crates/core/src/lib.rs", {}, {**entry, "extra": True},
                       {**entry, "reason": "empty"}, {**entry, "path": "crates/core/lib.rs"},
                       {**entry, "path": "crates/core/src/../src/lib.rs"},
                       {**entry, "sha256": "bad"}, {**entry, "sha256": "a" * 64},
                       {**entry, "path": None}, {**entry, "path": "crates/missing/src/lib.rs"}]
            for value in invalid:
                with self.subTest(value=value), self.assertRaises(ValueError):
                    commit.coverage_policy(root, {"non_executable_sources": [value]})
            for config in ({"non_executable_sources": {}}, {"coverage_tooling": {}},
                           {"non_executable_sources": [entry, entry]}):
                with self.subTest(config=config), self.assertRaises(ValueError):
                    commit.coverage_policy(root, config)
            for contents in ("fn run() {}\n", "#![allow(dead_code)]\n", "/* comment */\n", "// comment\npub mod code;\n"):
                executable = self.boundary(root, contents)
                with self.subTest(contents=contents), self.assertRaisesRegex(ValueError, "contains Rust code"):
                    commit.coverage_policy(root, {"non_executable_sources": [executable]})
            entry = self.boundary(root, "")
            self.assertEqual(commit.coverage_policy(root, {"non_executable_sources": [entry]})[1], {entry["path"]})
            root.joinpath("crates/core/Cargo.toml").unlink()
            with self.assertRaisesRegex(ValueError, "package boundary"):
                commit.coverage_policy(root, {"non_executable_sources": [entry]})

    def test_hash_and_inventory_cannot_hide_new_executable_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entry = self.boundary(root)
            config = {"non_executable_sources": [entry]}
            root.joinpath(entry["path"]).write_text("fn new_behavior() {}\n")
            with self.assertRaisesRegex(ValueError, "hash changed"):
                commit.coverage_policy(root, config)
            self.boundary(root)
            source = root / "apps/main.ts"
            source.parent.mkdir()
            source.write_text("run();\n")
            rust = report(root, "report", "apps/main.ts", [1])
            commit.append_non_executable_records(rust, root, config)
            for extension in ("mjs", "cjs", "mts", "cts", "rs", "tsx"):
                added = root / f"integrations/mods/nested/future.{extension}"
                added.parent.mkdir(parents=True, exist_ok=True)
                added.write_text("new_behavior();\n")
                with self.subTest(extension=extension), self.assertRaisesRegex(ValueError, "omits application sources"):
                    commit.coverage_counts([rust], root, config)
                added.unlink()

    def test_tooling_allowlist_is_exact_and_does_not_disable_source_detection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in commit.COVERAGE_TOOLING:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("configure();\n")
            config = {"coverage_tooling": sorted(commit.COVERAGE_TOOLING)}
            self.assertTrue(commit.application_present(root, config))
            source = root / "apps/desktop/src/main.ts"
            source.parent.mkdir()
            source.write_text("run();\n")
            actual = report(root, "report", str(source.relative_to(root)), [1])
            self.assertEqual(commit.coverage_counts([actual], root, config), (1, 1))
            for names in (["apps/desktop/src/main.ts"], ["apps/**/*.ts"], [None], [{}],
                          ["apps/desktop/vite.config.ts"] * 2):
                with self.subTest(names=names), self.assertRaises(ValueError):
                    commit.coverage_policy(root, {"coverage_tooling": names})
            root.joinpath("apps/desktop/vite.config.ts").unlink()
            with self.assertRaises(ValueError):
                commit.coverage_policy(root, config)
            with self.assertRaisesRegex(ValueError, "omits application sources"):
                commit.coverage_counts([actual], root)

    def test_symlink_escape_and_zero_executable_evidence_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as external:
            root = Path(directory)
            entry = self.boundary(root)
            config = {"non_executable_sources": [entry]}
            source = root / entry["path"]
            source.unlink()
            outside = Path(external) / "lib.rs"
            outside.write_text("// Outside boundary.\n")
            source.symlink_to(outside)
            with self.assertRaisesRegex(ValueError, "escapes repository"):
                commit.coverage_policy(root, config)
            source.unlink()
            self.boundary(root)
            link = root / "apps"
            link.symlink_to(Path(external), target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "escapes repository"):
                commit.coverage_policy(root, config)
            outside.unlink()
            with self.assertRaisesRegex(ValueError, "escapes repository"):
                commit.coverage_policy(root, config)
            link.unlink()
            empty = root / "empty.lcov"
            empty.write_text("")
            commit.append_non_executable_records(empty, root, config)
            with self.assertRaisesRegex(ValueError, "Missing executable line data"):
                commit.coverage_counts([empty], root, config)
            executable = root / "apps/main.ts"
            executable.parent.mkdir()
            executable.write_text("run();\n")
            genuine = report(root, "genuine.lcov", "apps/main.ts", [1])
            for reports in ([genuine, empty], [empty, genuine]):
                with self.subTest(reports=reports), self.assertRaisesRegex(ValueError, "Missing executable line data"):
                    commit.coverage_counts(reports, root, config)

    def test_weighted_counts_include_zero_hits_and_merge_duplicate_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = report(root, "first", "src/a.rs", [1] * 8 + [0] * 2)
            second = report(root, "second", "src/b.ts", [0] * 90)
            duplicate = report(root, "duplicate", "src/a.rs", [0] * 10)
            self.assertEqual(commit.coverage_counts([first, second, duplicate]), (8, 100))

    def test_empty_malformed_and_impossible_reports_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report"
            for contents in ("", "SF:src/a.rs\nend_of_record\n", "DA:1,1\n",
                             "SF:src/a.rs\nDA:0,1\n", "SF:src/a.rs\nDA:1,-1\n"):
                path.write_text(contents)
                with self.subTest(contents=contents), self.assertRaises(ValueError):
                    commit.coverage_counts([path])
            with self.assertRaises(ValueError):
                commit.coverage_counts([])

    def test_real_sources_must_exist_fit_line_counts_and_all_be_covered(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "crates/a.rs"
            source.parent.mkdir()
            source.write_text("fn main() {}\n")
            (source.parent / "types.d.ts").write_text("declare const label: string;\n")
            self.assertEqual(commit.coverage_counts([report(root, "report", "crates/a.rs", [1])], root), (1, 1))
            generated = root / "crates/generated/fake.rs"
            generated.parent.mkdir()
            generated.write_text("generated source\n")
            for name, hits in (("crates/missing.rs", [1]), ("crates/a.rs", [1, 1]), ("../outside.rs", [1])):
                with self.subTest(source=name), self.assertRaises(ValueError):
                    commit.coverage_counts([report(root, "report", name, hits)], root)
            with self.assertRaisesRegex(ValueError, "not application code"):
                commit.coverage_counts([report(root, "report", "crates/generated/fake.rs", [1])], root)
            (source.parent / "untested.rs").write_text("fn untested() {}\n")
            with self.assertRaisesRegex(ValueError, "omits application sources"):
                commit.coverage_counts([report(root, "report", "crates/a.rs", [1])], root)


class PhaseTests(unittest.TestCase):
    def test_phase_floor_and_scope_fail_closed(self):
        config = {"phase": "planning", "minimum_line_coverage": 80}
        commit.validate_phase(config, False)
        commit.validate_phase({**config, "phase": "application"}, True)
        for overrides, present in (({}, True), ({"phase": "preview"}, False),
                                   ({"minimum_line_coverage": 79}, False),
                                   ({"minimum_line_coverage": float("nan")}, False),
                                   ({"minimum_line_coverage": 101}, False),
                                   ({"production_roots": ["apps"]}, False),
                                   ({"application_reports": []}, False)):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                commit.validate_phase({**config, **overrides}, present)

    def test_detection_uses_canonical_roots_and_root_cargo_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "docs").mkdir()
            (root / "docs/sample.ts").touch()
            self.assertFalse(commit.application_present(root, {}))
            for folder, filename in (("apps", "main.tsx"), ("crates", "lib.rs"), ("integrations", "mod.mjs"), ("integrations", "mod.cjs"), ("integrations", "mod.mts")):
                path = root / folder / filename
                path.parent.mkdir(exist_ok=True)
                path.touch()
                self.assertTrue(commit.application_present(root, {"production_roots": []}))
                path.unlink()
            (root / "Cargo.toml").touch()
            self.assertTrue(commit.application_present(root, {}))


class OrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.config = {"phase": "planning", "minimum_line_coverage": 80}
        self.commands = []
        self.failure = None
        self.npm_version = "10.9.8"
        self.hits = [1] * 4 + [0]
        (self.root / ".venv-quality/bin").mkdir(parents=True)
        (self.root / ".venv-quality/bin/ruff").touch()
        patch = mock.patch.object(commit, "ROOT", self.root)
        patch.start()
        self.addCleanup(patch.stop)

    def run_tool(self, *args, capture=False):
        args = tuple(map(str, args))
        self.commands.append(args)
        if self.failure and self.failure in args:
            raise subprocess.CalledProcessError(1, args)
        if "llvm-cov" in args:
            report(self.root, "coverage/rust.lcov", "crates/lib.rs", self.hits)
        if "test:coverage" in args:
            report(self.root, "coverage/web/lcov.info", "apps/main.ts", self.hits)
        return subprocess.CompletedProcess(args, 0, stdout=self.npm_version if args == ("npm", "--version") else "")

    def execute(self, args):
        (self.root / "quality-gates.json").write_text(json.dumps(self.config))
        with mock.patch.object(commit, "run", side_effect=self.run_tool), contextlib.redirect_stdout(io.StringIO()):
            commit.main(args)

    def test_staged_and_ci_modes_run_lint_fresh_coverage_and_functional_tests(self):
        for mode in ([], ["--ci"], ["--working-tree"]):
            self.commands = []
            self.execute(mode)
            flattened = " ".join(" ".join(command) for command in self.commands)
            self.assertIn("coverage run", flattened)
            self.assertIn("coverage report --fail-under=80", flattened)
            self.assertIn("node_modules/eslint/bin/eslint.js . --max-warnings=0", flattened)
            self.assertNotIn("npm run lint:planning", flattened)
            self.assertEqual("--staged" in flattened, not mode)
        for folder in ("docs/planning", "poc/claude-mods", "poc/codex-queue"):
            (self.root / folder).mkdir(parents=True)
        self.execute(["--ci"])
        flattened = " ".join(" ".join(command) for command in self.commands)
        for expected in ("validate-planning.py", "poc/claude-mods", "poc/codex-queue"):
            self.assertIn(expected, flattened)

    def test_missing_linter_and_tool_failures_cannot_pass(self):
        for failure in ("check", "node", "coverage"):
            self.failure = failure
            with self.subTest(failure=failure), self.assertRaises(subprocess.CalledProcessError):
                self.execute(["--ci"])
        self.failure = None
        (self.root / ".venv-quality/bin/ruff").unlink()
        with mock.patch.object(commit.shutil, "which", return_value=None), self.assertRaisesRegex(ValueError, "Ruff is required"):
            self.execute(["--ci"])

    def test_staged_gate_rejects_untested_working_tree(self):
        with mock.patch.object(commit, "run", return_value=mock.Mock(stdout="changed.py\n")):
            with self.assertRaisesRegex(ValueError, "match the index"):
                commit.require_staged_tree()

    def test_old_or_invalid_npm_blocks_application_commands(self):
        self.config["phase"] = "application"
        for version in ("6.14.8", "10.9.7", "", "config failed", "10.9.8-preview"):
            self.npm_version = version
            self.commands = []
            with self.subTest(version=version), self.assertRaisesRegex(ValueError, "require npm >=10.9.8"):
                self.execute(["--ci"])
            self.assertEqual(self.commands, [("npm", "--version")])

    def test_application_gates_enforce_e2e_and_fresh_eighty_percent_reports(self):
        self.config["phase"] = "application"
        for name in ("crates/lib.rs", "apps/main.ts"):
            path = self.root / name
            path.parent.mkdir()
            path.write_text("statement\n" * 5)
        for name in commit.APPLICATION_REPORTS:
            report(self.root, name, "fake.rs", [1])
        self.execute(["--ci"])
        self.assertIn(("npm", "run", "test:e2e"), self.commands)
        self.hits = [1, 0, 0, 0, 0]
        with self.assertRaisesRegex(ValueError, "below the configured minimum"):
            self.execute(["--ci"])
        self.failure = "test:e2e"
        with self.assertRaises(subprocess.CalledProcessError):
            self.execute(["--ci"])
        self.failure = None
        with mock.patch(__name__ + ".report"), self.assertRaises(FileNotFoundError):
            self.execute(["--ci"])

    def test_application_boundary_evidence_is_added_only_after_real_rust_report(self):
        entry = CoverageTests().boundary(self.root)
        self.config.update(phase="application", non_executable_sources=[entry],
                           coverage_tooling=["apps/desktop/vite.config.ts"])
        for name in ("crates/lib.rs", "apps/main.ts", "apps/desktop/vite.config.ts"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("statement\n" * 5)
        self.execute(["--ci"])
        self.assertIn("LF:0\nLH:0", self.root.joinpath("coverage/rust.lcov").read_text())
        flattened = " ".join(" ".join(command) for command in self.commands)
        for expected in ("cargo fmt", "cargo clippy", "npm run lint", "test:coverage", "test:e2e"):
            self.assertIn(expected, flattened)
        with mock.patch(__name__ + ".report"), self.assertRaises(FileNotFoundError):
            self.execute(["--ci"])

    def test_command_wrapper_keeps_arguments_and_propagates_failure(self):
        with mock.patch.object(commit.shutil, "which", return_value="rtk"), mock.patch.object(commit.subprocess, "run") as process:
            commit.run("tool", Path("file with spaces"), capture=True)
            self.assertEqual(process.call_args.args[0], ["rtk", "proxy", "tool", "file with spaces"])
            self.assertTrue(process.call_args.kwargs["check"])

    def test_cli_help_and_missing_config_exit_codes(self):
        script = self.root / "scripts/check-commit.py"
        script.parent.mkdir()
        script.write_text((ROOT / "scripts/check-commit.py").read_text())
        for args, status in ((["--help"], 0), (["--ci"], 1)):
            result = subprocess.run([commit.sys.executable, str(script), *args],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, status, result.stderr)
            if status:
                self.assertIn("quality-gates.json", result.stderr)


if __name__ == "__main__":
    unittest.main()
