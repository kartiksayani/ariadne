# ADR-0093: Read first, then Ack

Status: accepted (2026-10-09)
Supersedes: none
Superseded by: none

## Context

An agent could file a new finding or explanation already Done, so the owner
could miss it. Read-only work needs a small acknowledgment without creating a
question or sending a message to the agent.

## Original decision (alpha.11)

The original decision is retained below as history. The alpha.12 revision
supersedes its restriction to terminal Ack targets and its optional target on
new read-only items; the other behavior remains in force.

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
  Existing items without `ack_to` retain terminal status transitions. With
  `ack_to`, terminal `item.status` is refused in strict filing or repaired in
  lenient filing unless the authenticated request answers an owner input
  (`source_input_id`) targeting that same item with kind Drop, Reply or Answer,
  such as Drop or “close it”. Owner-directed completion
  passes and clears `ack_to`. Superseded work uses `item.replace` with its live
  replacement link, also clearing `ack_to`.
- Lenient status repair applies only to existing items with `ack_to` and no
  qualifying owner input on that item: keep Open with the requested Decided, Done or Dropped target,
  retaining outcome and why. Unlike creation expansion, this decision needs
  live state. It runs under the store lock after replay lookup, against the
  original request intent; operation IDs and digests never depend on live state.
  Both preview and commit report repairs. Exact retries still replay after Ack.
- A Handled owner reply on the current question counts as replied only for Open
  and InProgress items, preserving the answered episode for Ack. Waiting on me
  counts only Queued/InFlight inputs and standing answers: explaining an owner
  follow-up or returning `unable` for Drop leaves the question answerable.
  Core counts, Ack and filing share the same predicate; the TypeScript selector
  mirrors it. Failed, cancelled,
  skipped, superseded and older-question inputs do not count. Handled inputs
  count only Answer/Reply/Note/Followup/Drop; a Handled Bring/Reopen requests
  an ask and cannot answer it, even at the same question revision. A newer ask
  advances the question revision and never reuses a prior Handled reply.
  Handling a reply cannot make its proposed completion lose Ack. Agent transitions
  and edits refuse an Open/InProgress unanswered ask, even without an Ack target; keep it
  Waiting on me, explain withdrawal with a new `ack_to: "dropped"` item, or
  replace the question with `item.replace`.
- The no-terminal-creation rule covers agent filing only. Continue is the owner's
  action: finished copies stay finished, and replacement links within the topic
  stay live and point to the copied replacement. External replacements retain
  the existing import-as-Dropped behavior and recorded provenance.
- New agent asks must have an answer round. Strict core refuses a new Open or
  InProgress item with an ask; lenient filing makes it Waiting on me, owned by
  the owner, preserving `ack_to` and text. Continue likewise repairs copied
  unanswered asks to Waiting on me with a fresh question revision and round,
  closing any previous live round. Inputs themselves are not imported, so copied
  non-answer replies and failed answers cannot strand an Open ask or suppress
  the new Waiting episode.
  Reply, follow-up and Back to Open remain available throughout.
- Ack means the owner read the item. Permission to act requires a real question
  with an explicit option, such as “Got it, go ahead”.

## Revised (alpha.12)

Ack records reading independently of completion. The agent deliberately chooses
the item's status after reading from `open`, `in_progress`, `decided`, `done`
or `dropped`; there is no implicit Done target. Use Open when the owner merely
reads and work continues, InProgress when work is underway, and Done or Decided
only when that item is truly finished once read. Item type alone cannot choose
the target. Ruled-out work can target Dropped.

New read-only Finding or Explanation items (without an ask) require an explicit
`ack_to`. Strict filing refuses omission with guidance to “choose ack_to ...”;
lenient filing supplies the item's current nonterminal status (`open` or
`in_progress`) as `ack_to` and reports the repair, so reading neither finishes
the work nor moves it backwards. Tasks, decisions, questions and items with asks
do not acquire an implicit Ack target. Existing
items without a target remain valid. Terminal creation repair still retains
the explicitly requested Decided, Done or Dropped as its target, preserving
outcome and why; it does not replace that intent with Open.

The owner Ack command clears `ack_to` and applies exactly that recorded status,
including Open or InProgress, under the writer lock with the expected revision.
It records owner activity and status history and creates no input or delivery.
Outcome and why survive nonterminal Ack just as they survive terminal Ack,
and remain through later nonterminal status changes. New Open/InProgress items
may carry outcome or why only with `ack_to`; filing a new ordinary item without
Ack still refuses that prose. Unanswered asks continue to block Ack.

An agent may revise `ack_to` through `item.edit` on an Open/InProgress item that already
has an Ack target. This changes only the target, retaining status and prose;
it cannot remove the target, add it to an ordinary item, or bypass an unanswered
ask. The existing owner-directed completion and replacement rules remain in
force. Agent instructions and examples teach a separate, deliberate target for
each item instead of treating every report, explanation or finding as Done.

## Consequences

New reports remain visible as Open until read. After reading they may remain
Open or become InProgress, rather than being marked finished automatically.
Quiet Ack controls identify the target in the tree and detail panel;
`a` acknowledges eligible items and keeps
its existing answer meaning on questions. Topic counts and graph markers make
unread acknowledgment work visible without inflating Waiting counts.

The CLI's deterministic operation ID still follows the expanded request.
Repairs change terminal-creation requests relative to versions before Ack.
Alpha.12 also changes previously accepted Open/InProgress findings/explanations
without an ask or `ack_to`, because CLI expansion now adds their current
`open` or `in_progress` status as `ack_to`.
Those old requests do not share the same derived ID or strict request digest
across an upgrade. Before resending either kind of uncertain request from an
older version, read the session and reconcile its original receipt first.
Requests expanded by the current version retain exact replay behavior. Existing
stored items and receipts remain readable and are never rewritten just by loading.

## References

- [ADR-0092: Lenient CLI filing](ADR-0092-lenient-apply-in-the-cli.md)
- [Domain and storage](../planning/low-level/DOMAIN_AND_STORAGE.md)
- [API and MCP](../planning/low-level/API_AND_MCP.md)
