# Ariadne build-ready planning package

**First-release scope:** [Personal release decisions](PERSONAL_RELEASE.md) and
[commit quality checks](DEVELOPMENT_CHECKS.md) govern what ships now. Public
plugin installation and exotic-failure recovery are deferred; organized crates,
discovery/liveness and optimized graphs remain required.

Revision3 · 2 October 2026. The original designs and all later owner requirements
are reconciled in the architecture/LLD. Production code is not built. Claude and
Codex existing-session transport POCs passed; remaining tests are implementation
acceptance, not assumed successes.

## Start here

1. [Build handoff](BUILD_HANDOFF.md) — next session's starting point and build order.
2. [Architecture](ARCHITECTURE.md) — modules, processes, storage and ownership.
3. [Interactive architecture](communication-explorer.html) — both agents, domain
   reply path, FIFO, persistence and failure scenarios; simulation, no live agent.
4. [Low-level contracts](LOW_LEVEL_DESIGN.md) — authoritative specifications.
5. [Design traceability](DESIGN_TRACEABILITY.md) — all30 mockup frames, actions,
   state/read models and acceptance checks.
6. [Roadmap](ROADMAP.md) and [Verification](low-level/VERIFICATION.md).

The [gap audit](ARCHITECTURE_AUDIT.md) records what was missing, where each gap was
closed, and which execution gates remain. [Decisions](../../DECISIONS.md) records
current choices and historical revisions separately.

## Core choices

- Existing Claude/Codex conversations; no new/resumed-session substitute.
- Pluggable adapters; Claude Mod and Codex native queue plus read-only history.
- One JSON snapshot per project session, shared Rust core/CLI/MCP/Tauri commands.
- Full explicit item replies/rounds/forks; agent controls statuses and branches.
- Durable FIFO; successful host turn + committed domain result resolves an input.
- Real mockup tree/detail/waiting/graph/rail/owner actions, with explicit deviations.
- Manual connection baseline; optional discovery/hooks/heartbeat/PID evidence.

## Evidence and boundaries

[Claude seven-check proof](../../poc/claude-mods/RESULTS.md),
[Codex eight-check proof](../../poc/codex-queue/RESULTS.md). Both used existing
conversations; production domain tools/store/native app remain to be implemented.
Original ZIP has a [verified member checksum manifest](assets/design-manifest.json).
Provider research files and older smoke reports are historical evidence; use the
LLD for implementation. No external publication or provider permission change
was made. Organization security guidance was not checked under the owner's waiver.
