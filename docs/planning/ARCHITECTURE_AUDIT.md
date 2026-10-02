# Architecture and LLD gap audit

**First-release scope:** [Personal release decisions](PERSONAL_RELEASE.md) and
[commit quality checks](DEVELOPMENT_CHECKS.md) govern what ships now. Public
plugin installation and exotic-failure recovery are deferred; organized crates,
discovery/liveness and optimized graphs remain required.

2 October 2026 · revision3. This is a design audit, not a claim that the app or
its production integrations passed tests. The original ZIP was inspected by
source, its two saved rendered references were visually reviewed, and all30
board frames are mapped. Source checksums cover all16 archive members.

## Gaps closed in the specifications

| Previously missing or contradictory | Concrete resolution | Implementation authority |
|---|---|---|
| Existing session vs app-owned launch | Claude Mod / Codex queue + same-daemon history are the release paths; no managed-launch gate | PROCESS_AND_PROTOCOLS |
| How initial agent findings get into Ariadne | Connect returns binding/instruction snippet; agent invokes domain CLI or configured MCP | API_AND_MCP §4, SETUP_AND_DELIVERY |
| Which of several sessions a tool call targets | Explicit binding+generation on every call; registry host tuple and no cwd/current-session guess | DOMAIN_AND_STORAGE, API_AND_MCP |
| Future agents | Provider-neutral types plus versioned executable JSONL adapter and conformance suite | AGENT_ADAPTERS |
| Agent replies vs terminal text | Full explicitly targeted domain replies; terminal text diagnostic only | API_AND_MCP §3 |
| Five messages and completion ordering | Persist per-input/attempt; one in flight; join domain result and successful turn in either order | QUEUES_AND_RECOVERY |
| Turn finished but no result | Grace, missing-result state, FIFO barrier, explicit repair-only turn or skip | QUEUES_AND_RECOVERY |
| Retry and duplicate execution | Durable operation receipts; provider send uncertainty is never automatic resend | DOMAIN_AND_STORAGE, QUEUES_AND_RECOVERY |
| Hooks and session liveness | Mod lifecycle and optional traditional hooks, heartbeat/read-only freshness; PID not sufficient | PROCESS_AND_PROTOCOLS §5 |
| App quit vs external host ownership | No new dispatch; external work continues; core CLI writes allowed, reconcile on reopen | ARCHITECTURE, QUEUES_AND_RECOVERY |
| Full conversations | Full Message bodies, immutable corrections, item target/provenance; no excerpt-only storage | DOMAIN_AND_STORAGE |
| Mockup Back-and-forth rounds | Explicit rounds, ask/option snapshots, owner/agent messages, result and fork IDs | DOMAIN_AND_STORAGE, UI_AND_NATIVE |
| Owner action controls | Bring/reply/note/follow-up/reopen/drop are input intents; Later is local; agent changes status | PRODUCT, DESIGN_TRACEABILITY |
| Waiting/Sent counts vs status | Episode-based unanswered predicate and independent input-derived labels/count projections | API_AND_MCP, UI_AND_NATIVE |
| Archive/close disappearance | Terminal/no-unresolved-input guards; close also requires pause; blockers shown | DOMAIN_AND_STORAGE, UI_AND_NATIVE |
| Continue/shared topics vs one-file JSON | Previewed provenance snapshot copy, remapped IDs, atomic target commit, unchanged source | DOMAIN_AND_STORAGE §6 |
| Concurrent writes and crash boundaries | Stable cross-process locks, reread, digest, validate, fsync, backup, rename, uncertain commit | DOMAIN_AND_STORAGE §4 |
| Binding bootstrap multi-file writes | Registry-scoped idempotent journal and staged repair; explicit lock order | DOMAIN_AND_STORAGE, SETUP_AND_DELIVERY |
| Capacity and large full replies | Enforced byte/entity limits, reserved result/control budget, no truncation or pruning | DOMAIN_AND_STORAGE §5 |
| Graph implementation | Deterministic SVG tree geometry, replacement arcs, pan/zoom/reveal and accessible tree alternative | UI_AND_NATIVE |
| Every designed screen/control |30-frame mapping, component map, actual tokens and state tests | DESIGN, DESIGN_TRACEABILITY |
| Setup/install/uninstall | Stable versioned helper/resources, exact owned config blocks/journal, explicit reload, safe reversal | SETUP_AND_DELIVERY |
| Native routing and notification lifecycle | Single native notification delegate, ID-only routes, common reveal, warm/cold tests | UI_AND_NATIVE |
| Test architecture | Rust core/store integration, fixture adapters, renderer tests, packaged native and live gates | VERIFICATION |
| Starting the build | Fixed module layout, ordered artifacts, safe staging/scaffold and lockfile steps | BUILD_HANDOFF, ROADMAP |
| New integration APIs | Exact host/daemon compatibility gate; Codex schema-to-Rust generation/drift recipe; Mod retained for active submission, hooks for observation | PROCESS_AND_PROTOCOLS §6 |
| JSON vs JSONL vs SQLite | Transactional snapshots preserve required format; no second authoritative append log; SQLite replacement criterion stated | DOMAIN_AND_STORAGE |
| Shared executable boundaries | Cargo workspace with thin app/CLI/MCP; one MCP library implements binary and CLI alias | ARCHITECTURE, SETUP_AND_DELIVERY |
| Large SVG rendering | Deterministic full layout with indexed viewport culling and preserved selection/full-bounds Fit | UI_AND_NATIVE, VERIFICATION V27 |

