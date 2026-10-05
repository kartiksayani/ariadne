# Ariadne handoff

Checkpoint 2026-10-05 02:46 UTC. Continue autonomously; delegates Sol 6.1 High only.
Owner authorizes focused local builds/tests to save overall time. MCP/the review tool disabled.

**Main:** `c773f3438f55f443860b3c6d88cd60a3deee7281` (PR83 merged).
Main CI pending; previous main green. PR83 passed [CI](https://github.com/kartiksayani/ariadne/actions/runs/37252266595),
[exact independent review](https://github.com/kartiksayani/ariadne/pull/83#pullrequestreview-5409284459),
and artifact audit: 86.44% weighted coverage, all 200 required sources, actual native
Reply/Send/result/host completion, packaged release isolation and all reference captures.
**28/49 tasks complete:** newly closed P2.4, P3.1, P3.2, P3.3, P3.6, P3.8.
Root local tasks.json/roadmap.html already reflect these closures; refresh the local page.
P4.4 is the active implementation marker. PR86 and PR88 native acceptance passed locally; their CI/review/merge remain pending.

| Open PR | Published head | CI / review |
| --- | --- | --- |
| [86](https://github.com/kartiksayani/ariadne/pull/86) | 7c87e35 | Newly pushed after full native pass; exact independent review5409534195 clear; CI pending. Base mainc773f34. |
| [88](https://github.com/kartiksayani/ariadne/pull/88) | eca5758 source | Full native passed locally; this docs checkpoint is next push. Final delta review/CI pending. |
| [91](https://github.com/kartiksayani/ariadne/pull/91) | 7a99411 | Old CI canceled; source review clear at old head. |
| [92](https://github.com/kartiksayani/ariadne/pull/92) | 68e0a54 | Old CI canceled; source review clear at old head. |
| [93](https://github.com/kartiksayani/ariadne/pull/93) | 9bfbc74 | Old CI canceled; source review clear at old head. |
| [94](https://github.com/kartiksayani/ariadne/pull/94) | c0c2abe | Old CI canceled; source review clear at old head. |
| [95](https://github.com/kartiksayani/ariadne/pull/95) | 4bbd6b8 | Old CI canceled; source review clear at old head. |
| [96](https://github.com/kartiksayani/ariadne/pull/96) | 9254f3b | Old installed SDK fixture failure; source review clear at old head. |
| [97](https://github.com/kartiksayani/ariadne/pull/97) | d5359fa | [CI failed](https://github.com/kartiksayani/ariadne/actions/runs/37252990615), audit underway; exact review5409329259 clear, all threads resolved. |

**Owners and unpushed work** (paths relative to `.worktrees/`):
- PR86 `native-domain-acceptance`, branch `task/native-domain-acceptance`: published
  `7c87e35`; `prove_three_binding_fifo` finished full local native proof at exact head.
  Evidence: `local-native-startup/coverage/native-e2e/bbf9a400-f467-4863-82d4-0361f3682ff5`.
  Five actual UI inputs, all FIFO result/host-completion joins, unchanged demo,
  real delivery Quit, fresh PID/nonce restored history/receipts without resend,
  and restoration Quit all passed. Final source review `review_native_acceptance_repairs`
  posted exact-head clear5409534195; CI remains pending. Navigation error retention,
  Waiting heartbeat mount stability and saved-answer overlap independently reviewed.
- PR88 `desktop-discovery-join`, branch `task/desktop-discovery-join`: source
  `eca5758` passed full native: explicit registration/connection to exact discovered
  Codex thread/socket, five FIFO inputs/joins, both Quit proofs and restoration.
  Evidence `local-native-startup/coverage/native-e2e/1c10140f-c2b8-4834-bbfb-c122494f9a41`.
  Maintainer carries this updated catalogue/handoff before coordinated push.
- `prove_three_binding_fifo`: owns PR91 `native-tree-acceptance`, branch
  `task/native-tree-acceptance`; integrating final88, preserving selectorc301ed3,
  and proving original 2k/5k native tree acceptance. Exclusive owner of
  `local-native-startup` and `target/native-e2e` after88 handover.
- `repair_history_graph_native_helpers`: owns only dedicated history/graph native
  helpers in their existing worktrees. Real scrolling before offviewport controls;
  history seed/navigation race adaptation awaits bounded root adjudication.
- `product-accessibility`, branch `task/product-accessibility`: local5b768e7,
  published d5359fa; held ec0055c minimum1000×700/actual viewport assertion and
  5b768e7 navigation error fix (already integrated86). Await propagated parents.
  Latest97 failed solely inherited pure-test coverage inventory before native.
- `guarded-history-actions`, branch `task/guarded-history-actions`: unpushed02bbbbd
  relocates pure Rust test into existing tests-directory convention; targeted real
  Rust test and hook pass. No coverage gate or production exclusion change.
- Other unpushed selector repairs: `native-tree-acceptance`c301ed3;
  `native-history-acceptance`7278706; `native-graph-acceptance`6318721.
  Corresponding branches are `task/` plus worktree basename. Preserve during propagation.
- Root owns catalogue/chart/HANDOFF; this88 checkpoint carries latest copies.
  Root local roadmap already shows28/49; never restart CI solely for status text.

**Next three steps**
1. Obtain final86 exact-head review and green CI, audit artifacts and squash merge.
   Then close P4.1/P4.3 immediately; do not call pending CI a pass.
2. Push/review88 and run91 native while86 CI runs; propagate86 →88 →91 →94 →93,
   retaining selector and pure-test repairs;97 follows93.
   92/95/96 are siblings. Reuse local native build for critical journeys while CI runs.
   Squash only qualified PRs integrated with current main; failed main pauses merges.
3. Audit acceptance and immediately update roadmap on each merge. Physical Mac
   lifecycle/notification/tray checks and M7 live hosts remain unproved; actual owner
   installation and billable hosts still require explicit approval.

Preserve ignored evidence and shared ui-reference/node_modules. Owner-authorized
cleanup removed five verified merged worktrees, preserving branches/history; about
10GiB free after cleanup. binding-connect-relay target is cold; native-provider-activation,
domain-transitions and owner-answer-ui caches remain. Native runs use private HOME,
existing RUSTUP_HOME/CARGO_HOME and pinned Node22 plus worktree node_modules/.bin.
User's 07:35 recording showed a genuine Waiting heartbeat remount bug, now fixed
and locally independently reviewed; app closure at end was test cleanup.
