# Ariadne handoff

Updated 2026-10-04, 21:41 UTC. Owner requests autonomous delivery; delegates use
only Sol 6.1 High. Ten subagent slots are available; four concurrent agents were
verified. Current focus is two product workers, not filling every slot.

**Main:** `b41829c931bb4949782665b1eaaf892f4a7ff98d`; CI green. PRs 80–82 merged.

| Open PR | Head / base | CI and review |
| --- | --- | --- |
| [83](https://github.com/kartiksayani/ariadne/pull/83) | `447fc43` / `b41829c` | [CI running](https://github.com/kartiksayani/ariadne/actions/runs/37234889765); [independent delta clear](https://github.com/kartiksayani/ariadne/pull/83#pullrequestreview-5408224020); desktop-only regression moved out of CLI-included preferences; 23 CLI tests independently pass |
| [84, draft](https://github.com/kartiksayani/ariadne/pull/84) | `3f0d813` / `b41829c` | [CI green](https://github.com/kartiksayani/ariadne/actions/runs/37233989440); [independent delta clear](https://github.com/kartiksayani/ariadne/pull/84#pullrequestreview-5408186250); independently repeated 23 tests and Clippy; held behind83, then update against actual main and revalidate |

| Owner | Worktree / branch | Current work |
| --- | --- | --- |
| Maintainer | `.worktrees/resume-integration` / `maintenance/resume-integration` | Local `6fbbe2d` replaces a helper in an excluded DTO with the existing standard predicate; 36 focused tests and generated contracts pass. One unpushed commit awaits current CI evidence to batch any further fixes |
| `prove_three_binding_fifo` | `.worktrees/three-binding-fifo` / `task/three-binding-fifo` | FIFO and real supervisor stop/restart proof pushed; no unpushed commits; awaiting83, then continues P3.2 → P4.1 → P4.4 |
| Maintainer | `.worktrees/delivery-focus` / `maintenance/delivery-focus` | ADR0060, ORCHESTRATOR rules and this handoff; published checkpoint queued for84, no separate process PR |
| `claude_installed_join` | `.worktrees/claude-installed-join` / `task/claude-installed-join` | Implementing actual installed Mod/CLI/Core join; root contract `7c86b86` is one unpushed documentation commit. Existing merged implementation prerequisites permit this work while83 validates |

Primary worker owns `crates/ariadne-runtime/tests/supervisor_native_fifo.rs` and
exclusively uses `.worktrees/native-provider-activation/target` for focused checks.
Second worker owns P3.3 Claude adapter capability condition and consuming fixtures,
with exclusive `.worktrees/binding-connect-relay/target` cache. No other module is
staffed. `audit_pr83_evidence` checks CI artifacts; `review_pr83_fix_delta` cleared
the local repair with 36 independent tests, awaiting pushed-head verification.
Shared native files, manifests, Tauri configuration and
generator registration remain with the maintainer until explicitly reassigned.

**Next three steps**

1. Finish83's current evidence audit, publish the bounded coverage repair with any
   other actual failures, then exact-head delta review and full CI. Squash merge
   and check main. Close only P2.4 and P3.1 with actual evidence.
2. Finish P3.2 real Core/Store stop/restart proof in84; integrate actual83 main.
   P3.2 acceptance audit confirms no remaining behavior gap after83/84 merge.
   Then keep this worker on P4.1 native five-input/relaunch and P4.4 tree acceptance;
   continue the independent Claude join stream. Full P3.3 acceptance still waits83.
3. Replace this handoff and update catalogue at checkpoints. Root `tasks.json` and
   `roadmap.html` overlays are intentional: only P3.3 is currently active;
   18 amber tasks are partial. Preserve cleared flags when main advances; PR83's
   seven older active flags are stale. Set flags when implementation resumes.

Missing proof includes discovery's UI consumer, five-input native relaunch, native
tree performance, packaged permission/cold-click checks and live M7. Live/billable
hosts and owner configuration remain approval-gated. Heavy native, packaging and
browser checks stay in CI. No warm native cache was found for pre-push timing;
no cold build was started. MCP/the review tool remain disabled under the owner's waiver.
Historical `.delivery/` records are evidence only; this is the sole current handoff.
Recheck GitHub on every resumption.
