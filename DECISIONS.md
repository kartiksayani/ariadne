# Current Ariadne decisions

These decisions describe the first personal release. [PERSONAL_RELEASE](docs/planning/PERSONAL_RELEASE.md)
takes precedence over the older [build prompt](BUILD_PROMPT.md) and exhaustive
requirements. Start implementation with [BUILD_HANDOFF](docs/planning/BUILD_HANDOFF.md);
the [low-level contracts](docs/planning/LOW_LEVEL_DESIGN.md) own detailed behavior.
Production application code has not been built.

| Area | Current decision |
|---|---|
| Product | Local macOS companion for existing coding conversations. Claude Code is primary; Codex is required. Use the supplied screens and complete item history. |
| Transport | Claude Mod `prompt.submit` and Codex native queue CLI with read-only daemon history. Connect the already-running conversation; preserve its context and permissions. |
| Domain ownership | Agents explicitly publish full item replies, statuses, topics, children and input results through shared CLI/MCP commands. Bridge text is bounded diagnostics. |
| Stack | Tauri 2, React/TypeScript and a Rust workspace. Keep separate domain, store, core, protocol, runtime and provider crates with thin app/CLI/MCP entry points. |
| Persistence | One project-local session JSON snapshot, stable locks and atomic saves. Global project/binding indexes are rebuildable; all writers reuse core/store. |
| Routing | Explicit binding, generation and host identity on every domain call and delivery. One active binding per Ariadne session; independent same-project sessions are supported. |
| Queue | One in-flight input per binding, durable FIFO and stable operation receipts. Advance only after a successful matching host turn and committed domain result. Uncertain sends require review before resend. |
| Process ownership | Ariadne owns dispatch, observers, bridge helpers and private local IPC. It never launches, resumes, kills or changes approvals for the external host. Quit stops new dispatch; accepted work and bound domain writes may finish. |
| Item history and status | Preserve complete messages, rounds, answer/question snapshots and forks. Only agent domain operations change item status. Waiting and Sent reflect question episodes and input facts. |
| UI | Tree/detail/waiting/graph/message rail, all-item owner intents, guarded archive/close, native tray/notifications and continuation are required. Continue previews a provenance-linked copy into another bound session. |
| Discovery/liveness | Include known-provider candidates and qualified activity/freshness evidence in v1. Manual connection remains available. PID alone never proves a particular conversation is running. |
| Graph | Deterministic SVG layout with viewport culling and correct full bounds, zoom, focus and selection from v1. |
| Extensibility | Common Rust adapter interface/DTOs and an in-process fake now. Provider types stay outside core/store/UI. Public executable registry/install/negotiation and third-party executable proof are deferred. |
| Reliability | Ordinary validation, repeated operations, concurrent writes, stale edits, connection loss and quit/reopen are required. Generic migration/repair frameworks, power-loss recovery, reserved capacity and exhaustive fault injection are deferred. |
| Setup | Simple local app/CLI/MCP install, explicit host trust/reload steps and safe removal of unchanged Ariadne-owned settings. Preserve project history and unrelated settings. No transactional setup journal or automatic rollback framework. |
| Compatibility | Gate the proven host versions, generate Codex wire DTOs from the exact CLI schema, check CLI/daemon versions and require live compatibility evidence before widening support. |
| Quality | Every application code commit, including scaffold source, passes all maintained-code lint, functional/E2E checks and at least 80% weighted overall application line coverage. Live/billable host acceptance runs at M7. |
| Publication | GitHub publication of the curated repository is authorized. Preserve existing history and the archived planning/POC reference. |

The bounded transport proofs are [Claude Code 2.1.287](https://github.com/kartiksayani/ariadne/blob/a5e306f/poc/claude-mods/RESULTS.md)
and [Codex 0.160.0](https://github.com/kartiksayani/ariadne/blob/a5e306f/poc/codex-queue/RESULTS.md).
They prove ordered delivery and retained existing-session context; they do not
prove the production store, structured result loop, native UI or installation.
Acceptance status belongs in the [verification ledger](docs/planning/low-level/VERIFICATION.md).

The owner explicitly waived Seezo for this work. Organization security guidance
was not fetched or checked; these decisions make no organization-compliance claim.

Earlier decisions, research and prototypes remain available in the
[immutable planning archive](https://github.com/kartiksayani/ariadne/tree/a5e306f)
and the `reference/planning-and-pocs` branch.
