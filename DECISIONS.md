# Ariadne decision log

Planning decisions made 2026-10-01 under the owner's delegated product/technical authority. Implementation status: not started. Changes to these decisions require recording the new evidence and effect on the roadmap, not silently changing a contract.

| ID | Decision | Reason and tradeoff |
| --- | --- | --- |
| D01 | This session completes planning only | The owner's latest instruction explicitly scopes the session; BUILD_PROMPT describes the subsequent implementation |
| D02 | Tauri 2 + React/TypeScript + Rust workspace CLI | Required stack; shared core avoids divergent validation and persistence |
| D03 | Project-local `.ariadne/` session JSON, global rebuildable project registry | Keeps agent writes within workspace boundaries; requires explicit registration/relocation instead of private transcript discovery |
| D04 | Stable sibling file lock, reread under lock, atomic same-directory replacement | Rename alone cannot prevent lost updates; all shipped writers share one protocol |
| D05 | Core domain commands, generated schema/TS DTOs, no full-snapshot UI writes | One authority for transitions; revisions reject stale semantic changes without clobbering unrelated updates |
| D06 | Session-scoped immutable hierarchical item IDs and topics | Matches prompt, simple provenance; no reparenting or cross-session shared topics in v1 |
| D07 | At-least-once answer delivery with explicit acknowledgment | A destructive fetch can lose an answer if a hook dies before context delivery; IDs/receipts make retries safe |
| D08 | Answer saved and agent receipt are distinct | Show an honest pending label; move the item out of waiting without claiming the agent has started work |
| D09 | Stable per-host-conversation consumer binding | Active UI tab or last-modified file must never redirect another conversation's answer |
| D10 | CLI + Claude plugin + documented Codex hook, with Codex instruction fallback | Both hosts are first-class; no MCP service, transcript parser, or terminal keystroke injection |
| D11 | Persistent Claude skills-directory plugin, project-root launch documented | Current documented local loading avoids marketplace mutation; exact host baseline/trust behavior proved in M0 |
| D12 | Setup/uninstall journal owned blocks/files and preserve other edits | Meets reversible settings requirement; edited owned content is reported rather than destroyed |
| D13 | Global Waiting panel with Sent section; per-session tree/graph | Matches the detailed mockups and keeps every known unanswered item visible |
| D14 | Preserve Nocturne visual language; port reusable markup/CSS, replace prototype runtime | Export relies on CDN dependencies and fake timers; production assets must be bundled and data real |
| D15 | Explicit answer selection and Cmd+Enter in the editor | Recommendation remains visible; routine Enter navigation cannot send an unchosen answer |
| D16 | Seven statuses; explanation+done may display Explained; replacement→dropped uses two linked items | Resolves contradictory example labels without expanding the state machine |
| D17 | Last-activity labels instead of guessed “connected/running” state | CLI writes do not establish live agent connections; no liveness service needed |
| D18 | Defer optional rail, topic sharing/handoff, archive/close-session and extra owner actions | Required release centers on reading, answering, and provenance; full discrepancies listed in DESIGN |
| D19 | Simple per-topic SVG graph; no diagram editor framework initially | Tree data has deterministic layout; overview does not need freeform authoring |
| D20 | Prove native notification routing and host hooks before UI polish | These platform risks can invalidate a late-stage build; native adapter is the planned fallback |
| D21 | macOS WebdriverIO service proof plus deterministic core/browser tests | Current docs offer embedded macOS support; test-only listener must never ship in release |
| D22 | Local `make install`, unsigned app, explicit PATH preflight | Required install experience without publishing/signing or silent shell-profile edits |
| D23 | Strictly offline product; copyable external links; no telemetry/updater/remote assets | Required runtime constraint; build-time dependency downloads and reference rendering remain development activities |
| D24 | No the review tool guidance fetched or checked | Owner explicitly selected “Proceed without the review tool; record that org guidance was not checked”; project security choices are not presented as organization-verified |
| D25 | Bounded whole-file sessions with clear errors and recovery | Keeps the specified JSON format predictable; no hidden database migration or silent truncation |

## Decisions awaiting evidence, not owner preference

- Exact toolchain/package versions, macOS deployment baseline, and supported host minimum versions: record in M0 after scaffolding and smoke tests.
- Notification implementation: use the plugin only if the required macOS click-routing proof passes; otherwise use a minimal native adapter.
- Real-app test harness: use the documented embedded WebdriverIO path if the M0 proof passes; otherwise use the build prompt's permitted mocked UI approach plus explicit native manual gates.

These are bounded implementation investigations. Product scope, storage location, delivery semantics, and build order are already decided.
