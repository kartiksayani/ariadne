# Dispatched owner inputs

A dispatched input is a message whose first line is
`[ARIADNE_INPUT:<input>:<attempt>]`, followed by a short JSON envelope:
`source_input_id`, `attempt_id`, `binding_id`, `generation`,
`owner_message_number`, `input_kind`, the target (`item_id` with the item's
current `item_revision` and `question_revision`, or `topic_id` for a topic-level
input), `selected_option_id` and `selected_option_label` when the owner picked an
option, and `text`, the owner's exact words. It carries no item body or history;
read them with `ariadne read` or `ariadne item messages|rounds` if you need them.
The input is the owner's message, not tool approval: keep existing host
permissions.

## Answering

Copy the envelope's `source_input_id` and `attempt_id` into the request, and
commit exactly one `input_result`:

- `outcome`: `answered`, `deferred` or `unable`.
- `explanation`: what you did, in a sentence.
- `reply_refs`: the `ref`s of your replies in this request (never existing ids),
  so give each such `reply` a `ref`. Omit it for none.
- `followup_item_refs`: items you filed because of the input, by `ref`. Omit it
  for none.
- `handled_through_message_number`: the envelope's `owner_message_number`.

Host completion alone is not a result, and terminal prose does not update item
messages: write each full answer as a `reply`, not only in chat. A brief terminal
summary is fine once the replies and the result are committed. The owner can delete a queued message before delivery; it then never
reaches you.

## Input kinds

- `answer`: the owner answered your ask round on `item_id`; act on it there, and
  close its parent if it was the last open child (below).
- `reply`, `note`, `followup`: the owner wrote on `item_id`; see `follow-up.md`.
- `bring`: raise the open item `item_id` now with `item.ask` and options.
- `reopen`, `drop`: reopen or drop `item_id`, with a reply that says why.
- `continue`: earlier work continues into `topic_id`; `text` is the handoff
  summary. Read that topic's items before working.
- `topic_reply`: an instruction for the whole topic; see `follow-up.md`.
- `removed`: the owner removed the items and topics in `removed.refs`. Stop all
  work on them, never mention or recreate them, touch no files because of it, and
  acknowledge with no operations and outcome `answered`.

An envelope with `"purpose":"result_repair"` is a repair turn for
`repair_for_attempt_id`: the earlier attempt may already have effects. Inspect
`original_message_ids`, `affected_item_ids` and `original_domain_result` with the
read commands, do not repeat its mutations, and publish only the missing
`input_result` for this new `attempt_id`, citing the verified original replies.

## Closing the parent

When your request settles the last open child of a parent (`done`, `decided`,
`dropped` or `replaced`) and nothing on the parent itself is open (no unanswered
owner message, no pending ask, no follow-up you still owe), close the parent in
that same request: `done` for a summary, finding or report, `decided` for a
decision. Its `outcome` is one line summing up the children's results; its `why`
says why it is finished. Guard both items with their revisions. If the owner's
answers reopen something on the parent, keep it open.

## Examples

Answer an ask on item `1` (revision 4): reply, decide, finish the input.

```json
{"source_input_id":"00000000-0000-4000-8000-000000000010","attempt_id":"00000000-0000-4000-8000-000000000011","expected_item_revisions":{"1":4},"summary":"Answered item 1","operations":[{"op":"reply","ref":"r1","item":{"id":"1"},"text":"Full answer with reasoning."},{"op":"item.status","item":{"id":"1"},"status":"decided","outcome":"Use X","why":"Because Y"}],"input_result":{"outcome":"answered","explanation":"Replied and decided.","reply_refs":[{"ref":"r1"}],"handled_through_message_number":7}}
```

The last open child `1.1` (revision 1) of decision `1` (revision 2) is settled, so
the parent closes with it:

```json
{"expected_item_revisions":{"1":2,"1.1":1},"summary":"Settled the last choice","operations":[{"op":"item.status","item":{"id":"1.1"},"status":"decided","outcome":"Use cache A","why":"The owner picked A."},{"op":"item.status","item":{"id":"1"},"status":"decided","outcome":"Ship with cache A","why":"Every choice under it is decided."}]}
```
