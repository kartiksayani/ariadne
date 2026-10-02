# Design traceability and acceptance map

This map ties every board frame in the immutable mockup ZIP to the production component/state, the domain interaction or read model that supplies it, and a concrete release-one acceptance check. Frame IDs refer to `design_handoff_ariadne/Ariadne Mockups.dc.html`; detailed source descriptions are in the ZIP README sections named in [`DESIGN.md`](DESIGN.md). SHA-256 provenance is in [`assets/design-manifest.json`](assets/design-manifest.json).

## Symbolic UI-to-domain seams

The names below are stable design references; exact parameter types, guards, and transport names live in [`API_AND_MCP.md`](low-level/API_AND_MCP.md). For example, `input.submit` maps to Tauri/CLI `input_submit`, while `topic.continue` maps to preview followed by commit. Agent `apply` remains a separate agent-only domain path.

| UI need | Domain seam |
| --- | --- |
| Read selected session's complete message history and item rounds | `item_messages`, `item_rounds` |
| Receive agent-authored tree, status, message, round and result writes | `apply` via explicit agent CLI/MCP protocol |
| Submit any owner intent against any item | `input.submit` with target, target revision, kind, optional option/text, and stable operation ID |
| Resolve uncertain/rejected input barrier | `input.resolve` with explicit resolution and reason |
| Archive / restore a terminal topic | `topic.archive`, `topic.restore` |
| Close / reopen eligible Ariadne session metadata | `session.close`, `session.reopen` |
| Copy a topic snapshot into another session | `topic.continue` after summary preview and explicit send |
| Report bridge lifecycle | `binding.connect`, `binding.pause`, `binding.resume`, `binding.disconnect` |

Only `apply` changes item status. `input.submit` and its delivery lifecycle never imply a status transition. Continue creates a target-session copy with origin references; it does not mutate the source.

## Board-frame mapping

| Frame | Source scenario | Production component/state | Store or command seam | Acceptance |
| --- | --- | --- | --- | --- |
| 1a | Dark tree + Waiting; message hover | AppShell, GlobalWaitingPanel, TreeView, MessageRail hover | session snapshot; `item_messages` | D01, D03, D04, D08 |
| 1b | Deep dropped item detail, timeline and related rail messages | ItemDetail, replacement/children, ItemTimeline, MessageRail highlight | `item_messages`, `item_rounds` | D05, D08 |
| 1c | Inline answer, recommendation, option selection | AnswerControl with no default choice; explicit submit | `input.submit` | D06 |
| 1d | Dark graph and selected path | TopicGraph, reveal and selection | session snapshot | D07 |
| 1e | Light waiting-question detail | Theme=Light, GlobalWaitingPanel, ItemDetail, AnswerControl | `input.submit` | D01, D03, D05, D06, D14 |
| 1f | Light graph plus message rail | TopicGraph + MessageRail, theme=Light | session snapshot; `item_messages` | D07, D08, D14 |
| 1g | Empty new session | Empty state, unbound/registered session distinction | session snapshot; binding registry | D02, D11 |
| 1h | Loading session | Loading state and retained shell | snapshot subscribe/load | D11 |
| 1i | All clear, light theme | Empty Waiting state with healthy registered sessions | global session summaries | D03, D14 |
| 1j | Component sheet, dark | StatusBadge, ItemRow, AnswerControl, MessageExcerpt states | fixture snapshot; local draft | D14 |
| 1k | Component sheet, light | Same component variants, Light palette/focus | fixture snapshot; local draft | D14 |
| 1l | Answer received and moved to Sent | Waiting/Sent sections, delivery receipt | `input.submit`, bridge receipt; no item status write | D03, D06, D12 |
| 1m | Delivery failure / interruption check | Sent and ItemDetail recovery states | `input.resolve` for uncertain; retry same operation ID on proven rejection | D06, D11, D12 |
| 1n | Item revealed outside filters | Tree reveal banner, temporary ancestry expansion | session snapshot; common `revealItem` route | D04 |
| 1o | Reconnecting with choice retained and submit disabled | Binding disconnected/reconnecting, retained answer draft | `binding.connect` lifecycle; draft preference | D11, D12 |
| 1p | First launch / discovered roots | Projects registration screen; discovery candidates require explicit owner binding | registry read; explicit registration/bind operation | D02, D11 |
| 1q | Open item with bring/reply/drop/Later | ItemDetail owner actions; Later is local | `input.submit` for bring/reply/drop; preference only for Later | D05, D06 |
| 1r | Light open item, free-text reply | Reply editor and unsent draft | `input.submit` | D06, D14 |
| 1s | Status transition implementer diagram | Item status badge, round/result history | `apply`; item history snapshot | D05, D12 |
| 1t | PR review with multiple waiting/open findings | Tree grouping, global waiting cards, selected detail, rail | `apply`; session snapshot; `item_messages` | D03, D04, D05, D08 |
| 1u | Multiple rounds and branches on one item | BackAndForthRounds with fork links and ongoing parent | `item_rounds`, `item_messages`; child links | D05 |
| 1v | Decided/done closed item follow-up/reopen | Terminal non-Replaced ItemDetail; request editor; prior outcome retained | `input.submit` follow-up/reopen intent; agent later uses `apply` | D05, D06 |
| 1w | Topics originating in another session | Project/session context and origin references | session snapshot; cross-session source refs | D02, D05 |
| 1x | Archive, restore, continue | Archive view, guarded Restore, Continue preview | `topic.archive`, `topic.restore`, `topic.continue` | D09, D10 |
| 1y | Continue summary preview | ContinueTopic dialog; explicit target and send | `topic.continue`; target gets immutable copy | D10 |
| 1z | All sessions across open project tabs | AllSessions screen grouped by project | registry and session summaries | D02 |
| 1aa | Session tab with one graph per topic | SessionWorkspace, TopicGraph, not-running evidence state | session snapshot; binding lifecycle state | D02, D07, D12 |
| 1ab | Projects first screen | ProjectList and project counts | explicit registered-project registry; v1 candidate discovery | D02 |
| 1ac | Project with active/closed sessions | ProjectDetail and guarded close/reopen controls | `session.close`, `session.reopen` | D02, D09 |
| 1ad | Agent not running; old handoff routes/queues answer | Disconnected existing-session state; queue same session input for bridge recovery | `input.submit`, binding lifecycle; no retarget-to-other-agent prompt | D06, D12 |

