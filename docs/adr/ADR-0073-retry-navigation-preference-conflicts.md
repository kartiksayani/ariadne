# ADR-0073: Retry preference revision conflicts for navigation and draft writes

Status: Proposed.

Several parties write preferences under a revision check: native window
geometry, pin/notification settings, the CLI and the renderer. The renderer only
learned of foreign writes through a 2 s poll, so a click soon after a resize
was rejected with "Preferences revision changed" and the owner's action was lost.

Native preference writers now emit `ariadne://preferences_changed` with the saved
revision after each successful write, following the `session_changed` hint
pattern. The navigation store refreshes when the revision is newer than the one
it holds. The hint is best effort; the poll still covers a missed hint and CLI
writes.

For navigation-only renderer writes (selection, expansion, scroll, filters,
session view, tabs, Later, theme), a definite `revision_conflict` refreshes and
re-applies the same action once, with a new operation id, against the new
revision. Only the fields the action changed are replayed, so a foreign change
to another field survives. A second conflict surfaces as before.

Draft bookkeeping writes follow a second path. `OwnerDraftStore.writePreferences`
(`apps/desktop/src/state/drafts/store.ts`) re-reads preferences and re-issues the
same `upsert_draft`/`delete_draft` entries under a fresh patch `op_id` after a
definite `revision_conflict`, at most three attempts in total. Draft entries are
keyed by the draft `op_id`, so replay is safe. (Added 2026-10-06 as an addendum;
folded into the body.)

Never retried: `commit_uncertain`, `invalid_transition` and any other error, on
either path. Owner input delivery is never resent automatically: the owner
`input_submit` is not part of draft bookkeeping, so BUILD_HANDOFF.md and ADR-0054
(no automatic resend) are unchanged, and the "This item changed" review safeguard
is untouched. ADR-0031 and ADR-0041 do not restrict re-submitting a rejected
preference patch; a conflicted patch committed nothing.

Not changed: a second click while a write is in flight is still refused. Waiting
and applying it would need the caller's stale whole-view object rebased onto the
first write, which is not a small change.
