# Ariadne resumption handoff

Checkpoint: 2026-10-05, after publishing `efc8206`. Owner resumed autonomous
implementation. Delegates **Sol 6.1 High only**; four concurrent delegates were
verified this turn. Local checks/native runs are authorized; MCP/Seezo remain
disabled. Preserve all worktrees/history/ignored evidence and two safety stashes.
Maintainer alone squash merges after independent exact-head review, green CI and
original acceptance. No genuine completion may be skipped or claimed early.

**Main:** `d3502f7c207967ced6570cb38e2760e88f53d9db`,
[green CI](https://github.com/kartiksayani/ariadne/actions/runs/37264196572).
**Roadmap: 34/49 complete; P4.4 and P6.1 active.** Owner approved XCTest; P6.1 has a
startup-route blocker under investigation, not an outstanding permission request.
Root dirty HANDOFF/tasks/roadmap are intentional; user views the local
`docs/planning/roadmap.html`. Regenerate it from tasks.json.

## GitHub and prepared branches

Stack **91 → 94 → 93 → 97**; 95/96 independently depend on 91. Worktrees are
`.worktrees/<name>`, branches `task/<name>`. Child published heads have independent
source clearance but failed native CI on older parent code.

| PR | Worktree | Published head / CI | Prepared local head |
| --- | --- | --- | --- |
| 91 | native-tree-acceptance | `4492e25`, [running](https://github.com/kartiksayani/ariadne/actions/runs/37296523921) | same, clean |
| 94 | native-history-acceptance | `d62cb7d7`, [failed](https://github.com/kartiksayani/ariadne/actions/runs/37273569573) | `09cb7dd` |
| 93 | guarded-history-actions | `1e1177ee`, [failed](https://github.com/kartiksayani/ariadne/actions/runs/37273574875) | `af75b33` |
| 95 | native-graph-acceptance | `c7dedca2`, [failed](https://github.com/kartiksayani/ariadne/actions/runs/37273584376) | `706ab4e` |
| 96 | packaged-route-acceptance | `86de2ce7`, [failed](https://github.com/kartiksayani/ariadne/actions/runs/37273589825) | `66cd776` |
| 97 | product-accessibility | `a873feb4`, [failed](https://github.com/kartiksayani/ariadne/actions/runs/37273579477) | `4f41a19` |

Five child worktrees are clean/unpushed and now integrate parent `efc8206`;
normal hooks passed. `prepare_stack_parent_updates` owns them and finished focused
checks:178 UI,27 graph/process,1 real-CLI history passed; packaged helpers2 passed
and1 artifact-dependent test skipped, no packaged acceptance claim.
PR97's focus conflict resolution preserves parent explicit-intent
focus and child request tokens; a revealed editor-remount race is fixed and all
139 focused tests passed. `audit_remaining_tree_flow` independently cleared the
five exact heads, including this resolved behavior. Hold pushes until useful
current native proof and coordinated parent checkpoint.

## Current execution and review

**Root exclusively owns the native runtime/cache:** `.worktrees/local-native-startup`,
detached at **4492e25dbf5c8c2ac460208ca553b9d1c583b43f**, full native run
**db8127b3-8f7f-4237-b893-4b475fb0b50b**, exec **82552**, ended exit1.
First usable888ms, all20-search p95≈126ms passed. Filter focus admission passed
with three stable frames and the exact Open click delivered, but product save
returned a preferences revision conflict (canonical rev54, statuses/search empty).
Owned PID88827 exited and port4445 is free. `local_search_projection` found a
concrete NavigationStore.load race: read revision checked before catalogue awaits
can publish stale preferences after a newer mutation receipt. It now solely owns
a bounded after-await floor recheck and red regression in a new worktree from449.
Startup worker finished its own edits, so there is no concurrent navstore editor.
`probe_native_readiness` finishes supporting input timeline evidence; no further
helper change. No repeat native run until the product fix is reviewed.
Previous full native run at efc8206,
**af992058-3beb-44f4-991f-ffea772d2954**, exec session **39745**, ended exit1.
First usable1068ms and 20-search p95≈119ms met targets, but filter-click readiness
at tree.spec.mjs:454 failed before the repaired reveal/anchor checks. Port4445
is free and owned PID76283 exited. Failure evidence shows 1107 callbacks, visible,
enabled, correct target/centre hit, but document.hasFocus=false throughout. Root
authorized `probe_native_readiness` to reuse verified activateOwned before an
untimed filter choice when not visible/focused, retaining readiness and one click.
It delivered clean `4492e25` in `.worktrees/native-filter-focus`, branch
`fix/native-filter-focus`; 35 tests and hooks passed, independent source review
clear and [public review](https://github.com/kartiksayani/ariadne/pull/91#pullrequestreview-5413094993).
Root fast-forwarded and published PR91; the subsequent product conflict
does not invalidate its corrected focus admission evidence.
Prior run **55e59027** at published `293e9a9`
failed missing selected-item reveal dismissal; it proved first usable **578 ms**,
all-20 search **p95 112 ms, max 148 ms**, and the Later focus repair. Owned PID
62436 exited and port4445 was free before the new run. No full acceptance yet.
No other native launches/builds during its timing. Evidence: `coverage/native-e2e/`
under that worktree. Private HOME `/private/tmp/ariadne-local-native-home-kj60kx9v`;
use pinned Node22, real CARGO_HOME/RUSTUP_HOME and NPM_CONFIG_USERCONFIG=/dev/null.
Existing runner verifies owned PID/executable/birth and port cleanup.

`audit_next_native_journeys` posted exact combined `293e9a9`
[review](https://github.com/kartiksayani/ariadne/pull/91#pullrequestreview-5412797705).
It also cleared `293e9a9..efc8206` and posted its
[exact-head review](https://github.com/kartiksayani/ariadne/pull/91#pullrequestreview-5412946157).
**125 combined
UI tests** and all cheap checks passed. Parent includes:

- Store byte capture under locks, full read validation after releasing locks;
  mutations/project identity gate unchanged. All 60 Store tests and Clippy passed;
  [independent review at 4f0d9519](https://github.com/kartiksayani/ariadne/pull/91#pullrequestreview-5412364169).
- Owned-App activation and visible, stable click readiness (`9f08e9f9`), reviewed;
  no synthetic test clicks, changed input count or timing threshold.
- Detail selection preserves tree focus; only explicit detail intents focus the
  composer (`b00cfa4`, integrated `bb6eee2`). Native/CI showed old `z` becoming a
  saved reply draft instead of Later. Regression reproduced it; 60 tests passed.
- Local search projection at the existing 100 ms debounce, with separate honest
  save confirmation (`bdea2ca`, integrated `293e9a9`). ADR0066/UI contract `febb3e9`
  and implementation independently clear; 93 focused tests passed. Canonical
  writer/revisions/exact replay and other filters remain unchanged.

`local_search_projection` delivered two clean commits, now published in PR91, in
`.worktrees/search-filter-reveal`, branch `fix/search-filter-reveal`:
`7146e4d` makes newer local selection supersede stale external reveal until the
external route changes; `efc8206` captures scroll anchors in rendered row order,
not ref-map insertion order. Both regressions failed before fixes; 95 focused
tests and cheap checks passed. Native verification remains incomplete; independent review passed.

`probe_native_readiness` is idle after that bounded helper fix; its earlier clean worktrees are
`fix/native-visible-readiness` / `native-visible-readiness` at `9f08e9f9`, and
`fix/detail-selection-focus` / `detail-selection-focus` at `b00cfa4`;
`local_search_projection` has `fix/local-search-projection` / `local-search-projection`
at `bdea2ca`. Their changes are integrated and published. Root contract worktree
`local-search-contract` / `docs/local-search-projection` at `febb3e9` is clean.

Previous local run `2f89e647` at `9f08e9f9` passed initial opening, filters and
Home/End; first usable 719 ms, search p95 208 ms, then failed Later. PID 42902 exited,
port free. Prior published CI `37287803266` at `4f0d9519` independently failed the
same focus defect, with search p95 198 ms and **86.76% coverage**. Its audit is in
`/tmp/ariadne-pr91-ci-audit/`. No full native acceptance from these failures.
Targets remain first usable ≤2s and all 20 searches p95 ≤150 ms.

## Production/window work and owner questions

Reviewed, clean, unpublished window supplement **cf5b97b8667f52c189c2633d473ee25817d6d0cd**
is in `.worktrees/native-window-acceptance`, branch `task/native-window-acceptance`,
and `.worktrees/local-production-window`. Root's ordinary release run
**b8d1280f-c44a-4658-aec0-f2c3cafc1cc3** in the latter **passed** cold/second-instance
routes, unchanged demo, release isolation and packaged install checks. PID 39226
exited, no extra packaged process remains, port free. Matching artifacts are in
`target/release-boundary/release`; evidence in `coverage/release-boundary/`.

Physical attempt `f54989e3` stopped at WDA authorization. Owner then explicitly
approved XCTest. Retry **747f3300** proved WDA/Appium ready but failed ordinary
production cold-route selection within20s, before physical window actions. All
owned App/service PIDs exited, ports10100/4723 free, cleanupErrors empty. Same
App bytes and demo hash as passed release proof; no proven timeout cause.
`native_window_acceptance` now owns a bounded navigation-store regression/fix in
`.worktrees/startup-route-readiness`, branch `task/startup-route-readiness`,
from293e9a9: route subscription can deliver before initial
preferences load, causing the route to fail without retention. Prove with deferred
initial-read tests reproduced the loss for both preferences and catalogue delays;
actual failed-run event ordering was not recorded. No
native launches/builds while root runs timing; no timeout increase.
This fix joins **PR96**, not PR91: clean unpushed **32c4d654bb5da864bab64d564fff17252393667b**,
100 related UI tests/hooks passed, independent `audit_next_native_journeys` review
clear. Seven new regressions cover initial reads, latest/crossing route delivery,
failed-read recovery, stop and original uncertain-operation replay. Integrator
`prepare_stack_parent_updates` owns adding this and parent449 to prepared children.

Owner also saw Terminal launch raw `target/native-e2e/debug/ariadne-desktop` with
Missing ARIADNE_E2E_ROOT at15:16 local. Tests use the correct separate App binary;
no symlink mismatch. OS logs show LaunchServices→Terminal→raw executable but not
requester. Owner confirmed clicking **Reopen** on a macOS crash dialog. This
relaunched the test executable without its private per-run environment; root
explained to choose Ignore and let the runner restart it. Raw test executable
requires runner setup; production is separate. Waiting-card screenshot overlap
is already fixed on main, with retained Chromium layout regression proof.

## Next three steps

1. Finish current exact-head native run and public review; inspect CI. Fix only
   demonstrated remaining defects, preserving meaningful tests and independent
   review. Verify owned cleanup. Do not repeat unchanged failed heads.
2. Propagate useful proven parent repairs into the five prepared child branches,
   run relevant checks/review and publish coordinated checkpoints. Retry physical
   window test after the startup-route diagnosis/fix and when native access is
   free. XCTest is approved. Physical monitor/wake/notifications/Dock/overlap remain unproved.
3. Merge qualified stack prefixes and update the local roadmap honestly. Pending
   main CI does not block another qualified merge; failed main pauses merging.
   Closure:91→P4.4;94→P4.5/P4.6/P4.7;93→P5.3;95→P5.1/P5.2;97→P4.8.
   PR96/window proves only part of P6.1. Live M7 and actual owner installation
   require approval once concrete reviewable work is ready.
