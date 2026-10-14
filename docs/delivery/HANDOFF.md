# Ariadne handoff — 2026-10-15

Claude Code on **Opus 5.5** maintains delivery. At most **3 Codex companion jobs**
(**gpt-6.1-sol, high effort**) implement bounded work in isolated worktrees with
declared, disjoint paths. Independent review uses a separate **Opus 5.5** context
at the exact head; one targeted re-review follows fixes. The owner authorized
pushes and squash merges with green `quality` and exact-head review. The maintainer
uses `gh pr merge --squash --match-head-commit <head>` and verifies main's tree
matches the PR head (`git diff --quiet <head> origin/main`). Test Ariadne behavior, not Apple window/menu mechanics; latency
is not a gate (ADR-0068). Keep the process budget in ORCHESTRATOR. Preserve worktrees,
branches and history; no force-push or open-source licence.

Codex jobs cannot run browsers, sockets, the app, native e2e or `git add`/commits.
The maintainer runs Playwright, design frames and the local native journey before
push, stages and commits, and plans time for it. Before UI implementation, share a
clickable HTML mock under `designs/mocks/`; the owner signs off and implementation
follows it.

**Main: `925c9645` (#162). Alpha.17 released as
[`v0.1.0-alpha.17`](https://github.com/kartiksayani/ariadne/releases/tag/v0.1.0-alpha.17)**
(tag at `925c9645`). Alpha.16 is `v0.1.0-alpha.16` (tag at `44158cbf`, #160), alpha.15 is
`v0.1.0-alpha.15` (tag at `10b6013a`, #159) and alpha.14 is `v0.1.0-alpha.14` (tag at
`1135693c`, #155): a Map you can follow, from #150 (`395736a2`), #151 (`bc7fa712`), #152
(`63295ec5`), #153 (`2bd09408`), #154 (`8a58f93c`) and #155 (`1135693c`).

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

**The UI is being redesigned.** Mockups are made in Claude Design, the owner approves
them, and only then does a redesign get built. The Map and window layout are chosen.
The remaining rounds are:

1. Answering plus conversation.
2. What changed plus peek.
3. Dialogs, notices and pages.

## Next steps

1. Follow-ups from #162, each a small task:
   - P11.10 Graph selection reply race: a Graph click's `revealItem` reply is dropped when a reveal is dismissed mid-flight, because the `external` guard in `GraphView.tsx` compares App's `treeReveal`. Fix with a counter that changes only on a non-own, non-null outside reveal.
   - P11.11 Stale "outside your filters" banner: it stays after a Graph fold or stub toggle; the Tree dismisses it through `onDismissReveal`.
   - P11.12 Reveal selected detail parity: the Graph keeps detail closed and the Tree opens it. The owner decides, then both align.
   - P11.13 Missing composed tests: a plain Graph click keeps scroll and focus through App, and the selection is asserted after Resume.
   - P11.14 Flake watch for `tests/integrations/claude/register.test.js` (see Known flakes).
2. Recovery edge cases from a failure table. Three rare cases from the #159 review:
   a rollback that could remove the only copy of the recovery file on network
   filesystems, transient read errors that set a good recovery file aside, and a
   needless sync on reads. Brief it as a full failure table (ORCHESTRATOR, "Delivery
   feedback rules"). Task P11.7.
3. Previous-release read test: an automatic check that the previous release accepts
   the files the new build writes. Task P11.8.
4. Watch the Known flakes list below; a second occurrence gets fixed before the next merge.

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

- **`tests/integrations/claude/register.test.js`, "admits claims again after an owner command is refused".** First occurrence; not fixed yet.
  - First failed: local #162 full coverage run, 2026-10-15. Line 780 waited for 2 matching calls and saw 1. Task P11.14.
  - Evidence: the file passed 3 times in a row on its own. #162 does not touch the Claude integration.
  - Suspected cause: timing under coverage load, where the `vi.waitFor` default timeout is too short after `h.timer().callback()`. Not confirmed.

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
- **Native delivery journey, "Detail Reply text and enabled Send were not ready for one click"** (`apps/desktop/tests/e2e/owner-reply.mjs:109`).
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
