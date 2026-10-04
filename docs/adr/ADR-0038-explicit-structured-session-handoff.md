# ADR-0038: Explicitly hand off structured session context

Status: accepted; partially superseded for new saved instruction construction
Supersedes: none
Superseded by: [ADR-0046](ADR-0046-explicit-owner-cli-and-saved-routing-instructions.md), only for new saved instruction construction; existing saved bytes and handoff authority remain unchanged

## Context

A fresh host conversation can explicitly connect an existing Ariadne session,
preserving its topics, items, rounds, answers and history. A new binding's zero
issued watermark otherwise hides retained owner context from canonical agent
queries. Host memory or transcript transfer cannot supply that authority.

## Decision

The maintainer approved explicit owner rebind as a second context issuer. Under
the existing session transaction, after active-state, old paused/disconnected
binding and all pending-input guards, a new binding captures the maximum persisted
owner-message number, including copied history, or0 if none, in the existing
`issued_through_message_number`. There is no new field, queue action or claim.
Same-host reconnect preserves its ceiling; default new empty sessions start at0.
Exact saved-operation replay precedes the callback and cannot widen the original
snapshot. Future genuine claims may advance issuance normally.

Canonical query and apply checks remain authoritative. Terminal reads use a
trusted current-binding grant no larger than persisted issuance; dispatched reads
and results retain the source-input ceiling and originating attempt generation.
The handoff grants no old-binding mutation/dispatch authority, does not clear a
barrier, and hides owner context appended after the captured ceiling.

The supported Claude SDK command argument string implements
`/ariadne-connect [session-id]`. Only one canonical UUID selects an existing
session; no argument keeps ordinary behavior. The Mod uses canonical owner
bootstrap `session:null` with `existing_session_id`, retains exact operation body,
target and ID after uncertainty, and verifies the receipt's session ID against the
explicit target. Its project is the validated registration ID already used in
that request, not an invented receipt field. Existing serialized owner transitions,
quiescence and late-evidence checks apply unchanged.

The canonical `setup_instruction` bytes stay unchanged. Only SDK human `{text}`
adds guidance tied to the validated project/session tuple: read structured topics,
items, questions, answers and results; summarize completed/remaining/missing
context; reuse items and respect cancelled work. The shared rule separates that
read context from an actual dispatched input. No host transcript/memory transfer,
session inference, automatic prompt, history copy or pruning is introduced.

## Consequences

Real filesystem binding/query regressions cover populated and copied history,
future-hidden bodies, exact replay, unchanged same-host issuance and old mutation/
attempt rejection. Mod tests use the actual source with SDK/helper transport
fixtures for selection, target retention, mismatched receipts and human guidance.
No dependency, wire DTO, schema or alternate business state is added. Actual owner
CLI, durable Core composition and trusted Claude qualification remain their
existing integration joins; this feature does not fabricate their success.
