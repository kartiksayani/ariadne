# UI state, item history, and macOS integration

Use [DESIGN](../DESIGN.md) for the visual contract and [DESIGN_TRACEABILITY](../DESIGN_TRACEABILITY.md) for frame-to-component-to-acceptance mappings. `LOW_LEVEL_DESIGN.md` and the other low-level specifications own persistence, command validation, bridge protocol, and queue recovery. This document defines renderer state, interaction, and native UI behavior. Release one connects to existing terminal sessions; Ariadne does not launch or host agents or mediate host tool permissions.

## 1. Component tree and state owners

```text
AppShell
  Header: project/session identity, binding evidence, search, theme, archive view
  SessionTabs: Projects / All sessions / opened sessions
  Workspace
    GlobalWaitingPanel: waiting questions, Sent
    SessionWorkspace: session evidence, topic/status/filter/search, TreeView | TopicGraph
    DetailRegion: ItemDetail
      ItemActions / AnswerControl
      BackAndForthRounds / ItemTimeline
    MessageRail: complete current-session message history
  Footer: implemented keyboard hints and scoped counts
  Dialogs: RegisterProject, BindSession, ArchiveTopic, ContinueTopic, ResolveInput, Settings
```

Header/tabs/footer are 48/38/30 px. Waiting is 300 px, center at least 560 px, detail 400 px, optional rail 240 px. The target is 1600x960; minimum window is 1000x700. Waiting stays pinned; center/detail/rail can overflow horizontally. Panels scroll independently. Detail and rail can close explicitly. There is no mobile layout or user-resizable split pane in v1.

| State | Owner and persistence |
| --- | --- |
| Session and item domain | Backend validated snapshots; renderer never writes a replacement snapshot |
| Project registrations and session bindings | Backend registry with explicit project trust and bind/unbind lifecycle |
| Global summaries | Backend cache keyed by root/session revision; inaccessible roots remain explicitly incomplete |
| Binding/runtime evidence | Bridge events plus last persisted lifecycle fact, always qualified when disconnected |
| Complete message/round history | Domain snapshot; includes item/message relations, answer/request entries, round snapshots, forks, reopen snapshots |
| UI selection, tabs, tree expansion, filters, rail, scroll | Per-session preferences under `~/.ariadne/ui.json` |
| Owner action drafts and operation IDs | Backend preferences; retain same operation ID while commit status is unresolved |
| Theme, window geometry, pin, notification watermark | Versioned global preferences |

