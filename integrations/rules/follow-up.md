# Answering the owner

For the owner's follow-up, reply, note or topic reply, dispatched (`inputs.md`) or
not. The rules in `SKILL.md` still apply; shape every answer like a first report.

- **Short answer about the item itself**: a `reply` on it.
- **Answer with two or more points the owner could comment on separately** (for
  example "what are Q10 and Q11?"): file each as a child
  `explanation`, `open` with `ack_to: "done"`, of that item (an ask if it waits on the owner). Keep the `reply` to a 1-2 line
  pointer and list the children in `followup_item_refs`.
- **Related items**: apply the ripple updates in `SKILL.md` across the session;
  if another item carries an owner decision, ask there before reversing it.
- **The answer changes the result**: update its `outcome` and `why`; the earlier
  outcome stays in history. Leave the result `open` with its `ack_to` for the
  owner to Ack.
- **`bring`** on an open item: ask it now with `item.ask` and options.
- **`reopen`**: `item.status` `open` with a `reason`, redo the work, then finish a
  read-only result `open` with `ack_to`, `outcome` and `why`.
- **Topic reply** ("approve the PR", "clean all of it up"): do it across the
  topic, settle each ask with `item.status` (the outcome says what you did),
  leaving any item with `ack_to` open, and finish with one `input_result`;
  `reply_refs` and `followup_item_refs`
  may be empty.
- **One part of a multi-part choice**: act on that part; finish the parent for Ack
  when its last part is decided.

## Example

The owner replied on [retry questions](item:1) (revision 1): "what are Q10 and
Q11?". The session check finds no other affected items. The new items use
[retry questions](item:1)'s topic id from `ariadne read`.

```json
{"source_input_id":"00000000-0000-4000-8000-000000000010","attempt_id":"00000000-0000-4000-8000-000000000011","expected_item_revisions":{"1":1},"summary":"Explained Q10 and Q11","operations":[{"op":"item.add","ref":"q10","topic":{"id":"00000000-0000-4000-8000-000000000005"},"parent":{"id":"1"},"question":"Q10: do retries stop after a cap?","short":"Q10 retry cap","type":"explanation","status":"open","ack_to":"done","outcome":"Yes, after five attempts.","why":"`MAX_RETRIES` in `src/retry.rs`."},{"op":"item.add","ref":"q11","topic":{"id":"00000000-0000-4000-8000-000000000005"},"parent":{"id":"1"},"question":"Q11: is the delay jittered?","short":"Q11 jitter","type":"explanation","status":"open","ack_to":"done","outcome":"No, it is a fixed 2s.","why":"See `backoff()` in `src/retry.rs`."},{"op":"reply","ref":"r1","item":{"id":"1"},"text":"Retries stop after five attempts; the delay is fixed at 2s."}],"input_result":{"outcome":"answered","explanation":"Explained Q10 and Q11 as two items.","reply_refs":[{"ref":"r1"}],"followup_item_refs":[{"ref":"q10"},{"ref":"q11"}],"handled_through_message_number":7}}
```
