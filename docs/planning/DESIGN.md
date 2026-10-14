# Design translation and release-one visual contract

[PERSONAL_RELEASE](PERSONAL_RELEASE.md) governs first-release scope and supersedes older exhaustive build-prompt gates. This document translates the supplied Ariadne UI handoff into the release-one interface. It is authoritative for layout, visual treatment, and which supplied controls appear. Product behavior comes from `PRODUCT.md`; storage, commands, queue semantics, and runtime ownership come from `LOW_LEVEL_DESIGN.md` and its linked low-level specifications. When a prototype differs from an explicit release-one decision below, preserve the prototype's visual language and apply the release-one behavior.

## Reference package

The immutable source is [`designs/Ariadne-UI-mockups-v2.zip`](../../designs/Ariadne-UI-mockups-v2.zip) (the v2 "Paperwhite" handoff). It contains the handoff README, main prototype, board, component sheets, status diagram, scenario pages, Paperwhite stylesheet, and its prototype-only runtime. The source inventory, SHA-256 digests, and member sizes are in [`assets/design-manifest.json`](assets/design-manifest.json); bundled font/icon sources, licences and file hashes are in [`assets/offline-design-assets.json`](assets/offline-design-assets.json); frame-to-acceptance mapping is in [`DESIGN_TRACEABILITY.md`](DESIGN_TRACEABILITY.md).

Previous committed screenshots were removed for privacy. The current design harness (`npm run test:design`, [ADR-0086](../adr/ADR-0086-paperwhite-design.md)) renders the supplied frames and application states from local fixtures. Port markup, dimensions, tokens, and SVG treatment. Do not ship `support.js`, its custom compiler, remote font/icon imports, fixture timers, or scripted agent behavior. Bundle required fonts and icons locally with their licenses.

## Product shape shown by the UI

Ariadne is a local second-screen tree, history browser, and input queue for **existing terminal sessions**. The primary interface is the project/session navigator, persistent Waiting on me column, session tree or graph, and item detail. Claude Code Mod is the primary proven bridge; Codex uses its native queue/history bridge. Tree writes, replies, outcomes, and status changes use explicit agent CLI/MCP operations. The bridge reports delivery and lifecycle evidence; it is not a second item-authoring API.

Release one does not launch agents, host their tool execution, present agent tool-approval cards, or provide a chat transcript composer. An owner can send an item-scoped bring-up, answer/reply, note, follow-up, drop, or reopen request from any item status; a Replaced item offers follow-up only and cannot be reopened in place. The request is stored and queued. Ack is a separate local owner action: it moves an eligible item to its agent-proposed target without a queued message (ADR-0093). Saving a response does not move an item to In progress. The app shows `Saved`, queue/delivery state, and agent receipt only when supported by evidence. `Later` is a local view preference and never reaches the agent.

Project registration and session binding are explicit. V1 discovery offers read-only candidates; it never silently binds a transcript or guesses which terminal owns it. Binding status is evidence-based and qualified when disconnected. Closing an Ariadne session is a guarded metadata operation and never terminates the host process. The complete item message history and round snapshots support the handoff's Back and forth detail. Alpha.15 removes the Messages pane by owner decision; the agent chat remains in the terminal.

Topics can be archived/restored only when all their items are terminal and no queued, in-flight, or needs-attention input targets them. Sessions can be closed only when all items are terminal, no input is unresolved, and dispatch is paused; the UI offers an explicit Pause then Close flow and displays blockers. They can be reopened without starting the host process. Continue in this session creates a snapshot copy in the target session, retains source references for copied topics, items, messages, rounds, and answers, previews the summary, and requires explicit send. The source topic is never modified and the copied topic is not a shared mutable cross-session object. These archive, close, reopen, continue, and all-item owner-action decisions are deliberate release-one restorations of controls shown in the mockups.

## Layout and responsive behavior

