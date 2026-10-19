#!/usr/bin/env python3
"""The previous release must still read what this build writes (P11.8).

A saved-data change that only the new build understands strands anyone who opens the old app or helper
again. This writes a populated store with this build's helper (a project, a session with items, an answer and
a reply, UI preferences with seen markers, and the recovery file), then reads it back with the previous
release's helper: `doctor --json`, a session read, the messages of two items, and `preferences get`. Each
read must return the data that was written, not just exit 0.

    scripts/check-previous-release.py --new target/debug/ariadne            # downloads the previous release
    scripts/check-previous-release.py --new target/debug/ariadne --old /path/to/previous/ariadne

Everything runs in a temporary HOME and data folder. Nothing outside it is read or written; the previous
release is downloaded into its own new folder and only its helper is run.
"""
import argparse
import json
import platform
import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

TIMEOUT = 90
# Fixed operation ids: the data folder is new on every run.
ANSWER_OP = "00000000-0000-4000-8000-0000000c0001"
REPLY_OP = "00000000-0000-4000-8000-0000000c0002"
VIEW_OP = "00000000-0000-4000-8000-0000000c0003"
RECOVERY_OP = "00000000-0000-4000-8000-0000000c0004"
ANSWER_TEXT = "Friday morning, after the review."
REPLY_TEXT = "Previous-release check reply."
SEEN_AT = "2026-10-03T12:30:00.000Z"
# Codes doctor gives a saved-data problem; a clean store has none of them.
STORE_PROBLEMS = re.compile(r"\.(invalid_snapshot|future_schema|unsafe_path_or_permissions|migration_pending|"
                            r"missing_coordination_or_data|io_unavailable|coordination_busy)$")


class CheckFailed(Exception):
    """A plain sentence about what the previous release did not read."""


def run(command, *, input=None, env=None, cwd=None, timeout=TIMEOUT):
    return subprocess.run([str(part) for part in command], input=input, env=env, cwd=cwd, text=True,
                          capture_output=True, timeout=timeout)


# --- The previous release -----------------------------------------------------------------------------------------

def previous_tag(listing):
    """The newest published release: `listing` is `gh release list --json` output. Between a release and the next
    version bump that is the build's own tag, which is the right one to compare against."""
    published = [release for release in listing if not release.get("isDraft")]
    published.sort(key=lambda release: release.get("publishedAt") or "", reverse=True)
    return published[0]["tagName"] if published else None


def safe_extract(tarball, into):
    """Unpack into a new, empty folder, refusing any member that would land outside it."""
    base = Path(into).resolve()
    with tarfile.open(tarball) as archive:
        for member in archive.getmembers():
            target = (base / member.name).resolve()
            if member.name.startswith("/") or not target.is_relative_to(base):
                raise CheckFailed(f"The release package holds a path outside itself: {member.name}")
            if member.isdev() or (member.islnk() or member.issym()) and Path(member.linkname).is_absolute():
                raise CheckFailed(f"The release package holds an unsafe entry: {member.name}")
        try:
            archive.extractall(base, filter="data")
        except TypeError:  # Python before 3.12 has no extraction filters; the members were checked above
            archive.extractall(base)


def download_previous(into):
    """Download the previous release's package for this Mac and return its `ariadne` helper. `(None, None)` only
    when `gh` answered and no release is published; a `gh` failure (token, permission, network) is a failed check."""
    listed = run(["gh", "release", "list", "--limit", "30", "--json", "tagName,isDraft,publishedAt"])
    if listed.returncode != 0:
        raise CheckFailed(f"Could not list the published releases: {listed.stderr.strip()[:300] or f'gh exited {listed.returncode}'}")
    try:
        listing = json.loads(listed.stdout or "[]")
    except ValueError:
        raise CheckFailed(f"Could not read the list of published releases: {listed.stdout.strip()[:300]}")
    tag = previous_tag(listing)
    if tag is None:
        return None, None
    arch = "arm64" if platform.machine() in ("arm64", "aarch64") else "x86_64"
    packages = Path(into) / "download"
    packages.mkdir()
    fetched = run(["gh", "release", "download", tag, "--pattern", f"ariadne-*-macos-{arch}.tar.gz", "--dir", packages])
    found = sorted(packages.glob("*.tar.gz"))
    if fetched.returncode != 0 or len(found) != 1:
        raise CheckFailed(f"Could not download the {tag} package for {arch}: {fetched.stderr.strip()}")
    unpacked = Path(into) / "previous"
    unpacked.mkdir()
    safe_extract(found[0], unpacked)
    helpers = sorted(unpacked.glob("ariadne-*/ariadne"))
    if len(helpers) != 1:
        raise CheckFailed(f"The {tag} package has no single ariadne helper.")
    return helpers[0], tag


