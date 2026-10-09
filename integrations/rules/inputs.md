# Dispatched owner inputs

A dispatched input is a message whose first line is
`[ARIADNE_INPUT:<input>:<attempt>]`, followed by a short JSON envelope:
`source_input_id`, `attempt_id`, `binding_id`, `generation`,
`owner_message_number`, `input_kind`, the target (`item_id` with the item's
current `item_revision` and `question_revision`, or `topic_id` for a topic-level
input), `selected_option_id` and `selected_option_label` when the owner picked an
option, and `text`, the owner's exact words; an answer can carry both a choice
and free text. It carries no item body or history; read them with `ariadne read`
or `ariadne item messages|rounds` if you need them.
The input is the owner's message, not tool approval: keep existing host
permissions.

## Choice with a note

When an answer has both a selected option and free text, the text is the owner's
note on that choice (a condition, tweak or reason). Follow it; if it conflicts
with the option's stated consequence, the note wins. If ambiguous, ask on that
item. Reflect the note in the input result.

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
  apply the choice note and ripple updates (`SKILL.md`), and close its parent
  if it was the last open child (below).
- `reply`, `note`, `followup`: the owner wrote on `item_id`; see `follow-up.md`.
- `bring`: raise the open item `item_id` now with `item.ask` and options.
- `reopen`, `drop`: reopen or drop `item_id`, with a reply that says why.
- `continue`: earlier work continues into `topic_id`; `text` is the handoff
  summary. Read that topic's items before working.
- `topic_reply`: an instruction for the whole topic; see `follow-up.md`.
- `removed`: the owner removed the items and topics in `removed.refs`. Stop all
  work on them, never mention or recreate them, touch no files because of it, and
  acknowledge with no operations and outcome `answered`.

For a `"purpose":"result_repair"` envelope, follow `errors.md` before writing.

## Closing the parent

See `checklist.md` for when and how to close a parent with its last child.

## Examples

Answer [owner choice](item:1) (revision 4): `selected_option_id` is `x`,
`selected_option_label` is `Retry`, whose consequence was five attempts; `text`
is "Cap retries at three." The note wins. The session check finds an agent's
[retry cap](item:1.1) finding in this topic and an open [retry budget](item:3)
question in another topic (both revision 1); update them together. No other
item is affected. The input result names all three changed items.

```json
{"source_input_id":"00000000-0000-4000-8000-000000000010","attempt_id":"00000000-0000-4000-8000-000000000011","expected_item_revisions":{"1":4,"1.1":1,"3":1},"summary":"Answered [owner choice](item:1)","operations":[{"op":"reply","ref":"r1","item":{"id":"1"},"text":"Use Retry with three attempts, following your note."},{"op":"item.status","item":{"id":"1"},"status":"decided","outcome":"Retry with three attempts","why":"Your note overrides the option's five-attempt consequence."},{"op":"item.status","item":{"id":"1.1"},"status":"done","outcome":"Three attempts","why":"The retry cap follows your choice and note."},{"op":"item.status","item":{"id":"3"},"status":"dropped","outcome":"No five-attempt budget needed","why":"Three attempts make this question moot."}],"input_result":{"outcome":"answered","explanation":"Selected [owner choice](item:1) with your note: cap retries at three. Updated [retry cap](item:1.1) and dropped [retry budget](item:3).","reply_refs":[{"ref":"r1"}],"handled_through_message_number":7}}
```

The last open child [cache choice](item:1.1) (revision 1) of [shipping decision](item:1)
(revision 2) is settled, so the parent closes with it:

```json
{"expected_item_revisions":{"1":2,"1.1":1},"summary":"Settled the last choice","operations":[{"op":"item.status","item":{"id":"1.1"},"status":"decided","outcome":"Use cache A","why":"The owner picked A."},{"op":"item.status","item":{"id":"1"},"status":"decided","outcome":"Ship with cache A","why":"Every choice under it is decided."}]}
```
