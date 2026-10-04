# Ariadne handoff

Checked 2026-10-04 23:49 UTC. Verify GitHub before acting. Continue autonomously;
Sol 6.1 High delegates only. Ten delegate slots are supported. Reviewed-parent
stacks are authorized. Publishing this checkpoint with the composed app repairs; check the current
GitHub head and checks rather than treating this snapshot as live status.

**Main:** `20eb77d715c0aa58664dddea0232465598cf8cb1` (PR85);
[postmerge CI pending](https://github.com/kartiksayani/ariadne/actions/runs/37244941515).
PR85 merged after exact-head independent review and coverage/native/release audit.
PRs80–82 and84 also merged. Preserve intentional root tasks.json/roadmap overlays.

| PR | Head / base | Review and CI |
| --- | --- | --- |
| [83](https://github.com/kartiksayani/ariadne/pull/83) | Local `2d57711` plus checkpoint / main | Publishing repairs; independent delta review underway; [old CI failed](https://github.com/kartiksayani/ariadne/actions/runs/37243524591) |
| [85](https://github.com/kartiksayani/ariadne/pull/85) | Merged as20eb77d | Clear5408629599; [CI green](https://github.com/kartiksayani/ariadne/actions/runs/37241561932), artifacts audited |
| [86](https://github.com/kartiksayani/ariadne/pull/86) | `b8b1bb3` /83 | Clear5408722087; [CI running](https://github.com/kartiksayani/ariadne/actions/runs/37243590020) |
| [88](https://github.com/kartiksayani/ariadne/pull/88) | `59eac83` /86 | Clear5408722152; [CI running](https://github.com/kartiksayani/ariadne/actions/runs/37243661426) |
| [90](https://github.com/kartiksayani/ariadne/pull/90) | `9628e68` / main | Clear5408675830; [CI failed](https://github.com/kartiksayani/ariadne/actions/runs/37242652964), wake-test diagnosis assigned |
| [91](https://github.com/kartiksayani/ariadne/pull/91) | `37b650a` /88 | Clear5408725188; [CI failed](https://github.com/kartiksayani/ariadne/actions/runs/37243736889) |
| [92](https://github.com/kartiksayani/ariadne/pull/92) | `1572661` /88 | Clear5408725538; [CI running](https://github.com/kartiksayani/ariadne/actions/runs/37243771774) |
| [93](https://github.com/kartiksayani/ariadne/pull/93) | `281baf4` /88 | Clear5408797489; retained-blocker fix verified; CI pending |
| [94](https://github.com/kartiksayani/ariadne/pull/94) | `cfaeb59` /91 | Clear5408753598; CI pending |
| [95](https://github.com/kartiksayani/ariadne/pull/95) | `e40f4fb` /91 | Clear5408787995; [CI pending](https://github.com/kartiksayani/ariadne/actions/runs/37244480495) |

GitHub stack87 is83 →86 →88 →91 →94. Atomic squash only a qualified prefix.
Prioritize this critical stack over an unrelated main update that restarts its
checks; independent siblings stay independent. Every merged state must satisfy
current-base validation. No new full task closure is claimed.

| Responsibility | Worktree / branch | Local state |
| --- | --- | --- |
| Maintainer | .worktrees/resume-integration / maintenance/resume-integration | Publishing source2d57711 plus workflow/checkpoint; shared contracts/catalogue |
| prove_three_binding_fifo | .worktrees/packaged-route-acceptance / task/packaged-route-acceptance | P6.1 cold launch, second-instance route and path spaces using real packaged release/CLI; no OS driver |
| guarded_history_actions | .worktrees/guarded-history-actions / task/guarded-history-actions |93 fix published/clean; review-local errors preserve controller pending identity |
| native_graph_acceptance | .worktrees/native-graph-acceptance / task/native-graph-acceptance |95 published/clean and source-cleared |
| repair_runtime_ci_races | .worktrees/runtime-wake-reuse / fix/runtime-wake-reuse |5bbd5ac committed/clean, cherry-picked into83 as2d57711; no other unpushed work |
| review_guarded_actions | Separate review context |93 targeted review clear5408797489; prior thread resolved |
| audit_claude85_green | Separate review context;85 evidence in /tmp/ariadne-pr85-ci37241561932-audit.XEXXMN |83 integration, coverage, wake and CI-setup delta review; exclusive owner-answer-ui/target |
| review_native_history | Separate review context |94 cleared;90 first-failure source diagnosis complete |
| review_personal_package92 | Separate review context |92 and95 source-cleared |

85 audit: 21,090/23,466 =89.87% weighted coverage, all176 required sources;
exact head/tree with no tracked changes, native PID54199/nonce/receipt/clean exit,
packaged PID64494 no test service/writes and clean exit. Native evidence is the
scaffold journey; actual Claude behavior is proved by its real Core/installed tests.

83 contains control-write, activation-fixture, recovery-transport and physical
lease repairs, propagated through descendants. Final lease drop unlocks only in
its acquiring process (ADR0064); exact old CI interleaving remains inferred.
90 has the control repair but not83 lease repair. Its new first failure is the
unchanged Claude wake/heartbeat counter107 versus106 at activation.rs402. Source
trace was proved deterministically: clearing evidence during helper inspection
stopped the worker.5bbd5ac now yields Unknown without losing the worker; preserves
actual identity/resource errors. Six activation and21 conformance tests passed.
83 also relocated two byte-identical test files under tests/ and excluded only
the declaration-only tray/mod.rs from source inventory. Original80% floor stays.

**Next three steps**

1. Finish83 independent review, push its composed repairs once, then propagate
   through the reviewed stack and siblings. Integrate90 with main and shared fixes.
   Continue isolated P6.1 product acceptance while CI runs.
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
approval; temporary private-home fixtures are authorized. MCP/the review tool disabled by
owner waiver; no organization security approval claimed.

Bounded CI setup repair: run37238789118 lost10m22s to a partial Rust install;
run37243736889 failed on conflicting cargo-clippy after8.1m of reference captures.
No earlier Rust invocation or cache restore was found; runner cause remains
unproven. A fresh mktemp RUSTUP_HOME isolates inherited state, and setup now runs
before captures to avoid wasting those8m on setup failure. Existing gates remain.