# --- Writing with this build ----------------------------------------------------------------------------------------

class Helper:
    """One `ariadne` helper run against the temporary data folder."""

    def __init__(self, path, home, label):
        self.path, self.label = Path(path), label
        self.env = {"PATH": "/usr/bin:/bin", "HOME": str(home / "home"), "ARIADNE_HOME": str(home / "data"), "LC_ALL": "C"}

    def call(self, *args, request=None):
        done = run([self.path, *args], input=None if request is None else json.dumps(request), env=self.env)
        try:
            body = json.loads(done.stdout)
        except ValueError:
            raise CheckFailed(f"{self.label} `ariadne {' '.join(map(str, args))}` printed no JSON (exit {done.returncode}): "
                              f"{(done.stderr or done.stdout).strip()[:300]}")
        if not body.get("ok"):
            raise CheckFailed(f"{self.label} `ariadne {' '.join(map(str, args))}` was refused: {json.dumps(body.get('error'))[:300]}")
        return body["data"]


def items_query():
    return {"command": "session_read", "params": {"selection": {"view": "items", "filters": {
        "topic_id": None, "item_id": None, "parent_item_id": None, "statuses": [], "archived": None}},
        "cursor": None, "limit": 100, "item_pages": []}}


def messages_query(item_id):
    return {"command": "item_messages", "params": {"item_id": item_id, "cursor": None, "limit": 50}}


def command(session, name, op_id, params):
    return {"session": session, "command": {"command": name, "api_version": 1, "op_id": op_id, "params": params}}


def write_store(new, project):
    """Write the populated store with this build. Returns what any reader of it must see."""
    route = new.call("demo", "--root", project, "--json")
    session = {"project_id": route["project_id"], "session_id": route["session_id"]}
    listed = new.call("session", "list", "--json")["data"]["sessions"]["items"][0]
    binding = listed["active_binding"]["id"]
    page = new.call("session", "read", "--json-stdin", request={"session": session, "request": items_query()})["data"]["page"]
    items = {entry["item"]["id"]: entry["item"] for entry in page["items"]}
    waiting = next(item for item in items.values() if item["status"] == "waiting_on_me")
    other = next(item for item in items.values() if item["status"] == "open")
    receipts = []
    for op_id, item, kind, text in ((ANSWER_OP, waiting, "answer", ANSWER_TEXT), (REPLY_OP, other, "reply", REPLY_TEXT)):
        receipts.append(new.call("input", "submit", "--json-stdin", request=command(session, "input_submit", op_id, {
            "binding_id": binding, "target": {"topic_id": item["topic_id"], "item_id": item["id"]}, "kind": kind, "text": text,
            "selected_option_id": None,
            "expected_question_revision": item["question_revision"] if kind == "answer" else None,
            "supersedes_answer_id": None})))
    revision = receipts[-1]["revision"]
    view = {"session": session, "tab_open": True, "selected_item_id": waiting["id"], "tab_order": 0,
            "expanded_item_ids": sorted(items)[:2],
            "filters": {"search": "", "statuses": [], "owners": [], "topic_id": None, "archived": False, "hide_later": False},
            "scroll": None}
    seen_items = [{"item_id": waiting["id"], "revision": waiting["revision"]}]
    seen_topics = [{"topic_id": waiting["topic_id"], "at": SEEN_AT}]
    global_preferences = {"theme": "dark", "selected_navigation": {"kind": "session", "session": session}, "window": None,
                          "pinned": True, "notification_watermark": SEEN_AT}
    new.call("preferences", "patch", "--json-stdin", request=command(None, "preferences_patch", VIEW_OP, {
        "expected_preferences_revision": new.call("preferences", "get", "--json")["data"]["revision"],
        "entries": [{"kind": "set_global", "preferences": global_preferences},
                    {"kind": "set_session_view", "preferences": view},
                    {"kind": "mark_seen", "session": session, "at": SEEN_AT, "items": seen_items, "topics": seen_topics}]}))
    # Recovery markers are saved on their own: this writes the recovery file next to ui.json.
    stuck = sorted(input_id for input_id, state in saved_inputs(project.parent / "data", session).items() if state == "needs_attention")
    if not stuck:
        raise CheckFailed("The demo session holds no input that needs attention, so there is nothing to mark as resolved.")
    unsent = stuck[0]
    new.call("preferences", "patch", "--json-stdin", request=command(None, "preferences_patch", RECOVERY_OP, {
        "expected_preferences_revision": new.call("preferences", "get", "--json")["data"]["revision"],
        "entries": [{"kind": "resolve_unsent_input", "input_id": unsent}]}))
    return {
        "session": session, "revision": revision, "item_ids": sorted(items), "waiting": waiting["id"], "other": other["id"],
        "preferences": {"global": global_preferences, "view": view, "seen_items": seen_items, "seen_topics": seen_topics,
                        "resolved": [unsent]},
    }


