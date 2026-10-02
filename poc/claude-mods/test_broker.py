"""Focused SQLite broker transaction tests (not Claude runtime tests)."""
import importlib.util
from contextlib import contextmanager
from pathlib import Path
import tempfile
import threading
import unittest


BROKER_PATH = Path(__file__).parent / "plugin" / "scripts" / "broker.py"
SPEC = importlib.util.spec_from_file_location("ariadne_poc_broker", BROKER_PATH)
broker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(broker)


class BrokerTransactions(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = self.tmp.name
        self.sid = "session-one"
        with self.connection() as db:
            self.connected = broker.operate(db, "connect", {"session": self.sid})

    def tearDown(self):
        self.tmp.cleanup()

    def db(self):
        return broker.connect(self.project)

    @contextmanager
    def connection(self):
        db = self.db()
        try:
            yield db
        finally:
            db.close()

    def call(self, action, **data):
        with self.connection() as db:
            return broker.operate(db, action, {"session": self.sid, **data})

    @property
    def gen(self):
        return self.connected["generation"]

    def enqueue(self, text, item="item-1", sid=None):
        with self.connection() as db:
            return broker.operate(db, "enqueue", {"session": sid or self.sid,
                                                   "text": text, "item": item})

    def test_fifo_claims_one_at_a_time_for_same_session(self):
        first = self.enqueue("first")
        second = self.enqueue("second")
        claimed = self.call("claim", generation=self.gen)
        self.assertEqual(first["id"], claimed["id"])
        self.assertIsNone(self.call("claim", generation=self.gen))
        self.call("started", generation=self.gen, id=first["id"], turnId="turn-1")
        self.call("completed", generation=self.gen, id=first["id"], turnId="turn-1",
                  reason="answer", answer="done", isAborted=False)
        self.assertEqual(second["id"], self.call("claim", generation=self.gen)["id"])

    def test_concurrent_claimers_get_only_one_claim(self):
        message = self.enqueue("only once")
        barrier = threading.Barrier(8)
        results = []
        errors = []
        lock = threading.Lock()

        def claimant():
            try:
                barrier.wait()
                result = self.call("claim", generation=self.gen)
                with lock:
                    results.append(result)
            except Exception as exc:  # surfaced below rather than lost in thread
                with lock:
                    errors.append(exc)

        threads = [threading.Thread(target=claimant) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual([], errors)
        claims = [result for result in results if result is not None]
        self.assertEqual([message["id"]], [result["id"] for result in claims])

    def test_mismatched_completion_is_refused_without_state_change(self):
        message = self.enqueue("answer me")
        self.call("claim", generation=self.gen)
        self.call("started", generation=self.gen, id=message["id"], turnId="expected")
        with self.assertRaisesRegex(ValueError, "Completion does not match"):
            self.call("completed", generation=self.gen, id=message["id"],
                      turnId="other", reason="answer", answer="wrong", isAborted=False)
        with self.connection() as db:
            status = broker.operate(db, "status", {"session": self.sid})
        row = next(row for row in status["inputs"] if row["id"] == message["id"])
        self.assertEqual("running", row["state"])
        self.assertEqual("expected", row["turn"])

    def test_failed_completion_pauses_queue(self):
        message = self.enqueue("may fail")
        queued = self.enqueue("must wait")
        self.call("claim", generation=self.gen)
        self.call("started", generation=self.gen, id=message["id"], turnId="turn-x")
        self.call("completed", generation=self.gen, id=message["id"], turnId="turn-x",
                  reason="error", answer="", isAborted=False)
        self.assertIsNone(self.call("claim", generation=self.gen))
        with self.connection() as db:
            status = broker.operate(db, "status", {"session": self.sid})
        self.assertTrue(status["session"]["paused"])
        states = {row["id"]: row["state"] for row in status["inputs"]}
        self.assertEqual("failed", states[message["id"]])
        self.assertEqual("queued", states[queued["id"]])

    def test_reconnect_fences_generation_and_does_not_replay_uncertain_claim(self):
        message = self.enqueue("in flight during reload")
        self.call("claim", generation=self.gen)
        old_generation = self.gen
        self.connected = self.call("connect")
        self.assertNotEqual(old_generation, self.gen)
        self.assertTrue(self.connected["paused"])
        with self.assertRaisesRegex(ValueError, "Stale or unbound"):
            self.call("started", generation=old_generation, id=message["id"], turnId="late")
        self.assertIsNone(self.call("claim", generation=self.gen))
        with self.connection() as db:
            status = broker.operate(db, "status", {"session": self.sid})
        row = next(row for row in status["inputs"] if row["id"] == message["id"])
        self.assertEqual("claimed", row["state"])

    def test_sessions_are_isolated(self):
        second = "session-two"
        with self.connection() as db:
            connected = broker.operate(db, "connect", {"session": second})
        first_input = self.enqueue("first session", sid=self.sid)
        second_input = self.enqueue("second session", sid=second)
        with self.connection() as db:
            first_claim = broker.operate(db, "claim", {"session": self.sid,
                                                         "generation": self.gen})
            second_claim = broker.operate(db, "claim", {"session": second,
                                                          "generation": connected["generation"]})
        self.assertEqual(first_input["id"], first_claim["id"])
        self.assertEqual(second_input["id"], second_claim["id"])
        self.call("failed", generation=self.gen, id=first_input["id"], error="stop first")
        with self.connection() as db:
            second_status = broker.operate(db, "status", {"session": second})
        self.assertFalse(second_status["session"]["paused"])
        self.assertEqual("claimed", second_status["inputs"][0]["state"])


if __name__ == "__main__":
    unittest.main()
