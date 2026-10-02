#!/usr/bin/env python3
"""Fresh GitHub evidence for the Ariadne maintainer; no agent execution."""
import argparse
import fcntl
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from delivery_core import owns_path, ready, validate_gate

ROOT = Path(__file__).resolve().parents[1]
REPO = "kartiksayani/ariadne"
LIST_QUERY = '''query($cursor:String) { repository(owner:"kartiksayani",name:"ariadne") {
 pullRequests(first:100,after:$cursor,states:[OPEN,MERGED]) {
 pageInfo { hasNextPage endCursor } nodes { number body state } } } }'''
SNAPSHOT_QUERY = '''query($number:Int!) { viewer { login }
 repository(owner:"kartiksayani",name:"ariadne") {
 defaultBranchRef { name target { oid } }
 pullRequest(number:$number) { number url state body isDraft mergeable baseRefName headRefOid
 headRepository { nameWithOwner } mergedAt mergeCommit { oid }
 commits(last:1) { nodes { commit { oid statusCheckRollup { state contexts(first:100) {
 pageInfo { hasNextPage } nodes { __typename ... on CheckRun { name status conclusion checkSuite { app { slug } } }
 ... on StatusContext { context state } } } } } } }
 reviews(first:100) { pageInfo { hasNextPage } nodes { id state body submittedAt author { login } commit { oid } } }
 files(first:100) { pageInfo { hasNextPage } nodes { path } }
 comments(first:100) { pageInfo { hasNextPage } nodes { body author { login } } }
 reviewThreads(first:100) { pageInfo { hasNextPage } nodes { isResolved } }
 } } }'''


def run(*args):
    prefix = ["rtk", "proxy"] if shutil.which("rtk") else []
    return subprocess.run([*prefix, *map(str, args)], cwd=ROOT, check=True,
                          text=True, capture_output=True).stdout


def graphql(query, **variables):
    args = ["gh", "api", "graphql", "-f", "query=" + query]
    for key, value in variables.items():
        args.extend(["-F" if isinstance(value, int) else "-f", f"{key}={value}"])
    result = json.loads(run(*args))
    if result.get("errors") or "data" not in result:
        raise ValueError("GitHub GraphQL returned an error")
    return result["data"]


def nodes(connection):
    if connection["pageInfo"]["hasNextPage"]:
        raise ValueError("Nested GitHub pagination exceeds 100 entries; review manually")
    return connection["nodes"]


def snapshot(number):
    data = graphql(SNAPSHOT_QUERY, number=number)
    repo = data["repository"]
    pr = repo["pullRequest"]
    if not pr or pr["baseRefName"] != "main" or repo["defaultBranchRef"]["name"] != "main":
        raise ValueError("PR must target Ariadne main")
    if not pr["headRepository"] or pr["headRepository"]["nameWithOwner"] != REPO:
        raise ValueError("Fork PRs are not accepted by this maintainer")
    commit = pr["commits"]["nodes"][0]["commit"]
    rollup = commit["statusCheckRollup"]
    if commit["oid"] != pr["headRefOid"] or not rollup or rollup["state"] != "SUCCESS":
        raise ValueError("Final-head GitHub check rollup must be SUCCESS")
    contexts = nodes(rollup["contexts"])
    required = {check["name"] for check in contexts if check["__typename"] == "CheckRun"
                and check["status"] == "COMPLETED" and check["conclusion"] == "SUCCESS"
                and check["checkSuite"]["app"] and check["checkSuite"]["app"]["slug"] == "github-actions"}
    if not {"quality", "change-policy"} <= required:
        raise ValueError("Both final-head GitHub Actions quality checks must succeed")
    if any(not thread["isResolved"] for thread in nodes(pr["reviewThreads"])):
        raise ValueError("Unresolved review threads remain")
    return {"number": number, "url": pr["url"], "state": pr["state"], "body": pr["body"],
            "head": pr["headRefOid"], "base": repo["defaultBranchRef"]["target"]["oid"],
            "base_ref": pr["baseRefName"], "mergeable": pr["mergeable"] == "MERGEABLE", "is_draft": pr["isDraft"],
            "checks": [{"name": name, "state": "SUCCESS"} for name in required],
            "reviews": [{"id": review["id"], "head": review["commit"]["oid"] if review["commit"] else None,
                         "body": review["body"], "state": review["state"], "submitted_at": review["submittedAt"]}
                        for review in nodes(pr["reviews"]) if review["state"] not in {"PENDING", "DISMISSED"}],
            "files": [file["path"] for file in nodes(pr["files"])], "comments": nodes(pr["comments"]),
            "merged_at": pr["mergedAt"], "merged_commit": pr["mergeCommit"]["oid"] if pr["mergeCommit"] else None,
            "viewer": data["viewer"]["login"], "spec_status": any(
                check["__typename"] == "StatusContext" and check["context"] == "maintainer-spec-review"
                and check["state"] == "SUCCESS" for check in contexts)}


