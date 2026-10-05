# Ariadne handoff

Checked 2026-10-05 00:12 UTC. Verify GitHub before acting. Continue autonomously;
Sol 6.1 High delegates only. Ten delegate slots are supported. Reviewed-parent
stacks are authorized. Publishing this checkpoint with the one-file workflow-fixture repair; verify
current GitHub heads after the coordinated parent pushes.

**Main:** `20eb77d715c0aa58664dddea0232465598cf8cb1` (PR85);
[postmerge CI pending](https://github.com/kartiksayani/ariadne/actions/runs/37244941515).
PR85 merged after exact-head independent review and coverage/native/release audit.
PRs80–82 and84 also merged. Preserve intentional root tasks.json/roadmap overlays.

| PR | Head / base | Review and CI |
| --- | --- | --- |
| [83](https://github.com/kartiksayani/ariadne/pull/83) | Local `e897c39` plus checkpoint / main | Publishing workflow-fixture repair; [previous CI failed](https://github.com/kartiksayani/ariadne/actions/runs/37245309717) |
| [85](https://github.com/kartiksayani/ariadne/pull/85) | Merged as20eb77d | Clear5408629599; [CI green](https://github.com/kartiksayani/ariadne/actions/runs/37241561932), artifacts audited |
| [86](https://github.com/kartiksayani/ariadne/pull/86) | `568a51e` /83 | Clear5408879961; [CI pending](https://github.com/kartiksayani/ariadne/actions/runs/37245408157) |
| [88](https://github.com/kartiksayani/ariadne/pull/88) | `57ab2e5` /86 | Clear5408880014; [CI pending](https://github.com/kartiksayani/ariadne/actions/runs/37245454134) |
| [90](https://github.com/kartiksayani/ariadne/pull/90) | Local `3d022c4` / main | Publishing same fixture repair; [previous CI failed](https://github.com/kartiksayani/ariadne/actions/runs/37245310924) |
| [91](https://github.com/kartiksayani/ariadne/pull/91) | `7ec65b8` /88 | Clear5408877294; [CI pending](https://github.com/kartiksayani/ariadne/actions/runs/37245484743) |
| [92](https://github.com/kartiksayani/ariadne/pull/92) | `b2306db` /88 | Clear5408882161; [CI pending](https://github.com/kartiksayani/ariadne/actions/runs/37245493115) |
| [93](https://github.com/kartiksayani/ariadne/pull/93) | `a8f5de2` /94 | Combined source clear5408901847; [CI pending](https://github.com/kartiksayani/ariadne/actions/runs/37245921123) |
| [94](https://github.com/kartiksayani/ariadne/pull/94) | `097fdc8` /91 | Clear5408884753; CI pending |
| [95](https://github.com/kartiksayani/ariadne/pull/95) | `a21e6d0` /91 | Clear5408882221; [CI pending](https://github.com/kartiksayani/ariadne/actions/runs/37245534352) |

| [96](https://github.com/kartiksayani/ariadne/pull/96) | `c45feef` /91 | Clear5408892476; [CI pending](https://github.com/kartiksayani/ariadne/actions/runs/37245702501) |

GitHub stack87 is83 →86 →88 →91 →94 →93.92/95/96 remain independent siblings. Atomic squash only a qualified prefix.
Prioritize this critical stack over an unrelated main update that restarts its
checks; independent siblings stay independent. Every merged state must satisfy
current-base validation. No new full task closure is claimed.

| Responsibility | Worktree / branch | Local state |
| --- | --- | --- |
| Maintainer | .worktrees/resume-integration / maintenance/resume-integration | Clean published source401d620; this local checkpoint uncommitted; shared contracts/catalogue |
| prove_three_binding_fifo | .worktrees/packaged-route-acceptance / task/packaged-route-acceptance |96 published/clean; independent24 checks and source review clear; actual packaged CI pending |
| guarded_history_actions | .worktrees/guarded-history-actions / task/guarded-history-actions |93 stacked on94; combined source clear5408901847, reviewer130 UI pass; parent update pending |
| native_graph_acceptance | .worktrees/native-graph-acceptance / task/native-graph-acceptance |95 published/clean and source-cleared |
| repair_runtime_ci_races | .worktrees/runtime-wake-reuse / fix/runtime-wake-reuse |5bbd5ac committed/clean, cherry-picked into83 as2d57711; no other unpushed work |
| review_guarded_actions | Separate review context |93 integration source-clear5408901847 |
| audit_claude85_green | Separate review context;85 evidence in /tmp/ariadne-pr85-ci37241561932-audit.XEXXMN |83/86/88 cleared; CI pacing audit complete, no cache changes |
| review_native_history | Separate review context |90/94 cleared |
| review_personal_package92 | Separate review context |Reviewing91/92/95 parent integration |

85 audit: 21,090/23,466 =89.87% weighted coverage, all176 required sources;
exact head/tree with no tracked changes, native PID54199/nonce/receipt/clean exit,
packaged PID64494 no test service/writes and clean exit. Native evidence is the
scaffold journey; actual Claude behavior is proved by its real Core/installed tests.

83 contains control-write, activation-fixture, recovery-transport and physical
lease repairs, propagated through descendants. Final lease drop unlocks only in
its acquiring process (ADR0064); exact old CI interleaving remains inferred.
90 now also carries the same lease, wake and CI setup fixes, independently
reviewed. Its previous first failure was the
unchanged Claude wake/heartbeat counter107 versus106 at activation.rs402. Source
trace was proved deterministically: clearing evidence during helper inspection
stopped the worker.5bbd5ac now yields Unknown without losing the worker; preserves
actual identity/resource errors. Six activation and21 conformance tests passed.
83 also relocated two byte-identical test files under tests/ and excluded only
the declaration-only tray/mod.rs from source inventory. Original80% floor stays.

**Next three steps**

1. Review/push the workflow-fixture repair on83/90, then propagate once through
   all children including96. All product scopes are independently source-clear.
   Review only the exact shared fix and integration; retain full current-head CI.
2. Audit critical stack coverage/native/release artifacts before squash merge.
   Close P2.4/P3.1 and P3.2 only with required merges/proof, then original dependent
   tasks.85 is now merged; main failure pauses further merges, pending does not.
3. Publish this single handoff with the next substantive checkpoint. Purple+A
   means actual coding; amber includes partial work waiting for review or CI.
   Preserve root overlays, historical evidence and all worktrees.

Use pinned Node22 with NPM_CONFIG_USERCONFIG=/dev/null; old global npm may print
failure but exit0. Explicit warm caches only: primary native-provider-activation,
guarded author binding-connect-relay, guarded reviewer domain-transitions,
83 reviewer owner-answer-ui (all /target). No cold native builds. Heavy native,
browser and package checks stay in CI. Real owner install, paid hosts and M7 need
approval; temporary private-home fixtures are authorized. MCP/Seezo disabled by
owner waiver; no organization security approval claimed.

Bounded CI setup repair: run37238789118 lost10m22s to a partial Rust install;
run37243736889 failed on conflicting cargo-clippy after8.1m of reference captures.
No earlier Rust invocation or cache restore was found; runner cause remains
unproven. A fresh mktemp RUSTUP_HOME isolates inherited state, and setup now runs
before captures to avoid wasting those8m on setup failure. Existing gates remain.

Current CI blocker:83/90 failed test_quality_workflow because the fixture mocked
rustup/cargo but invoked real rustc under the new empty RUSTUP_HOME, and expected
setup after captures. Production setup succeeded. Author cfe2edf changes only that
test file: mock rustc, isolate each RUNNER_TEMP, assert early install/version probes
and failing-install short circuit. All16 workflow cases,19 Python tests and19 Node
process-contract checks pass. Fresh review_workflow_fixture is reviewing the fix.
No production gate or Rust behavior changes; no real toolchain installed locally.