Reference viewport is **1600 × 960**. The frame has a **48 px header**, **38 px tab bar**, flexible body, and **30 px footer**. The body uses a persistent **300 px** Waiting on me column, a center of at least **560 px**, a **400 px** detail column when open. Panels scroll vertically independently; header, tab bar, footer, and waiting column remain available. At the supported minimum **1000 × 700**, center/detail occupy a horizontally scrollable region; the waiting column remains pinned. Detail can be closed explicitly to recover width. No mobile reflow or user-resizable panel dividers are specified by the handoff.

Keep Projects, All sessions, and closable session tabs. Closing a tab changes only navigation state. Projects contains registered roots; All sessions lists all known sessions, including those not open as tabs. Project and session pages show active/closed groupings and binding evidence. Preserve tab order, selected tab/item, tree expansion, search and filter state, drafts and scroll anchors across launch.

### Shared visual tokens

The complete source ramps and Paperwhite variables are documented in the zipped `design_handoff_ariadne/README.md` under Design tokens and in `_ds/paperwhite/styles.css`. They are ported to `apps/desktop/public/styles/design-tokens.css`, which is the shipped source of truth; the values below are summaries.

| Element | Dark | Light |
| --- | --- | --- |
| Background / surface / text / accent | `oklch(0.2 0.006 80)` / `oklch(0.25 0.007 80)` / `oklch(0.9 0.012 85)` / `oklch(0.7 0.12 255)` | `oklch(0.958 0.009 85)` / `oklch(0.978 0.007 85)` / `oklch(0.27 0.008 75)` / accent-600 |
| Divider | text at 14% | text at 12% |
| Status | Open neutral-400; Waiting accent-400; In progress `oklch(0.82 0.09 78)`; Decided `oklch(0.8 0.075 178)`; Done `oklch(0.8 0.085 148)`; Dropped/Replaced neutral-500 | Open neutral-600; Waiting accent-600; In progress `oklch(0.55 0.11 68)`; Decided `oklch(0.52 0.08 185)`; Done `oklch(0.52 0.1 148)`; Dropped/Replaced neutral-700 |

Use the entire neutral/accent ramps from the stylesheet. Use JetBrains Mono 400/500 for all text, with `ui-monospace`/Menlo as fallback. Bundle Phosphor regular and fill icons, the spiral mark, and fonts so the application works offline. Themes are Dark and Light, toggled by a two-state control; a stored legacy `system` preference resolves through `prefers-color-scheme`. Status has a distinct shape and a text label, never color alone. Preserve the source's accent-outline primary buttons, readable dimmed terminal rows, visible focus, and icon-plus-text states.

The bundled WOFF2 files are the complete, unmodified Phosphor fonts; `phosphor.css` maps the glyphs the app draws. Beyond the handoff's 62 glyphs, `assets/offline-design-assets.json` records additional app glyphs under `app_glyphs`, using codepoints from `@phosphor-icons/web@2.1.1` `src/regular/style.css`. `apps/desktop/tests/ui/shared/icons.test.ts` checks that every `ph-*` class the app uses has a CSS mapping.

| Component | Source sizing and treatment |
| --- | --- |
| Detail title / page title / item sentence | 20 / 18 / 15 px; preserve source line-height and sentence wrapping |
| Metadata / section label | 12–12.5 / 11 px; section labels medium, tracked uppercase |
| Radius | 4 px keycap; 6 px badge; 8 px card/button/node; 14 px dialog |
| Tree | 24 px per depth; continuous neutral ancestry rails; accent selected path; stable decorative hue per top-level root |
| Status badge | 22 px high pill, icon plus label |
| Graph node | 190 × 66 px, two-line preview; full item text in detail |
| Graph edge | Curved parent edge; accent selected path; dashed, labelled replacement edge |
| Focus | 2 px accent `:focus-visible` outline |

## Screens and components

