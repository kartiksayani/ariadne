# Ariadne implementation roadmap

The execution catalogue is [tasks.json](../delivery/tasks.json): scoped PRs
with owned paths, dependencies, exact spec sections, acceptance and planned checks.
Open [the standalone Gantt and dependency graph](roadmap.html) locally to inspect
tasks and project relative work days for one or several workers. The JSON is the
source of task definitions; its exact copy is embedded in the HTML for `file://`.

P0.1 (#11) and P0.2 (#14) are merged: the pinned scaffold and real native
WebView smoke are implemented. Domain/provider integration and final release
acceptance remain ahead. The owner resumed contract-first three-stream delivery on
2026-10-03; follow [MODULE_CONTRACTS](MODULE_CONTRACTS.md). Existing Claude/Codex POCs prove
transport primitives only. Organization security guidance was not fetched under
the owner's explicit session-wide Seezo/MCP waiver; no approval is claimed.

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

## Dependency and contract readiness

Use [MODULE_CONTRACTS](MODULE_CONTRACTS.md) for the published producer/consumer
seams, three streams and shared-file owners. A starts original P0.3a
(domain/generator), B starts P0.5's independent private Codex wire/schema work,
and C starts original P0.4a (assets). Shared adapter DTOs wait for P0.3b. P0.6
publishes the core service contract and a small scripted test/dev double, without
adding a production package or duplicating business logic.

`depends_on` retains every original full acceptance/integration prerequisite.
Optional `implementation_depends_on` permits an earlier implementation start on
reviewed, merged contracts/components; otherwise use `depends_on`. A merged
implementation publishes only the surface its consumers need, recorded by a real
`implementation_pr_url`, and remains in progress. `completion.pr_url` requires
full original acceptance and real integration. Neither drafts nor partial work
satisfy acceptance dependencies. The maintainer checks actual GitHub state and
published scope before dispatch; chart projections are not readiness decisions.

Domain DTOs fan out to validation/history, protocol and storage. Core service and
adapter contracts fan out to runtime, CLI/MCP and UI. Published reusable renderer
service/route/selection/count components unlock their screens, graph and native
consumers; those component dependencies remain explicit. Build full modules in
parallel and connect actual boundaries when available. P4.1 completes the real
UI-to-Rust domain integration after its original acceptance prerequisites; it
is not an early walking-slice priority or a phase-wide barrier. P7.1 joins every
module and remaining integration acceptance, then unchanged live P7.2/P7.3 and
release P8.1 prove the assembled product. No arbitrary integration-duration
promise is made.

Choose disjoint owned paths; serialize shared manifests, exports, generator
registration and composition wiring under one declared owner per path. A owns
domain generation during P0.3a/b, B owns private Codex files, and generator
registration changes are handed to A. Workers propose shared signature/semantic
changes to the maintainer before dependent work. The maintainer adjudicates,
updates the authoritative contract and dispatches all affected producer,
consumer and test changes. No worker-local contract copies. Important
architecture choices get short ADRs; compatible routine amendments go in the PR.

Scripted doubles return canonical fixture responses/events only. Native
acceptance always uses actual core/store; all original meaningful tests,
coverage, native and release checks remain required. Live five-input host proof
remains M7 with owner approval; POCs and module fixtures are not product proof.

## Execution and PR rules

Use Sol 6.1 High implementers in isolated worktrees for eligible parallel modules,
with Astra High maintaining. A separate reviewer joins when ready and reviews the
latest GitHub diff at its exact head. The author fixes findings; one targeted
re-review follows. Required unresolved issues remain unmerged.
Routine ownership/spec updates can ride product PRs; important choices get short ADRs.
No numeric caps, machine receipts or mandatory separate patcher.
See [ORCHESTRATOR](../../ORCHESTRATOR.md).

## Commit checks and native E2E

The hook runs cheap changed-language format/lint/type checks. CI on each pushed
head selects docs, tooling or application checks from the whole branch diff;
unknown paths and missing base run full checks. Application changes keep all
meaningful tests, >=80% weighted coverage including untested logic and real native
WebView smoke. Release-sensitive changes and milestones prove packaged release
isolation. See [Development checks](DEVELOPMENT_CHECKS.md).
The scaffold smoke proves UI/invoke/Rust/disk and actual PID cleanup; the first
domain slice replaces it with persisted domain behavior. Tests fake only providers.
Live final Claude/Codex acceptance remains M7 with owner approval.

Project/session navigation includes an explicit new-versus-existing Ariadne
session choice. A fresh Claude conversation may attach to registered Session X
in its selected project while retaining topics, items and history, including
unfinished work. P4.2 owns the visible selection and canonical binding request;
the P3.3/backend follow-up must prove structured historical owner-context access
through the locked connection snapshot, isolation of later unissued inputs and
unchanged rebind guards. This does not transfer host transcript/memory or resume
dispatch. Completion requires that handoff proof, beyond the early reusable UI.

## Milestones and acceptance evidence

Milestones summarize acceptance; task prerequisites govern actual scheduling.
Complete a milestone only when its tasks are merged and its evidence is saved
with command, expected/observed result, source/head, exact versions, OS/architecture,
fixture seed/hash and redacted artifact paths. Use [VERIFICATION's vocabulary](low-level/VERIFICATION.md#evidence-vocabulary)
without promoting a fixture, mocked provider or POC to live production proof.

| Milestone | Task range | Reviewable artifact and gate |
| --- | --- | --- |
| M0 | P0.1–P0.6 | Pinned staged scaffold, ten packages/three entry points, activated native/UI-to-Rust smoke and coverage gates, domain schemas/fixtures, bundled source assets, pinned private Codex wire generation, core service/semantic fixture publication. No generated drift or remote runtime assets. |
| M1 | P1.1–P1.6 | Validated domain/history, stable locked atomic snapshots, separate-process concurrency, explicit registry/generations, durable input receipts and bounded queries/counts. Invalid/stale/future data never silently overwrites history. |
| M2 | P2.1–P2.6 | Atomic explicit replies/status/topic/children/results, FIFO join, real CLI and both identical stdio MCP entry paths, bootstrap/rules and guarded history/continuation. Core owns effects; transport wrappers stay thin. |
| M3 | P3.1–P3.8 | Desktop lease/control socket, independent binding supervisors, both first-party adapters, generated-version conformance, read-only discovery/freshness, duplicate/out-of-order events and audited normal recovery/quit/reopen with a deterministic fake host. |
| M4 | P4.1–P4.8 | Real Tauri domain integration and independently implemented screens, project/session navigation, Waiting/Sent, tree/reveal, full rounds/rail, all owner intents/drafts, qualified edge states and supplied-frame/theme/keyboard comparisons. |
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
| V29 complete gates and measured coverage | P0.2 and subsequent application CI |

## Estimates and offline chart

`tasks.json` is the single source for definitions, estimates and maintainer-updated
`completion.pr_url` and optional `implementation_pr_url` metadata. Completion
means full acceptance; an implementation merge remains in progress. Estimates are relative work days, not delivery
promises. The static Gantt projects full acceptance joins and owned-path constraints; the
dependency graph can show implementation prerequisites separately. It does not
predict a contract-first delivery date. The pre-plan baseline was 48 tasks /
56.5 effort days, with a three-worker full-plan projection of 29 work days
(64.9% utilization); remaining work was 54 effort days / 26.5 projected days.
These describe the original graph, not delivery promises or forecasts for the
new parallel plan.
After an actual merge, update completion with its real PR link and run:

```sh
python3 scripts/regenerate-roadmap.py
```

The embedded data supports `file://` with useful Gantt/dependency views and no
server, polling, credentials or live export. Completion metadata is a maintainer
record; check GitHub before scheduling/merging. The old receipt import is retired.
Final release still requires every non-deferred verification row proved on its
recorded version or explicitly blocked by a concrete external prerequisite.
