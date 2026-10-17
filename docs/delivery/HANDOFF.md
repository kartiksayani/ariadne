# Ariadne handoff — 2026-10-17

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

**Main: `c87909da` (#169). Alpha.19 released as
[`v0.1.0-alpha.19`](https://github.com/kartiksayani/ariadne/releases/tag/v0.1.0-alpha.19)**
(tag at `c87909da`). Alpha.18 is `v0.1.0-alpha.18` (tag at `0336a903`, #164), alpha.17 is
`v0.1.0-alpha.17` (tag at `925c9645`, #162), alpha.16 is
`v0.1.0-alpha.16` (tag at `44158cbf`, #160), alpha.15 is `v0.1.0-alpha.15` (tag at
`10b6013a`, #159) and alpha.14 is `v0.1.0-alpha.14` (tag at `1135693c`, #155): a Map you
can follow, from #150 (`395736a2`), #151 (`bc7fa712`), #152 (`63295ec5`), #153
(`2bd09408`), #154 (`8a58f93c`) and #155 (`1135693c`).

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
- Keys act on the selected item only; on a page they do nothing to the Map. Removed: ⌥1–9 / ⌥0 quick-send, ⌘J (use `.` to return to the selected item), `e`, `w`, `x` and `h` / `l` folding. `a` only acknowledges.
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
2. The Map, including what changed and peek: alpha.20.
3. Dialogs, notices and pages, with connection states: release 3.

## Next steps

Items 1 and 2 are for alpha.20. Items 3 and 4 are small and do not touch the redesign; take them alongside. Items 5 onward wait until the redesign is done, unless the owner asks for one earlier.

1. **Alpha.20 "The Map"** (plan approved by the owner on 2026-10-17). The Tree and Graph match the approved board, and three rules hold under every trigger: the Map never moves on its own; a branch's hue stays put across adds, removes and reloads; markers clear only by the defined rules. Each rule gets an invariant table written before the code. Order: P0 prep, then T, M3 and M7 in parallel, then M1, M2, M5 and M6 in parallel, then V, then one integration and one full gate, then Opus reviews split by area.
   - P11.36 (P0) behaviour-preserving prep: split `tree.css`, hue table to `ui/tree/branch.ts`, band slot props.
   - P11.37 (T) Tree core: search in place, a fixed end cluster, the Map-never-moves table.
   - P11.38 (M1) Map look. P11.39 (M2) topic band. P11.40 (M5) filter chip row. P11.41 (M3) Graph. P11.42 (M6) changes, markers and Back-to. P11.43 (M7) peek. P11.44 (V) design regions for the Map states.
   - Owner answers on 2026-10-17: hovering to peek is not a Recent visit; a single Ack shows Undo, then saves; a folded chip also says "N waiting"; several topics in one session stack in the Graph.
2. Other alpha.20 must-dos:
   - P11.26 Deflake the load-sensitive tests. The Codex `queue.rs` version probe is a second occurrence, so the Flakes rule (ORCHESTRATOR) requires the fix before the next merge. Scope: every flake in Known flakes below, including the alpha.19 ones (llvm-cov composition wake test, native recovery under load, the native Graph step and the accessibility `r` step).
   - Fixes already built on branches and not merged. They are in progress, not done:
     - P11.35 Silent Send in Details under load, branch `redesign/a20-sendfix` (`edd355c6`). `submit.ts` refuses when the sending session differs from the rendered one and sets `loadingError`; the next snapshot clears it. The text is kept, Send stays enabled, nothing is saved and no message shows. Found in the alpha.19 gate, where the native recovery journey failed once under load and passed 3 of 3 alone. The bug dates from alpha.8.
     - P11.22 and P11.23 Fair store lock and a realistic `claim_contention` test, branch `redesign/a20-lock` (`a01d22eb`).
3. Hook notice follow-ups from the alpha.18 final re-review (non-blocking), each a small task:
   - P11.17 `claim` is not retired after binding removal (`claims.js` `end()`), so the terminal "removed" line stays current and hides later advice until reconnect. Retire it after the removal is recorded.
   - P11.18 Pre-existing dead end: `autoConnect` holds `ownerTransition` while awaiting `deliverNote` (`register.js`). If `$.session.append` hangs, `/ariadne-connect` and `/ariadne-disconnect` answer "already connecting" forever. Don't await the note inside the transition window, or time-box it.
   - P11.19 The oracle's one-outcome check is circular (`notice-invariants.test.js`). Turn on the `balanced()` ledger in `register.test.js` and `connect-recovery.test.mjs`.
   - P11.20 A transient turn-callback failure stays current while idle, and "it will keep trying" is false there.
   - P11.21 `HUNG_CALL_MS` (10 s) assumes one helper run per call, but auto and reports do several. Use per-producer thresholds and fix the README wording.
4. Store and install follow-ups from the alpha.18 head review and install check:
   - P11.22 In progress (item 2). The store lock is unfair (`crates/ariadne-store/src/session/lock.rs`): `try_lock` with a backoff growing to 50 ms lets newcomers polling at 10 ms beat the longest waiter. Use a flat 10 ms poll or a FIFO handoff.
   - P11.23 In progress (item 2). `claim_contention.rs` readers should resolve like the CLI (`AgentResolver::resolve`), so a busy catalogue fails the try instead of hiding a 2 s wait. Place queue inputs outside the 2.3 s holds (space them 150–200 ms). Keep every assertion. It fails 2 to 4 of 5 local runs on a shared machine.
   - P11.24 Later: the owner's `session_read` takes the session lock (`queries/mod.rs` to `catalogue.rs`). Peek-based reads are possible.
   - P11.25 While the alpha.17 app ran, `install.sh`'s doctor printed "some data was busy or unreadable" and "Saved data couldn't be read safely". A rerun right after said "No problems found". The install-time doctor should ride out busy like other reads, or word it as busy, try again.
   - P11.27 Every alpha ships as plugin version 0.1.0, so the Claude plugin cache cannot tell alphas apart.
5. Follow-ups from #162, each a small task:
   - P11.10 Graph selection reply race: a Graph click's `revealItem` reply is dropped when a reveal is dismissed mid-flight, because the `external` guard in `GraphView.tsx` compares App's `treeReveal`. Fix with a counter that changes only on a non-own, non-null outside reveal.
   - P11.11 Stale "outside your filters" banner: it stays after a Graph fold or stub toggle; the Tree dismisses it through `onDismissReveal`.
   - P11.12 Reveal selected detail parity: the Graph keeps detail closed and the Tree opens it. The owner decides, then both align.
   - P11.13 Missing composed tests: a plain Graph click keeps scroll and focus through App, and the selection is asserted after Resume.
   - P11.14 Flake watch for `tests/integrations/claude/register.test.js` (see Known flakes).
6. Recovery edge cases from a failure table. Three rare cases from the #159 review:
   a rollback that could remove the only copy of the recovery file on network
   filesystems, transient read errors that set a good recovery file aside, and a
   needless sync on reads. Brief it as a full failure table (ORCHESTRATOR, "Delivery
   feedback rules"). Task P11.7.
7. Previous-release read test: an automatic check that the previous release accepts
   the files the new build writes. Task P11.8.
8. Watch the Known flakes list below; a second occurrence gets fixed before the next merge.

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

- **`cargo llvm-cov` coverage run, `composition::tests::wake_replaces_activation_only_after_old_monitors_exit_and_requires_fresh_bound_evidence` (`mod.rs:389`).** Fixed in P11.26 (the test, not the product).
  - First failed: #169 CI coverage run, 2026-10-17. PermissionDenied: "Another desktop or supervisor holds this nonblocking lease". `src-tauri` is untouched by alpha.19.
  - Cause: line 389 is the bound announcement. It starts a replacement activation that takes the binding's nonblocking lease, and a request or blocking call the old activation started can still hold a lease clone just after `reconcile_after_wake` returns. A lock probe in the test saw it busy once in 40 runs at load 40. Fix: `wait_lease_free` waits for the lease file to be free before the announcement. Product follow-up, not done here: a wake followed at once by an announcement can see this refusal.

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
