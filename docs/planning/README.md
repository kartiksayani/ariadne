# Ariadne planning package

**Status: planning complete; application implementation has not started.** Prepared 1 October 2026 from the two repository prompts, supplied mockup handoff and source, rendered reference screens, and current official platform documentation.

Ariadne will be a local macOS app plus a Rust CLI that turns agent conversations into a navigable tree of decisions, questions, findings and tasks. A global waiting queue lets the owner answer in the app; Claude Code and Codex pick up those answers on the next owner turn.

## Read in this order

| Document | What it settles |
| --- | --- |
| [Product](PRODUCT.md) | Release scope, user journeys, states, keyboard behavior, quality targets |
| [Design translation](DESIGN.md) | Actual dimensions/tokens, reference screenshots, component mapping, explicit mockup deviations |
| [Architecture](ARCHITECTURE.md) | Modules, storage, concurrency, discovery, live updates, native features, local security |
| [Contracts](CONTRACTS.md) | Schema, CLI, state transitions, routing, answer delivery and acknowledgment |
| [Integrations](INTEGRATIONS.md) | Shared rules, both hosts, reversible setup/uninstall, build/install |
| [Roadmap](ROADMAP.md) | Ordered tasks, dependencies, milestone gates, tests and requirement traceability |
| [Decisions](../../DECISIONS.md) | Chosen approach and reasons, plus bounded platform investigations |
| [Research](RESEARCH.md) | Dated upstream facts, direct official sources and untested assumptions |

## Recommended implementation order

Prove the platform edges → build durable store → CLI/demo → live UI answer loop → full primary UI → graph → native integration → both real agents → install and release verification. The roadmap identifies dependency-safe overlap, but an ordinary implementation session can follow the ordered milestones sequentially.

The first usable internal build is **M3**, where an agent-style CLI write appears in the app and an owner answer returns through the store. The full requested release is **M8**, after both real agent flows, native behavior, visual fidelity, repeatability and installation pass.

## Planning evidence and limits

- Reviewed the original ZIP and inspected representative dark tree/detail and light graph/detail screens. Screenshots here are **mockup references**, not an implemented app.
- Verified official documentation for Tauri/macOS and host integrations; observed local Codex CLI version. Platform capabilities still require M0 executable proofs.
- Decided all product/architecture questions needed to start. Remaining investigations have explicit fallback paths and gates.
- Organization security guidance was not checked, as explicitly authorized by the owner. No the review tool/MCP connector was used.
- No app scaffold, dependencies, agent settings, installed application, or external publication was created during this planning session.

Start implementation with **P0.1 in [ROADMAP](ROADMAP.md)**. Preserve the prompts and original design archive as source inputs.
