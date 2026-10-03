# ADR-0014: Check only the pushed branch head in CI

Status: accepted
Supersedes: none
Superseded by: none

## Context

CI repeated the full application suite for every authored PR commit and again
for the integration tree. Native builds and release-boundary proofs made this
cost grow with the commit count, despite mandatory full local commit hooks and
squash-only merges. The owner requested one execution for each newly pushed
branch head, with newer pushes cancelling older executions on that branch,
rather than replaying historical commits or changing the quality gates.

## Decision

Use one push trigger for all branches, excluding tags, with no duplicate PR
trigger. Run the complete suite once on the exact pushed head from the default
checkout, including main after a squash merge. Group concurrency by branch ref
and cancel the previous execution when a newer push arrives. Preserve pinned
tools, read-only workflow permissions, failure propagation, coverage/native
evidence archival and the always-run artifact upload. CI does not require RTK.

Every authored local commit still runs the installed full hook. Change-policy
checks compare origin/main to non-main pushed heads to enforce every authored
commit and the complete PR range, rather than only the latest push delta. Main
pushes compare the event's preceding SHA and enforce each squash commit.
Coverage floors, lint/type checks, real tests, native E2E, clean production
boundary proof and independent final-head review remain required.

## Consequences

A branch push pays for one full suite rather than its historical commit count
plus one. PRs require their latest head to be green; intermediate commits retain
local hook evidence and size checks. The post-squash main push remains a separate
verification, and its failure blocks subsequent merges. Tag pushes do not run
this workflow. No historical ADR is
superseded: the existing decisions did not require the commit-replay loop.

## Spec references

- [Contribution rules](../../CONTRIBUTING.md#six-rules)
- [Development checks](../planning/DEVELOPMENT_CHECKS.md#current-state)
- [Harness enforcement](../delivery/HARNESS_OVERVIEW.md#what-is-enforced-and-where)
- [Scheduling prerequisites](../planning/ROADMAP.md#execution-and-pr-rules)
