# ADR-0083: Remove is a permanent owner command, backed up first and told to the agent

Status: accepted (2026-10-07).
Supersedes: none
Superseded by: none

## Context

Archive and Close hide work but keep it. The owner needs to get rid of projects,
sessions, topics and items for good, for example test sessions or a wrong topic.
Removed work must not come back through the agent: an agent that keeps working on
a removed item, or mentions it again, undoes the owner's decision. Ariadne state
is cross-referenced (messages, rounds, inputs, answers, continuation copies), so a
plain delete leaves the store invalid. The UI offers a 5-second undo before it
sends the command.

## Decision

- **Four owner commands.** `item_remove` and `topic_remove` use a session route
  and return a saved `removal` session receipt. `session_remove` and
  `project_remove` use `session:null` with explicit IDs and return a new
  `MutationReceipt::Removed {operation_id, scope, project_id, session_ids, backup}`.
  The explicit IDs keep exact retries working after the session file is gone.
- **Scope.** An item takes everything below it. A topic takes its whole
  continuation family: every copy linked through `origin`, in any registered
  project. A session takes only its own file; copies of its topics in other
  sessions are their own topics and stay. A project takes its sessions and its
  store and is unregistered; a new session in that folder registers it again.
- **Hard delete with a consistent remainder.** Core deletes the scope's items,
  topics, rounds, answers, inputs, continuation records and the messages that exist
  only for them, and strips references to them from what remains. Delivery
  receipts for removed inputs are pruned by the store. The candidate is validated
  before commit; a removal that would break history is refused with
  `invalid_transition`.
- **Guards (amended by ADR-0088).** Pending inputs never block removal:
  removal takes them with it and clears the active input and delivery barrier.
  Integrity refusals remain: a stale revision, a remaining item whose
  `replaced_by` points at removed work, a remaining item depending on a removed
  message, capacity limits and partial family removal. Sessions and projects
  also take pending inputs; no preliminary Close or Pause is required.
- **Backup first, path returned.** Each changed session is copied to
  `<store>/backups/pre-remove-<stamp>-<op>-<session>.json` before the write, where
  `<store>` is `<data root>/projects/<project-id>` (ADR-0082). A project is copied
  to `<data root>/backups/pre-remove-<stamp>-<op>/` (`project.json`, the store's
  earlier `backups/`, `sessions/`, `removal.json`), outside the store it deletes.
  Every receipt carries the backup path, and the CLI prints the receipt.
- **Bounded deletion.** Project removal deletes only
  `<data root>/projects/<project-id>` through anchored `openat` handles that never
  follow links. A pending legacy `<root>/.ariadne` store is migrated first, as on
  every project resolve. The owner's folder, its files, parked legacy copies and
  link targets are never touched. A missing project folder does not block removal.
- **The agent is told once.** Item and topic removal queue one input of the new
  kind `removed` on the selected binding of the told session: the owning session
  for an item, and for a topic the family member most recently continued into
  (latest `continued_at`, else the original). A disconnected agent gets it on its
  next claim. A closed session, or one with no selected binding, gets nothing.
  Session and project removal tell no agent. The envelope names the removed refs,
  says they are gone and must never be brought up again, and carries no removed
  content. The agent acknowledges with `answered` and no replies, the only result
  shape allowed without replies. Owners cannot submit `removed` themselves.
- **No backend undo.** The 5-second undo is in the renderer.

## Consequences

- Removal cannot be reversed in the app. Recovery means restoring a backup file
  by hand.
- Backups are never pruned automatically. They grow with each removal.
- A queued removal notice still names its topic. Archiving takes pending notices
  with it through the ordinary cancellation path (ADR-0090).
- Topic family members after the route session commit one by one under the same
  op_id. A crash or a failing member in between leaves some copies; the error
  names the sessions that still hold one. An exact retry finishes them.
- A registered project whose sessions cannot be read blocks every topic
  removal, because it may hold a copy. Topic removal refuses when any
  registered project's store or session cannot be read, because any of them may
  hold a copy.
- The `removed` notice is text to an agent, not enforcement. An agent that ignores
  it can still mention removed work in the terminal; it can no longer write to the
  removed items because they do not exist.

## Not verified

- A live Claude Code or Codex agent receiving and acknowledging a `removed`
  notice. Core, CLI and desktop tests cover the envelope and the acknowledgement.
- The renderer Remove UI and its undo. That is a separate work package.

## Spec references

- [API and MCP: Remove](../planning/low-level/API_AND_MCP.md)
- [UI and native: Remove](../planning/low-level/UI_AND_NATIVE.md)
- [ADR-0082](ADR-0082-project-store-under-data-root.md)
