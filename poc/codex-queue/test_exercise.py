"""Focused offline checks for the Codex queue exercise harness."""
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import exercise


def user_turn(turn_id, marker, status="completed", answer="", started=1, completed=2):
    return {
        "id": turn_id,
        "status": status,
        "startedAt": started,
        "completedAt": completed if status == "completed" else None,
        "itemsView": "full",
        "items": [
            {"id": "u-" + turn_id, "type": "userMessage", "clientId": "c-" + turn_id,
             "content": [{"type": "text", "text": marker + " prompt"}]},
            {"id": "a-" + turn_id, "type": "agentMessage", "phase": "final_answer", "text": answer},
        ],
    }


class ExerciseHelpersTest(unittest.TestCase):
    def test_marker_matches_user_message_only(self):
        marker = "[ARIADNE_INPUT:one]"
        turn = {"id": "t", "items": [
            {"type": "agentMessage", "text": marker},
            {"type": "userMessage", "content": [{"type": "text", "text": "ordinary input"}]},
        ]}
        self.assertIsNone(exercise.matched_turn([turn], marker))

    def test_ambiguous_marker_is_rejected(self):
        marker = "[ARIADNE_INPUT:duplicate]"
        turns = [user_turn("one", marker), user_turn("two", marker)]
        with self.assertRaisesRegex(RuntimeError, "multiple turns"):
            exercise.matched_turn(turns, marker)

    def test_final_phase_preferred_unknown_phase_kept_reasoning_excluded(self):
        turn = {"items": [
            {"type": "agentMessage", "phase": "commentary", "text": "status"},
            {"type": "agentMessage", "phase": "analysis", "text": "private reasoning"},
            {"type": "agentMessage", "phase": "final_answer", "text": "answer"},
        ]}
        self.assertEqual(exercise.answer_text(turn), "answer")
        unknown = {"items": [
            {"type": "agentMessage", "phase": "future_visible_phase", "text": "visible"},
            {"type": "agentMessage", "phase": "analysis", "text": "private reasoning"},
        ]}
        self.assertEqual(exercise.answer_text(unknown), "")
        no_phase = {"items": [
            {"type": "agentMessage", "text": "legacy visible"},
            {"type": "agentMessage", "phase": "analysis", "text": "private reasoning"},
        ]}
        self.assertEqual(exercise.answer_text(no_phase), "legacy visible")


class ExerciseLifecycleTest(unittest.TestCase):
    def test_core_run_queues_three_distinct_fifo_contextual_turns_without_resume_or_start(self):
        queued_markers = []

        class FakeClient:
            def __init__(self, socket):
                self.calls = []
                self.turn_list_reads = 0

            def call(self, method, params, timeout=12):
                self.calls.append((method, params))
                if method == "initialize":
                    return {"protocolVersion": "mock"}
                if method == "thread/read":
                    return {"thread": {"id": params["threadId"], "status": {"type": "idle"}}}
                if method == "thread/queue/list":
                    return {"data": []}
                if method == "thread/turns/list":
                    self.turn_list_reads += 1
                    if self.turn_list_reads == 1:
                        turns = []
                    elif self.turn_list_reads <= 3:
                        turns = [user_turn("turn-1", queued_markers[0], "inProgress", started=1)]
                    else:
                        turns = [
                            user_turn("turn-1", queued_markers[0], answer="ACK", started=1, completed=10),
                            user_turn("turn-2", queued_markers[1], answer="nonce", started=11, completed=20),
                            user_turn("turn-3", queued_markers[2], answer="ARIADNE_CODEX_POC_DONE", started=21, completed=30),
                        ]
                    return {"data": turns}
                raise AssertionError("unexpected RPC " + method)

            def send(self, frame):
                self.calls.append(("notification:" + frame["method"], frame.get("params")))

            def close(self):
                pass

        fake_client = FakeClient("unused")
        queue_calls = []

        def fake_subprocess_run(command, **kwargs):
            queue_calls.append(command)
            queued_markers.append(command[-1].splitlines()[0])
            return subprocess.CompletedProcess(command, 0, "queued\n", "")

        args = SimpleNamespace(socket="mock.sock", thread="thread-uuid", timeout=3)
        report = {"nonce": "nonce", "inputs": [], "observations": []}
        with patch.object(exercise, "Client", return_value=fake_client), patch.object(exercise.subprocess, "run", side_effect=fake_subprocess_run):
            passed = exercise.run(args, report)

        self.assertTrue(passed, report)
        self.assertEqual([row["turn_id"] for row in report["inputs"]], ["turn-1", "turn-2", "turn-3"])
        self.assertTrue(report["checks"]["fifo_turn_times"])
        self.assertTrue(report["checks"]["context_retained"])
        self.assertTrue(report["checks"]["both_followups_accepted_while_first_running"])
        self.assertEqual(len(queue_calls), 3)
        self.assertFalse(any(method in ("thread/resume", "thread/start", "thread/queue/start")
                             for method, _ in fake_client.calls))


if __name__ == "__main__":
    unittest.main()
