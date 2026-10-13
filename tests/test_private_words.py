"""Exercise the pre-push hook against isolated Git history and local lists."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ZERO = "0" * 40
WORD = "fixture-marker"


class PrivateWordTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.env = {**os.environ, "HOME": str(self.root / "home"),
                    "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
        self.env.pop("ARIADNE_PRIVATE_WORDS", None)
        self.env.pop("GIT_DIR", None)
        self.env.pop("GIT_WORK_TREE", None)
        self.words = self.root / "words.txt"
        self.words.write_text(f"# ignored comment\n\n  {WORD}  \n")
        self.env["ARIADNE_PRIVATE_WORDS"] = str(self.words)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "core.hooksPath", ".githooks")
        self.base = self.commit("baseline", {"notes.txt": "ordinary\n"})
        self.git("update-ref", "refs/remotes/origin/main", self.base)
        for name in (".githooks/pre-push", "scripts/check-private-words.py"):
            target = self.repo / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, target)
        python = self.repo / ".venv-quality/bin/python"
        python.parent.mkdir(parents=True)
        python.symlink_to(sys.executable)

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, env=self.env,
                              check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, message, files):
        for name, content in files.items():
            (self.repo / name).write_text(content)
        self.git("add", "--", *files)
        self.git("commit", "-qm", message)
        return self.git("rev-parse", "HEAD")

    def push(self, head=None, remote=None, extra=""):
        head = self.git("rev-parse", "HEAD") if head is None else head
        remote = self.base if remote is None else remote
        return subprocess.run([str(self.repo / ".githooks/pre-push")], cwd=self.repo,
                              env=self.env, capture_output=True, text=True,
                              input=f"refs/heads/work {head} refs/heads/work {remote}\n" + extra)

    def test_added_lines_case_and_exact_location_without_content(self):
        self.commit("ordinary", {"notes.txt": f"ordinary\nkeep\n{WORD.upper()} extra text\n"})
        result = self.push()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stdout, f"notes.txt:3: {WORD}\n")

    def test_messages_include_body_and_all_pushed_commits(self):
        head = self.commit(f"ordinary\n\n{WORD.upper()}", {"notes.txt": "changed\n"})
        self.commit("later", {"notes.txt": "later\n"})
        result = self.push()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stdout, f"commit {head[:7]} message: {WORD}\n")

    def test_existing_ref_excludes_old_messages_removed_and_context_lines(self):
        base = self.commit(WORD, {"notes.txt": f"{WORD}\nkeep\n{WORD}\n"})
        self.commit("ordinary", {"notes.txt": f"{WORD}\nkeep\nordinary\n"})
        result = self.push(remote=base)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_new_branch_uses_origin_main_and_pushed_head_not_working_tree(self):
        head = self.commit("ordinary", {"notes.txt": "ordinary\nchanged\n"})
        self.commit(WORD, {"notes.txt": WORD + "\n"})
        result = self.push(head=head, remote=ZERO)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.push(remote=ZERO).returncode, 1)

    def test_multiple_refs_deletion_and_missing_list(self):
        head = self.commit("ordinary", {"notes.txt": WORD + "\n"})
        extra = f"refs/heads/other {head} refs/heads/other {self.base}\n"
        self.assertEqual(self.push(head=ZERO, extra=extra).returncode, 1)
        self.assertEqual(self.push(head=ZERO).returncode, 0)
        self.words.unlink()
        result = self.push()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "Private-word check: list file missing; allowing push.\n")

    def test_default_list_comments_and_literal_patterns(self):
        self.env.pop("ARIADNE_PRIVATE_WORDS")
        default = Path(self.env["HOME"]) / ".config/ariadne/private-words.txt"
        default.parent.mkdir(parents=True)
        default.write_text("\n # ignored comment\n  fixture[.]marker \n")
        self.commit("ordinary", {"notes.txt": "ignored comment\nfixture.marker\n"})
        self.assertEqual(self.push().returncode, 0)
        self.commit("ordinary", {"notes.txt": "FIXTURE[.]MARKER\n"})
        result = self.push()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stdout, "notes.txt:1: fixture[.]marker\n")

    def test_quoted_path_and_added_line_starting_with_pluses(self):
        name = 'a "quoted" [file].txt'
        self.commit("ordinary", {name: f"+++{WORD}\n"})
        result = self.push()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stdout, f"{name}:1: {WORD}\n")

    def test_diff_preferences_do_not_hide_added_lines(self):
        self.git("config", "color.ui", "always")
        self.git("config", "diff.outputIndicatorNew", ">")
        self.commit("ordinary", {"notes.txt": f"ordinary\n{WORD}\n"})
        result = self.push()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stdout, f"notes.txt:2: {WORD}\n")

    def test_missing_base_and_unreadable_list_block(self):
        self.git("update-ref", "-d", "refs/remotes/origin/main")
        self.assertEqual(self.push(remote=ZERO).returncode, 1)
        self.env["ARIADNE_PRIVATE_WORDS"] = str(self.root)
        result = self.push()
        self.assertEqual(result.returncode, 1)
        self.assertIn("push blocked", result.stderr)


if __name__ == "__main__":
    unittest.main()