| Screen or component | Required contents and behavior | Reference |
| --- | --- | --- |
| Global chrome | Ariadne spiral/name, registered project or session context, evidence-based binding state, search, Tree/Graph/Archive view, theme control; project/session tabs; footer with implemented keyboard hints and scoped counts | README `Global chrome`; board 1a, 1aa, 1ab, 1z |
| Projects / project / all sessions | Registered-root cards and project/session groupings, active/closed sessions, topic counts, Open/Go to tab/Close/Reopen controls, first-launch empty-registration state | README `Projects screen`, `Project page`, `All sessions`; board 1p, 1ab, 1ac, 1z |
| Waiting on me | Active-session queue where item status is Waiting and there is no Answer for the current question revision whose input is not cancelled/skipped; oldest waiting episode first; plain-language path; question and ask; previous-round/earlier-session context; compact answer; Sent inputs; empty state. A new ask can be Waiting while an older input for that item remains Sent. Closed-session questions appear only in their own Map history, never in Waiting or its counts | README `Waiting on me`; board 1a, 1c, 1l |
| Session tree | Session evidence bar; status chips and topic selector; topic counts/actions; 24 px nested rows with status, question, outcome/supporting line, selected ancestry, active-descendant summary, search/filter context and local Later marker | README `Session tab`; board 1a, 1n, 1t, 1u, 1w, 1aa |
| Item row and status badge | Named title with adjacent status; question and closed outcome; one priority supporting line; descendants summary; hover actions; unique status shape plus text; selected, focus, search, touched-message, open-answer states | README `Components`; `Item Row.dc.html`, `Status Badge.dc.html`; board 1j, 1k |
| Item detail | Breadcrumbs, type/status/next actor, question, outcome, why/note, prior reopen snapshot, replacement, children, links, answer/delivery history, complete message timeline, and Back and forth rounds with answer/result/message references and child forks | README `Item detail`; board 1b, 1e, 1q, 1r, 1u, 1v |
| Owner actions / answer | Any unarchived item in an active session can queue bring-up, answer/reply, note, follow-up, drop, or reopen intent; Replaced items offer follow-up only. Waiting choices show option consequence and recommendation; recommendation is not selected by default. One option plus optional text or nonempty free text alone. Save is explicit; local `Later` is separate. | README `Answering inline`; `Answer Control.dc.html`; board 1c, 1e, 1q, 1r, 1m |
| Graph | One topic at a time with ordered nodes, statuses, parent paths, distinct replacement link, filters, pan/zoom/fit/reveal and selection shared with tree/detail | README `Graph view`; board 1d, 1f, 1aa |
| Archive / continue | Archive list with restore; archive guard; continue dialog previews an immutable source snapshot and requires explicit submission into a chosen target session | README `Archive`, `Dialogs`; board 1x, 1y |
| Loading, empty and failure states | Empty session, first registration, all-clear, loading, stale/unavailable binding, reconnecting, filter reveal, malformed/read-only and write/delivery recovery states preserve last-known content and unsent owner text | README `Empty, loading and edge states`; board 1g–1i, 1m–1p |
| Component sheet | Both themes and all status/row/answer/message variants, including focus and disabled/error states | `Component Sheet.dc.html`; board 1j, 1k |

Full item history is not inferred from a single excerpt. Preserve each message's author, timestamp, excerpt/full recorded text, touched item references, and session-local message number. Preserve each item's rounds (agent ask, owner option/free text, result, messages and forked child IDs) as an ordered snapshot. Current status/outcome remain separate from historical rounds. A round can refine an item without creating a child; a new question creates a child while the parent continues. Reopen keeps the previous outcome/status snapshot. See `DESIGN_TRACEABILITY.md` and the domain specification for persistence details.

Item references in Ariadne-owned visible text use names; numeric item references do not appear in rows, detail navigation, Waiting controls, or the Continue preview. Short names that collide in a view put distinguishing topic or question words first, before any width truncation. Related controls, Waiting answers, detail headings, selected-item tags and replacement links use the full question in accessible names and tooltips. Replacement links use the same name chips as other item references. Keep numeric identities in routes, provenance, agent-written content, the exact summary sent by Continue, and the explicit Copy reference action.

