# Ariadne

A local macOS companion for coding conversations: see what was decided, what
needs your answer, and where each question came from.

**Current state:** architecture, design-grounded LLD and implementation roadmap;
production app not yet built. Existing-session communication passed live POCs
for both Claude Code and Codex.

Start with the [build handoff](docs/planning/BUILD_HANDOFF.md),
[architecture](docs/planning/ARCHITECTURE.md), and
[interactive explorer](docs/planning/communication-explorer.html).
The [planning index](docs/planning/README.md) links the complete specification,
all30 design frames, implementation gates and proof limits.

Source inputs: [build prompt](BUILD_PROMPT.md), [design brief](DESIGN_PROMPT.md),
[UI mockups](<designs/Ariadne UI mockups.zip>). Original inputs are preserved.

Claude Code is primary; Codex and future compatible CLI adapters use the same
core. Agents publish full item replies and tree decisions through CLI/MCP;
bridges deliver owner messages to existing conversations and track lifecycle.
Build/install commands will be exposed when the implementation exists.
