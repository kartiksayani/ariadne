# Design translation and release-one visual contract

[PERSONAL_RELEASE](PERSONAL_RELEASE.md) governs first-release scope and supersedes older exhaustive build-prompt gates. This document translates the supplied Ariadne UI handoff into the release-one interface. It is authoritative for layout, visual treatment, and which supplied controls appear. Product behavior comes from `PRODUCT.md`; storage, commands, queue semantics, and runtime ownership come from `LOW_LEVEL_DESIGN.md` and its linked low-level specifications. When a prototype differs from an explicit release-one decision below, preserve the prototype's visual language and apply the release-one behavior.

## Reference package

The immutable source is [`designs/Ariadne-UI-mockups-v2.zip`](../../designs/Ariadne-UI-mockups-v2.zip) (the v2 "Paperwhite" handoff; the v1 "Nocturne" zip stays in `designs/` as history only). It contains the handoff README, main prototype, board, component sheets, status diagram, scenario pages, Paperwhite stylesheet, and its prototype-only runtime. The source inventory, SHA-256 digests, and member sizes are in [`assets/design-manifest.json`](assets/design-manifest.json); frame-to-acceptance mapping is in [`DESIGN_TRACEABILITY.md`](DESIGN_TRACEABILITY.md).

The existing `assets/mockup-dark-tree.png` and `assets/mockup-light-graph.png` are rendered design references, not Ariadne application screenshots. Port markup, dimensions, tokens, and SVG treatment. Do not ship `support.js`, its custom compiler, remote font/icon imports, fixture timers, or scripted agent behavior. Bundle required fonts and icons locally with their licenses.

## Product shape shown by the UI

Ariadne is a local second-screen tree, history browser, and input queue for **existing terminal sessions**. The primary interface is the project/session navigator, persistent Waiting on me column, session tree or graph, item detail, and message rail. Claude Code Mod is the primary proven bridge; Codex uses its native queue/history bridge. Tree writes, replies, outcomes, and status changes use explicit agent CLI/MCP operations. The bridge reports delivery and lifecycle evidence; it is not a second item-authoring API.

Release one does not launch agents, host their tool execution, present agent tool-approval cards, or provide a chat transcript composer. An owner can send an item-scoped bring-up, answer/reply, note, follow-up, drop, or reopen request from any item status; a Replaced item offers follow-up only and cannot be reopened in place. The request is stored and queued; only the agent changes item status. Saving a response does not move an item to In progress. The app shows `Saved`, queue/delivery state, and agent receipt only when supported by evidence. `Later` is a local view preference and never reaches the agent.

Project registration and session binding are explicit. V1 discovery offers read-only candidates; it never silently binds a transcript or guesses which terminal owns it. Binding status is evidence-based and qualified when disconnected. Closing an Ariadne session is a guarded metadata operation and never terminates the host process. The complete item message history and round snapshots support the handoff's Back and forth detail; the message rail is included in release one.

Topics can be archived/restored only when all their items are terminal and no queued, in-flight, or needs-attention input targets them. Sessions can be closed only when all items are terminal, no input is unresolved, and dispatch is paused; the UI offers an explicit Pause then Close flow and displays blockers. They can be reopened without starting the host process. Continue in this session creates a snapshot copy in the target session, retains source references for copied topics, items, messages, rounds, and answers, previews the summary, and requires explicit send. The source topic is never modified and the copied topic is not a shared mutable cross-session object. These archive, close, reopen, continue, message-rail, and all-item owner-action decisions are deliberate release-one restorations of controls shown in the mockups.

## Layout and responsive behavior

Reference viewport is **1600 × 960**. The frame has a **48 px header**, **38 px tab bar**, flexible body, and **30 px footer**. The body uses a persistent **300 px** Waiting on me column, a center of at least **560 px**, a **400 px** detail column when open, and a **240 px** optional message rail. Panels scroll vertically independently; header, tab bar, footer, and waiting column remain available. At the supported minimum **1000 × 700**, center/detail/rail occupy a horizontally scrollable region; the waiting column remains pinned. Detail and rail can be closed explicitly to recover width. No mobile reflow or user-resizable panel dividers are specified by the handoff.

