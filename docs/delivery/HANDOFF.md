# Ariadne handoff — 2026-10-09

Claude Code session is the maintainer (Fable 5.1); reviewers Opus 5.5, implementers
Sonnet 5.5, at most seven delegates. The owner approved autonomous delivery, pushes
and squash merges (green `quality` + independent review at the exact head). Test
Ariadne behaviour, not Apple window/menu mechanics. Latency budgets are not gates
(ADR-0068). Preserve worktrees, branches and history; no force-push. The owner plans a
closed-source freemium product: never add an open-source licence (Cargo.toml is
`LicenseRef-Proprietary` since #108).

**Released: alpha.6 (`v0.1.0-alpha.6`, 859c7a6c, #141), 2026-10-09. Roadmap: 58/58 done.** The release includes the lighter skill, easier filing, copy, back/forward, item links, tidier tree and text size. The Paperwhite redesign (ADR-0086) was integrated in #138. [Alpha.6 release](https://github.com/kartiksayani/ariadne/releases/tag/v0.1.0-alpha.6).

## Alpha.7 work in progress

The alpha.7 UI and hide-item fixes are committed on `fix/a8-hide` in [PR #143](https://github.com/kartiksayani/ariadne/pull/143), awaiting merge; alpha.7 is not released.

- Waiting on me and Sent scroll separately. Sent holds messages waiting for the agent to pick up, with Edit and Delete actions.
- ⌥1–9 picks and sends a quick answer; ⌥0 focuses own words. Choices keep any typed note.
- Item detail is one chronological chat. Results avoid repeating a full follow-up message, and children have their own scrolling list.
- Cancelled bubbles are dimmed and labelled to say whether the agent may have seen them; the original choice and note remain visible.
- The +N children badge has an accent highlight. An indirect match gets a quieter tint while keeping AA text contrast in both themes.
- Hide items uses x, row actions or detail, saves the hidden preference and gathers rows into expandable muted groups. Hidden questions still appear in Waiting on me; the graph fades hidden items.
- Review fixes: x waits for a stale session refresh before saving; weak badges regain their cue; pending Remove hides Sent rows immediately and Undo brings them back. Regression tests cover these paths, including item, topic, session and project removals.

Local verification for this task is `npm run check`, focused Vitest and `python3 scripts/regenerate-roadmap.py --check`. The generated roadmap is refreshed with the task catalogue. Native/e2e runs are excluded by the owner's task instruction; no new native acceptance is claimed here.

## Earlier delivery evidence

### Paperwhite checkpoint (2026-10-07)

**Main: fddd998 (#134). Roadmap: 58/58 done; P8.11 (remove commands) merged in #125, P8.12 (short labels) in #131 and P8.13 (host location and topic counts) in #133 and #134.** P8.3 is done as the Paperwhite redesign (ADR-0086): work packages #126-#132 and the finish #136 sit on `feat/paperwhite-integration`, and its integration PR to main is pending. `npm run test:design` is the fidelity gate (thresholds = measured + 0.01). Follow-ups: rewrite UI_AND_NATIVE for the Paperwhite UI; fidelity of frames 1m, 1z, 1w and 1ac. Continue is one picker, `ui/dialogs/ContinueTopicDialog.tsx`, which the tree and the other entry points share; the old `components/history-actions/ContinueDialog` is gone. Topic folds are saved in the session preferences (`collapsed_topic_ids`, at most 256 kept) and survive a restart; the Waiting column's fold is saved in the global layout (`waiting_collapsed`), folds by itself below 1300 px without sideways scroll, and the `w` key toggles it. Still open: a Rust `ExitRequested` flush for pending removals; the removal `expected_revision` is read at run time, so agent edits in the undo window are removed silently. P8.1 (release evidence) is done in #118; P8.2 (prebuilt alpha package) is done in #117 and the `v0.1.0-alpha.1` pre-release is published ([release](https://github.com/kartiksayani/ariadne/releases/tag/v0.1.0-alpha.1), workflow run 37523466225).

#109 was squash-merged as 1906583 at head ed56f7d after quality run 37411039163; #110
(docs, install-trial evidence, real README screenshot) as a2cfa9d at head 72dd525.
At the #110 checkpoint, no open PRs were recorded. The release install trial ran on main 1e8d9e7 ([clean-install-1e8d9e7.md](../planning/evidence/release/clean-install-1e8d9e7.md)); its green `quality` run is [37511788713](https://github.com/kartiksayani/ariadne/actions/runs/37511788713). P8.1 is done in #118; the owner still fills date and tester in the manual checklist ([manual-checklist.md](../planning/evidence/release/manual-checklist.md)). Duplicate and
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
  Evidence: [install-trial.md](../planning/evidence/release/install-trial.md).
- P7.1: evidence is the green full-scope `quality` run on main a2cfa9d,
  [37418522364](https://github.com/kartiksayani/ariadne/actions/runs/37418522364)
  (dispatched by hand because the push of #110 cancelled the run on 1906583; pushes
  to main cancel the previous main run, and a docs-only push runs the docs scope).
- #109 run 2 failed only on the reference-capture first-load wait (fixed in ed56f7d).
  If it recurs as a ~31 s failure, set `optimizeDeps.entries` on the test's Vite server
  in `tests/ui/design/design.spec.mts` (the design harness, `npm run test:design`).
- `docs/live-acceptance-plan` is published by this PR.
- Worktrees under `.worktrees/` (preference-conflicts, host-version-tolerance,
  toolchain-minimums, doctor-first-run, release-handoff, codex-skill, readme-for-users)
  are contained in main; keep them. Superseded stack PRs #93, #94, #97, #98, #99,
  #101, #103, #104 and #105 are closed, branches kept.

## P7.2 live Claude run (2026-10-06, PR #114)

The core owner-input to Claude turn to committed-result loop is proved live on Claude
Code 2.1.291. P7.2 is done by owner ruling 2026-10-06 (no further paid host turns; core
loops proven). Deferred rows: completion-before-result order, result repair, resend,
second session, second project isolation and Ariadne app quit/relaunch;
`npm run test:live` does not exist. Evidence:
[CLAUDE-2026-10-06.md](../planning/evidence/live-acceptance/CLAUDE-2026-10-06.md);
decision [ADR-0076](../adr/ADR-0076-claude-framed-plugin-prompts-and-turn-correlation.md).
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
`npm run test:live` (does not exist). Evidence:
[CODEX-2026-10-06.md](../planning/evidence/live-acceptance/CODEX-2026-10-06.md).
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

## Next steps

1. Review the committed alpha.7 fixes in [PR #143](https://github.com/kartiksayani/ariadne/pull/143), awaiting merge, and the focused check results.
2. Complete the remaining alpha.7 acceptance before publishing a release; this task does not run native/e2e checks.
3. Update the release checkpoint when alpha.7 is released.

Earlier screenshot follow-up:

- README screenshots are the design harness's app renders of frames 1a, 1d and 1b
   (`docs/planning/assets/paperwhite-{tree,graph,detail}.png`, 1600×960, dark). The
   former demo capture (`screenshot-dark-tree.png`) is removed. The capture tooling is uncommitted in
   `.worktrees/post-106-batch` (`scripts/readme-screenshot.mjs`,
   `apps/desktop/wdio.screenshot.conf.mjs`, `apps/desktop/tests/e2e/screenshot.spec.mjs`):
   it reuses the native e2e build, moves the window onto the larger display through
   the Accessibility API (the driver clamps `setWindowSize` to the built-in screen) and
   runs in about 10 s. Commit it if a second capture is ever needed. The demo data shows
   a raw agent id in the filter chips and "host unavailable" banners; polish the demo
   data if that bothers users.
