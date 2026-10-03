# How the Ariadne delivery harness works

The harness is the working arrangement for building Ariadne: a live maintainer
session delegates bounded tasks, separate agents implement and review them, and
repository tools check the evidence before merging. The maintainer makes the
decisions. The Python helper makes repeatable checks; it does not start agents
or keep work running after the maintainer session ends.

The production app has not been built. The repository contains its implementation
baseline, original designs, delivery plan and tested quality tools. Implementation
can uncover gaps in that baseline; reviewed architecture decision records (ADRs)
preserve the resulting decisions rather than assuming the specifications are complete.

Explore the [Gantt](../planning/roadmap.html) and
[dependency graph](../planning/roadmap.html) in the same interactive chart, or
step through the [communication simulation](../planning/communication-explorer.html).
These standalone HTML files run locally in a browser. GitHub shows their source;
download them or open them from a checkout to interact. The simulation explains
the intended app flow and includes links to archived transport evidence. It does
not connect to a live agent or prove production integration is finished.

## Who does what

| Role | Responsibility |
| --- | --- |
| Owner | Starts the maintainer on **Astra, High effort**, sets the product scope, and answers questions requiring owner decisions or access. |
| Maintainer / orchestrator | Chooses eligible tasks, assigns ownership, reads the specification, adjudicates findings and architecture decisions, verifies the final change, and merges serially. |
| Implementer | Uses **Sol 6.1, High effort** in an isolated worktree to implement one bounded task, add meaningful tests, run the hook and open a PR. It never merges. |
| Independent reviewer | Uses **Sol 6.1, High effort** in a separate context that has never authored or patched this PR. Reads the latest GitHub diff and posts findings for the exact commit reviewed. |
| Separate patcher | Uses **Sol 6.1, High effort** to fix accepted findings within the assigned paths and update regression tests. The reviewer verifies the resulting commit. |

At most three worker contexts run at once, leaving a slot for the maintainer.
Each assignment declares its task, owned paths, dependency and specification
references, acceptance conditions, checks, branch and worktree. Separate
worktrees keep agents' working files apart; path ownership also prevents them
from making competing changes to the same part of the repository.

## One task from assignment to main

1. **Select and reserve.** The maintainer reads current GitHub evidence and the
   task catalogue. A task is eligible when its prerequisites have genuinely
   merged and its paths do not conflict with active owners. Reserve one task,
   then recompute eligibility before assigning another.
2. **Implement.** The implementer starts from current `origin/main`, works within
   the task's paths and specification, and commits through the installed hook.
   Its PR explains the behavior, task/spec references, tests, coverage and limits.
   Draft PRs remain drafts until the required behavior and checks exist.
3. **Review independently.** A separate reviewer reads the current GitHub diff,
   checks acceptance and evidence, and posts a GitHub COMMENT review bound to
   the actual head commit. The review contains readable findings and a compact
   structured record. A clean review can have zero findings.
4. **Decide and patch.** The maintainer gives every finding a disposition:
   **fixed**, **deferred**, or **rejected**, with a reason and spec reference.
   Accepted fixes go to a separate patcher; the independent reviewer then verifies
   the new head. Required behavior and failing checks cannot be deferred to get
   a merge. There are at most three review rounds; unresolved required work stays
   unmerged after the third. Reopening a PR does not erase that history.
5. **Check the final specification and commit.** The maintainer reads the final
   diff against the task's acceptance conditions, checks all dispositions and
   decision records, and confirms real tests and coverage. The reviewed commit
   must include current main. A changed head or base requires refreshed checks
   and review rather than reusing stale evidence.
6. **Squash and confirm.** After verification, the maintainer publishes its
   conclusion and requests a squash merge for the exact reviewed head. It then
   confirms the merged state and main's CI before merging another PR. A failed
   main check pauses further merges while a reviewed corrective PR is prepared.

Small maintenance PRs, such as fixes to this harness, follow the same independent
review, quality and exact-head merge rules. They do not complete a product task
unless they are actually assigned one in the catalogue.

The full operational instructions are in [ORCHESTRATOR.md](../../ORCHESTRATOR.md);
record formats and commands are in the [delivery helper guide](README.md).

## Architecture decisions discovered during implementation

The current owner scope and specifications are the starting authority. Workers
choose ordinary implementation details within settled contracts. Implementers,
reviewers and patchers send architecture questions to the orchestrator with the
task/PR, exact spec references, context, options and a recommendation. They pause
only work that depends on the answer and continue independent work within their
ownership. The orchestrator decides within its authority; owner questions are
needed when the decision requires authority or access it does not have.

