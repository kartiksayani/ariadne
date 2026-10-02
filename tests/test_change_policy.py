"""Real Git functional tests for the commit and PR change policy."""
import contextlib
import importlib.util
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("check_change", ROOT / "scripts/check-change.py")
change = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(change)


class GitFunctionalTests(unittest.TestCase):
    def setUp(self):
        # Git exports repository/index variables while executing commit hooks.
        environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        environment.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                           GIT_CONFIG_SYSTEM=os.devnull, GIT_CONFIG_COUNT="1",
                           GIT_CONFIG_KEY_0="core.hooksPath", GIT_CONFIG_VALUE_0=os.devnull)
        patch = mock.patch.dict(os.environ, environment, clear=True)
        patch.start()
        self.addCleanup(patch.stop)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Quality Test")
        self.git("config", "user.email", "quality@example.invalid")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, check=True,
                              capture_output=True, text=True).stdout.strip()

    def add_commit(self, name, lines):
        (self.root / name).parent.mkdir(parents=True, exist_ok=True)
        (self.root / name).write_text("line\n" * lines)
        self.git("add", ".")
        self.git("commit", "-qm", name)
        return self.git("rev-parse", "HEAD")

    def check(self, args):
        with contextlib.chdir(self.root), contextlib.redirect_stdout(io.StringIO()):
            change.main(args)

    def test_staged_boundaries_work_in_unborn_repository(self):
        for lines, fails in ((800, False), (801, True)):
            (self.root / "file with spaces.py").write_text("line\n" * lines)
            self.git("add", ".")
            if fails:
                with self.assertRaisesRegex(ValueError, "commit exceeds 800"):
                    self.check(["--staged"])
            else:
                self.check(["--staged"])

    def test_initial_zero_base_and_normal_base_enforce_each_commit_and_pr(self):
        base = self.add_commit("first.py", 800)
        self.check(["--base", "0" * 40])
        self.add_commit("tests/test_feature.py", 800)
        self.check(["--base", "0" * 40])
        self.check(["--base", base])
        self.add_commit("config/settings.toml", 800)
        self.check(["--base", base])
        self.add_commit("last.py", 1)
        with self.assertRaisesRegex(ValueError, "pr exceeds 1600"):
            self.check(["--base", base])

    def test_pr_rejects_oversized_individual_commit_below_aggregate_limit(self):
        self.add_commit("base.py", 1)
        self.add_commit("too-large.py", 801)
        with self.assertRaisesRegex(ValueError, "commit exceeds 800"):
            self.check(["--base", "HEAD~1"])
        with self.assertRaisesRegex(ValueError, "commit exceeds 800"):
            self.check(["--base", "0" * 40])

    def test_valid_prs_pass_after_real_squash_and_oversized_squash_fails(self):
        base = self.add_commit("base.py", 1)
        main = self.git("branch", "--show-current")
        for total in (801, 1600, 1601):
            with self.subTest(total=total):
                branch = f"pr-{total}"
                self.git("checkout", "-qb", branch, base)
                for number, lines in enumerate((800, min(total - 800, 800), max(total - 1600, 0))):
                    if lines:
                        self.add_commit(f"{branch}-{number}.py", lines)
                if total <= 1600:
                    self.check(["--base", base])
                else:
                    with self.assertRaisesRegex(ValueError, "pr exceeds 1600"):
                        self.check(["--base", base])
                self.git("checkout", "-q", main)
                self.git("merge", "--squash", branch)
                self.git("commit", "-qm", f"Squash {branch}")
                if total <= 1600:
                    self.check(["--main", "--base", base])
                else:
                    with self.assertRaisesRegex(ValueError, "squash exceeds 1600"):
                        self.check(["--main", "--base", base])
                base = self.git("rev-parse", "HEAD")

    def test_main_ranges_check_each_squash_and_initial_commit_separately(self):
        base = self.add_commit("first.py", 1600)
        self.check(["--main", "--base", "0" * 40])
        self.add_commit("second.py", 1600)
        self.add_commit("third.py", 1600)
        self.check(["--main", "--base", base])
        self.add_commit("oversized.py", 1601)
        with self.assertRaisesRegex(ValueError, "squash exceeds 1600"):
            self.check(["--main", "--base", base])

    def test_main_requires_ancestor_base_and_rejects_merge_commits(self):
        base = self.add_commit("base.py", 1)
        self.git("checkout", "-qb", "other")
        other = self.add_commit("other.py", 1)
        self.git("checkout", "-q", "-")
        self.add_commit("main.py", 1)
        with self.assertRaisesRegex(ValueError, "base must be an ancestor"):
            self.check(["--main", "--base", other])
        self.git("merge", "-q", "--no-ff", "other", "-m", "merge")
        with self.assertRaisesRegex(ValueError, "linear history"):
            self.check(["--main", "--base", base])

    def test_merge_and_option_injection_are_rejected(self):
        base = self.add_commit("base.py", 1)
        self.git("checkout", "-qb", "other")
        self.add_commit("other.py", 1)
        self.git("checkout", "-q", "-")
        self.add_commit("main.py", 1)
        self.git("merge", "-q", "--no-ff", "other", "-m", "merge")
        with self.assertRaisesRegex(ValueError, "linear history"):
            self.check(["--base", base])
        with self.assertRaises(subprocess.CalledProcessError):
            self.check(["--base=--help"])

    def test_cli_exit_status_and_argument_errors(self):
        for name in ("check-change.py",):
            result = subprocess.run([sys.executable, str(ROOT / "scripts" / name), "--help"],
                                    cwd=self.root, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        for args in ([], ["--main"], ["--staged", "--base", "HEAD"], ["--staged", "--main"]):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                self.check(args)
        (self.root / "too-large.py").write_text("line\n" * 801)
        self.git("add", ".")
        result = subprocess.run([sys.executable, str(ROOT / "scripts/check-change.py"), "--staged"],
                                cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("split it by behavior", result.stderr)

    def test_generated_docs_binary_and_app_sources_classify_distinctly(self):
        result = change.classify("2\t1\tapps/page.html\0" "4\t1\tdocs/notes.md\0"
                                 "6\t2\tpackage-lock.json\0" "-\t-\timage.png\0"
                                 "2\t0\tdocs/delivery/tasks.json\0" "1\t0\tapps/tasks.json\0")
        self.assertEqual(result, {"handwritten": 4, "docs": 7, "generated": 8,
                                  "binary_files": ["image.png"]})

    def test_foreign_hook_environment_preserves_outer_head_index_and_config(self):
        head = self.add_commit("outer.py", 1)
        (self.root / "pending.py").write_text("pending change\n")
        self.git("add", "pending.py")
        index = (self.root / ".git/index").read_bytes()
        config = (self.root / ".git/config").read_bytes()
        global_config = self.root / "foreign-global"
        global_config.write_text("[core]\n\tbare = true\n")
        foreign = {**os.environ, "GIT_DIR": str(self.root / ".git"),
                   "GIT_WORK_TREE": str(self.root), "GIT_INDEX_FILE": str(self.root / ".git/index"),
                   "GIT_CONFIG_GLOBAL": str(global_config), "GIT_CONFIG_VALUE_0": str(self.root / ".git/hooks")}
        # A separate process must restore its inherited environment after cleanup.
        probe = ("import importlib.util, os, sys, unittest; before = dict(os.environ); "
                 f"spec = importlib.util.spec_from_file_location('probe', {str(Path(__file__).resolve())!r}); "
                 "module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); "
                 "suite = unittest.TestSuite([module.GitFunctionalTests('test_initial_zero_base_and_normal_base_enforce_each_commit_and_pr')]); "
                 "result = unittest.TextTestRunner().run(suite); "
                 "assert dict(os.environ) == before; sys.exit(not result.wasSuccessful())")
        result = subprocess.run([sys.executable, "-c", probe], env=foreign,
                                cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git("rev-parse", "HEAD"), head)
        self.assertEqual((self.root / ".git/index").read_bytes(), index)
        self.assertEqual((self.root / ".git/config").read_bytes(), config)


class WorkflowTests(unittest.TestCase):
    def test_only_pushes_to_main_select_squash_checks(self):
        workflow = (ROOT / ".github/workflows/quality.yml").read_text()
        step = workflow.split("  change-policy:\n", 1)[1].split("\n  quality:", 1)[0]
        script = "\n".join(line.removeprefix("          ")
                           for line in step.split("        run: |\n", 1)[1].splitlines())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stub = root / "python3"
            output = root / "arguments"
            stub.write_text(f"#!{sys.executable}\nimport os, sys\n"
                            "from pathlib import Path\n"
                            "Path(os.environ['ARGUMENTS']).write_text('\\n'.join(sys.argv[1:]))\n")
            stub.chmod(0o755)
            for event, ref, main in (("pull_request", "refs/pull/1/merge", False),
                                     ("push", "refs/heads/main", True),
                                     ("push", "refs/heads/feature", False)):
                with self.subTest(event=event, ref=ref):
                    env = {**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                           "ARGUMENTS": str(output), "BASE_SHA": "before", "HEAD_SHA": "after",
                           "EVENT_NAME": event, "REF_NAME": ref}
                    subprocess.run(["bash", "-c", script], env=env, check=True, capture_output=True)
                    self.assertEqual(output.read_text().splitlines(),
                                     ["scripts/check-change.py", "--base", "before", "--head", "after"]
                                     + (["--main"] if main else []))


if __name__ == "__main__":
    unittest.main()
