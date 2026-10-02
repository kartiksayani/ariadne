#!/usr/bin/env python3
"""Send three real messages to an already-connected Claude session; never launch Claude."""
import argparse
import importlib.util
import json
from pathlib import Path
import secrets
import sys
import time

spec = importlib.util.spec_from_file_location("broker", Path(__file__).parent / "plugin/scripts/broker.py")
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session")
    parser.add_argument("--project", default=str(Path(__file__).resolve().parents[2]))
    parser.add_argument("--timeout", type=int, default=90)
    args = parser.parse_args()
    db = broker.connect(args.project)
    sid = args.session
    initial = broker.operate(db, "status", {"session": sid})
    if not initial["session"] or initial["session"]["paused"]:
        parser.error("Session is not connected and ready; run /ariadne-connect there first")
    if any(row["state"] != "done" for row in initial["inputs"]):
        parser.error("Finish or inspect existing queue entries before running this exercise")

    nonce = "ariadne-" + secrets.token_hex(6)
    prompts = [
        f"Communication test only. Remember this exact phrase for my next message: {nonce}. Reply with exactly ACK. Do not use tools.",
        "What exact phrase did I just ask you to remember? Reply with that phrase only. Do not use tools.",
        "Reply with exactly ARIADNE_POC_DONE. Do not use tools.",
    ]
    ids = []

    def enqueue(index):
        result = broker.operate(db, "enqueue", {"session": sid, "item": f"finding-{index + 1}", "text": prompts[index]})
        ids.append(result["id"])
        print(f"Enqueued message {index + 1}: {result['id']}", flush=True)

    enqueue(0)
    deadline = time.monotonic() + args.timeout
    last_states = None
    queued_while_running = False
    while True:
        snapshot = broker.operate(db, "status", {"session": sid})
        rows = [row for row in snapshot["inputs"] if row["id"] in ids]
        states = [row["state"] for row in rows]
        if states != last_states:
            print("Queue: " + ", ".join(states), flush=True)
            last_states = states
        if len(ids) == 1 and rows[0]["state"] in ("running", "done"):
            queued_while_running = rows[0]["state"] == "running"
            enqueue(1)
            enqueue(2)
        elif len(ids) == 3 and all(state == "done" for state in states):
            break
        if any(state == "failed" for state in states) or snapshot["session"]["paused"]:
            break
        if time.monotonic() >= deadline:
            print("Timed out. No retry was submitted; inspect the queue before doing more.", flush=True)
            break
        time.sleep(0.1)

    events = [event for event in snapshot["events"] if event["data"].get("id") in ids]
    expected_lifecycle = [(kind, ident) for ident in ids for kind in ("started", "completed")]
    observed_lifecycle = [(event["kind"], event["data"]["id"]) for event in events if event["kind"] in ("started", "completed")]
    first_complete = next((event["at"] for event in events if event["kind"] == "completed" and event["data"]["id"] == ids[0]), None)
    later_enqueues = [event["at"] for event in events if event["kind"] == "enqueued" and event["data"]["id"] != ids[0]]
    checks = {
        "three_completed": len(rows) == 3 and all(row["state"] == "done" for row in rows),
        "same_session": all(row["session"] == sid for row in rows),
        "three_distinct_turns": len(rows) == 3 and all(row["turn"] for row in rows) and len({row["turn"] for row in rows}) == 3,
        "fifo_turn_lifecycle": len(ids) == 3 and observed_lifecycle == expected_lifecycle,
        "context_retained": len(rows) >= 2 and (rows[1]["answer"] or "").strip() == nonce,
        "final_ack": len(rows) == 3 and (rows[2]["answer"] or "").strip() == "ARIADNE_POC_DONE",
        "messages_enqueued_while_busy": queued_while_running and len(later_enqueues) == 2 and first_complete is not None and max(later_enqueues) < first_complete,
    }
    report = {"session": sid, "nonce": nonce, "checks": checks, "inputs": rows, "events": events,
              "scope": "External messages sent to an already-connected session. No Claude launch, resume or stdin delivery by this script."}
    destination = Path(args.project).resolve() / ".ariadne-mods-poc" / ("exercise-" + ids[0] + ".json")
    destination.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(checks, indent=2), flush=True)
    print(f"Evidence: {destination}", flush=True)
    db.close()
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
