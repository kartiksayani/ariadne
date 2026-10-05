# Ariadne handoff

Checked 2026-10-05 00:50 UTC. Continue autonomously. Delegates use Sol 6.1 High.
This checkpoint is uncommitted; publish with the next product checkpoint.

**Main:** `20eb77d715c0aa58664dddea0232465598cf8cb1` (PR85), with
[green CI](https://github.com/kartiksayani/ariadne/actions/runs/37244941515).
PR85 passed independent review, 89.87% coverage, native receipt/exit and release
isolation. PRs80–82,84,89 were already merged. Full task closures still await83.

| PR | Published head / base | Current CI and review |
| --- | --- | --- |
| [83](https://github.com/kartiksayani/ariadne/pull/83) | `9d416f0` / main | Clear5408932429; [native startup abort](https://github.com/kartiksayani/ariadne/actions/runs/37246640362) |
| [86](https://github.com/kartiksayani/ariadne/pull/86) | `d4e0c2c` /83 | Clear5408938387; [same abort](https://github.com/kartiksayani/ariadne/actions/runs/37246721384) |
| [88](https://github.com/kartiksayani/ariadne/pull/88) | `49ba507` /86 | Clear5408938541; [same abort](https://github.com/kartiksayani/ariadne/actions/runs/37246724928) |
| [90](https://github.com/kartiksayani/ariadne/pull/90) | `a4ac32c` / main | Required P2 review5409022282; [queued](https://github.com/kartiksayani/ariadne/actions/runs/37248155625) |
| [91](https://github.com/kartiksayani/ariadne/pull/91) | `7a99411` /88 | Clear5408938690; [running](https://github.com/kartiksayani/ariadne/actions/runs/37246728599) |
| [92](https://github.com/kartiksayani/ariadne/pull/92) | `68e0a54` /88 | Clear5408938803; [running](https://github.com/kartiksayani/ariadne/actions/runs/37246738589) |
| [93](https://github.com/kartiksayani/ariadne/pull/93) | `9bfbc74` /94 | Clear5408938904; [running](https://github.com/kartiksayani/ariadne/actions/runs/37246735317) |
| [94](https://github.com/kartiksayani/ariadne/pull/94) | `c0c2abe` /91 | Clear5408939009; [running](https://github.com/kartiksayani/ariadne/actions/runs/37246731520) |
| [95](https://github.com/kartiksayani/ariadne/pull/95) | `4bbd6b8` /91 | Clear5408939098; [running](https://github.com/kartiksayani/ariadne/actions/runs/37246742119) |
| [96](https://github.com/kartiksayani/ariadne/pull/96) | `9254f3b` /91 | Clear5408939186; [installed Claude fixture failure](https://github.com/kartiksayani/ariadne/actions/runs/37246745052) |

GitHub stack87 is83 →86 →88 →91 →94 →93. Merge only a fully qualified prefix,
using squash.90,92,95,96 remain independent siblings. Never infer acceptance from
source review. Current main integration, exact-head review and full CI still apply.

**Current work and ownership**
- Maintainer owns shared contracts, integration, catalogue and merges. Root main
  has intentional dirty tasks.json/roadmap.html overlays. Purple+A means actual
  implementation, not CI waiting. Active markers: P3.6, P4.8.
- `.worktrees/resume-integration`, branch `maintenance/resume-integration`, has
  unpushed `80b7f1a` (backend capture), `b13e217` (SDK EPIPE fixture), and
  `ddd0a0b` (await control-handler cleanup). Diagnostic and SDK local reviews are
  clear; affected-flow control review and exact published-head reviews remain. HANDOFF is
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
  Activation ownership investigation and Unknown regression continue.
  Cache: native-provider-activation/target.
  Keep shared control fix in a separate commit for83; activation compatibility is90-only.
- `validate_product_accessibility` owns `.worktrees/product-accessibility`, branch
  `task/product-accessibility`, based on reviewed93. P4.8 fixes actual App/dialog/
  owner-input shortcuts and announcements, adds ordinary App captures and native
  keyboard proof. Owns App.tsx, related accessibility/reference/input components,
  native-smoke helper wiring, visual config and narrow capture-scope/typecheck updates.
  Maintainer recorded fresh Bring shortcut semantics in its UI_AND_NATIVE.md; include
  that change. Ten focused UI tests passed; implementation/capture work continues.
- Other product worktrees remain on their published checkpoints. Check actual
  local state before reuse; preserve all worktrees, history and ignored evidence.

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
no cold native build is authorized. Heavy browser/native checks stay in CI. MCP
and Seezo remain disabled by owner waiver; no organization security approval claimed.
