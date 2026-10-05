# Ariadne resumption handoff

Checkpoint 2026-10-05 06:28 UTC. Continue autonomously; delegates use **Sol 6.1 High only**.
Local checks/builds/native runs are authorized. MCP/the review tool remain disabled. Root alone
squash merges after exact-head independent review, green CI and proven acceptance.
Preserve all worktrees, history and evidence. Reuse relevant reviewer contexts when
new spawns hit the thread limit; four delegates ran concurrently after usage reset.

**Main:** `d3502f7c207967ced6570cb38e2760e88f53d9db`, PR92 merged;
[main CI passed](https://github.com/kartiksayani/ariadne/actions/runs/37264196572).
**Roadmap: 34/49 complete; P4.4 and P6.1 actively executing.** Overlap/flicker fixes
are merged. PR92 closed P3.4/P6.3; package coverage was 86.58%, with actual private
production install/repeat/doctor/uninstall, native FIFO/Quit/restart, release
isolation and browser proof. Audit: `/tmp/ariadne-pr92-green-ua0a96ik`.
P6.4 still retains its physical dependencies. Root's dirty HANDOFF/tasks/roadmap
are intentional current state. Two safety stashes remain; no cleanup is pending.

## Published work

All six exact heads have independent source reviews with no required findings.
CI/native acceptance remains pending; source review alone is not merge clearance.
Stack: **91 → 94 → 93 → 97**. PR95/96 are independent children of91.
Each worktree is under `.worktrees/`, on `task/<worktree>`.

| PR | Worktree | Published head | CI |
| --- | --- | --- | --- |
| 91 | native-tree-acceptance | bb05c9e4 | [Queued](https://github.com/kartiksayani/ariadne/actions/runs/37271534010) |
| 94 | native-history-acceptance | b329c5de | [Running](https://github.com/kartiksayani/ariadne/actions/runs/37271533980) |
| 93 | guarded-history-actions | 52cfcf27 | [Running](https://github.com/kartiksayani/ariadne/actions/runs/37271534538) |
| 95 | native-graph-acceptance | 6a1f7056 | [Running](https://github.com/kartiksayani/ariadne/actions/runs/37271534255) |
| 96 | packaged-route-acceptance | 6d04e545 | [Running](https://github.com/kartiksayani/ariadne/actions/runs/37271534223) |
| 97 | product-accessibility | cf87480d | [Running](https://github.com/kartiksayani/ariadne/actions/runs/37271533766) |

## Active owners and unpublished work

- `prove_three_binding_fifo`: P4.4, native tree and owner-filter focus repair.
  PR91 branch is published; isolated repair in `native-tree-filter-observation`
  has fixture commit `cb04e49` plus product/test fix `6802b51`; 26 author and
  26 independent component tests pass, review clear. PR91 fast-forwarded locally
  to67ce914, not pushed. **Exclusive** native runner/cache owner:
  `.worktrees/local-native-startup`, `target/native-e2e`. Do not launch another App
  or build there. Private HOME `/private/tmp/ariadne-local-native-home-kj60kx9v`;
  retain real CARGO_HOME/RUSTUP_HOME, pinned Node22 PATH and disabled npm user config.
- `review_validation_indexes`: independent PR91 repair review, then published delta.
- `cache_tree_search_text`: `.worktrees/tree-search-text-cache`, branch
  `fix/tree-search-text-cache` atop6802b51; owns only rows.ts/rows.test.tsx.
  Unpushed candidate67ce914 adds private immutable-session search-text cache and
  new-snapshot regression; 53 focused tests/hook pass; independent review clear with1,920 functional
  old/new comparisons.
  Same2k/5k warmed20-query selector batches: median54.094→13.712ms; this is not
  native latency proof. Native owner holds next run for review and docs checkpoint.
- `audit_next_native_journeys`: PR94/93/95/97 reviews clear; inspecting retained
  search timing. PR97 has root-authored, independently cleared **unpushed266eaeb**
  correcting outer-window evidence wording; include with next necessary code push.
- `review_native_acceptance_repairs`: PR96 review clear; no distinct CI failure yet.
- `native_window_acceptance`: fresh Sol 6.1 High worker preparing bounded P6.1
  physical lifecycle checks atop PR96; owns only new tests/native/window/** and
  docs/planning/evidence/native/window.md. No App/build execution until runner is free.
- `audit_green_acceptance86_88`: preparing remaining P6.1/P6.2/P6.4 physical proof
  assignments. Read-only; no second native App or live host execution.

## Current blocker and evidence

Native run `95e3b26e-a7ef-4da6-963f-fc4f19434508` at published91 `bb05c9e4`
completed **2,000 items / 5,000 messages with zero StoreBusy retries**. Actual native
outer window1000×700 and WebView1000×668 are proved; Done filter now passed. Me save
succeeded but index-key reuse broke element identity. Component regression confirms
real keyboard focus can change to collaborator; stable keys alone blur on reverse
reorder. Author is fixing stable type-qualified keys plus minimal guarded focus
restoration, proving both Space toggles and no stealing another focused control.
Do not merge the fixture-only selector repair as the complete fix.

The prematurely started follow-up98abfe6a was safely stopped pre-App through
owned-wrapper SIGINT; exit/port cleanup proved, warm artifacts preserved.

First usable **1,013ms**; 20-search **p95 153ms exceeds150ms**. Final journey/anchor/
Quit/restart assertions remain unproved. Cleanup succeeded. Keep every failed sample;
no threshold relaxation, repeat-until-pass or offline Quit/relaunch workaround.
Earlier optimized run measured1,136ms/142ms but failed before full acceptance.

Reviewed91 repairs already include domain indexes, one presence catalogue per sweep
with fresh admission checks, skipping zero-Waiting tray snapshots, strict typed-first
snapshot decoding, roving-focus effect ordering and bounded passive diagnostics.
Native App/CLI builds use opt-level1 **with debug assertions**; ordinary dev/test and
separate production isolation remain unchanged. Original thresholds still apply.
Window assertions use existing read-only outer_size/scale_factor, not inner height.
Prior run details and repair history remain in git and retained local artifacts.

## Next three steps

1. Finish and independently review owner-focus repair; run full native acceptance
   on the coherent candidate. Investigate the original150ms target honestly.
2. Propagate parent correction to94→93→97 and95/96, publish one checkpoint, obtain
   exact-head delta reviews and inspect CI while preparing physical acceptance.
3. Audit actual native/browser artifacts, then merge qualified stack prefixes and
   update local tasks/roadmap. Pending main CI does not block qualified merges;
   failed main CI pauses merges.

Closure map:91→P4.4;94→P4.5/P4.6/P4.7;93→P5.3;95→P5.1/P5.2;97→P4.8.
PR96 proves only part of P6.1. Physical Mac lifecycle/notification proof remains;
live M7 and actual owner installation need approval once concrete work is ready.
