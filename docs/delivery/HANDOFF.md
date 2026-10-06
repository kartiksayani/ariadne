# Ariadne handoff — 2026-10-06 04:55 UTC

Claude Code session is the maintainer (Fable 5.1); reviewers Opus 5.5, implementers
Sonnet 5.5, at most seven delegates. The owner approved autonomous delivery, pushes
and squash merges (green `quality` + independent review at the exact head). Test
Ariadne behaviour, not Apple window/menu mechanics. Latency budgets are not gates
(ADR-0068). Preserve worktrees, branches and history; no force-push. The owner plans a
closed-source freemium product: never add an open-source licence (Cargo.toml is
`LicenseRef-Proprietary` since #108).

**Main: 1906583. Roadmap: 44/49 on main, 45/49 once this docs PR merges (P6.4).**
#109 was squash-merged as 1906583 at head ed56f7d after quality run 37411039163.
No open PRs besides this docs PR (branch `docs/followups`).

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
- P7.1: evidence is main's `quality` run
  [37415365326](https://github.com/kartiksayani/ariadne/actions/runs/37415365326),
  still in progress when this was written. Link it once it is green.
- #109 run 2 failed only on the reference-capture first-load wait (fixed in ed56f7d).
  If it recurs as a ~31 s failure, set `optimizeDeps.entries` on the test's Vite server
  in `tests/ui/reference/capture.spec.mts`.
- `docs/live-acceptance-plan` is published by this PR.
- Worktrees under `.worktrees/` (preference-conflicts, host-version-tolerance,
  toolchain-minimums, doctor-first-run, release-handoff, codex-skill, readme-for-users)
  are contained in main; keep them. Superseded stack PRs #93, #94, #97, #98, #99,
  #101, #103, #104 and #105 are closed, branches kept.

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

## Next steps

1. P7.1: when run 37415365326 is green, record the link in tasks.json and here.
2. Owner approval for P7.2/P7.3 live host runs and owner-home install (writes under
   the real home: Claude plugin registration, `~/.agents/skills/ariadne`, scratch
   histories, Codex daemon restart). The owner summary is at the top of
   [PLAN.md](../planning/evidence/live-acceptance/PLAN.md).
3. P8.1.
4. README screenshot is a real capture of the demo session (`docs/planning/assets/
   screenshot-dark-tree.png`, 1600×960, dark). The capture tooling is uncommitted in
   `.worktrees/post-106-batch` (`scripts/readme-screenshot.mjs`,
   `apps/desktop/wdio.screenshot.conf.mjs`, `apps/desktop/tests/e2e/screenshot.spec.mjs`):
   it reuses the native e2e build, moves the window onto the larger display through
   the Accessibility API (the driver clamps `setWindowSize` to the built-in screen) and
   runs in about 10 s. Commit it if a second capture is ever needed. The demo data shows
   a raw agent id in the filter chips and "host unavailable" banners; polish the demo
   data if that bothers users.
