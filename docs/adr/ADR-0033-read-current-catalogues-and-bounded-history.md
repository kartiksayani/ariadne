# ADR-0033: Read current catalogues and bounded history

Status: accepted
Supersedes: none
Superseded by: none
Implementation: P1.6

## Context

Registered roots may become unreadable independently of their registration.
Queries need truthful partial counts without inventing Project metadata. Registry
revision alone cannot detect session edits between aggregate pages. Full saved
conversation history also needs independent continuations within bounded parents.

## Decision

Native `queries::QueryService` reads the trusted Registry catalogue and validated
session snapshots using existing stable coordination locks. Reads create no
authoritative registry, project, session, index or backup content. A genuinely
absent sessions directory is an empty complete catalogue, without creating a
sessions or backups directory. Other unreadability remains explicit and partial.
Setup's fail-fast global uniqueness checks are unchanged.

`ProjectSummary` includes required `project_id` and required nullable `project`.
Available rows have current verified metadata matching the registered ID.
Unavailable rows may have null metadata, or verified metadata when only sessions
are unreadable. There is no retained metadata cache or fabricated Project.
Partial counts include known unreadable session IDs; an unknown catalogue may
truthfully have an empty ID list. Counts and rows use the same captured records,
before pagination or session-state filtering. Binding presence remains unknown
without an actual runtime observation.

Aggregate cursor `filter_digest` hashes the full actor/route/filter and captured
inventory of registered roots, current Project metadata, session revisions and
availability. Its positive revision is the captured registry revision, or one
for an empty registry. Any full digest mismatch, including changed filters,
returns `snapshot_changed`; wrong view/position shape is `invalid_argument`.
Single-session cursors retain session revision freshness and reject changed
actor/route/filter scopes. No truncated digest, extra cursor field or counter is
introduced. Keys use explicit parent/ordinal paths and stable tie-break IDs;
session summaries sort by updated_at then project ID and session ID ascending.

Pages retain at most 100 entities/1 MiB and fixed entity projections at most
768 KiB, accounting for JSON escaping. Complete entities are never truncated.
Item and round historical collections have separate cursors. Their fixed parent
and truthful continuations reserve space first, then requested collections get
priority over defaults. A default collection can be empty with an `after:null`
continuation when space is consumed by another family. Requesting that family
progresses when its complete entity fits; conflicting explicit families may
return capacity guidance to request one at a time. Outer continuation never
advances an independent nested cursor.

Items.statuses remains a literal current-status filter. Waiting counts use an
unsuperseded Answer for the current question episode whose Input is neither
cancelled nor skipped; cancellation does not reactivate a superseded Answer.
Sent counts queued/in-flight/needs-attention Inputs without changing Item status.
Item conversations use direct OwnerInput/Reply targets, with creation context
separate from activity backlinks.

Agent reads recheck the selected binding and current trusted generation. A
terminal ceiling may be narrower than the persisted issued watermark, never
wider. Dispatched scope also verifies the source Input/Attempt and ceiling at
most its source owner-message issuance and latest binding watermark. Historical
attempt reads may use a newly trusted current generation after reconciliation;
the original attempt generation is preserved. Owner messages and their Answers,
round histories, item history and timeline backlinks obey the same ceiling.
Queue projections carry IDs/state only. These read scopes confer no lease,
dispatch, write or retry authority.

## Consequences

Queries expose current verified data and explicit unavailability without writes
or repair. Native QueryError preserves Registry/Store causes. Continuation and
preferences execution remain with their owning product tasks. Real filesystem
tests cover freshness, partial data, complete histories, escaping, read ceilings
and readers concurrent with atomic owner saves; full measured/native/release
acceptance remains in CI.
