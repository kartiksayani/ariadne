# ADR-0095: Put finished sessions away without losing their history

Status: accepted (2026-10-09).
Supersedes: none
Superseded by: none

## Context

Finished plans and merged changes leave many sessions on the owner's project
page. The owner needs to put them away while keeping their topics, messages,
and outcomes available to read.

## Decision

`session_archive` and `session_restore` are revision-guarded owner commands.
Archive closes an active session through the same cancellation and binding pause
path as Close, then records `archived_at` in the same transaction. A result already
committed stays handled. Restore clears the archive marker and leaves the session
Closed. Undo of an active session requests `reopen: true` on `session_restore`:
restore and the existing Reopen behavior run in one transaction with one expected
revision and one receipt. This resumes sending even if the owner had paused it
before archiving. Undo of a closed session leaves it Closed. Cancelled messages
remain cancelled in both cases.

Session cards offer Archive, with a plain confirmation whenever the session is
Active, a question waits on the owner, or a message is pending. The confirmation
reuses Close's counts; committed results are not counted as cancellations. The
notice reports closing and receipt cancellation counts. When messages were
cancelled, it says they stay cancelled and, for an active session, that Undo
resumes sending even if the owner had paused it. Its Undo action is
consumed on the first click. Archived cards live in a bottom `Archived · N` group,
folded by default. The existing preference store remembers expansion per project.
Restore, reading, and Remove remain available there.

Archived sessions stay readable through desktop, agent reads, and CLI. Owner
input and reconnecting are refused with instructions to restore and reopen.
Related item links remain readable within the same archived session. Continue
from an archived session is refused until the source session is restored.
Ordinary totals, project counts, menus, the tray, Waiting, discovery targets,
and connection choices exclude archived sessions. The full session catalogue
retains them and reports a separate `archived_total`.

## Consequences

Archive keeps all saved history and closes safely in one action. Session,
summary, and lifecycle receipt archive markers default to absent and serialize
only when set, preserving old data and untouched files. Expansion preferences
also serialize only when used. No migration or new dependency is needed.

## Spec references

- [Domain and storage](../planning/low-level/DOMAIN_AND_STORAGE.md)
- [API and MCP](../planning/low-level/API_AND_MCP.md)
- [UI and native](../planning/low-level/UI_AND_NATIVE.md)
