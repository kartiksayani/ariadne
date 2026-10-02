"""Unit and orchestration tests for fail-closed commit gates."""
import contextlib
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
        return subprocess.CompletedProcess(args, 0, stdout="")

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
            self.assertIn("lint:planning", flattened)
            self.assertEqual("--staged" in flattened, not mode)
        for folder in ("docs/planning", "poc/claude-mods", "poc/codex-queue"):
            (self.root / folder).mkdir(parents=True)
        self.execute(["--ci"])
        flattened = " ".join(" ".join(command) for command in self.commands)
        for expected in ("validate-planning.py", "poc/claude-mods", "poc/codex-queue"):
            self.assertIn(expected, flattened)

    def test_missing_linter_and_tool_failures_cannot_pass(self):
        for failure in ("check", "lint:planning", "coverage"):
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
