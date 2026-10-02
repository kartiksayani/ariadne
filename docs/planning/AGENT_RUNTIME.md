# Agent runtime overview

The release connects to existing terminal conversations. See the authoritative
[process/protocol contract](low-level/PROCESS_AND_PROTOCOLS.md),
[queue/recovery contract](low-level/QUEUES_AND_RECOVERY.md) and
[setup flow](low-level/SETUP_AND_DELIVERY.md).

| Responsibility | Claude Code | Codex |
|---|---|---|
| Known live baseline | 2.1.287 | 0.160.0 |
| Sender | Installed Mod pulls an eligible input through bridge CLI, then $.prompt.submit | Desktop adapter calls codex queue against existing daemon/thread |
| Lifecycle | Mod main-turn hooks with explicit marker/turn matching | WebSocket-over-Unix read-only full turn history |
| Results | Explicit Ariadne CLI/MCP apply/reply/input_result | Same domain tools |
| Host ownership | User terminal owns process, auth and tool approvals | User terminal/daemon owns thread, auth and tool approvals |
| App-off behavior | No new claim; current turn may report and write results through CLI | No new sends; current host turn may continue, reconcile history on reopen |

Multiple bindings in one project are supported through separate Ariadne sessions.
A lease is per binding, never an exclusive project execution lock. Quit/Disconnect
stop Ariadne scheduling and observation; they do not stop external agent work.

Basic live transport evidence: [Claude](../../poc/claude-mods/RESULTS.md),
[Codex](../../poc/codex-queue/RESULTS.md). Structured result integration, durable
production store and recovery remain build acceptance gates. Earlier managed
stream-json evidence is historical and is not a substitute for existing-session
acceptance. Managed launching is outside release1.
