# Ariadne

A local macOS companion for coding conversations: see what was decided, what
needs your answer, and where each question came from.

**Status:** product, architecture, designs and implementation contracts are ready;
the production app has not been built. Existing-session transport was proven for
Claude Code and Codex. Agents publish full item replies and tree changes through
explicit CLI/MCP operations; the bridge handles delivery and lifecycle.

Start with the [build handoff](docs/planning/BUILD_HANDOFF.md),
[personal release scope](docs/planning/PERSONAL_RELEASE.md) and
[roadmap](docs/planning/ROADMAP.md). The [planning index](docs/planning/README.md)
links the full specification and all 30 design frames. Explore the
[interactive communication model](docs/planning/communication-explorer.html).
Every application commit must pass the [development checks](docs/planning/DEVELOPMENT_CHECKS.md).

Source inputs: [build prompt](BUILD_PROMPT.md), [design brief](DESIGN_PROMPT.md),
[UI mockups](<designs/Ariadne UI mockups.zip>). The current personal release scope
supersedes older exhaustive requirements in those inputs.

Historical planning, research and POCs are preserved in the
[immutable archive](https://github.com/kartiksayani/ariadne/tree/a5e306f)
and `reference/planning-and-pocs`. Build/install commands will be documented
when the application exists.
