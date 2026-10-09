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
            plistlib.dump({"CFBundleShortVersionString": version, "CFBundleIdentifier": "dev.ariadne.fixture"}, output)
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
        app = self.home / "Applications/Ariadne.app"
        self.assertTrue(app.is_dir() and not app.is_symlink())
        self.assertEqual(receipt["owned_app"], True)
        self.assertEqual(installer.app_inventory(app),
                         {k: v for k, v in installer.inventory(final).items() if k.startswith("Ariadne.app/")})
        self.assertEqual(sorted(p.name for p in app.parent.iterdir()), ["Ariadne.app"])
        self.assertEqual((self.home / ".local/bin/ariadne").resolve(), final / "bin/ariadne")
        self.assertEqual((final / "integrations/claude-mod/plugin/hooks/installed.js").read_text(), str(final / "bin/ariadne"))
        self.assertEqual(stat.S_IMODE((final / "bin/ariadne").stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((final / "integrations/rules/claude.md").stat().st_mode), 0o600)
        before = (final / "install.json").read_bytes()
        self.assertEqual(self.install(), final)
        self.assertIn("Replacing the Ariadne 0.1.0 already installed (your projects and history are kept).",
                      self.output.getvalue())
        self.assertNotIn("without an install record", self.output.getvalue())
        self.assertEqual((final / "install.json").read_bytes(), before)
        self.assertEqual(history.read_bytes(), b"session and backups survive")
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
        self.assertIn("add ~/.local/share/ariadne/current/bin to PATH", self.output.getvalue())
        self.assertEqual(len(self.output.getvalue().splitlines()), 1)
        self.assertEqual(set(installer.json_read(final / "install.json")["owned_links"]),
                         {installer.SKILL_LINK})

    @property
    def skill(self):
        return self.home / installer.SKILL_LINK

    def test_codex_skill_link_is_created_recorded_idempotent_and_removed_leaving_parent(self):
        final = self.install()
        self.assertTrue(self.skill.is_symlink())
        self.assertEqual(self.skill.resolve(), final / "integrations/codex-skills/ariadne")
        self.assertEqual((self.skill / "SKILL.md").read_text(), "fixture codex skill")
        self.assertIn(installer.SKILL_LINK, installer.json_read(final / "install.json")["owned_links"])
        before = (final / "install.json").read_bytes()
        self.assertEqual(self.install(), final)
        self.assertEqual((final / "install.json").read_bytes(), before)
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
                self.skill.symlink_to(self.base / "owner-skill")
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
        self.assertNotIn(installer.SKILL_LINK, installer.json_read(final / "install.json")["owned_links"])
        self.assertEqual(installer.uninstall(self.home), [])
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

    def test_same_version_older_receipt_without_link_is_replaced_with_a_complete_receipt(self):
        final = self.install()
        receipt = installer.json_read(final / "install.json")
        del receipt["owned_links"][installer.SKILL_LINK]
        (final / "install.json").write_bytes(installer.encode(receipt))
        self.skill.unlink()
        self.assertEqual(self.install(), final)
        self.assertTrue(self.skill.is_symlink())
        self.assertIn(installer.SKILL_LINK, installer.json_read(final / "install.json")["owned_links"])
        self.assertEqual(installer.uninstall(self.home), [])
        self.assertFalse(installer.exists(self.skill))

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

    def test_same_version_changed_source_replaces_and_edited_install_is_refused_untouched(self):
        final = self.install()
        (self.artifacts / "bundle/macos/Ariadne.app/Contents/Info.plist").write_bytes(
            plistlib.dumps({"CFBundleShortVersionString": self.version, "Changed": True}))
        self.assertEqual(self.install(), final)
        self.assertTrue(plistlib.loads((final / "Ariadne.app/Contents/Info.plist").read_bytes())["Changed"])
        (final / "integrations/rules/claude.md").write_bytes(b"owner edited rule")
        with self.assertRaisesRegex(installer.InstallError, f"Move the folder {final} somewhere else"):
            self.install()
        self.assertEqual((final / "integrations/rules/claude.md").read_bytes(), b"owner edited rule")
        self.assertTrue((final / "bin/ariadne").exists())
        self.assertTrue(self.app.is_dir())
        self.assertTrue((self.home / ".local/bin/ariadne").is_symlink())

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
                app.symlink_to(installer.LEGACY_APP_TARGET)
            with self.assertRaisesRegex(installer.InstallError, "Foreign or edited"):
                self.install()
            self.assertTrue(installer.exists(app))
            app.unlink()

    @property
    def app(self):
        return self.home / "Applications/Ariadne.app"

    def make_legacy(self, final):
        """Rewrite a fresh install as the ADR-0062 layout: version-1 receipt and an app symlink."""
        shutil.rmtree(self.app)
        self.app.symlink_to(installer.LEGACY_APP_TARGET)
        receipt = installer.json_read(final / "install.json")
        del receipt["owned_app"]
        receipt["inventory_version"] = 1
        receipt["owned_links"][installer.APP_PATH] = installer.LEGACY_APP_TARGET
        (final / "install.json").write_bytes(installer.encode(receipt))

    def leftovers(self):
        return [p.name for p in self.app.parent.iterdir() if p.name != "Ariadne.app"]

    def test_old_symlink_layout_is_migrated_by_same_version_install_and_removed_by_uninstall(self):
        final = self.install()
        self.make_legacy(final)
        self.assertEqual(self.install(), final)
        self.assertTrue(self.app.is_dir() and not self.app.is_symlink())
        self.assertEqual(self.leftovers(), [])
        self.assertEqual(installer.json_read(final / "install.json")["inventory_version"], 2)
        self.assertEqual(self.install(), final)
        self.assertEqual(installer.uninstall(self.home), [])
        self.assertFalse(installer.exists(self.app))
        self.assertFalse(final.exists())

    def test_old_symlink_layout_is_migrated_by_upgrade_and_both_versions_uninstall(self):
        self.make_legacy(self.install())
        self.make_artifacts("0.2.0")
        second = self.install()
        self.assertTrue(self.app.is_dir() and not self.app.is_symlink())
        self.assertEqual(installer.app_inventory(self.app), installer.bundle_files(installer.inventory(second)))
        self.assertEqual(installer.uninstall(self.home), [])
        self.assertFalse(installer.exists(self.app))
        self.assertEqual(os.listdir(self.root / "versions"), [])

    def test_uninstall_removes_the_owned_old_layout_symlink(self):
        self.make_legacy(self.install())
        self.assertEqual(installer.uninstall(self.home), [])
        self.assertFalse(installer.exists(self.app))
        self.assertEqual(os.listdir(self.root / "versions"), [])

    def test_foreign_app_directory_refuses_install_and_survives_uninstall(self):
        self.app.mkdir(parents=True)
        (self.app / "owner.txt").write_bytes(b"owner bundle")
        with self.assertRaisesRegex(installer.InstallError, "Foreign or edited"):
            self.install()
        self.assertEqual((self.app / "owner.txt").read_bytes(), b"owner bundle")
        self.assertFalse(installer.exists(self.root / "current"))
        self.assertEqual(installer.uninstall(self.home), [])
        self.assertEqual((self.app / "owner.txt").read_bytes(), b"owner bundle")
        # A receipt that owns an app, with a foreign directory now in its place, leaves it too.
        shutil.rmtree(self.app)
        final = self.install()
        shutil.rmtree(self.app)
        self.app.mkdir()
        (self.app / "owner.txt").write_bytes(b"owner bundle")
        installer.uninstall(self.home)
        self.assertEqual((self.app / "owner.txt").read_bytes(), b"owner bundle")
        self.assertFalse((final / "bin").exists())

    def test_unrecorded_matching_app_is_replaced_with_one_plain_message(self):
        for identical in (False, True):
            with self.subTest(identical=identical):
                final = self.install()
                final.rename(self.base / f"saved-version-{identical}")
                if not identical:
                    (self.app / "Contents/MacOS/ariadne-desktop").write_bytes(b"older app")
                previous_inode = self.app.stat().st_ino
                self.output.truncate(0)
                self.output.seek(0)
                again = self.install()
                line = "Found an Ariadne app without an install record; replacing it."
                self.assertEqual(self.output.getvalue().splitlines().count(line), 1)
                self.assertNotEqual(self.app.stat().st_ino, previous_inode)
                self.assertEqual(installer.app_inventory(self.app),
                                 installer.bundle_files(installer.inventory(again)))
                self.assertEqual(installer.uninstall(self.home), [])

    def test_unrecorded_app_adoption_is_not_announced_when_a_link_refuses_install(self):
        final = self.install()
        final.rename(self.base / "saved-version")
        helper = self.home / ".local/bin/ariadne"
        helper.unlink()
        helper.write_bytes(b"owner helper")
        previous = installer.app_inventory(self.app)
        self.output.truncate(0)
        self.output.seek(0)
        with self.assertRaisesRegex(installer.InstallError, "Foreign or edited"):
            self.install()
        self.assertNotIn("without an install record", self.output.getvalue())
        self.assertEqual(installer.app_inventory(self.app), previous)

    def test_unrecorded_app_with_another_identifier_is_refused_without_adoption_message(self):
        final = self.install()
        final.rename(self.base / "saved-version")
        info = self.app / "Contents/Info.plist"
        with info.open("wb") as output:
            plistlib.dump({"CFBundleIdentifier": "dev.other.fixture"}, output)
        previous = installer.app_inventory(self.app)
        self.output.truncate(0)
        self.output.seek(0)
        with self.assertRaisesRegex(installer.InstallError, "Foreign or edited"):
            self.install()
        self.assertNotIn("without an install record", self.output.getvalue())
        self.assertEqual(installer.app_inventory(self.app), previous)
        self.assertEqual(installer.uninstall(self.home), [])
        self.assertEqual(installer.app_inventory(self.app), previous)

    def test_edited_app_copy_is_left_by_uninstall_with_a_plain_message(self):
        final = self.install()
        edited = self.app / "Contents/MacOS/ariadne-desktop"
        edited.write_bytes(b"owner patched executable")
        with self.assertRaisesRegex(installer.InstallError, "Foreign or edited"):
            self.install()
        self.assertEqual(installer.uninstall(self.home), [])
        self.assertEqual(edited.read_bytes(), b"owner patched executable")
        self.assertNotIn("without an install record", self.output.getvalue())
        self.assertIn("was edited after install, so it was left in place", self.output.getvalue())
        self.assertFalse(final.exists())

    def test_failure_mid_copy_leaves_no_stage_and_keeps_the_previous_copy(self):
        first = self.install()
        previous = installer.app_inventory(self.app)
        self.make_artifacts("0.2.0")
        real = shutil.copytree

        def partial(source, destination, *args, **options):
            if ".Ariadne.app.stage-" in str(destination):
                Path(destination).mkdir()
                (Path(destination) / "half").write_bytes(b"x")
                raise OSError("copy failure")
            return real(source, destination, *args, **options)

        with patch.object(installer.shutil, "copytree", side_effect=partial):
            with self.assertRaisesRegex(OSError, "copy failure"):
                self.install()
        self.assertEqual(self.leftovers(), [])
        self.assertEqual(installer.app_inventory(self.app), previous)
        # The pointer already moved; the old copy is still provably ours, so a retry completes.
        second = self.install()
        self.assertEqual(installer.app_inventory(self.app), installer.bundle_files(installer.inventory(second)))
        self.assertEqual(self.leftovers(), [])
        self.assertEqual(installer.uninstall(self.home), [])
        self.assertTrue(first.name not in os.listdir(self.root / "versions"))

    def test_failed_swap_restores_the_previous_copy(self):
        self.install()
        self.make_artifacts("0.2.0")
        previous = installer.app_inventory(self.app)
        real = installer.os.rename

        def rename(source, destination, **options):
            if str(source).startswith(".Ariadne.app.stage-"):
                raise OSError("swap failure")
            return real(source, destination, **options)

        with patch.object(installer.os, "rename", side_effect=rename):
            with self.assertRaisesRegex(OSError, "swap failure"):
                self.install()
        self.assertEqual(installer.app_inventory(self.app), previous)
        self.assertEqual(self.leftovers(), [])

    def test_owned_app_must_be_a_boolean_in_version_two_receipts(self):
        final = self.install()
        receipt = installer.json_read(final / "install.json")
        receipt["owned_app"] = "yes"
        (final / "install.json").write_bytes(installer.encode(receipt))
        with self.assertRaisesRegex(installer.InstallError, "Unsupported install inventory"):
            installer.descriptor(final, self.home)
        receipt["owned_app"] = False
        (final / "install.json").write_bytes(installer.encode(receipt))
        self.assertEqual(installer.descriptor(final, self.home)["owned_app"], False)
        with self.assertRaisesRegex(installer.InstallError, "Foreign or edited"):
            self.install()

    def test_install_creates_a_missing_applications_directory_privately(self):
        self.assertFalse((self.home / "Applications").exists())
        self.install()
        self.assertEqual(stat.S_IMODE((self.home / "Applications").stat().st_mode), 0o700)

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
        self.assertEqual(installer.app_inventory(self.home / "Applications/Ariadne.app"),
                         installer.bundle_files(installer.inventory(first)))

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

    def test_uninstall_tolerates_a_missing_bin_directory(self):
        final = self.install()
        shutil.rmtree(final / "bin")
        self.assertEqual(installer.uninstall(self.home), [])
        self.assertFalse(final.exists())
        self.assertFalse((self.root / "current").is_symlink())
        self.assertFalse(self.app.exists())
        self.assertFalse((self.home / ".local/bin/ariadne").is_symlink())
        self.assertIn("uninstall finished", self.output.getvalue())

    def test_uninstall_tolerates_a_missing_app_copy_and_bundle(self):
        final = self.install()
        shutil.rmtree(self.app)
        shutil.rmtree(final / "Ariadne.app")
        self.assertEqual(installer.uninstall(self.home), [])
        self.assertFalse(final.exists())

    def test_uninstall_of_the_real_partial_shape_keeps_foreign_and_edited_files(self):
        final = self.install()
        shutil.rmtree(final / "bin")
        shutil.rmtree(final / "Ariadne.app")
        shutil.rmtree(self.app)
        edited = final / "integrations/rules/claude.md"
        edited.write_bytes(b"owner edited")
        foreign = final / "owner-notes.txt"
        foreign.write_bytes(b"foreign notes")
        retained = installer.uninstall(self.home)
        self.assertIn(str(edited), retained)
        self.assertIn(str(final), retained)
        self.assertEqual(edited.read_bytes(), b"owner edited")
        self.assertEqual(foreign.read_bytes(), b"foreign notes")
        self.assertFalse((final / "integrations/rules/codex.md").exists())
        self.assertTrue((final / "install.json").exists())

    def test_partial_package_with_an_edited_helper_still_preserves_everything(self):
        final = self.install()
        (final / "bin/ariadne").write_text("edited")
        (final / "bin/ariadne").chmod(0o700)
        with self.assertRaisesRegex(installer.InstallError, "helper identity"):
            installer.uninstall(self.home)
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
                patch.object(installer, "run", return_value="") as run:
            # The file installer independently probes versions; leave it real in other tests.
            with patch.object(installer, "install", return_value=Path("/fixture/version")):
                installer.main(["install"])
            build.assert_called_once()
            run.assert_called_once_with([Path("/fixture/version/bin/ariadne"), "doctor", "--summary"])
            installer.main(["uninstall"])
            build.assert_called_once()
        self.assertIn("No personal Ariadne package", self.output.getvalue())

    def test_main_source_install_reports_doctor_failure_separately(self):
        command = [Path("/fixture/version/bin/ariadne"), "doctor", "--summary"]
        errors = io.StringIO()
        with patch.dict(os.environ, {"HOME": str(self.home)}), \
                patch.object(installer, "build", return_value=(self.artifacts, self.facts)), \
                patch.object(installer, "install", return_value=Path("/fixture/version")) as install, \
                patch.object(installer, "run", side_effect=subprocess.CalledProcessError(4, command)) as run, \
                contextlib.redirect_stderr(errors), self.assertRaises(SystemExit) as stopped:
            installer.main(["install"])
        install.assert_called_once_with(self.home, self.artifacts, self.facts)
        run.assert_called_once_with(command)
        self.assertEqual(stopped.exception.code, 1)
        self.assertEqual(errors.getvalue(),
                         "Ariadne is installed, but doctor found a problem. Run `ariadne doctor` for details.\n")


def shutil_error():
    return shutil.Error


class PackageTests(unittest.TestCase):
    """Prebuilt package assembly and `install --package`; reuses scripted artifacts."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ariadne package fixtures ")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.home = self.base / "home"
        self.home.mkdir(mode=0o700)
        (self.home / ".local/bin").mkdir(parents=True)
        self.artifacts = self.base / "release"
        self.facts = {"os": "macOS", "os_version": "14.0", "architecture": "arm64", "python": "3.12.0"}
        self.make_artifacts()
        (self.artifacts / "bundle/macos/Ariadne.app/Contents/current-info").symlink_to("Info.plist")
        self.output = io.StringIO()
        self.capture = contextlib.redirect_stdout(self.output)
        self.capture.__enter__()
        self.addCleanup(self.capture.__exit__, None, None, None)
        host = (patch.object(installer.platform, "system", return_value="Darwin"),
                patch.object(installer.platform, "mac_ver", return_value=("14.0", (), "")),
                patch.object(installer.platform, "machine", return_value="arm64"))
        for item in host:
            item.start()
            self.addCleanup(item.stop)

    version = "0.1.0"
    make_artifacts = InstallationTests.make_artifacts
    root = InstallationTests.root

    def assemble(self):
        return installer.assemble(self.artifacts, self.facts, self.base / "dist", "a" * 40, "2026-10-06T00:00:00Z")

    def extract(self):
        tarball = self.assemble()
        target = self.base / "extracted"
        target.mkdir()
        subprocess.run(["tar", "-xzf", str(tarball), "-C", str(target)], check=True)
        return tarball, target / "ariadne-0.1.0"

    def test_assembly_produces_expected_tree_description_and_symlinks(self):
        tarball, package = self.extract()
        self.assertEqual(tarball.name, "ariadne-0.1.0-macos-arm64.tar.gz")
        self.assertEqual(sorted(path.name for path in (self.base / "dist").iterdir()), [tarball.name])
        self.assertEqual(sorted(path.name for path in package.iterdir()),
                         ["ariadne", "ariadne-mcp", "bundle", "install.py", "install.sh", "package.json"])
        self.assertTrue(os.access(package / "install.sh", os.X_OK))
        self.assertTrue(os.access(package / "ariadne", os.X_OK))
        self.assertEqual((package / "install.py").read_bytes(), SOURCE.read_bytes())
        self.assertEqual(os.readlink(package / "bundle/macos/Ariadne.app/Contents/current-info"), "Info.plist")
        self.assertTrue(os.access(package / "bundle/macos/Ariadne.app/Contents/MacOS/ariadne-desktop", os.X_OK))
        description = json.loads((package / "package.json").read_text())
        self.assertEqual(description, {**self.facts, "app_version": "0.1.0",
                                       "source_sha": "a" * 40, "built_at": "2026-10-06T00:00:00Z"})
        self.assertEqual(self.assemble(), tarball)

    def test_package_script_is_shipped_executable_and_checks_python(self):
        script = SOURCE.parent / "install.sh"
        text = script.read_text()
        self.assertTrue(os.access(script, os.X_OK))
        self.assertTrue(text.startswith("#!/bin/bash\n"))
        self.assertIn("set -euo pipefail", text)
        self.assertIn("3, 11", text)
        self.assertIn('install.py install --package "$PWD"', text)

    def test_package_installs_without_building_and_uninstalls(self):
        _, package = self.extract()
        before = {path: path.stat().st_mtime_ns for path in package.rglob("*") if not path.is_symlink()}
        with patch.object(installer, "build", side_effect=AssertionError("must not build")), \
                patch.object(installer, "preflight", side_effect=AssertionError("no toolchain preflight")):
            final = installer.install_package(self.home, package)
        receipt = installer.json_read(final / "install.json")
        self.assertEqual(receipt["preflight"]["built"]["source_sha"], "a" * 40)
        self.assertEqual(receipt["preflight"]["architecture"], "arm64")
        self.assertEqual((self.home / ".local/bin/ariadne").resolve(), final / "bin/ariadne")
        self.assertEqual(before, {path: path.stat().st_mtime_ns for path in package.rglob("*") if not path.is_symlink()})
        self.assertEqual(installer.uninstall(self.home), [])
        self.assertFalse(final.exists())

    def install_over(self, package):
        with patch.object(installer, "build", side_effect=AssertionError("must not build")):
            return installer.install_package(self.home, package)

    def replacing_line(self):
        return "Replacing the Ariadne 0.1.0 already installed (your projects and history are kept)."

    def test_install_over_a_complete_same_version_install_replaces_it(self):
        _, package = self.extract()
        first = self.install_over(package)
        self.assertNotIn("Replacing", self.output.getvalue())
        history = self.home / ".ariadne/projects/p/history.json"
        history.parent.mkdir(parents=True)
        history.write_text("keep")
        second = self.install_over(package)
        self.assertEqual(first, second)
        self.assertEqual(self.output.getvalue().count(self.replacing_line()), 1)
        self.assertEqual((self.root / "current").resolve(), second)
        self.assertTrue((second / "bin/ariadne").is_file())
        self.assertTrue((self.home / "Applications/Ariadne.app").is_dir())
        self.assertEqual(history.read_text(), "keep")
        self.assertEqual(installer.uninstall(self.home), [])

    def test_install_over_a_partial_same_version_install_replaces_it(self):
        _, package = self.extract()
        final = self.install_over(package)
        shutil.rmtree(final / "bin")
        shutil.rmtree(final / "Ariadne.app")
        shutil.rmtree(self.home / "Applications/Ariadne.app")
        again = self.install_over(package)
        self.assertEqual(self.output.getvalue().count(self.replacing_line()), 1)
        self.assertTrue((again / "bin/ariadne").is_file())
        self.assertTrue((again / "Ariadne.app").is_dir())
        self.assertTrue((self.home / "Applications/Ariadne.app").is_dir())
        self.assertEqual((self.root / "current").resolve(), again)
        self.assertEqual(installer.uninstall(self.home), [])

    def test_install_over_an_install_with_foreign_files_stops_with_one_instruction(self):
        _, package = self.extract()
        final = self.install_over(package)
        foreign = final / "owner-notes.txt"
        foreign.write_bytes(b"foreign notes")
        edited = final / "integrations/rules/claude.md"
        edited.write_bytes(b"owner edited")
        before = self.snapshot()
        with self.assertRaises(installer.InstallError) as stopped:
            self.install_over(package)
        self.assertIn(f"Move the folder {final} somewhere else, then run ./install.sh again.", str(stopped.exception))
        self.assertNotIn("Replacing", self.output.getvalue())
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(foreign.read_bytes(), b"foreign notes")
        self.assertEqual(edited.read_bytes(), b"owner edited")

    def snapshot(self):
        """Every path under the temp HOME with its kind and content, to prove nothing was touched."""
        found = {}
        for path in sorted(self.home.rglob("*")):
            name = str(path.relative_to(self.home))
            if path.is_symlink():
                found[name] = ("link", os.readlink(path))
            elif path.is_dir():
                found[name] = ("dir", stat.S_IMODE(path.stat().st_mode))
            else:
                found[name] = ("file", path.read_bytes(), stat.S_IMODE(path.stat().st_mode))
        return found

    def test_failed_checks_leave_the_old_install_fully_intact(self):
        _, package = self.extract()
        final = self.install_over(package)
        # A new package whose helpers report another version.
        (package / "ariadne-mcp").write_text(f"#!{sys.executable}\nprint('ariadne-mcp 9.9.9')\n")
        before = self.snapshot()
        with self.assertRaisesRegex(installer.InstallError, "versions differ"):
            self.install_over(package)
        self.assertEqual(self.snapshot(), before)
        self.assertNotIn("Replacing", self.output.getvalue())
        # A foreign link and an edited app copy are found before anything is removed.
        _, package = self.extract_again()
        link = self.home / ".local/bin/ariadne"
        link.unlink()
        link.write_bytes(b"owner's own helper")
        before = self.snapshot()
        with self.assertRaisesRegex(installer.InstallError, "Foreign or edited"):
            self.install_over(package)
        self.assertEqual(self.snapshot(), before)
        link.unlink()
        link.symlink_to(installer.links(self.home)[".local/bin/ariadne"])
        (self.home / "Applications/Ariadne.app/Contents/MacOS/ariadne-desktop").write_bytes(b"patched")
        before = self.snapshot()
        with self.assertRaisesRegex(installer.InstallError, "Foreign or edited"):
            self.install_over(package)
        self.assertEqual(self.snapshot(), before)
        self.assertTrue((final / "bin/ariadne").is_file())

    def test_moving_the_blocking_folder_aside_lets_the_rerun_succeed(self):
        _, package = self.extract()
        final = self.install_over(package)
        (final / "owner-notes.txt").write_bytes(b"foreign notes")
        with self.assertRaisesRegex(installer.InstallError, "Move the folder"):
            self.install_over(package)
        aside = self.base / "moved aside"
        final.rename(aside)
        self.assertTrue((self.root / "current").is_symlink() and not (self.root / "current").exists())
        again = self.install_over(package)
        self.assertEqual((self.root / "current").resolve(), again)
        self.assertEqual((self.home / ".local/bin/ariadne").resolve(), again / "bin/ariadne")
        self.assertEqual((aside / "owner-notes.txt").read_bytes(), b"foreign notes")
        self.assertEqual(installer.app_inventory(self.home / "Applications/Ariadne.app"),
                         installer.bundle_files(installer.inventory(again)))
        self.assertEqual(installer.uninstall(self.home), [])

    def test_a_dangling_current_pointer_or_missing_root_counts_as_no_install(self):
        _, package = self.extract()
        final = self.install_over(package)
        shutil.rmtree(final)
        self.assertTrue((self.root / "current").is_symlink() and not (self.root / "current").exists())
        again = self.install_over(package)
        self.assertEqual((self.root / "current").resolve(), again)
        self.assertNotIn("Replacing", self.output.getvalue())
        self.assertEqual(installer.uninstall(self.home), [])
        # The whole Ariadne folder gone, links and app copy left behind.
        final = self.install_over(package)
        shutil.rmtree(self.root)
        self.assertTrue(self.install_over(package).is_dir())
        self.assertEqual(installer.uninstall(self.home), [])
        self.assertFalse(installer.exists(self.home / "Applications/Ariadne.app"))

    def test_replacing_names_every_version_it_removes(self):
        _, package = self.extract()
        self.make_artifacts("0.0.9")
        installer.install(self.home, self.artifacts, self.facts)
        self.make_artifacts()
        final = self.install_over(package)
        self.assertEqual(sorted(os.listdir(self.root / "versions")), ["0.0.9", "0.1.0"])
        self.output.truncate(0)
        self.output.seek(0)
        self.install_over(package)
        self.assertIn("Replacing the Ariadne 0.1.0 already installed, and removing the other installed versions "
                      "0.0.9 with it (your projects and history are kept).", self.output.getvalue())
        self.assertEqual(os.listdir(self.root / "versions"), ["0.1.0"])
        # A changed file in the other version blocks the replacement before anything is removed.
        self.make_artifacts("0.0.9")
        installer.install(self.home, self.artifacts, self.facts)
        self.make_artifacts()
        (self.root / "versions/0.0.9/integrations/rules/claude.md").write_bytes(b"owner edited")
        before = self.snapshot()
        with self.assertRaisesRegex(installer.InstallError, f"Move the folder {self.root / 'versions/0.0.9'} somewhere"):
            self.install_over(package)
        self.assertEqual(self.snapshot(), before)
        self.assertTrue(final.is_dir())

    def test_install_script_no_longer_blocks_on_an_existing_version(self):
        script = (SOURCE.parent / "install.sh").read_text()
        self.assertNotIn("already exists", script)
        self.assertIn('install.py install --package "$PWD"', script)

    def test_main_package_mode_skips_build_and_runs_doctor(self):
        _, package = self.extract()
        with patch.dict(os.environ, {"HOME": str(self.home)}), \
                patch.object(installer, "build") as build, \
                patch.object(installer, "install_package", return_value=Path("/fixture/version")) as install_package, \
                patch.object(installer, "run", return_value="") as run:
            installer.main(["install", "--package", str(package)])
        build.assert_not_called()
        install_package.assert_called_once_with(self.home, package)
        run.assert_called_once_with([Path("/fixture/version/bin/ariadne"), "doctor", "--summary"])
        with self.assertRaisesRegex(installer.InstallError, "install only"):
            installer.main(["package", "--package", str(package)])
        with patch.dict(os.environ, {"HOME": str(self.home)}), \
                self.assertRaisesRegex(installer.InstallError, "install only"):
            installer.main(["uninstall", "--package", str(package)])

    def test_package_install_ends_with_a_short_plain_summary_without_ids(self):
        _, package = self.extract()
        summary = ("9 sessions in 3 projects; none connected right now.\n"
                   "Open Ariadne. In Claude, run /reload-plugins, then /ariadne-connect. "
                   "For Codex, use Connect existing session in Ariadne and paste the copied instruction into Codex.\n"
                   "Run `ariadne doctor` for details.\n")
        def invoke(args, **kwargs):
            if args[1:] == ["doctor", "--summary"]:
                self.assertEqual(kwargs, {})
                print(summary, end="")
                return None
            return installer_run(args, **kwargs)
        installer_run = installer.run
        with patch.dict(os.environ, {"HOME": str(self.home)}), patch.object(installer, "run", side_effect=invoke):
            installer.main(["install", "--package", str(package)])
        lines = self.output.getvalue().splitlines()
        self.assertEqual(len(lines), 4)
        self.assertEqual(lines[0], "Installed Ariadne 0.1.0.")
        self.assertEqual("\n".join(lines[1:]) + "\n", summary)
        self.assertNotRegex(self.output.getvalue(), r"[0-9a-f]{8}-[0-9a-f]{4}-")
        self.assertNotIn("session id", self.output.getvalue())
        self.assertNotIn("Copy ID", self.output.getvalue())
        self.assertNotIn("Result: warning", self.output.getvalue())

    def test_package_doctor_exit_four_keeps_the_install_and_reports_plain_guidance(self):
        _, package = self.extract()
        errors = io.StringIO()
        installer_run = installer.run
        def invoke(args, **kwargs):
            if args[1:] == ["doctor", "--summary"]:
                raise subprocess.CalledProcessError(4, args)
            return installer_run(args, **kwargs)
        with patch.dict(os.environ, {"HOME": str(self.home)}), \
                patch.object(installer, "run", side_effect=invoke), contextlib.redirect_stderr(errors), \
                self.assertRaises(SystemExit) as stopped:
            installer.main(["install", "--package", str(package)])
        self.assertEqual(stopped.exception.code, 1)
        self.assertEqual(errors.getvalue(),
                         "Ariadne is installed, but doctor found a problem. Run `ariadne doctor` for details.\n")
        final = self.root / "versions/0.1.0"
        self.assertEqual((self.root / "current").resolve(), final)
        self.assertEqual(installer.inventory(final), installer.descriptor(final, self.home)["owned_files"])
        self.assertTrue((self.home / "Applications/Ariadne.app").is_dir())
        self.assertIn("Installed Ariadne 0.1.0.", self.output.getvalue())

    def test_main_package_action_builds_then_assembles(self):
        with patch.object(installer, "build", return_value=(self.artifacts, self.facts)) as build, \
                patch.object(installer, "run", return_value="b" * 40 + "\n"), \
                patch.object(installer, "assemble", return_value=Path("/fixture/x.tar.gz")) as assemble:
            installer.main(["package"])
        build.assert_called_once()
        self.assertEqual(assemble.call_args.args[:3], (self.artifacts, self.facts, installer.ROOT / "dist"))
        self.assertEqual(assemble.call_args.args[3], "b" * 40)
        self.assertIn("Package: /fixture/x.tar.gz", self.output.getvalue())

    def test_missing_file_bad_description_and_architecture_mismatch_are_refused(self):
        _, package = self.extract()
        description = (package / "package.json").read_text()
        for name in ("install.sh", "ariadne-mcp"):
            moved = package / (name + ".moved")
            (package / name).rename(moved)
            with self.assertRaisesRegex(installer.InstallError, "missing " + name):
                installer.install_package(self.home, package)
            moved.rename(package / name)
        shutil.rmtree(package / "bundle")
        with self.assertRaisesRegex(installer.InstallError, "missing Ariadne.app"):
            installer.install_package(self.home, package)
        _, package = self.extract_again()
        for bad, message in (("not json", "unreadable"), ('{"architecture": "arm64"}', "malformed"),
                             ('["list"]', "malformed"),
                             (json.dumps({**json.loads(description), "app_version": "9.9.9"}), "does not match")):
            (package / "package.json").write_text(bad)
            with self.assertRaisesRegex(installer.InstallError, message):
                installer.install_package(self.home, package)
        (package / "package.json").write_text(json.dumps({**json.loads(description), "architecture": "x86_64"}))
        with self.assertRaisesRegex(installer.InstallError, "x86_64 Macs; this Mac is arm64"):
            installer.install_package(self.home, package)
        self.assertFalse(installer.exists(self.root / "current"))

    def test_symlinked_package_members_are_refused(self):
        _, package = self.extract()
        for name in ("ariadne", "ariadne-mcp", "package.json"):
            real = package / (name + ".real")
            (package / name).rename(real)
            (package / name).symlink_to(real)
            with self.assertRaisesRegex(installer.InstallError, "missing " + name):
                installer.install_package(self.home, package)
            (package / name).unlink()
            real.rename(package / name)
        app = package / "bundle/macos/Ariadne.app"
        app.rename(package / "bundle/macos/Real.app")
        app.symlink_to("Real.app")
        with self.assertRaisesRegex(installer.InstallError, "missing Ariadne.app"):
            installer.install_package(self.home, package)

    def test_package_description_keeps_only_known_short_values(self):
        _, package = self.extract()
        description = json.loads((package / "package.json").read_text())
        (package / "package.json").write_text(json.dumps({**description, "source_sha": "a" * 201}))
        with self.assertRaisesRegex(installer.InstallError, "longer than 200"):
            installer.install_package(self.home, package)
        (package / "package.json").write_text(json.dumps({**description, "extra": "x" * 400000}))
        final = installer.install_package(self.home, package)
        built = installer.json_read(final / "install.json")["preflight"]["built"]
        self.assertEqual(sorted(built), sorted(installer.PACKAGE_KEYS))

    def extract_again(self):
        shutil.rmtree(self.base / "extracted")
        return self.extract()

    def test_package_still_enforces_host_checks_but_not_toolchains(self):
        _, package = self.extract()
        with patch.object(installer.platform, "system", return_value="Linux"):
            with self.assertRaisesRegex(installer.InstallError, "requires macOS"):
                installer.install_package(self.home, package)
        with patch.object(installer.platform, "mac_ver", return_value=("12.6", (), "")):
            with self.assertRaisesRegex(installer.InstallError, "macOS 13 or newer"):
                installer.install_package(self.home, package)


class BuildTests(unittest.TestCase):
    def preflight_with(self, answers, pinned_installed=True):
        def fake(args, **kwargs):
            if args[0] == "rustup":
                if args[1:3] == ["run", installer.RUST_VERSION] and not pinned_installed:
                    raise subprocess.CalledProcessError(1, args)
                if args[1] == "show":
                    return "stable-aarch64-apple-darwin (default)\n"
                return answers[args[-2]]
            return answers[args[0]]
        with patch.object(installer.platform, "system", return_value="Darwin"), \
                patch.object(installer.platform, "mac_ver", return_value=("13.7", (), "")), \
                patch.object(installer.platform, "machine", return_value="arm64"), \
                patch.object(installer, "run", side_effect=fake):
            return installer.preflight()

    def test_preflight_accepts_minimums_and_newer_and_records_actual_versions(self):
        base = {"node": "v22.23.2", "npm": "10.9.8", "rustc": "rustc 1.98.1 (fixture)", "cargo": "cargo 1.98.1 (fixture)",
                "xcode-select": "/Xcode", "xcrun": "/SDK"}
        facts = self.preflight_with(base)
        self.assertEqual((facts["architecture"], facts["rust_toolchain"]), ("arm64", "1.98.1"))
        newer = {**base, "node": "v24.15.1", "npm": "11.0.0", "rustc": "rustc 1.99.0 (fixture)", "cargo": "cargo 1.99.0 (fixture)"}
        facts = self.preflight_with(newer, pinned_installed=False)
        self.assertEqual((facts["node"], facts["npm"], facts["rustc"], facts["cargo"]),
                         ("v24.15.1", "11.0.0", "rustc 1.99.0 (fixture)", "cargo 1.99.0 (fixture)"))
        self.assertEqual(facts["rust_toolchain"], "stable-aarch64-apple-darwin")
        patch_newer = {**base, "node": "v22.24.0", "npm": "10.9.9"}
        self.assertEqual(self.preflight_with(patch_newer)["node"], "v22.24.0")
        for node in ("v22.23.2", "v22.30.0", "v24.15.0", "v26.0.0"):
            self.assertEqual(self.preflight_with({**base, "node": node})["node"], node)

    def test_preflight_rejects_older_or_unparsable_tools_plainly(self):
        base = {"node": "v22.23.2", "npm": "10.9.8", "rustc": "rustc 1.98.1 (fixture)", "cargo": "cargo 1.98.1 (fixture)",
                "xcode-select": "/Xcode", "xcrun": "/SDK"}
        node_msg = "Ariadne needs Node 22.23.2 or newer on the 22 line, 24.15.0 or newer on the 24 line, or 26 and later"
        cases = [("node", "v22.23.1", node_msg + "; found v22.23.1"),
                 ("node", "v20.0.0", node_msg),
                 ("node", "v23.5.0", node_msg),
                 ("node", "v24.14.0", node_msg),
                 ("node", "v25.1.0", node_msg),
                 ("npm", "wrong", "Ariadne needs npm 10.9.8 or newer; found wrong"),
                 ("npm", "10.9.7", "Ariadne needs npm 10.9.8 or newer"),
                 ("rustc", "rustc 1.97.0 (fixture)", "Ariadne needs Rust 1.98.1 or newer"),
                 ("cargo", "garbage", "Ariadne needs Rust 1.98.1 or newer")]
        for name, value, message in cases:
            with self.subTest(name=name, value=value), self.assertRaisesRegex(installer.InstallError, message):
                self.preflight_with({**base, name: value})
        with patch.object(installer.platform, "system", return_value="Linux"):
            with self.assertRaisesRegex(installer.InstallError, "requires macOS"):
                installer.preflight()

    def test_build_uses_locks_generation_checks_and_clean_production_environment(self):
        with patch.object(installer, "preflight", return_value={"architecture": "arm64", "rust_toolchain": "stable-test"}), \
                patch.object(installer, "run") as run, \
                patch.dict(os.environ, {"VITE_ARIADNE_E2E": "1", "RUSTFLAGS": "--bad", "TAURI_CONFIG": "bad"}), \
                contextlib.redirect_stdout(io.StringIO()):
            artifacts, facts = installer.build()
        self.assertEqual(artifacts, installer.ROOT / "target/personal-install/release")
        self.assertEqual(facts["architecture"], "arm64")
        calls = run.call_args_list
        self.assertEqual(calls[0].args[0], ["npm", "ci", "--ignore-scripts", "--engine-strict"])
        self.assertEqual(len(calls), 6)
        for call in calls[1:]:
            self.assertIn("--locked", call.args[0])
            self.assertNotIn("RUSTFLAGS", call.kwargs["env"])
            self.assertNotIn("VITE_ARIADNE_E2E", call.kwargs["env"])
            self.assertEqual(call.kwargs["env"]["RUSTUP_AUTO_INSTALL"], "0")
            self.assertEqual(call.kwargs["env"]["RUSTUP_TOOLCHAIN"], "stable-test")
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
                with self.assertRaisesRegex(installer.InstallError, "Ariadne needs Rust 1.98.1 or newer"):
                    installer.preflight()
            self.assertEqual(probes[2], ["rustup", "run", "1.98.1", "rustc", "--version"])
            for probe_args in probes:
                self.assertNotIn("--install", probe_args)
            self.assertIn("not installed", "".join(errors))
            self.assertNotIn("syncing channel", "".join(errors))
            self.assertNotIn("downloading", "".join(errors))
            self.assertFalse((Path(temporary) / "empty-rustup/toolchains").exists())


if __name__ == "__main__":
    unittest.main()
