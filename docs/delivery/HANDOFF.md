# Ariadne handoff — 2026-10-06

Claude Code session is the maintainer (Fable 5.1); reviewers Opus 5.5, implementers
Sonnet 5.5, at most seven delegates. The owner approved autonomous delivery, pushes
and squash merges (green `quality` + independent review at the exact head). Test
Ariadne behaviour, not Apple window/menu mechanics. Latency budgets are not gates
(ADR-0068). Preserve worktrees, branches and history; no force-push. The owner plans a
closed-source freemium product: never add an open-source licence (Cargo.toml is
`LicenseRef-Proprietary` since #108).

**Main: a2cfa9d (#110). Roadmap: 45/49 on main, 46/49 once this docs PR merges (P7.1).**
#109 was squash-merged as 1906583 at head ed56f7d after quality run 37411039163; #110
(docs, install-trial evidence, real README screenshot) as a2cfa9d at head 72dd525.
No open PRs besides this docs PR (branch `docs/p71-evidence`). Duplicate and
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
  in `tests/ui/reference/capture.spec.mts`.
- `docs/live-acceptance-plan` is published by this PR.
- Worktrees under `.worktrees/` (preference-conflicts, host-version-tolerance,
  toolchain-minimums, doctor-first-run, release-handoff, codex-skill, readme-for-users)
  are contained in main; keep them. Superseded stack PRs #93, #94, #97, #98, #99,
  #101, #103, #104 and #105 are closed, branches kept.

## P7.2 live Claude run (2026-10-06, PR #114)

The core owner-input to Claude turn to committed-result loop is proved live on Claude
Code 2.1.291. P7.2 stays `in_progress`: completion-before-result order, result repair,
resend, second session, second project isolation and Ariadne app quit/relaunch are not
yet exercised, and `npm run test:live` does not exist. Evidence:
[CLAUDE-2026-10-06.md](../planning/evidence/live-acceptance/CLAUDE-2026-10-06.md);
decision [ADR-0076](../adr/ADR-0076-claude-framed-plugin-prompts-and-turn-correlation.md).
Follow-ups the run surfaced:

- Core: queued never-prepared inputs stay bound to a retired binding after an explicit
  rebind (`delivery/claim.rs` filters by `binding_id`); re-target or let the owner move them.
- Recovery: a committed result with unknown turn state can only be sealed by `skip` or
  `resend`; add a "confirm completed" resolution.
- Lifecycle: a session whose active binding is Disconnected cannot be closed
  (`history_actions/lifecycle.rs:127-132` only waives Paused).
- Delivery format: `recent_context` re-sends every topic message the host already produced; send only messages this binding has not seen (other bindings or pre-connect history), shrink topic/item snapshots to id+status, and move the fixed instruction sentence to the skill.
- Rules: `source.md` should say option `consequence` is required.
- Claude Mod: `$.plugin.root` is used but undocumented.

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

1. Finish the P7.2 coverage gaps; owner approval for the P7.3 live Codex run and owner-home install (writes under
   the real home: Claude plugin registration, `~/.agents/skills/ariadne`, scratch
   histories, Codex daemon restart). The owner summary is at the top of
   [PLAN.md](../planning/evidence/live-acceptance/PLAN.md).
2. P8.1.
3. README screenshot is a real capture of the demo session (`docs/planning/assets/
   screenshot-dark-tree.png`, 1600×960, dark). The capture tooling is uncommitted in
   `.worktrees/post-106-batch` (`scripts/readme-screenshot.mjs`,
   `apps/desktop/wdio.screenshot.conf.mjs`, `apps/desktop/tests/e2e/screenshot.spec.mjs`):
   it reuses the native e2e build, moves the window onto the larger display through
   the Accessibility API (the driver clamps `setWindowSize` to the built-in screen) and
   runs in about 10 s. Commit it if a second capture is ever needed. The demo data shows
   a raw agent id in the filter chips and "host unavailable" banners; polish the demo
   data if that bothers users.
