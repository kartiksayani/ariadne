# Verification and implementation evidence

This ledger distinguishes transport evidence from product behavior. The
existing-session transports have passed bounded live proofs: Claude Mods on
Claude Code **2.1.287** and the native queue/history adapter on Codex **0.160.0**.
Neither transport proof establishes Ariadne's store, CLI/MCP, result join, UI,
recovery, or release packaging acceptance. Production implementation and qualified
merge evidence are recorded in the [task catalogue](../../delivery/tasks.json);
current delivery state is in the [handoff](../../delivery/HANDOFF.md).

Organization security guidance was not checked under the owner's explicit
waiver. This ledger records project evidence only.

## Evidence vocabulary

| Label | Meaning |
| --- | --- |
| `specified` | Required behavior and pass condition are written in the authoritative design. |
| `mocked` | Exercised against a deterministic fake host/store/UI. This does not prove a live adapter or packaged macOS behavior. |
| `proved primitive` | A bounded live POC establishes only the named host transport behavior. |
| `implemented pending` | Production code exists; required automated/live gate has not passed. |
| `proved on <version>` | The named executable gate passed on that exact host/toolchain/OS version, with evidence recorded. |
| `blocked: <reason>` | A concrete external prerequisite prevents that gate. State the missing tool, permission, or service and the affected test. This is not an architecture placeholder. |

Never promote evidence from one label to another by inference. Record command,
version, OS/architecture, fixture or harmless input, expected result, observed
result, redacted evidence path, and any resolution. Do not put secrets or full
private host transcripts in evidence files.

## Existing evidence

