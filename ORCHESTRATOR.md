# Delivery

The owner starts the maintainer on **Astra High**; delegated implementers and
independent reviewers use **Sol 6.1 High**. Product implementation remains paused
until the owner resumes it. Do not reactivate old contexts.

Read CONTRIBUTING, BUILD_HANDOFF, PERSONAL_RELEASE and ROADMAP. Fetch origin/main,
inspect worktrees and current task PRs, and preserve unrelated edits/history.
Use fresh isolated worktrees for dependency-eligible parallel modules. Declare
bounded owned paths, goal, settled contracts, spec and acceptance. Reviewers join
when ready. Product scheduling waits for the corrected plan and owner resumption.
No automatic readiness engine or receipt workflow is required.

Use [HANDOFF](docs/delivery/HANDOFF.md) as the sole current resumption page. Replace
its one-page state at checkpoints: main SHA, open PR CI/reviews, active owners,
worktrees/branches/unpushed work, and next three steps. Link CI evidence rather than
copying logs. Historical records stay intact. Check actual GitHub state for every
open PR before scheduling.

Prioritize P3.2 → P4.1 → P4.4 with one continuing implementer and P3.3 with a
second. A stream whose declared implementation prerequisites are already merged
may progress while composition CI runs; full acceptance retains its original
dependencies. Follow [ADR-0060](docs/adr/ADR-0060-own-desktop-integration-seams.md)
for shared ownership. Remaining changes land vertically on merged main, including
real Core/native acceptance where appropriate. Do not defer wiring to another
combining PR. Prefer units one PR can finish.

The owner authorizes stacked implementation on reviewed parent code while CI runs.
Use settled contracts and disjoint ownership; keep each child diff bounded and
its merge behind its prerequisites. Independent discovery UI work may run as a
third stream. Use the existing GitHub stack support for linear dependent PRs;
do not create artificial dependencies between independent siblings. Coordinate
parent updates before workers publish, with current-head CI and delta reviews.

## Delivery feedback rules

The owner authorizes local builds, native runs, browser tests and other focused
checks whenever they are necessary and likely to save time overall. No further
confirmation is needed to make an exception to the earlier CI-only default.
Prefer existing caches, isolated fixture data and the smallest useful reproduction;
reuse the build to verify the fix. Required CI and merge acceptance still apply.
This standing authorization was confirmed on 2026-10-05.

The owner clarified the test boundary on 2026-10-05: test Ariadne-owned behavior,
not standard macOS window/menu behavior. Verify our preference persistence, route
selection, tray projection, lifecycle ordering and external-turn preservation.
Use focused unit/Core/Store integration tests and the existing native/release smoke
where it proves our wiring. Physical Pin checkmarks, Show/minimize mechanics and
repeated window/menu operations are not acceptance gates. Do not expand OS-level
automation to prove behavior delegated unchanged to Apple APIs.

- **Pre-push timing:** Measure `cargo check --workspace --all-features --locked`
  and `tsc --noEmit` on an existing warm cache, recording each duration and the
  combined time. Include a representative incremental source change so a no-op
  check does not mislead. If the combined check takes **under 90 seconds**, propose
  it to the owner as a pre-push step. Until explicitly approved, the existing rule
  remains. If no warm cache exists, report that rather than starting a cold build solely
  for this timing measurement.
  Keep one build directory per worker.
- **Process budget:** No new process or tooling PR until the same concrete
  delivery problem has occurred twice. Record both occurrences, their observed
  cost, and one sentence explaining the expected saving. Use the smallest useful
  fix. Exceptions require an explicit owner decision.
- **Affected-flow review:** Follow changed behavior from its entry point through
  validation/admission, state changes, external effects and completion/errors.
  Include unchanged code sharing relevant state, locks, ownership or ordering.
  For lifecycle/recovery/concurrency, also examine applicable cancellation,
  shutdown, retries/replay and competing operations. Check tests proving those
  invariants; deepen the relevant flow without reopening unrelated files.
- **Review after changes:** Fixes and conflict-free base updates receive an
  independent delta review against the previously reviewed head. Expand to
  affected-flow review when behavior or invariants change. Conflict resolutions
  require review of the resolved behavior and interacting upstream changes.
  Every review identifies the exact head and scope.
