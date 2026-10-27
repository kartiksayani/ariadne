# Ariadne handoff — 2026-10-23

Claude Code on **Opus 5.5** maintains delivery. Team mode (ORCHESTRATOR): **Sonnet 5.5
(high effort)** does most implementation, including browser work; **Codex
(gpt-6.1-sol, high effort)** does pure-logic pieces its sandbox can test; **Opus 5.5
(high effort)** does only the critical pieces (send-once, typed text, storage and locks,
saved formats) and all reviews; **Haiku 5.5** does mechanical edits. Pieces run in
isolated worktrees with declared, disjoint paths. The maintainer integrates them and runs
one full gate on the combined head. Independent review uses a separate **Opus 5.5** context
at the exact head; one targeted re-review follows fixes. The owner authorized
pushes and squash merges with green `quality` and exact-head review. The maintainer
uses `gh pr merge --squash --match-head-commit <head>` and verifies main's tree
matches the PR head (`git diff --quiet <head> origin/main`). Test Ariadne behavior, not Apple window/menu mechanics; latency
is not a gate (ADR-0068). Keep the process budget in ORCHESTRATOR. Preserve worktrees,
branches and history; no force-push or open-source licence.

Codex jobs cannot run browsers, sockets, the app, native e2e or `git add`/commits, so
that work goes to Sonnet. Implementers run `npm run check` and targeted tests, then
hand back. The maintainer runs the full gate (Playwright, design frames and the local
native journey) once on the integrated head before push, and plans time for it. UI
designs come from Claude Design: the owner approves them (the approved board is
`designs/Ariadne-final-board.zip`), and implementation follows the board.

