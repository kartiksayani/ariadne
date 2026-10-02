"""Real Git functional tests for the commit and PR change policy."""
import contextlib
import importlib.util
import io
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("check_change", ROOT / "scripts/check-change.py")
change = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(change)


class GitFunctionalTests(unittest.TestCase):
    def setUp(self):
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
        (self.root / name).write_text("line\n" * lines)
        self.git("add", ".")
        self.git("commit", "-qm", name)
        return self.git("rev-parse", "HEAD")

    def check(self, args):
        with contextlib.chdir(self.root), contextlib.redirect_stdout(io.StringIO()):
            change.main(args)

    def test_staged_boundaries_work_in_unborn_repository(self):
        for lines, fails in ((400, False), (401, True)):
            (self.root / "file with spaces.py").write_text("line\n" * lines)
            self.git("add", ".")
            if fails:
                with self.assertRaisesRegex(ValueError, "commit exceeds 400"):
                    self.check(["--staged"])
            else:
                self.check(["--staged"])

    def test_initial_zero_base_and_normal_base_enforce_each_commit_and_pr(self):
        base = self.add_commit("first.py", 400)
        self.check(["--base", "0" * 40])
        self.add_commit("second.py", 400)
        self.check(["--base", base])
        self.add_commit("third.py", 401)
        with self.assertRaisesRegex(ValueError, "pr exceeds 800"):
            self.check(["--base", base])
        with self.assertRaisesRegex(ValueError, "commit exceeds 400"):
            self.check(["--base", "HEAD~1"])

    def test_merge_and_option_injection_are_rejected(self):
        base = self.add_commit("base.py", 1)
        self.git("checkout", "-qb", "other")
        self.add_commit("other.py", 1)
        self.git("checkout", "-q", "-")
        self.add_commit("main.py", 1)
        self.git("merge", "-q", "--no-ff", "other", "-m", "merge")
        with self.assertRaisesRegex(ValueError, "linear PR branch"):
            self.check(["--base", base])
        with self.assertRaises(subprocess.CalledProcessError):
            self.check(["--base=--help"])

    def test_cli_exit_status_and_argument_errors(self):
        for name in ("check-change.py",):
            result = subprocess.run([sys.executable, str(ROOT / "scripts" / name), "--help"],
                                    cwd=self.root, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        for args in ([], ["--staged", "--base", "HEAD"]):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                self.check(args)
        (self.root / "too-large.py").write_text("line\n" * 401)
        self.git("add", ".")
        result = subprocess.run([sys.executable, str(ROOT / "scripts/check-change.py"), "--staged"],
                                cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("split it by behavior", result.stderr)

    def test_generated_docs_binary_and_app_sources_classify_distinctly(self):
        result = change.classify("2\t1\tapps/page.html\0" "4\t1\tdocs/notes.md\0"
                                 "6\t2\tpackage-lock.json\0" "-\t-\timage.png\0")
        self.assertEqual(result, {"handwritten": 3, "docs": 5, "generated": 8,
                                  "binary_files": ["image.png"]})


if __name__ == "__main__":
    unittest.main()
