# Ariadne resumption handoff

Checkpoint 2026-10-05 04:49 UTC. Continue autonomously. Delegates: **Sol 6.1 High only**.
Local checks/builds/native runs are authorized when useful. MCP/the review tool remain disabled.
Root alone squash merges after current-head review, green CI and actual acceptance.
Preserve other worktrees, evidence and history. New spawns hit the thread limit;
reuse relevant existing reviewer contexts for their ongoing work.

**Main:** `d3502f7c207967ced6570cb38e2760e88f53d9db` (PR92 squash merged).
[Post-merge main CI running](https://github.com/kartiksayani/ariadne/actions/runs/37264196572); previous main and exact PR92 head were green.
PRs 86/88 are merged; overlap and flicker fixes are on main. The local roadmap is
**34/49 complete**, with only P4.4 actively executing. Root's dirty HANDOFF,
tasks.json and roadmap.html are intentional current state; carry into PR91 at
publication. Two safety stashes remain. No cleanup is pending.

| PR | Published → prepared local head | Current state |
| --- | --- | --- |
| 91 | 7a99411 → 3a2c55b | Current main integrated conflict-free; detached native run below. |
| 92 | fbad9e5 → merged d3502f7 | [CI passed](https://github.com/kartiksayani/ariadne/actions/runs/37262049847); complete independent artifact audit clear. |
| 94 | c0c2abe → 19f72e0 | History; final integration clear, 24 runner tests pass. |
| 93 | 9bfbc74 → 980a76e | Guarded actions; 81 UI tests, final integration clear. |
| 95 | 4bbd6b8 → c54847d | Graph; final integration clear, 26 runner/helper tests pass. |
| 96 | 9254f3b → a48d710 | Package routes; 3/3 real-CLI/ownership tests, final integration clear. |
| 97 | d5359fa → b68fbf0 | Accessibility; 137 UI tests, final integration clear. |

**Active worker:** `prove_three_binding_fifo`, branch `task/native-tree-acceptance`,
worktree `.worktrees/native-tree-acceptance`. It exclusively owns the native runner
`.worktrees/local-native-startup` and `target/native-e2e` cache. Do not launch another
App or build there. Private HOME: `/private/tmp/ariadne-local-native-home-kj60kx9v`.
Retain real CARGO_HOME/RUSTUP_HOME and pinned Node22 PATH; npm user config is disabled.

**PR91 blocker:** full 2,000-item/5,000-message publication succeeded twice, but
acceptance remains unproved. Run6435 exposed a zero-tabstop bug, fixed with a
layout-effect ordering change (21 author +21 independent tests). Run31f4 completed
the corpus but session-opening measurement never finished. Passive click/DOM/prefs
capture was added. Run3ee6412d then hit intermittent StoreBusy at 4,869 messages.
Its actual App sample showed repeated lock-held decode/validation in presence
admission, with other queries waiting. All failed runs and cleanup evidence remain.

Reviewed repairs in91 include domain lookup indexes, one catalogue per presence
sweep with fresh admission checks, zero-Waiting tray read avoidance, strict typed-first
snapshot decoding, roving focus and passive failure capture. Relevant focused tests,
hooks and independent source reviews passed. Same-byte retained snapshot reads with
production opt-level1: first 0.989s, repeats 0.129/0.098s; debug: 1.387/0.447/0.435s.
The native App/CLI builds now use opt-level1 while retaining debug assertions and
paths. Ordinary dev/test settings and separate production isolation are unchanged.
All 24 runner tests passed. Exact repair a0384f89 is independently clear; integrated
cd9f45e8 has identical tree `543d8425b4a3d6f5af572e4b15b8cb264f40d4dc`.
**Latest native run:** `74bfd8ac-ee28-4284-83c9-284fd2856bcb` compiled optimized App
in4m32s and published full2k/5k with zero StoreBusy retries. Roving focus, row bounds,
20 search measurements, normalization/clear and Open filter count1320 were reached;
Done filter aria-pressed never became true. Final performance/restart assertions were
not reached. Cleanup passed. The pre-filter screenshot is cropped; source confirms
900×650 initial native window below CSS/documented1000×700 minimum. Root authorized
bringing already-reviewed97 minimum config hunk forward, supported genuine scrolling,
and bounded tree-wide failure capture; no production filter semantics change without
evidence. Repair3a2c55b is independently clear: supported minimum window, one genuine
scroll/click per filter, bounded whole-journey failure capture that preserves the
original error. Actual viewport and early timing evidence are asserted/retained.
Current native run3622d32e-4108-4302-9c39-228ba02ca70c is active at exact3a2c55b.
PR91 branch now includes package-only main d3502f7 as3f2411fa; detached run remains
on cd9f45e8, with all native product/test source unchanged by the parent merge.
No acceptance threshold/retry expansion or offline lifecycle workaround is approved.

**PR92:** worktree `.worktrees/personal-package-install`, branch `task/personal-package-install`.
Previous CI passed native/release isolation and 86.57% coverage, then installed doctor
rejected fixture-created `.ariadne`0755. Real CLI reproduced exit4 versus0700 exit0.
fbad9e5 fixed only private fixture directory modes and failure reporting. Full CI and
independent artifact audit passed: 86.58% coverage/all205 sources,31 installer tests,
actual production install/repeat/doctor/uninstall with history/settings preserved,
native five-input FIFO/Quit/restart/discovery, release isolation and42 browser tests.
PR92 merged; **P3.4/P6.3 are complete**. Existing installed Claude tests prove real
helper/Mod/Core/Discovery/ProviderFactory/NativeActivation and both join orders;
canonical resource-export tests prove bundle parity. P6.4 retains its physical
dependencies. Audit evidence: `/tmp/ariadne-pr92-green-ua0a96ik`.

Prepared branches use matching `task/<worktree>` names under `.worktrees/`:
`native-history-acceptance` (94), `guarded-history-actions` (93),
`native-graph-acceptance` (95), `packaged-route-acceptance` (96),
`product-accessibility` (97). Stack: 91→94→93→97; 95/96 are independent children of91.
Root is publishing all prepared branches while the local native run continues. New package main+docs were
propagated conflict-free to every branch;97 gate unit tests16/16 pass. Independent
published delta review must cover these newest parent updates once pushed. PR94/95 final runner conflicts
retain their history/graph fixture invocations plus the reviewed optimization env.
`audit_next_native_journeys` cleared the exact local94/93/95/97 heads;
`review_native_acceptance_repairs` cleared96. Published-head reviews remain required. PR descriptions are prepared at `/tmp/ariadne-pr{91,93,94,95,96,97}-body.md`;
update actual native validation before publication. Full native/browser acceptance
remains required; prepared source is not completion.

**Next three steps:** (1) inspect run3622d32e and resolve only demonstrated failures;
(2) monitor post-merge main and overlapping stack CI; (3) obtain exact published-head delta reviews and audit actual native artifacts before
qualified squash/stack merges.
Original closure:91→P4.4;94→P4.5/P4.6/P4.7;93→P5.3;95→P5.1/P5.2;97→P4.8.
96 covers only part of P6.1. Physical Mac lifecycle/notifications and live M7 remain
unproved. Owner installation and billable live hosts require approval once concrete
reviewable work is ready. Do not reopen unrelated process work.