**Main: `37cdfc69` (#179). Alpha.23 released as
[`v0.1.0-alpha.23`](https://github.com/kartiksayani/ariadne/releases/tag/v0.1.0-alpha.23)**
(tag at `37cdfc69`). Alpha.22 is `v0.1.0-alpha.22` (tag at `66e7a3f8`, #177), alpha.21 is
`v0.1.0-alpha.21` (tag at `8ed87b66`, #173), alpha.20 is
`v0.1.0-alpha.20` (tag at `c5c8f6a9`, #171), alpha.19 is
`v0.1.0-alpha.19` (tag at `c87909da`, #169), alpha.18 is
`v0.1.0-alpha.18` (tag at `0336a903`, #164), alpha.17 is
`v0.1.0-alpha.17` (tag at `925c9645`, #162), alpha.16 is
`v0.1.0-alpha.16` (tag at `44158cbf`, #160), alpha.15 is `v0.1.0-alpha.15` (tag at
`10b6013a`, #159) and alpha.14 is `v0.1.0-alpha.14` (tag at `1135693c`, #155): a Map you
can follow, from #150 (`395736a2`), #151 (`bc7fa712`), #152 (`63295ec5`), #153
(`2bd09408`), #154 (`8a58f93c`) and #155 (`1135693c`).

## Alpha.23 released

[#179](https://github.com/kartiksayani/ariadne/pull/179), `37cdfc69`, "Nothing blocks you": a brief refresh, a timer or the app's own window fit no longer undoes or blocks what the owner just did. The release is a pre-release with the asset `ariadne-0.1.0-alpha.23-macos-arm64.tar.gz`, tagged `v0.1.0-alpha.23` on 2026-10-23 and installed on the owner's machine; both installed binaries match the package, and older helper versions are kept. CI was green on the first run. Saved data is unchanged from alpha.22. What changed for the owner:

- Clicks open at once, even on big sessions (F1). Clicking a row, or pressing Enter on it, opens it from the loaded snapshot instead of re-reading the whole session first, so there is no false "still loading… Try again".
- Send never silently does nothing (F2). Clicking Send while the agent is updating the session waits for that update, then sends once (`sendable`, and a read-only wait lock). The box holds the owner's text while it waits.
- What changed holds the rows it showed (F3). A row read elsewhere while the popover is open stays in place, dimmed, instead of disappearing and moving the list. This was the alpha.22 follow-up "the popover moves 45 to 52 px after opening": the 1 s seen-dwell on the item open in Details removed its row (53 px).
- Only owner-made window frames are saved (F4). A time-bounded `SaveGate` plus display-change and scale-change rules mean opening on the laptop alone no longer overwrites the size set on an external display, and unplugging it does not either.
- Reveal selected opens Details in both the Tree and the Graph (F5, P11.12; the owner chose this on 2026-10-22). The Back to pill does the same.
- The Map stops redrawing while idle (F6). Stores skip no-change publishes, and rows are reused and memoised. On a 2,000-item fixture, idle row renders went from 30,285 per 5 s to 0, and click-to-Details from 5.4 s to about 2 s.
- Version 0.1.0-alpha.23 (F7), and test follow-through (F8).
- Flakes fixed in the release: the native tree journey "row click refused…" and the native "Visible detail Reply did not save the exact owner text" (causes under Known flakes). One new first-occurrence flake is recorded: "Native Quit note observation deadline".

## Alpha.22 released

[#177](https://github.com/kartiksayani/ariadne/pull/177), `66e7a3f8`, "Fixes and fit": the follow-ups and owner requests after the three redesign releases. The release is a pre-release with the asset `ariadne-0.1.0-alpha.22-macos-arm64.tar.gz`, tagged `v0.1.0-alpha.22` on 2026-10-21 and installed on the owner's machine; both installed binaries match the package, and older helper versions are kept. Saved data is unchanged from alpha.21. It is the first release with its own version number (0.1.0-alpha.22), which Tauri accepted. What changed for the owner:

- Copy session ID on every session row, in All sessions and on each project's page, closed sessions included. The peek card waits a second before it opens on a resting pointer; clicking a name still opens it at once.
- The window fits the screen: it opens inside the visible area, the minimum width is 1100, and a window dragged partly off-screen is left where the owner put it.
- `/clear` keeps the session: the conversation reconnects to its Ariadne session on its own, and a stuck state says exactly what to do. Disconnect says so, with a note and Copy session ID, and the connection button reads "Connection…" when the session is off.
- The hover icons sit above the row, never over its title or the row above's buttons, and moving from one name to the next opens each one's card. Branch colours and the grey text and status pills on them are stronger in light and dark. Ack shows where it goes: "✓ Ack → Done" in Details and "✓ → Done" on the row.
- The Map keeps a fold or filter made just before a session switch, and never writes it to the wrong session. Changing text size or archiving the last topic at the very bottom no longer moves the row. A link clicked after a Graph node always wins, and `.` works in the Graph as in the Tree.
- What changed matches the board: icons, Before → after cards and the three buttons. The bin says "Empty", a long absence says "since Monday 18:10", the Back-to pill stays above the dock and Retry waits while an item is being removed. Screen readers keep announcing questions when one session cannot be read.
- Plugin and store: plugin messages no longer promise "it will keep trying" when they will not, and a stuck note cannot leave `/ariadne-connect` saying "already connecting". `ariadne doctor` waits for busy saved data, and the agent's `session_read` does not wait on the session lock. A brief disk error no longer sets the recovery file aside. A plugin that does not match the app is noticed and the top bar says what to run. An old Claude plugin is therefore noticed instead of running unseen.
- Process: an eslint rule against class selectors in tests, with a baseline that may only shrink; `scripts/check-previous-release.py` checks that the previous release still reads what this build writes (native CI, release scope).
- CI fixes made during integration, all test-side: the native window-size checks accept the visible screen when it is smaller than 1100×760 (the CI screen is 1024×768); the What changed popover structure test reads related positions in one call; the native tree row click (`selectRow` in `apps/desktop/tests/e2e/tree.spec.mjs`) waits for a ready session and retries one refused reveal. No retry fired on the green CI run.

## Alpha.21 released

[#173](https://github.com/kartiksayani/ariadne/pull/173), `8ed87b66`, "Details and the rest": the third of three redesign releases. The release is a pre-release with the asset `ariadne-0.1.0-macos-arm64.tar.gz`. Saved data is unchanged from alpha.20. What changed for the owner:

- Details: a new head (the path, Back and Forward on wide windows, Read in a bigger view, Focus, a "…" menu and Fold), and one "Changed since you looked" box with Mark seen. The actions sit in the body under the outcome. The conversation reads like a chat and opens at "New since you last looked". "Because you chose …" shows once, under the answer that changed things. Every message you send shows where it is (Sending…, Sent · waiting for the agent with Undo while queued, Picked up). The bigger view is a 760-wide column in place of the Map. Reply to topic opens the topic in Details.
- Notices and toasts: things you do confirm in one toast at the Map's lower left, with Undo where it applies. Notices sit under the topic band, newest on top, two at a time, then "N more" and "Dismiss all". A reply that has not reached the agent after 2 minutes gets a notice with Edit or Retry. Words not sent before a restart come back with a notice and a "Recovered after a restart" mark; nothing was sent.
- Connection: the dot by the session name always says where the agent stands, with a line above the Map when it changes what you can do. The dock says where your answers wait in each state.
- Remove, archive and the bin: before anything with your words in it is removed, you see the words, with Copy. A plain item goes at once, with 5 seconds to Undo. Removing a topic that continues in another session is blocked; archive it instead. The bin is a dialog (Restore, or Empty after seeing every word that goes with it). Archive always asks, then leaves one strip you can click to undo.
- Continue elsewhere: two steps (pick a session, then review and edit the summary). Esc keeps your edit. It sends once.
- Fixes: one session that cannot be read no longer hides the questions waiting in other sessions; ← on the Graph folds the node you picked even while the Graph is still revealing an earlier node; the agent is named "Claude Code" and "Codex" everywhere.
- Flakes fixed in the release: the `page-keys` test, the `itemNavigation` "undrawn Graph selection" test and the native Graph step `graph.spec.mjs` "← did not fold item 10" (a key against selection-save race).

## Alpha.20 released

[#171](https://github.com/kartiksayani/ariadne/pull/171), `c5c8f6a9`, "The Map": the second
of three redesign releases, built to the owner-approved Claude Design board. Tasks P11.36–P11.44,
with the fixes P11.22, P11.23 and P11.35 and the deflake task P11.26. What changed for the owner:

- The Map never moves on its own. The row being read stays put when the agent adds, changes or removes items, when a filter changes what is shown, when markers clear and when something opens above the Map, also at the top and bottom. If that row goes away, the nearest row takes its place. The topic band never covers it.
- New look: branches are nested boxes in five colours that survive adds, removes and restarts; a thread runs from the topic down to the selected item; every row has the same six hover buttons, greyed with a reason when they do not apply; long questions and outcomes fold at 3 lines behind Show more; folded branches say what is inside; hidden, filtered and outside-the-focus items show as one dashed line each.
- The topic band shows counts in words, Next unseen (`n`), Ack all, Focus (⇧F), Continue elsewhere and a "…" menu. Ack waits 6 seconds with Undo before it saves, everywhere; Ack all lists the items first and keeps Undo for 8 seconds.
- A row of filter chips replaces the filter menu, in the Tree and the Graph. The picks for To ack, Sent, Blocked and Later are kept outside the saved file.
- "N new, N changed since" in the band opens What changed. Recent (the clock button) lists what was viewed and what changed. New and Changed markers clear only after a one-second look in Details or the answer dock with the window in front; peeking, hovering, searching and scrolling never clear them.
- Graph: one trunk per topic, right-angled lines, the path to the selected item in blue, a legend, and folded nodes that say "+N · N waiting".
- Peek: hovering a name shows a card to answer from in place. Peeking never marks anything seen, and a hover is not a Recent visit.
- Removed: the breadcrumbs row, the Focus button on each row and the hover icons on the topic band.

Late fixes in the release: the Map hold no longer drifts after a jump (`.`, Next unseen, a search step or Show more) on a slow CPU; a Peek card opened by a click survives Details scrolling itself; a clicked row always opens while the Recent list is saving, and its selection is saved when that finishes; the `page-keys` test is deflaked; the CI native mocha budget is 900 s instead of 480 s, because CI runs it about 1.7 times slower than a local Mac. The fair store lock (P11.22, P11.23), the silent Send fix (P11.35) and the load-flake fixes (P11.26) shipped in it too, and a session reconnecting right after the Mac wakes now waits up to 2 seconds for the old connection to let go ([ADR-0102](../adr/ADR-0102-replacement-waits-for-own-binding-lease.md)).

The local full gate (static, coverage, design, and native 6+4 blocks) was green on `ca6fbc1c`, with Opus reviews per piece and per fix. The release was installed and checked. Saved data is unchanged from alpha.19.

## Alpha.19 released

[#169](https://github.com/kartiksayani/ariadne/pull/169), `c87909da`, "The window": the
first of three redesign releases, built to the owner-approved Claude Design board
(checks against the final board landed in
[#167](https://github.com/kartiksayani/ariadne/pull/167), `65484aca`). Tasks
P11.28–P11.34. What changed for the owner:

- No tabs, header or footer. A top bar holds a switcher (⌘O) for projects, sessions and their waiting questions, and the pages Projects, All sessions and Archive. All sessions rows have Rename, Close and Archive. Archive rows open the session to read without restoring it; an archived session's card says "Restore session".
- The connection card (the "Live" chip) holds Sending…, Close session, Restore or Reopen session, and Copy session ID. A failed copy reads "Couldn't copy". Copy instruction is hidden when there is no setup receipt.
- The answer dock replaces the Waiting column. It floats over the Map and Details, opens with `[`, `]` or the "N waiting" pill, and can be dragged to any height. Number keys pick an option; ↵ or ⌘↵ sends (⌘↵ only when focus is in the dock). The dock path ends at the parent; clicking the question's title, or focusing it and pressing Enter, opens it in Details.
- One answer per question. Undo works only while the answer is queued. A busy agent's answer reads "It goes when the agent is free".
- A failed send keeps the owner's words, with Copy and Retry. Cancel message, Mark as done and Stop waiting reopen the cards with the words and choice. If the agent may already have the answer, Send asks "Send again?" first.
- After a handled answer, "Add a reply" (or `r`) adds more words.
- Details folds to a rail (» or the rail); its width and fold are saved outside the saved file. Opening an item (click, Enter, `r`, ⌘[ / ⌘]) unfolds it; arrow keys through the Map do not. Nothing is marked seen while it is folded, and the rail shows a marker for something new. The reading row stays put when Details folds, unfolds or is resized.
- Keys act on the selected item only; on a page they do nothing to the Map. Removed: ⌥0, ⌘J (use `.` to return to the selected item), `e`, `w`, and `h` / `l` folding. `a` only acknowledges. Back in alpha.24 at the owner's request: Hide is `x` again (not `h`), ⌥1–9 picks option N of the selected waiting question and sends it at once (ignored in text fields; refused, and the key consumed, while a hover peek shows another item or Details shows a topic conversation), and ⌥↑ / ⌥↓ scroll Details (a tap is under a tenth of its height, holding scrolls smoothly until the keys come up; every press and key-repeat is consumed so WebKit never pages the Map, even when nothing scrolls; text fields and open menus keep the keys).
- First run says to register a project folder before a Codex setup instruction can be copied.

Differences from the board, kept on purpose:

- A failed send keeps Mark as done, Cancel message and More options, so a stuck message is never a dead end.
- A project page keeps "Connect existing session", which is how a Codex session connects.
- First run offers "Register a project" where the board shows "Copy instruction", because there is nothing to copy before a project exists.
- "Disconnect" versus "Close session" and "Copy session ID" (board 12.1) waits for release 3 (connection states).

Decisions made while integrating: a click on a Map item unfolds folded Details but keyboard
moves do not, so the Map never narrows without an owner action; the text scale defaults to
80 for fresh installs and saved values are untouched. The design harness asserts 37 board
states by region at 0.1–0.6 %, the old v2 frames are retired, and about 300 UI, e2e and
native tests were migrated with their assertions kept. Two Opus reviews found 12 defects,
each fixed with a failing-first test; a targeted re-review said ship and its two minor gaps
are fixed. The full local gate passed (Vitest 3933/3933, design 261/261, build, cargo and
native 10/10 blocks). The release-boundary check ran in CI, because the owner's app is open
locally. Saved data is unchanged from alpha.18.

## Alpha.18 released

[#164](https://github.com/kartiksayani/ariadne/pull/164), `0336a903`: a hotfix. Tasks
P11.15 and P11.16. It was installed and verified on the owner's Mac. What changed for the
owner:

- The same release also carries [#165](https://github.com/kartiksayani/ariadne/pull/165) (harness: team mode) and [#166](https://github.com/kartiksayani/ariadne/pull/166) (shell seams: groundwork for the redesign; nothing visible changes).
- An idle session no longer fills up with repeated background hook notices.
- Each conversation keeps one health record, and every hook call records exactly one outcome. A producer counts from its first outcome until it is explicitly retired (loop stop, binding end, qualify, reset).
- A call open more than 10 s counts as a transient timeout.
- Ranks: terminal > install > owner-needed held > generic held > transient. Urgent conditions print at once. Transient and generic held conditions get a 2-minute grace. Recovery takes 3 successes.
- A broken install (SIGABRT, SEGV, BUS, ILL) speaks at once. SIGKILL is transient.
- Each error code has a plain hint. `store_busy` is retryable, and only it.
- Reads ride out a busy store: 5 s for the agent CLI, owner queries and MCP; 2.5 s for plugin reads. An attempt starts only if it still fits the budget.
- The claim check reads the committed file without the lock (`Store::peek`, a small cache), then decides again under the lock. Decision: [ADR-0101](../adr/ADR-0101-lock-free-claim-check-and-busy-read-retry.md).

Install check: the app and CLI were identical to the package (`cmp`), and the running
alpha.17 app was left untouched. The follow-ups it left are tasks P11.17–P11.27 (see Next
steps).

## Alpha.17 released

[#162](https://github.com/kartiksayani/ariadne/pull/162), `925c9645`: Map fixes from the
owner's alpha.16 feedback. Task P11.9. What changed for the owner:

- The topic brief wraps as one line of names instead of one per line.
- The collapse chevron is a visible chip with a larger caret.
- The filter button sits in the Recent row, and in the Graph legend row beside "Reveal selected". When a filter leaves no topics to draw, the Graph keeps a bare row so the filter can still be cleared.
- The thread rail runs unbroken through topic cards.
- The Graph folds hidden items into an "N hidden" stub, with the Tree's hidden semantics: stubs on the selected item's route open once per selection change, the owner can fold them, folds survive re-renders and live updates, and a selected hidden item is drawn. Stubs join the keyboard roving tab stop.
- Unfocus sits on the focused item's own button and the "Focused:" banner is gone. A sticky Unfocus shows whenever that button is not mounted or not visible (filtered out, topic folded, scrolled under the band). Hiding the focused item ends Focus.
- With nothing to catch up on, a check in the brief header replaces the "All caught up" box.
- The Graph scrolls only on owner actions. One invariant, tested as a 60-row table (6 starting states × 10 non-owner events): the Graph scrolls on first open per store, outside reveals, Reveal selected, and the owner's own click or key. A scroll request is used in its own commit or dropped, so a stale one never fires later on a filter edit, unfold or live update. A plain selection change keeps the scroll position.
- Reveal selected brings an undrawn selection in through the registered temporary route, as the Tree does. When a focused node or stub disappears, focus moves to the nearest survivor, never the page body.

Three review rounds each found a scroll or fold regression introduced by the previous
fix. That is the origin of the "UI side effects get one invariant" rule in
ORCHESTRATOR. The follow-ups it left are tasks P11.10–P11.14 (see Next steps).

## Alpha.16 released

[#160](https://github.com/kartiksayani/ariadne/pull/160), `44158cbf`, "Item conversation
view" (task P11.2). The owner signed off mock M3. It is a larger view of one item's
conversation, with Waiting beside it. There is no session-wide Conversation view and no
reading of host transcripts. Chat with the agent stays in the terminal. #161 (`d937eb1c`)
added the harness rules and the alpha.15 records.

## Alpha.15 released

- [#156](https://github.com/kartiksayani/ariadne/pull/156), `91bf3537`: `/ariadne-pr-comments`. Owners choose Fix, Reply or Skip for each imported review comment.
- [#157](https://github.com/kartiksayani/ariadne/pull/157), `6101ba93`: alpha.14 follow-ups (Ack all and Go to edge cases, faster large Maps, steadier CI, release records).
- [#158](https://github.com/kartiksayani/ariadne/pull/158), `914b4374`: the Messages pane is removed and the Map holds the reading row through resizes. Unsent-message notices live in a separate recovery file, so alpha.14 can still read preferences.
- [#159](https://github.com/kartiksayani/ariadne/pull/159), `10b6013a`: the recovery file survives disk errors, reads never fail because of it, and notices can always be dismissed.

## Next

**The UI is being redesigned** in three releases from the owner-approved board. Mockups
are made in Claude Design, the owner approves them, and only then does a redesign get
built.

1. The window (answering, Details, top bar): alpha.19, released.
2. The Map, including what changed and peek: alpha.20, released.
3. Details, dialogs, notices and pages, with connection states: alpha.21, released.

## Next steps

Alpha.23 closed the alpha.22 follow-ups list (the native tree row click and the native Reply flake are fixed; the saved window size over an external display is fixed by F4, with the owner hardware check below) and finished P11.12 (Reveal selected opens Details in both views). Item 1 is the follow-ups carried to the next release (alpha.24); the owner picks the order.

1. **Follow-ups carried to the next release** (none blocks it).
   - After `.` or Enter, the keyboard focus ring hides: in `TreeView.tsx` the selection effect runs `setKbd(false)` on the view's own reveal echo. Decide whether keyboard selection should keep the ring.
   - `ui/tree/model.ts` `sameValue` treats Sets, Maps and Dates as equal. This is latent, since no row field holds one today. Recurse only into arrays and plain objects.
   - Owner hardware check for F4: put the window on the external display, unplug it, wait more than 2 s, quit, replug and relaunch; it should open on the external display at the owner's size. Also drag the window between a 2x and a 1x display and relaunch.
   - After install, check whether `/reload-plugins` alone loads the new plugin and whether it fires `session.end`. Pending the owner's report.
   - F6e residual: `disabled` flips on all rows during a view write, so a click causes two full-row redraws.
2. Follow-up from #162, a small task: P11.14 Flake watch for `tests/integrations/claude/register.test.js` (see Known flakes).
3. Watch the Known flakes list below; a second occurrence gets fixed before the next merge.

## Process lessons

- `quality` runs on push only. Before merging a PR whose base is behind main,
  merge main into it and let CI run on that head. The tree-equality check presumes
  the PR includes current main; verify the merged tree against that head.
- Run `cargo test --workspace` before pushing integration-resource changes.
  Installed-plugin fixtures live in several crates, so a CLI-only test run is
  insufficient for that push.
- Fix rounds, moved UI code, saved formats, CI parity and flakes follow the
  ORCHESTRATOR rules under "Delivery feedback rules" ([ORCHESTRATOR](../../ORCHESTRATOR.md)).

After merge, tag `v0.1.0-alpha.N` with `-m "Ariadne v0.1.0-alpha.N"`, wait for the
release workflow and edit notes with the fixed
[How to upgrade block](../planning/PERSONAL_RELEASE.md#release-notes).
Refresh this page, tasks.json and the roadmap chart using
`python3 scripts/regenerate-roadmap.py`.

## Known flakes

One entry per flake: the test and its first failure, the evidence, and the suspected cause. A second occurrence gets fixed before the next merge (ORCHESTRATOR, Flakes).

- **Native Quit note observation deadline (`scripts/native-quit-note.mjs:145`, the delivery phase).** First occurrence; not fixed.
  - First failed: local alpha.23 integration run, 2026-10-22, under machine load. A rerun passed 10/10 blocks and CI native passed.
  - Suspected cause: the System Events accessibility inspect is slow under load. No alpha.23 change touches quit.

- **Native tree journey, row click refused with “still loading this session's latest changes” (`apps/desktop/tests/e2e/tree.spec.mjs`, `selectRow`).** Fixed in alpha.23 (#179).
  - First failed: alpha.22 integration CI at 1024×677, 2 of 3 runs. Never on main at 1300 wide. Alpha.22 added a test-side retry in `selectRow`.
  - Cause: the row click joined a full session re-read inside a 5 s race. It now opens from the loaded data (F1).
  - Pinned by a held-read vitest and `tests/e2e/tree-layout/row-opens.spec.mts`, both deterministic.

- **Native journey, “Visible detail Reply did not save the exact owner text” (`runRecoveryAcceptance`).** Fixed in alpha.23 (#179); seen on main since alpha.11.
  - A Send click was lost while the text and Send stayed enabled.
  - Cause: Send was disabled or refused during each `stale` publish. It now waits for the refresh (F2).
  - Pinned by the refresh-overlap send test in `readiness.test.tsx`, which is deterministic.

- **`apps/desktop/tests/ui/tree/component.test.tsx`, “waits for a stale session before selecting with click”.** Fixed in #162 (released in alpha.17).
  - First failed: local #162 coverage gate, 2026-10-15. Selection completed and was saved, but the final notice assertion expected zero notices and saw one (then line 647); an unchanged full coverage rerun passed. Second occurrence: the owner's full coverage run on the same working tree, also 2026-10-15 (about 60 s for the file with `--maxWorkers=3`).
  - Cause: the new “keeps a sticky Focus exit when pending removal unmounts the row” test left a `RemovalQueue` operation in its five-second Undo window. Component cleanup and `notices.clear()` did not cancel its timer. The timer later called `RemovalQueue.fire` → `note`, then `execute` → `note`, pushing `remove:<operation-id>` into a later test. Captured text: `Removed “Keep the full reply…” and 1 item below it. demo.local was told and won’t bring them up again.` This is a fixture leak introduced by this PR; production removals correctly survive view unmounts. Geometry mocks, Focus effects and TopicChanges were not the source.
  - Comparison: four whole-file coverage runs on an exact `origin/main` export (`44158cbf`), plus a run with 200 stale-selection cases, passed under three-process load. The main-source controlled selection case also retained zero notices after the five-second deadline. Ordinary loaded runs did not reproduce the failure; controlling the leaked timer reproduced the saved-selection-plus-one-notice state deterministically.
  - Fix: register fixture removal queues during mount, undo every pending operation and await already-sending commands in shared teardown before clearing notices; restore mocks/globals and clear fake timers before returning to real timers. “does not leak a pending removal into a later stale selection” exercises that teardown with fake timers installed before mounting. Removing just the pending-operation cleanup makes it fail with the captured removal notice, while selection `3` is already saved. “waits for a sending removal before teardown clears its notices and timers” gates an in-flight command and fails if teardown omits the wait. No product change, added delay, retry or relaxed assertion.
  - Validation: ten post-fix whole-file coverage runs passed (199 tests each; 1,990 total; zero failures), three concurrent Vitest processes, each using `--coverage --maxWorkers=3` with separate report directories; 48–58 s per run. The regression was also checked with the cleanup removed and failed deterministically. `npm run check` passed. The exact full coverage command with `--maxWorkers=3` completed in 158.22 s: 120 files / 2,538 tests passed; only `tests/ui/reference/assets.test.ts`, “serves each local resource through Vite unchanged”, failed with “Server is not running.” (the permitted localhost-socket sandbox exception). An earlier attempt overlapping all three file processes with the full suite exhausted unrelated test timeouts; those runs were stopped and do not count toward the ten-run proof.

- **`tests/integrations/claude/register.test.js`, "admits claims again after an owner command is refused".** Fixed in P11.26.
  - First failed: local #162 full coverage run, 2026-10-15. Line 780 waited for 2 matching calls and saw 1. Task P11.14.
  - Evidence: the file passed 3 times in a row on its own. #162 does not touch the Claude integration.
  - Cause: the `vi.waitFor` default limit is 1 s. Fix: the `claude-mod` project's `setup-timeouts.js` makes the default 10 s (a caller's own limit still wins) and its test limit 30 s. A wait returns the moment its callback passes, so only a wait that cannot succeed takes longer.

- **`tests/e2e/tree-layout/tree-layout.spec.mts:442`, "Map look: continuous rails, clamp threshold, reserved selection tags and clear reveals" (light theme only).** Fixed in P11.26 (cause not reproduced locally).
  - First failed: #164 CI run 38894984785, 2026-10-16. `.tree-path > .tree-selected-slot .tree-selected-edge` was not found within 5 s after `expectRevealedRow` (about line 577). The dark run passed. #164 does not touch the Map.
  - Fix: `expectRevealedRow` now also waits for the scroller to be still for three animation frames, so a test's hand scroll cannot land inside the reveal's own correction (the held row is put back after each reflow). The Playwright `expect` limit is 20 s instead of 5 s (`tests/ui/design/playwright.config.ts`). Under load 45 to 190, 20 of 20 and 36 of 36 runs passed; a different 5 s `expect` ("Getting around ... (light)", Peek dialog) failed once before the limit changed.

- **Load flakes in the alpha.18 integration gate (2026-10-17), first occurrence each.** All passed alone, so they are load-sensitive, not broken. Task P11.26. Fixed in P11.26 except `claim_contention` (P11.23).
  - Cause and fix, all of them: a wall-clock budget raced real work on a busy machine. Rust: `ariadne_agent_protocol::deadline_scale::scaled` stretches the adapter, doctor, control-socket and Claude-qualification budgets by `ARIADNE_TEST_DEADLINE_SCALE` (1 to 100); release builds ignore it (`cfg(debug_assertions)`), so product budgets are unchanged. The Codex queue/history, doctor, `claude_installed_join` and composition tests set it to 10 and wait on their conditions with 30 to 60 s hang guards. Vitest: test limit 30 s, `waitFor` 10 s, and the per-describe 10 to 20 s limits removed.
  - Load reproduced locally: `queue.rs` failed 8 to 9 of 28 at load 100; `claude_installed_join` failed 2 of 3 copies under 40 CPU hogs (a Node helper killed at its 8 s limit); `itemNavigation` and `App.test.tsx` failed on their 10 s limits. After the fixes all passed at load 40 to 190.
  - `crates/ariadne-cli/tests/doctor.rs`: `doctor_warns_in_plain_words_when_codex_has_not_loaded_the_selected_thread` and `executable_doctor_qualifies_only_the_existing_codex_daemon_and_exact_thread` failed in `cargo test --workspace` and passed alone (28 of 28). Same family as the `ariadne-adapter-codex` `queue.rs` "Codex version probe timed out" load flakes.
  - `crates/ariadne-cli/tests/claude_installed_join.rs` fails when 3 copies run at once (load-sensitive deadline asserts around lines 278, 667, 693 and 741) and passes alone.
  - `apps/desktop/tests/ui/inputs/owner-input.test.tsx` (two tests), the `App.test.tsx` reveal test and `crates/ariadne-adapter-codex/tests/queue.rs` also fail under load.
  - `itemNavigation` "keeps Waiting, linked and history reveals…" and "reveals native item routes again…", and the tree component test "never scrolls when status chip dismisses…", failed in the gate and passed alone (236 of 236).
  - Not a flake: `conformance.rs:532` failed because a non-interactive shell's background job inherits SIGINT as ignored, so the fake child exited 0. Fixed in `fc090d91`: the test binary is the child, and it resets and raises the signal.
  - `claim_contention::pollers_and_readers_together…` fails at load 15–45 on a shared machine (task P11.23). CI on a quiet runner passed.

- **`crates/ariadne-adapter-codex/tests/queue.rs`, "Codex version probe timed out" under load.** Second occurrence; fixed in P11.26.
  - First listed with the alpha.18 load flakes above. Failed again 3 times in the alpha.19 gate (2026-10-17) with no crate change since the previous gate passed.
  - Cause: `identity.rs` gives the stub `--version` 5 s of wall clock, and a busy machine takes longer than that to start `sh`. Fix: the budget goes through `deadline_scale` (see the load-flakes entry); `history.rs` also warms its stub once, outside any deadline.

- **`cargo llvm-cov` coverage run, `composition::tests::wake_replaces_activation_only_after_old_monitors_exit_and_requires_fresh_bound_evidence` (`mod.rs:389`).** Fixed in the product (alpha.20, [ADR-0102](../adr/ADR-0102-replacement-waits-for-own-binding-lease.md)).
  - First failed: #169 CI coverage run, 2026-10-17. PermissionDenied: "Another desktop or supervisor holds this nonblocking lease". `src-tauri` is untouched by alpha.19.
  - Cause: line 389 is the bound announcement. It starts a replacement activation that takes the binding's nonblocking lease, and a request or blocking call the old activation started can still hold a lease clone just after `reconcile_after_wake` returns. A lock probe in the test saw it busy once in 40 runs at load 40. Fix: a replacement activation waits up to 2 s, within its deadline, for this desktop's own earlier lease to be released, then returns the retryable `store_busy`; another holder is still refused at once. The test no longer waits for the lease itself.

- **Native journey recovery step under load.** Waits widened in P11.26; root cause not reproduced (native runs are gate-only).
  - First failed: alpha.19 gate 2, 2026-10-17. `runRecoveryAcceptance` waited 10 s for `button=Sending…`. The failure screenshot shows the card open with Sending… present. It did not reproduce when rerun alone (2 of 2, then 3 of 3).
  - Likely related to P11.35 (silent Send in Details under load).
  - Done: WebDriver element waits (`waitforTimeout`) are 30 s instead of 10 s, every native `wait` is 60 s instead of 20 s, and the accessibility repeated `r` press now waits for the same readiness as the first (the first press already did). Not done: the native Graph step "Tree must show the same filtered items as Graph" has no known cause; it now has the 60 s wait. If it or the Sending… step fails again, capture a screenshot and the tree HTML before widening anything.

- **Design harness first load: `tests/ui/design/design.spec.mts` `openApp`'s 60 s `waitForFunction` for the app to render.** Fixed in #160.
  - First failed: #155 CI. Failed again: #160 CI, "M2 chosen answer and attributed topic lists (dark)" (line 271), one of the first tests a fresh worker runs. Both times a first-load timeout.
  - Cause: each worker started its own Vite dev server with no warm-up, so the first test paid for the cold transform of the gallery app and the dependency optimisation inside its 60 s render wait. Vite's default dependency scan also crawled every html file under the repo. Two workers did this at once on a slow runner.
  - Fix: `tests/ui/design/server.mts` starts the server with the dependency scan limited to `gallery.html`, then transforms the gallery's import graph and waits for the server to go idle before it resolves. `setup.mts` (global setup) runs it once before any test, so the dependency cache exists, and each worker's `origin` fixture runs it again to warm its own server. The test timeouts are unchanged.
  - Checked: a full `npm run test:design` from a cold start (Vite's `node_modules/.vite/deps` cleared) passed, 114 of 114.

- **`tests/e2e/tree-layout/tree-layout.spec.mts:585`, dark theme only.**
  - First failed: #158 CI, 2026-10-14. The rerun passed.
  - The check that the child sits under the sticky header failed after the test set `scrollTop` by hand.
  - Suspected cause: a ⌘J reveal was still settling.
- **`apps/desktop/tests/e2e/tree.spec.mjs:604`.**
  - First failed: #157 CI, 2026-10-13. The rerun passed.
  - A click right after a keyboard Enter selection was never saved.
  - Suspected cause: a click landing while a selection save is in flight.
- **Native delivery journey, "Detail Reply text and enabled Send were not ready for one click"** (`apps/desktop/tests/e2e/owner-reply.mjs`).
  - First failed: #159 CI, 2026-10-14. The rerun passed.
  - The fake agent changed the item (revision 3 → 4) while the test typed, so the stale-question guard disabled Send. The app behaved as designed.
  - The cause is known, and it broke the rule that native journeys never race agent-side changes, so it was not a flake to wait on. Fixed in #160: the journey freezes the completed publication (`ownerReplyTarget`) and waits for the app to show that target before typing.
- **`crates/ariadne-core/tests/native_connection.rs` `expired_fresh_work_cannot_persist_after_waiting_for_registry_lock`.**
  - A local hang under heavy load, not a required check, so it is outside the Flakes rule.
  - First failed: a local run on 2026-10-14, where it hung for 45 minutes under heavy load.
  - It then passed 8 of 8 runs on its own.
  - Suspected cause: thread timing under CPU starvation in its lock-and-channel handshake.

## Earlier delivery evidence

### Paperwhite checkpoint (2026-10-07)

**Main: fddd998 (#134). Roadmap: 58/58 done; P8.11 (remove commands) merged in #125, P8.12 (short labels) in #131 and P8.13 (host location and topic counts) in #133 and #134.** P8.3 is done as the Paperwhite redesign (ADR-0086): work packages #126-#132 and the finish #136 sit on `feat/paperwhite-integration`, and its integration PR to main is pending. `npm run test:design` is the fidelity gate (thresholds = measured + 0.01). Follow-ups: rewrite UI_AND_NATIVE for the Paperwhite UI; fidelity of frames 1m, 1z, 1w and 1ac. Continue is one picker, `ui/dialogs/ContinueTopicDialog.tsx`, which the tree and the other entry points share; the old `components/history-actions/ContinueDialog` is gone. Topic folds are saved in the session preferences (`collapsed_topic_ids`, at most 256 kept) and survive a restart; the Waiting column's fold is saved in the global layout (`waiting_collapsed`), folds by itself below 1300 px without sideways scroll, and the `w` key toggles it. Still open: a Rust `ExitRequested` flush for pending removals; the removal `expected_revision` is read at run time, so agent edits in the undo window are removed silently. P8.1 (release evidence) is done in #118; P8.2 (prebuilt alpha package) is done in #117 and the `v0.1.0-alpha.1` pre-release is published ([release](https://github.com/kartiksayani/ariadne/releases/tag/v0.1.0-alpha.1), workflow run 37523466225).

#109 was squash-merged as 1906583 at head ed56f7d after quality run 37411039163; #110
(docs, install-trial evidence and README updates) as a2cfa9d at head 72dd525.
At the #110 checkpoint, no open PRs were recorded. The release install trial ran on main 1e8d9e7; its green `quality` run is [37511788713](https://github.com/kartiksayani/ariadne/actions/runs/37511788713). P8.1 is done in #118; manual release checks still need the owner’s date, tester and results for V11, V21 and V24 in the [verification contract](../planning/low-level/VERIFICATION.md#required-acceptance-matrix). Duplicate and
out-of-order event handling (P7.1 acceptance) is proved in core and CLI tests
(`crates/ariadne-core/tests/history_actions.rs`, `tests/functional/acceptance/parallel_cli.rs`)
rather than the native journey.

## Local native journey is the fast loop

`env -u NODE_USE_ENV_PROXY node scripts/run-native-e2e.mjs` in a worktree runs the whole
native journey (build, delivery, Quit, restoration, release boundary) in ~8 minutes on
the owner's Mac. Run it directly with `node`, not through `npm run` (a wrapper makes Node
print a proxy warning that a fixture treats as failure). CI takes 35–55 minutes and
stops at the first failing step; run locally first, fix everything, push once.
Evidence lands under `coverage/native-e2e/<uuid>/{delivery,restoration}/` (wdio.log has
the failing step; `history-failure-<label>.json` has DOM evidence for wrapped waits).

Embedded driver facts (vendor/tauri-plugin-wdio-webdriver): click = DOM
scrollIntoView + `el.click()` + focus; wdio `scrollIntoView` is a no-op; `<option>`
clicks do not change a select (set value via native setter + bubbling `change`);
synthetic keys do not move focus.

## State after #109

- P6.4: the isolated install, doctor and uninstall trial passed on the ed56f7d tree.
- P7.1: evidence is the green full-scope `quality` run on main a2cfa9d,
  [37418522364](https://github.com/kartiksayani/ariadne/actions/runs/37418522364)
  (dispatched by hand because the push of #110 cancelled the run on 1906583; pushes
  to main cancel the previous main run, and a docs-only push runs the docs scope).
- #109 run 2 failed only on the reference-capture first-load wait (fixed in ed56f7d).
  If it recurs as a ~31 s failure, set `optimizeDeps.entries` on the test's Vite server
  in `tests/ui/design/design.spec.mts` (the design harness, `npm run test:design`).
- Worktrees under `.worktrees/` (preference-conflicts, host-version-tolerance,
  toolchain-minimums, doctor-first-run, release-handoff, codex-skill, readme-for-users)
  are contained in main; keep them. Superseded stack PRs #93, #94, #97, #98, #99,
  #101, #103, #104 and #105 are closed, branches kept.

## P7.2 live Claude run (2026-10-06, PR #114)

The core owner-input to Claude turn to committed-result loop is proved live on Claude
Code 2.1.291. P7.2 is done by owner ruling 2026-10-06 (no further paid host turns; core
loops proven). Deferred rows: completion-before-result order, result repair, resend,
second session, second project isolation and Ariadne app quit/relaunch;
`npm run test:live` does not exist. Decision: [ADR-0076](../adr/ADR-0076-claude-framed-plugin-prompts-and-turn-correlation.md).
Follow-ups the run surfaced:

- Core, fixed in [ADR-0088](../adr/ADR-0088-core-never-dead-ends.md): an explicit rebind
  (`/clear`) moves queued inputs to the new binding, and moves other sent inputs there as
  needs-attention for the owner's decision.
- Recovery, fixed in ADR-0088: `accept_result` handles an input whose attempt committed
  its result; `resend` and `skip` cover the rest.
- Lifecycle, fixed in ADR-0088: close is one step. `Binding::dispatch_quiesced` is removed;
  close cancels pending inputs and no longer needs a paused or disconnected binding.
- Delivery format, fixed in [ADR-0089](../adr/ADR-0089-slim-input-envelope.md): the
  envelope carries no `recent_context` or snapshots, and the fixed instructions live in the skill.
- Rules: `source.md` should say option `consequence` is required.
- Claude Mod: `$.plugin.root` is used but undocumented.

## P7.3 live Codex run (2026-10-06, this PR)

The core loop is proved live through the Codex native queue: pause, two queued inputs,
resume, FIFO delivery via `codex queue`, turn correlation, explicit results committed.
P7.3 is done by owner ruling 2026-10-06 (no further paid host turns). Deferred rows:
five inputs (two were run), closed-item message, disconnect/relaunch, duplicates, both
join orders, missing-result/uncertain recovery, same-project/cross-project isolation,
`npm run test:live` (does not exist).
Follow-ups the run surfaced:

- D1-D6 (fresh-thread connect, RPC error text, setup instruction path and
  `ARIADNE_HOME`, connect card, `question_changed` message, discovery dialog) were fixed
  and merged in #116; docs/GUIDE.md documents the fixed behaviour.
- D7 (UX: font, alignment, button contrast, scrollbars, raw UUIDs): task P8.3, UX review
  and theme refresh, runs after P8.1.
- D6 discovery: a Codex thread with no messages yet may not appear in the discovery
  list until "Refresh host sessions" (documented in docs/GUIDE.md Known limits); find out
  whether the daemon lists such threads at all.
- D8: Ariadne should send the setup instruction through `codex queue` itself instead of
  the owner pasting it.
- Release: `release.yml` tag pattern should match `v<version>` or `v<version>-*`
  exactly.
- Install: `install.sh`'s same-version guard also blocks an identical re-install;
  uninstall first.
- Install: `place_app` failure after `current` is switched leaves `current` on the new version while `~/Applications/Ariadne.app` is the old one; rerunning install recovers; fix: switch `current` back on failure or say "run install again" in the error (`scripts/install/install.py` ~671-685).
- Desktop: `read_provider_file` accepts 0644 and does not check owner uid; the CLI reader is strict (`mode & 0o077 == 0`, uid == euid); align the desktop (`apps/desktop/src-tauri/src/composition/configuration.rs` ~177).
- Desktop: `read_provider_file` opens with blocking `File::open`; a FIFO swapped in between lstat and open would hang startup; open with `O_NOFOLLOW|O_NONBLOCK` via `custom_flags` (`configuration.rs` ~184).
- Doctor: the Codex check takes the home from `CODEX_HOME`/default while the app uses the recorded `home`; pass the recorded home to doctor when no flag is given (`crates/ariadne-cli/src/doctor/inspect.rs` ~365).

## Known gaps, not blocking

- Navigation-only preference writes retry once on conflict and draft bookkeeping writes
  retry up to three times (ADR-0073); a tree click that lands before the window
  receives `preferences_changed` is still refused, and two very fast owner clicks can
  drop the second.
- accessibility.spec.mjs waits 3 s for ui.json to settle before the second `r`.
- Tab/Shift+Tab e2e checks pass vacuously (synthetic keys); keyboard behaviour is
  proved by unit tests.
- Quit note OK is pressed through macOS Accessibility (osascript) in CI; the
  hosted image grants it. Unit tests prove the trigger.
- `seedJourney` in `apps/desktop/tests/e2e/scripted-provider.mjs` (~line 199-232) is the
  third connect-then-apply site without `awaitConnected`; close it when next touching the
  e2e files.

## In flight

- P8.4 App bundle visible in Finder and Spotlight (ADR-0080, PR pending): the owner found
  with `v0.1.0-alpha.1` that the `~/Applications/Ariadne.app` symlink is invisible to
  Finder, Spotlight and Launchpad. The installer now owns a real copy there and migrates
  the old symlink layout.
- P8.5 App finds Claude and Codex when opened normally (ADR-0081, PR pending): the owner
  found with `v0.1.0-alpha.1` that the app opened from Finder has no provider flags, so
  `binding connect` answered "Selected native provider is not configured". Claude now needs
  no executable (the adapter trusts the Mod's version report; the app finds its installed
  package); `ariadne setup` records the Codex path in `~/.ariadne/providers.json`, which
  the app reads at start (flags win) and `doctor` checks. The live acceptance only ever
  passed with flags. Claude bindings qualified before this must reconnect once.
- P8.6 Ariadne working method in the Mod rules (PR pending): the owner found the shipped
  rules only documented the wire protocol. They now tell Claude and Codex to choose their own topics,
  file typed items with full replies as they work and route decisions through `item.ask`, so
  "use Ariadne" is enough. Source is `integrations/rules/source.md`; run `cargo xtask gen-rules`.
  Follow-up: `integrations/rules/codex.md` still mentions `/ariadne-connect`, which Codex does not have.
- P8.7 Project store under the data root (ADR-0082, merged in #124 as ddd978b): the per-project store moves
  from `<project>/.ariadne/` to `~/.ariadne/projects/<project-id>/`. Opening or registering a
  project migrates a legacy store (copy, verify byte-for-byte, park the old copy at
  `projects/<id>.legacy-<ts>`; never deleted, both kept on failure). If both exist and differ the
  open fails until the owner compares them. Native e2e was not run
  locally; CI's native stage is the proof for the rewritten fixtures.
  Follow-up: `registered_projects` runs migration from the desktop watcher tick; consider moving it to an explicit open.
- P8.11 Remove project, session, topic and item (ADR-0083, merged in #125): backend, CLI `ariadne remove …`, Tauri and `RendererService` methods with a `pre-remove-…` backup and a `removed` agent notice; the renderer Remove UI and its 5-second undo are a separate work package.
- P8.12 Short labels on items and topics (ADR-0084, merged in #131): `Topic` and `Item` carry an
  optional agent-written `short` (2-4 words, at most 40 characters, trimmed, one line) for the
  redesigned graph and breadcrumbs. `item.edit` without `short` keeps it, `null` clears it.
  UI components do not read it yet. Follow-up: there is no topic edit, so an older topic cannot be labelled.
- P8.13 Host location and topic counts (ADR-0085, #133 and #134): `Binding`/`BindingSummary` carry
  optional `host_location` ("iTerm window 1"), parsed from `TERM_PROGRAM`/`ITERM_SESSION_ID` by
  `ariadne bridge announce` and written on connect and reconnect; Codex bindings have none (no
  agent-side process on that path). `SessionSummary.topic_count` counts all topics. UI does not read either yet.

## Next steps at alpha.7 (historical)

1. Review the committed alpha.7 fixes in [PR #143](https://github.com/kartiksayani/ariadne/pull/143), awaiting merge, and the focused check results.
2. Complete the remaining alpha.7 acceptance before publishing a release; this task does not run native/e2e checks.
3. Update the release checkpoint when alpha.7 is released.

Previous committed screenshots were removed for privacy. Use the current design
harness (`npm run test:design`, [ADR-0086](../adr/ADR-0086-paperwhite-design.md))
for future captures with neutral fixture data.