Tree rows put the status next to the title. The body shows the full text unless a four-line preview hides at least three additional lines; then it offers expansion. Ancestry rails stay continuous across row content and supporting lines. Neutral rails show structure, accent rails mark the selected path, and a stable hue for each top-level root is decorative. Clicking a tree row selects it without scrolling the reader. Opening or restoring a session restores its saved scroll anchor; without one, it brings the selected row into view once. Deliberate navigation from Waiting, search, history, item links and native reveal requests brings the target into view, overriding a saved reading anchor when an item route opens another session. Detail opening and closing keep the scroll position. Keyboard movement uses the least scrolling needed to keep the new row visible. Every reveal places the row's top below pinned session/filter controls and the measured sticky topic header; a row that fits the remaining viewport is fully visible.

When selection is above or below the Map viewport, show a compact `↑ Selected: name` or `↓ Selected: name` tag in a permanently reserved slot in the filter bar. The slot stays mounted while the tag is hidden, including in Archive's reserved top bar. The tag sits outside the row scroller, uses content width with a bounded ellipsis for long names, and has a solid card background and full opacity in normal, hover, focus and active states. Showing or hiding it never overlays rows or changes row wrapping, filter-bar height or scroller geometry. Activating the tag returns keyboard focus to the selected row with preventScroll; Cmd+J reveals it while preserving editor focus. The tag slot has its own navigation label outside the filter group. Graph does not show this Map tag.

Opening placement finishes even when the saved selection cannot be mounted or its read times out; discard an absent opening target when opening finishes and discard pending placement when the owner scrolls. Temporary restoration preserves the current detail state and reports no opening error; later deliberate reveals still work. The first visible reading anchor holds its offset through side-panel and window-width changes, including rewrapping above it. A row click during search has the same scroll behavior as every other row click. Preview folding counts actual text lines, excluding Markdown spacing and padding, and cuts after a complete fourth line. Natural content-size and font changes remeasure a folded preview through one Map-level font subscription. Mouse focus on an agent link keeps its folding state; keyboard focus expands it so the focused link is visible. Question options always stay outside the fold.

### Seeing changes (Alpha.14.4, mock M2)

Use one coral-orange attention token for the eye-catching `New` tag and filled
changed-since-read dot. Waiting status is separate and clears only when answered.
Wording-only edits stay in history and create no attention marker.

Under the owner's answer, show the saved option and any typed words, followed by
`Because you chose X:` or the agent's `Read as: …` interpretation for typed
answers. Group affected item names as updated, replaced, new or now blocked.
Use a card-wide budget of five names, showing whole groups in Updated, Replaced,
New, Now blocked order. Once the next whole group exceeds the budget, hide it
and every later group; omit their headings. Summarize these hidden groups once
outside the shown groups, in display order, such as
`and N more: 1 replaced, 2 new`; reveal restores each whole group and its heading.
Thus three updated plus three replaced shows only the three updated names and
`and 3 more: 3 replaced`. Only when the first nonempty group itself exceeds five
may it split: show its first five names and an `and N more` reveal inside that
group; expansion keeps all its names under the same heading. The in-group and
whole-group reveals operate independently. Never hide exactly one name in total:
five updated plus one replaced shows all six, while three
updated plus three replaced still hides the whole replaced group.
Each name opens its item.
All comparisons use a small compare icon with `Show before and after` as its
tooltip, highlighted while expanded.

The topic brief is the agent's 2–3 sentence bottom line, labelled
`By the agent · as of …`. Ariadne derives the linked Decided, Your turn and Replaced
lists; replacements strike through the old name and name its replacement.
`Since you were here` comes from saved change records since the topic's caught-up
baseline. After more than two days or at least 30 changes, lead with the brief
and offer Mark all seen with Undo.

Seen is one shared state. Opening an item marks its captured revision seen after
about one second; an item peek follows the same dwell rule. Its marker
clears everywhere and its change card leaves the list. A card marked with its
Seen button briefly says `✓ Seen`, then leaves after about three seconds.
When a topic has no unseen item changes remaining, record
its caught-up baseline automatically. Seen, Mark all caught up and Mark all seen
remain optional shortcuts. A bulk action updates shared seen state immediately
and defers its monotonic preference write for the five-second Undo window; Undo
survives navigation and reverts only those pending marks, preserving later reads
and new changes. A topic mark uses the observation time only when the rendered
session revision is still current; an older bulk capture marks its shown items
while leaving newer unread batches eligible.

