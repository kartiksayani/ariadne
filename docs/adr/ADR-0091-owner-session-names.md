# ADR-0091: The owner names a session; the agent line becomes the quieter label

Status: accepted (owner ruling, 2026-10-08)
Supersedes: none
Superseded by: none

## Context

Every session card on a project page read "claude-code · iTerm window 1". Two
sessions of the same agent in the same terminal looked identical, so the owner
could not tell which one held which work. `Session.title` is no help: it holds the
external session id (a UUID), which the owner should never see.

## Decision

- **Two optional fields on `Session` and `SessionSummary`:** `name` (trimmed,
  1 to 60 characters) and `description` (trimmed, one line, at most 200
  characters). Both are omitted when unset (serde default, skipped when `None`), so
  older stores load and re-serialize byte for byte. There is no schema-version bump;
  this is the same additive migration as `Topic.short` (ADR-0084) and
  `Binding.host_location` (ADR-0085). Stored-session validation rejects a
  hand-edited name or description that is blank, untrimmed, multi-line, has control
  characters or is over its limit.
- **One owner command, `session_label_set`.** Params are `{name, description}`,
  each `string | null`; the session comes from the route, as for `session_close`,
  so there is no `session_id` in the params and no `expected_revision`. Both fields
  are replaced together. Text is trimmed; blank or `null` clears the field. A name
  over 60 characters, a description over 200, or a line break is refused with a plain
  message and a field error. The command is allowed on active and closed sessions
  and refused with `not_found` ("This session was removed, so it can't be renamed.")
  once the session is removed. Agents cannot call it.
- **A rename is not activity.** It bumps `revision` (the store's write barrier) but
  not `updated_at`, which stays the time of the last real change. The retry digest
  uses the stored (normalized) form, so a retry with different spacing replays the
  saved receipt. The receipt is `session_label {name, description}`, the stored
  values; the desktop checks them against what it sent.
- **Display.** The name leads wherever a session is named: project-page cards, the
  session bar, tabs, the Continue picker and Connect picker, the Close, Remove and
  not-running confirmations, the Archive "From" line, a continued topic's chip, the
  graph's session chip, and "asked in an earlier session" on Waiting cards. The
  "claude-code · iTerm window 1" line stays as a quieter secondary line beside a name,
  and stays the title while a session is unnamed. The description shows under the name
  on the card and as a one-line subtitle in the session bar (the whole text in its
  tooltip). All of it goes through `sessionLabel` and `sessionPhrase`
  (`ui/shell/model.ts`). The tray lists no sessions, so it is unchanged.
- **Editing.** A "Rename" button (pencil and word) on each card and in the session
  bar opens the two fields in place. Enter or Save saves; Esc or Cancel leaves
  everything as it was and focus returns to the button.

## Consequences

- Names are display text and grant nothing. They are not unique.
- Closed sessions can be named, so history stays recognizable.

## Not verified

- A live rename in the packaged desktop app. Rust tests cover limits, clearing,
  removed sessions and persistence across reopen; UI tests cover the flow, the
  places the name shows and the unnamed fallback.
