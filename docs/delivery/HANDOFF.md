# Ariadne handoff

Checkpoint 2026-10-05 02:25 UTC. Continue autonomously; delegates Sol 6.1 High only.
Owner authorizes focused local builds/tests to save overall time. MCP/Seezo disabled.

**Main:** `c773f3438f55f443860b3c6d88cd60a3deee7281` (PR83 merged).
Main CI pending; previous main green. PR83 passed [CI](https://github.com/kartiksayani/ariadne/actions/runs/37252266595),
[exact independent review](https://github.com/kartiksayani/ariadne/pull/83#pullrequestreview-5409284459),
and artifact audit: 86.44% weighted coverage, all 200 required sources, actual native
Reply/Send/result/host completion, packaged release isolation and all reference captures.
**28/49 tasks complete:** newly closed P2.4, P3.1, P3.2, P3.3, P3.6, P3.8.
Root local tasks.json/roadmap.html already reflect these closures; refresh the local page.
P4.1 is the sole active implementation marker. Five-input/relaunch acceptance is still open.

| Open PR | Published head | CI / review |
| --- | --- | --- |
| [86](https://github.com/kartiksayani/ariadne/pull/86) | d4e0c2c | Old startup failure; repaired local head below, new exact-head review/CI required. Base now main. |
| [88](https://github.com/kartiksayani/ariadne/pull/88) | 49ba507 | Old inherited startup failure; source review clear at old head. |
| [91](https://github.com/kartiksayani/ariadne/pull/91) | 7a99411 | Old CI canceled; source review clear at old head. |
| [92](https://github.com/kartiksayani/ariadne/pull/92) | 68e0a54 | Old CI canceled; source review clear at old head. |
| [93](https://github.com/kartiksayani/ariadne/pull/93) | 9bfbc74 | Old CI canceled; source review clear at old head. |
| [94](https://github.com/kartiksayani/ariadne/pull/94) | c0c2abe | Old CI canceled; source review clear at old head. |
| [95](https://github.com/kartiksayani/ariadne/pull/95) | 4bbd6b8 | Old CI canceled; source review clear at old head. |
| [96](https://github.com/kartiksayani/ariadne/pull/96) | 9254f3b | Old installed SDK fixture failure; source review clear at old head. |
| [97](https://github.com/kartiksayani/ariadne/pull/97) | d5359fa | [CI failed](https://github.com/kartiksayani/ariadne/actions/runs/37252990615), audit underway; exact review5409329259 clear, all threads resolved. |

**Owners and unpushed work** (paths relative to `.worktrees/`):
- `prove_three_binding_fifo`: `native-domain-acceptance`, branch `task/native-domain-acceptance`,
  local `4ed6fea`. Integrated reviewed parent064dfce and merged mainc773f34 with
  identical-tree proof. Owns native smoke/provider fixture and exclusive warm
  `local-native-startup/target/native-e2e`; full native run underway on detached4ed6fea.
  Local commits include real scoped selectors, delivery phase, genuine wrong-identity
  provider facts, actual ledger publication/viewport waits, removal of unnecessary
  WebDriver refresh, and one explicit recovery action after visible revision conflict.
  Navigation error retention01dc932 (source5b768e7) and Waiting heartbeat repair
  a50d337 (source045d103) independently reviewed locally; exact pushed-head review remains.
  Maintainer exclusively owns this branch's tasks.json, roadmap.html and HANDOFF update.
- `review_product_accessibility`: local independent clear for both two-file fixes;
  navigation71+2 independent probes; Waiting71 tests including focus/draft identity
  and durable question fencing. No automatic mutation retry was introduced.
- `audit_accessibility_ci_failure`: read-only diagnosis of latest97 failure.
- `product-accessibility`, branch `task/product-accessibility`: local5b768e7,
  published d5359fa; held ec0055c minimum1000×700/actual viewport assertion and
  5b768e7 navigation error fix. Native acceptance and propagated parent still needed.
- Other unpushed selector repairs: `desktop-discovery-join`442295b;
  `native-tree-acceptance`c301ed3; `native-history-acceptance`7278706;
  `guarded-history-actions`067f1e0; `native-graph-acceptance`6318721.
  Corresponding branches are `task/` plus worktree basename. Preserve during propagation.

**Next three steps**
1. Finish actual five-input/Quit/reopen86 proof, push coherent checkpoint with this
   catalogue update, obtain independent exact-head delta/affected-flow review and full CI.
2. Propagate86 →88 →91 →94 →93 once, retaining scoped-selector repairs;97 follows93.
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
