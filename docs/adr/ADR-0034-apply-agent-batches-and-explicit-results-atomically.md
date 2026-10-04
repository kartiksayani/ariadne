# ADR-0034: Apply ordered agent batches and explicit results atomically

Status: accepted
Supersedes: none
Superseded by: none
Implementation: P2.1

## Context

Agent batches need ordered local references, immutable full replies and explicit
results without partial publication. Host completion and a domain result can
arrive in either order; neither alone proves successful delivery.

## Decision

Native `apply::ApplyService` resolves the trusted registered project and invokes
Store's stable locked transaction. The normalized command includes all typed
params and exact text, excluding only the operation key. Store binds canonical
route and actor, replays exact receipts before mutable guards or allocations,
and validates/publishes one candidate and receipt with one session revision.
Native errors retain core, registry and ordinary store causes.

All supplied item/topic revision guards are checked against the locked original
snapshot once. Ordered operations use the staged current revisions thereafter;
new batch entities need no original guard. Existing parents whose child counters
change and items owning explicitly closed rounds require their original item
guard. Referencing an existing topic during item creation needs no mandatory
topic guard, while supplied guards are always honored.

One batch Activity records actual mutation provenance and the touched-item union.
It preserves exact nonblank summary bytes; blank summaries use a deterministic
fallback when there are changes. Blank no-op/no-result batches save only their
receipt and revision. Replies stay separate full Messages. Initial waiting items
start round 1/question revision 1; later Asks use the existing pure transition and
history helpers to create distinct immutable episodes. Local refs resolve only
earlier operations, and validation rejects the complete candidate atomically.

Fresh dispatched writes require the current native binding generation and the
attempt's originating generation to match. Exact input/attempt/binding scope is
checked under lock; historical read permission gives no write or retry authority.
Trusted grants may be narrower, never widened. Explicit result watermarks obey
source owner message <= handled <= trusted issuance <= latest persisted message.

Results commit once per attempt and use the existing history/provenance checks.
Incremental effects from that attempt may qualify; repair results may cite verified
effects of the original completed work attempt. Subsequent new operations reject
after result commit, while saved exact retries remain valid.

A small crate-private pure join is shared by apply and the future P2.2 reporter.
It seals only completed host turns with committed results and no contradictory,
uncertain, rejected, failed or interrupted evidence. Result-first stays in flight
until completion; failed delivery retains published domain data and requires
attention. A sealed join is idempotent. A retained `result_missing` warning ceases
blocking only upon that successful explicit join; its bytes/history remain.
Only the automatic ResultMissing pause clears, preserving owner pause,
disconnected/unqualified connection state and other barriers. No timer, recovery,
resend authority or alternate persistence framework is introduced.

## Consequences

Tests exercise registered temporary filesystem data, candidate rollback, saved
replay and separate-process item concurrency. Transport/CoreService composition,
formatting and durable adapter reports remain their owning tasks. No shared wire
signature or canonical schema change is needed.

MCP/the review tool remain disabled under the owner's current-session waiver. Organization
security guidance was not checked; no approval is claimed.

## Spec references

- [Agent API](../planning/low-level/API_AND_MCP.md#3-agent-api-explicit-results-and-tree-operations)
- [Domain history](../planning/low-level/DOMAIN_AND_STORAGE.md#full-messages-answers-and-rounds)
- [Save/claim/join](../planning/low-level/QUEUES_AND_RECOVERY.md#1-save-claim-join)
