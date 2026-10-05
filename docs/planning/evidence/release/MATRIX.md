# Release evidence matrix

One row per [VERIFICATION](../../low-level/VERIFICATION.md) acceptance row, V01–V29,
as pruned by [ADR-0069](../../../adr/ADR-0069-release-evidence-is-proportionate.md).
Evidence kinds: `test` (an automated test in this repository), `CI run` (a passing
required CI run on main), `live run` (real Claude Code / Codex session), `manual
check` (short owner checklist). Test paths are listed only where the test file was
opened and its tests cover the row. Everything else says "to confirm".

Release evidence for all `test` rows is one link to a passing required CI run on
main: **pending merge**. Live rows are **pending live run**; the installed host
version is recorded there.

| ID | Meaning | Evidence kind | Evidence link/path | Status |
|---|---|---|---|---|
| V01 | Schema, IDs, transitions and bounded content | test | `crates/ariadne-domain/tests/schema.rs`, `crates/ariadne-domain/tests/transitions.rs` | Test present; CI run pending merge |
| V02 | Concurrent app and CLI/MCP writes | test | `crates/ariadne-store/tests/transactions.rs` (separate-process writers, stale same-item conflict) | Test present; CI run pending merge |
| V03 | Ordinary atomic storage behaviour | test | `crates/ariadne-store/tests/transactions.rs` (unwritable directory returns save error, previous snapshot) | Test present; CI run pending merge |
| V04 | Project registry and binding | test | `crates/ariadne-store/tests/registry.rs`, `crates/ariadne-core/tests/bindings.rs` | Test present; CI run pending merge |
| V05 | Item conversation history | test | to confirm | To confirm |
| V06 | Idempotent domain batch | test | `crates/ariadne-core/tests/apply.rs` | Test present; CI run pending merge |
| V07 | Input result/completion join | test | `crates/ariadne-core/tests/delivery_join.rs` | Test present; CI run pending merge |
| V08 | Five-message FIFO per binding | test, live run | to confirm (test); pending live run | To confirm |
| V09 | Same-project parallel bindings | test, live run | `crates/ariadne-cli/tests/parallel_acceptance.rs` (test); pending live run | Test present; live run pending |
| V10 | Adapter event replay and day-to-day recovery | test | to confirm | To confirm |
| V11 | App lifecycle with external host | test, manual check | to confirm | To confirm |
| V12 | Agent domain choices | test, live run | to confirm (test); pending live run | To confirm |
| V13 | Missing result recovery | test | `crates/ariadne-core/tests/recovery.rs`, `crates/ariadne-core/tests/delivery_join.rs` (missing-result grace and barrier) | Test present; CI run pending merge |
| V14 | CLI/MCP contract and bootstrap | test | `crates/ariadne-cli/tests/agent_cli.rs`, `crates/ariadne-cli/tests/owner_cli.rs` | Test present; CI run pending merge |
| V15 | Full mockup and owner actions | test | to confirm | To confirm (row unchanged by ADR-0069) |
| V16 | Graph and guarded session actions | test | `crates/ariadne-core/tests/history_actions.rs` (archive/close guards, continuation) | Test present; graph/tree selection agreement to confirm |
| V17 | Claude first-party adapter | live run | pending live run | Pending live run |
| V18 | Codex first-party adapter | live run | pending live run | Pending live run |
| V19 | Third executable adapter | none | none | Deferred (outside this personal release) |
| V20 | Known-metadata discovery and liveness | test | to confirm (`crates/ariadne-runtime/tests/discovery.rs` exists; not confirmed against the PID-alone rule) | To confirm |
| V21 | Native macOS app (manual checklist: notification click opens item, tray count matches, second launch routes to running app, quit keeps external sessions; project path with spaces; cold-start notification click) | manual check | pending manual check (checklist) | Pending manual check |
| V22 | Simple setup, install and uninstall | test | `crates/ariadne-cli/tests/setup.rs`, `tests/functional/install/test_install.py` | Test present; CI run pending merge |
| V23 | Offline and release boundary | CI run | to confirm | To confirm |
| V24 | Full release journey | manual check | to confirm | To confirm; after V17/V18 |
| V25 | Waiting episode and counts | test | to confirm | To confirm |
| V26 | Provider compatibility and generated wire DTOs | test | to confirm | To confirm |
| V27 | SVG viewport culling | test | `apps/desktop/tests/ui/graph-culling/index.test.tsx`, `apps/desktop/tests/ui/graph-culling/component.test.tsx` | Test present; CI run pending merge (row unchanged by ADR-0069) |
| V28 | Thin entry points | test | `crates/ariadne-cli/tests/mcp_alias.rs` (alias and CLI share receipts), `crates/ariadne-mcp/tests/native_process.rs` | Test present; install of all entry points covered by V22 |
| V29 | Quality gate | CI run | pending merge | Pending merge: one link to a passing required CI run on main |

Counts: 13 rows with a confirmed test path (V01–V04, V06, V07, V09, V13, V14, V16,
V22, V27, V28), 1 deferred (V19), 15 "to confirm" or pending live/manual evidence.
