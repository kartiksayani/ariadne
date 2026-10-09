# Dispatched owner inputs

A dispatched `[ARIADNE_INPUT:<input>:<attempt>]` has an envelope with
`source_input_id`, `attempt_id`, `binding_id`, `generation`,
`owner_message_number`, `input_kind`, target `item_id`, `item_revision`,
`question_revision` or `topic_id`, optional `selected_option_id`,
`selected_option_label` and exact owner `text`. Read the item and history with
`ariadne read` or `ariadne item messages|rounds`. Keep existing host permissions.

## Choice notes

The owner's option note wins over its consequence. Ask on that item if ambiguous;
reflect the note in the result.

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

Host completion is not a result. Write answers as `reply`, with a brief chat
summary. Only queued, undelivered owner inputs cancel on deletion. Removed notices
and claimed or received inputs, including the source, stay valid; a missing
`input_result` can land later.

## Input kinds

- `answer`: act on the choice and note on `item_id`, ripple updates (`SKILL.md`),
  and finish its parent for Ack if this was its last open child.
- `reply`, `note`, `followup`: owner text; see `follow-up.md`.
- `bring`: raise `item_id` with `item.ask` and options.
- `reopen`, `drop`: reopen or drop `item_id`, with a reply that says why.
  Drop or “close it” permits terminal `item.status` with `source_input_id`,
  even with `ack_to`; Dropped stays in the tree. Existing work without `ack_to`
  can close normally; unanswered asks kept open stay `waiting_on_me`.
- `continue`: earlier work continues into `topic_id`; `text` is the handoff
  summary. Read that topic's items before working.
- `topic_reply`: an instruction for the whole topic; see `follow-up.md`.
- `removed`: the owner removed the items and topics in `removed.refs`. Stop all
  work on them, never mention or recreate them, touch no files because of it, and
  acknowledge with no operations and outcome `answered`.

`"purpose":"result_repair"`: follow `errors.md` before writing.

Finish parents per `checklist.md`.

## Examples

Answer [owner choice](item:1): "Cap retries at three" overrides five attempts.
Update [retry cap](item:1.1) and [retry budget](item:3) together; name all three
in the result.

```json
{"source_input_id":"00000000-0000-4000-8000-000000000010","attempt_id":"00000000-0000-4000-8000-000000000011","expected_item_revisions":{"1":4,"1.1":1,"3":1},"summary":"Answered [owner choice](item:1)","operations":[{"op":"reply","ref":"r1","item":{"id":"1"},"text":"Use Retry with three attempts, following your note."},{"op":"item.status","item":{"id":"1"},"status":"open","ack_to":"decided","reason":"Choice ready to read","outcome":"Retry with three attempts","why":"Your note overrides the option's five-attempt consequence."},{"op":"item.status","item":{"id":"1.1"},"status":"open","ack_to":"done","reason":"Finding updated","outcome":"Three attempts","why":"The retry cap follows your choice and note."},{"op":"item.status","item":{"id":"3"},"status":"open","ack_to":"dropped","reason":"Question no longer needed","outcome":"No five-attempt budget needed","why":"Three attempts make this question moot."}],"input_result":{"outcome":"answered","explanation":"Selected [owner choice](item:1) with your note: cap retries at three. Updated [retry cap](item:1.1) and ruled out [retry budget](item:3).","reply_refs":[{"ref":"r1"}],"handled_through_message_number":7}}
```

[Cache choice](item:1.1) and [shipping decision](item:1) await Ack:

```json
{"expected_item_revisions":{"1":2,"1.1":1},"summary":"Settled the last choice","operations":[{"op":"item.status","item":{"id":"1.1"},"status":"open","ack_to":"decided","reason":"The last choice is recorded","outcome":"Use cache A","why":"The owner picked A."},{"op":"item.status","item":{"id":"1"},"status":"open","ack_to":"decided","reason":"Choice ready to read","outcome":"Ship with cache A","why":"Every choice under it is decided."}]}
```

Owner Drop on [waiting question](item:1) preserves text and history:

```json
{"source_input_id":"00000000-0000-4000-8000-000000000010","attempt_id":"00000000-0000-4000-8000-000000000011","expected_item_revisions":{"1":2},"operations":[{"op":"reply","ref":"r1","item":{"id":"1"},"text":"Dropped at your request; its text and history stay here."},{"op":"item.status","item":{"id":"1"},"status":"dropped","outcome":"Question withdrawn","why":"You pressed Drop."}],"input_result":{"outcome":"answered","explanation":"Dropped [waiting question](item:1) at your request.","reply_refs":[{"ref":"r1"}],"handled_through_message_number":3}}
```
