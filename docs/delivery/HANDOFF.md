# Ariadne handoff

Checked 2026-10-04, 22:07 UTC. This is a point-in-time checkpoint; verify current
GitHub heads/checks before acting. Owner requests autonomous delivery; delegates use
only Sol 6.1 High. Ten subagent slots are available; four concurrent agents were
verified. Native acceptance and discovery workers are coding; Claude is in review.
Reviewed parent code may be stacked
while CI runs. Do not keep implementation idle just because a parent awaits CI.

**Main:** `e4d8bdb6ce67b0012301f12cd73cd6b31124d2a5`; [CI running](https://github.com/kartiksayani/ariadne/actions/runs/37237477719).
PR84 merged with independent review, 89.77% coverage and native receipt/cleanup
audit; its squash tree equals the tested head. PRs80–82 were already merged.

| Open PR | Code checkpoint / base | CI and review |
| --- | --- | --- |
| [83](https://github.com/kartiksayani/ariadne/pull/83) | `09c24f2` / `e4d8bdb` | Native test repair being published with this handoff; [live checks](https://github.com/kartiksayani/ariadne/pull/83/checks) and independent delta review required. Prior `447fc43` run hung and was cancelled; it never produced coverage/native/release proof |
| [85, draft](https://github.com/kartiksayani/ariadne/pull/85) | `732f95d` / `e4d8bdb` | [CI running](https://github.com/kartiksayani/ariadne/actions/runs/37238387146); `review_claude_installed85` reviewing actual installed Mod/CLI/Core join and bootstrap ordering fix |

| Owner | Worktree / branch | Current work |
| --- | --- | --- |
| Maintainer | `.worktrees/resume-integration` / `maintenance/resume-integration` | Publishing `09c24f2` plus this checkpoint. Window test first-read barrier and recovery fixture registry path fixed; fifth shutdown-test failure still needs actual CI diagnosis. 21 Core recovery tests pass; no local desktop test claim |
| `prove_three_binding_fifo` | `.worktrees/native-domain-acceptance` / `task/native-domain-acceptance` | Uncommitted P4.1 five-input and genuine quit/relaunch implementation atop `6fbbe2d`; previous84 worktree preserved |
| Maintainer | `.worktrees/delivery-focus` / `maintenance/delivery-focus` | Historical preparation branch preserved; delivery rules/ADR0060/current handoff now carried by83 |
| `claude_installed_join` | `.worktrees/claude-installed-join` / `task/claude-installed-join` | PR85 fully pushed, worktree clean, awaiting independent review/CI; no unpushed commits |
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
2. Keep product streams moving and review in parallel with CI. Link83 → P4.1 →
   discovery using installed `gh stack link` at coherent checkpoints. Discovery
   now uses P4.1's additional scripted candidate/native fixture: primary provides
   fixture support, child adds discovery helper/callsite, each PR self-contained.
3. Replace this handoff and update catalogue at checkpoints. Root `tasks.json` and
   `roadmap.html` overlays are intentional: P3.7/P4.1 are currently coding;
   18 amber tasks are partial. Preserve cleared flags when main advances; PR83's
   seven older active flags are stale. Set flags when implementation resumes.

Missing proof includes discovery's UI consumer, five-input native relaunch, native
tree performance, packaged permission/cold-click checks and live M7. Live/billable
hosts and owner configuration remain approval-gated. Heavy native, packaging and
browser checks stay in CI. No warm native cache was found for pre-push timing;
no cold build was started. MCP/Seezo remain disabled under the owner's waiver.
Historical `.delivery/` records are evidence only; this is the sole current handoff.
Recheck GitHub on every resumption.
