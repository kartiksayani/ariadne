"""Small regressions for scope selection and honest application coverage."""
import importlib.util
import os
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
        f"DA:{number},{count}\n" for number, count in enumerate(hits, 1)) + "end_of_record\n")
    return path


class ScopeTests(unittest.TestCase):
    def test_small_map_and_conservative_release_paths(self):
        for paths, expected in [
            (["docs/planning/roadmap.html", "docs/delivery/tasks.json"], ("docs", False)),
            (["scripts/regenerate-roadmap.py"], ("tooling", False)),
            (["crates/ariadne-core/src/queue.rs"], ("application", False)),
            (["apps/desktop/src-tauri/src/lib.rs"], ("application", True)),
            (["apps/desktop/vite.config.ts"], ("application", True)),
            (["apps/desktop/src/main.tsx"], ("application", True)),
            (["apps/desktop/src-tauri/capabilities/main.json"], ("application", True)),
            (["crates/ariadne-domain/Cargo.toml"], ("application", True)),
            (["Cargo.lock"], ("application", True)),
            (["package-lock.json"], ("application", True)),
            (["scripts/run-native-e2e.mjs"], ("application", True)),
            (["quality-gates.json"], ("application", True)),
            ([".github/workflows/quality.yml"], ("application", True)),
            (["future/unknown.ts"], ("application", True)),
            (None, ("application", True)),
        ]:
            with self.subTest(paths=paths):
                self.assertEqual(commit.scope_for(paths), expected)

    def test_git_deletion_rename_missing_base_and_earlier_commit(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            def git(*args):
                return subprocess.run(["git", *args], cwd=root, check=True, text=True,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()
            git("init", "-q")
            git("config", "user.email", "tests@example.invalid")
            git("config", "user.name", "Test")
            (root / "crates").mkdir()
            (root / "docs").mkdir()
            (root / "crates/source.rs").write_text("fn run() {}\n")
            (root / "crates/deleted.rs").write_text("fn other() {}\n")
            git("add", ".")
            git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "initial")
            base = git("rev-parse", "HEAD")
            git("mv", "crates/source.rs", "docs/source.rs")
            git("rm", "crates/deleted.rs")
            git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "move and delete")
            (root / "docs/note.md").write_text("later docs change\n")
            git("add", ".")
            git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "docs")
            with mock.patch.object(commit, "ROOT", root):
                for merge_base in (False, True):
                    paths = commit.changed_paths(base, merge_base=merge_base)
                    self.assertEqual(set(paths), {"crates/source.rs", "crates/deleted.rs", "docs/source.rs", "docs/note.md"})
                    self.assertEqual(commit.scope_for(paths)[0], "application")
                self.assertIsNone(commit.changed_paths("missing-base"))
                self.assertEqual(commit.scope_for(commit.changed_paths("missing-base")), ("application", True))

    def test_diverged_feature_scope_main_push_delta_and_ancestry_fallback(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            def git(*args):
                return subprocess.run(["git", *args], cwd=root, check=True, text=True,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()
            def save(name, content):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
                git("add", ".")
                git("-c", "core.hooksPath=/dev/null", "commit", "-qm", name)
            git("init", "-q", "-b", "main")
            git("config", "user.email", "tests@example.invalid")
            git("config", "user.name", "Test")
            save("docs/initial.md", "initial\n")
            fork = git("rev-parse", "HEAD")
            git("checkout", "-qb", "feature")
            save("docs/first.md", "first branch change\n")
            save("docs/second.md", "second branch change\n")
            git("checkout", "-q", "main")
            save("Cargo.lock", "main-only addition\n")
            previous_push = git("rev-parse", "HEAD")
            save("crates/core/src/queue.rs", "fn run() {}\n")
            save("docs/main.md", "latest main change\n")
            git("checkout", "-q", "feature")
            with mock.patch.object(commit, "ROOT", root):
                paths = commit.changed_paths("main", merge_base=True)
                self.assertEqual(paths, ["docs/first.md", "docs/second.md"])
                self.assertEqual(commit.scope_for(paths), ("docs", False))
                self.assertIsNone(commit.changed_paths("main"))
                git("checkout", "-q", "main")
                paths = commit.changed_paths(previous_push)
                self.assertEqual(paths, ["crates/core/src/queue.rs", "docs/main.md"])
                self.assertEqual(commit.scope_for(paths), ("application", False))
                self.assertIn("Cargo.lock", commit.changed_paths(fork))
                git("checkout", "--orphan", "unrelated")
                git("rm", "-rf", ".")
                save("docs/unrelated.md", "unrelated root\n")
                for base in ("main", "missing-base", "0" * 40):
                    for merge_base in (False, True):
                        with self.subTest(base=base, merge_base=merge_base):
                            paths = commit.changed_paths(base, merge_base=merge_base)
                            self.assertIsNone(paths)
                            self.assertEqual(commit.scope_for(paths), ("application", True))

    def test_ambiguous_merge_base_selects_full_checks(self):
        with mock.patch.object(commit, "run", side_effect=[
                mock.Mock(stdout="target\n"), mock.Mock(stdout="ancestor-one\nancestor-two\n")]):
            paths = commit.changed_paths("main", merge_base=True)
            self.assertIsNone(paths)
            self.assertEqual(commit.scope_for(paths), ("application", True))

    def test_local_hook_only_lints_even_for_gate_change_and_dirty_tree(self):
        with mock.patch.object(commit, "changed_paths", return_value=["scripts/check-commit.py"]), mock.patch.object(
                commit, "lint") as lint, mock.patch.object(commit, "run") as run:
            commit.main([])
            lint.assert_called_once_with(["scripts/check-commit.py"], full=False)
            run.assert_not_called()

    def test_ci_docs_does_not_run_tests_or_builds(self):
        with mock.patch.object(commit, "changed_paths", return_value=["docs/planning/ROADMAP.md"]), mock.patch.object(
                commit, "lint"), mock.patch.object(commit, "run") as run:
            commit.main(["--ci", "--base", "main"])
            run.assert_called_once_with(commit.sys.executable, "scripts/regenerate-roadmap.py", "--check")

    def test_ci_feature_comparison_requests_merge_base(self):
        with mock.patch.object(commit, "changed_paths", return_value=["docs/note.md"]) as paths:
            commit.main(["--ci", "--base", "origin/main", "--merge-base", "--print-scope"])
            paths.assert_called_once_with("origin/main", False, True)


class CoverageTests(unittest.TestCase):
    def test_weighted_counts_include_uncovered_lines_and_merge_duplicates(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            first = report(root, "rust", "src/a.rs", [1] * 8 + [0] * 2)
            second = report(root, "web", "src/b.ts", [0] * 90)
            duplicate = report(root, "duplicate", "src/a.rs", [0] * 10)
            self.assertEqual(commit.coverage_counts([first, second, duplicate]), (8, 100))

    def test_explicit_stub_exclusion_does_not_hide_child_or_other_lib_logic(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "crates/core/src"
            source.mkdir(parents=True)
            (source / "lib.rs").write_text("// Stub only\n")
            (source / "logic.rs").write_text("fn run() {}\n")
            config = {"coverage_exclusions": ["crates/core/src/lib.rs"]}
            rust = report(root, "rust", "crates/core/src/logic.rs", [1])
            self.assertEqual(commit.coverage_counts([rust], root, config), (1, 1))
            self.assertNotIn("LF:0", rust.read_text())
            other = root / "crates/other/src/lib.rs"
            other.parent.mkdir(parents=True)
            other.write_text("fn uncovered() {}\n")
            with self.assertRaisesRegex(ValueError, "omits application sources"):
                commit.coverage_counts([rust], root, config)

    def test_missing_stale_malformed_and_zero_records_fail(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "apps/main.ts"
            source.parent.mkdir()
            source.write_text("run();\n")
            path = report(root, "web", "apps/main.ts", [1])
            os.utime(path, ns=(1, 1))
            with self.assertRaisesRegex(ValueError, "Stale"):
                commit.coverage_counts([path], root)
            for content in ("", "SF:apps/main.ts\nLF:0\nLH:0\nend_of_record\n",
                            "DA:1,1\n", "SF:apps/main.ts\nDA:0,1\nend_of_record\n",
                            "SF:apps/main.ts\nDA:1,-1\nend_of_record\n"):
                path.write_text(content)
                with self.subTest(content=content), self.assertRaises(ValueError):
                    commit.coverage_counts([path], root)
            with self.assertRaises(FileNotFoundError):
                commit.coverage_counts([root / "absent"], root)

    def test_inventory_includes_shipped_mods_and_rejects_source_escape(self):
        with tempfile.TemporaryDirectory() as folder, tempfile.TemporaryDirectory() as external:
            root = Path(folder)
            path = root / "integrations/claude/mod.mjs"
            path.parent.mkdir(parents=True)
            path.write_text("submit();\n")
            self.assertIn("integrations/claude/mod.mjs", commit.application_sources(root))
            path.unlink()
            path.symlink_to(Path(external) / "mod.mjs")
            with self.assertRaisesRegex(ValueError, "escapes repository"):
                commit.application_sources(root)

    def test_tool_coverage_cannot_inflate_application_percentage(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "apps/main.ts"
            source.parent.mkdir()
            source.write_text("run();\n")
            actual = report(root, "web", "apps/main.ts", [0])
            tool = report(root, "tool", "tools/helper.rs", [1] * 9)
            self.assertEqual(commit.coverage_counts([actual], root), (0, 1))
            with self.assertRaisesRegex(ValueError, "not application code"):
                commit.coverage_counts([actual, tool], root)


if __name__ == "__main__":
    unittest.main()
