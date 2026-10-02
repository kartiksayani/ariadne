"""Behavior tests for exact-head review gates and exclusive task ownership."""
import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.delivery_core import overlap, owns_path, ready, validate_gate  # noqa: E402

HEAD, BASE, OLD = "a" * 40, "b" * 40, "c" * 40
TASK = {"id": "P0.1", "depends_on": [], "paths": ["src/**"], "spec": ["docs/spec.md#behavior"]}


def review(id="R1", head=HEAD, round=1, findings=None, agent="reviewer"):
    payload = dict(head=head, round=round, findings=findings or [], agent=agent, model="gpt-6.1-sol", effort="high")
    fetched = dict(id=id, head=head, state="COMMENTED", submitted_at=f"2026-10-02T00:00:0{round}Z",
                   body="Review evidence\n```ariadne-review\n" + json.dumps(payload) + "\n```")
    return fetched, dict(id=id, head=head, agent=agent, round=round)


def fixture():
    fetched, event = review()
    snapshot = dict(number=1, url="https://github.com/kartiksayani/ariadne/pull/1", state="OPEN",
                    head=HEAD, base=BASE, base_ref="main", mergeable=True, is_draft=False, files=["src/one.rs"],
                    checks=[dict(name=name, state="SUCCESS") for name in ["quality", "change-policy"]], reviews=[fetched])
    record = dict(task_id=TASK["id"], head=HEAD, base=BASE, authors=["implementer", "patcher"], reviews=[event],
                  decisions=[], spec_review=dict(sections=TASK["spec"], conclusion="Meets the accepted behavior."))
    return snapshot, record


