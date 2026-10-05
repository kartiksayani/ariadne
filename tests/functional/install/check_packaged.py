#!/usr/bin/env python3
"""CI acceptance against an existing production bundle; never builds or uses the real home."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import importlib.util

SOURCE = Path(__file__).resolve().parents[3] / "scripts/install/install.py"
SPEC = importlib.util.spec_from_file_location("personal_install", SOURCE)
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


def check(artifacts, evidence):
    facts = installer.preflight()
    evidence.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix="ariadne packaged install ") as temporary:
        home = Path(temporary).resolve() / "home with spaces"
        home.mkdir(mode=0o700)
        (home / ".local/bin").mkdir(parents=True)
        history = home / ".ariadne/sessions/fixture.json"
        (home / ".ariadne").mkdir(mode=0o700)
        history.parent.mkdir(mode=0o700)
        history.write_bytes(b"existing history and backups")
        foreign = home / ".claude/settings.json"
        foreign.parent.mkdir()
        foreign.write_bytes(b"foreign host settings")
        installed = installer.install(home, artifacts, facts)
        # Simulate HOME only for these children, as installed_commands.rs does.
        # Package resolution uses HOME; ARIADNE_HOME selects only project data.
        # The parent environment and owner's real home are never changed.
        env = {**os.environ, "HOME": str(home), "ARIADNE_HOME": str(home / ".ariadne")}
        helper = installed / "bin/ariadne"
        def invoke(*args):
            try:
                return subprocess.run([str(helper), *args], env=env, check=True, text=True,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      timeout=30).stdout
            except subprocess.CalledProcessError as error:
                raise AssertionError(
                    f"Installed helper {args!r} failed ({error.returncode}):\n"
                    f"stdout: {error.stdout}\nstderr: {error.stderr}"
                ) from error
        descriptor = installer.json_read(installed / "install.json")
        assert installer.inventory(installed) == descriptor["owned_files"]
        assert (home / "Applications/Ariadne.app").resolve() == installed / "Ariadne.app"
        app_relative = "Ariadne.app/Contents/MacOS/ariadne-desktop"
        source = artifacts / "bundle/macos" / app_relative
        copied = installed / app_relative
        source_digest = installer.record(source, source.parent.parent.parent)["sha256"]
        copied_digest = installer.record(copied, installed / "Ariadne.app")["sha256"]
        assert source_digest == copied_digest
        assert invoke("--version").strip() == f"ariadne {descriptor['version']}"
        mcp = subprocess.run([str(home / ".local/bin/ariadne-mcp"), "--version"], env=env,
                             check=True, text=True, stdout=subprocess.PIPE, timeout=30)
        assert mcp.stdout.strip() == f"ariadne-mcp {descriptor['version']}"
        setup = json.loads(invoke("setup", "--agent", "both", "--json"))
        assert setup["ok"] is True and setup["data"]["changes"] == []
        doctor = json.loads(invoke("doctor", "--json"))
        assert doctor["ok"] is True and doctor["data"]["status"] != "error"
        assert any(check["code"] == "installation.resource_parity" and check["status"] == "ok"
                   for check in doctor["data"]["checks"])
        assert installer.install(home, artifacts, facts) == installed
        assert installer.uninstall(home) == []
        assert not installed.exists()
        assert not os.path.lexists(home / "Applications/Ariadne.app")
        assert not os.path.lexists(home / ".local/bin/ariadne")
        assert not os.path.lexists(home / ".local/bin/ariadne-mcp")
        assert history.read_bytes() == b"existing history and backups"
        assert foreign.read_bytes() == b"foreign host settings"
        (evidence / "install.json").write_bytes(installer.encode({
            "preflight": facts, "version": descriptor["version"], "temporary_home": str(home),
            "application": descriptor["app_path"], "immutable_root": str(installed),
            "source_application": str(source), "source_app_binary_sha256": source_digest,
            "installed_app_binary_sha256": copied_digest, "doctor": doctor,
            "repeat_unchanged": True, "package_removed": not installed.exists(),
            "history_preserved": True, "foreign_settings_preserved": True,
            "links_removed": all(not os.path.lexists(home / name) for name in descriptor["owned_links"]),
        }))
        print("Actual production app/CLI/MCP package install, repeat, doctor and owned uninstall passed in an isolated home.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", required=True, type=Path)
    parser.add_argument("--evidence", required=True, type=Path)
    args = parser.parse_args()
    check(args.artifacts.resolve(), args.evidence.resolve())
