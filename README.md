# Ariadne

A local macOS companion for coding conversations: see what was decided, what
needs your answer, and where each question came from.

**Status:** the production app has not been built. Product, architecture, designs
and implementation contracts provide the baseline for implementation; decisions
and contract gaps discovered while building go through reviewed architecture
decision records (ADRs). Existing-session transport was proven for Claude Code
and Codex; production domain integration remains to be implemented.

## Start here

- [Harness overview](docs/delivery/HARNESS_OVERVIEW.md) — how the maintainer,
  implementers, reviewers and checks work together, and what the files are for.
- [Implementation Gantt](docs/planning/roadmap.html) and
  [dependency graph](docs/planning/roadmap.html) — switch views in the same chart
  to explore build order, task ownership and estimates.
- [Interactive communication simulation](docs/planning/communication-explorer.html)
  — step through agent messages, queues, replies and failure scenarios.

The diagrams are standalone HTML files. GitHub displays their source; open them
from a local checkout or download them and open them in a browser to interact.
They explain the plan and architecture; they are not a live app or agent connection.

Start with the [build handoff](docs/planning/BUILD_HANDOFF.md),
[personal release scope](docs/planning/PERSONAL_RELEASE.md) and
[roadmap](docs/planning/ROADMAP.md). The [planning index](docs/planning/README.md)
links the full specification and all 30 design frames.
Every application commit must pass the [development checks](docs/planning/DEVELOPMENT_CHECKS.md).

For autonomous implementation, start an Astra High session with
[ORCHESTRATOR.md](ORCHESTRATOR.md). The [delivery helper guide](docs/delivery/README.md)
includes the startup prompt and commands; all subagents use Sol 6.1 High.

Source inputs: [build prompt](BUILD_PROMPT.md), [design brief](DESIGN_PROMPT.md),
[UI mockups](<designs/Ariadne UI mockups.zip>). The current personal release scope
supersedes older exhaustive requirements in those inputs.

Historical planning, research and POCs are preserved in the
[immutable archive](https://github.com/kartiksayani/ariadne/tree/a5e306f)
and `reference/planning-and-pocs`. Build/install commands will be documented
when the application exists.