def task_id(body):
    ids = re.findall(r"<!-- ariadne-task:([A-Za-z0-9_.-]+) -->", body)
    if len(ids) > 1:
        raise ValueError("PR has multiple task markers")
    return ids[0] if ids else None


def check_catalog(catalog):
    current = json.loads(run("git", "show", "refs/remotes/origin/main:docs/delivery/tasks.json"))
    if catalog != current:
        raise ValueError("Task catalogue differs from current main; refresh the maintainer checkout before continuing")


def ancestor(snap, task, catalog):
    number = snap["number"]
    run("git", "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main",
        f"+refs/pull/{number}/head:refs/delivery/{number}")
    check_catalog(catalog)
    if run("git", "rev-parse", "refs/remotes/origin/main").strip() != snap["base"]:
        raise ValueError("Main changed while fetching; verify the new base")
    if run("git", "rev-parse", f"refs/delivery/{number}").strip() != snap["head"]:
        raise ValueError("PR head changed while fetching")
    run("git", "merge-base", "--is-ancestor", snap["base"], snap["head"])
    paths = run("git", "diff", "--no-renames", "--name-only", "-z", snap["base"], snap["head"]).split("\0")
    if not all(owns_path(path, task["paths"]) for path in paths if path):
        raise ValueError("Git diff includes changed/deleted paths outside task ownership")


def receipt(task, snap, catalog):
    if not snap["spec_status"]:
        raise ValueError("Merged task lacks maintainer-spec-review SUCCESS")
    records = [json.loads(body) for comment in snap["comments"]
               if comment["author"] and comment["author"]["login"] == "kartiksayani"
               for body in re.findall(r"```ariadne-delivery\s*\n(.*?)\n```", comment["body"], re.S)]
    for record in reversed(records):
        if record.get("head") == snap["head"] and record.get("task_id") == task["id"]:
            proof = validate_gate(task, snap, record)
            run("git", "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main")
            check_catalog(catalog)
            if run("git", "rev-parse", "refs/remotes/origin/main").strip() != snap["base"]:
                raise ValueError("Main changed while verifying merged evidence")
            run("git", "merge-base", "--is-ancestor", snap["merged_commit"], snap["base"])
            return proof
    raise ValueError("Merged task lacks a genuine final-head delivery receipt")


def discover(tasks, catalog):
    completed, running, evidence, cursor = set(), set(), [], None
    for _ in range(20):
        data = graphql(LIST_QUERY, **({"cursor": cursor} if cursor else {}))["repository"]["pullRequests"]
        for pr in data["nodes"]:
            identifier = task_id(pr["body"])
            if not identifier:
                continue
            task = tasks[identifier]
            if pr["state"] == "OPEN":
                if identifier in running:
                    raise ValueError("Task has multiple open PRs")
                running.add(identifier)
            else:
                snap = snapshot(pr["number"])
                proof = receipt(task, snap, catalog)
                if identifier in completed:
                    raise ValueError("Task has multiple validated merged PRs")
                completed.add(identifier)
                evidence.append(proof)
        if not data["pageInfo"]["hasNextPage"]:
            return completed, running, evidence
        cursor = data["pageInfo"]["endCursor"]
        if not cursor:
            raise ValueError("GitHub pagination omitted its cursor")
    raise ValueError("GitHub PR listing exceeds 2000 entries")


