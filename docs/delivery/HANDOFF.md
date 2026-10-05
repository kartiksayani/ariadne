# Ariadne handoff — 2026-10-05 12:58 UTC

Continue autonomous delivery until the owner stops. Delegates: Sol 6.1 High only.
Local validation is authorized; MCP/the review tool disabled. Preserve all worktrees/history,
ignored evidence and two safety stashes. Root owns adjudication and squash merges;
workers operate tests. Only one interactive Mac runtime at a time.

**Main `0b1623131bedda187cea5311cdca38c208295ccb`; roadmap 35/49.**
PR91 merged with independent review, green CI and86.77% coverage. P4.4 is complete.
Main follow-up [37308680505](https://github.com/kartiksayani/ariadne/actions/runs/37308680505)
failed an existing process-fixture readiness race, before application checks; tree
identical to passing PR91. Other merges pause until the repair is green.
PR100 fixes it, independently clear at `ffb6be4`; [CI37312111856](https://github.com/kartiksayani/ariadne/actions/runs/37312111856)
has priority. Never weaken the original child cleanup assertion or production timer.
Root cancelled queued94/97 and recent101 CI to free a runner for100; these children
are being updated with the fix, then must publish and run required CI again.

## Published PRs and reviews

Stack94→93→97;99 depends on96; others target main. CI links are available on each PR.
Check actual GitHub head/base/CI before merging. All current PRs remain draft.

| PR | Head | Independent review / acceptance |
| --- | --- | --- |
| 93 | 9dd6368 | clear5414707793; native actions pending |
| 94 | b398314 | clear5414707560; full native history pending |
| 95 | 2310f94 | clear5414520528; local native Graph passed; CI running |
| 96 | cf1ffa3 | clear5414435458; routes/release passed; CI running |
| 97 | ce67c55 | clear5414708046; native run active |
| 98 | 57a27f9 | clear5414557609; focused real CLI test passed; CI running |
| 99 | 62b0784 | clear5414719444; physical notification proof pending |
| 100 | ffb6be4 | clear5414720722; main repair CI priority |
| 101 | 22d67d8 | initial source clear; final socket semantic delta review needed |

## Active owners, worktrees and unpublished work

Worktrees are under .worktrees/ unless stated; ordinary branches task/<name>.
- **desktop_discovery_join:** owns94 native-history-acceptance,93 guarded-history-actions,
  97 product-accessibility and98 deterministic-acceptance integration of reviewed100.
  Hold publication until100 CI starts. Original latest history fix b398314 is published:
  verify actual Unpin state/no preference write, then genuine Close clears references,
  reopen same full rail. Hover alone legitimately retains highlights; no fake mouseleave.
- **index_large_session_validation:** sole Mac runtime operator. local-native-startup
  is clean detached `ce67c55`; native exec45992 is running. Record UUID and all20 samples.
  Prior75ee run3f501f41 passed tree778ms/p95118 but hit now-fixed unpin predicate.
  Operator also owns local-production-window and window-status-item runtime/evidence.
- **native_window_acceptance:** authored PR100 in process-readiness-fix, clean/published.
  Also owns unpublished native-menu-publication `286bb37` (private publication cache,
  Pin invalidation), independently source-clear. Ordinary production build and fresh
  retained-artifact verification passed; physical tray menu still disappears, cause unknown.
  No further speculative menu edits. Bounded next observation: two AX sources after
  status click before lookup, then source after lookup; distinguish spontaneous closure.
- **window_lifecycle_acceptance:** PR101 window-shutdown-acceptance `22d67d8` contains
  only real composed shutdown test and registration, on current main. Original tested
  `ba69722` in window-lifecycle-acceptance has identical production consumers; test passed
  1.57s after compile. It preserves scripted active external process/turn, unsent inputs,
  canonical bytes and leases. Socket release means refused/missing endpoint, not required
  pathname removal. Unpublished physical runner fix `3eb7baf` in window-socket-release-proof
  records actual Unix connection result;21 tests/hook pass, independent review pending.
- **notification_acceptance:** PR99 at /private/tmp/ariadne-notification-acceptance is
  clean/published. Required pre-activation visibility finding fixed and independently clear.
  Also owns /private/tmp/ariadne-quit-host-note-implementation, branch task/quit-host-note-implementation:
  uncommitted Quit note in lib.rs, native/window/mod.rs, new quit_note.rs, existing AppKit
  features in Cargo.toml. Canonical read after shutdown drain, native informational alert
  for accepted nonterminal work; no demo-specific exemption. Real native acknowledgement
  in CI remains an integration obligation; do not introduce test-only auto-dismiss.
  Private target/native-e2e cache cloned by operator; hold build until20 samples complete.
- **review_validation_indexes:** independent94/93/97/98/99 reviewer; source clear above.
  **resume_acceptance_closeout:** independent100 and held-turn reviewer;100 clear, final101
  public delta review pending. Archived names do not imply active work; thread-limit errors
  sometimes prevent fresh contexts, so reuse appropriate independent contexts explicitly.

## Evidence and next three steps

1. Get PR100 green, merge it, monitor main, and integrate/publish reviewed children.
   Required application CI, >=80% coverage, exact-head independent reviews and squash
   merges remain mandatory. A pending main run does not block another qualified merge.
2. Finish current native97 run and fix only demonstrated failures. PR91 run18cb99a2
   passed795ms/p95123; PR95 run9f2bd9dc passed740ms/p95115, real Graph and restoration.
   Closure mapping:94 P4.5/P4.6/P4.7;93 P5.3;95 P5.1/P5.2;97 P4.8. No acceptance shortcuts.
3. Finish tray diagnosis, reviewed socket proof and native notification/quit-note acceptance.
   Ordinary286 build evidence76cb4499 and fresh retained release proof ed801683 live in
   local-production-window/coverage/. Same binaries passed cold/second-instance route,
   isolation/security/installer checks; this is not a clean-build claim. Physical3f98cf34
   in window-status-item/coverage/native-window showed menu open then closed before Show.
   App/WDA/Appium exited; ports4445/4723/10100 free. Auto-hide read0, no setting changes.

P6.1/P6.2/P6.4/P7.1 remain incomplete; physical monitor/wake/notification and full joins
still matter. Actual owner install/live paid M7 require approval once concrete work is ready.
XCTest already approved. Notification allow/deny remains a separate owner choice when ready.
Use pinned Node22, NPM_CONFIG_USERCONFIG=/dev/null, usual CARGO_HOME/RUSTUP_HOME.
Native private HOME=/private/tmp/ariadne-local-native-home-kj60kx9v. RTK outer commands only;
GraphQL first for GitHub reads. Root tasks.json/HANDOFF/roadmap edits are intentional;
regenerate local docs/planning/roadmap.html from tasks.json, never invent green tasks.