- **Validation and completion:** Application changes retain full required
  application CI; documentation-only changes retain appropriate lightweight
  checks. Use native acceptance for user-visible integration and deterministic
  real Core/Store tests where they better prove internal behavior. Mechanism
  subtasks may complete independently; their parent remains incomplete until its
  original acceptance passes.

Workers push coherent checkpoints and open draft PRs when ready for review; do not
trigger CI on every commit. The maintainer adjudicates and merges. List unpushed
work explicitly in the current handoff. Carry bounded delivery documentation with
ongoing product work instead of opening a separate process initiative.

Follow the [implementation order](docs/planning/BUILD_HANDOFF.md#implementation-order)
and actual task prerequisites. Foundations and contract readiness enable parallel
work; no phase-wide barrier or single-implementer restriction applies. Preserve
the provider-neutral core, atomic locked JSON, binding identity/generation,
operation deduplication and explicit result/host-completion semantics. Live host
acceptance remains M7 and needs owner approval.

Select work from actual merged prerequisite PRs and current GitHub state. A draft,
local commit or partial task does not satisfy a dependency. Reserve disjoint paths
before assigning work; overlapping ownership serializes work even when dependency
edges allow parallelism. Assign one owner for shared manifests, exports and wiring,
and settle a contract change before dependent implementation. Keep independent
work moving while a concrete access or architecture blocker is resolved.

Workers propose shared-interface changes to the maintainer with affected consumers
and tests. The maintainer adjudicates, updates the authoritative contract and
dispatches all affected implementation/test work under declared ownership. Workers
do not change shared signatures or semantics unilaterally or maintain duplicate
contract copies. Important architecture changes get a short ADR; routine compatible
contract amendments are tracked in the affected PR.

The implementer adds meaningful behavior tests, commits through the cheap hook,
runs relevant pushed-head checks and opens a reviewable PR with behavior and real
validation evidence. Routine ownership/spec updates can ride it. Important
architecture gaps go to the maintainer before dependent work and resulting
important choices get a short ADR. No mandatory ADR for routine choices.

A separate reviewer context reads the latest GitHub diff and relevant contracts,
checks acceptance/tests/coverage and unnecessary complexity, and posts readable
findings bound to the exact head. Zero findings is valid. The maintainer adjudicates
findings; the author fixes them. Use one targeted re-review. Required unresolved
issues stay unmerged. No separate patcher, JSON context proof or service-wide
pre-mortem checklist is required.

Before squash merge, the maintainer checks:
- the PR is updated against current main and its current head/base are verified;
- genuine independent review at that head and resolved required findings;
- green quality for that integrated head and acceptance evidence;
- squash merge, then monitor main's CI asynchronously.

Do not wait for each successful merge's main run before preparing or merging the
next independently reviewed, green PR integrated against current main. If main
fails, pause further merges until the failure is diagnosed and corrected.

Changed head/base requires relevant checks and current-head review. If a merge
reply is lost, read PR/main state before retrying. Only the maintainer merges.
Update task completion in tasks.json with actual PR links, then regenerate the
static chart. Preserve historical .delivery records without creating new receipts.

A tooling blocker gets one cheap attempt (about 15 minutes), then explain the cost
and cheaper route to the owner. Change harness/gates only for a demonstrated
delivery issue or repeatedly solved manual work; keep changes small and
proportionate while preserving quality. Do not grow another delivery framework.

PR #83 runs [37243524591](https://github.com/kartiksayani/ariadne/actions/runs/37243524591)
and [37246640362](https://github.com/kartiksayani/ariadne/actions/runs/37246640362)
spent 8m31s and 8m36s on reference captures before failing coverage inventory and
native checks respectively. CI now runs the required checks before reference
provisioning/captures, saving about 8m30s on such failures while requiring both
checks and all relevant captures for success.

The maintainer writes
retrospectives/docs directly and reports delivered capability, completed tasks and
concrete blockers. Use concise handoffs on interruption; reconcile them with
actual worktrees, GitHub and live contexts on resumption.

Repository rulesets and their limits are documented in CONTRIBUTING. Do not change
remote settings, remove existing worktrees/branches/history or read credentials.
MCP/the review tool remain disabled under the current-session waiver; organization guidance
was not checked.
