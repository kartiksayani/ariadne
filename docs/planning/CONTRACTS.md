# Contract index

Revision3 uses a single schema source: [Domain and storage](low-level/DOMAIN_AND_STORAGE.md).
Request fields, concrete examples and errors: [API and MCP](low-level/API_AND_MCP.md).
Transport/state transitions: [Processes](low-level/PROCESS_AND_PROTOCOLS.md) and
[Queues](low-level/QUEUES_AND_RECOVERY.md). This index intentionally contains no
second copy of entity tables that could drift.

## Stable invariants

Project → sessions → topics → parent/child items. Items have complete append-only
owner/agent messages and explicit rounds with child-fork references. Session files
also contain bindings, inputs, attempts, structured results and operation receipts.
Provider identity is an arbitrary adapter ID; no `claude|codex` enum in core.

Input persistence is atomic with owner-message persistence. Agent `apply` atomically
commits explicit replies and tree changes. Its optional input result joins with
host completion to resolve an input. Domain writes can succeed while desktop is
closed; new delivery requires the desktop supervisor. CLI/MCP/Tauri all share
core validation and atomic-store transactions.

Contract schemas and golden examples are generated/verified in the first build
milestones. Raw JSON files are not an agent authoring interface. Unsupported
versions, invalid references or ambiguous bindings fail with actionable errors.
