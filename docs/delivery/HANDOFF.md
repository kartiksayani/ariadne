# Ariadne handoff

Updated 2026-10-04, 21:54 UTC. Owner requests autonomous delivery; delegates use
only Sol 6.1 High. Ten subagent slots are available; four concurrent agents were
verified. Three product workers are active; reviewed parent code may be stacked
while CI runs. Do not keep implementation idle just because a parent awaits CI.

**Main:** `e4d8bdb6ce67b0012301f12cd73cd6b31124d2a5`; [CI running](https://github.com/kartiksayani/ariadne/actions/runs/37237477719).
PR84 merged with independent review, 89.77% coverage and native receipt/cleanup
audit; its squash tree equals the tested head. PRs80–82 were already merged.

| Open PR | Head / base | CI and review |
| --- | --- | --- |
| [83](https://github.com/kartiksayani/ariadne/pull/83) | `447fc43` / `b41829c` | [CI running](https://github.com/kartiksayani/ariadne/actions/runs/37234889765); [independent delta clear](https://github.com/kartiksayani/ariadne/pull/83#pullrequestreview-5408224020); desktop-only regression moved out of CLI-included preferences; 23 CLI tests independently pass |

| Owner | Worktree / branch | Current work |
| --- | --- | --- |
| Maintainer | `.worktrees/resume-integration` / `maintenance/resume-integration` | Local `bd07660`: two unpushed commits, predicate repair `6fbbe2d` plus conflict-free main merge. Repair has 36 independent passing tests and clear review; waiting current CI result to batch further failures |
| `prove_three_binding_fifo` | `.worktrees/native-domain-acceptance` / `task/native-domain-acceptance` | Uncommitted P4.1 five-input and genuine quit/relaunch implementation atop `6fbbe2d`; previous84 worktree preserved |
| Maintainer | `.worktrees/delivery-focus` / `maintenance/delivery-focus` | ADR0060, ORCHESTRATOR rules and this handoff; carry with83's next update, no separate process PR |
| `claude_installed_join` | `.worktrees/claude-installed-join` / `task/claude-installed-join` | Implementing actual installed Mod/CLI/Core join; root contract `7c86b86` is one unpushed documentation commit. Existing merged implementation prerequisites permit this work while83 validates |
| `desktop_discovery_join` | `.worktrees/desktop-discovery-join` / `task/desktop-discovery-join` | Implementing discovery projection/controller/Projects/Connect; root contract `f1941db` is unpushed atop83 local `bd07660` |

Primary owns the five native e2e files and temporarily `lib.rs` for an e2e-only
nonce-checked genuine Quit trigger; cache `native-provider-activation/target`.
Claude owns adapter/hooks/CLI joined fixture; cache `binding-connect-relay/target`.
Discovery owns service/navigation, native discovery commands/bridge, core DTO
exports/generator; cache `owner-answer-ui/target`. It must not edit `lib.rs` until
primary hands it back. Root owns other shared manifests/config and all catalogue
state. Claude's real fixture exposed bootstrap status-before-bound-announcement;
root approved announce-after-exact-receipt, pending status with exact retry IDs.

**Next three steps**

1. Finish83's current evidence audit, publish the bounded coverage repair with any
   other actual failures, then exact-head delta review and full CI. Squash merge
   and check main. Close P2.4/P3.1 and P3.2 with actual evidence:84 already merged
   and acceptance audit found no additional P3.2 behavior gap.
2. Keep all three streams moving, publish coherent checkpoints and review in
   parallel with CI. Link P4.1 above83 using installed `gh stack link` when ready;
   discovery is an independent sibling, not an artificial P4.1 dependency.
3. Replace this handoff and update catalogue at checkpoints. Root `tasks.json` and
   `roadmap.html` overlays are intentional: P3.3/P3.7/P4.1 are currently active;
   18 amber tasks are partial. Preserve cleared flags when main advances; PR83's
   seven older active flags are stale. Set flags when implementation resumes.

Missing proof includes discovery's UI consumer, five-input native relaunch, native
tree performance, packaged permission/cold-click checks and live M7. Live/billable
hosts and owner configuration remain approval-gated. Heavy native, packaging and
browser checks stay in CI. No warm native cache was found for pre-push timing;
no cold build was started. MCP/the review tool remain disabled under the owner's waiver.
Historical `.delivery/` records are evidence only; this is the sole current handoff.
Recheck GitHub on every resumption.
