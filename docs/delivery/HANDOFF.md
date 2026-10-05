# Ariadne handoff

Checked 2026-10-05 01:08 UTC. Continue autonomously. Delegates use Sol 6.1 High.
This checkpoint is uncommitted; publish with the next product checkpoint.

**Main:** `20eb77d715c0aa58664dddea0232465598cf8cb1` (PR85), with
[green CI](https://github.com/kartiksayani/ariadne/actions/runs/37244941515).
PR85 passed independent review, 89.87% coverage, native receipt/exit and release
isolation. PRs80–82,84,89 were already merged. Full task closures still await83.

| PR | Published head / base | Current CI and review |
| --- | --- | --- |
| [83](https://github.com/kartiksayani/ariadne/pull/83) | `b2fd962` / main | Clear5409059548; [running with diagnostics](https://github.com/kartiksayani/ariadne/actions/runs/37249102645) |
| [86](https://github.com/kartiksayani/ariadne/pull/86) | `d4e0c2c` /83 | Clear5408938387; [same abort](https://github.com/kartiksayani/ariadne/actions/runs/37246721384) |
| [88](https://github.com/kartiksayani/ariadne/pull/88) | `49ba507` /86 | Clear5408938541; [same abort](https://github.com/kartiksayani/ariadne/actions/runs/37246724928) |
| [90](https://github.com/kartiksayani/ariadne/pull/90) | `6069d9d` / main | Clear5409080891; [running](https://github.com/kartiksayani/ariadne/actions/runs/37249498936) |
| [91](https://github.com/kartiksayani/ariadne/pull/91) | `7a99411` /88 | Clear5408938690; [canceled: shared broken startup](https://github.com/kartiksayani/ariadne/actions/runs/37246728599) |
| [92](https://github.com/kartiksayani/ariadne/pull/92) | `68e0a54` /88 | Clear5408938803; [canceled: shared broken startup](https://github.com/kartiksayani/ariadne/actions/runs/37246738589) |
| [93](https://github.com/kartiksayani/ariadne/pull/93) | `9bfbc74` /94 | Clear5408938904; [canceled: shared broken startup](https://github.com/kartiksayani/ariadne/actions/runs/37246735317) |
| [94](https://github.com/kartiksayani/ariadne/pull/94) | `c0c2abe` /91 | Clear5408939009; [canceled: shared broken startup](https://github.com/kartiksayani/ariadne/actions/runs/37246731520) |
| [95](https://github.com/kartiksayani/ariadne/pull/95) | `4bbd6b8` /91 | Clear5408939098; [canceled: shared broken startup](https://github.com/kartiksayani/ariadne/actions/runs/37246742119) |
| [96](https://github.com/kartiksayani/ariadne/pull/96) | `9254f3b` /91 | Clear5408939186; [installed Claude fixture failure](https://github.com/kartiksayani/ariadne/actions/runs/37246745052) |

| [97](https://github.com/kartiksayani/ariadne/pull/97) | `e0292ae` /93 | Independent review running; [CI running](https://github.com/kartiksayani/ariadne/actions/runs/37249848470) |

GitHub stack87 is83 →86 →88 →91 →94 →93. Merge only a fully qualified prefix,
using squash.90,92,95,96 remain independent siblings. Never infer acceptance from
source review. Current main integration, exact-head review and full CI still apply.

**Current work and ownership**
- Maintainer owns shared contracts, integration, catalogue and merges. Root main
  has intentional dirty tasks.json/roadmap.html overlays. Purple+A means actual
  implementation, not CI waiting. Active markers reflect actual implementation only; clear them when coding finishes.
- `.worktrees/resume-integration`, branch `maintenance/resume-integration`, has
  published `b2fd962`, containing backend capture, SDK EPIPE fixture and awaited
  control-handler cleanup. Exact independent review5409059548 is clear; all18
  control tests and both focused fixture regressions passed independently. HANDOFF is
  separately dirty. Root coordinates the next push with repairs below.
- `audit_claude85_green` owns `.worktrees/installed-lifecycle-repair`, branch
  `fix/installed-lifecycle-fixture`: installed-join.js plus its Rust test only.
  The SDK lacked a stdin EPIPE handler. Deterministic old-code failure reproduced;
  repair preserves actual child exit/stdout/stderr. Commit370ee71 is clean,
  all six lifecycle tests pass, independently reviewed and cherry-picked as b13e217.
  The domain-transitions warm cache is idle after independent review.
- `repair_pr90_current_ci` owns `.worktrees/codex-native-join`, branch
  `task/codex-native-join`. Adds deterministic in-flight Unknown conformance proof
  after independent mutation escaped the revised activation test. Also repairs
  ControlServer shutdown: await canceled handlers before returning ownership.
  Deterministic old-code failure reproduced; separate commit9ef4eb0 passes all
  18 control tests and three Codex joins and is cherry-picked as ddd0a0b on83.
  Further local commits:956365c drains the fixture-owned Runtime before lease
  reacquire; e19c645 restores deterministic canonical Unknown proof; addad11 takes
  the SDK repair. All5 activation/18 control/3 Codex joins/24 conformance pass.
  Final head6069d9d is pushed and independently clear (review5409080891).
  All56 author cases and53 independent cases pass. Queue956365c/e19c645 and
  readiness fix6069d9d for83 at its next necessary update; keep current CI stable.
  Cache: native-provider-activation/target.
  Keep shared control fix in a separate commit for83; activation compatibility is90-only.
- `validate_product_accessibility` owns `.worktrees/product-accessibility`, branch
  `task/product-accessibility`, based on reviewed93. P4.8 fixes actual App/dialog/
  owner-input shortcuts and announcements, adds ordinary App captures and native
  keyboard proof. Owns App.tsx, related accessibility/reference/input components,
  native-smoke helper wiring, visual config and narrow capture-scope/typecheck updates.
  Maintainer recorded fresh Bring shortcut semantics in its UI_AND_NATIVE.md; include
  that change. PR97 is pushed at e0292ae; worktree is clean.176 focused tests and latest38
  accessibility tests passed. review_product_accessibility owns independent review;
  browser/native acceptance remains pending.
- Other product worktrees remain on their published checkpoints. Check actual
  local state before reuse; preserve all worktrees, history and ignored evidence.

- `repair_composed_native_startup` now owns `.worktrees/local-native-startup`,
  branch `fix/local-native-startup`, based on83 b2fd962. The owner authorized local
  native reproduction and then a standing exception for local checks that save
  time overall. Exclusive build target is this worktree's target/native-e2e;
  private fixture HOME and ARIADNE_HOME, no real host/store. First attempt reached
  no compilation because tsc was absent from child PATH; corrected tool PATH and
  retried. Capture actual stderr before deciding the bundle hypothesis.
- `.worktrees/ci-failfast-order`, branch `fix/ci-failfast-order`, has unpushed
  ae37a751: required gate before reference captures. Two observed failures each
  wasted about8m30 on captures. All captures remain required for success. Independent
  local review is clear;18 workflow cases/mutation and20 Python/20 Node tests pass.
  Carry with the next necessary app repair; do not restart current CI for it alone.

**Evidence and limitations**
83/86/88 passed independently audited coverage (86.40%,86.40%,86.54%; all required
sources present) but aborted before WebDriver readiness. No journey or release
proof exists for these heads. Backend output was not retained.80b7f1a fixes capture;
its real launcher regression proves stderr survives failure. Notification-center
initialization in an unbundled executable is only a source hypothesis, not a cause.
PR96 failed earlier: unhandled fixture stdin EPIPE killed its scripted SDK.

**Next three steps**
1. Finish bounded shared repairs, independent affected-flow reviews and one coherent
   push. Run83 with retained backend diagnostics; diagnose actual abort, not guesses.
   Coordinate parent propagation without overwriting active P4.8 work.
2. Audit passing native/coverage/release artifacts, merge qualified stack prefixes,
   and immediately update honest task closures in the local graph and catalogue.
  83 can close P2.4/P3.1/P3.2 and, with85/76, P3.3/P3.8 after original proof passes.
3. Continue P4.8 and independent siblings. Recorded Mac window/notification/tray
   interactions, live M7 and final release remain open. No manual harness alone
   proves those criteria; actual owner install/live paid hosts need approval.

Use pinned Node22 and NPM_CONFIG_USERCONFIG=/dev/null. No warm native cache exists;
the owner now authorizes necessary local native/browser/build checks whenever
likely to save time overall, without further confirmation. Required CI remains. MCP
and Seezo remain disabled by owner waiver; no organization security approval claimed.
