# Results and presence — current decisions

This page summarizes, rather than duplicates, the implementation contracts:
[domain result schema](low-level/DOMAIN_AND_STORAGE.md),
[API](low-level/API_AND_MCP.md), [queue join/recovery](low-level/QUEUES_AND_RECOVERY.md),
[hook/presence mechanism](low-level/PROCESS_AND_PROTOCOLS.md).

## Reply and decision path

Agent publishes item replies, statuses, topics and children through explicit
Ariadne CLI/MCP operations. Full reply text is durable and targets one item;
activity summaries do not become replies to every touched item. The bridge sends
owner inputs and records matching host lifecycle; its captured text is diagnostic.
Five submitted messages are saved immediately and delivered separately in order.
Each requires a structured result and a successful host turn before the next.
Missing results pause with an explanation. Recovery never silently replays work.

## Passive session presence

Use installed Claude Mod/hooks to observe session and turn events, with a30s
heartbeat and90s stale threshold as initial configuration. Stop/turn.complete
means a response ended, not that the terminal exited. Missing session.end is
normal after crashes; no assumption of clean closure. Codex uses read-only state
on its existing daemon. PID plus process-start identity is supporting evidence,
not proof of a specific thread running. MCP connection-open is not model liveness.

Keep connection freshness, observed execution state and app Active/Closed session
lifecycle separate. UI displays Running, Connected idle, Last seen or Unknown
based on evidence. No prompts, keystrokes, host start/resume or approvals are used
for liveness. Discovery is optional; manual binding is the required fallback.
