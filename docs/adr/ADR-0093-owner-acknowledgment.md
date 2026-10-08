# ADR-0093: Read first, then Ack

Status: accepted (2026-10-09)
Supersedes: none
Superseded by: none

## Context

An agent could file a new finding or explanation already Done, so the owner
could miss it. Read-only work needs a small acknowledgment without creating a
question or sending a message to the agent.

## Decision

- New agent items must be nonterminal. The strict core rejects terminal creation,
  including Replaced. Following ADR-0092, the lenient CLI repairs Decided, Done
  and Dropped creation to Open with `ack_to` set to the requested state, including
  nested children. It reports the repair plainly. Conflicting explicit targets
  are rejected rather than silently overwritten.
- `ack_to` is optional and permits only `decided`, `done` and `dropped`. Open
  and InProgress items may carry the agent's intended `outcome` and `why` with
  this target; those words survive filing and acknowledgment. Older items omit
  the field and load unchanged. Loading alone never rewrites stored bytes.
- The owner command `ack` takes an item and its expected revision. Under the
  writer lock, it changes Open or InProgress to the recorded target, clears
  `ack_to`, and records owner activity and status history. It creates no input
  or delivery. The agent sees the state on its next read.
- Ack is refused if there is no target, the item is terminal, or an unanswered
  ask is waiting on the owner. An item can carry both an ask and `ack_to`, but
  its question must be answered first. Waiting counts keep their existing
  episode semantics; Open Ack items do not enter the Waiting rail.
- `item.status` to Open or InProgress can set `ack_to` and carry the proposed
  outcome and why. Omitting `ack_to` preserves an existing target and its prose.
  The agent finishes a summary by making it Open with a target for the owner.
  Strict core refuses any agent terminal transition, including replacement,
  while that item has `ack_to`. The agent cannot bypass the owner's Ack.
  Existing items without a target retain their strict terminal transitions.
- Lenient CLI repairs every Decided, Done or Dropped `item.status` request to
  Open with the requested target as `ack_to`, preserving its outcome and why
  and supplying a reason if absent. It reports the repair plainly. This repair
  depends only on request bytes, rather than changing live state, so identical
  retries keep the same operation ID even after the owner acknowledges it.
- The no-terminal-creation rule covers agent filing only. Continue is the owner's
  action: finished copies stay finished, and replacement links within the topic
  stay live and point to the copied replacement. External replacements retain
  the existing import-as-Dropped behavior and recorded provenance.
- New agent asks must have an answer round. Strict core refuses a new Open or
  InProgress item with an ask; lenient filing makes it Waiting on me, owned by
  the owner, preserving `ack_to` and text. Continue likewise repairs copied
  unanswered asks without a current round to Waiting on me with a fresh round.
  Reply, follow-up and Back to Open remain available throughout.
- Ack means the owner read the item. Permission to act requires a real question
  with an explicit option, such as “Got it, go ahead”.

## Consequences

New reports remain visible as Open until read. Quiet Ack controls identify the
target in the tree and detail panel; `a` acknowledges eligible items and keeps
its existing answer meaning on questions. Topic counts and graph markers make
unread acknowledgment work visible without inflating Waiting counts.

The CLI's deterministic operation ID still follows the expanded request.
Repairs change terminal-creation requests relative to versions before Ack, so
those old requests do not share the same derived ID or strict request digest
across an upgrade. Do not blindly resend an uncertain terminal-creation request
from an older version: read the session and reconcile its original receipt first.
Requests expanded by the current version retain exact replay behavior. Existing
stored items and receipts remain readable and are never rewritten just by loading.

## References

- [ADR-0092: Lenient CLI filing](ADR-0092-lenient-apply-in-the-cli.md)
- [Domain and storage](../planning/low-level/DOMAIN_AND_STORAGE.md)
- [API and MCP](../planning/low-level/API_AND_MCP.md)
