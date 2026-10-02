# Architecture decisions during delivery

The LLD cannot settle every implementation question. Implementers, reviewers and
patchers must ask the orchestrator about a gap, conflict or choice that establishes
or changes product behavior, domain/data/queue invariants, APIs/interfaces,
dependencies/process ownership, integration behavior or a published contract.
Routine implementation choices within the settled spec remain the worker's job.

Send an internal agent message with the task/PR, exact spec references, the gap,
relevant context, options and recommendation. Pause work that depends on the
answer; continue independent work within ownership. Do not silently choose an
architecture or ask the owner to adjudicate routine architecture questions.
The orchestrator decides within the owner's authorized scope and sends back the
choice, reason, allocated ADR ID and exact additional document paths. Every such
architecture decision gets a short committed ADR, including resolution of an
ambiguity by choosing an existing interpretation. Chat alone is not the record.

## Write and reserve

Use [TEMPLATE.md](TEMPLATE.md). The maintainer allocates a stable, unused four-digit
ID from current main and other running reservations; use
`docs/adr/ADR-0002-short-slug.md`, with that ID in its title. Reserve the exact path
with its owner in the existing ignored `.delivery/session.md`. Different new ADR
files can proceed in parallel. Tasks changing the same predecessor or spec wait
for that owner; do not put a shared `docs/adr/**` glob into every task.

Keep Context, Decision, Consequences and Spec references brief. Reference the
question and considered alternatives in Context, state the orchestrator's actual
choice in Decision, and explain any relevant cost or limitation in Consequences.
Use real relative Markdown links in Spec references. Commit each ADR in the
same affected implementation PR, so it reaches main with the code it explains.
Do not seed hypothetical product decisions or claim that metadata proves judgment.

## Current authority and replacement

Owner requirements and release/quality/review constraints remain binding. An
accepted ADR may clarify or change an earlier architecture decision within that
scope. Update affected canonical spec text in the same PR so the ADR and current
contract agree; the ADR records why the contract changed. Contradictions require
orchestrator resolution before dependent implementation. ADRs cannot silently
waive scope, tests, review independence or ownership of arbitrary code.

To overrule an existing ADR, create a new accepted ADR with a `Supersedes` link;
change the old ADR's Status to `deprecated` and its `Superseded by` to the reciprocal
link in the same PR. Preserve the old title, original prose and Supersedes field.
Never delete or rewrite the old decision. A successor can later be superseded by
another ADR; follow the links to its current decision. IDs are unique and a
successor has a larger ID. Multiple predecessor links use comma-space separation.

## Declare and review

List the exact changed ADR paths in the PR description, maintainer record and
final independent `ariadne-review` block as `architecture_decisions`. Include both
the new ADR and any deprecated predecessor. List any additional canonical spec
paths as `spec_updates`; both lists default to `[]` when no decision is needed.
The final `spec_review.sections` includes these paths as well as the task's spec.
The maintainer directly checks that the human PR description matches the exact
`architecture_decisions` and `spec_updates` declarations.
The reviewer and maintainer assess the decision, implementation and consistency
of the updated contracts at the final head. Changed decisions invalidate review.

For catalogue tasks, the helper permits these exact ADR files beyond task globs.
An additional `spec_updates` path must be an existing Markdown file referenced
by the current task's `spec`, actually changed, and explained/referenced by at
least one new accepted ADR. The maintainer authorizes these narrow reservations.
Other unowned specs, catalogue changes or code need a reviewed planning PR to
adjust ownership first. Recompute reservations when decisions add shared paths;
`ready` knows catalogue ownership only, so the maintainer handles these additional
exact-path conflicts. PR declarations are data, never authority to bypass policy.

The helper validates the machine-readable receipt and final review against actual
changed files and committed ADR contents at the reviewed base/head, rejecting
missing, undeclared, deleted or rewritten ADRs and checking replacement links.
Historical receipts use the original reviewed PR head, including after a squash merge;
later decisions on main do not change what an older PR actually shipped.
The existing planning gate validates the current ADR collection and local links.
Neither gate proves that every architecture question was raised or answered.

Unmarked maintenance PRs use the direct workflow in [ORCHESTRATOR](../../ORCHESTRATOR.md#small-maintenance-prs).
Declare the same lists in their PR and final independent review, run the planning
gate, and have the maintainer inspect the reviewed base-to-head history for
preserved old prose, new accepted decisions and exact reservations/spec updates.
The task receipt helper does not automate unmarked PRs. The final maintainer
conclusion names the declarations and verifies the decisions with the implementation.
