"""Temporary homes and scripted build artifacts; these are not native release proof."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import stat
import sys
import subprocess
import shutil
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[3] / "scripts/install/install.py"
SPEC = importlib.util.spec_from_file_location("personal_install", SOURCE)
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ariadne install fixtures ")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.home = self.base / "home with spaces"
        self.home.mkdir(mode=0o700)
        (self.home / ".local/bin").mkdir(parents=True)
        self.artifacts = self.base / "release"
        self.facts = {"os": "fixture", "architecture": "scripted"}
        self.version = "0.1.0"
        self.make_artifacts()
        self.output = io.StringIO()
        self.capture = contextlib.redirect_stdout(self.output)
        self.capture.__enter__()
        self.addCleanup(self.capture.__exit__, None, None, None)

    def make_artifacts(self, version=None):
        version = version or self.version
        app = self.artifacts / "bundle/macos/Ariadne.app/Contents"
        app.mkdir(parents=True, exist_ok=True)
        with (app / "Info.plist").open("wb") as output:
            plistlib.dump({"CFBundleShortVersionString": version}, output)
        (app / "MacOS").mkdir(exist_ok=True)
        (app / "MacOS/ariadne-desktop").write_bytes(b"fixture desktop executable")
        (app / "MacOS/ariadne-desktop").chmod(0o755)
        for name in installer.BINARIES:
            script = (f"#!{sys.executable}\nimport sys,json\n"
                      f"if sys.argv[1:]==['--version']: print('{name} {version}')\n"
                      "elif sys.argv[1]=='package-resources':\n"
                      f" print(json.dumps({{'schema_version':1,'version':'{version}','files':{{"
                      "'rules/claude.md':'fixture claude rules','rules/codex.md':'fixture codex rules',"
                      "'codex-skills/ariadne/SKILL.md':'fixture codex skill',"
                      "'claude-mod/plugin/hooks/installed.js':sys.argv[3]}}))\n"
                      "else: sys.exit(2)\n")
            (self.artifacts / name).write_text(script)
            (self.artifacts / name).chmod(0o755)

    @property
    def root(self):
        return self.home / ".local/share/ariadne"

    def install(self):
        return installer.install(self.home, self.artifacts, self.facts)

    def test_install_repeat_owned_uninstall_preserves_host_settings_and_history(self):
        history = self.home / ".ariadne/sessions/session.json"
        history.parent.mkdir(parents=True)
        history.write_bytes(b"session and backups survive")
        foreign = self.home / ".claude/settings.json"
        foreign.parent.mkdir()
        foreign.write_bytes(b"foreign host settings")
        final = self.install()
        receipt = installer.json_read(final / "install.json")
        self.assertEqual(receipt["app_path"], str(self.home / "Applications/Ariadne.app"))
        self.assertEqual(receipt["owned_files"], installer.inventory(final))
        self.assertEqual(os.readlink(self.root / "current"), "versions/0.1.0")
        self.assertEqual((self.home / "Applications/Ariadne.app").resolve(), final / "Ariadne.app")
        self.assertEqual((self.home / ".local/bin/ariadne").resolve(), final / "bin/ariadne")
        self.assertEqual((final / "integrations/claude-mod/plugin/hooks/installed.js").read_text(), str(final / "bin/ariadne"))
        self.assertEqual(stat.S_IMODE((final / "bin/ariadne").stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((final / "integrations/rules/claude.md").stat().st_mode), 0o600)
        before = (final / "install.json").stat().st_mtime_ns
        self.assertEqual(self.install(), final)
        self.assertEqual((final / "install.json").stat().st_mtime_ns, before)
        self.assertEqual(installer.uninstall(self.home), [])
        self.assertFalse(final.exists())
        self.assertFalse(installer.exists(self.root / "current"))
        self.assertFalse(installer.exists(self.home / "Applications/Ariadne.app"))
        self.assertEqual(history.read_bytes(), b"session and backups survive")
        self.assertEqual(foreign.read_bytes(), b"foreign host settings")

    def test_missing_path_directory_prints_instruction_without_creating_it(self):
        (self.home / ".local/bin").rmdir()
        final = self.install()
        self.assertFalse((self.home / ".local/bin").exists())
        self.assertIn("PATH directory is absent", self.output.getvalue())
        self.assertEqual(set(installer.json_read(final / "install.json")["owned_links"]),
                         {"Applications/Ariadne.app", installer.SKILL_LINK})

    @property
    def skill(self):
        return self.home / installer.SKILL_LINK

    def test_codex_skill_link_is_created_recorded_idempotent_and_removed_leaving_parent(self):
        final = self.install()
        self.assertTrue(self.skill.is_symlink())
        self.assertEqual(self.skill.resolve(), final / "integrations/codex-skills/ariadne")
        self.assertEqual((self.skill / "SKILL.md").read_text(), "fixture codex skill")
        self.assertIn(installer.SKILL_LINK, installer.json_read(final / "install.json")["owned_links"])
        before = (final / "install.json").stat().st_mtime_ns
        self.assertEqual(self.install(), final)
        self.assertEqual((final / "install.json").stat().st_mtime_ns, before)
        self.assertTrue(self.skill.is_symlink())
        self.assertEqual(installer.uninstall(self.home), [])
        self.assertFalse(installer.exists(self.skill))
        self.assertTrue((self.home / ".agents/skills").is_dir())

    def test_codex_skill_upgrade_keeps_owned_link_pointing_at_current(self):
        self.install()
        self.make_artifacts("0.2.0")
        second = self.install()
        self.assertEqual(self.skill.resolve(), second / "integrations/codex-skills/ariadne")
        self.assertEqual(installer.uninstall(self.home), [])
        self.assertFalse(installer.exists(self.skill))

    def test_foreign_codex_skill_is_skipped_with_instruction_and_never_removed(self):
        for kind in ("directory", "file", "symlink"):
            self.skill.parent.mkdir(parents=True, exist_ok=True)
            if kind == "directory":
                self.skill.mkdir()
                (self.skill / "SKILL.md").write_bytes(b"owner skill")
            elif kind == "file":
                self.skill.write_bytes(b"owner file")
            else:
                self.skill.symlink_to(installer.links(self.home)[installer.SKILL_LINK])
            self.output.truncate(0)
            self.output.seek(0)
            final = self.install()
            self.assertIn("Skipped the Codex skill link", self.output.getvalue())
            self.assertNotIn(installer.SKILL_LINK, installer.json_read(final / "install.json")["owned_links"])
            self.assertEqual(installer.uninstall(self.home), [])
            self.assertTrue(installer.exists(self.skill), kind)
            if kind == "directory":
                self.assertEqual((self.skill / "SKILL.md").read_bytes(), b"owner skill")
                shutil.rmtree(self.skill)
            elif kind == "file":
                self.assertEqual(self.skill.read_bytes(), b"owner file")
                self.skill.unlink()
            else:
                self.skill.unlink()

    def test_redirected_agents_directory_is_skipped_without_writing_through_it(self):
        outside = self.base / "outside-agents"
        (outside / "skills").mkdir(parents=True)
        (self.home / ".agents").symlink_to(outside)
        self.install()
        self.assertIn("Skipped the Codex skill link", self.output.getvalue())
        self.assertEqual(list((outside / "skills").iterdir()), [])
        self.assertEqual(installer.uninstall(self.home), [])
        self.assertTrue((self.home / ".agents").is_symlink())

    def test_redirected_agents_skills_directory_is_skipped_without_writing_through_it(self):
        outside = self.base / "outside-skills"
        outside.mkdir()
        (self.home / ".agents").mkdir()
        (self.home / ".agents/skills").symlink_to(outside)
        self.install()
        self.assertIn("Skipped the Codex skill link", self.output.getvalue())
        self.assertEqual(list(outside.iterdir()), [])
        self.assertEqual(installer.uninstall(self.home), [])
        self.assertTrue((self.home / ".agents/skills").is_symlink())

    def test_same_version_reinstall_after_owner_replaced_link_skips_and_keeps_it(self):
        final = self.install()
        self.skill.unlink()
        self.skill.write_bytes(b"owner replacement")
        self.output.truncate(0)
        self.output.seek(0)
        self.assertEqual(self.install(), final)
        self.assertIn("Skipped the Codex skill link", self.output.getvalue())
        self.assertIn("link", self.output.getvalue())
        self.assertEqual(self.skill.read_bytes(), b"owner replacement")
        self.assertIn(str(self.skill), installer.uninstall(self.home))
        self.assertEqual(self.skill.read_bytes(), b"owner replacement")

    def test_same_version_reinstall_with_redirected_agents_skips_without_error(self):
        final = self.install()
        outside = self.base / "outside-agents"
        (outside / "skills").mkdir(parents=True)
        self.skill.unlink()
        self.skill.parent.rmdir()
        self.skill.parent.parent.rmdir()
        (self.home / ".agents").symlink_to(outside)
        self.assertEqual(self.install(), final)
        self.assertIn("Skipped the Codex skill link", self.output.getvalue())
        self.assertEqual(list((outside / "skills").iterdir()), [])

    def test_same_version_older_receipt_without_link_does_not_create_or_fail(self):
        final = self.install()
        receipt = installer.json_read(final / "install.json")
        del receipt["owned_links"][installer.SKILL_LINK]
        (final / "install.json").write_bytes(installer.encode(receipt))
        self.skill.unlink()
        self.output.truncate(0)
        self.output.seek(0)
        self.assertEqual(self.install(), final)
        self.assertIn("does not record it", self.output.getvalue())
        self.assertFalse(installer.exists(self.skill))
        self.assertEqual(installer.uninstall(self.home), [])

    def test_replaced_owned_codex_skill_link_survives_uninstall(self):
        self.install()
        self.skill.unlink()
        self.skill.write_bytes(b"owner replacement")
        self.assertIn(str(self.skill), installer.uninstall(self.home))
        self.assertEqual(self.skill.read_bytes(), b"owner replacement")

    def test_upgrade_retains_previous_immutable_version_then_uninstalls_both(self):
        first = self.install()
        original = (first / "bin/ariadne").read_bytes()
        self.make_artifacts("0.2.0")
        second = self.install()
        self.assertEqual(first.name, "0.1.0")
        self.assertEqual(second.name, "0.2.0")
        self.assertEqual((first / "bin/ariadne").read_bytes(), original)
        self.assertEqual((self.root / "current").resolve(), second)
        self.assertEqual(installer.uninstall(self.home), [])

    def test_same_version_changed_source_and_edited_install_are_refused(self):
        final = self.install()
        original = (final / "bin/ariadne").read_bytes()
        (self.artifacts / "bundle/macos/Ariadne.app/Contents/Info.plist").write_bytes(
            plistlib.dumps({"CFBundleShortVersionString": self.version, "Changed": True}))
        with self.assertRaisesRegex(installer.InstallError, "Same-version"):
            self.install()
        self.assertEqual((final / "bin/ariadne").read_bytes(), original)
        (final / "integrations/rules/claude.md").write_bytes(b"owner edited rule")
        with self.assertRaisesRegex(installer.InstallError, "contains edits"):
            self.install()
        self.assertEqual((final / "integrations/rules/claude.md").read_bytes(), b"owner edited rule")

    def test_edited_and_foreign_package_files_and_links_survive_uninstall(self):
        final = self.install()
        edited = final / "integrations/rules/claude.md"
        edited.write_bytes(b"owner edited")
        foreign = final / "owner-notes.txt"
        foreign.write_bytes(b"foreign notes")
        foreign_directory = final / "owner-empty-directory"
        foreign_directory.mkdir()
        path = self.home / ".local/bin/ariadne"
        path.unlink()
        path.write_bytes(b"foreign helper replacement")
        retained = installer.uninstall(self.home)
        self.assertIn(str(edited), retained)
        self.assertEqual(edited.read_bytes(), b"owner edited")
        self.assertEqual(foreign.read_bytes(), b"foreign notes")
        self.assertTrue(foreign_directory.is_dir())
        self.assertEqual(path.read_bytes(), b"foreign helper replacement")
        self.assertFalse((final / "bin/ariadne").exists())
        self.assertTrue((final / "install.json").exists())

    def test_foreign_app_file_and_matching_unowned_symlink_are_not_adopted(self):
        app = self.home / "Applications/Ariadne.app"
        app.parent.mkdir()
        for kind in ("file", "symlink"):
            if kind == "file":
                app.write_bytes(b"foreign application")
            else:
                app.symlink_to(installer.links(self.home)["Applications/Ariadne.app"])
            with self.assertRaisesRegex(installer.InstallError, "Foreign or edited"):
                self.install()
            self.assertTrue(installer.exists(app))
            app.unlink()

    def test_redirected_directories_and_current_pointer_are_rejected(self):
        for target in (".local", ".local/share", ".local/share/ariadne/versions", "Applications"):
            home = self.base / ("unsafe-" + target.replace("/", "-"))
            home.mkdir()
            destination = home / target
            destination.parent.mkdir(parents=True, exist_ok=True)
            outside = self.base / ("outside-" + target.replace("/", "-"))
            outside.mkdir()
            destination.symlink_to(outside, target_is_directory=True)
            with self.assertRaises(installer.InstallError):
                installer.install(home, self.artifacts, self.facts)
            self.assertEqual(list(outside.iterdir()), [])
        self.install()
        (self.root / "current").unlink()
        (self.root / "current").symlink_to(self.base)
        with self.assertRaises(installer.InstallError):
            self.install()
        with self.assertRaises(installer.InstallError):
            installer.uninstall(self.home)

    def test_external_app_symlink_aborts_stage_and_leaves_previous_version_intact(self):
        first = self.install()
        self.make_artifacts("0.2.0")
        outside = self.base / "foreign.txt"
        outside.write_bytes(b"foreign")
        (self.artifacts / "bundle/macos/Ariadne.app/Contents/escaped").symlink_to(outside)
        with self.assertRaisesRegex(installer.InstallError, "escapes"):
            self.install()
        self.assertEqual((self.root / "current").resolve(), first)
        self.assertEqual(outside.read_bytes(), b"foreign")
        self.assertEqual(sorted(path.name for path in (self.root / "versions").iterdir()), ["0.1.0"])

    def test_internal_app_symlink_is_installed_and_safely_removed(self):
        app = self.artifacts / "bundle/macos/Ariadne.app/Contents"
        (app / "current-info").symlink_to("Info.plist")
        final = self.install()
        self.assertEqual(os.readlink(final / "Ariadne.app/Contents/current-info"), "Info.plist")
        self.assertEqual(installer.uninstall(self.home), [])

    def test_failed_atomic_publication_removes_attempts_paths_and_preserves_old_install(self):
        first = self.install()
        before = (first / "install.json").read_bytes()
        self.make_artifacts("0.2.0")
        with patch.object(installer.os, "replace", side_effect=OSError("publication failure")):
            with self.assertRaisesRegex(OSError, "publication failure"):
                self.install()
        self.assertEqual((self.root / "current").resolve(), first)
        self.assertEqual((first / "install.json").read_bytes(), before)
        self.assertFalse((self.root / "versions/0.2.0").exists())
        self.assertFalse(installer.exists(self.root / ".current-next"))
        self.assertEqual((self.home / "Applications/Ariadne.app").resolve(), first / "Ariadne.app")

    def test_failed_first_publication_does_not_leave_owned_links(self):
        with patch.object(installer.os, "replace", side_effect=OSError("publication failure")):
            with self.assertRaises(OSError):
                self.install()
        self.assertFalse(installer.exists(self.home / "Applications/Ariadne.app"))
        self.assertFalse(installer.exists(self.home / ".local/bin/ariadne"))
        self.assertFalse((self.root / "versions/0.1.0").exists())

    def test_failed_publication_cleanup_uses_retained_versions_not_foreign_tree(self):
        outside = self.base / "foreign-published-versions"
        outside.mkdir()
        saved = self.root / "saved-versions"
        captured = {}
        def swap_then_fail(*args, **kwargs):
            version = self.root / "versions/0.1.0"
            foreign = outside / version.name
            shutil.copytree(version, foreign, symlinks=True)
            captured["inventory"] = installer.inventory(foreign)
            (self.root / "versions").rename(saved)
            (self.root / "versions").symlink_to(outside)
            raise OSError("publication after ancestor swap")
        with patch.object(installer.os, "replace", side_effect=swap_then_fail):
            with self.assertRaisesRegex(OSError, "ancestor swap"):
                self.install()
        self.assertEqual(installer.inventory(outside / "0.1.0"), captured["inventory"])
        self.assertTrue((outside / "0.1.0/install.json").exists())
        self.assertFalse((saved / "0.1.0").exists())

    def test_unknown_manifest_inventory_never_unlinks_paths(self):
        final = self.install()
        foreign = self.home / "foreign.txt"
        foreign.write_bytes(b"foreign content")
        value = installer.json_read(final / "install.json")
        value["owned_files"]["../../../../../../foreign.txt"] = next(iter(value["owned_files"].values()))
        (final / "install.json").write_bytes(installer.encode(value))
        with self.assertRaises(installer.InstallError):
            installer.uninstall(self.home)
        self.assertEqual(foreign.read_bytes(), b"foreign content")
        self.assertTrue((final / "bin/ariadne").exists())

    def test_invented_integration_inventory_is_not_authorized_by_containment(self):
        final = self.install()
        foreign = final / "integrations/rules/foreign.txt"
        foreign.write_bytes(b"foreign integration note")
        foreign.chmod(0o600)
        value = installer.json_read(final / "install.json")
        value["owned_files"]["integrations/rules/foreign.txt"] = installer.record(foreign, final / "Ariadne.app")
        (final / "install.json").write_bytes(installer.encode(value))
        with self.assertRaisesRegex(installer.InstallError, "Unknown integration inventory"):
            installer.uninstall(self.home)
        self.assertEqual(foreign.read_bytes(), b"foreign integration note")
        self.assertTrue((final / "bin/ariadne").exists())

    def test_edited_helper_is_never_executed_and_entire_package_is_preserved(self):
        final = self.install()
        sentinel = self.base / "must-not-exist"
        helper = final / "bin/ariadne"
        helper.write_text(f"#!{sys.executable}\nfrom pathlib import Path\nPath({str(sentinel)!r}).touch()\n")
        with self.assertRaisesRegex(installer.InstallError, "helper identity"):
            installer.uninstall(self.home)
        self.assertFalse(sentinel.exists())
        self.assertTrue((final / "bin/ariadne-mcp").exists())
        self.assertTrue((final / "integrations/rules/claude.md").exists())

    def test_original_empty_app_directory_is_removed_but_foreign_directory_survives(self):
        (self.artifacts / "bundle/macos/Ariadne.app/Contents/empty-original").mkdir()
        final = self.install()
        self.assertIn("Ariadne.app/Contents/empty-original", installer.json_read(final / "install.json")["owned_directories"])
        self.assertEqual(installer.uninstall(self.home), [])
        self.assertFalse(final.exists())

    def test_unsupported_inactive_descriptor_is_retained_without_authorizing_removal(self):
        self.install()
        unknown = self.root / "versions/0.0.1"
        unknown.mkdir()
        (unknown / "install.json").write_text('{"inventory_version":99}')
        self.assertIn(str(unknown), installer.uninstall(self.home))
        self.assertTrue((unknown / "install.json").exists())

    def test_duplicate_oversized_nonregular_and_symlink_manifest_are_rejected(self):
        final = self.install()
        path = final / "install.json"
        original = path.read_bytes()
        for bad in (b'{"schema_version":1,"schema_version":1}', b" " * (installer.LIMIT + 1)):
            path.write_bytes(bad)
            with self.assertRaises(installer.InstallError):
                installer.descriptor(final, self.home)
        path.unlink()
        foreign = self.base / "foreign-manifest"
        foreign.write_bytes(original)
        path.symlink_to(foreign)
        with self.assertRaises((installer.InstallError, OSError)):
            installer.descriptor(final, self.home)
        path.unlink()
        os.mkfifo(path)
        with self.assertRaises(installer.InstallError):
            installer.descriptor(final, self.home)

    def test_edited_parent_symlink_retains_owned_files_and_foreign_target(self):
        final = self.install()
        rules = final / "integrations/rules"
        (rules / "claude.md").unlink()
        (rules / "codex.md").unlink()
        rules.rmdir()
        outside = self.base / "outside-rules"
        outside.mkdir()
        (outside / "claude.md").write_bytes(b"foreign rules")
        rules.symlink_to(outside)
        installer.uninstall(self.home)
        self.assertEqual((outside / "claude.md").read_bytes(), b"foreign rules")
        self.assertTrue(rules.is_symlink())

    def test_existing_redirected_parent_with_complete_package_is_rejected(self):
        self.install()
        local = self.home / ".local"
        outside = self.base / "complete-outside-local"
        local.rename(outside)
        local.symlink_to(outside)
        with self.assertRaisesRegex(installer.InstallError, "Unsafe directory"):
            self.install()
        with self.assertRaisesRegex(installer.InstallError, "Unsafe directory"):
            installer.uninstall(self.home)
        self.assertTrue((outside / "share/ariadne/versions/0.1.0/bin/ariadne").exists())

    def test_unknown_and_busy_lock_refuse_without_mutating_installation(self):
        final = self.install()
        before = (final / "install.json").read_bytes()
        with installer.locked(self.home):
            with self.assertRaisesRegex(installer.InstallError, "Another install"):
                self.install()
        self.assertEqual((final / "install.json").read_bytes(), before)

    def test_parent_path_swap_cannot_redirect_anchored_owned_removal(self):
        final = self.install()
        name = "integrations/rules/claude.md"
        expected = installer.json_read(final / "install.json")["owned_files"][name]
        rules = final / "integrations/rules"
        moved = final / "integrations/previous-rules"
        outside = self.base / "outside-race"
        outside.mkdir()
        foreign = outside / "claude.md"
        foreign.write_bytes((rules / "claude.md").read_bytes())
        real_unlink = installer.os.unlink
        def swap_before_unlink(path, *, dir_fd=None):
            rules.rename(moved)
            rules.symlink_to(outside)
            return real_unlink(path, dir_fd=dir_fd)
        with patch.object(installer.os, "unlink", side_effect=swap_before_unlink):
            self.assertTrue(installer.remove_owned(final, name, expected))
        self.assertEqual(foreign.read_bytes(), b"fixture claude rules")
        self.assertFalse((moved / "claude.md").exists())

    def test_ancestor_swap_before_package_open_never_removes_equal_foreign_file(self):
        final = self.install()
        name = "integrations/rules/claude.md"
        expected = installer.json_read(final / "install.json")["owned_files"][name]
        outside = self.base / "foreign-versions"
        foreign = outside / final.name / name
        foreign.parent.mkdir(parents=True)
        foreign.write_bytes((final / name).read_bytes())
        foreign.chmod(expected["mode"])
        versions = self.root / "versions"
        saved = self.root / "saved-versions"
        real_open = installer.os.open
        swapped = False
        def swap_before_root_open(path, flags, *args, **kwargs):
            nonlocal swapped
            # Covers the original absolute-root implementation and the new
            # component walk, so the regression fails against the reviewed bug.
            if not swapped and (Path(path) == final or str(path) == "versions"):
                versions.rename(saved)
                versions.symlink_to(outside)
                swapped = True
            return real_open(path, flags, *args, **kwargs)
        with patch.object(installer.os, "open", side_effect=swap_before_root_open):
            with self.assertRaises((installer.InstallError, OSError)):
                installer.remove_owned(final, name, expected)
        self.assertTrue(swapped)
        self.assertEqual(foreign.read_bytes(), b"fixture claude rules")
        self.assertEqual((saved / final.name / name).read_bytes(), b"fixture claude rules")

    def test_uninstall_retained_anchors_protect_foreign_tree_after_versions_swap(self):
        final = self.install()
        outside = self.base / "foreign-version-tree"
        foreign = outside / final.name / "integrations/rules/claude.md"
        foreign.parent.mkdir(parents=True)
        foreign.write_bytes((final / "integrations/rules/claude.md").read_bytes())
        foreign.chmod(0o600)
        versions = self.root / "versions"
        saved = self.root / "saved-versions"
        remove = installer.remove_owned
        swapped = False
        def swap_before_first_removal(root, name, expected):
            nonlocal swapped
            if not swapped:
                versions.rename(saved)
                versions.symlink_to(outside)
                swapped = True
            return remove(root, name, expected)
        with patch.object(installer, "remove_owned", side_effect=swap_before_first_removal):
            installer.uninstall(self.home)
        self.assertTrue(swapped)
        self.assertEqual(foreign.read_bytes(), b"fixture claude rules")
        self.assertTrue((outside / final.name).is_dir())
        self.assertFalse((saved / final.name).exists())

    def test_file_identity_change_after_read_is_retained(self):
        final = self.install()
        name = "integrations/rules/claude.md"
        expected = installer.json_read(final / "install.json")["owned_files"][name]
        real_stat = installer.os.stat
        probes = 0
        def change_before_recheck(path, *args, **kwargs):
            nonlocal probes
            if kwargs.get("dir_fd") is not None:
                probes += 1
                if probes == 2:
                    (final / name).write_bytes(b"edit during removal")
            return real_stat(path, *args, **kwargs)
        with patch.object(installer.os, "stat", side_effect=change_before_recheck):
            self.assertFalse(installer.remove_owned(final, name, expected))
        self.assertEqual((final / name).read_bytes(), b"edit during removal")

    def test_resource_invalid_version_and_oversized_output_are_bounded(self):
        final_helper = self.root / "versions/0.1.0/bin/ariadne"
        binary = self.artifacts / "ariadne"
        binary.write_text(f"#!{sys.executable}\nprint(' ' * {installer.LIMIT + 1})\n")
        binary.chmod(0o700)
        with self.assertRaisesRegex(installer.InstallError, "output limit"):
            installer.resources(binary, final_helper)
        for data in ({"schema_version": 2, "version": "0.1.0", "files": {}},
                     {"schema_version": 1, "version": "0.2.0", "files": {"rules/x": "x"}},
                     {"schema_version": 1, "version": "0.1.0", "files": {"../x": "x"}}):
            binary.write_text(f"#!{sys.executable}\nprint({json.dumps(json.dumps(data))})\n")
            with self.assertRaises(installer.InstallError):
                installer.resources(binary, final_helper)

    def test_version_and_special_source_files_fail_before_publication(self):
        (self.artifacts / "ariadne-mcp").write_text(f"#!{sys.executable}\nprint('ariadne-mcp 9.9.9')\n")
        with self.assertRaisesRegex(installer.InstallError, "versions differ"):
            self.install()
        self.assertFalse(installer.exists(self.root / "current"))
        self.make_artifacts()
        os.mkfifo(self.artifacts / "bundle/macos/Ariadne.app/Contents/fifo")
        # copytree refuses FIFOs rather than opening a blocking stream.
        with self.assertRaises(shutil_error()):
            self.install()

    def test_main_uses_build_and_installed_doctor_and_never_builds_uninstall(self):
        with patch.dict(os.environ, {"HOME": str(self.home)}), \
                patch.object(installer, "build", return_value=(self.artifacts, self.facts)) as build, \
                patch.object(installer, "run") as run:
            # The file installer independently probes versions; leave it real in other tests.
            with patch.object(installer, "install", return_value=Path("/fixture/version")):
                installer.main(["install"])
            build.assert_called_once()
            run.assert_called_once_with([Path("/fixture/version/bin/ariadne"), "doctor"])
            installer.main(["uninstall"])
            build.assert_called_once()
        self.assertIn("No personal Ariadne package", self.output.getvalue())


def shutil_error():
    return shutil.Error


class BuildTests(unittest.TestCase):
    def test_preflight_records_exact_supported_tools_and_rejects_unsupported(self):
        answers = {"node": "v22.23.2", "npm": "10.9.8", "rustc": "rustc 1.98.1 (fixture)", "cargo": "cargo 1.98.1 (fixture)",
                   "xcode-select": "/Xcode", "xcrun": "/SDK"}
        with patch.object(installer.platform, "system", return_value="Darwin"), \
                patch.object(installer.platform, "mac_ver", return_value=("13.7", (), "")), \
                patch.object(installer.platform, "machine", return_value="arm64"), \
                patch.object(installer, "run", side_effect=lambda args, **kwargs: answers[args[3] if args[0] == "rustup" else args[0]]):
            self.assertEqual(installer.preflight()["architecture"], "arm64")
            answers["npm"] = "wrong"
            with self.assertRaisesRegex(installer.InstallError, "pinned npm"):
                installer.preflight()
        with patch.object(installer.platform, "system", return_value="Linux"):
            with self.assertRaisesRegex(installer.InstallError, "requires macOS"):
                installer.preflight()

    def test_build_uses_locks_generation_checks_and_clean_production_environment(self):
        with patch.object(installer, "preflight", return_value={"architecture": "arm64"}), \
                patch.object(installer, "run") as run, \
                patch.dict(os.environ, {"VITE_ARIADNE_E2E": "1", "RUSTFLAGS": "--bad", "TAURI_CONFIG": "bad"}), \
                contextlib.redirect_stdout(io.StringIO()):
            artifacts, facts = installer.build()
        self.assertEqual(artifacts, installer.ROOT / "target/personal-install/release")
        self.assertEqual(facts, {"architecture": "arm64"})
        calls = run.call_args_list
        self.assertEqual(calls[0].args[0], ["npm", "ci", "--ignore-scripts", "--engine-strict"])
        self.assertEqual(len(calls), 6)
        for call in calls[1:]:
            self.assertIn("--locked", call.args[0])
            self.assertNotIn("RUSTFLAGS", call.kwargs["env"])
            self.assertNotIn("VITE_ARIADNE_E2E", call.kwargs["env"])
            self.assertEqual(call.kwargs["env"]["RUSTUP_AUTO_INSTALL"], "0")
            self.assertEqual(call.kwargs["env"]["RUSTUP_TOOLCHAIN"], "1.98.1")
        self.assertIn("--no-default-features", calls[-1].args[0])
        self.assertEqual(calls[-1].kwargs["env"]["MACOSX_DEPLOYMENT_TARGET"], "13.0")

    def test_missing_rustup_toolchain_refuses_without_channel_sync_or_download(self):
        with tempfile.TemporaryDirectory(prefix="ariadne missing rustup ") as temporary:
            errors = []
            probes = []
            def probe(args, **kwargs):
                probes.append(args)
                if args[0] == "node":
                    return "v22.23.2"
                if args[0] == "npm":
                    return "10.9.8"
                env = {**kwargs["env"], "RUSTUP_HOME": str(Path(temporary) / "empty-rustup"),
                       "RUSTUP_DIST_SERVER": "http://127.0.0.1:9"}
                result = subprocess.run(args, cwd=installer.ROOT, env=env, text=True,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
                errors.append(result.stderr)
                result.check_returncode()
                return result.stdout
            with patch.object(installer.platform, "system", return_value="Darwin"), \
                    patch.object(installer.platform, "mac_ver", return_value=("13.7", (), "")), \
                    patch.object(installer.platform, "machine", return_value="arm64"), \
                    patch.object(installer, "run", side_effect=probe):
                with self.assertRaisesRegex(installer.InstallError, "Install/select Rust 1.98.1"):
                    installer.preflight()
            self.assertEqual(probes[-1], ["rustup", "run", "1.98.1", "rustc", "--version"])
            self.assertNotIn("--install", probes[-1])
            self.assertIn("not installed", "".join(errors))
            self.assertNotIn("syncing channel", "".join(errors))
            self.assertNotIn("downloading", "".join(errors))
            self.assertFalse((Path(temporary) / "empty-rustup/toolchains").exists())


if __name__ == "__main__":
    unittest.main()