Drafts are unsent and invisible to the agent. Preserve them across unrelated snapshots, tab close, and detail navigation. A changed target revision shows a review banner and requires renewed submission. Never auto-send a draft after restart. Preferences corruption backs up the file and allows resetting UI preferences without modifying session data. Follow exact caps, file modes, and write/atomicity behavior in the domain and storage specifications.
The canonical owner-only preference read and typed revision-checked patch records
are published by [CoreService](API_AND_MCP.md#service-owned-read-and-preference-records).

## 2. Snapshot and event synchronization

### Module service and route contract

P4.1 publishes the renderer service over generated domain/service DTOs: typed
query/owner command calls, the existing session/presence revision hints and one
`revealItem({project_id,session_id,item_id})` route over registered IDs. Native
open routes use the same shape with nullable `item_id` for session-only opening.
Presence remains a qualified canonical observation, never a renderer-invented
host state. Screens, graph and native modules consume this service and route
independently; shared exports/composition wiring have one declared owner.
Renderer unit/component work may consume P0.6's scripted canonical double.
Real Tauri/native acceptance uses actual core/store and the original task gates.
Publish reusable snapshot/selection/count selectors before their downstream
components start; a service double is not a replacement for these dependencies.

The early P4.1 seam lives in `apps/desktop/src/data`: `createDesktopService`,
`OpenSessions`/`useSession`, `indexSession`, `summaryCounts` and `RegisteredRoutes`.
Consumers explicitly open/close sessions; multiple readers share the same store.
`revealItem` returns the registered route and temporary expanded ancestors for
the caller to select/focus, without changing saved filters. Native composition is
startup-only. If reveal returns `not_found`, the same registered session read
must succeed before showing a missing-item banner; no missing item is selected
or given invented ancestors. Inaccessible session reads preserve their error.
Actual Registry wiring, registered-parent watch and original native
on-disk acceptance remain required before P4.1 completion.

Subscribe before loading. Keep one immutable validated snapshot store per opened session and expose it through `useSyncExternalStore`; keep drafts/view state in a separate local reducer. Coalesce invalidations and ignore revisions no newer than the displayed revision. Replace displayed data only after a complete valid snapshot is available. Preserve selected item, focus, scroll anchor, filters, and draft. A failed read marks the root/session stale or inaccessible; it never looks like an empty queue.

Watch registered session-store parent directories, debounce changes, validate snapshots in the backend, and emit IDs/revisions rather than file contents. Reconcile on app focus, wake, watcher error, and a bounded fallback poll. Selected session gets priority. V1 session discovery reads only known-provider session metadata and Mod announcements; it never imports private terminal transcripts or chooses a binding automatically. Qualified host state and heartbeat freshness supply liveness. Explicit CLI/MCP messages and bridge lifecycle evidence are authoritative.

Global Waiting contains an item only when its status is `waiting_on_me` and it has no Answer for the current `question_revision` whose input is in any state other than `cancelled` or `skipped`. A handled answer continues to suppress that waiting episode until a new ask changes the question revision. Sort eligible rows by the current waiting-episode timestamp, then project/session and stable item order. Sent shows one row per input in `queued`, `in_flight`, or `needs_attention`, including generic non-answer requests, and links each row to its target question snapshot. A new ask on an item can appear in Waiting while an older input for that item remains in Sent.

Use the API's `SummaryCounts` projection consistently: `waiting_unanswered` drives global/project Waiting counts and the tray; `sent_inputs` counts inputs by `queued`, `in_flight`, and `needs_attention`; `items_by_status` is the separate raw seven-status count. Topic/session chips count nonarchived items before local search/filter. Footer shows visible and total scope. Archived topic counts stay in Archive. Inaccessible roots make counts partial and display an incomplete marker, never zero. These counts are not recomputed from whatever rows happen to be visible after filtering.

The early P4.3 read module publishes `WaitingStore`, `waitingRows`, `sentRows`,
`deliveryEvidence` and `WaitingPanel` over the merged renderer service. It pages
the complete registered catalogue, matches every snapshot to its backend summary
revision, preserves the last complete read on failure, and retains backend counts
and partial metadata. Composition supplies the shared `OpenSessions` cache,
registered reveal/session-open callbacks and optional real answer control;
without that control the panel is read-only. Stopping the reader removes its
subscriptions/poll and never closes another screen's session store. Current
delivery labels use the active attempt and persisted facts, including Waiting
for result during grace; no renderer timer creates Missing result or Handled.
Actual owner/draft actions, core/store/runtime composition and native Waiting
acceptance remain their original task joins, not completion through a scripted
transport.

## 3. Tree, detail, message rail, search, and filters

Build `childrenByParent`, `itemById`, `messagesByItem`, `roundsByItem`, and active-descendant counts once per changed snapshot. Sort siblings by stable numeric item reference while never reassigning references. Store topic order explicitly.

Determine initial expansion once per session view: active branches expanded, fully terminal subtrees collapsed. Persist explicit owner changes. Selecting an item hidden under a collapsed parent uses a temporary reveal path; it does not permanently reset the saved collapse choice. Rows show question and terminal outcome separately, soft-wrap full sentences, and never clip to a fixed height. Dimming applies to decoration, not to the whole row text. If an active descendant is under a terminal ancestor, show its count and reveal ancestry on selection.

Item detail renders full item history in two linked forms:

- **Back and forth:** ordered round cards, each with agent ask, owner choice and optional text (or free-text-only reply), agent result, related messages, and child items forked during that round. A new question is a child; refinement of the same decision is another round on the existing item.
- **Timeline:** deduplicated session-local messages with author, timestamp, excerpt, touched items, and origin/created/updated role. Message numbers are Ariadne provenance numbers, not host transcript line numbers.

The rail uses the same stored history, newest at bottom. Hovering a message highlights touched items; clicking pins that highlight. Selecting/hovering an item highlights its messages. Scrolling upward pauses follow; show `N new messages · Jump to latest`. Live updates never steal keyboard focus or scroll an owner away from older content.

Search normalizes NFKC and locale-independent lowercase for indexing only; stored text is unchanged. Every whitespace token must match the combined question, outcome, why, topic name, or message excerpt. It excludes transient provider activity, raw tool input/result, and credentials. Debounce 100ms. Status/topic/owner filters combine with AND; choices within one filter combine with OR. Include matching items and labelled contextual ancestors. No-results offers Clear search/filters.

Selecting from Waiting, Sent, search, tree, graph, archive, rail, tray, or notification calls a single `revealItem`: switch to project/session, load validated snapshot, select item, temporarily reveal ancestry, mark it outside current filters if applicable, scroll nearest, and open detail. Preserve filter values and offer an explicit clear action. Replacement/fork/source references use this route. If the item no longer exists, show its session and an explanatory banner.

Start with variable-height DOM rows memoized by item revision. Add virtualization only if the documented 2,000-item performance target is missed; virtualize the flattened visible list with measured heights and keep ARIA focus and scroll anchoring.

## 4. Graph

Render SVG for the selected topic. Use deterministic ordered tree layout: 190x66 px nodes, 254 px horizontal depth step, minimum 94 px leaf-center spacing, 32 px extra spacing between roots. Leaves follow stable item order; parent center is midway between first and last child. Parent edges are cubic curves from right-center to left-center. Replacement edges are dashed and labelled and do not participate in parent layout or cycle checks.

Keep viewport transform `{x,y,scale}` local to the view; clamp scale to 0.25–2.0. Wheel zoom anchors cursor, dragging blank canvas pans, Fit adds 32 px bounds padding. Tree/graph share item selection and filters. Graph selection opens the same detail. A two-line node preview is allowed; detail always shows the complete sentence. Accessible Fit/Zoom/Switch to tree controls mean graph is never the only route to an action.

Lay out the complete filtered topic when its structure or filter changes; pan/zoom
does not recompute geometry. Above 300 layout nodes, cull SVG elements to the
visible world rectangle expanded by 200 screen pixels divided by scale. Bucket
node bounds into 512x512 world-coordinate cells; retain intersecting nodes plus
the focused/selected node so focus survives a pan. For edges, use conservative
Bezier control-point bounds and the same bucket query, retaining an edge whose
bounds cross the viewport even if both endpoints are off screen. Deduplicate IDs
from buckets. Update transform and visible IDs once per animation frame; Fit uses
full layout bounds, never culled bounds. A remote selection first centers/reveals
the node, then focuses it. Culling affects rendering only, not counts, search,
ancestry or stored data. Test 2,000-node topics at multiple zoom levels, crossing
edges, selection off screen and tree/graph parity before accepting M5.

## 5. Owner input and delivery UI

The renderer uses these design operation symbols; the authoritative transport mapping (including snake_case Tauri/CLI names and continuation preview/commit) is in `API_AND_MCP.md`:

| Operation | Renderer use |
| --- | --- |
| `item_messages`, `item_rounds` | Load complete per-item timeline and round/fork history |
| `input.submit` | Persist any owner intent; return durable save and queue position |
| `input.resolve` | Resolve a delivery uncertainty barrier with an explicit choice and reason |
| `topic.archive`, `topic.restore` | Guarded topic metadata controls |
| `session.close`, `session.reopen` | Guarded Ariadne session metadata controls |
| `topic.continue` | Submit previewed topic snapshot to the selected target session |
| `binding.connect`, `binding.pause`, `binding.resume`, `binding.disconnect` | Display or request bridge lifecycle only |
| agent CLI/MCP `apply` | Agent-authored item/message/round/result updates; only path that changes item status |

The owner can queue an intent against any unarchived item in an active session, including terminal items: `bring`, `answer`, `reply`, `note`, `followup`, `drop`, or `reopen`. These are input requests, not item status mutations. A Replaced item offers Follow up and does not expose Reopen because it cannot be reopened in place. `Later` is local view state and is not submitted. The UI captures operation kind, target reference/revision, chosen option if any, text, and the owner-visible summary. It displays exact queue/delivery evidence from the bridge.

An answer has zero default selections. The owner may select exactly one option and add optional explanation, or submit nonempty free text alone. Recommendation is visually marked. Number keys select but do not send. `Cmd+Enter` submits the focused valid form. A button is always available. Double submission reuses the operation ID; the store serializes the operation. On save error, retain content and show an inline actionable error without moving focus.

Queue and delivery labels are input lifecycle labels, separate from item status: `Saved`, `Queued`, `Delivering`, `Delivered · awaiting agent receipt`, `Received · agent working`, `Reply published · agent working`, `Handled`, `Missing result`, `Delivery uncertain`, `Rejected`, or `Resolved`. Keep the input in Sent through receipt and published-result intermediate states, including uncertainty. Remove it only on handling (successful matching turn plus committed domain result), cancellation or explicit skip. Preserve the full conversation afterward. Do not infer receipt, work or completion from local acceptance or a running process; a matching turn establishes receipt, and only explicit agent domain writes change item status.

Per-session FIFO is maintained by the queue service. A definite pre-delivery rejection can be retried with its original operation identity. If delivery might have occurred, stop later inputs and require an explicit `input.resolve` choice; explain possible duplicate work, preserve the failed record, and resume only after resolution. Input resolution records the choice and reason. New owner inputs cannot silently reverse a Stop/pause state; binding resume remains explicit.

Continue is a topic-level owner action, not a shared topic mutation: prepare a snapshot of source topic/items/history, preserve original references and origin metadata, preview the grouped summary, then explicitly `topic.continue` to send it in a selected target session. The target receives a new local topic copy; source IDs remain navigable and immutable. Failure to write target copy leaves source unchanged.

## 6. Archive, sessions, and binding lifecycle

Archive and close are guarded metadata operations. Render the returned blocking item/input IDs and dispatch state from guard errors, with actions to navigate to the blocker:

- `topic.archive` is enabled only when every topic item is terminal and no `queued`, `in_flight`, or `needs_attention` input targets an item in it. Waiting items therefore cannot leave the global queue through archive. Handled, cancelled, and explicitly skipped inputs do not block. Restore uses `topic.restore` and preserves IDs/history.
- `session.close` requires every item terminal, no `queued`, `in_flight`, or `needs_attention` input, and persisted dispatch state `paused`. If dispatch is enabled, show an explicit Pause dispatch step; wait until the paused state is confirmed, then offer a separately confirmed Close action. Keep close disabled and show blockers while active items or inputs remain. It marks Ariadne metadata only; it never signals or terminates the terminal process. `session.reopen` reactivates the record without changing its binding or implicitly resuming dispatch.
- Tab close changes navigation only. It does not close a session, remove its project registration, or discard drafts.

Persist navigation through the canonical owner preferences: global
`selected_navigation` chooses Projects, All sessions, a registered project ID or
a registered SessionRef; per-session `tab_open` controls tab visibility without
deleting selection, expansion, filters, scroll or drafts. A rejected write keeps
the last valid view. Unknown completion retains the original operation ID and
exact patch for explicit same-operation reconciliation.

Manual connection explicitly chooses a new Ariadne session or an existing
registered session in that project. A fresh Claude conversation may attach to
Session X while retaining its topics, items and history; unfinished topics/items
do not block this choice. The native rebind guards still require an active target,
paused/disconnected old binding and no pending/running/unresolved inputs. The
backend handoff follow-up must prove historical structured owner-context visibility
at the connection snapshot and isolation of future unissued inputs; it does not
transfer host transcript/memory, copy old host authority or resume dispatch.

The reusable registration UI receives composition-owned installed adapter choices
`{adapter_id,label,configuration:AdapterConfig}`. They are presentation inputs,
not authorization or a new query contract. The owner supplies the explicit host
ID and typed endpoint; native core validates adapter/configuration/host identity
and may reject them as unsupported or unknown. Show saved setup instructions only
after a validated receipt, and keep rebind guard errors visible in the dialog.
Real candidate discovery/choices are a later native composition join; do not
invent candidates or infer ownership from read-only provider metadata.

Automatic provider discovery and manual project/session connection are both first-version paths. Discovery presents candidates for owner review and binding; private transcripts are not scanned. Read-only provider session metadata never establishes ownership by itself. Claude Mod and Codex queue/history bridges deliver inputs and report lifecycle; the agent sends explicit item/message/result operations through CLI/MCP. `binding.connect`, `binding.pause`, `binding.resume`, and `binding.disconnect` describe bridge lifecycle only. Disconnected/external states remain labelled as such. Do not claim the UI controls a host process.

## 7. Keyboard and accessibility

Keyboard navigation works when focus is outside editable controls:

| Key | Action |
| --- | --- |
| Up / Down or j / k | Previous / next visible tree row |
| Right / l | Expand or move to first child |
| Left / h | Collapse or move to parent |
| Home / End | First / last visible row |
| Enter | Open detail, expand/collapse topic, or activate focused navigation control |
| `a` | Focus answer control for waiting item; otherwise oldest waiting item |
| `1`–`9` | Select an answer option; never submit |
| `b` | Queue bring-up intent |
| `r` | Focus reply/note/follow-up editor based on item status |
| `d` | Focus drop intent; require explicit submit |
| `z` | Toggle local Later flag |
| `o` | Focus reopen intent for eligible terminal item; Replaced items offer Follow up only |
| `e` | Open guarded topic archive action |
| `/` or Cmd+F | Focus search |
| `g` | Switch tree/graph |
| `m` | Toggle message rail |
| Escape | Close top overlay/detail or leave editor without discarding draft |
| Cmd+Enter | Submit the currently focused valid owner input |

Roving tree focus uses visible row IDs and correct `aria-level`, `aria-expanded`, and `aria-selected`. All icons have labels; status always has adjacent text. Focus-visible is a 2 px accent outline. Dialogs trap and restore focus. Announce new waiting items and resolved inputs once through a polite live region; do not announce every message delta. Respect reduced motion and system appearance changes while theme is System. Verify contrast in both themes.

## 8. Native macOS service

`NativeService` owns window, tray, notifications, and open-route handling behind small interfaces. Native UI calls run on the app main thread. Register single-instance handling before other Tauri plugins and queue routes until the webview is ready. Window geometry, monitor identity, and pin are persisted and clamped to a reachable work area after display changes. Hide-on-close is distinct from Quit.

The tray uses a template icon, numeric `waiting_unanswered` count (blank at zero), oldest 10 eligible waiting entries with project/session labels, separate binding/lifecycle diagnostics, Show Ariadne, Pin, and Quit. Sent generic requests do not increment the task-question count. Coalesce rebuilds at most every 250 ms. If registered roots are inaccessible, show an incomplete count and diagnostic row rather than a false total. No approval action exists in the tray.

Use one native UserNotifications bridge in the macOS module with a single long-lived Rust `objc2` delegate. It owns permission request, schedule/remove, foreground policy, and click routing; do not initialize a second notification delegate. Notification identity is `ariadne:<session>:<item>:<waiting-episode>` and payload contains IDs resolved through the registry. Default body is generic; item text preview is opt-in. Deduplicate episodes in a bounded preference ledger. Establish a watermark on first launch rather than notifying the backlog. Group bursts over three arrivals within 500 ms; all entries remain in the queue. Denied notification permission leaves in-app queue working. Never put host permission approval controls in a notification.

Click focuses/unhides, restores a minimized window, and calls the common reveal route. Cold launch stores the route until app readiness. If the item was answered, open its current detail; do not fail routing. A quit app cannot report new external changes until reopened, but already delivered notification routes must work. Packaged click and cold-launch routing have native proof acceptance coverage in `DESIGN_TRACEABILITY.md`.

`ariadne open` resolves project/session and optional item route explicitly, locates the installed app from its package manifest, and passes structured launch arguments. Never place user-authored item text in a command line or shell string.

## 9. Renderer boundary and diagnostics

Use one production webview named `main` and an explicit capability allowlist for application commands/events and required window/dialog/clipboard actions. No remote origin capability, shell/fs/http plugin, devtools, test-driver plugin, or localhost listener in release. Production CSP allows bundled resources and required Tauri IPC only; no unsafe eval or external fonts/images. Render text as text, validate URLs/targets in Rust, and make links copy their target instead of launching navigation.

Rust validates every renderer command and enforces project/session/item membership, input kind, revision, request size, and allowed state transition. Scope every read/write to a registered project and bound session. Reject path traversal and symlink escapes at project registration/binding boundaries. Durable owner input is never removed by a renderer crash. Store/backend outage displays last-known data, disables mutations, retains draft, and offers recovery. Diagnostics redact known credential values/fields and auth-looking strings; default logs do not include owner text, raw provider activity, tool input/result, environment, or headers. Visible agent-authored sentences can contain project information; keep them local and do not promise arbitrary text redaction.

## 10. Security guidance provenance

The owner explicitly waived the review tool organizational guidance for this task. It was not checked. The renderer and storage constraints above are design requirements, not a claim that the guidance was reviewed.