Keep Projects, All sessions, and closable session tabs. Closing a tab changes only navigation state. Projects contains registered roots; All sessions lists all known sessions, including those not open as tabs. Project and session pages show active/closed groupings and binding evidence. Preserve tab order, selected tab/item, tree expansion, search and filter state, drafts, rail state, and scroll anchors across launch.

### Shared visual tokens

The complete source ramps and Paperwhite variables are documented in the zipped `design_handoff_ariadne/README.md` under Design tokens and in `_ds/paperwhite/styles.css`. They are ported to `apps/desktop/public/styles/design-tokens.css`, which is the shipped source of truth; the values below are summaries.

| Element | Dark | Light |
| --- | --- | --- |
| Background / surface / text / accent | `oklch(0.2 0.006 80)` / `oklch(0.25 0.007 80)` / `oklch(0.9 0.012 85)` / `oklch(0.7 0.12 255)` | `oklch(0.958 0.009 85)` / `oklch(0.978 0.007 85)` / `oklch(0.27 0.008 75)` / accent-600 |
| Divider | text at 14% | text at 12% |
| Status | Open neutral-400; Waiting accent-400; In progress `oklch(0.82 0.09 78)`; Decided `oklch(0.8 0.075 178)`; Done `oklch(0.8 0.085 148)`; Dropped/Replaced neutral-500 | Open neutral-600; Waiting accent-600; In progress `oklch(0.55 0.11 68)`; Decided `oklch(0.52 0.08 185)`; Done `oklch(0.52 0.1 148)`; Dropped/Replaced neutral-700 |

Use the entire neutral/accent ramps from the stylesheet. Use JetBrains Mono 400/500 for all text, with `ui-monospace`/Menlo as fallback. Bundle Phosphor regular and fill icons, the spiral mark, and fonts so the application works offline. Themes are Dark and Light, toggled by a two-state control; a stored legacy `system` preference resolves through `prefers-color-scheme`. Status has a distinct shape and a text label, never color alone. Preserve the source's accent-outline primary buttons, readable dimmed terminal rows, visible focus, and icon-plus-text states.

| Component | Source sizing and treatment |
| --- | --- |
| Detail title / page title / item sentence | 20 / 18 / 15 px; preserve source line-height and sentence wrapping |
| Metadata / section label | 12–12.5 / 11 px; section labels medium, tracked uppercase |
| Radius | 4 px keycap; 6 px badge; 8 px card/button/node; 14 px dialog |
| Tree | 24 px per depth; neutral ancestry guides; accent selected path |
| Status badge | 22 px high pill, icon plus label |
| Graph node | 190 × 66 px, two-line preview; full item text in detail |
| Graph edge | Curved parent edge; accent selected path; dashed, labelled replacement edge |
| Focus | 2 px accent `:focus-visible` outline |

## Screens and components

