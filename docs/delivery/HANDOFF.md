# Ariadne handoff

Updated 2026-10-04, 21:15 UTC. Owner requests autonomous delivery; delegates use
only Sol 6.1 High. Ten subagent slots are available; four concurrent agents were
verified. Current focus is two product workers, not filling every slot.

**Main:** `b41829c931bb4949782665b1eaaf892f4a7ff98d`; CI green. PRs 80–82 merged.

| Open PR | Head / base | CI and review |
| --- | --- | --- |
| [83](https://github.com/kartiksayani/ariadne/pull/83) | `447fc43` / `b41829c` | [CI running](https://github.com/kartiksayani/ariadne/actions/runs/37234889765); [independent delta clear](https://github.com/kartiksayani/ariadne/pull/83#pullrequestreview-5408224020); desktop-only regression moved out of CLI-included preferences; 23 CLI tests independently pass |
| [84, draft](https://github.com/kartiksayani/ariadne/pull/84) | `3f0d813` / `b41829c` | [CI green](https://github.com/kartiksayani/ariadne/actions/runs/37233989440); [independent delta clear](https://github.com/kartiksayani/ariadne/pull/84#pullrequestreview-5408186250); independently repeated 23 tests and Clippy; held behind83, then update against actual main and revalidate |

| Owner | Worktree / branch | Current work |
| --- | --- | --- |
| Maintainer | `.worktrees/resume-integration` / `maintenance/resume-integration` | PR83 fully pushed; awaiting CI and evidence audit |
| `prove_three_binding_fifo` | `.worktrees/three-binding-fifo` / `task/three-binding-fifo` | FIFO and real supervisor stop/restart proof pushed; no unpushed commits; awaiting83, then continues P3.2 → P4.1 → P4.4 |
| Maintainer | `.worktrees/delivery-focus` / `maintenance/delivery-focus` | ADR0060, ORCHESTRATOR rules and this handoff; published checkpoint queued for84, no separate process PR |

Primary worker owns `crates/ariadne-runtime/tests/supervisor_native_fifo.rs` and
exclusively uses `.worktrees/native-provider-activation/target` for focused checks.
Second worker will own P3.3 after83. Claude qualification scoping is finished; no
other module is staffed. Shared native files, manifests, Tauri configuration and
generator registration remain with the maintainer until explicitly reassigned.

**Next three steps**

1. Recheck GitHub head/base; finish83 CI and independent evidence audit; squash
   merge and check main. Close only P2.4 and P3.1 with actual evidence.
2. Finish P3.2 real Core/Store stop/restart proof in84; integrate actual83 main.
   Then keep this worker on P4.1 native five-input/relaunch and P4.4 tree acceptance.
   Start the second worker on the Claude join after83.
3. Replace this handoff and update catalogue at checkpoints. Root `tasks.json` and
   `roadmap.html` overlays are intentional: no coding agent is currently active;
   18 amber tasks are partial. Preserve cleared flags when main advances; PR83's
   seven older active flags are stale. Set flags when implementation resumes.

Missing proof includes discovery's UI consumer, five-input native relaunch, native
tree performance, packaged permission/cold-click checks and live M7. Live/billable
hosts and owner configuration remain approval-gated. Heavy native, packaging and
browser checks stay in CI. No warm native cache was found for pre-push timing;
no cold build was started. MCP/the review tool remain disabled under the owner's waiver.
Historical `.delivery/` records are evidence only; this is the sole current handoff.
Recheck GitHub on every resumption.
