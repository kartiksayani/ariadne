"""Pure delivery gates. GitHub facts come from the adapter; context IDs are attestations."""
import fnmatch
import json
import re
from datetime import datetime
from functools import lru_cache


def require(condition, message):
    if not condition:
        raise ValueError(message)


def text(value):
    return isinstance(value, str) and bool(value.strip())


def sha(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{40}", value) is not None


def timestamp(value):
    require(text(value), "Missing GitHub timestamp")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(result.tzinfo is not None, "Timestamp must include timezone")
        return result
    except (ValueError, TypeError) as error:
        raise ValueError("Invalid GitHub timestamp") from error


def parts(path):
    require(text(path) and not path.startswith("/") and "\\" not in path,
            "Path must be repository-relative")
    result = path.split("/")
    require(all(part not in {"", ".", ".."} for part in result), "Noncanonical path")
    return result


def owns_path(path, patterns):
    """Glob segments match from the repository root; ** matches zero or more segments."""
    segments = parts(path)
    for pattern in patterns:
        glob = parts(pattern)

        @lru_cache(None)
        def match(i, j):
            if j == len(glob):
                return i == len(segments)
            if glob[j] == "**":
                return match(i, j + 1) or (i < len(segments) and match(i + 1, j))
            return (i < len(segments) and fnmatch.fnmatchcase(segments[i], glob[j])
                    and match(i + 1, j + 1))

        if match(0, 0):
            return True
    return False


def overlap(left, right):
    """Conservative prefix overlap may serialize extra work, never overlapping owners."""
    for a in left:
        parts(a)
        for b in right:
            parts(b)
            x, y = re.split(r"[?*\[]", a, maxsplit=1)[0], re.split(r"[?*\[]", b, maxsplit=1)[0]
            if a == b or ((x != a or y != b) and (x.rstrip("/").startswith(y.rstrip("/")) or y.rstrip("/").startswith(x.rstrip("/")))):
                return True
    return False


def ready(tasks, completed, running):
    """Return candidates disjoint from running owners; reserve each launch before selecting again."""
    by_id = {task["id"]: task for task in tasks}
    done, active = set(completed), set(running)
    require(len(by_id) == len(tasks), "Duplicate task IDs")
    require((done | active) <= by_id.keys() and not done & active, "Invalid task state IDs")
    require(all(set(task["depends_on"]) <= by_id.keys() for task in tasks), "Unknown dependency")
    return sorted((task for task in tasks if task["id"] not in done | active
                   and set(task["depends_on"]) <= done
                   and all(not overlap(task["paths"], by_id[id]["paths"]) for id in active)),
                  key=lambda task: task["id"])


def review_payload(review):
    body = review.get("body", "")
    require(isinstance(body, str), "Invalid review body")
    blocks = re.findall(r"```ariadne-review[ \t]*\r?\n(.*?)\r?\n```", body, re.S)
    require(len(blocks) == 1, "Expected exactly one ariadne-review block")
    try:
        data = json.loads(blocks[0])
    except ValueError as error:
        raise ValueError("Invalid review JSON") from error
    require(isinstance(data, dict) and sha(data.get("head")), "Invalid review head")
    require(type(data.get("round")) is int and 1 <= data["round"] <= 3, "Review rounds must be 1–3")
    require(data.get("model") == "gpt-6.1-sol" and data.get("effort") == "high", "Reviewer model/effort mismatch")
    require(text(data.get("agent")) and isinstance(data.get("findings"), list), "Invalid reviewer/findings")
    ids = []
    for finding in data["findings"]:
        require(isinstance(finding, dict) and text(finding.get("id"))
                and finding.get("priority") in {"P0", "P1", "P2", "P3"}
                and text(finding.get("summary")), "Invalid review finding")
        ids.append(finding["id"])
    require(len(ids) == len(set(ids)), "Duplicate finding IDs in review")
    return data


def validate_gate(task, snapshot, record):
    """Return None before merge or chart evidence after an actual merge; otherwise raise ValueError."""
    require(all(isinstance(value, dict) for value in (task, snapshot, record)), "Expected object inputs")
    head, state = snapshot.get("head"), snapshot.get("state")
    require(record.get("task_id") == task.get("id") and sha(head) and record.get("head") == head,
            "Task or final head mismatch")
    require(state in {"OPEN", "MERGED"} and snapshot.get("is_draft") is False, "PR must be open or merged, not draft")
    require(sha(record.get("base")), "Missing reviewed main base")
    if state == "OPEN":
        require(record["base"] == snapshot.get("base") and snapshot.get("mergeable") is True,
                "Current main base or mergeability mismatch")
    require(snapshot.get("base_ref") == "main", "PR must explicitly target main")
    checks = snapshot.get("checks", [])
    require(isinstance(checks, list) and all(isinstance(check, dict) for check in checks), "Invalid checks")
    for name in ("quality", "change-policy"):
        matches = [check for check in checks if check.get("name") == name]
        require(matches and all(check.get("state") == "SUCCESS" for check in matches), "Missing/failed CI: " + name)
    files = snapshot.get("files", [])
    require(isinstance(files, list) and files and all(owns_path(path, task["paths"]) for path in files),
            "Out-of-scope or missing changed files")
    authors = record.get("authors", [])
    require(isinstance(authors, list) and authors and all(text(agent) for agent in authors), "Missing author/patcher contexts")
    reviews = snapshot.get("reviews", [])
    require(isinstance(reviews, list) and all(isinstance(review, dict) and isinstance(review.get("body", ""), str)
                                            for review in reviews), "Invalid fetched reviews")
    actual = [review for review in reviews if "```ariadne-review" in review.get("body", "")]
    actual.sort(key=lambda review: timestamp(review.get("submitted_at")))
    events = record.get("reviews", [])
    require(actual and isinstance(events, list) and all(isinstance(event, dict) and text(event.get("id")) for event in events)
            and [review.get("id") for review in actual]
            == [event.get("id") for event in events], "Missing, omitted or reordered structured review")
    require(len({event.get("id") for event in events}) == len(events), "Duplicate review event")
    rounds, findings = [], set()
    for fetched, event in zip(actual, events):
        data = review_payload(fetched)
        require(fetched.get("state") == "COMMENTED" and fetched.get("head") == data["head"] == event.get("head"),
                "Actual, embedded or recorded review head mismatch")
        require(event.get("agent") == data["agent"] and data["agent"] not in authors, "Review is not independent")
        require(type(event.get("round")) is int and event["round"] == data["round"], "Recorded review round mismatch")
        rounds.append(data["round"])
        findings.update(f'{event["id"]}:{finding["id"]}' for finding in data["findings"])
    require(rounds == sorted(rounds) and set(rounds) == set(range(1, max(rounds) + 1)), "Nonconsecutive review rounds")
    require(data["head"] == head and not data["findings"], "Final current-head review must have no findings")
    decisions = record.get("decisions", [])
    require(isinstance(decisions, list), "Invalid finding decisions")
    resolved = set()
    for decision in decisions:
        require(isinstance(decision, dict) and text(decision.get("finding"))
                and decision.get("finding") not in resolved
                and decision.get("disposition") in {"fixed", "deferred", "rejected"}
                and text(decision.get("reason")) and text(decision.get("spec")), "Unresolved/invalid finding decision")
        resolved.add(decision["finding"])
    require(findings == resolved, "Finding dispositions must exactly match review findings")
    spec = record.get("spec_review", {})
    require(isinstance(spec, dict) and isinstance(spec.get("sections"), list) and all(text(section) for section in spec["sections"])
            and set(task["spec"]) <= set(spec["sections"]) and text(spec.get("conclusion")), "Missing final spec adjudication")
    if state == "OPEN":
        return None
    timestamp(snapshot.get("merged_at"))
    require(sha(snapshot.get("merged_commit")) and text(snapshot.get("url")), "Missing actual merge evidence")
    return {"task_id": task["id"], "pr_url": snapshot["url"], "state": "MERGED",
            "merged_at": snapshot["merged_at"], "merged_commit": snapshot["merged_commit"],
            "head_sha": head, "reviewed_head": head, "checks_head": head, "spec_review_head": head,
            "checks_passed": True, "review_passed": True, "spec_review_passed": True}
