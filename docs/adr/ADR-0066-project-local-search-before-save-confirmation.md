# ADR-0066: Project local search before save confirmation

Status: Accepted
Date: 2026-10-05

Partially superseded by [ADR-0068](ADR-0068-performance-budgets-are-recorded-not-gating.md): the "retain the 150 ms p95 limit" clause is no longer a gate.

## Context

The native 2,000-item journey records search p95 of 208 ms locally and 198 ms in
CI, above the 150 ms target. Local result-to-frame p95 is 11 ms; most elapsed time
precedes row publication. The current tree projects only saved preferences, so
every search waits for its durable receipt after the required 100 ms debounce.
These measurements do not attribute the remaining time to a particular backend
phase. Rendering local search does not itself require a disk acknowledgement.

## Decision

Keep a transient, route-scoped search projection. Project typed search on the
next normal renderer update. Debounce only its durable preference write by 100 ms,
using the unchanged revision-checked preferences writer. Only search is overlaid. Keep
canonical revisions, other filters, selection, expansion and Later authoritative.

Distinguish pending or unconfirmed persistence from confirmed preferences. A
failed or uncertain save may retain the visible preview, but must not retry an
attempted operation automatically or replace its operation identity. Preserve
newer unsubmitted text across unrelated confirmed writes. Route changes, reopen
and explicit reset discard the preview; restoration reads canonical preferences.

## Verification

Hold a save unresolved: rows reflect typed search before 100 ms, no preference
write is submitted before 100 ms, and canonical preferences remain unchanged. Cover confirmation, rejection, uncertain
completion, explicit reconciliation, route reset and absence of automatic resend.
Retain the original native inputs, all 20 samples and 150 ms p95 limit. Local projection alone is not proof that the complete native journey passes.

## Same-day refinement after renderer-only measurement

PR #94 [run 37346055843](https://github.com/kartiksayani/ariadne/actions/runs/37346055843) measured search p95 of 193 ms after local projection was
implemented. The 20 renderer-only samples exclude test-driver latency; 18 took
108–126 ms, with 213 ms and 193 ms outliers. Input-to-row publication dominated; the
final frame took 3 ms and 7 ms in the outliers. The 100 ms preview delay consumes most
of the 150 ms interaction budget even though the durable write is now independent.
Remove that intentional preview delay and retain 100 ms coalescing for disk writes.
The existing canonical-state, cancellation and recovery rules remain unchanged.
This is an implementation refinement; native measurement must still prove the
unchanged responsiveness target.
