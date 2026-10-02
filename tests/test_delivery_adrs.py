"""Behavior checks for committed decisions, immutable history and reciprocal replacement."""
import unittest

from scripts.delivery_adrs import parse, validate_changes, validate_documents

FIRST = "docs/adr/ADR-0001-first.md"
SECOND = "docs/adr/ADR-0002-second.md"


def document(number=1, status="accepted", supersedes="none", successor="none"):
    return (f"# ADR-{number:04d}: A concrete choice\n\nStatus: {status}\nSupersedes: {supersedes}\n"
            f"Superseded by: {successor}\n\n## Context\nAn implementation gap and two options.\n\n"
            "## Decision\nThe orchestrator chose the bounded option.\n\n## Consequences\nA practical cost.\n\n"
            "## Spec references\n[Behavior](../planning/spec.md#behavior)\n")


def replacement():
    return {FIRST: document(status="deprecated", successor="[ADR-0002](ADR-0002-second.md)"),
            SECOND: document(2, supersedes="[ADR-0001](ADR-0001-first.md)")}


class AdrTests(unittest.TestCase):
    def test_new_decision_and_supersession_preserve_history(self):
        before = {FIRST: document()}
        self.assertEqual(validate_changes({}, before, [FIRST]), {FIRST})
        self.assertEqual(validate_changes(before, replacement(), [FIRST, SECOND], ["docs/planning/spec.md"]), {SECOND})
        self.assertEqual(parse(FIRST, before[FIRST])["prose"], parse(FIRST, replacement()[FIRST])["prose"])
        self.assertEqual(validate_changes(before, before, []), set())

    def test_missing_undeclared_deleted_and_rewritten_decisions_fail(self):
        before = {FIRST: document()}
        cases = [(replacement(), [], ()), ({}, [FIRST], ()), (before, [SECOND], ()),
                 (replacement(), [SECOND], ()), (replacement(), [FIRST, SECOND], ["docs/planning/other.md"]),
                 ({FIRST: document().replace("bounded option", "different option")}, [FIRST], ())]
        for after, declared, specs in cases:
            with self.subTest(after=after, declared=declared), self.assertRaises(ValueError):
                validate_changes(before, after, declared, specs)
        changed = replacement()
        changed[FIRST] = changed[FIRST].replace("practical cost", "different cost")
        with self.assertRaisesRegex(ValueError, "preserve its prose"):
            validate_changes(before, changed, [FIRST, SECOND])
        with self.assertRaises(ValueError):
            validate_changes({}, replacement(), [FIRST, SECOND])

    def test_invalid_metadata_sections_and_reciprocal_links_fail(self):
        mutations = [lambda d: d.update({FIRST: d[FIRST].replace("ADR-0001:", "ADR-0009:")}),
                     lambda d: d.update({FIRST: d[FIRST].replace("accepted", "draft")}),
                     lambda d: d.update({FIRST: d[FIRST].replace("Status: accepted", "Status: accepted\nStatus: accepted")}),
                     lambda d: d.update({FIRST: d[FIRST].replace("## Decision", "## Missing")}),
                     lambda d: d.update({FIRST: d[FIRST].replace("The orchestrator chose the bounded option.", "")}),
                     lambda d: d.update({FIRST: d[FIRST].replace("Supersedes: none", "Supersedes: bad")}),
                     lambda d: d.update({FIRST: d[FIRST].replace("Supersedes: none", "Supersedes: [ADR-0002](ADR-0003-third.md)")}),
                     lambda d: d.update({FIRST: document(status="deprecated")}),
                     lambda d: d.update({"docs/adr/ADR-0001-duplicate.md": document()}),
                     lambda d: d.update({FIRST: document(supersedes="[ADR-0002](ADR-0002-second.md)")})]
        for mutate in mutations:
            docs = {FIRST: document()}
            mutate(docs)
            with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                validate_documents(docs)
        for path in ["docs/adr/ADR-0000-zero.md", "docs/adr/ADR-one.md"]:
            with self.assertRaises(ValueError):
                validate_documents({path: document(0)})
        docs = replacement()
        docs[SECOND] = document(2)
        with self.assertRaisesRegex(ValueError, "reciprocal"):
            validate_documents(docs)
        docs = replacement()
        docs[FIRST] = document()
        with self.assertRaisesRegex(ValueError, "reciprocal"):
            validate_documents(docs)

    def test_successor_can_later_be_replaced(self):
        third = "docs/adr/ADR-0003-third.md"
        before = replacement()
        after = dict(before)
        after[SECOND] = before[SECOND].replace("Status: accepted", "Status: deprecated").replace(
            "Superseded by: none", "Superseded by: [ADR-0003](ADR-0003-third.md)")
        after[third] = document(3, supersedes="[ADR-0002](ADR-0002-second.md)")
        self.assertEqual(validate_changes(before, after, [SECOND, third]), {third})
