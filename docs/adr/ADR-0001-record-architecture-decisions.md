# ADR-0001: Record architecture decisions with the affected implementation

Status: deprecated
Supersedes: none
Superseded by: [ADR-0018](ADR-0018-recalibrate-delivery.md)

## Context

The LLD leaves implementation gaps. The owner requires workers to ask the
orchestrator and preserve every resulting architecture decision with the code.
Chat-only answers lose the decision rationale; a separate global decision ledger
would add synchronization and shared ownership to the existing delivery workflow.

## Decision

Implementers, reviewers and patchers send architecture questions to the
orchestrator with context, options and recommendation, then wait on dependent
work. The orchestrator decides and allocates a stable ADR ID. Commit a short
Markdown ADR in the affected implementation PR, including decisions that resolve
ambiguity by choosing an existing interpretation. Routine choices within settled
contracts remain worker autonomy.

Declare exact changed ADR paths and any existing task-referenced Markdown spec
updates in the PR description, receipt and final independent review. Spec updates
require a new accepted ADR explaining them. Update affected canonical contracts
in the same PR.
A future ADR may overrule an older ADR: preserve the older prose, mark it deprecated
and add reciprocal links in that PR. Owner scope and quality constraints remain
binding. The maintainer directly checks that the human PR description matches
the exact ADR/spec declarations. The helper validates the machine-readable receipt
and final review against actual changed files and committed ADR contents;
maintenance PRs receive the same declarations and direct maintainer history/spec
review.

## Consequences

Decisions reach main with their implementation and remain auditable after later
replacement or squash merges. Exact document reservations preserve parallel work
without granting broad ownership. The current planning gate checks the ADR
collection. The maintainer still judges architecture, consistency, independent review and
additional path conflicts. No new service, CLI, database or decision ledger is needed.

## Spec references

- [Architecture question and ADR contract](README.md)
- [Worker assignment and review](../../ORCHESTRATOR.md#one-delivery-loop)
- [Delivery evidence](../delivery/README.md#maintainer-record)
- [Implementation authority](../planning/BUILD_HANDOFF.md#start-here)