Every resulting architecture decision gets a short committed ADR in the affected
implementation PR, including decisions that resolve ambiguity by choosing an
existing interpretation. The orchestrator allocates its ID and reserves the exact
additional paths. [docs/adr/README.md](../adr/README.md) defines the format and rules.
An accepted ADR can clarify or change an earlier architecture choice within owner
scope; affected canonical specs change in the same PR. To replace an older ADR,
create a new accepted ADR, mark the earlier one deprecated, preserve its original
prose and add reciprocal supersession links. This keeps the current contract and
the reason for its evolution discoverable.

The PR, delivery record and final independent review declare exact changed ADR
paths as `architecture_decisions`, including deprecated predecessors. Additional
canonical spec changes go in `spec_updates`: existing Markdown files referenced
by the task's `spec`, actually changed and explained/referenced by a new accepted
ADR. Both lists default to empty. The maintainer reserves these paths against
other owners; catalogue readiness alone does not detect these added conflicts.
Other ownership changes need a reviewed planning PR first.

The final independent reviewer acknowledges these declarations; the maintainer
directly checks that the human PR description matches them and checks decisions,
implementation and updated contracts together. The helper validates the machine
receipt and final review against actual changed files and committed ADR content
at the reviewed base/head, including preserved prose and reciprocal links.
Historical receipts use the original reviewed PR
head after a squash merge. Metadata cannot prove that workers asked every needed
question, or authorize expanding scope or weakening quality rules. Unmarked
maintenance PRs use the same declarations and direct maintainer history review.

## What is enforced, and where

| Layer | What it does |
| --- | --- |
| Installed commit hook | Requires the staged tree to match the tested files; runs size checks, lint, tests, coverage and planning validation. It does not stash changes or skip checks. |
| GitHub Actions | Runs one complete suite on each pushed branch head, including post-squash main; newer pushes cancel older runs on that branch. Checks the whole feature-branch authored commit/PR range and each main squash commit. |
| Delivery helper | Reads fresh GitHub state, task dependencies, owned paths, review heads, dispositions, required checks and delivery records. Before merging it rechecks head/base and requests an exact-head squash merge. |
| Maintainer and reviewer | Judge behavior, specification fidelity, real review independence, valid deferrals and decision quality. JSON fields cannot prove that this judgment happened. |

The agreed size limits are **1600 changed handwritten lines per authored commit**
and **3200 per PR**, with roughly 500 preferred for easy review. Main's integrated
squash commits use the 3200-line PR cap. Tests and configuration count; documents,
original assets and generated lockfiles are accounted for separately. That
exemption is not permission to place application code in documentation.

All maintained code must pass its applicable lint checks with zero violations or
warnings. Quality helpers have a separate measured **80% line coverage** gate.
Application coverage is currently **N/A**, because no application source exists.
The first application/Cargo commit must activate the actual application gates,
including at least 80% combined executable Rust and JS/TS coverage, untested files,
and deterministic end-to-end tests. Live Claude/Codex tests run at integration
milestones. Planning simulations and transport proofs do not replace those tests.