| Subject | Evidence | Establishes | Does not establish |
| --- | --- | --- | --- |
| Claude Mods transport | [POC results](https://github.com/kartiksayani/ariadne/blob/a5e306f/poc/claude-mods/RESULTS.md), Claude Code 2.1.287 | Three external inputs reached an already-running interactive Claude session; busy ordering, retained context and lifecycle replies were observed | Production bridge, durable queue, Ariadne domain results, recovery, installation, or Claude versions outside 2.1.287 |
| Codex native queue/history | [POC results](https://github.com/kartiksayani/ariadne/blob/a5e306f/poc/codex-queue/RESULTS.md), Codex 0.160.0 | Eight checks passed for idle/busy ordered delivery, retained context, and full reply retrieval without start/resume | Production adapter contract, durable Ariadne queue/results, crash recovery, direct queue API, or Codex versions outside 0.160.0 |
| Basic Claude stream transport | [Recorded exchange](https://github.com/kartiksayani/ariadne/blob/a5e306f/docs/planning/evidence/CLAUDE_STREAM_SMOKE.md), Claude Code 2.1.287 | A separate same-process, two-turn transport smoke test | The primary Mods path or any product acceptance row |
| Design and protocol documents | Current low-level specifications and adapter POCs | Specified contracts and observed protocol facts as labelled above | Implemented application behavior |

Keep redacted protocol fixtures with provenance in the repository: source host
version, capture/generation command, date, and SHA-256. Do not depend on an
ephemeral planning directory. Live runs use the installed Claude Code and Codex
versions and record them in the evidence
([ADR-0069](../../adr/ADR-0069-release-evidence-is-proportionate.md)); the
fixtures above were captured on Claude 2.1.287 and Codex 0.160.0.

## Required acceptance matrix

Rows below define the required acceptance; source implementation alone does not
prove them. Consult the task catalogue's completion evidence and exact qualifying
CI/native/live records before marking a row proved.
Rows marked **deferred** are explicitly outside this personal release and do
not block acceptance. Row owners and implementation stages are in the
[roadmap](../ROADMAP.md).

| ID | Scenario | Required pass evidence | Stage |
| --- | --- | --- | --- |
| V01 | Schema, IDs, transitions and bounded content | Generated Rust/JSON Schema/TypeScript agree; valid fixture loads; invalid refs, cycles, illegal status transitions, oversize text and future schema are rejected without writes | M0–M1 |
| V02 | Concurrent app and CLI/MCP writes | Separate processes write different items without lost updates; same stale item revision conflicts; counters and operation receipts remain unique | M1 |
| V03 | Ordinary atomic storage behavior | Concurrent writers serialize through the stable lock; ordinary write/retry and stale-revision conflict behavior is correct; a replacement failure does not silently report success | M1 |
| V04 | Project registry and binding | Register/locate known roots, reject duplicate project identity, rebuild the small index, and keep bindings explicit, versioned, generation-bound and isolated | M1–M2 |
| V05 | Item conversation history | Owner message and full agent replies persist by target item with provenance, including a message to a closed item; private provider transcript is absent; cursor paging returns every stored entry | M1–M4 |
| V06 | Idempotent domain batch | Two child additions, topic creation, explicit replies/status edits and `input_result` commit atomically; same op retry returns same refs; changed payload under same op ID fails | M2 |
| V07 | Input result/completion join | Test result-before-completion and completion-before-result; both seal exactly once only after successful turn plus valid result; result missing pauses; failed/interrupted turn preserves explicit updates and pauses; terminal text never creates a duplicate item reply | M2–M3 |
| V08 | Five-message FIFO per binding | Five owner inputs create five distinct host turns in order with no coalescing; each result joins its matching attempt; input 2 does not start until input 1 completes and publishes a result | M3, M7 |
| V09 | Same-project parallel bindings | Two bound sessions in one project progress concurrently, each at most one in-flight input; no answer, result, event or reply crosses binding ID/generation | M1–M3, M7 |
| V10 | Adapter event replay and day-to-day recovery | Duplicate events deduplicate; checkpoint advances only after durable effects; app quit/relaunch, ordinary host disconnect and malformed input retain queued/accepted state; no blind replay | M3, M7 |
| V11 | App lifecycle with external host | App alive dispatches through private local socket; app quit starts no new dispatch and does not stop the already-running host; CLI/MCP can still read/write; relaunch reconciles before sending | M3, M7 |
| V12 | Agent domain choices | On both first-party adapters, the agent explicitly chooses reply targets, statuses, topic/children and input result through the shared domain API; bridge lifecycle alone causes no item change | M2–M3, M7 |
| V13 | Missing result recovery | Successful host turn without result visibly marks `result_missing`, pauses only its binding, preserves terminal output as bounded diagnostic, and offers audited inspect/repair/resend/skip; no automatic prose inference | M2–M4, M7 |
| V14 | CLI/MCP contract and bootstrap | Text/JSON/error/exit contracts are stable; bootstrap registers and binds an existing host conversation without launching it; repeat is idempotent; stale, conflicting and unknown binding errors give corrective hints | M2 |
| V15 | Full mockup and owner actions | Screens cover required mockup inventory; five rounds, multi-item replies, closed-item messages, answer/revise and reopen/drop request intents, drafts, filters, Later preference, rail, themes, accessibility, keyboard and live updates pass; capture reference comparisons. Reopen/drop enqueue intents and never directly change agent-controlled item status. | M4 |
| V16 | Graph and guarded session actions | Graph/tree selection agree; archive rejects active topic items or unresolved topic inputs; session close rejects active items, unresolved inputs, or enabled dispatch bindings; history remains readable; topic continue previews then atomically copies provenance and queues one handoff to an existing bound session, leaving source unchanged | M5 |
| V17 | Claude first-party adapter | Live scratch session on the installed Claude Code version (recorded in the evidence) completes five ordered inputs with explicit domain results/replies, busy queuing, app disconnect/reconcile, missing-result handling and binding isolation | M3, M7 |
| V18 | Codex first-party adapter | Live scratch session on the installed Codex version (recorded in the evidence) completes the same five-input/result/recovery/isolation path through native queue CLI and read-only history | M3, M7 |
| V19 | Third executable adapter (**deferred**) | Public plugin registration and a third executable adapter are outside this personal release; keep the internal adapter seam provider-neutral and document how a future adapter fits | Deferred |
| V20 | Known-metadata discovery and liveness | Implement bounded read-only discovery/liveness from known host metadata where available; report unsupported metadata as a limitation; manual binding works; PID alone never proves a conversation is live | M3, M7 |
| V21 | Native macOS app | Short manual checklist of Ariadne-owned behaviour on the recorded OS: a notification click opens the right item; the tray count matches Waiting; a second launch routes to the running app; quitting keeps external sessions running. macOS mechanics (permission dialogs, monitors, minimise, pin checkmarks) are not automated or gated | M6 |
| V22 | Simple setup, install and uninstall | Setup repeat is a no-op; packaged local install succeeds; uninstall removes only owned artifacts and preserves unrelated config and project history | M6, M8 |
| V23 | Offline and release boundary | History/demo/message browsing and owner edits work offline; no host transcript, provider credential, telemetry, updater, remote assets or Ariadne TCP/HTTP listener ships (private Unix IPC is required) | M8 |
| V24 | Full release journey | Clean checkout installs on the recorded Mac; acceptance flow works for Claude and Codex; every non-deferred row has evidence or a concrete external blocker; README instructions match packaged app | M8 |
| V25 | Waiting episode and counts | An unanswered waiting episode contributes once to Waiting; after answer it appears in Sent and not Waiting while status remains waiting; a new agent ask increments the episode and returns it to Waiting; corrections and unrelated replies do not corrupt counts | M1, M4 |
| V26 | Provider compatibility and generated wire DTOs | Vendored schemas for the installed host version (recorded in the evidence) and regenerated Rust have no drift; recorded payloads decode; unknown variants, CLI/daemon version mismatch and replaced binaries disable dispatch without losing saved inputs | M0, M3 |
| V27 | SVG viewport culling | On a large fixture (render timing recorded as evidence, not a pass condition), off-screen elements are culled, crossing edges remain visible, focus/selection survive pan/zoom and Fit uses full layout bounds; graph/tree counts and selection agree | M5 |
| V28 | Thin entry points | Desktop, CLI and standalone MCP share core/store; standalone MCP and CLI alias expose identical tools and outcomes; diagnostics stay off MCP stdout; simple install provides all entry points | M2, M6 |
| V29 | Quality gate | Release evidence is one link to a passing required CI run on main (maintained-code lint and test checks, functional and E2E checks, at least 80% overall coverage). Absent tooling/results fail closed. Live/billable host runs are reserved for M7. | Release |

## Cross-cutting failure fixtures

Implement focused deterministic fixtures for ordinary user-visible failure
paths:

- partial UTF-8/JSON frame boundaries, malformed or over-limit messages,
  unknown protocol version, duplicate event ID with same/different body, and
  out-of-order sequence;
- host accepted input but no completion, completion with no result, result
  before completion, completion before result, and exact operation retry after
  a lost response;
- ordinary validation/size-limit failures and a stale revision conflict;
- two in-process and two separate-process writers, same-item conflict,
  cross-binding recipient/result attack, stale binding generation and host ID
  reuse;
- answered waiting item versus a new waiting episode; item still waiting does
  not remain counted in Waiting while its current episode has an answer;
- session close with active item, unresolved input, enabled binding, and valid
  all-terminal/paused state; only the last case closes;
- quit/relaunch with queued inputs, live external host, known-metadata
  discovery unavailable, manual binding fallback, and no adapter PID evidence.

Do not add exhaustive machine-crash, full-disk, arbitrary-corruption,
transaction-boundary kill, or lost-data recovery matrices to this release.

The fixture must assert persistent state and public UI/API result, not only
adapter logs. Real host tests cover only semantics that fakes cannot establish.
Use disposable projects and test configuration; never use the owner's active
agent settings or project history.

## Milestone artifacts

| Stage | Evidence to save |
| --- | --- |
| M0 | Platform/toolchain ledger, lockfiles, mockup/asset manifest, schema/protocol fixture provenance, clean scaffold build |
| M1 | Generated schema and type parity, canonical session fixture, ordinary store/race logs, registry/binding fixtures |
| M2 | CLI help/error examples, machine-readable envelopes, MCP stdio traces, reply/result schema and retry fixtures, bootstrap transcript |
| M3 | Adapter compatibility table, Claude/Codex event fixtures, fake-adapter tests, five-input queue/join/recovery logs |
| M4–M5 | Mockup reference captures, UI/domain acceptance results, graph and archive/continue fixtures |
| M6 | Packaged native checklist, simple install/uninstall manifest and unrelated-setting preservation evidence |
| M7 | Redacted live Claude/Codex acceptance evidence, discovery/liveness behavior or limitations, day-to-day recovery and isolation results |
| M8 | Final platform ledger, clean install record, link to a passing required CI run on main, README review, local source revision and [release matrix](../evidence/release/MATRIX.md) with one evidence kind (test / CI run / live run / manual check) per row |

The implementation is complete only when every non-deferred row is `proved on
<version>` (or has a concrete documented environment blocker), not merely
`specified`, `mocked`, or `proved primitive`. Deferred rows do not block this
personal release.

## Native test mechanism

Execute [the native E2E contract](NATIVE_E2E.md) from the first application commit.
It specifies the macOS driver and real invoke/receipt checks; its documented recipe
is not execution evidence. Record actual results when the application is built.