## Deliberate differences from the design prototype

- Existing-session bridges replace transcript scraping, AppleScript input and
  next-user-message answer pickup.
- No preselected answer; Cmd+Enter submits deliberately. Full option + explanation
  are preserved. System theme is the initial preference.
- Archive/close cannot hide unresolved work; controls show guard blockers.
- Continue makes a visible snapshot copy instead of a shared mutable topic.
- Discovery is optional and reports evidence; never pretend every terminal is found.
- No Ariadne tool-approval UI or managed-host launch in this release.

The [design contract](DESIGN.md) records the complete visual/behavior mapping.
These are explicit implementation choices, not blank controls or silent omissions.

## Remaining execution gates — not hidden design questions

| Gate | What is specified | Evidence still required |
|---|---|---|
| Production agent result loop | Concrete apply/reply/result schema and FIFO join | Both real agents handle five inputs, create topics/children and publish full replies |
| Host lifecycle failures | Explicit uncertainty and recovery policy | Reload/disconnect/interruption, mixed terminal inputs, app restart; avoid duplicates |
| Rust host wire implementation | Mod JS port, WS Unix library, exact queue/history requests | Run protocol fixtures and same live primitives through production code |
| Data durability | Lock/write/backup/replay algorithm + failure points | Concurrent writers, process kill around commit, full disk/capacity and repair fixtures |
| Native behavior | Chosen objc2 UserNotifications delegate and route design | Packaged permission, click, hidden window and cold-launch behavior |
| UI fidelity | Actual dimensions/assets +30-frame tests | Rendered implementation screenshots, keyboard/contrast and large-fixture measurements |
| Reproducible packaging | Fixed stack, mechanical exact-version lock, install journal | Build/install/uninstall on target macOS; no network/runtime test listener in release |
| Third adapter | Manifest/method/event/capability contract | Fake executable works without changing core/storage/UI |

There is no production build to test yet. Remaining compiler, OS and provider
compatibility failures must be diagnosed during implementation; planning cannot
honestly certify them in advance. Those gates have selected mechanisms and pass/
fail behavior, so the builder need not choose an architecture while writing code.

## Review method and validation

Separate audits covered design grounding, runtime/protocol/recovery, and domain/
API/storage/handoff. Follow-up consistency checks caught and fixed result-repair
provenance, claim replay, app-off write eligibility, binding cardinality, count
predicates, continuation origins and session-close guards. Overview pages were
rewritten rather than layering further contradictory amendment banners.
The final pass also corrected premature removal from Sent, added explicit attempt
correlation and both owner/agent messages to the explorer, and aligned roadmap
topic archive vs session close terminology.

The planning validation script checks local links, design member checksums/frame
coverage, JSON examples and the four interactive simulation scenarios. It does
not claim native rendering or production tests. See `evidence/planning-validation.json`.
Organization security guidance was not checked under the owner's the review tool waiver.