N wraps from the last unseen item to the first, reporting `No unseen items` when
none remain. Landing via N focuses and reveals the row without opening detail or
a preview and leaves it unseen. The row pulses briefly, then keeps a distinct
outline until the next N. Clicking it or pressing Enter opens it and starts the
seen dwell.

Closed-session questions show `Session closed` without answer controls only in
that session's own Map history. Waiting has no hidden-question line, Show toggle
or historical cards; its Sent rows also omit those questions. Unavailable-session
notices use a known session name or plain words, never an ID. The mock's former
closed-session Waiting tour step 21 is removed from the Alpha.14.4 contract.

The design gallery preserves the immutable archive and applies intentional row changes through `tests/ui/design/row-chrome.ts`, called by `source.mts`; setup regenerates `coverage/design/source/`. Alpha.14 Map references use named titles with adjacent status, reserved actions, and accent topic titles with the existing dimming for earlier topics. The app also has continuous grey rails, accent selection paths and decorative root marks from mock M1. The inline-answer reference replays session opening with detail visible, then closes detail and opens the answer without scrolling, matching the app gallery. It waits for fonts and layout before that transition and never recenters the expanded editor. Initial selection placement is retained; scroll drift is not an intentional visual difference. Keep screenshot thresholds unchanged.

The Map uses disambiguated name chips for item references in Markdown, related/affects/depends-on lists, Waiting paths and other reference lists. Clicking a chip or pressing Space on it or a focused Map item opens an accessible peek next to the source; plain hover does nothing, and Command-hover waits 500 ms. The peek stays inside the window below the top bar, heads the card with the full item title, wrapped without truncation or a repeated short name, then shows type, status and a short summary, and offers Copy reference and Go to. Go to reveals, selects and opens detail. Escape closes the peek and returns focus to its source without scrolling when the peek took focus. A hover peek leaves editor focus and its Escape handling intact. A waiting question offers option picks and one-line free text through the existing durable owner draft and input-submit path. Closing keeps text, and Open details carries the same draft into the full editor. The onPeekSeen callback fires once after a continuous second on that item and marks its captured displayed revision seen through the shared reading lane; closing early cancels the dwell. Later agent revisions remain unseen.

The Map reserves a fixed breadcrumb slot above the row scroller. It shows at most three nearest ancestor names of the first row fully visible below the pinned bars; each reveals that ancestor. Its appearance never covers a row or changes the scroller geometry. The three-name Recent trail under the session title records viewed, peeked, answered and acknowledged items, plus Next for the oldest unanswered question. Cmd+E or Recent opens the full distinct-item list with the existing change selectors behind Changed only. Session preferences retain at most 15 recent items; current item names are resolved at display time.

Focus is a view preference per session. Double-click a top-level bullet or use its visible Focus action to show that branch. A Focused: name notice has an accessible exit control. Loading and pending removal preserve Focus; clear it only when loaded session data confirms the root is gone. A deliberate reveal outside the branch leaves Focus; the cross-session Waiting column remains complete. Ack all confirms the topic and read-only result count, excludes questions and decisions, and offers a five-second Undo hold before any Core acknowledgements. The header retains a separate count of items that need individual acknowledgement. A session-owned controller sends each reviewed result once, in order, skips results already hand-acknowledged and flushes confirmed work on shutdown; changed proposals and failed or uncertain saves stop the remaining batch with explicit recovery. Undo cancels the hold without sending.

Compact references in running Markdown text, Waiting paths, detail paths, breadcrumbs and the Recent trail use plain inline links with no box or added padding. They retain their names, keyboard access and peek behavior. Peeks clear both the top bar and the reserved ancestor slot. A deliberate reveal holds its target through detail-width changes and preview clamping until the owner scrolls or steers again; ordinary reading then resumes holding the first visible row. Closing detail also holds the visible selected or answered row while previews above it rewrap. The visible Focus action is labelled with the item name and, like other contextual row actions, adds no Tab stop.

