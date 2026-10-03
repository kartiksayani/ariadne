# Ariadne implementation roadmap

The execution catalogue is [tasks.json](../delivery/tasks.json): 44 scoped PRs
with owned paths, dependencies, exact spec sections, acceptance and planned checks.
Open [the standalone Gantt and dependency graph](roadmap.html) locally to inspect
tasks and project relative work days for one or several workers. The JSON is the
source of task definitions; its exact copy is embedded in the HTML for `file://`.

No application task is implemented or proved by this plan. The quality foundation
is already on main; it does not establish product coverage, real native E2E,
adapter integration or release acceptance. Existing Claude/Codex POCs prove
transport primitives only. Organization security guidance was not fetched under
the owner's explicit session-wide the review tool/MCP waiver; no approval is claimed.

## Fixed scope and implementation boundaries

Claude Code 2.1.287 Mods submit into the already-open original conversation.
Codex CLI/daemon 0.160.0 uses installed `codex queue` and read-only full item
history on the explicitly selected existing thread. Do not start/resume a host,
replace native queue with direct turn APIs, import private transcripts or infer
binding from tab/cwd/PID. Read-only known-metadata discovery and qualified
liveness are required in v1; manual connection remains available.

Keep the ten Rust workspace packages in [ARCHITECTURE](ARCHITECTURE.md#ownership-and-implementation-map):
domain, store, core, agent-protocol, runtime, adapter-claude, adapter-codex, cli,
mcp and desktop. Desktop, `ariadne` and `ariadne-mcp` are the three thin product
entry points. A tooling-only xtask does not add a product entry point. Core/store
and item UI contain no provider-specific branches. The shared adapter trait and
in-process fake ship now; public executable registration and third-party plugin
proof remain deferred.

Every owner message and explicit full item reply, answer snapshot, round, fork,
outcome and provenance is durable. Agent CLI/MCP `apply` is the item mutation
path; bridge transport text is bounded diagnostic activity. FIFO advances only
after both a valid committed input result and successful matching host completion,
in either order. One input is in flight per binding. Same-project bindings may
progress independently. Missing result or uncertain delivery pauses only its
binding and requires the specified reconciliation/recovery.

The supplied screens, themes, keyboard behavior, graph viewport culling,
archive/close guards, provenance-preserving continuation, tray/notifications,
local install and ordinary quit/reopen recovery are required. Public plugins,
installer journals, automated corruption repair, disk/power-crash recovery,
capacity reservations and exhaustive fault injection remain later work under
[PERSONAL_RELEASE](PERSONAL_RELEASE.md#accepted-choices).

## Execution and PR rules

The owner manually starts the orchestrator with **Astra High**. Delegated
implementation/review agents use **Sol 6.1 High** exclusively. Use isolated
worktrees for simultaneous work; preserve all unrelated edits. This roadmap is
data for that workflow and does not start an orchestrator or execute commands.

Each task is one small independently reviewed PR: prefer about 500 handwritten
changed lines, maximum 1600 including tests/config; each commit maximum 800.
Original assets, documentation and genuinely generated outputs are classified
separately with provenance, as required by [CONTRIBUTING](../../CONTRIBUTING.md).
Do not put handwritten production code in a generated/documentation exemption.
If the smallest correct diff exceeds the cap, amend the catalogue into smaller
named tasks with preserved dependencies/ownership before implementing it.

Task eligibility is calculated from actual merged prerequisite PR evidence.
There are no stored `ready` flags or manually maintained completion checkboxes.
Before selecting work, the maintainer verifies task → PR → final reviewed head,
full local hooks for every authored commit, successful checks at the exact current
pushed PR head, spec adjudication, actual merge and successful checks of the
resulting main revision. A changed head invalidates prior review
and verification. Failed, pending, merely opened or locally committed PRs do not
satisfy a dependency. The chart's offline evidence import is display only; the
harness must re-read GitHub before scheduling or merging.

Select only dependency-eligible tasks whose owned `paths` do not overlap another
running task. Ownership overlap serializes work even when dependencies allow
parallelism. Task owners may edit only their declared scope; a necessary shared
manifest/export change needs an ownership update before work starts. Shared
documentation/evidence files follow the same rule. No phase-wide barrier is
implied: domain validation, conversation history, store, assets and private
provider DTOs can branch after their concrete prerequisites. CLI and optional
MCP, independent provider modules, renderer features and native/setup work also
branch where their task dependencies and paths allow it.

## Commit checks and native E2E

The authoritative commit gate remains
`rtk proxy .venv-quality/bin/python scripts/check-commit.py --working-tree`
for local review, the installed hook for the staged commit, and the same checker
in CI. It runs all maintained-code lint/tests, functional tests and deterministic
E2E. Task `checks` add focused behavior suites to that common gate; they are
planned command contracts that the owning task implements, not commands claimed
available or passing in today's planning repository.

P0.1 records exact installed versions, chooses the concrete generator and creates
the pristine template in a fresh external staging directory. P0.2 integrates it
without overwriting curated files and activates `phase: application` before
the first production source or root Cargo manifest commit. Both fresh canonical
Rust and TS/JS LCOV reports must account for production sources, including untested
files and shipped Mod code. Weighted executable-line coverage must be at least
80%; missing tools/reports/E2E fail. Nonexecutable/type-only source treatment is
explicit and narrowly reviewed, rather than a blanket module exclusion.

Follow [the exact native macOS E2E contract](low-level/NATIVE_E2E.md#test-only-build-recipe)
using the pinned embedded WDIO plugins and the real Tauri binary. P0.2 must prove
UI element action → typed production `native_ping` invoke → Rust receipt on disk,
matching nonce and independently observed native executable/PID. A rejected
request leaves the receipt unchanged; startup and cleanup are bounded. This first
native smoke is not a domain store. P4.1 replaces it with a real core/store
operation, persisted receipt/revision and relaunch assertion. Later five-message
deterministic tests fake only the provider transport. Mocked invoke, intercepted
results, preloaded success or a detached HTTP/backend process cannot satisfy E2E.

Release packaging uses a clean production target/config and excludes test driver
dependencies, capabilities, frontend module and listener. Native feature proof
uses the packaged app on the recorded Mac. Missing GUI/toolchain/permission
prerequisites are concrete blockers, never passing skips. Live billable Claude
and Codex turns run at M7; per-commit tests remain deterministic.

## Milestones and acceptance evidence

Milestones summarize acceptance; task prerequisites govern actual scheduling.
Complete a milestone only when its tasks are merged and its evidence is saved
with command, expected/observed result, source/head, exact versions, OS/architecture,
fixture seed/hash and redacted artifact paths. Use [VERIFICATION's vocabulary](low-level/VERIFICATION.md#evidence-vocabulary)
without promoting a fixture, mocked provider or POC to live production proof.

| Milestone | Task range | Reviewable artifact and gate |
| --- | --- | --- |
| M0 | P0.1–P0.5 | Pinned staged scaffold, ten packages/three entry points, activated native/UI-to-Rust smoke and coverage gates, domain schemas/fixtures, bundled source assets, pinned private Codex wire generation. No generated drift or remote runtime assets. |
| M1 | P1.1–P1.6 | Validated domain/history, stable locked atomic snapshots, separate-process concurrency, explicit registry/generations, durable input receipts and bounded queries/counts. Invalid/stale/future data never silently overwrites history. |
| M2 | P2.1–P2.6 | Atomic explicit replies/status/topic/children/results, FIFO join, real CLI and both identical stdio MCP entry paths, bootstrap/rules and guarded history/continuation. Core owns effects; transport wrappers stay thin. |
| M3 | P3.1–P3.8 | Desktop lease/control socket, independent binding supervisors, both first-party adapters, generated-version conformance, read-only discovery/freshness, duplicate/out-of-order events and audited normal recovery/quit/reopen with a deterministic fake host. |
| M4 | P4.1–P4.8 | Working real Tauri domain slice before screen expansion, project/session navigation, Waiting/Sent, tree/reveal, full rounds/rail, all owner intents/drafts, qualified edge states and supplied-frame/theme/keyboard comparisons. |
| M5 | P5.1–P5.3 | Deterministic graph plus correct 2,000-node viewport culling and focus/selection, guarded archive/close and Continue preview/send. Target failure leaves source unchanged. |
| M6 | P6.1–P6.4 | Actual packaged window/open/tray/notification routes, permission denial behavior, owned idempotent setup and read-only doctor, locked clean install/uninstall preserving unrelated settings and history. |
| M7 | P7.1–P7.3 | Full deterministic failure suite, then five original owner messages in each supported existing host, complete explicit item replies/results and correlation/FIFO/isolation. Additional recovery scenarios are separate from the baseline five-input no-coalescing run. |
| M8 | P8.1 | Clean-checkout packaged release journey, offline history/demo/edits, both live adapters, native/install/uninstall proof, evidence ledger and user-ready README with exact source/platform and limitations. |

M7 Claude and Codex records each include busy queues, closed-item owner messages,
multi-item replies, explicit statuses/topics/children, result-before-completion,
completion-before-result, missing-result handling, app quit/relaunch, disconnect,
event replay and audited repair/resend/skip. Prove two simultaneous sessions in
one project and a third in another: input/result/reply/event cannot cross binding
or generation. Record known-metadata discovery/liveness and manual fallback,
including any observed unsupported host metadata. Do not reuse the three-turn
transport POCs as the required five-input product proof.

## Verification ownership

Every non-deferred [V01–V29](low-level/VERIFICATION.md#required-acceptance-matrix)
is mapped here to concrete tasks; V19 public plugin proof is deferred.

| Evidence rows | Owning tasks |
| --- | --- |
| V01 schema/transition; V26 generated compatibility | P0.3, P0.5, P1.1, P3.4–P3.6 |
| V02–V04 store concurrency/atomicity/registry | P1.3–P1.5, P2.5, P4.1, P7.1 |
| V05 complete conversation; V25 Waiting episodes/counts | P1.2, P1.6, P4.3, P4.5, P4.6 |
| V06 apply; V07 join; V08 FIFO; V09 isolation | P2.1, P2.2, P3.2, P7.1–P7.3 |
| V10 replay/recovery; V11 app/host lifetime; V13 missing result | P3.1, P3.2, P3.8, P4.7, P7.1–P7.3 |
| V12 explicit domain choices; V14 CLI/MCP/bootstrap; V28 thin entry points | P2.1, P2.3–P2.5, P3.4, P3.6, P6.4, P7.2, P7.3 |
| V15 full mockups/owner actions | P0.4, P4.1–P4.8; D01–D06, D08, D11, D12, D14 |
| V16 guarded history/continuation; V27 graph culling | P2.6, P5.1–P5.3; D07, D09, D10 |
| V17 Claude; V18 Codex; V20 discovery/liveness | P3.3–P3.7, P7.2, P7.3 |
| V21 native; V22 setup/install/uninstall | P6.1–P6.4, P8.1; D13 |
| V23 offline boundary; V24 full release | P8.1 |
| V29 complete gates and measured coverage | P0.2 and every subsequent application commit |

## Estimates and offline chart

`estimate_days` means estimated task effort in relative work days; it is not a
delivery promise, calendar date, cost forecast or observed benchmark. The 44
tasks currently total **55.5 serial estimate days**. The chart computes a
deterministic list schedule from the DAG, chosen worker count and conservative
owned-path overlap. It prioritizes longest remaining dependency chains and then
task ID. Lanes are worker allocations, not teams. Filtered rows do not change the
full schedule. Real task dependencies are the arrow lines; lane/path serialization
is included when marking the projected critical path and explained in details.
The dependency-only lower bound excludes worker/path contention.

This task model adapts scope/ownership/dependency/acceptance/check concepts and a
task → PR → reviewed-head evidence map. The Gantt, resource schedule and effort
estimates are newly authored projections. No corporate source content or prior
Gantt estimates are imported.

The chart has no stored execution state. Its optional local evidence file is:

```json
{
  "schema_version": 1,
  "tasks": [{
    "task_id": "P0.1",
    "pr_url": "https://github.com/kartiksayani/ariadne/pull/123",
    "state": "MERGED",
    "merged_at": "2026-10-02T00:00:00Z",
    "merged_commit": "<40-character merged SHA>",
    "head_sha": "<40-character final PR head>",
    "reviewed_head": "<same final PR head>",
    "checks_head": "<same final PR head>",
    "spec_review_head": "<same final PR head>",
    "checks_passed": true,
    "review_passed": true,
    "spec_review_passed": true
  }]
}
```

That is an illustrative shape, not merge evidence. Matching final heads, valid
merge SHA/time, merged state and passing review/check/spec fields qualify an
import for display. These fields cannot establish authenticity offline; execution
requires fresh GitHub verification and the maintainer's full per-commit/integrated
evidence ledger. No import means no claimed completed tasks. “Dependencies merged”
describes prerequisites only; it does not override running owners or approval gates.

When task definitions change, replace the `roadmap-data` JSON block with the
exact parsed catalogue and validate equality, unique IDs, references, acyclic
dependencies and spec anchors. The pure `roadmap-engine` exposes scheduling,
selection/dependency and evidence-shape helpers through `globalThis.ariadneRoadmap`;
the separate `roadmap-ui` renders accessible keyboard controls. No external
script/font/network request or local web server is needed to open the chart.

Start at **P0.1**, then follow the task dependencies and owned paths. Final release
acceptance requires every non-deferred evidence row proved on its recorded version
or explicitly blocked by a concrete external prerequisite. A blocker remains an
incomplete required gate; it is not a claim that the product is done.
