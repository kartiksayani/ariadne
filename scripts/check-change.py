#!/usr/bin/env python3
"""Keep code/test/config changes reviewable; report docs and generated files separately."""
import argparse
import fnmatch
import json
import shutil
import subprocess
import sys

GENERATED = (
    "Cargo.lock", "package-lock.json", "contracts/generated/*",
    "contracts/providers/*/schema/*", "*/src/generated/*",
)
LIMITS = {"commit": 400, "pr": 800}


def classify(numstat):
    result = {"handwritten": 0, "docs": 0, "generated": 0, "binary_files": []}
    for entry in numstat.split("\0"):
        if not entry:
            continue
        added, removed, path = entry.split("\t", 2)
        if added == "-" or removed == "-":
            result["binary_files"].append(path)
            continue
        count = int(added) + int(removed)
        if any(fnmatch.fnmatchcase(path, pattern) for pattern in GENERATED):
            category = "generated"
        elif path == "docs/delivery/tasks.json" or (path.endswith((".md", ".html"))
                and not path.startswith(("apps/", "crates/", "integrations/"))):
            category = "docs"
        else:
            category = "handwritten"
        result[category] += count
    return result


def git(*args, input=None):
    prefix = ["rtk", "proxy"] if shutil.which("rtk") else []
    return subprocess.run([*prefix, "git", *args], check=True, text=True,
                          stdout=subprocess.PIPE, input=input).stdout


def check(args, kind):
    counts = classify(git("diff", "--numstat", "-z", "--no-renames", *args))
    print(json.dumps({"scope": kind, "limit": LIMITS[kind], **counts}))
    if counts["handwritten"] > LIMITS[kind]:
        raise ValueError(f"{kind} exceeds {LIMITS[kind]} changed hand-authored lines; split it by behavior")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staged", action="store_true")
    parser.add_argument("--base")
    parser.add_argument("--head", default="HEAD")
    args = parser.parse_args(argv)
    if args.staged:
        if args.base:
            parser.error("--staged and --base are mutually exclusive")
        check(["--cached"], "commit")
        return
    if not args.base:
        parser.error("--base is required for PR checks")
    # Resolve untrusted input as an object name, never pass it as a Git option.
    head = git("rev-parse", "--verify", "--end-of-options", args.head + "^{commit}").strip()
    initial = args.base in {"0" * 40, "0" * 64}
    if initial:
        ancestor = git("hash-object", "-t", "tree", "--stdin", input="").strip()
    else:
        base = git("rev-parse", "--verify", "--end-of-options", args.base + "^{commit}").strip()
        ancestor = git("merge-base", base, head).strip()
    check([ancestor, head], "pr")
    commits = git("rev-list", "--reverse", head if initial else f"{ancestor}..{head}").splitlines()
    for commit in commits:
        parents = git("rev-list", "--parents", "-n", "1", commit).split()[1:]
        if not parents and initial:
            check([ancestor, commit], "commit")
        elif len(parents) != 1:
            raise ValueError("Use a linear PR branch; refresh with rebase before review")
        else:
            check([parents[0], commit], "commit")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        print(f"Change policy failed: {error}", file=sys.stderr)
        sys.exit(1)
