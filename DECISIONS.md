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
| D20 | Prove native notification routing and both managed host protocols before UI polish | Claude multi-turn input, approvals, resume and cleanup first; native notification adapter remains the fallback |
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

## Decisions awaiting evidence, not owner preference

- Exact toolchain/package versions, macOS deployment baseline, and supported host minimum versions: record in M0 after scaffolding and smoke tests.
- Managed conversation control: prove persistent Claude input, permissions and resume first, then Codex equivalents. Pin parser fixtures to tested versions. No next-message-only fallback passes acceptance.
- Parent death, interrupted send and protocol rejection: prove owned-process cleanup and honest uncertain-delivery recovery in M0/M3. A pipe write is not agent acknowledgment.
- Notification implementation: use the plugin only if the required macOS click-routing proof passes; otherwise use a minimal native adapter.
- Real-app test harness: use the documented embedded WebdriverIO path if the M0 proof passes; otherwise use the build prompt's permitted mocked UI approach plus explicit native manual gates.

These are bounded implementation investigations. Product scope, storage location, delivery semantics, and build order are already decided.
