# ADR-0019: Restore dependency-led parallel module delivery

Status: accepted
Supersedes: [ADR-0018](ADR-0018-recalibrate-delivery.md) (product sequencing only)
Superseded by: none

## Context

The owner's recalibration removed delivery overhead. It did not authorize a
cross-roadmap first walking slice, deferring required foundation contracts or
restricting product implementation to one engineer. The owner corrected that
interpretation on 2026-10-03 and requested contract-ready parallel module work.

## Decision

Restore the pre-PR22 foundation and dependency intent while keeping current
product scope and acceptance. Settle shared contracts before dependent consumers,
schedule eligible work with disjoint ownership, and integrate the real domain
slice at P4.1 after its prerequisites. Milestones are acceptance summaries rather
than phase-wide scheduling barriers. Product implementation remains paused until
the corrected plan is reviewed and the owner resumes it. Preserve paused drafts;
the cross-roadmap first-working-slice draft is not the active implementation plan.
This correction leaves the task catalogue unchanged. A separate reviewed module
plan may reorganize scheduling through explicit contract-ready dependencies while
preserving actual prerequisites and all original product acceptance.

Only ADR-0018's product-sequencing paragraph is superseded. Its cheap hooks,
scoped pushed-head CI, meaningful tests, >=80% weighted application coverage,
native smoke/release isolation, independent exact-head review, author fixes,
squash/main checks, static catalogue and removal of delivery machinery remain
accepted. Maintenance follow-ups on main also remain intact. No readiness engine,
machine receipts, numeric caps, full native commit hooks or new delivery framework
are reintroduced. Live host product acceptance remains M7 with owner approval.

## Consequences

Parallel work follows actual prerequisites and settled contracts with one owner
for each shared manifest/export/wiring change. Drafts and partial tasks never
count as dependency completion. The maintainer schedules and serializes merges;
independent reviewers assess the current head. This corrects execution strategy
without changing product scope or weakening quality.

## Spec references

- [Build handoff](../planning/BUILD_HANDOFF.md#implementation-order)
- [Roadmap](../planning/ROADMAP.md#dependency-and-contract-readiness)
- [Delivery](../../ORCHESTRATOR.md)
- [Personal release](../planning/PERSONAL_RELEASE.md#implementation-sequencing)
