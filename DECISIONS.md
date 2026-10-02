# Current effective decisions — revision 4

The architecture and seven low-level contracts were rewritten on 2 October 2026
after the full design/architecture gap audit. The table below is current;
older numbered entries below it are historical and are superseded where they
conflict. Start implementation from [BUILD_HANDOFF](docs/planning/BUILD_HANDOFF.md).

| Decision | Choice and reason |
|---|---|
| D47 Primary runtime | Existing-session only release1: Claude Mod and Codex queue/history, both transport-proven. Managed launch/approval UI removed from required milestones. |
| D48 Domain replies | Explicit CLI/MCP apply + full per-item reply + input_result. Bridge text diagnostic only; no prose inference or duplicate final reply. |
| D49 Persistence | One project-session JSON, global binding index, provider-neutral bindings, durable attempts/results and full message/round/fork history. |
| D50 Queue completion | One active binding/session, many sessions/project; one in-flight input/binding; join successful host turn + domain result, with explicit uncertainty/recovery. |
| D51 Process ownership | App owns adapter workers/private local IPC, not host processes. Quit stops new dispatch; accepted host work and bound domain writes may continue. |
| D52 Design coverage | All30 mockup frames mapped. Rail, owner action intents, rounds, guarded archive/close and continuation copy now specified. |
| D53 Status ownership | Only agent domain operations change item status; owner answers/intents and transport events do not. Waiting/Sent derives from current question episode and input facts. |
| D54 Continuation | Previewed snapshot copy with original references, one target-file transaction; no shared mutable topic across sessions. |
| D55 Extensibility | Versioned Rust/executable JSONL adapter contract and fake third-adapter acceptance; no core provider enum. |
| D56 Presence | Optional hook/lifecycle + heartbeat/read-only state; PID supporting evidence only. Manual binding always available. |
| D57 Source of truth | Low-level docs own detailed contracts; overview docs link instead of duplicating conflicting schemas. Audited fixtures and native/live gates remain separate from planning proof. |
| D58 Integration maturity | Mod required for active same-session submission; hooks supplementary. Pin host compatibility; generate Codex wire types from the exact CLI schema and check CLI/daemon versions before dispatch. |
| D59 Storage tradeoff | Preserve required transactional JSON snapshots. JSONL alone does not provide multi-entity atomicity; SQLite is the replacement candidate only if the format requirement changes or measured gates fail. |
| D60 Thin entry points | One Cargo workspace; app, CLI and MCP binaries reuse core/store. CLI MCP alias and standalone MCP binary reuse one rmcp service. |
| D61 Large graphs | Full deterministic layout with viewport culling above 300 nodes; full bounds and off-screen focus/selection remain correct. |

## Personal-use scope correction

[PERSONAL_RELEASE](docs/planning/PERSONAL_RELEASE.md) takes precedence over the
older exhaustive release gates. The owner explicitly kept organized crates,
discovery/liveness and optimized graphs; accepted deferral of the public plugin
system, advanced installation and exotic failure recovery.

| Decision | Current choice |
|---|---|
| D62 Personal use first | Simplicity, functionality and extensibility; ordinary-use safeguards, no exhaustive recovery/scale program |
| D63 Organized code | Keep the planned crate boundaries and shared core; do not collapse them merely to reduce package count |
| D64 Easy later extensions | Common adapter interface and fake implementation now; public executable adapter installer/registry/conformance later |
| D65 Discovery and graph | Both remain first-version features; prune discovery only after discussing actual implementation complexity |
| D66 Installation and recovery | Simple local install; defer installer rollback/journals, data-repair/migration frameworks, capacity reservations and exotic failure tests |
| D67 Commit quality | Local-only Git; all maintained code linted and zero lint issues per commit, functional/E2E tests, minimum 80% weighted overall application line coverage |

Organization security guidance was not checked under the owner's existing the review tool
waiver. These are project decisions, not organization compliance claims.

---

## Historical decision log

# Ariadne decision log

Planning decisions made 2026-10-01, revised 2026-10-02 under the owner's delegated product/technical authority. Implementation status: not started. Changes require recording new evidence and the effect on the roadmap.