Frame 1ad's original cross-agent reroute prompt and 1p's automatic transcript-folder binding are visual source examples only. Release one never guesses ownership or changes an input's recipient. Frames 1j/1k and 1s are reference sheets/diagrams, not standalone application pages.

## Component-state mapping

| Component | Required states | Reference source | Seam | Acceptance |
| --- | --- | --- | --- | --- |
| StatusBadge | Open, Waiting on me, In progress, Decided, Done/Explained, Dropped, Replaced; icon, pill, and text variants | `Status Badge.dc.html`, README Components | item snapshot | D01, D14 |
| TreeRow | Nested, selected, keyboard-focused, search match, contextual ancestor, touched by message, terminal/dimmed, collapsed descendant summary, locally Later, waiting answer editor; Replaced exposes Follow up but no reopen action | `Item Row.dc.html`, README Components | session snapshot; local UI preference; `input.submit` | D04, D06, D08, D14 |
| AnswerControl | Unselected options, recommended marker, selected option, option plus text, free text only, disabled invalid state, saving/error, saved/queued/delivering/received/uncertain | `Answer Control.dc.html`, README Components | `input.submit`, `input.resolve` | D06, D11, D12 |
| MessageExcerpt | Created/origin/updated roles, owner/agent author, related-item hover, pinned rail highlight, paused-follow/latest pill | `Message Excerpt.dc.html`, README Components | `item_messages` | D05, D08 |
| BackAndForthRound | Ask only, awaiting owner, selected/replied, result, one or more fork links, historical closed round | main detail markup; board 1u | `item_rounds`, `item_messages` | D05 |
| TopicGraph node/edge | Open/waiting/in-progress/closed node; matching/contextual filter; selected ancestry; parent edge; labelled replacement edge; fit/pan/zoom | main graph markup; board 1d/1f/1aa | session snapshot | D07 |
| Archive/Continue dialogs | Archive guard blocked/eligible; restore; source/target summary preview; confirm/cancel; target write error | main dialogs; board 1x/1y | `topic.archive`, `topic.restore`, `topic.continue` | D09, D10, D11 |
| Project/session card | Unregistered candidate, registered/bound, disconnected, active/closed, tab open/closed, close guard including dispatch pause, reopen | main chrome; board 1p/1ab/1ac/1z | registry; binding lifecycle; `session.close`, `session.reopen` | D02, D09, D12 |
| GlobalWaitingPanel | `waiting_unanswered` predicate across multiple projects, oldest waiting-episode order, earlier-session origin, empty, one Sent row per queued/in-flight/needs-attention input, failed/uncertain delivery | main waiting markup; board 1a/1c/1i/1l/1m | `SummaryCounts`; `input.submit`, receipt events | D03, D06, D11 |