class GateTests(unittest.TestCase):
    def test_declared_adrs_specs_and_review_are_exact_narrow_exceptions(self):
        adr, spec = "docs/adr/ADR-0001-choice.md", "docs/spec.md"
        snapshot, record = fixture()
        record.update(architecture_decisions=[adr], spec_updates=[spec])
        snapshot["files"] += [adr, spec]
        payload = json.loads(snapshot["reviews"][0]["body"].split("```ariadne-review\n")[1].split("\n```")[0])
        payload.update(architecture_decisions=[adr], spec_updates=[spec])
        snapshot["reviews"][0]["body"] = "```ariadne-review\n" + json.dumps(payload) + "\n```"
        record["spec_review"]["sections"] = [*TASK["spec"], adr, spec]
        self.assertIsNone(validate_gate(TASK, snapshot, record))
        mutations = [lambda s, r: r.update(architecture_decisions=[]),
                     lambda s, r: r.update(architecture_decisions=[adr, adr]),
                     lambda s, r: r.update(spec_updates=["other.md"]),
                     lambda s, r: r.update(architecture_decisions=["src/other.rs"]),
                     lambda s, r: r.update(spec_updates="docs/spec.md"),
                     lambda s, r: r.update(architecture_decisions=["docs/adr/../other.md"]),
                     lambda s, r: s["files"].append("src-independent/other.rs"),
                     lambda s, r: s["files"].remove(adr), lambda s, r: s["files"].remove(spec),
                     lambda s, r: s["reviews"][0].update(body=review()[0]["body"]),
                     lambda s, r: r["spec_review"].update(sections=TASK["spec"])]
        for mutate in mutations:
            s, r = copy.deepcopy(snapshot), copy.deepcopy(record)
            mutate(s, r)
            with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                validate_gate(TASK, s, r)

    def test_open_and_actual_merge(self):
        snapshot, record = fixture()
        self.assertIsNone(validate_gate(TASK, snapshot, record))
        snapshot.update(state="MERGED", merged_at="2026-10-02T01:00:00Z", merged_commit=OLD, base="d" * 40)
        evidence = validate_gate(TASK, snapshot, record)
        self.assertEqual((evidence["head_sha"], evidence["merged_commit"]), (HEAD, OLD))
        self.assertTrue(evidence["review_passed"])
        del snapshot["merged_commit"]
        with self.assertRaises(ValueError):
            validate_gate(TASK, snapshot, record)

    def test_invalid_pr_ci_scope_and_adjudication(self):
        mutations = [lambda s, r: r.update(head=OLD), lambda s, r: r.update(task_id="P0.2"),
                     lambda s, r: r.update(base=OLD), lambda s, r: s.update(mergeable=False),
                     lambda s, r: s.pop("base_ref"), lambda s, r: s.update(base_ref="other"),
                     lambda s, r: s.update(is_draft=True), lambda s, r: s.update(state="CLOSED"),
                     lambda s, r: s.update(checks=[]), lambda s, r: s["checks"][0].update(state="FAILURE"),
                     lambda s, r: s.update(files=["other.rs"]), lambda s, r: s.update(files=["src/../secret"]),
                     lambda s, r: r.update(spec_review=dict(sections=[], conclusion="okay")),
                     lambda s, r: r["spec_review"].update(conclusion=" "), lambda s, r: r.update(authors=[])]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                snapshot, record = fixture()
                mutate(snapshot, record)
                with self.assertRaises(ValueError):
                    validate_gate(TASK, snapshot, record)

    def test_review_independence_head_model_and_order(self):
        for agent in ["implementer", "patcher"]:
            snapshot, record = fixture()
            fetched, event = review(agent=agent)
            snapshot["reviews"], record["reviews"] = [fetched], [event]
            with self.assertRaises(ValueError):
                validate_gate(TASK, snapshot, record)
        for changes in [dict(head=OLD), dict(round=4), dict(round=2)]:
            snapshot, record = fixture()
            fetched, event = review(**changes)
            snapshot["reviews"], record["reviews"] = [fetched], [event]
            with self.assertRaises(ValueError):
                validate_gate(TASK, snapshot, record)
        snapshot, record = fixture()
        snapshot["reviews"][0]["body"] = snapshot["reviews"][0]["body"].replace("gpt-6.1-sol", "other-model")
        with self.assertRaises(ValueError):
            validate_gate(TASK, snapshot, record)
        snapshot, record = fixture()
        snapshot["reviews"].append(review(id="R2", round=2, findings=[dict(id="F2", priority="P1", summary="New bug")])[0])
        with self.assertRaises(ValueError):
            validate_gate(TASK, snapshot, record)

    def test_findings_need_disposition_and_final_verification(self):
        snapshot, record = fixture()
        first, event = review(head=OLD, findings=[dict(id="F1", priority="P1", summary="A concrete defect")])
        last, final = review(id="R2", round=2)
        snapshot["reviews"], record["reviews"] = [first, last], [event, final]
        with self.assertRaises(ValueError):
            validate_gate(TASK, snapshot, record)
        for disposition in ["fixed", "deferred", "rejected"]:
            record["decisions"] = [dict(finding="R1:F1", disposition=disposition, reason="Spec-backed judgment", spec=TASK["spec"][0])]
            self.assertIsNone(validate_gate(TASK, snapshot, record))
        broken = copy.deepcopy(record)
        broken["decisions"][0]["disposition"] = "pending"
        with self.assertRaises(ValueError):
            validate_gate(TASK, snapshot, broken)
        snapshot["reviews"].reverse()
        self.assertIsNone(validate_gate(TASK, snapshot, record))  # Actual timestamps determine chronology.
        record["reviews"].reverse()
        with self.assertRaises(ValueError):
            validate_gate(TASK, snapshot, record)

    def test_multiple_verifications_same_round_and_duplicate_events(self):
        snapshot, record = fixture()
        fetched, event = review(id="R2")
        snapshot["reviews"].append(fetched)
        record["reviews"].append(event)
        self.assertIsNone(validate_gate(TASK, snapshot, record))
        record["reviews"][1]["id"] = "R1"
        with self.assertRaises(ValueError):
            validate_gate(TASK, snapshot, record)

    def test_repeated_finding_ids_need_review_scoped_dispositions(self):
        snapshot, record = fixture()
        finding = dict(id="F1", priority="P1", summary="A defect in this review")
        pairs = [review(id="R_first", head=OLD, round=1, findings=[finding]),
                 review(id="R_second", head=OLD, round=2, findings=[finding]), review(id="R_final", round=3)]
        snapshot["reviews"] = [pair[0] for pair in pairs]
        record["reviews"] = [pair[1] for pair in pairs]
        record["decisions"] = [dict(finding="R_first:F1", disposition="fixed", reason="First defect fixed", spec=TASK["spec"][0])]
        with self.assertRaises(ValueError):
            validate_gate(TASK, snapshot, record)
        record["decisions"].append(dict(finding="R_second:F1", disposition="fixed", reason="Second defect fixed", spec=TASK["spec"][0]))
        self.assertIsNone(validate_gate(TASK, snapshot, record))
        record["decisions"].append(dict(finding="R_unknown:F1", disposition="rejected", reason="Unrelated", spec=TASK["spec"][0]))
        with self.assertRaises(ValueError):
            validate_gate(TASK, snapshot, record)


class OwnershipTests(unittest.TestCase):
    def test_rooted_globs_and_conservative_overlap(self):
        self.assertTrue(owns_path("src/file.rs", ["src/**/file.rs"]))
        self.assertTrue(owns_path("src/deep/file.rs", ["src/**/file.rs"]))
        self.assertFalse(owns_path("other/src/file.rs", ["src/*.rs"]))
        self.assertFalse(owns_path("src/deep/file.rs", ["src/*.rs"]))
        self.assertTrue(overlap(["src/**"], ["src/file.rs"]) and overlap(["src/**"], ["src"]))
        self.assertFalse(overlap(["src/a.rs"], ["src/b.rs"]))

    def test_dependencies_and_running_owners(self):
        dependent = dict(id="P0.2", depends_on=["P0.1"], paths=["other/**"])
        conflict = dict(id="P0.3", depends_on=[], paths=["src/file.rs"])
        tasks = [TASK, dependent, conflict]
        self.assertEqual([t["id"] for t in ready(tasks, [], ["P0.1"])], [])
        self.assertEqual([t["id"] for t in ready(tasks, ["P0.1"], [])], ["P0.2", "P0.3"])
        with self.assertRaises(ValueError):
            ready(tasks, ["unknown"], [])
