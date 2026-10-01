# Ariadne

A local macOS companion for long conversations with Claude Code and Codex: see what was decided, what needs your answer, and where each question came from.

Claude Code is the primary integration. Ariadne will [manage official agent CLI sessions](docs/planning/AGENT_RUNTIME.md), use MCP for structured tree updates, and deliver answers without an extra terminal message. Codex will support the same workflow through app-server.

**Current state: planning complete; app and CLI implementation has not started.**

Start with the [planning package](docs/planning/README.md), then follow the [implementation roadmap](docs/planning/ROADMAP.md). Significant choices and their reasons are recorded in [DECISIONS.md](DECISIONS.md).

Source inputs: [build prompt](BUILD_PROMPT.md), [design brief](DESIGN_PROMPT.md), and [UI mockups](<designs/Ariadne UI mockups.zip>).

The plan covers the full required release: shared JSON storage, Rust CLI, Tauri/React app, both agent integrations, native macOS features, reversible setup, demo, installation and verification. Build/install commands will be added when they work.
