# UI state, rendering, and macOS integration

Use [DESIGN](../DESIGN.md) for exact source dimensions, colors and supplied reference screenshots. This document specifies component behavior and backend boundaries. New managed-session controls use the same tokens; they do not replace the primary tree with a chat-first layout.

## 1. Components and state owners

```text
AppShell
  Header: project/session identity, New session, runtime/permission indicators
  SessionTabs: Projects / All sessions / opened sessions
  Workspace
    GlobalWaitingPanel: permission cards, waiting questions, Sent
    SessionWorkspace: toolbar, topic/filter/search, TreeView | TopicGraph
    DetailRegion: ItemDetail | ConversationPanel
  Footer: relevant shortcuts, store/agent availability
  Dialogs: NewSession, ProjectTrust, Recovery, QuitActiveRuns, Settings
```

Header48px/tabs38px/footer30px; waiting300px, center≥560px, detail400px. Window minimum1000×700; reference1600×960. Waiting stays pinned; center/detail can overflow horizontally at narrow widths. Default detail opens for selected item; Conversation toggle swaps the same region. Project/all-session screens retain global queue and permission access.

| State | Owner / persistence |
| --- | --- |
| Session domain | Backend validated snapshots; frontend never saves a replacement snapshot |
| Global summaries | Backend cache keyed by project/session revision; incomplete roots explicitly flagged |
| Runtime status | Current worker events plus last persisted lifecycle state, with disconnected qualifier |
| Activity text/tool summaries | In-memory bounded ring per run; no duplicate private transcript store |
| Selection/expanded branches/tabs/filters | Per-session UI state in `~/.ariadne/preferences.json` |
| Answer/prompt drafts | Backend preference draft records, debounced250ms, flushed on navigation/blur; owner-only file permissions |
| Submission op IDs | Allocated once when Send is pressed, retained with draft until commit is resolved |
| Theme/window geometry/pin | Global preferences, versioned independently of domain |

Draft key: `(project_id,session_id,item_id,question_revision)` for answers; `(session_id,composer_kind)` for prompts. Preserve stale drafts with a changed-question banner; never automatically send after refresh. A draft is unsent data and is not visible to the agent. Cap total drafts at2MiB; on limit retain current in memory and explain persistence failure. No silent eviction of owner text. Closing a tab preserves its draft. Preferences corruption backs up the file and offers Reset UI preferences without touching sessions.

## 2. Snapshot/event synchronization

Subscribe before loading. Maintain one external snapshot store per opened session, exposed through `useSyncExternalStore`; render selectors from immutable validated snapshots. Keep local view/draft reducer separate. Invalidation causes a coalesced reload; if revision≤current, ignore. During reload, show existing data with a subtle updating state; replace only after complete validation. Preserve selected item, scroll anchor and focused input.

Backend watches parent directories, debounces75ms, validates changed snapshots and emits IDs/revisions. Reconcile on app focus, wake, watcher error and every2s. Normal watched updates target<1s; the2s fallback is explicitly degraded recovery. Summaries cache metadata and stat signatures rather than rereading every session on every React render. Selected session gets priority. A failed read marks that session stale/inaccessible; never silently resets count to zero.

Global Waiting is all `waiting_on_me` items in accessible registered sessions, sorted by waiting_since then project/session ID and numeric item ID. Pending permission requests appear in a distinct section above task questions. Tray's numeric count remains **task questions**, with a separate permission menu entry, so it matches the build requirement and avoids counting one operation twice. Sent includes outstanding delivery/receipt and uncertain entries; received items leave Sent and remain in their normal tree/detail state.

## 3. Tree/search/filter algorithms

Build `childrenByParent`, `itemById`, `messagesByItem`, `activeDescendantCount` in one O(n) pass per changed snapshot, with post-order accumulation for descendant counts. Siblings sort by numeric suffix. Topic order is explicit. Never reassign IDs for sorting.

Default expansion is determined once per session view: active branches expanded, fully closed subtrees collapsed. Stored explicit owner choices take precedence. An active descendant under a closed parent forces discoverable ancestry in a reveal operation, not a permanent reset of the owner's collapse choice. Rows show question and terminal outcome separately. Soft-wrap full sentences; no fixed-height clipping. Closed styling dims decoration while retaining readable text contrast.

