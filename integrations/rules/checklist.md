# Plans and long-running work

The `SKILL.md` rules apply.

## Checklist

- One `task` per step, added `open` in the order you will do them. The step you
  start is `in_progress` with a `note` ("Backfilling: 1.2M of 4M rows").
- A step that needs consent is an ask on that step (`ask` when you add it,
  `item.ask` once it exists). Work for someone else is a
  `task` owned by `{"kind":"other","name":"N"}` that says who and what.
- As you go, update the note with `item.edit` (patch `{"note":"..."}`), finish each
  step `open` with `ack_to: "done"`, its result and evidence, and start the next.
  The tree is the checklist; the owner watches "In progress". Finishing hides
  the progress note; Ack marks the step Done.

## Finishing the parent

Keep any parent with `ack_to` open: finishing its children is not acknowledgment.
Finish an in-progress summary with `item.status` `open`, `ack_to`, `outcome` and
`why`, so the owner can read it before Ack.

When the last child is settled and your work on the parent is complete, finish
its result `open` with `ack_to` in the same request, but only if all of these hold:

- The parent is yours to finish: you own it, not the owner or someone else, and it
  has no ask of its own still waiting.
- Nothing else on it is open: no unanswered owner message, no follow-up you owe.

Choose the parent's target from its actual remaining work: `open` or
`in_progress` if reading leaves more work; `decided` for a finished choice,
`done` for finished work. Its `outcome` is
one line summing up the children's results; its `why` says why it is finished.
Guard both items with their revisions. If the owner's answers reopen work on
the parent, keep its progress current instead.

## Live work

- Each new confirmed lead is a child `finding`, `open` with `ack_to: "open"`
  while the investigation continues;
  a newly ruled-out lead uses `ack_to: "dropped"` with why.
  The root cause is a `finding`; follow-ups are tasks.
- When the work ends, finish the task `open` with `ack_to: "done"`, what happened
  and why, and add a summary item if the owner needs a report (`report.md`).

## Example

A started step, a consent ask, and work for someone else (`owner` `other`).

```json
{"summary":"Planned the notes sync migration","operations":[{"op":"topic.add","name":"Migrate notes sync to v2","short":"Notes sync migration"},{"op":"item.add","question":"Backfill v2 from v1","short":"Backfill v2","type":"task","status":"in_progress","note":"Backfilling: 1.2M of 4M rows"},{"op":"item.add","question":"Switch reads to v2","short":"Switch reads","type":"task","ask":"Switch reads to v2 after the backfill?","options":[{"label":"Switch after backfill","consequence":"Readers use v2; rollback needs a redeploy","recommended":true},{"label":"Wait","consequence":"Both tables stay in sync longer"}]},{"op":"item.add","question":"Drop the v1 table","short":"Drop v1","type":"task","owner":{"kind":"other","name":"Sync maintainer"}}]}
```
