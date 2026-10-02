#!/usr/bin/env python3
"""Test codex queue against an existing daemon-backed thread, without resuming it."""
import argparse
import json
import os
from pathlib import Path
import queue
import secrets
import subprocess
import sys
import threading
import time
import uuid
from unix_websocket import UnixWebSocket


class RpcError(RuntimeError):
    pass


class Client:
    def __init__(self, socket):
        self.transport = UnixWebSocket(socket)
        self.inbox = queue.Queue()
        self.errors = []
        self.serial = 0
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        try:
            while True:
                self.inbox.put(self.transport.receive())
        except Exception as exc:
            self.inbox.put({"reader_error": str(exc)})
        finally:
            self.inbox.put({"eof": True})

    def send(self, frame):
        self.transport.send(frame)

    def call(self, method, params, timeout=12):
        self.serial += 1
        ident = self.serial
        self.send({"id": ident, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RpcError(f"Timed out waiting for {method}")
            try:
                frame = self.inbox.get(timeout=remaining)
            except queue.Empty:
                raise RpcError(f"Timed out waiting for {method}") from None
            if frame.get("eof") or frame.get("reader_error"):
                raise RpcError("WebSocket closed: " + str(frame))
            # This observer does not start/resume/subscribe or handle approvals.
            if frame.get("id") != ident:
                continue
            if "error" in frame:
                raise RpcError(method + ": " + json.dumps(frame["error"]))
            return frame["result"]

    def close(self):
        self.transport.close()


def input_text(item):
    if item.get("type") != "userMessage":
        return ""
    return "\n".join(part.get("text", "") for part in item.get("content", []) if part.get("type") == "text")


def matched_turn(turns, marker):
    matches = [turn for turn in turns if any(marker in input_text(item) for item in turn.get("items", []))]
    if len(matches) > 1:
        raise RuntimeError("Input marker matched multiple turns; refusing ambiguous routing")
    return matches[0] if matches else None


def reply_items(turn):
    return [{k: item.get(k) for k in ("id", "text", "phase", "delivery")}
            for item in turn.get("items", []) if item.get("type") == "agentMessage"]


def answer_text(turn):
    items = reply_items(turn)
    finals = [item for item in items if item["phase"] == "final_answer"]
    # Preserve unknown-phase visible output; never import reasoning items.
    candidates = finals or [item for item in items if item["phase"] is None]
    return "\n".join(item["text"] or "" for item in candidates).strip()


def read_turns(client, thread):
    rows = []
    cursor = None
    for _ in range(5):
        params = {"threadId": thread, "limit": 20, "sortDirection": "desc", "itemsView": "full"}
        if cursor:
            params["cursor"] = cursor
        page = client.call("thread/turns/list", params)
        rows.extend(page["data"])
        cursor = page.get("nextCursor")
        if not cursor:
            return rows
    raise RuntimeError("Thread has over 100 turns; use a smaller test conversation for this POC")


def run(args, report):
    client = Client(args.socket)
    try:
        report["initialize"] = client.call("initialize", {
            "clientInfo": {"name": "ariadne_queue_poc", "version": "0.1.0"},
            "capabilities": {"experimentalApi": True},
        })
        client.send({"method": "initialized", "params": {}})
        thread = client.call("thread/read", {"threadId": args.thread, "includeTurns": False})["thread"]
        if thread["id"] != args.thread:
            raise RuntimeError("Returned thread identity differs from the requested UUID")
        report["initial_status"] = thread.get("status")
        if thread.get("status", {}).get("type") not in ("idle", "active"):
            raise RuntimeError("Target thread is not loaded and healthy; open it in your Codex terminal first")
        pending = client.call("thread/queue/list", {"threadId": args.thread, "limit": 20})
        if pending["data"]:
            raise RuntimeError("Target already has queued messages; finish them before this exercise")
        read_turns(client, args.thread)  # Verify the reply-read path before sending anything.
        print("Connected to existing thread:", args.thread, flush=True)
        print("Initial status:", json.dumps(report["initial_status"]), flush=True)
        nonce = report["nonce"]
        prompts = [
            f"Communication test only. Remember this exact phrase for my next message: {nonce}. Reply with exactly ACK. Do not use tools.",
            "What exact phrase did I just ask you to remember? Reply with that phrase only. Do not use tools.",
            "Reply with exactly ARIADNE_CODEX_POC_DONE. Do not use tools.",
        ]

        def enqueue(index):
            ident = str(uuid.uuid4())
            marker = f"[ARIADNE_INPUT:{ident}]"
            text = marker + f"\nOwner message on Ariadne item finding-{index + 1}:\n" + prompts[index]
            row = {"input_id": ident, "item_id": f"finding-{index + 1}", "marker": marker,
                   "text": text, "state": "sending", "send_started_at": time.time()}
            report["inputs"].append(row)
            print(f"Sending message {index + 1}: {ident}", flush=True)
            # Explicit socket keeps the queue sender and observer on the same daemon.
            command = ["rtk", "proxy", "codex", "queue", "--remote", "unix://" + str(args.socket),
                       "--thread", args.thread, "--message", text]
            result = subprocess.run(command, text=True, capture_output=True, timeout=20)
            row.update({"send_returned_at": time.time(), "queue_exit_code": result.returncode,
                        "queue_stdout": result.stdout[:8000], "queue_stderr": result.stderr[:8000]})
            if result.returncode != 0:
                row["state"] = "delivery_uncertain"
                raise RuntimeError("Queue command failed; no automatic retry: " + result.stderr[-2000:])
            row["state"] = "accepted_by_cli"

        enqueue(0)
        deadline = time.monotonic() + args.timeout
        last_states = None
        followups_sent_during_first = False
        first_still_running_after_followups = False
        while time.monotonic() < deadline:
            turns = read_turns(client, args.thread)
            for row in report["inputs"]:
                turn = matched_turn(turns, row["marker"])
                if not turn:
                    continue
                row.setdefault("first_observed_at", time.time())
                row.update({"turn_id": turn["id"], "state": turn["status"],
                            "started_at": turn.get("startedAt"), "completed_at": turn.get("completedAt"),
                            "duration_ms": turn.get("durationMs"), "items_view": turn.get("itemsView", "full"),
                            "reply_items": reply_items(turn), "answer": answer_text(turn),
                            "user_message_ids": [{"id": item.get("id"), "clientId": item.get("clientId")}
                                                 for item in turn.get("items", []) if row["marker"] in input_text(item)]})
                if row["state"] in ("completed", "failed", "interrupted"):
                    row.setdefault("terminal_observed_at", time.time())
            states = [row["state"] for row in report["inputs"]]
            if states != last_states:
                print("Queue:", ", ".join(states), flush=True)
                report["observations"].append({"at": time.time(), "states": states})
                last_states = states
            if any(state in ("failed", "interrupted") for state in states):
                raise RuntimeError("A turn failed or was interrupted; exercise stopped without retry")
            if len(report["inputs"]) == 1 and states[0] in ("inProgress", "completed"):
                followups_sent_during_first = states[0] == "inProgress"
                enqueue(1)
                enqueue(2)
                after = matched_turn(read_turns(client, args.thread), report["inputs"][0]["marker"])
                first_still_running_after_followups = bool(after and after["status"] == "inProgress")
            elif len(states) == 3 and all(state == "completed" for state in states):
                break
            time.sleep(0.25)
        rows = report["inputs"]
        distinct = len(rows) == 3 and all(row.get("turn_id") for row in rows) and len({row["turn_id"] for row in rows}) == 3
        fifo = distinct and all(
            rows[i].get("completed_at") is not None and rows[i + 1].get("started_at") is not None
            and rows[i]["completed_at"] <= rows[i + 1]["started_at"] for i in range(2)
        )
        report["checks"] = {
            "three_completed": len(rows) == 3 and all(row["state"] == "completed" for row in rows),
            "same_thread_read_without_resume": True,
            "three_distinct_turns": distinct,
            "fifo_turn_times": fifo,
            "context_retained": len(rows) >= 2 and rows[1].get("answer") == nonce,
            "final_ack": len(rows) == 3 and rows[2].get("answer") == "ARIADNE_CODEX_POC_DONE",
            "both_followups_accepted_while_first_running": followups_sent_during_first and first_still_running_after_followups,
            "full_item_views": all(row.get("items_view") == "full" for row in rows),
        }
        if not report["checks"]["three_completed"]:
            report["error"] = "Timed out before all replies completed. No retry or queue/start was issued."
        return all(report["checks"].values())
    finally:
        client.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("thread", help="Existing Codex thread UUID")
    parser.add_argument("--socket", type=Path, default=Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "app-server-control/app-server-control.sock")
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    args.thread = str(uuid.UUID(args.thread))
    args.socket = args.socket.expanduser().resolve()
    os.umask(0o077)
    directory = Path(__file__).resolve().parent / ".runtime"
    directory.mkdir(mode=0o700, exist_ok=True)
    report = {"thread_id": args.thread, "nonce": "ariadne-" + secrets.token_hex(6),
              "started_at": time.time(), "inputs": [], "observations": [], "checks": {},
              "method": "codex queue over explicit shared daemon socket; observer uses WebSocket-over-Unix with read-only history; no start/resume/queue-start RPC"}
    report_path = directory / ("exercise-" + str(uuid.uuid4()) + ".json")
    passed = False
    try:
        version = subprocess.run(["rtk", "proxy", "codex", "--version"], text=True, capture_output=True, timeout=10)
        report["cli_version"] = version.stdout.strip()
        passed = run(args, report)
    except (Exception, KeyboardInterrupt) as exc:
        report["error"] = type(exc).__name__ + ": " + str(exc)
        print("Stopped:", report["error"], flush=True)
    finally:
        report["finished_at"] = time.time()
        report["passed"] = passed
        report_path.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report["checks"], indent=2), flush=True)
        print("Evidence:", report_path, flush=True)
        if not passed and report["inputs"]:
            print("Do not rerun blindly: sent messages may still be queued in Codex. Inspect that terminal first.", flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
