# Complete communication paths

Revision3. [Open the interactive explorer](communication-explorer.html).
The whole system is specified in [ARCHITECTURE](ARCHITECTURE.md); exact interfaces
are in [LOW_LEVEL_DESIGN](LOW_LEVEL_DESIGN.md). Diagrams describe the planned
product; linked POCs demonstrate the underlying existing-session transports.

```mermaid
sequenceDiagram
  actor Owner
  participant UI as Ariadne UI
  participant Core as Core + session JSON
  participant Adapter as Claude Mod / Codex adapter
  participant Host as Existing agent session
  participant Tools as Ariadne CLI / MCP
  Owner->>Host: Review this PR
  Host->>Tools: apply topic + seven findings
  Tools->>Core: Validate binding / revisions; atomic commit
  Core-->>UI: Revision hint; refresh tree
  Owner->>UI: Five messages against items
  UI->>Core: Save each full message + queued input
  loop One input at a time
    Adapter->>Core: Claim smallest eligible sequence
    Core-->>Adapter: Persisted attempt + exact target context
    Adapter->>Host: prompt.submit or codex queue
    Host-->>Adapter: Matching turn starts
    Adapter->>Core: Record turn identity
    Host->>Tools: Explicit replies + status / topic / child operations
    Tools->>Core: Commit full messages, rounds and tree changes
    Core-->>UI: Refresh affected item conversations and tree
    Host->>Tools: Commit input_result
    Tools->>Core: Persist result receipt
    Host-->>Adapter: Turn finishes
    Adapter->>Core: Persist lifecycle; join result + success
  end
```

The result and completion may arrive in the opposite order. Core joins persisted
facts and seals once; it never relies on the notification arrival order.

## Routing

Owner input stores its binding, topic, item and message IDs. Delivery adds an
attempt ID/marker; adapter matches that exact original user input to the host
turn. Domain calls include explicit binding/generation/input/attempt plus reply
item refs. Core verifies scope and records full reply body and provenance. Agent
can reply to a related item or create children deliberately. This gives model
choice without letting model prose silently reroute arbitrary sessions.

## Return paths

| Data | Return path | Stored/displayed as |
|---|---|---|
| Item answer, follow-up question, status, children/topics | Domain CLI/MCP → core | Full item conversation and tree |
| Host accepted/started/completed/failed | Adapter → bridge/core | Durable delivery facts |
| Captured terminal summary/progress | Adapter → activity buffer | Bounded diagnostic text, no duplicate item reply |
| Hook/heartbeat/daemon state | Adapter → presence | Freshness/execution indicator, not a tree mutation |

## Claude and Codex

Claude Mod is installed in its process; it polls the desktop through bridge CLI,
calls $.prompt.submit, and reports matching main-turn hooks. Codex is contacted
externally through codex queue and read-only WebSocket history on its existing
daemon. Neither path requires resume or a new conversation. Neither Ariadne nor
its MCP server handles provider credentials or replaces host permissions.

See [Claude proof](https://github.com/kartiksayani/ariadne/blob/a5e306f/poc/claude-mods/RESULTS.md) and
[Codex proof](https://github.com/kartiksayani/ariadne/blob/a5e306f/poc/codex-queue/RESULTS.md). The POCs captured raw final answers
in fixtures to prove transport; production item replies deliberately use domain
tools as requested by the owner. Five-message structured-result acceptance is
specified but has not run against a production implementation.