Search uses NFKC + locale-independent lowercase for the **index only**, tokenized by whitespace; every token must match the concatenation of question/outcome/why/topic/excerpts. Stored text is unchanged. Debounce100ms; status/topic/owner filters combine AND, values within each filter OR. Results include matching items and their ancestors, labelled contextual when they do not match. Do not search provider raw activity or secrets. No results state includes Clear filters/search.

Selecting from Waiting/search/tray/notification calls one `revealItem` action: switch project/session, load snapshot, select item, temporarily expose its ancestors, mark it outside current filters if needed, scroll nearest, open detail. Preserve filter values; offer Clear filters instead of silently clearing them. Replacement links navigate to target through the same route. A missing item route opens its session with an explanatory banner.

Initial v1 uses ordinary variable-height DOM rows, memoized by item revision. If the2,000-item target fails, add virtualization only to the flattened visible list with measured row heights; keep keyboard/ARIA semantics and scroll anchoring. Tree layout itself must not depend on DOM geometry.

## 4. Graph algorithm

Use SVG per selected topic. Deterministic ordered tree layout: node width190px, height66px, horizontal depth step254px, minimum leaf center spacing94px. Lay out leaves in numeric tree order, place parent center midway between first/last child centers; separated roots have an extra32px gap. Parent edges are cubic curves from right-center to left-center. Replacement arcs are dashed, separately labelled and excluded from tree layout/cycle logic. No drag/reparent in v1.

Viewport transform is local `{x,y,scale}`, clamped scale0.25–2.0. Wheel zoom anchors the cursor; drag blank canvas pans; Fit computes bounds plus32px padding. Node selection updates the same selected item/detail as tree. Node preview may use two lines but detail always contains the full text. Graph filter/reveal scope matches tree semantics. Accessible HTML controls provide Fit/Zoom and Switch to tree; graph is never the sole path to an action.

## 5. Conversation and input queue

Conversation panel contains current run state, latest assistant text/tool activity, queued owner submissions, composer and Stop/Resume. Cmd+Enter sends; Enter inserts a newline. There is no Send-on-every-key behavior. New session chooses Claude Code initially; Codex is explicit. A model override is optional, not an assumed list of latest models; provider configured default is labelled accurately.

Immediately after durable save, clear the committed draft and display queue position. Before save succeeds, preserve it. Show `Saved`, `Queued · agent busy`, `Sent · awaiting acknowledgment`, `Received`, `Turn failed`, `Delivery uncertain`, or `Stopped · Resume to continue` according to backend evidence. Do not show a fake agent typing timer when only the queue changed.

A proven pre-execution rejection offers **Prepare retry**, then **Resume**; preserve the original queue position. A failed/interrupted/uncertain input that may have executed opens Recovery with **Resend this input** or **Do not resend; continue later inputs**, an explanation of possible repeated work, and a required decision reason. Explicit Resume follows either decision. Keep the original failure visible; skipping is not success. Resume is disabled while an earlier input still has an unresolved barrier.

Activity ring: max2MiB/run, keep latest complete records, evict oldest first, visible “Earlier live activity omitted” marker. Keep current text block in a bounded builder; blocks over64KiB are shown truncated in the transient view with explicit notice, not added to domain storage. Allowlisted content: owner-submitted text, assistant visible text, tool name, bounded path summary, running/completed/failed indicator, public usage estimate if available. Never persist/display hidden reasoning, raw tool inputs/results, arbitrary stderr, auth fields, headers or environment dumps in activity.

The owner may choose to inspect the full operation in a permission card, subject to request limits; that is a separate authorized display path. Diagnostic logs replace known credential values/fields and auth-looking strings with redaction markers. Visible assistant prose may itself contain sensitive project content; do not claim complete automatic redaction of arbitrary generated text. It stays local and is absent from default logs/telemetry.

On app restart, show stored prompt/answer history, agent-authored excerpts and run outcomes. Full past stream text is not reconstructed. Label the Conversation panel's live-only history accurately. If the owner scrolls upward, do not auto-scroll on new text; show Jump to latest. Raw host IDs remain secondary diagnostics, not primary labels.

## 6. Questions and permissions

Answer options are semantic radio choices/buttons with recommendation badge and consequence. No default answer is submitted. One selection plus optional free text, or free text alone. Send stays disabled until valid. Question revision changes preserve draft and require review. A double click reuses the op ID. Errors appear inline and focus stays in the editor.