The gallery applies intentional navigation chrome through `tests/ui/design/getting-around-chrome.ts`, alongside the row and change adapters in `source.mts`. It adds Recent, the ancestor slot, Focus, eligible Ack all and the existing text-size header control to the reference source without changing the archive, masks or thresholds. Restored selections do not fabricate Recent visits; explicit visits update a bounded distinct-item trail. Reference Focus uses the same fixed 24 px height as the app.

Alpha.14.4 adds Topic brief and Since you were here surfaces below expanded topic
headers. `tests/ui/design/changes-chrome.ts` adapts the reference from the archive's
own named Decided, Your turn and Replaced items. The archive has no change ledger
or attributed brief, so these records start caught up and no New/changed markers
are invented. These additional surfaces move the rows and the initial selection
placement in frames such as 1a and 1c; their absence in the original v2 reference
is an intentional source difference. App-only M2 gallery frames cover attributed
briefs, New/changed markers, answer effects, comparisons, Since cards and Undo.
Reference captures retain the original mismatch thresholds.

## Input, state, and navigation rules

- Owner messages, including messages on closed items, become durable session-scoped input requests. Ack records local owner activity and status history without creating an input. The UI labels the request kind and target; one FIFO queue preserves submission order. Delivery and receipt are separate from item status.
- Waiting counts use `waiting_unanswered`: in an active, unarchived session, item status is Waiting and there is no Answer for the current question revision whose input is other than cancelled or skipped. Once answered, that episode stays out of Waiting even after the input is handled. Sent shows one row per queued, in-flight, or needs-attention input, including generic requests, but excludes closed-session question inputs. A new ask can re-enter Waiting while an older input on the same item remains in Sent. Raw status counts remain separate from actionable Waiting counts.
- Use API `SummaryCounts` consistently: global/project/tray Waiting count is `waiting_unanswered`; Sent counts inputs by queued/in-flight/needs-attention; `items_by_status` is the separate raw status count. Topic and selected-session chips count nonarchived items before local search/filter. Footer shows visible and total scope. Archive has separate topic counts. Partial/inaccessible sources show an incomplete marker, never a false zero. The UI/API mapping for design operation names such as `input.submit` to transport command names is in `low-level/API_AND_MCP.md`.
- Agent operations update status; owner Ack applies the recorded `ack_to` target once no question needs an answer. New read-only items start Open with a target and show a quiet Ack button; topic controls offer “Ack all (N)” for read-only findings and explanations, and graph nodes carry an Ack marker. An accepted answer remains visible in Sent until handled (successful matching host turn plus committed domain result), or explicitly cancelled/skipped. Received and Reply published are intermediate labels within Sent. Uncertain delivery blocks later queue work until explicitly resolved. Resend uses the same operation identity when the runtime proves the first delivery did not occur; uncertainty offers explicit recovery and a duplicate-work explanation.
- `Later` only changes local visibility. It does not change owner/status fields or send a request.
- Archive requires all topic items terminal and no queued, in-flight, or needs-attention input. Close session requires all items terminal, no unresolved inputs, and dispatch paused; show blockers and offer an explicit Pause then Close flow. Neither operation kills, closes, or types into a terminal process. Restore/reopen only restores Ariadne metadata.
- Continue makes a copy in the target session with immutable source references. Preview and owner confirmation precede send. A failed target write leaves the source untouched.
- Search is local to the selected session and includes question, outcome, why, topic, and message excerpts; it excludes provider raw activity and secrets. Status/topic/owner filters combine with AND; values within each filter combine with OR. A reveal temporarily expands ancestry and displays an outside-filter banner without clearing filters or overwriting the owner's saved expansion choices.
- Use the same reveal route from Waiting, search, tree links, graph, tray, notifications, archive, and message timeline. Ordinary Map row clicks and opening or closing detail keep its reading position. Deliberate navigation, including Go to from a peek, Recent, breadcrumbs, keyboard row movement, the selected-item edge marker and Cmd+J, reveals the target clear of sticky elements. Preserve selection, focus, scroll anchor, and drafts through live snapshots.

