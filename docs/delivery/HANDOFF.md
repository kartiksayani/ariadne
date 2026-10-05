# Ariadne handoff

Checkpoint 2026-10-05, after full local native journey passed. Continue autonomously;
delegates use Sol 6.1 High only. Owner authorizes local builds/tests whenever they
save overall time; required CI and independent review still apply. MCP/the review tool disabled.

**Main:** `20eb77d715c0aa58664dddea0232465598cf8cb1`, PR85,
[green CI](https://github.com/kartiksayani/ariadne/actions/runs/37244941515).
22/49 full tasks complete. Preserve root's dirty tasks.json/roadmap.html overlay.

| PR | Published head | CI / independent review |
| --- | --- | --- |
| [83](https://github.com/kartiksayani/ariadne/pull/83) | b2fd962 | [Failed startup](https://github.com/kartiksayani/ariadne/actions/runs/37249102645); clear5409059548. Local repair below awaits push/review. |
| [86](https://github.com/kartiksayani/ariadne/pull/86) | d4e0c2c | Failed same startup; clear5408938387. |
| [88](https://github.com/kartiksayani/ariadne/pull/88) | 49ba507 | Failed same startup; clear5408938541. |
| [90](https://github.com/kartiksayani/ariadne/pull/90) | 6069d9d | [Running](https://github.com/kartiksayani/ariadne/actions/runs/37249498936); clear5409080891; 56 author/53 independent focused cases pass. |
| [91](https://github.com/kartiksayani/ariadne/pull/91) | 7a99411 | Canceled: inherited startup; clear5408938690. |
| [92](https://github.com/kartiksayani/ariadne/pull/92) | 68e0a54 | Canceled: inherited startup; clear5408938803. |
| [93](https://github.com/kartiksayani/ariadne/pull/93) | 9bfbc74 | Canceled: inherited startup; clear5408938904. |
| [94](https://github.com/kartiksayani/ariadne/pull/94) | c0c2abe | Canceled: inherited startup; clear5408939009. |
| [95](https://github.com/kartiksayani/ariadne/pull/95) | 4bbd6b8 | Canceled: inherited startup; clear5408939098. |
| [96](https://github.com/kartiksayani/ariadne/pull/96) | 9254f3b | Failed installed SDK EPIPE fixture; clear5408939186. |
| [97](https://github.com/kartiksayani/ariadne/pull/97) | e0292ae | [Failed captures](https://github.com/kartiksayani/ariadne/actions/runs/37249848470); required review5409105752/5409111194 being fixed. |

Stack87:83 →86 →88 →91 →94 →93;97 is based93.92/95/96 are siblings.
Merge only a qualified squash prefix, with current main integration, exact-head
review and full green CI. Never count canceled checks or source review as acceptance.

**Active owners / local work** (worktrees below are under `.worktrees/`):
- Maintainer: `resume-integration`, `maintenance/resume-integration`, unpublished
  assembled head `dd14960` plus this documentation checkpoint. Includes runtime
  fixture drainage, canonical Unknown proof, installed readiness deadline, required
  checks before captures, bundled native launch and native fixture corrections.
  Shared contracts/catalogue/merges remain maintainer-owned.
- `repair_composed_native_startup`: `local-native-startup`, preserved branch
  `fix/local-native-startup` at `a561be7`, detached at assembled `dd14960` for exact
  warm native validation. Exclusive target `target/native-e2e`; private HOME/store.
  Confirmed raw executable aborts in macOS notification initialization because
  bundleProxyForCurrentProcess is nil. Build/launch the actual `.app` executable
  fixes startup. Full original journey passed at `025c245` plus fixture overlay
  committed as `a561be7`: receipt/provider handling, negative nonce, file integrity,
  PID exit and port cleanup. Evidence `coverage/native-e2e/1e8706ad-a1f4-4d7e-abbb-2a56fe248657`.
- `validate_product_accessibility`: `product-accessibility`, `task/product-accessibility`.
  Uncommitted review fixes: stale async navigation guard; stale/consumed numeric
  token protection; real light-theme contrast; empty/filter capture assertions.
  Root authorized and updated MODULE_CONTRACTS/UI_AND_NATIVE. Navigation getter
  plus optional pre-dispatch cancellation guard are approved. 224 focused tests
  and 27 ordinary browser states have passed; final regression/checkpoint pending.
  `review_product_accessibility` will independently re-review the new exact head.
- `repair_descendant_native_selectors`: only unique native helper files in
  native-domain-acceptance, desktop-discovery-join, native-tree-acceptance,
  native-history-acceptance, guarded-history-actions and native-graph-acceptance.
  Fix 27 confirmed compound CSS/text selector sites; commit without parent updates
  or pushes. Maintainer coordinates propagation/native runs. Preserve P4.8 work.
- PR90 branch `task/codex-native-join` is clean/pushed. Runtime/cache repairs reviewed.
  Warm Rust targets native-provider-activation/target, domain-transitions/target,
  owner-answer-ui/target, binding-connect-relay/target are idle; assign exclusively.

**Next three steps**
1. Verify assembled83 locally, push coherent repairs, independent exact-head delta
   review, full CI. CI now checks before eight-minute captures, retaining both gates.
2. Propagate repaired parents/selectors once; reuse warm local native cache for
   critical86/88 journeys while CI/reviews run. Audit native/coverage/release artifacts,
   merge qualified prefixes and immediately update honest local roadmap closures.
   83 can close P2.4/P3.1/P3.2 plus P3.3/P3.8 with merged85/76 when proof passes.
3. Finish97 review/browser/native acceptance and siblings. Physical Mac lifecycle,
   notifications/tray, M7 live hosts and final release remain open; actual owner
   installation/live paid hosts need approval. Do not invent completion.

Pinned Node22 path `/opt/homebrew/opt/node@22/bin`; NPM_CONFIG_USERCONFIG=/dev/null.
Native beforeBuild additionally needs worktree node_modules/.bin in PATH. Preserve
all worktrees, ignored evidence and caches; no new delivery framework or log copies.