| ID | Decision | Reason and tradeoff |
| --- | --- | --- |
| D01 | This session completes planning only | The owner's latest instruction explicitly scopes the session; BUILD_PROMPT describes the subsequent implementation |
| D02 | Tauri 2 + React/TypeScript + Rust workspace CLI | Required stack; shared core avoids divergent validation and persistence |
| D03 | Project-local `.ariadne/` session JSON, global rebuildable project registry | Keeps agent writes within workspace boundaries; requires explicit registration/relocation instead of private transcript discovery |
| D04 | Stable sibling file lock, reread under lock, atomic same-directory replacement | Rename alone cannot prevent lost updates; all shipped writers share one protocol |
| D05 | Core domain commands, generated schema/TS DTOs, no full-snapshot UI writes | One authority for transitions; revisions reject stale semantic changes without clobbering unrelated updates |
| D06 | Session-scoped immutable hierarchical item IDs and topics | Matches prompt, simple provenance; no reparenting or cross-session shared topics in v1 |
| D07 | Durable outbox, non-destructive answer availability and explicit acknowledgment | Separate host acceptance from agent receipt. Preserve IDs on recovery; uncertain sends need reconciliation, not blind retry |
| D08 | Answer saved and agent receipt are distinct | Show an honest pending label; move the item out of waiting without claiming the agent has started work |
| D09 | Stable per-host-conversation consumer binding | Active UI tab or last-modified file must never redirect another conversation's answer |
| D10 | Superseded by D26–D28: original CLI/hook-only integration | The owner rejected waiting for another terminal message; retain the CLI and hooks for auxiliary/recovery use |
| D11 | Managed launch uses scoped resources; persistent Claude skills-directory plugin is optional external mode | Keep original plugin capability while avoiding global host-file changes for managed sessions; prove exact loading/trust behavior in M0 |
| D12 | Setup/uninstall journal owned blocks/files and preserve other edits | Meets reversible settings requirement; edited owned content is reported rather than destroyed |
| D13 | Global Waiting panel with Sent section; per-session tree/graph | Matches the detailed mockups and keeps every known unanswered item visible |
| D14 | Preserve Nocturne visual language; port reusable markup/CSS, replace prototype runtime | Export relies on CDN dependencies and fake timers; production assets must be bundled and data real |
| D15 | Explicit answer selection and Cmd+Enter in the editor | Recommendation remains visible; routine Enter navigation cannot send an unchosen answer |
| D16 | Seven statuses; explanation+done may display Explained; replacement→dropped uses two linked items | Resolves contradictory example labels without expanding the state machine |
| D17 | Managed process/protocol evidence drives liveness; external sessions show last activity | File writes alone cannot establish a running agent; live managed state comes from the runtime |
| D18 | Defer optional rail, topic sharing/handoff, archive/close-session and extra owner actions | Required release centers on reading, answering, and provenance; full discrepancies listed in DESIGN |
| D19 | Simple per-topic SVG graph; no diagram editor framework initially | Tree data has deterministic layout; overview does not need freeform authoring |
| D20 | Prove native notification routing and both managed host protocols before UI polish | Claude multi-turn input, approvals, resume and cleanup first; single native UserNotifications bridge is now the selected macOS implementation |
| D21 | macOS WebdriverIO service proof plus deterministic core/browser tests | Current docs offer embedded macOS support; test-only listener must never ship in release |
| D22 | Local `make install`, unsigned app, explicit PATH preflight | Required install experience without publishing/signing or silent shell-profile edits |
| D23 | Ariadne UI/store/MCP stays local; provider child processes use their normal network services | Offline history and answer saving; no offline inference promise. No app telemetry, updater, remote assets, direct model API, or network listener |
| D24 | No the review tool guidance fetched or checked | Owner explicitly selected “Proceed without the review tool; record that org guidance was not checked”; project security choices are not presented as organization-verified |
| D25 | Bounded whole-file sessions with clear errors and recovery | Keeps the specified JSON format predictable; no hidden database migration or silent truncation |
| D26 | Claude Code is the primary integration; Codex remains required | Explicit owner clarification; prove the primary experience on Claude before Codex |
| D27 | An app answer must reach an available agent without another terminal message | Explicit owner correction supersedes the build prompt's next-turn baseline; hook-only acceptance is insufficient |
| D28 | Managed official CLI processes plus local stdio MCP domain tools | Claude persistent stream-json and Codex app-server deliver owner input; MCP records the tree. Replaces the intermediate pending-tool/Channels proposal. See [agent runtime](docs/planning/AGENT_RUNTIME.md) |
| D29 | Rust adapters and an app-owned worker; no production SDK sidecar by default | Fits the chosen stack. Worker owns provider handles and cleanup, monitors parent death, and holds a project lease |
| D30 | Minimal Conversation panel, launch/follow-up input, approvals, Stop/Resume | Required to operate managed sessions from the app; tree/queue remain the main view. Arbitrary terminal takeover and a full IDE are deferred |
| D31 | Queue owner input while busy; dispatch automatically when idle | Consistent behavior across Claude/Codex. Explicit Stop remains respected; no active-turn steering in v1 |
| D32 | Existing official CLI authentication; no app credential collection or automatic provider installation | Provider handles login and billing. Detect configuration conflicts; make no blanket SDK/subscription-billing promise |
| D33 | One managed run per project root; independent existing worktrees may run concurrently | Avoid two managed writers in one checkout without adding worktree automation; runtime lease prevents duplicate launches |
| D34 | Each owner submission gets one FIFO host turn; no cross-submission coalescing | Makes the N-message promise precise. Separate permission/native response lane unblocks the active turn |
| D35 | Persist dispatch status separately from turn status; restrict managed fetch to eligible inputs | Host acceptance/answer receipt cannot advance the queue; fetching a future answer would violate FIFO |
| D36 | Concrete Rust modules, rmcp, Tokio pipes and versioned worker JSONL protocol | The communication mechanism is an implementation contract, not a future discovery task. See [low-level design](docs/planning/LOW_LEVEL_DESIGN.md) |
| D37 | Stable flock + keyed in-process mutex, full atomic transaction algorithm and control-capacity reserve | Specifies concurrency/crash behavior down to write/rename boundaries; record uncertain commits explicitly |
| D38 | Distinct question revision, immutable answers, strict actor-bound APIs | Unrelated activity must not invalidate an answer draft; agent tools cannot impersonate owner decisions |
| D39 | Bounded transient Conversation activity; durable owner inputs and agent-authored excerpts | No private transcript ingestion or unbounded stream history; truncation/restart behavior is visible |
| D40 | Compatibility ledger separates inspected schemas, specified design and executed proof | Corrects earlier overstatement of architectural completeness; live Claude/Codex/native gates remain pending |
| D41 | Failed inputs remain FIFO barriers until explicit retry or owner resolution | Proven pre-execution rejection can retry the original input; possibly executed work needs a reviewed resend/skip decision. Resume alone cannot silently lose failed work |