Permission cards are visually distinct, identify run/project and exact operation/path, and offer Allow once/Deny; Escape dismisses detail without deciding. A native multi-question request uses one grouped answer form opened from any linked item, preserves per-question drafts and submits all displayed questions together. It retains request lifetime/expiry; expired responses are rejected clearly. Global permission count remains visible even with a different project or Conversation panel closed.

## 7. Keyboard and accessibility

Roving tree focus by visible row ID: Up/Down traverse; Right expands or moves to first child; Left collapses or goes to parent; Home/End first/last visible row; Enter opens detail; `a` focuses answer; `/` or Cmd+F search. Ignore these shortcuts inside editable controls. Escape exits overlay/edit focus without discarding text. Cmd+Enter sends only the currently focused valid answer/composer. Stop has a labelled button, not an ambiguous single-letter destructive shortcut.

Use aria-tree/treeitem levels/expanded/selected, labels for all icons, focus-visible outlines and status text beside shapes/colors. Loading/error notifications use polite live regions; permission/new-question notices are announced once, not for each stream delta. Dialogs trap focus and restore it to their opener. Respect reduced motion and system appearance changes while theme=System. Check text contrast and keyboard journey in both themes.

## 8. Native macOS design

`NativeService` owns window, tray and notifications through small interfaces. All native UI calls return to the app main thread. Single-instance handling is registered before other Tauri plugins and queues routes until the webview subscribes. [Tauri single-instance](https://v2.tauri.app/plugin/single-instance/)

Tray: template icon, numeric task-waiting title (empty when zero), menu oldest10 waiting items with project/session labels, separate permission count/action, Show Ariadne, Pin toggle, Quit. Rebuild/coalesce at most every250ms. If some roots cannot be read, show an incomplete-state marker and a diagnostic row rather than a false precise total.

Notifications use **one native UserNotifications bridge** in the macOS module, selected because click routing is required and Tauri's documented action callback is not established for macOS. Bind through maintained `objc2` framework crates; hold one delegate for app lifetime. The bridge owns permission request, schedule/remove, foreground policy and response routing. Do not also initialize a competing notification plugin delegate. Apple delegate API: [UNUserNotificationCenterDelegate](https://developer.apple.com/documentation/usernotifications/unusernotificationcenterdelegate).

Notification identifier is `ariadne:<session>:<item>:<waiting-episode>`. Payload is IDs only, resolved through registered projects at click. Default body is “A project has a question”; full question preview is opt-in. Deduplicate episodes in a bounded persisted preference ledger. Group arrivals within500ms into a summary if more than3; every item remains in tray/queue. First app load establishes a watermark and does not notify the entire backlog. Permission denial leaves in-app flow intact. Permission-request alerts use a separate category/count; never add approval buttons to OS notifications in v1.

Click focuses/unhides, restores a minimized window and routes to item; cold launch stores the route until app readiness. If item already answered, open its current detail rather than fail. App quit cannot notify about future external changes until reopened; existing delivered notifications still must route correctly when clicked. Packaged click/cold-launch behavior is proof M01; fix native bridge if necessary, do not drop required routing.

Persist window logical geometry, monitor identity and pin flag. On launch/screen change clamp to an available work area with a reachable title bar. Hide-on-close is separate from Quit. `ariadne open` resolves project/session explicitly, locates installed bundle from package manifest, and uses structured launch arguments; never interpolates item text into a command.

## 9. Renderer security and diagnostics

Single production webview `main`, explicit capability allowlist for named application commands/events and needed window/dialog/clipboard actions. Configure Tauri application-command permissions, not only plugin permissions; registered custom commands otherwise have broad defaults. No remote origin capability, shell/fs/http plugin, devtools, test-driver plugin, or localhost listener in release. [Tauri capabilities](https://v2.tauri.app/security/capabilities/)

Production CSP uses bundled resources and Tauri-required IPC origins only; no unsafe-eval, external fonts/images or HTML injection. Text/links are escaped; links copy their target. Rust validates every command even if the frontend already did. A frontend crash cannot clear pending answers or approve work. A backend/store outage shows last-known data with disabled mutation controls and a recoverable error, not endless loading.
