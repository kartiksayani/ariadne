# Ariadne handoff

Checkpoint 2026-10-05, after full local native journey passed. Continue autonomously;
delegates use Sol 6.1 High only. Owner authorizes local builds/tests whenever they
save overall time; required CI and independent review still apply. MCP/Seezo disabled.

**Main:** `6387674f358c9dd9c82e12aec224760861582238`, PR90,
[CI running](https://github.com/kartiksayani/ariadne/actions/runs/37251995721).
PR90 merged after exact independent review, 89.91% coverage with all176 required
sources, actual native receipt/cleanup and packaged release isolation. Previous
main20eb77d was green.
22/49 full tasks complete. Preserve root's dirty tasks.json/roadmap.html overlay.

| PR | Published head | CI / independent review |
| --- | --- | --- |
| [83](https://github.com/kartiksayani/ariadne/pull/83) | b2fd962 | [Failed startup](https://github.com/kartiksayani/ariadne/actions/runs/37249102645); clear5409059548. Local repair below awaits push/review. |
| [86](https://github.com/kartiksayani/ariadne/pull/86) | d4e0c2c | Failed same startup; clear5408938387. |
| [88](https://github.com/kartiksayani/ariadne/pull/88) | 49ba507 | Failed same startup; clear5408938541. |
| [90](https://github.com/kartiksayani/ariadne/pull/90) | 6069d9d | Merged; [green audited CI](https://github.com/kartiksayani/ariadne/actions/runs/37249498936); clear5409080891. |
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
- Maintainer: `resume-integration`, `maintenance/resume-integration`, native repair published at `cc11095`, independently clear5409236668.
  Current local HEAD integrates main6387674; conflicts preserve the reviewed
  check-before-capture order and presence-aware activation assertions. Includes runtime
  fixture drainage, canonical Unknown proof, installed readiness deadline, required
  checks before captures, bundled native launch and native fixture corrections.
  Shared contracts/catalogue/merges remain maintainer-owned.
- `repair_composed_native_startup`: `local-native-startup`, preserved branch
  `fix/local-native-startup` at `a561be7`, passed exact clean assembled `dd14960` (cc11095 differs only by HANDOFF).
  Evidence `coverage/native-e2e/fc0cc383-41f6-4391-bd70-e622f5035079`.
  Warm target is now exclusively assigned to `prove_three_binding_fifo` for86. Exclusive target `target/native-e2e`; private HOME/store.
  Confirmed raw executable aborts in macOS notification initialization because
  bundleProxyForCurrentProcess is nil. Build/launch the actual `.app` executable
  fixes startup. Full original journey passed at `025c245` plus fixture overlay
  committed as `a561be7`: receipt/provider handling, negative nonce, file integrity,
  PID exit and port cleanup. Evidence `coverage/native-e2e/1e8706ad-a1f4-4d7e-abbb-2a56fe248657`.
- `validate_product_accessibility`: `product-accessibility`, `task/product-accessibility`.
  Checkpoint5b55583 pushed; further fix and parent merge local: stale async navigation guard; stale/consumed numeric
  token protection; real light-theme contrast; empty/filter capture assertions.
  Remaining review P2: after a dispatched preference write, Escape must suppress
  stale local reveal without rewriting the durable result. Root authorized and
  updated MODULE_CONTRACTS/UI_AND_NATIVE. Navigation getter
  plus optional pre-dispatch cancellation guard are approved. 224 focused tests
  and 27 ordinary browser states have passed; final regression/checkpoint pending.
  `review_product_accessibility` will independently re-review the new exact head.
- `prove_three_binding_fifo` owns86 merge a939a4e and warm native five-input/
  Quit/reopen validation. Selector repairs committed without pushes:86 74a8a49;
  88 442295b;91 c301ed3;94 7278706;93 067f1e0;95 6318721. Preserve these
  during parent propagation. `repair_descendant_native_selectors` now checks
  integrated83 activation/Codex tests with native-provider-activation/target.
  Root owns83 commits; worker must preserve the root activation assertion fix.
- PR90 branch `task/codex-native-join` is clean/pushed. Runtime/cache repairs reviewed.
  Warm Rust targets domain-transitions/target, owner-answer-ui/target and
  binding-connect-relay/target are idle; assign exclusively.

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
