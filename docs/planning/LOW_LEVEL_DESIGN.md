# Ariadne low-level design — build contract

**First-release scope:** [Personal release decisions](PERSONAL_RELEASE.md) and
[commit quality checks](DEVELOPMENT_CHECKS.md) govern what ships now. Public
plugin installation and exotic-failure recovery are deferred; organized crates,
discovery/liveness and optimized graphs remain required.

Revision 3 · 2 October 2026. This revision replaces the earlier managed-launch
specifications. Read [BUILD_HANDOFF](BUILD_HANDOFF.md), then the contracts below.
The pinned scaffold and real native smoke are implemented (P0.1/P0.2); domain,
provider integration and personal-release acceptance remain ahead. Proven
transports and pending product tests are distinguished in the
[verification ledger](low-level/VERIFICATION.md).

## Authoritative contracts

| Area | Specification |
|---|---|
| Product behavior and scope | [PRODUCT](PRODUCT.md) |
| Actual designs, differences and every board frame | [DESIGN](DESIGN.md), [DESIGN_TRACEABILITY](DESIGN_TRACEABILITY.md) |
| Components, process ownership and dependency direction | [ARCHITECTURE](ARCHITECTURE.md) |
| Every stored entity, full replies/rounds, atomic writes, capacity, continuation | [DOMAIN_AND_STORAGE](low-level/DOMAIN_AND_STORAGE.md) |
| Concrete CLI/Tauri/MCP calls, operation payloads, result contract and errors | [API_AND_MCP](low-level/API_AND_MCP.md) |
| Queue state machine, result/turn join, crash/retry/quit behavior | [QUEUES_AND_RECOVERY](low-level/QUEUES_AND_RECOVERY.md) |
| Claude Mod, Codex native queue, framing, hooks, app control IPC | [PROCESS_AND_PROTOCOLS](low-level/PROCESS_AND_PROTOCOLS.md) |
| Shared Rust adapter seam; deferred executable extension reference | [AGENT_ADAPTERS](AGENT_ADAPTERS.md) |
| Views, selectors, graph layout, keyboard, native routing | [UI_AND_NATIVE](low-level/UI_AND_NATIVE.md) |
| Bootstrap, trust, simple installation, uninstall and doctor | [SETUP_AND_DELIVERY](low-level/SETUP_AND_DELIVERY.md) |
| Ordered implementation artifacts and evidence gates | [ROADMAP](ROADMAP.md), [VERIFICATION](low-level/VERIFICATION.md) |

Overview pages link to these contracts rather than maintaining alternate schemas.
Historical research and POC reports are evidence, not current behavior contracts.
The original prompts/ZIP remain untouched. No production schema exists yet;
revision3 changes are incorporated into its initial version1, not a migration
from prototype data. Generated models/fixtures must follow the current tables.

## Non-negotiable implementation boundaries

- Existing terminal session, same context. No resume/new-session substitute.
- Claude primary, Codex required, shared Rust adapter seam now; public executable plugins later.
- Domain CLI/MCP owns full item replies and tree mutations. Bridge text is diagnostic.
- One in-flight input per binding; FIFO advances only after domain result + host success.
- No private transcript import, credential copying, host approval takeover or host killing.
- All writers reuse core/store. Immutable messages/round history and operation receipts.
- Multiple same-project sessions are valid; one active binding per Ariadne session.
- Discovery/liveness is included in v1; manual binding remains available and hooks are supplementary.
- Model-generated text is data. Validate IDs, generations, revisions and transitions.

## What the next session must produce first

Preserve the completed Tauri2/React/TypeScript/Rust scaffold, pinned versions and
lockfiles. Resume the declared v1 domain/provider contracts, source assets and
reference component work from current main, assessing preserved drafts within
their original tasks. Implement pure core/store behavior and contract tests
before dependent provider integration. Eligible independent modules may proceed
in parallel with settled contracts and disjoint ownership.
Exact commands and ordering are in BUILD_HANDOFF; there is no unresolved choice
of storage engine, delivery transport, reply path, graph library or UI framework.

Native platform behavior and production domain-tool integration still need
execution tests. A failed compatibility test is a recorded build blocker with
an explicit diagnosis; it is not permission to silently switch architectures.

## Native test implementation

[Native macOS E2E](low-level/NATIVE_E2E.md) pins the embedded driver, test-only
build configuration, actual UI-to-Rust proof, cleanup, and release exclusion checks.