Keyboard behavior is specified in `low-level/UI_AND_NATIVE.md`; the footer only advertises release-one bindings. A recommended option is visual guidance only. Number keys select; they never submit. Enter opens the selected item or activates ordinary navigation; Cmd+Enter submits the focused valid owner input. Escape closes the topmost detail/overlay while keeping drafts.

## Native surface

The tray count and quick list use `waiting_unanswered`, not raw items with Waiting status; oldest unanswered episodes appear first. Sent generic requests do not inflate that task-question count. Show separate lifecycle/binding indicators; do not expose host tool approval. Native notifications identify a waiting episode, contain IDs only by default, and route clicks through the same reveal action. Use the single Rust `objc2` UserNotifications delegate bridge already specified in `low-level/UI_AND_NATIVE.md`; do not add a competing delegate. Pin, window geometry, tray, notification, and `ariadne open` details are in that low-level spec.

## Required visual states

Capture at 1600 × 960 in both themes: Projects, project page, All sessions, session tree, selected terminal item, waiting detail, option answer, free-text answer, queued/sent/received and uncertain delivery, full Back and forth rounds with forks, graph, item conversation updates and retained unsent messages, archive/restore, continue preview/commit, session close/reopen guard, first registration, empty session, loading, all-clear, no results, filter reveal, stale/unavailable binding, malformed store, write failure with retained draft, changed question during an answer, and native-route recovery.

Alpha.14.4 adds captures for New and changed markers, grouped answer effects
(including typed words and Read as), expanded comparison icons, topic brief and
Since you were here cards, transient Seen and bulk Undo, long-absence catch-up,
N arrival without detail or seen, the selected-item edge marker, closed-session Map
history without answer controls, and Waiting without closed questions or IDs.

Use deterministic clocks and the canonical fixture from `DESIGN_PROMPT.md`. Compare layout, text wrapping, indentation, icons, colors, focus, selected ancestry, item conversations, and responsive overflow to the supplied references. Raster antialiasing differences are acceptable. Missing states, lost history, clipped controls, inaccurate status/delivery claims, and spacing drift are not. Trace each board frame and requirement to an acceptance ID in `DESIGN_TRACEABILITY.md`.

## Security boundaries

Security boundaries in these documents are grounded in the approved local-only architecture and user-provided decisions.

### Alpha.15: Remove the Messages pane

The owner never used the header's Messages pane and chose to remove it. There is no right-hand Messages layout slot, toggle, `m` shortcut or UI rail preference. Item conversations retain their complete history, cancellation labels, copy actions and “Put back in reply box” recovery. Topic replies and session lifecycle messages without an item conversation stay stored and are not shown. The owner declined a replacement history surface; any future surface requires an approved mock.

An editable owner message cancelled by topic archive, session close or agent removal, with no item conversation, gets a persistent notice: “Your unsent message to <topic name> was kept · Put back in reply box”. It includes a short plain-text quote and Copy for the complete message, explains restore/reopen prerequisites, and never overwrites an existing draft. Owner Delete and Edit do not create recovery notices. Dismissal and successful put-back are saved by input ID and survive restart. A successful topic put-back confirms where to open its reply box; unsuccessful outcomes retain their explanation through draft updates.

Older preference files still load with the retired rail field ignored. Saved session views retain the write-only compatibility value `"rail": "hidden"` so alpha.14 can read them. Recovery completion IDs live in companion owner preferences, preserving both versions' ability to read `ui.json`; see [ADR-0100](../adr/ADR-0100-downgrade-compatible-recovery-preferences.md). Prototype frames with Messages are adapted to rail-less layouts; parity checks remain for the rest of each frame.
The companion is optional: quarantine a damaged or unreconcilable file and continue without markers so navigation and drafts stay available. Keep the newest 10,000 completion IDs, evicting the oldest first; old notices may reappear after quarantine or eviction.