| Screen or component | Required contents and behavior | Reference |
| --- | --- | --- |
| Global chrome | Ariadne spiral/name, registered project or session context, evidence-based binding state, search, Tree/Graph/Archive view, message-rail toggle, theme control; project/session tabs; footer with implemented keyboard hints and scoped counts | README `Global chrome`; board 1a, 1aa, 1ab, 1z |
| Projects / project / all sessions | Registered-root cards and project/session groupings, active/closed sessions, topic counts, Open/Go to tab/Close/Reopen controls, first-launch empty-registration state | README `Projects screen`, `Project page`, `All sessions`; board 1p, 1ab, 1ac, 1z |
| Waiting on me | Cross-session queue where item status is Waiting and there is no Answer for the current question revision whose input is not cancelled/skipped; oldest waiting episode first; plain-language path; question and ask; previous-round/earlier-session context; compact answer; Sent inputs; empty state. A new ask can be Waiting while an older input for that item remains Sent. Archived topics cannot contain waiting items because archive is guarded | README `Waiting on me`; board 1a, 1c, 1l |
| Session tree | Session evidence bar; status chips and topic selector; topic counts/actions; 24 px nested rows with status, question, outcome/supporting line, selected ancestry, active-descendant summary, search/filter context and local Later marker | README `Session tab`; board 1a, 1n, 1t, 1u, 1w, 1aa |
| Item row and status badge | Full question and closed outcome; one priority supporting line; descendants summary; hover actions; small/secondary item reference; unique status shape plus text; selected, focus, search, touched-message, open-answer states | README `Components`; `Item Row.dc.html`, `Status Badge.dc.html`; board 1j, 1k |
| Item detail | Breadcrumbs, type/status/next actor, question, outcome, why/note, prior reopen snapshot, replacement, children, links, answer/delivery history, complete message timeline, and Back and forth rounds with answer/result/message references and child forks | README `Item detail`; board 1b, 1e, 1q, 1r, 1u, 1v |
| Owner actions / answer | Any unarchived item in an active session can queue bring-up, answer/reply, note, follow-up, drop, or reopen intent; Replaced items offer follow-up only. Waiting choices show option consequence and recommendation; recommendation is not selected by default. One option plus optional text or nonempty free text alone. Save is explicit; local `Later` is separate. | README `Answering inline`; `Answer Control.dc.html`; board 1c, 1e, 1q, 1r, 1m |
| Graph | One topic at a time with ordered nodes, statuses, parent paths, distinct replacement link, filters, pan/zoom/fit/reveal and selection shared with tree/detail | README `Graph view`; board 1d, 1f, 1aa |
| Message rail | Current session's complete Ariadne message history, newest at bottom; hover highlights touched items, click pins highlight, selecting item highlights its messages; upward scroll pauses follow and exposes Jump to latest | README `Message rail`; board 1a, 1b, 1f, 1q, 1t, 1u, 1w, 1y |
| Archive / continue | Archive list with restore; archive guard; continue dialog previews an immutable source snapshot and requires explicit submission into a chosen target session | README `Archive`, `Dialogs`; board 1x, 1y |
| Loading, empty and failure states | Empty session, first registration, all-clear, loading, stale/unavailable binding, reconnecting, filter reveal, malformed/read-only and write/delivery recovery states preserve last-known content and unsent owner text | README `Empty, loading and edge states`; board 1g–1i, 1m–1p |
| Component sheet | Both themes and all status/row/answer/message variants, including focus and disabled/error states | `Component Sheet.dc.html`; board 1j, 1k |

Full item history is not inferred from a single excerpt. Preserve each message's author, timestamp, excerpt/full recorded text, touched item references, and session-local message number. Preserve each item's rounds (agent ask, owner option/free text, result, messages and forked child IDs) as an ordered snapshot. Current status/outcome remain separate from historical rounds. A round can refine an item without creating a child; a new question creates a child while the parent continues. Reopen keeps the previous outcome/status snapshot. See `DESIGN_TRACEABILITY.md` and the domain specification for persistence details.

## Input, state, and navigation rules

