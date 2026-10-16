# Delivery

The maintainer is Claude Code on **Opus 5.5**. It plans, sets the contracts
between pieces of work, integrates them and talks to the owner. Implementers are
Claude sub-agents working as a team. Owner ruling, 2026-10-16: the team model
below replaces Codex implementers. Codex is used only when the owner asks for it.
Independent review uses a separate **Opus 5.5** context at the exact head, with one
targeted re-review after fixes.

### Team mode

- **Model by risk.** **Opus 5.5 (high effort)** takes anything critical or large:
  delivery and send-once, drafts and typed text, storage and saved formats,
  concurrency and locks, scroll and focus side effects, and shell refactors that
  others build on. **Sonnet 5.5 (high effort)** takes well-specified, bounded
  pieces: a component built to a drawn state, a test rewrite, harness tooling.
  **Haiku 5.5** takes mechanical work: renames, deleting dead code, records,
  release-notes formatting.
- **Plan first.** No implementer starts before the owner approves a written plan.
- **Break the work down.** Split each feature into mini and micro features that can
  run in parallel, each with declared, disjoint owned paths. Before launch, the
  maintainer writes the contracts between them: slot names, context and hook
  signatures, intent names, and CSS variables.
- **Team size.** Run 6–7 implementers at once, grouped into teams by feature.
- **Team communication.**
  - After launch, the maintainer sends every team member the agent IDs of its
    teammates.
  - Teammates message each other directly (SendMessage) about a shared contract.
    They copy the maintainer on any change to it.
  - A teammate asks the maintainer before changing a decision in the plan.
  - Messages to a running agent are cheap. Message a finished agent only when its
    context is worth the replay cost.
- **Local first, and one full run at a time.**
  - Implementers have no sandbox limits. They run targeted tests while working,
    and the full local gate set before handing back.
  - Full suites run one at a time, behind `/tmp/ariadne-gates.lock`. Machine load
    above about 30 makes timeout flakes, so concurrent full runs waste time.
  - A failure is rerun alone, on a quiet machine, before anyone judges it.
- **Integration.** The maintainer, or a designated integrator, merges a feature's
  pieces in contract order. It runs the full gate set once on the combined head,
  then pushes, so CI runs once per head.

Before UI implementation, the maintainer shares a clickable HTML mock under
`designs/mocks/` and gets owner sign-off. Implementation follows the approved mock.

Owner ruling, 2026-10-06: run the local native journey
(`env -u NODE_USE_ENV_PROXY node scripts/run-native-e2e.mjs`, about 8 minutes) and
the relevant local checks first, fix everything, then push once so CI (35–55
minutes) runs once per head.

Read CONTRIBUTING, BUILD_HANDOFF, PERSONAL_RELEASE and ROADMAP. Fetch origin/main,
inspect worktrees and current task PRs, and preserve unrelated edits/history.
Use fresh isolated worktrees for dependency-eligible parallel modules. Declare
bounded owned paths, goal, settled contracts, spec and acceptance. Reviewers join
when ready. No automatic readiness engine or receipt workflow is required.

Use [HANDOFF](docs/delivery/HANDOFF.md) as the sole current resumption page. Replace
its one-page state at checkpoints: main SHA, open PR CI/reviews, active owners,
worktrees/branches/unpushed work, and next three steps. Link CI evidence rather than
copying logs. Historical records stay intact. Check actual GitHub state for every
open PR before scheduling.

Schedule dependency-eligible modules with settled contracts and disjoint ownership.
Follow [ADR-0060](docs/adr/ADR-0060-own-desktop-integration-seams.md) for shared seams.
Land vertical changes with real Core/native acceptance where appropriate; do not
defer wiring to a combining PR. Prefer units one PR can finish.

The owner authorizes stacked implementation on reviewed parent code while CI runs.
Keep child diffs bounded and independently reviewed, merge prerequisites first,
and run required CI on each integrated head. Coordinate parent updates before
publishing; review conflicts and interacting upstream changes. Stack order does
not create a product dependency or restrict independent implementation.

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

The owner ruled on 2026-10-06 that latency budgets are not acceptance gates for a
personal-use app. Tree search stays (DESIGN_PROMPT asks for `/` to search), but the
PRODUCT.md performance targets (search p95, save p95, first usable view) are
guidance only; do not spend delivery time chasing them. If a native timing
assertion fails again, remove that assertion rather than changing product code.

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
- **Fix the class, not the finding:** When review finds a defect in storage,
  recovery, concurrency or error handling, the next brief lists the unit's full
  failure table before code changes. The table crosses every error source (parse,
  validation, revision mismatch, I/O, sync, publish, unsupported OS call) with every
  operation (read, save, retry, restart, previous-release read), and gives the
  owner-visible outcome for each pair. The author implements the whole table with one
  test per row. The reviewer checks the table for missing rows as well as the diff.
  A third fix round in one area stops for a re-brief from the table. Recorded
  2026-10-14: the recovery companion needed three rounds, because each fix moved the
  failure to a neighbouring path. Owner decision 2026-10-14.
