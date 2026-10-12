# ADR-0099: Link kinds, change records, topic briefs and seen state

Status: accepted (2026-10-13)
Supersedes: none
Superseded by: none

## Context

The owner's goal for Ariadne is faster knowledge transfer from agent to owner and
cheap context switching. A review of real use found three gaps the data model
cannot close today:

- One decision ripples into other items, but [ADR-0094](ADR-0094-item-links.md)
  links carry one meaning, **related**, so nothing says which items a decision
  affects or what a task waits on.
- When an agent updates an item, Ariadne keeps no before and after text. The owner
  learns "3.4 and 4.7 updated" and must reopen both to find out what changed.
- Nothing records what the owner has already looked at, so changed items cannot
  stand out.

Agent rules also ask for a summary-first item in every topic, which competes with
the work items for attention.

Separately, owner preferences keep every operation receipt forever. On one real
store, 32,517 receipts made `ui.json` 11 MB, and each preference change (selecting
or expanding a row) rewrites that file and its backup.

## Decision

1. **Link kinds.**
   - Add optional `Item.affects` and `Item.depends_on`: `ItemRef[]` declared on
     the source item, next to `related`.
   - Both reuse every ADR-0094 rule for `related`: same-session targets across
     topics; strict reference objects plus CLI item-number and local-ref strings;
     at most 32 per list; self-links and duplicate targets refused; dangling
     targets tolerated and pruned on the next write of that list, reported in
     `pruned_related`; continuation remaps them; omitted keeps, `[]` clears.
   - A target appears in at most one of an item's three lists. Strict contracts
     refuse a repeat. The CLI repairs it by keeping the specific kind and dropping
     the target from `related`, and reports the repair.
   - Both directions are shown: "affects" on the source, "affected by" on the
     target; "depends on" and "needed by".
   - No "replaces" or "same as" link: `item.replace` already records a
     replacement, and duplicates are merged with it.
2. **Change records.**
   - Add optional `Item.changes`: `ItemChangeRecord[]`, oldest first, at most 20.
     A write drops the oldest records beyond 20.
   - A record holds:
     - `revision`: the item revision after the change;
     - `at`;
     - `cause_message_id`: the batch's activity message;
     - optional `reason`: one line, at most 280 characters;
     - `before`: the previous value of each changed field, and only those.
   - Fields covered by `before`: `question`, `short`, `type`, `status`, `note`,
     `ask`, `options`, `outcome`, `why`, `links`, `related`, `affects`,
     `depends_on`. Null means the field was empty.
   - Written inside `transition_item` for every agent edit, ask, status change and
     replacement that changes at least one of those fields. The reason comes from:
     - `item.edit` and `item.status`: their `reason` (status falls back to `why`);
     - `item.replace`: its `why`;
     - `item.ask`: none.
   - `item.edit` gains an optional `reason` and an optional `wording_only` flag
     (default false). The flag means "same meaning, new words". The record keeps
     it as `wording_only: true` (absent when false). The edit shows in history
     but never marks the item as changed for the owner, because repeated
     low-value alerts get ignored. Status changes, asks and replacements are
     never wording-only. A `wording_only` edit may change only `question`, `short`
     and `note`. One that also changes `type`, `ack_to` or any link list is
     refused with a plain message.
   - Not recorded:
     - item creation (`created_message_id` and revision 1 already mark it new);
     - owner acknowledgment and other owner actions;
     - a child being added under a parent;
     - continuation copies, which start with no records;
     - bin removal and restore.
   - Validation checks shape, order and that each revision is at most the item's.
     A cause message that is later removed leaves the record readable.
3. **Topic brief.**
   - Add optional `Topic.brief`: plain text, trimmed, line breaks allowed, at most
     1,200 characters. Add `Topic.brief_updated_at`.
   - `topic.add` accepts `brief`.
   - New agent operation `topic.edit` with:
     - `topic`;
     - optional `name`;
     - optional `short` (null clears);
     - optional `brief` (null clears).

     It bumps the topic revision, honours `expected_topic_revisions`, and refuses
     archived or binned topics with the same messages as `item.add`.
   - The brief replaces the summary-first item in the agent rules.
4. **Seen state, owner only, in preferences.**
   - Add `PreferencesSnapshot.seen`: `SessionSeen[]`, defaulting to empty. Each
     entry holds:
     - `session`;
     - `since`;
     - `items`: `{item_id, revision}[]`;
     - `topics`: `{topic_id, at}[]`.
   - New patch entry `mark_seen {session, at, items, topics}`:
     - It merges upward only, never lowering a revision or a time.
     - The first entry for a session sets `since` to `at`.
     - It is bounded at 10,000 items and 1,024 topics per session.
   - Seen state stays out of the session file, so the owner's browsing never
     rewrites the file agents write.
5. **Preference receipt window.**
   - Keep the newest 256 preference receipts.
   - Validation accepts any consecutive run of receipts that ends at the snapshot
     revision, so existing large files still load. The next write trims them.
   - A replayed operation ID inside the window returns its saved result. An older
     one is treated as new, and its stale `expected_preferences_revision` refuses
     it, so nothing applies twice.
6. **Derived, not stored.**
   - The "this changed N things" card for an owner input comes from the agent
     batches whose activity message carries that `input_id`: the items they
     created, and their change records with that cause.
   - **New to the owner**: the item was created after `since` and has no seen
     revision.
   - **Changed since read**: a change record that is not wording-only, made
     after `since` and newer than the item's seen revision.
   - "Waiting on me" stays the item's status. Viewing never clears it; only an
     answer does.
   - A topic's seen time is when the owner last marked it caught up, not when
     they last opened it. "Since you were here" and an updated brief are
     measured from it.
   - A question still waiting in a closed session shows "session closed" and
     leaves the Waiting count. No data is written for it.
7. **Agent warnings.** The CLI may add non-blocking warnings to its apply output.
   Warnings never change what is saved.

## Consequences

- Every new field is optional and additive. Stores written before this ADR load
  and re-save unchanged until an agent writes the new fields.
- Session files grow by at most 20 small records per item, holding only changed
  fields.
- Owner-visible "what changed" no longer depends on agents remembering to say it.
  Typed links and reasons add meaning when agents give them.
- Large preference files shrink on the first write after upgrade.

## Spec references

- [Domain and storage](../planning/low-level/DOMAIN_AND_STORAGE.md)
- [Agent API](../planning/low-level/API_AND_MCP.md)
- [Agent rules](../../integrations/rules/source.md)
- [ADR-0094 Related items](ADR-0094-item-links.md)

## Implementation clarifications

Every change inside the apply batch that created an item is part of creation and
adds no record, including the CLI's deferred connections and explicit edits. The
first later batch starts its history. `transition_item` enforces this once using
the creation activity message.

Stored records remain complete. Read projections expose them as an optional,
independent `item_changes` page, following the existing item-history cursor
contract: six valid before-values containing large link lists can exceed the
fixed item projection's byte budget. A standalone `item_changes` read continues
the same history without repeating the current item, so large current and
previous values remain independently readable.

Explicit reasons obey the new one-line, 280-character rule. Reasons derived from
existing `why` prose normalize whitespace and keep at most 280 characters while
preserving the full `why`, whose existing contract permits multiline text.
