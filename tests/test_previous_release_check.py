"""The previous-release read check: its choices and its refusals, with stand-in helpers (no download, no build)."""
import importlib.util
import io
import json
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("check_previous_release", ROOT / "scripts/check-previous-release.py")
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)

PROJECT, SESSION, BINDING, TOPIC = ("00000000-0000-4000-8000-00000000000%d" % n for n in (1, 2, 3, 4))
STUCK = "00000000-0000-4000-8000-000000000074"

# A stand-in `ariadne`. It keeps what it was given (preferences, answers) in the data folder, as the real helper does, and
# answers every command the check uses. `FAULT` makes it lose one thing, as an older release might.
STUB = r'''#!{python}
import json, os, sys
FAULT = {fault!r}
if sys.argv[1:] == ["--version"]:
    print("ariadne 0.0.0-stub"); sys.exit(0)
data = os.environ["ARIADNE_HOME"]
state_path = os.path.join(data, "stub.json")
state = json.load(open(state_path)) if os.path.exists(state_path) else {{"revision": 1, "global": {{}}, "sessions": [], "seen": [], "resolved": [], "inputs": []}}
def save(): json.dump(state, open(state_path, "w"))
def out(value): print(json.dumps({{"api_version": 1, "ok": True, "data": value}})); sys.exit(0)
args = sys.argv[1:]
request = json.load(sys.stdin) if "--json-stdin" in args else None
if args[0] == "demo":
    os.makedirs(os.path.join(data, "projects", "{project}", "sessions"), exist_ok=True)
    json.dump({{"inputs": {{"{stuck}": {{"state": "needs_attention"}}}}}}, open(os.path.join(data, "projects", "{project}", "sessions", "{session}.json"), "w"))
    out({{"project_id": "{project}", "session_id": "{session}"}})
if args[:2] == ["session", "list"]:
    out({{"data": {{"sessions": {{"items": [{{"active_binding": {{"id": "{binding}"}}}}]}}}}, "kind": "session_list"}})
if args[:2] == ["session", "read"]:
    ids = ["1", "2", "3"] if FAULT != "lose_item" else ["1", "2"]
    status = {{"1": "waiting_on_me", "2": "open", "3": "done"}}
    items = [{{"item": {{"id": i, "status": status[i], "topic_id": "{topic}", "question_revision": 1, "revision": 2}}}} for i in ids]
    out({{"data": {{"page": {{"items": items, "snapshot_revision": 23}}, "view": "items"}}, "kind": "session_read"}})
if args[:2] == ["input", "submit"]:
    state["inputs"].append(request["command"]["params"]); save()
    out({{"data": {{"kind": "input_submit"}}, "revision": 23}})
if args[:2] == ["item", "messages"]:
    item = request["request"]["params"]["item_id"]
    bodies = [p["text"] for p in state["inputs"] if p["target"]["item_id"] == item]
    out({{"data": {{"messages": {{"items": [{{"body": b}} for b in bodies]}}}}, "kind": "item_messages"}})
if args[:2] == ["preferences", "patch"]:
    for entry in request["command"]["params"]["entries"]:
        if entry["kind"] == "set_global": state["global"] = entry["preferences"]
        if entry["kind"] == "set_session_view": state["sessions"] = [entry["preferences"]]
        if entry["kind"] == "mark_seen": state["seen"] = [{{"session": entry["session"], "since": entry["at"], "items": entry["items"], "topics": entry["topics"]}}]
        if entry["kind"] == "resolve_unsent_input": state["resolved"] = [entry["input_id"]]
    state["revision"] += 1; save()
    out({{"operation_id": request["command"]["op_id"], "preferences_revision": state["revision"]}})
if args[:2] == ["preferences", "get"]:
    value = {{"revision": state["revision"], "global": state["global"], "sessions": state["sessions"], "later": [], "drafts": []}}
    if FAULT != "lose_seen": value["seen"] = state["seen"]
    if FAULT != "lose_recovery": value["resolved_unsent_input_ids"] = state["resolved"]
    out({{"data": value, "kind": "preferences_get"}})
if args[0] == "doctor":
    checks = [{{"status": "ok", "code": "registry.valid", "facts": {{}}}},
              {{"status": "ok", "code": "project.identity", "facts": {{"project_id": "{project}"}}}},
              {{"status": "ok", "code": "session.valid", "facts": {{"session_id": "{session}", "revision": 23}}}}]
    if FAULT == "doctor_error": checks.append({{"status": "error", "code": "session.invalid_snapshot", "facts": {{}}}})
    if FAULT == "doctor_blind": checks = checks[:1]
    out({{"checks": checks}})
sys.exit(2)
'''


def stub(folder, name, fault=""):
    path = Path(folder) / name
    path.write_text(STUB.format(python=sys.executable, fault=fault, project=PROJECT, session=SESSION, binding=BINDING,
                                topic=TOPIC, stuck=STUCK))
    path.chmod(0o755)
    return path