| D42 | Existing terminal session delivery is the primary workflow; managed launch alone is insufficient | Owner clarified PR-review findings → item messages → same running conversation. Channels is the documented Claude candidate, with startup opt-in and batching constraints; see [correction](docs/planning/EXISTING_SESSION_DELIVERY.md). Supersedes earlier external-manual acceptance and managed-only assumptions |

**D43 — Claude Mods is the primary existing-session inbound adapter.** The
2.1.287 live POC delivered three external inputs into the user's already-running
interactive session through `$.prompt.submit`; lifecycle hooks recorded ordered
replies, busy queuing and retained context. [Evidence](poc/claude-mods/RESULTS.md).
This supersedes D42's preference for Channels. It establishes the communication
primitive, not production recovery, tree mutation, full roadmap migration, or
Codex parity. SQLite in this POC is only a fixture; production storage decisions
are unchanged.

**D44 — Codex existing-session delivery uses the native queue CLI and read-only
daemon history.** The 0.160.0 live POC passed all eight checks: an idle existing
conversation started work, two busy submissions followed in distinct ordered
turns, context survived, and the observer retrieved full replies without
start/resume. [Evidence and limits](poc/codex-queue/RESULTS.md). Input markers in
user messages bind turns and replies to Ariadne items. Prefer the proven CLI
sender initially; direct queue API scheduling, client-ID propagation, recovery
and production persistence require further gates. This establishes transport
parity with D43, not completion of the production integrations.

**D45 — Agents are pluggable through a versioned adapter contract.** Required by
the owner: another compatible agent/CLI must be addable without changing tree
logic, storage or the item UI. First-party Rust adapters and registered local
executable adapters share capabilities, delivery/events, correlation and
reconciliation semantics. [Contract and acceptance](docs/planning/AGENT_ADAPTERS.md).

## Decisions awaiting evidence, not owner preference

**D46 — Agent-authored replies and tree decisions use domain CLI/MCP.** Owner
requires the agent to choose reply targets, statuses, new topics and children.
Bridge handles delivery/lifecycle; no automatic final-text item reply. Per-input
progress requires a committed domain result and successful host completion.
Optional passive session discovery uses adapter state/heartbeats and qualified
PID evidence; manual binding remains sufficient. See
[result and presence contract](docs/planning/AGENT_RESULTS_AND_PRESENCE.md).

- Exact toolchain/package versions, macOS deployment baseline, and supported host minimum versions: record in M0 after scaffolding and smoke tests.
- Managed conversation control: prove persistent Claude input, permissions and resume first, then Codex equivalents. Pin parser fixtures to tested versions. No next-message-only fallback passes acceptance.
- Parent death, interrupted send and protocol rejection: prove owned-process cleanup and honest uncertain-delivery recovery in M0/M3. A pipe write is not agent acknowledgment.
- Notification behavior: implement the chosen single native bridge and prove M01 packaged click/permission/cold-start paths.
- Real-app test harness: use the documented embedded WebdriverIO path if the M0 proof passes; otherwise use the build prompt's permitted mocked UI approach plus explicit native manual gates.

These are bounded implementation investigations. Product scope, storage location, delivery semantics, and build order are already decided.