- **Pin before moving:** Before extracting, moving or sharing UI or state code, add
  tests that pin the current behaviour of every control it touches: open, close,
  Cancel, Esc, keys, disabled states and saved drafts. They pass before and after
  the move. Recorded 2026-10-14: extracting the item conversation silently stopped
  Cancel from closing the Drop box. Owner decision 2026-10-14.
- **Previous-release reads:** A change to any saved format keeps a test that the
  previous release's reader accepts the new output. Otherwise the PR states the
  one-way step and the owner approves it. Recorded 2026-10-14: dropping a preference
  field would have stopped alpha.14 reading ui.json; review caught it only by reading. Owner decision 2026-10-14.
- **CI parity:** Tests find build outputs through `CARGO_TARGET_DIR`, which CI sets,
  or `CARGO_BIN_EXE_*`, never a hard-coded `target/debug`. Recorded once,
  2026-10-14. A check-script guard waits for a second occurrence, per the process
  budget.
- **Flakes:** When a required check fails on code that already passed it, rerun it
  once. If the rerun passes, record the test, the failed assertion and the suspected
  race under "Known flakes" in [HANDOFF](docs/delivery/HANDOFF.md). A second
  occurrence of the same flake is fixed, in the test or in the race, before the next
  merge. Native journeys never race agent-side changes: they wait for the canonical
  state the next step depends on. Owner decision 2026-10-14.
- **UI side effects:** scroll, focus and anything else that moves the view state get
  one invariant over every trigger: which owner actions may cause it, and that a
  request never outlives its commit. Test it as a table (starting states × non-owner
  events) before fixing. Recorded 2026-10-15: three review rounds on #162 each found
  a scroll or fold regression introduced by the previous fix. Owner decision
  2026-10-15 (generalize harness learnings).
- **Visual work:** layout and visual changes go to a browser-capable worker that runs
  the design suite and reads the screenshots. The implementer's sandbox cannot launch
  a browser, so it writes layout blind. Recorded 2026-10-15: #160 took 5 rounds.
  Owner decision 2026-10-15 (generalize harness learnings).
- **Native parity:** native end-to-end steps assert parity with the app's own state,
  never guessed text. Recorded 2026-10-15: #160's native steps failed 3 times on
  guessed text. Owner decision 2026-10-15 (generalize harness learnings).
- **Validation and completion:** Application changes retain full required
  application CI; documentation-only changes retain appropriate lightweight
  checks. Use native acceptance for user-visible integration and deterministic
  real Core/Store tests where they better prove internal behavior. Mechanism
  subtasks may complete independently; their parent remains incomplete until its
  original acceptance passes.

The maintainer commits and pushes coherent checkpoints and opens draft PRs when
ready for review; do not trigger CI on every commit. The maintainer adjudicates
and merges. List unpushed work explicitly in the current handoff.
Carry bounded delivery documentation with
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

The implementer adds meaningful behavior tests and runs the sandbox-compatible
checks. The maintainer runs the remaining local checks, commits through the cheap
hook and opens a reviewable PR with behavior and real validation evidence.
Routine ownership/spec updates can ride it. Important architecture gaps go to
the maintainer before dependent work and resulting
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
- `gh pr merge --squash --match-head-commit <head>`, then verify main's tree matches
  the PR head (`git diff --quiet <head> origin/main`) and monitor main's CI asynchronously.

Do not wait for each successful merge's main run before preparing or merging the
next independently reviewed, green PR integrated against current main. If main
fails, pause further merges until the failure is diagnosed and corrected.

Changed head/base requires relevant checks and current-head review. If a merge
reply is lost, read PR/main state before retrying. Only the maintainer merges.
After merge, tag `v0.1.0-alpha.N` with `-m "Ariadne v0.1.0-alpha.N"`, wait for the
release workflow, then edit the release notes. Every release includes the fixed
[How to upgrade block](docs/planning/PERSONAL_RELEASE.md#release-notes).
Refresh HANDOFF, tasks.json (actual PR links) and the roadmap chart.
Preserve historical .delivery records without creating new receipts.

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