def run_main(new, old):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = check.main(["--new", str(new), "--old", str(old)])
    return code, out.getvalue(), err.getvalue()


class PreviousTag(unittest.TestCase):
    def test_the_newest_published_release_other_than_this_build(self):
        listing = [
            {"tagName": "v0.1.0-alpha.22", "isDraft": False, "publishedAt": "2026-10-20T00:00:00Z"},
            {"tagName": "v0.1.0-alpha.21", "isDraft": False, "publishedAt": "2026-10-18T00:00:00Z"},
            {"tagName": "v0.1.0-alpha.20", "isDraft": False, "publishedAt": "2026-10-17T00:00:00Z"},
            {"tagName": "v0.1.0-alpha.23", "isDraft": True, "publishedAt": "2026-10-21T00:00:00Z"},
        ]
        self.assertEqual(check.previous_tag(listing, "0.1.0-alpha.22"), "v0.1.0-alpha.21")
        self.assertEqual(check.previous_tag(listing[2:3], "0.1.0-alpha.22"), "v0.1.0-alpha.20")
        self.assertIsNone(check.previous_tag(listing[:1], "0.1.0-alpha.22"))
        self.assertIsNone(check.previous_tag([], "0.1.0-alpha.22"))


class SafeExtract(unittest.TestCase):
    def package(self, folder, members):
        path = Path(folder) / "package.tar.gz"
        with tarfile.open(path, "w:gz") as archive:
            for name, data in members:
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        return path

    def test_unpacks_inside_the_folder_and_refuses_anything_outside(self):
        with tempfile.TemporaryDirectory() as folder:
            good = self.package(folder, [("ariadne-0.1.0/ariadne", b"helper")])
            into = Path(folder) / "good"
            into.mkdir()
            check.safe_extract(good, into)
            self.assertEqual((into / "ariadne-0.1.0/ariadne").read_bytes(), b"helper")
            for name in ("../escape", "/absolute", "ariadne-0.1.0/../../escape"):
                with self.subTest(name=name):
                    bad = self.package(folder, [(name, b"x")])
                    target = Path(folder) / "bad"
                    target.mkdir(exist_ok=True)
                    with self.assertRaises(check.CheckFailed):
                        check.safe_extract(bad, target)
                    self.assertFalse((Path(folder) / "escape").exists())


class ReadBack(unittest.TestCase):
    def check(self, fault=""):
        with tempfile.TemporaryDirectory() as folder:
            new, old = stub(folder, "new"), stub(folder, "old", fault)
            return run_main(new, old)

    def test_a_previous_release_that_reads_everything_passes(self):
        code, out, err = self.check()
        self.assertEqual((code, err), (0, ""))
        self.assertIn("reads everything this build wrote", out)

    def test_each_loss_is_named_and_fails_the_check(self):
        for fault, words in [
            ("doctor_error", "doctor errors"),
            ("doctor_blind", "no `project.identity` check"),
            ("lose_item", "session read items"),
            ("lose_seen", "seen markers"),
            ("lose_recovery", "the recovery markers"),
        ]:
            with self.subTest(fault=fault):
                with self.assertRaises(check.CheckFailed) as failed:
                    with tempfile.TemporaryDirectory() as folder:
                        new, old = stub(folder, "new"), stub(folder, "old", fault)
                        check.main(["--new", str(new), "--old", str(old)])
                self.assertIn(words, str(failed.exception))
                self.assertIn("The previous release", str(failed.exception))

    def test_a_helper_that_prints_no_json_is_a_plain_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            new = stub(folder, "new")
            old = Path(folder) / "old"
            old.write_text(f"#!{sys.executable}\nimport sys\nif sys.argv[1:] == ['--version']:\n    print('ariadne 0.0.0-broken')\nelse:\n    print('crash')\n    sys.exit(3)\n")
            old.chmod(0o755)
            with self.assertRaises(check.CheckFailed) as failed:
                check.main(["--new", str(new), "--old", str(old)])
            self.assertIn("printed no JSON", str(failed.exception))

    def test_the_stand_in_writes_only_inside_its_temporary_folder(self):
        with tempfile.TemporaryDirectory() as folder:
            new, old = stub(folder, "new"), stub(folder, "old")
            before = sorted(path.name for path in Path(folder).iterdir())
            self.assertEqual(run_main(new, old)[0], 0)
            self.assertEqual(sorted(path.name for path in Path(folder).iterdir()), before)


class Versions(unittest.TestCase):
    def test_the_current_version_is_the_apps(self):
        config = json.loads((ROOT / "apps/desktop/src-tauri/tauri.conf.json").read_text())
        self.assertEqual(check.current_version(), config["version"])


if __name__ == "__main__":
    unittest.main()
