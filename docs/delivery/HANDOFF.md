# Ariadne handoff

Checked 2026-10-04 23:20 UTC. Verify GitHub before acting. Owner requests
autonomous delivery, Sol 6.1 High delegates only. Ten slots work; coding and
independent review overlap. Reviewed-parent stacks are authorized while CI runs.

**Main:** `79c0d86705d688f5504672e4d79d4d76cbd5ec3c`, PR89 squash;
[postmerge CI green](https://github.com/kartiksayani/ariadne/actions/runs/37240630623).
PR89 repaired FIFO test shutdown coordination, preserving production uncertainty.
Its audited proof had 89.77% coverage, all 175 required sources and actual native
receipt/clean exit. PRs80–82 and84 are also merged.

| PR | Code checkpoint / base | Current evidence |
| --- | --- | --- |
| [83](https://github.com/kartiksayani/ariadne/pull/83) | Local `3b710cc` plus this checkpoint / main | Publishing lease, control/activation and recovery-fixture repairs; independent delta review running. Old [CI failed](https://github.com/kartiksayani/ariadne/actions/runs/37241027659) physical owner reacquisition after shutdown. Check latest head/run |
| [85](https://github.com/kartiksayani/ariadne/pull/85) | `224e737` / main | Clear5408629599; independent 83 Rust + 53 Mod passed; [CI running](https://github.com/kartiksayani/ariadne/actions/runs/37241561932) |
| [86](https://github.com/kartiksayani/ariadne/pull/86) | `3759819` /83 | Clear5408605936; [failed CI](https://github.com/kartiksayani/ariadne/actions/runs/37241062792) inherited activation-test race; await composed83 repair |
| [88](https://github.com/kartiksayani/ariadne/pull/88) | `48960cb` /86 | Clear5408612150; [failed CI](https://github.com/kartiksayani/ariadne/actions/runs/37241260290) 14 recovery fake-transport tests; fix composed into83 |
| [90](https://github.com/kartiksayani/ariadne/pull/90) | `9628e68` / main | Control socket-write fix; clear5408675830; [new CI running](https://github.com/kartiksayani/ariadne/actions/runs/37242652964) |
| [91](https://github.com/kartiksayani/ariadne/pull/91) | Remote `7ad7a23`, local `34bc65f` /88 | Local targeted review clear: unclipped native row growth and full2k/5k corpus. [Old CI failed](https://github.com/kartiksayani/ariadne/actions/runs/37241410266) inherited lease reacquisition; publish with parent repair |
| [92](https://github.com/kartiksayani/ariadne/pull/92) | Remote `b81bdee`, local `f694e56` /88 | Both installer findings locally cleared; independent31 tests/97% coverage. [CI](https://github.com/kartiksayani/ariadne/actions/runs/37241451121); publish fix with parent repair |

| Owner | Worktree / branch | Local work and ownership |
| --- | --- | --- |
| Maintainer | `.worktrees/resume-integration` / `maintenance/resume-integration` |83 repairs composed; publishing current docs. Root tasks.json/roadmap overlays intentional; owns shared contracts/manifests/catalogue |
| `prove_three_binding_fifo` | `.worktrees/native-history-acceptance` / `task/native-history-acceptance` | P4.5 App/tree highlights + real five-round/two-fork/paging/history native helper; local91 repair integrated. Owns provider/native-smoke/post-CLI fixture callsites |
| `guarded_history_actions` | `.worktrees/guarded-history-actions` / `task/guarded-history-actions` | Product checkpoint `fc978df` unpushed; Core23/UI35 pass. Temporary App ownership handed over by primary; guarded native helper uses paused discovery target and unchanged demo source |
| `review_runtime_race_repairs` | Separate review worktrees |83 control/activation, lease final-drop and recovery fixture delta; exclusive `owner-answer-ui/target` cache |
| `personal_package_install` | `.worktrees/personal-package-install` / `task/personal-package-install` | Clean `f694e56`, held only for parent update; targeted reviewer ready for final published-head review |

Root integrated control9986701, activationa5ff0d9, recovery fixtured176ddc and
leasecb74cf8. Lease author proved inherited-fd failure with zero parent Arcs on
macOS; acquiring-PID guarded final unlock fixes instance and binding leases.
Native composition assertion remains strict; its exact CI interleaving is inferred.
ADR0064 records the decision. Other warm caches: primary native-provider-activation,
guarded binding-connect-relay; domain-transitions idle. Always set explicit
CARGO_TARGET_DIR; no cold native builds.

**Next three steps**

1. Publish composed83 repairs, independently clear its exact head, propagate once
   through86→88→91 and sibling92, then publish held fixes with targeted review.
   GitHub stack87 is83→86→88→91. No global stack sync/rebase over active edits.
2. Finish history and guarded actions vertically while CI runs. Guarded Continue
   moves stale-preview rejection under target receipt replay; ADR0065 reserved.
   Native pin/ref/scroll proof joins component hover tests: pinned driver emits
   mousemove without hover transitions, so do not claim native hover automation.
3. Audit83 actual coverage/native/release artifacts before squash merge. Close
   P2.4/P3.1/P3.2 only with required proof and merges, then dependent acceptance.
   Preserve root overlays; purple+A means coding, amber means partial, not CI waiting.

Live/billable hosts, M7 and real owner installation/configuration need approval;
temporary-home fixtures are authorized. Packaged permissions/cold-click manual
proof remains. Heavy native/browser/package checks stay in CI. No warm native
cache existed for pre-push timing; no cold build was started. MCP/the review tool disabled
by owner waiver, no org approval claimed. Historical .delivery remains evidence.
