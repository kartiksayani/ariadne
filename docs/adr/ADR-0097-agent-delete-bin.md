# ADR-0097: Agents delete into a recoverable bin

Status: accepted (2026-10-09).
Supersedes: none
Superseded by: none

## Context

The owner asked for agents to delete items and topics. Wrong or duplicate work
should leave the active tree without losing owner text or questions. Existing
permanent owner removal has backups and integrity guards
([remove.rs](../../crates/ariadne-core/src/history_actions/remove.rs), ADR-0083,
ADR-0088). Topic archive already preserves item state while abandoning pending
owner inputs ([lifecycle.rs](../../crates/ariadne-core/src/history_actions/lifecycle.rs),
ADR-0090); session archive keeps the same principle (ADR-0095). Hidden items are
view preferences only ([hidden.ts](../../apps/desktop/src/ui/tree/hidden.ts)).
The agent operation path is the existing typed Apply batch
([apply.rs](../../crates/ariadne-core/src/dto/apply.rs),
[batch.rs](../../crates/ariadne-core/src/apply/batch.rs)); ADR-0094 supplies the
end-to-end contract-generation and agent-skill pattern.

## Decision

- Agent `item.delete` removes the selected item and its subtree from active work;
  `topic.delete` removes that topic in the acting session. Both are recoverable.
  Any content in the bound session is eligible, including owner-written items,
  questions waiting on the owner and proposed acknowledgments. Existing session,
  selected agent, generation and revision guards apply. Archived topics and
  archived/closed sessions refuse agent changes. Another session is never affected.
- Persist optional `removed_at` and `removed_by: {binding_id,message_id}` on the
  selected root or topic. Descendants inherit removal. Old records omit these
  fields, without migration. Re-deleting effectively removed work succeeds without
  another marker or notice. Statuses, subtree structure, text, history and ordering
  remain intact. Only the changed root or topic advances its lifecycle revision.
- Ordinary reads, counts, Waiting on me, acknowledgments, Waiting/Sent columns,
  tree, graph, search and menu counts exclude effectively removed work. Agent
  reads report omitted work in plain words. Other writes to removed work refuse
  with an instruction to ask the owner to restore it. Owner snapshots and direct
  conversation reads retain the bin and cancelled message text.
- Deletion cancels only queued, undelivered owner inputs for removed work and
  clears their delivery barriers; their text stays visible as cancelled. Removed
  notices and already claimed or received inputs, including the deleting request's
  source input, remain valid. A result may land later if the deleting batch omitted
  it. A valid same-request result commits normally; the explicit-reply requirement
  is unchanged, and a reply before delete stays in history.
- Each newly removed scope saves a plain owner notice and an Apply receipt entry
  listing its items, waiting-question count and cancelled inputs. The desktop
  notice names the work and counts and offers Restore and View. It does not ask
  the owner to infer a missed question from disappearing counts.
- Desktop folds item subtrees under a topic's `Removed by agent · N` row and
  removed topics under the session's row. Rows are dimmed. Restore and Delete
  forever wait for current agent writes through the existing lifecycle readiness
  checks. Restore is revision guarded and clears only the selected marker;
  nested removal markers stay removed until separately restored. Cancelled
  messages stay cancelled. Restore sends no agent input, matching topic Restore.
- Delete forever uses the existing confirmed permanent owner remove, including
  its backup, cross-reference guards and topic continuation-family semantics.
  Agent topic deletion itself never deletes continuation copies in other sessions.
- Stored `related` and `replaced_by` references across the bin remain valid.
  Live projections skip removed destinations and restore them when visible again.
  Continue refuses a removed topic and omits removed item subtrees. Related links
  remap within the copied set; replacements outside it use existing imported-drop
  behavior. Source state remains intact.
- Agent rules teach deletion only for clearly wrong, duplicate or obsolete work
  the agent created or the owner asked to delete. Prefer Drop or Replace for real
  work that is no longer needed. Explain briefly what was deleted and why: reply
  before deleting an item; for an empty topic, explain in the next reply on another
  live item or in turn text. Include `input_result` in the deleting request when
  the owner asked.
  These are behavioral instructions, not content-based authorization refusals.

## Consequences

Owner restoration recovers the prior work without resending messages. Saved
operation receipts provide durable notice counts, and full owner snapshots keep
removed content available for review. No new trash store, host operation or
permanent agent-delete privilege is introduced.

## References

- [API and MCP](../planning/low-level/API_AND_MCP.md)
- [Domain and storage](../planning/low-level/DOMAIN_AND_STORAGE.md)
- [UI and native](../planning/low-level/UI_AND_NATIVE.md)
- [Agent rules](../../integrations/rules/source.md)
