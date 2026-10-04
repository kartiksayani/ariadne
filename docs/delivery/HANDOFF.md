# Ariadne handoff

Checked 2026-10-04, 22:40 UTC. This is a point-in-time checkpoint; verify current
GitHub heads/checks before acting. Owner requests autonomous delivery; delegates use
only Sol 6.1 High. Ten subagent slots are available; four concurrent agents were
verified. Claude is fixing review feedback; native tree and personal packaging
are coding in disjoint paths. Codex acceptance is published in90 for review/CI.
Reviewed parent code may be stacked
while CI runs. Do not keep implementation idle just because a parent awaits CI.

**Main:** `79c0d86705d688f5504672e4d79d4d76cbd5ec3c`;89 merged after
[green CI](https://github.com/kartiksayani/ariadne/actions/runs/37239394526), independent
review and evidence audit:89.77% coverage, all175 required sources, three FIFO tests,
actual native receipt and clean exit/port. The test stop now parks observation after
prior Core work settles; production uncertainty behavior is unchanged. Check main's
new push CI asynchronously. PRs80–82 and84 were already merged.

| Open PR | Code checkpoint / base | CI and review |
| --- | --- | --- |
| [83](https://github.com/kartiksayani/ariadne/pull/83) | code checkpoint `79bad2f`, incorporating main `79c0d86` | Workflow fix independently clear; current main integration + checkpoint being published. [Live checks](https://github.com/kartiksayani/ariadne/pull/83/checks); native test evidence still required |
| [85, draft](https://github.com/kartiksayani/ariadne/pull/85) | `495f8c6` / `e4d8bdb` | Required pending-scope late-announcement/end race being fixed; [checks](https://github.com/kartiksayani/ariadne/pull/85/checks) |
| [86, draft](https://github.com/kartiksayani/ariadne/pull/86) | `6f6e1fa` / `b1e5cfa` | Five native inputs and genuine quit/relaunch; independent review clear, [CI](https://github.com/kartiksayani/ariadne/actions/runs/37239015770) running |
| [88, draft](https://github.com/kartiksayani/ariadne/pull/88) | `48042dc` / `6f6e1fa` | Discovery UI/native join; independent review clear, [CI](https://github.com/kartiksayani/ariadne/actions/runs/37239323967) running |
| [90, draft](https://github.com/kartiksayani/ariadne/pull/90) | `8963489` / `79c0d86` | Codex real Core/Store/queue uncertainty and no-resend acceptance; independent review and [CI](https://github.com/kartiksayani/ariadne/pull/90/checks) running |

| Owner | Worktree / branch | Current work |
| --- | --- | --- |
| Maintainer | `.worktrees/resume-integration` / `maintenance/resume-integration` | Publishing explicit Rust core components plus this checkpoint; native shutdown-test result still awaits actual CI |
| `prove_three_binding_fifo` | `.worktrees/native-tree-acceptance` / `task/native-tree-acceptance` | P4.4 remaining native tree acceptance atop86;86 and89 fully pushed, their worktrees clean |
| `fix_claude_terminal_scope` | `.worktrees/claude-installed-join` / `task/claude-installed-join` | Root contract7003dda unpushed; author implementing terminal generation fence for actual SDK end. Prior read-only author context released ownership |
| `review_codex_native90` | Separate review worktree |90 fully pushed and author tree clean; no unpushed commits |
| `desktop_discovery_join` | `.worktrees/desktop-discovery-join` / `task/desktop-discovery-join` | Local checked merge b22fbec unpushed; waiting final86 parent with main repair and valid fixture RequestRefs |
| `personal_package_install` | `.worktrees/personal-package-install` / `task/personal-package-install` | P6.4 bounded package ownership/install/uninstall atop88; root resource-export contract amended, implementation underway |

Primary owns new native tree acceptance; shared harness callsites need root assignment.
Independent89 reviewer temporarily owns cache `native-provider-activation/target`.
Claude owns adapter/hooks/CLI joined fixture; cache `binding-connect-relay/target`.
Discovery owns service/navigation, native discovery commands/bridge, core DTO
exports/generator; cache `owner-answer-ui/target`. Its `lib.rs` and native-smoke wiring
is published in88. Codex owns only runtime joined-test/fixture paths and cache
`domain-transitions/target`. Root owns shared manifests/config and all catalogue
state. Claude's real fixture exposed bootstrap status-before-bound-announcement;
root approved announce-after-exact-receipt, pending status with exact retry IDs.

**Next three steps**

1. Incorporate repaired main into open work. Diagnose any83 failure, then audit
   its native/coverage/release proof and merge.
   Close P2.4/P3.1/P3.2 only after their required proof and merges.
2. Keep three product streams moving while independent reviews/CI run. Native
   GitHub stack87 already links83 →86 →88. Delta review fixes; only merge qualified
   stack members. Never run global stack sync/rebase over workers' active edits.
3. Replace this handoff and update local catalogue at checkpoints. Root tasks.json
   and roadmap.html overlays are intentional; purple+A means coding, amber means
   partial. Review/CI waiting is not coding. Preserve overlays when main advances.

Missing proof includes discovery's UI consumer, five-input native relaunch, native
tree performance, packaged permission/cold-click checks and live M7. Live/billable
hosts and owner configuration remain approval-gated. Heavy native, packaging and
browser checks stay in CI. No warm native cache was found for pre-push timing;
no cold build was started. MCP/Seezo remain disabled under the owner's waiver.
Historical `.delivery/` records are evidence only; this is the sole current handoff.
Recheck GitHub on every resumption.

Bounded CI repair: [PR54 run37173179211](https://github.com/kartiksayani/ariadne/actions/runs/37173179211)
lost about9m40s and [PR83 run37238789118](https://github.com/kartiksayani/ariadne/actions/runs/37238789118)
lost about10m22s when rustup installed only the three add-ons, leaving cargo/rustc
absent. The underlying runner cause is unproven. Explicitly request the three
core components and print their versions to avoid another wasted application run;
all existing CI gates remain intact.
