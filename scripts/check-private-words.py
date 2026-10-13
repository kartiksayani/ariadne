#!/usr/bin/env python3
"""Block pushed additions and commit messages containing locally listed text."""
import os
import re
import subprocess
import sys
from pathlib import Path


def git(*args):
    return subprocess.run(
        ["git", "--no-pager", *args], check=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ).stdout.decode("utf-8", errors="surrogateescape")


def matches(text, words):
    folded = text.casefold()
    return [word for word in words if word.casefold() in folded]


def scan(base, head, words):
    found = False
    paths = git("diff", "--no-ext-diff", "--no-textconv", "--no-renames",
                "--name-only", "-z", "--diff-filter=AMT", base, head, "--").split("\0")
    for path in filter(None, paths):
        diff = git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color",
                   "--output-indicator-new=+", "--output-indicator-old=-",
                   "--output-indicator-context= ", "--unified=0", base, head, "--", ":(literal)" + path)
        number = None
        for line in diff.split("\n"):
            hunk = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
            if hunk:
                number = int(hunk[1])
            elif number is not None and line.startswith("+"):
                for word in matches(line[1:], words):
                    print(f"{path}:{number}: {word}")
                    found = True
                number += 1
            elif number is not None and line.startswith(" "):
                number += 1
    messages = git("log", "--no-show-signature", "--encoding=UTF-8",
                   "--format=%h%x00%B%x00", f"{base}..{head}", "--")
    fields = messages.split("\0")
    for index in range(0, len(fields) - 1, 2):
        for word in matches(fields[index + 1], words):
            print(f"commit {fields[index].strip()} message: {word}")
            found = True
    return found


def main():
    path = Path(os.environ.get("ARIADNE_PRIVATE_WORDS") or
                Path.home() / ".config/ariadne/private-words.txt")
    try:
        contents = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        print("Private-word check: list file missing; allowing push.")
        return 0
    words = list(dict.fromkeys(line.strip() for line in contents.splitlines()
                              if line.strip() and not line.lstrip().startswith("#")))
    found = False
    for update in sys.stdin:
        _, local, _, remote = update.split()
        if not all(re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", oid) for oid in (local, remote)):
            raise ValueError("Invalid push object ID")
        if set(local) == {"0"}:
            continue
        base = git("rev-parse", "--verify", "origin/main^{commit}").strip() if set(remote) == {"0"} else remote
        head = git("rev-parse", "--verify", local + "^{commit}").strip()
        found = scan(base, head, words) or found
    return int(found)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, UnicodeError, ValueError, subprocess.CalledProcessError):
        print("Private-word check failed: check the list file and local Git objects; push blocked.", file=sys.stderr)
        sys.exit(1)