def mutate(endpoint, payload, method="POST"):
    with tempfile.TemporaryDirectory(prefix="ariadne-delivery-") as directory:
        path = Path(directory) / "body.json"
        path.write_text(json.dumps(payload))
        return json.loads(run("gh", "api", f"repos/{REPO}/{endpoint}", "--method", method, "--input", path))


def eligible(tasks, task, catalog):
    completed, running, _ = discover(tasks, catalog)
    candidates = ready(list(tasks.values()), completed, running - {task["id"]})
    if task["id"] not in {candidate["id"] for candidate in candidates}:
        raise ValueError("Task prerequisites, completion or running ownership forbid this PR")


def merge(tasks, task, number, record, catalog):
    common = Path(run("git", "rev-parse", "--git-common-dir").strip())
    with (ROOT / common / "ariadne-delivery.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        snap = snapshot(number)
        validate_gate(task, snap, record)
        if snap["viewer"] != "kartiksayani" or snap["state"] != "OPEN":
            raise ValueError("Only the maintainer may merge an open task PR")
        eligible(tasks, task, catalog)
        ancestor(snap, task, catalog)
        comment = mutate(f"issues/{number}/comments", {"body": "```ariadne-delivery\n" + json.dumps(record, indent=2) + "\n```"})
        mutate(f"statuses/{snap['head']}", {"state": "success", "context": "maintainer-spec-review",
               "description": "Independent final-head review adjudicated against the task spec", "target_url": comment["html_url"]})
        eligible(tasks, task, catalog)
        fresh = snapshot(number)
        validate_gate(task, fresh, record)
        if (fresh["head"], fresh["base"]) != (snap["head"], snap["base"]):
            raise ValueError("Head or main changed immediately before merge")
        result = mutate(f"pulls/{number}/merge", {"sha": snap["head"], "merge_method": "rebase"}, "PUT")
        if not result.get("merged"):
            raise ValueError("GitHub refused the exact-head rebase merge")
        try:
            merged = snapshot(number)
            if merged["state"] != "MERGED":
                raise ValueError("GitHub has not confirmed merged state")
            return receipt(task, merged, catalog)
        except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
            raise ValueError(f"PR already merged; post-merge evidence verification failed: {error}") from error


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    select = commands.add_parser("ready")
    select.add_argument("--running", action="append", default=[])
    commands.add_parser("export")
    commands.add_parser("brief").add_argument("task")
    for name in ("verify", "merge"):
        command = commands.add_parser(name)
        command.add_argument("pr", type=int)
        command.add_argument("--record", type=Path, required=True)
    args = parser.parse_args(argv)
    origin = run("git", "remote", "get-url", "origin").strip()
    if origin not in {f"git@github.com:{REPO}.git", f"https://github.com/{REPO}.git", f"https://github.com/{REPO}"}:
        raise ValueError("Origin must be kartiksayani/ariadne on GitHub")
    catalog = json.loads((ROOT / "docs/delivery/tasks.json").read_text())
    tasks = {task["id"]: task for task in catalog["tasks"]}
    if args.command != "brief":
        run("git", "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main")
        check_catalog(catalog)
    if args.command == "brief":
        result = tasks[args.task]
    elif args.command in {"ready", "export"}:
        completed, running, evidence = discover(tasks, catalog)
        if args.command == "ready":
            if set(args.running) - tasks.keys():
                raise ValueError("Unknown reserved task")
            result = ready(list(tasks.values()), completed, running | set(args.running))
        else:
            result = {"schema_version": 1, "tasks": evidence}
    else:
        snap = snapshot(args.pr)
        task = tasks[task_id(snap["body"])]
        record = json.loads(args.record.read_text())
        validate_gate(task, snap, record)
        if args.command == "verify":
            if snap["state"] != "OPEN":
                raise ValueError("Verify expects an open PR; export rechecks merged evidence")
            eligible(tasks, task, catalog)
            ancestor(snap, task, catalog)
            result = {"pr": args.pr, "head": snap["head"], "base": snap["base"], "passed": True}
        else:
            result = merge(tasks, task, args.pr, record, catalog)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f"Delivery gate failed: {error}", file=sys.stderr)
        sys.exit(1)
