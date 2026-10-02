# Personal release scope — revision 4

The owner’s latest choices govern the first version. This page supersedes earlier
blanket requirements for exhaustive hardening. The application is for one person
on their Mac first; possible distribution comes later. Keep functionality, clear
code organization and an easy path to adding agents.

## Accepted choices

| Area | First version | Later, when needed |
|---|---|---|
| Code organization | Keep the separate Rust crates, shared core and thin entry points in ARCHITECTURE | Split or combine only for a demonstrated development need |
| Agent extensibility | Provider-neutral adapter interface, common DTOs and in-process fake adapter tests; Claude and Codex implement it | Public executable plugin registration/install/negotiation and third-party adapter proof |
| Installation | Simple local app/CLI/MCP install, explicit host setup, preserve unrelated settings and all session data | Transactional installer journals, version switching, automatic rollback |
| Discovery/liveness | Implement known-provider discovery and activity/freshness evidence; manual connection remains available | Discuss pruning only if implementation proves too complex; do not silently drop it |
| Graph | Deterministic SVG with viewport culling and selection/zoom correctness from the start | Additional optimization only after measurement |
| Reliability | Correct binding, FIFO/result join, operation deduplication, file locking and atomic saves, ordinary quit/reopen and connection-loss handling | Corruption repair, disk-exhaustion recovery, machine/power-crash recovery, lost-data recovery, capacity reservations and exhaustive fault injection |
| Testing | Every commit: all maintained code linted, functional and end-to-end checks, at least 80% overall application line coverage | Broad OS/architecture matrices, exotic failure scenarios and exhaustive native automation |

## What the smaller scope does not remove

Both existing-session integrations, full item conversations and rounds, explicit
agent-authored replies/statuses/topics/children, multiple sessions, the supplied
screens, optimized graph, normal native behavior and per-binding FIFO remain.
No host transcript scraping or automatic resend after an uncertain delivery.
The adapter interface must not leak Claude/Codex types into storage or the UI.
Adding a provider later should require an adapter implementation and wiring,
not a rewrite of domain state or the tree. The first version need not load
arbitrary executable adapters at runtime.

## Ordinary failures versus deferred recovery

Handle empty/invalid input, stale item edits, repeated submissions, disconnected
agents, missing structured results, unavailable project paths and normal app
quit/reopen. If a save fails, return an error and retain the draft; never report
success before data is saved. Invalid data must not be overwritten. These basic
behaviors do not require building repair wizards, reserved-byte accounting,
power-loss simulation or a transactional multi-file recovery framework.

Keep schema_version. Implement migrations when a real shipped schema changes,
not a generic migration framework before the first release. Keep unknown future
schemas read-only with a clear error. A simple previous snapshot backup is fine;
automated recovery from it is not a first-release requirement.

## Quality and Git

Publishing the curated repository to GitHub is authorized. Preserve existing
history and the archived planning/POC reference; keep current implementation
requirements on main.
[Development checks](DEVELOPMENT_CHECKS.md) defines the commit hook, exact coverage
meaning and end-to-end requirements. 80% is a minimum, not a reason to omit an
important workflow test. “100% linting” means all maintained code is checked and
there are no lint errors/warnings; it does not mean 100% test coverage.

Planning/prototype validation cannot count as application coverage. No product
source exists yet. Scaffolding must activate the application gates before its
first application commit; missing reports or missing test commands fail the gate.
The current planning check does not claim the future app has passed tests.

## Scope discipline

Implement the selected mechanisms. Do not add cloud services, multi-user or scale
infrastructure. Do not remove product features under the label of simplification.
If a chosen feature becomes disproportionately complex, explain the concrete
tradeoff to the owner before pruning it. The detailed future plugin design may
remain as reference without becoming a release blocker.