## Acceptance checks

These are behavior and visual acceptance targets, not implementation-specific unit tests. Each check names an observable result so a test cannot pass merely because a component rendered.

| ID | Acceptance check |
| --- | --- |
| D01 | At the 1600x960 reference size, header/tabs/footer and 300px waiting column match the stated dimensions; selected ancestry and component typography/colors match reference in both themes. At 1000x700, the waiting column remains pinned while center/detail/rail overflow horizontally. |
| D02 | A project is not treated as bound until explicitly registered/bound. Candidate discovery is read-only. Tabs, Project, and All sessions show the same session identity; close/reopen only updates Ariadne metadata and does not signal the host process. Summary counts show incomplete/unavailable roots instead of reporting zero. |
| D03 | `waiting_unanswered` includes only Waiting-status items with no Answer for the current question revision whose input is neither cancelled nor skipped; a handled answer suppresses that episode. Sent shows one row per queued/in-flight/needs-attention input of any kind. A new ask can be Waiting while an older input for the same item is Sent. Global/project/tray counts use `waiting_unanswered`; raw `items_by_status` remains separate. Archival cannot hide a waiting item. |
| D04 | Tree expand/collapse, search, AND/OR filters, contextual ancestors, keyboard focus, and every reveal entry point resolve to the same item without clearing filters or permanently overwriting expansion preferences. |
| D05 | A fixture with three rounds and two child forks renders asks, selected option/free text, results, related messages, and fork links in order. Reopen preserves the former status/outcome. Every full item message remains reachable in both timeline and rail. |
| D06 | Bring/reply/note/follow-up/drop/reopen from an unarchived item in an active session creates an ordered owner input with a stable operation ID. Replaced items allow follow-up but expose no in-place reopen. Input save/delivery does not change item status. A valid answer needs a deliberate selection or nonempty free text; Cmd+Enter submits once, retry/double click does not duplicate. |
| D07 | Graph parent layout is deterministic; filters and selected item match tree; replacement edge is visually distinct; pan/zoom/fit work and all actions remain reachable in tree/detail. |
| D08 | Hover and pin cross-highlight message↔item links. Scrolling upward pauses autoscroll; subsequent messages increment a Jump to latest affordance without moving focus/scroll. |
| D09 | Archive rejects topics with a nonterminal item or queued/in-flight/needs-attention input and reports blocker IDs. Session close requires all items terminal, no unresolved inputs, and persisted dispatch paused; when needed the UI explicitly pauses, waits for confirmation, then offers a separately confirmed Close. Successful restore/reopen preserves IDs/history/binding. Neither operation affects the host process. |
| D10 | Continue preview names source and target, includes waiting/open/terminal summary and source references, and requires explicit send. The target mapping/origin for copied topic, items, messages, rounds, and answers remains navigable when the source project is unavailable. Successful submission creates a target copy; a forced target write failure leaves the source byte-for-byte unchanged. |
| D11 | Empty, loading, stale, unavailable, malformed, reconnecting, no-results, and write-failure states remain distinguishable. Last valid data stays visible on read failure; an unsent draft survives recoverable error and refresh. |
| D12 | Agent CLI/MCP `apply` is the only item-state mutation path. A bridge can report connected/paused/disconnected and input delivery/receipt, but cannot author statuses or approve host tool operations. A simulated lost acknowledgement leaves delivery uncertain and blocks later FIFO entries pending `input.resolve`. |
| D13 | Packaged macOS notification click, cold-launch routing, tray entry, pin, and `ariadne open` select the same session/item route; stale/already-answered item routes still open current detail. Notification permission denial leaves in-app Waiting usable. |
| D14 | Offline packaged build loads local fonts/icons. Both themes keep status readable without color-only encoding; keyboard focus is visible, dialog focus returns to opener, and controls do not clip at reference/minimum sizes. |

## Visual regression fixtures

Use deterministic clocks, stable project/session/item references, and the canonical example in `DESIGN_PROMPT.md`. Keep reference screenshots at 1600x960 for both themes and crop/diff stable application regions rather than prototype chrome. Review component dimensions, wrapping, indentation, selected ancestry, icon shape, focus rings, graph geometry, rail highlighting, and dialog spacing. Permit rasterization-only differences; do not waive missing state, altered interaction, clipped content, inaccurate delivery/status, or inaccessible focus. Any approved contrast correction records before/after screenshots and the token changed.