def saved_inputs(data, session):
    """Input ids and states straight from the session file this build wrote (read only, to pick a real input)."""
    path = Path(data) / "projects" / session["project_id"] / "sessions" / f"{session['session_id']}.json"
    return {input_id: value["state"] for input_id, value in json.loads(path.read_text())["inputs"].items()}


# --- Reading with the previous release ------------------------------------------------------------------------------

def expect(label, what, got, wanted):
    if got != wanted:
        raise CheckFailed(f"{label}: {what} came back as {json.dumps(got)[:300]}, expected {json.dumps(wanted)[:300]}")


def read_back(old, expected):
    label, session = old.label, expected["session"]
    report = old.call("doctor", "--json")
    checks = report["checks"]
    errors = [check["code"] for check in checks if check["status"] == "error"]
    expect(label, "doctor errors", errors, [])
    expect(label, "doctor saved-data problems", [c["code"] for c in checks if STORE_PROBLEMS.search(c["code"])], [])
    by_code = {check["code"]: check for check in checks}
    for code in ("registry.valid", "project.identity", "session.valid"):
        if code not in by_code:
            raise CheckFailed(f"{label}: doctor has no `{code}` check, so it did not read the store.")
    expect(label, "doctor project id", by_code["project.identity"]["facts"]["project_id"], session["project_id"])
    expect(label, "doctor session id", by_code["session.valid"]["facts"]["session_id"], session["session_id"])
    expect(label, "doctor session revision", by_code["session.valid"]["facts"]["revision"], expected["revision"])

    page = old.call("session", "read", "--json-stdin", request={"session": session, "request": items_query()})["data"]["page"]
    expect(label, "session read items", sorted(entry["item"]["id"] for entry in page["items"]), expected["item_ids"])
    expect(label, "session read revision", page["snapshot_revision"], expected["revision"])
    for item_id, text in ((expected["waiting"], ANSWER_TEXT), (expected["other"], REPLY_TEXT)):
        messages = old.call("item", "messages", "--json-stdin",
                            request={"session": session, "request": messages_query(item_id)})["data"]["messages"]["items"]
        expect(label, f"the owner texts on item {item_id}", [m["body"] for m in messages if m["body"] == text], [text])

    preferences = old.call("preferences", "get", "--json")["data"]
    wanted = expected["preferences"]
    expect(label, "global preferences", {key: preferences["global"].get(key) for key in wanted["global"]}, wanted["global"])
    expect(label, "the session view", [{key: view.get(key) for key in wanted["view"]} for view in preferences["sessions"]],
           [wanted["view"]])
    seen = preferences.get("seen") or []
    expect(label, "seen markers", [(s["session"], s["items"], s["topics"]) for s in seen],
           [(session, wanted["seen_items"], wanted["seen_topics"])])
    expect(label, "the recovery markers", preferences.get("resolved_unsent_input_ids"), wanted["resolved"])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--new", required=True, type=Path, help="this build's `ariadne` helper")
    parser.add_argument("--old", type=Path, help="the previous release's `ariadne` helper; default: download the latest release")
    args = parser.parse_args(argv)
    with tempfile.TemporaryDirectory(prefix="ariadne-previous-release-") as folder:
        work = Path(folder)
        (work / "home").mkdir()
        (work / "project").mkdir()
        old_path, tag = args.old, None
        if old_path is None:
            old_path, tag = download_previous(work)
            if old_path is None:
                print("There is no earlier release to check; nothing to compare.")
                return 0
        new, old = Helper(args.new, work, "This build"), Helper(old_path, work, "The previous release")
        previous = run([old_path, "--version"], env={"PATH": "/usr/bin:/bin"}).stdout.strip()
        if not previous.startswith("ariadne "):
            raise CheckFailed(f"The previous release's helper did not answer --version: {previous!r}")
        print(f"This build writes; {previous}{f' ({tag})' if tag else ''} reads.", flush=True)
        expected = write_store(new, work / "project")
        read_back(old, expected)
    print("The previous release reads everything this build wrote: doctor, a session read, item messages, preferences.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (CheckFailed, OSError, subprocess.SubprocessError, KeyError, ValueError) as error:
        print(f"Previous-release check failed: {error}", file=sys.stderr)
        sys.exit(1)