- All owner actions, including messages on closed items, become durable session-scoped input requests. The UI labels the request kind and target; one FIFO queue preserves submission order. Delivery and receipt are separate from item status.
- Waiting counts use `waiting_unanswered`: item status is Waiting and there is no Answer for the current question revision whose input is other than cancelled or skipped. Once answered, that episode stays out of Waiting even after the input is handled. Sent shows one row per queued, in-flight, or needs-attention input, including generic requests. A new ask can re-enter Waiting while an older input on the same item remains in Sent. Raw status counts remain separate from actionable Waiting counts.
- Use API `SummaryCounts` consistently: global/project/tray Waiting count is `waiting_unanswered`; Sent counts inputs by queued/in-flight/needs-attention; `items_by_status` is the separate raw status count. Topic and selected-session chips count nonarchived items before local search/filter. Footer shows visible and total scope. Archive has separate topic counts. Partial/inaccessible sources show an incomplete marker, never a false zero. The UI/API mapping for design operation names such as `input.submit` to transport command names is in `low-level/API_AND_MCP.md`.
- Only the agent updates status. An accepted answer remains visible in Sent until handled (successful matching host turn plus committed domain result), or explicitly cancelled/skipped. Received and Reply published are intermediate labels within Sent. Uncertain delivery blocks later queue work until explicitly resolved. Resend uses the same operation identity when the runtime proves the first delivery did not occur; uncertainty offers explicit recovery and a duplicate-work explanation.
- `Later` only changes local visibility. It does not change owner/status fields or send a request.
- Archive requires all topic items terminal and no queued, in-flight, or needs-attention input. Close session requires all items terminal, no unresolved inputs, and dispatch paused; show blockers and offer an explicit Pause then Close flow. Neither operation kills, closes, or types into a terminal process. Restore/reopen only restores Ariadne metadata.
- Continue makes a copy in the target session with immutable source references. Preview and owner confirmation precede send. A failed target write leaves the source untouched.
- Search is local to the selected session and includes question, outcome, why, topic, and message excerpts; it excludes provider raw activity and secrets. Status/topic/owner filters combine with AND; values within each filter combine with OR. A reveal temporarily expands ancestry and displays an outside-filter banner without clearing filters or overwriting the owner's saved expansion choices.
- Use the same reveal route from Waiting, search, tree links, graph, tray, notifications, archive, and message timeline. Preserve selection, focus, scroll anchor, and drafts through live snapshots.

Keyboard behavior is specified in `low-level/UI_AND_NATIVE.md`; the footer only advertises release-one bindings. A recommended option is visual guidance only. Number keys select; they never submit. Enter opens the selected item or activates ordinary navigation; Cmd+Enter submits the focused valid owner input. Escape closes the topmost detail/overlay while keeping drafts.

## Native surface

The tray count and quick list use `waiting_unanswered`, not raw items with Waiting status; oldest unanswered episodes appear first. Sent generic requests do not inflate that task-question count. Show separate lifecycle/binding indicators; do not expose host tool approval. Native notifications identify a waiting episode, contain IDs only by default, and route clicks through the same reveal action. Use the single Rust `objc2` UserNotifications delegate bridge already specified in `low-level/UI_AND_NATIVE.md`; do not add a competing delegate. Pin, window geometry, tray, notification, and `ariadne open` details are in that low-level spec.

## Required visual states

Capture at 1600 × 960 in both themes: Projects, project page, All sessions, session tree, selected terminal item, waiting detail, option answer, free-text answer, queued/sent/received and uncertain delivery, full Back and forth rounds with forks, graph, message rail hover/pin/follow-latest, archive/restore, continue preview/commit, session close/reopen guard, first registration, empty session, loading, all-clear, no results, filter reveal, stale/unavailable binding, malformed store, write failure with retained draft, changed question during an answer, and native-route recovery.

Use deterministic clocks and the canonical fixture from `DESIGN_PROMPT.md`. Compare layout, text wrapping, indentation, icons, colors, focus, selected ancestry, rail interactions, and responsive overflow to the supplied references. Raster antialiasing differences are acceptable. Missing states, lost history, clipped controls, inaccurate status/delivery claims, and spacing drift are not. Trace each board frame and requirement to an acceptance ID in `DESIGN_TRACEABILITY.md`.

## Security guidance provenance

The owner explicitly waived Seezo organizational guidance for this task. It was not checked. Security boundaries in these documents are grounded in the approved local-only architecture and user-provided decisions; this note does not claim organizational guidance review.
