# Ariadne planning package

**Status: low-level design specified; implementation and live compatibility proofs pending.** Prepared 1 October 2026 and expanded 2 October after the owner identified insufficient integration detail. Evidence now includes local generated Codex schemas and Claude's published message types, without live inference.

Ariadne will be a local macOS app plus a Rust CLI that turns agent conversations into a navigable tree of decisions, questions, findings and tasks. **Claude Code is primary; Codex also supports the complete workflow.** Answering in the global waiting queue must deliver the answer to an available agent without another terminal message.

**Read [Low-level design](LOW_LEVEL_DESIGN.md) first.** Its seven specifications define process/wire contracts, storage/transactions, FIFO inputs, permissions/recovery, APIs/MCP, frontend/native behavior and installation. [Managed agent sessions](AGENT_RUNTIME.md) remains the architecture overview. Each owner submission gets one ordered turn; MCP records structured tree changes through the same Rust core used directly by the UI.

## Read in this order

| Document | What it settles |
| --- | --- |
| [Low-level design](LOW_LEVEL_DESIGN.md) | Implementation choices, ownership map and seven detailed contracts |
| [Product](PRODUCT.md) | Release scope, user journeys, states, keyboard behavior, quality targets |
| [Design translation](DESIGN.md) | Actual dimensions/tokens, reference screenshots, component mapping, explicit mockup deviations |
| [Architecture](ARCHITECTURE.md) | Modules, storage, concurrency, discovery, live updates, native features, local security |
| [Agent runtime](AGENT_RUNTIME.md) | Claude-first process control, Codex adapter, MCP boundary, permissions, delivery, auth and recovery |
| [Contracts](CONTRACTS.md) | Schema, CLI, state transitions, routing, answer delivery and acknowledgment |
| [Integrations](INTEGRATIONS.md) | Shared rules, both hosts, reversible setup/uninstall, build/install |
| [Roadmap](ROADMAP.md) | Ordered tasks, dependencies, milestone gates, tests and requirement traceability |
| [Decisions](../../DECISIONS.md) | Chosen approach and reasons, plus bounded platform investigations |
| [Research](RESEARCH.md) | Dated upstream facts, direct official sources and untested assumptions |

## Recommended implementation order

Prove Claude/Codex and macOS platform edges → durable store/outbox → CLI/MCP/demo → managed Claude answer loop → full UI → graph → native integration → Codex parity and setup → install/release verification. An ordinary implementation session can follow the milestones sequentially.

The first usable internal build is **M3**, where a real managed Claude conversation updates the tree and receives an app answer without another terminal message. The full requested release is **M8**, after both agents, native behavior, visual fidelity, repeatability and installation pass.

## Planning evidence and limits

- Reviewed the original ZIP and inspected representative dark tree/detail and light graph/detail screens. Screenshots here are **mockup references**, not an implemented app.
- Verified official documentation for Tauri/macOS and host integrations; observed Claude Code `2.1.287` and Codex `0.159.3` locally through version/help commands. No model sessions were launched. Platform capabilities still require M0 executable proofs.
- Each major flow now has an owner, API contract, persistence/ordering rule, recovery policy and a named test in the [verification ledger](low-level/VERIFICATION.md). Live provider/native proof results remain explicitly pending.
- Organization security guidance was not checked, as explicitly authorized by the owner. No the review tool/MCP connector was used.
- No app scaffold, dependencies, agent settings, installed application, or external publication was created during this planning session.

Start implementation with **P0.1 in [ROADMAP](ROADMAP.md)**. Preserve the prompts and original design archive as source inputs.