**Main is not protected by server-enforced branch protection.** GitHub rejected
the protection request with HTTP 403 on this private repository's current plan.
Squash-only repository settings, hooks, CI and the maintainer workflow are active,
but an account with write access can bypass the workflow. The prepared protection
payload is retained for an owner-approved plan upgrade; details are in
[CONTRIBUTING.md](../../CONTRIBUTING.md#github-enforcement).

## The five helper commands

Run `scripts/delivery.py` using the configured quality Python environment from
the maintainer's clean checkout of current main. It uses Git and the authenticated
`gh` CLI; there is no delivery daemon or model runtime inside it.

| Command | Purpose |
| --- | --- |
| `ready` | Find tasks whose prerequisites have valid merged evidence and whose paths do not conflict with running work. Include locally reserved task IDs with `--running`. |
| `brief TASK` | Show a catalogue task's scope, paths, spec references, acceptance and planned checks. |
| `verify PR --record FILE` | Validate an open task PR and its maintainer record without posting or merging. |
| `merge PR --record FILE` | Revalidate, publish the durable record/status, request the exact-head squash merge and check merged evidence. |
| `export` | Produce merged-task evidence that can be imported into the interactive chart. |

The [helper guide](README.md#commands) has copyable commands and setup details.
The helper deliberately rejects maintenance PRs without a task marker; the
maintainer performs their equivalent checks directly under the documented workflow.

Three kinds of information have different jobs:

- **Catalogue:** [tasks.json](tasks.json) defines planned work, dependencies,
  ownership, specifications, acceptance and checks. It does not prove completion.
- **GitHub:** actual merged PRs and their exact-commit reviews, tests and
  maintainer decisions provide durable delivery evidence. Local checkboxes do
  not unlock dependencies.
- **Local notes and diagrams:** ignored `.delivery/` records/session notes help
  prepare evidence and resume work. Exported JSON and chart imports visualize
  evidence; they are disposable copies, not authority to mark a task complete.

## What the files on main are for

The files are grouped by their job so readers can find the current contract
without studying the entire tree.

| Group | Main files | Why they are maintained here |
| --- | --- | --- |
| Entry points and rules | [README](../../README.md), [AGENTS](../../AGENTS.md), [CONTRIBUTING](../../CONTRIBUTING.md), [ORCHESTRATOR](../../ORCHESTRATOR.md) | Orient readers and define agent roles, setup, quality gates and the delivery loop. |
| Product inputs and scope | [BUILD_PROMPT](../../BUILD_PROMPT.md), [DESIGN_PROMPT](../../DESIGN_PROMPT.md), [DECISIONS](../../DECISIONS.md), [PERSONAL_RELEASE](../planning/PERSONAL_RELEASE.md) | Preserve original requirements alongside current personal release choices, which supersede older exhaustive input requirements. |
| Implementation contracts | [Planning index](../planning/README.md), [BUILD_HANDOFF](../planning/BUILD_HANDOFF.md), product/architecture/design documents, adapter/integration contracts and [low-level specs](../planning/LOW_LEVEL_DESIGN.md) | Give implementers and reviewers the same current baseline for behavior, processes, storage, APIs, UI and verification. |
| Architecture decisions | [ADR guide](../adr/README.md), [template](../adr/TEMPLATE.md), individual ADR files | Preserve reviewed choices and supersession when implementation clarifies or changes the baseline. |
| Original design evidence | [Mockup ZIP](<../../designs/Ariadne UI mockups.zip>), [design traceability](../planning/DESIGN_TRACEABILITY.md), [asset manifest](../planning/assets/design-manifest.json), reference images | Keep source designs and their provenance available for fidelity checks instead of relying on an agent's interpretation. |
| Delivery plan and visual explanations | [tasks.json](tasks.json), [ROADMAP](../planning/ROADMAP.md), [roadmap.html](../planning/roadmap.html), [communication-explorer.html](../planning/communication-explorer.html), [helper guide](README.md) | Define bounded work and show dependencies, scheduling estimates and communication scenarios. The chart's embedded catalogue is validated against the JSON source. |
| Quality configuration | [quality-gates.json](../../quality-gates.json), [.githooks/pre-commit](../../.githooks/pre-commit), [.github/workflows/quality.yml](../../.github/workflows/quality.yml), [protection payload](../../.github/main-protection.json), CODEOWNERS, PR template, Python/Node lint and dependency files | Make local and CI checks repeatable, pin tools and preserve the intended enforcement settings. |
| Executable helpers | [delivery.py](../../scripts/delivery.py), [delivery_core.py](../../scripts/delivery_core.py), [delivery_adrs.py](../../scripts/delivery_adrs.py), [check-commit.py](../../scripts/check-commit.py), [check-change.py](../../scripts/check-change.py), planning/roadmap validators | Implement GitHub evidence checks, dependency/ownership rules, ADR validation, quality and size gates, and design/chart validation. |
| Helper tests | [tests](../../tests/) | Exercise the delivery rules and failure cases, size/coverage enforcement, temporary Git repositories, CLI processes and planning lint. These are tests of the tools, not app coverage. |

Main keeps the current build inputs and the tools that enforce them. Older
planning drafts, provider research and transport proof-of-concept code remain on
`reference/planning-and-pocs` and in the
[immutable archive at a5e306f](https://github.com/kartiksayani/ariadne/tree/a5e306f).
Current contracts link useful historical evidence. Keeping that history available
preserves the reasoning and experiments without presenting old POCs as maintained
production code or making them part of each application's test gate.

To begin delivery, follow the [maintainer startup guide](README.md#start-the-maintainer),
then read the [build handoff](../planning/BUILD_HANDOFF.md) and the exact task specs.
Build/install commands for the application will be documented when it exists.
