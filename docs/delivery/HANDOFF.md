# Ariadne handoff

Updated 2026-10-04, 20:48 UTC. Owner requests autonomous delivery; delegates use
only Sol 6.1 High. Ten subagent slots are available; four concurrent agents were
verified. Current focus is two product workers, not filling every slot.

**Main:** `b41829c931bb4949782665b1eaaf892f4a7ff98d`; CI green. PRs 80–82 merged.

| Open PR | Head / base | CI and review |
| --- | --- | --- |
| [83](https://github.com/kartiksayani/ariadne/pull/83) | `598034e` / `b41829c` | [CI failed](https://github.com/kartiksayani/ariadne/actions/runs/37232166797); exact cause under diagnosis; [prior delta clear](https://github.com/kartiksayani/ariadne/pull/83#pullrequestreview-5408029979), earlier required thread resolved |
| [84, draft](https://github.com/kartiksayani/ariadne/pull/84) | `be4ac3c` / `b41829c` | CI pending; [independent review clear](https://github.com/kartiksayani/ariadne/pull/84#pullrequestreview-5408134002); independently repeated 22 tests and Clippy; native acceptance awaits83 |

| Owner | Worktree / branch | Current work |
| --- | --- | --- |
| Maintainer | `.worktrees/resume-integration` / `maintenance/resume-integration` | PR83 fully pushed; awaiting CI and evidence audit |
| `resume_pr83_ci_fix` | `.worktrees/pr83-native-ci` / `fix/pr83-native-ci` | Diagnosing latest83 CI failure; no unpushed fix yet |
| `prove_three_binding_fifo` | `.worktrees/three-binding-fifo` / `task/three-binding-fifo` | PR84 fully pushed, no unpushed commits; continues P3.2 → P4.1 → P4.4 after83 |
| Maintainer | `.worktrees/delivery-focus` / `maintenance/delivery-focus` | ADR0060, ORCHESTRATOR rules and this handoff; published checkpoint queued for84, no separate process PR |

Primary worker owns `crates/ariadne-runtime/tests/supervisor_native_fifo.rs` and
exclusively uses `.worktrees/native-provider-activation/target` for focused checks.
Second worker will own P3.3 after83. Claude qualification scoping is finished; no
other module is staffed. Shared native files, manifests, Tauri configuration and
generator registration remain with the maintainer until explicitly reassigned.

**Next three steps**

1. Recheck GitHub head/base; finish83 CI and independent evidence audit; squash
   merge and check main. Close only P2.4 and P3.1 with actual evidence.
2. Continue primary worker through native five-input/relaunch and tree acceptance.
   Keep vertical PR84 on actual main. Start the second worker on the Claude join.
3. Replace this handoff and update catalogue at checkpoints. Root `tasks.json` and
   `roadmap.html` overlays are intentional: P3.2 active, 18 amber partial tasks.
   Preserve them when main advances; amber does not mean complete.

Missing proof includes discovery's UI consumer, five-input native relaunch, native
tree performance, packaged permission/cold-click checks and live M7. Live/billable
hosts and owner configuration remain approval-gated. Heavy native, packaging and
browser checks stay in CI. No warm native cache was found for pre-push timing;
no cold build was started. MCP/the review tool remain disabled under the owner's waiver.
Historical `.delivery/` records are evidence only; this is the sole current handoff.
Recheck GitHub on every resumption.
