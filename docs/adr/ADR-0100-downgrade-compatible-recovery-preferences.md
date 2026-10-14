# ADR-0100: Downgrade-compatible unsent recovery preferences

Status: accepted
Supersedes: none
Superseded by: none

## Context

Alpha.15 removes the Messages pane and adds persistent recovery notices for unsent
owner messages outside item conversations. The owner requires dismissals and
successful put-backs to survive restart, and alpha.14 to keep loading tabs, Later
and drafts after a downgrade. Alpha.14 requires each saved session view's `rail`
field and rejects unknown fields throughout its preference record. A new recovery
field in `ui.json` would therefore break the required downgrade.

## Decision

At the disk boundary, always write `"rail": "hidden"` in session views. Keep it
absent from the current API and generated TypeScript model, and ignore its old
value when loading. Expose an optional, default-empty `resolved_unsent_input_ids`
collection in the current preference snapshot and an additive `resolve_unsent_input`
patch. Store those IDs in the fixed `ui-recovery.json` companion under the existing
owner preference lock. Alpha.14 leaves this companion untouched.

Recovery patches contain only their completion marker. Save a restored draft
first, then its marker. The companion durably records the marker and replay receipt
before the corresponding `ui.json` revision and receipt are published. Loading or
replaying completes a pending marker's revision projection when needed, preserving
the current tabs, Later and drafts. If a downgraded build has already advanced the
main preferences, keep its changes and the companion's marker. Never report a
completed recovery before its marker is durable.

The companion is optional convenience data. If it cannot be read, validated or
reconciled with the main revision because its contents are invalid, move it aside to
`ui-recovery.corrupt-<time>.json`, log a plain line, and continue without markers.
Never delete its evidence or let it block navigation or saved drafts. If moving
it fails, keep it untouched and ignore it for that operation. Old notices may
reappear. Keep at most 10,000 completion IDs in insertion order, evicting the
oldest first for a new ID; an existing ID keeps its position.

Store failures do not make a valid companion corrupt: leave its bytes and replay
receipts untouched. Preference reads still succeed. If companion durability
cannot be confirmed, return the authoritative main snapshot without markers. If
durability is confirmed but publishing a pending revision to the main file fails,
return the validated in-memory projection, including the durable markers and the
main file's saved navigation and drafts. Retry publication on a later operation.
Every patch, including an ordinary draft patch, still propagates store failures
or `CommitUncertain`; retry with the same operation ID. A successful read does
not imply that a pending main-file publication or a new patch has been saved.

Keep the existing 1 MiB response allowance for the legacy preference fields.
The bounded recovery ledger and revision metadata have a separate 400 KiB
allowance for the maximum 10,000 input IDs and revision digit growth. Account
for ordinary data at revision 1, and validate the full envelope against the
combined limit. Validate these limits both when loading preferences and at the
query boundary, so a valid older build's full preferences remain readable after
the companion is merged. Other response limits remain unchanged.

## Consequences

Both versions can read and save their owner preferences. The current build resumes
recovery completion after a downgrade without adding a message history surface.
The companion adds one fixed preference file and a small replay path; it reuses
the existing locked, private, atomic file primitives. Existing draft-save
uncertainty and operation-reuse protections remain in force.

## Spec references

- [Alpha.15 design](../planning/DESIGN.md#alpha15-remove-the-messages-pane)
- [Preference contract](../planning/low-level/API_AND_MCP.md)
- [UI and native contract](../planning/low-level/UI_AND_NATIVE.md)
