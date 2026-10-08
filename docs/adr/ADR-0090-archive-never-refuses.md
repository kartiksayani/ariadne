# ADR-0090: Archive never refuses, and an archived topic is read-only to agents

Status: accepted (2026-10-08).
Supersedes: none (amends the archive guard of DOMAIN_AND_STORAGE and UI_AND_NATIVE)
Superseded by: none

## Context

The owner could not archive a topic that still had open items or messages on
their way. The UI hid Archive and showed a blocker list instead. The owner wants
Archive to work the way Close does (ADR-0088): one confirmed step that does the
safe thing itself.

## Decision

- **Archive always succeeds.** `topic_archive` no longer checks item status or
  pending inputs. In one commit it cancels the owner inputs that target the topic
  through the same abandon path as `session_close`:
  - queued inputs cancel;
  - in-flight and needs-attention inputs are abandoned (state `cancelled`,
    attempts sealed), and the binding's active input and barrier clear;
  - an input whose attempt already committed its result is handled instead.

  Items keep their status. The `topic_lifecycle` receipt lists
  `cancelled_input_ids`. `topic_not_archivable` is no longer produced; the code
  stays in the wire vocabulary.
- **Restore changes the lifecycle only.** The topic comes back unchanged.
  Cancelled inputs stay cancelled.
- **Counts.** Items in an archived topic leave every "Waiting on me" count
  (`waiting_unanswered` and the desktop rail, tree, footer, tray and project
  card) and come back on restore.
- **Agents read, but do not write.** `ariadne read` still returns an archived
  topic's topics, items and messages. Any agent apply that adds an item to an
  archived topic, or edits, asks, changes status, replaces or replies to an item
  in one, returns `invalid_transition` with `details.reason: topic_archived`.
  Claim never delivers an input for an archived topic.
- The integrity refusals stay: revision conflict, the topic already archived or
  restored, a missing topic and the topic revision limit.

## Consequences

- The owner never has to close items or cancel messages before archiving.
- An agent that tries to work on an archived topic gets one stable reason to
  leave it alone until the owner restores it.
- Contract changes:
  - `TopicLifecycle.cancelled_input_ids`;
  - `BarrierReason` `topic_archived`.

## Spec references

- [Domain and storage](../planning/low-level/DOMAIN_AND_STORAGE.md)
- [API and MCP](../planning/low-level/API_AND_MCP.md)
- [UI and native](../planning/low-level/UI_AND_NATIVE.md)
