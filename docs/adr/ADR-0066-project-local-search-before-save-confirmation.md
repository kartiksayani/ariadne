# ADR-0066: Project local search before save confirmation

Status: Accepted
Date: 2026-10-05

## Context

The native 2,000-item journey records search p95 of 208 ms locally and 198 ms in
CI, above the 150 ms target. Local result-to-frame p95 is 11 ms; most elapsed time
precedes row publication. The current tree projects only saved preferences, so
every search waits for its durable receipt after the required 100 ms debounce.
These measurements do not attribute the remaining time to a particular backend
phase. Rendering local search does not itself require a disk acknowledgement.

## Decision

Keep a transient, route-scoped debounced search projection. At 100 ms, project
that search text over the latest canonical view while saving it through the
unchanged revision-checked preferences writer. Only search is overlaid. Keep
canonical revisions, other filters, selection, expansion and Later authoritative.

Distinguish pending or unconfirmed persistence from confirmed preferences. A
failed or uncertain save may retain the visible preview, but must not retry an
attempted operation automatically or replace its operation identity. Preserve
newer unsubmitted text across unrelated confirmed writes. Route changes, reopen
and explicit reset discard the preview; restoration reads canonical preferences.

## Verification

Hold a save unresolved: rows stay unchanged at 99 ms, change at 100 ms, and
canonical preferences remain unchanged. Cover confirmation, rejection, uncertain
completion, explicit reconciliation, route reset and absence of automatic resend.
Retain the original native inputs, all 20 samples, 100 ms debounce and 150 ms p95
limit. Local projection alone is not proof that the complete native journey passes.
