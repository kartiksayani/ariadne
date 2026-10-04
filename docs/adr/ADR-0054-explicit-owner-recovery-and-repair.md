# ADR-0054: Explicit owner recovery and result-only repair

Status: Accepted

## Decision

Implement native Core/Store recovery against the published InputResolve,
resolution history and operation receipts. Store replay precedes mutable revision,
state and liveness guards. Optional trusted RecoveryObservation binds current
binding/generation and adapter instance to provider-qualified presence; it is not
wire data or persisted authority. Only properly qualified Fresh Connected Idle
proves idle, ProcessHint never does, and Fresh Running/WaitingForApproval blocks
all resolutions. Unknown/stale/historical observations require current-request
owner idle attestation, recorded as owner evidence rather than machine fact.
Ordinary Core composition defaults to Unknown. No host wait occurs under locks.

Retry requires proven pre-execution rejection. Explicit resend may repeat work.
Retry/Resend preserve the replaced attempt purpose: Work remains Work, while a
ResultRepair remains result-only and retains its original Completed Work linkage.
Prepare/retry/resend/repair and Skip retain the immutable input/sequence/history,
seal the replaced attempt, clear active IDs and persist owner pause. They allocate
no new attempt and never send. Resume is separate; later claim uses the retained
preparation decision. Repair prompts identify original completed work and retained
effect references rather than replaying its action text. Every repeated repair
points directly to the original actually Completed Work; selected replacement
repair must also be machine-observed Completed for RequestResultRepair.

ConfirmEvidence records attributed audit, never changes stored host turn facts or
fabricates a result/Handled. For a sealed historical input, allow an append-only
resolution_history acknowledgement while preserving all existing state/payload,
Attempt/result/message/effect bytes. Scan typed EventConflict receipts and matching
owner resolution/receipt scope and revision; no extra index. Acknowledgements cover
only conflicts through the guarded snapshot. Clear Uncertain only when every
attributable conflict is acknowledged and no other unresolved attempt/cause remains.
Unscoped/unmatched conflicts and unrelated recovery causes remain blocked. Clearing
requires owner pause and a later Resume; exact replay cannot clear newer conflicts.
This narrow owner-only append differs from the host reporter's immutable sealed
Input/Attempt behavior, which remains unchanged.

## Consequences

Merged P2.2/P2.3/P0.6 permit Core recovery implementation independently of native
supervisor composition. Full P3.8 still requires its original P3.2, audited CLI and
real composition acceptance. No automatic resend, provider control, corruption/
full-disk recovery, journal, new persistent structure or CoreService signature is
introduced. Complete receipts/effects remain retained without TTL or pruning.
