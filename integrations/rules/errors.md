# Errors

## Request details

- Defaults. `topic`: the request's only `topic.add` (nested `children` take their parent's).
  `status`: `waiting_on_me` with an `ask`, else `open`. `owner`: you; `{"kind":"me"}`
  with an `ask`; others are `{"kind":"other","name":"N"}`. Option `id`: 1, 2, ...
  `ref`: r1, r2, ... by position; name one only to reference it later. An ask's
  answer comes back to you.
- `children: [...]` on `item.add` holds nested `item.add` objects; their parent
  and topic are wired automatically.
- References: `{"ref":"a"}` names an earlier `ref` of this request (a letter, then
  letters, digits or `_`, at most 32); `{"id":"1.2"}` is an existing item, or a
  UUID for a topic or message. In `item.edit`, omit `short` or `note` to keep it,
  send a string to replace it, `null` to clear it.
- Connections: `item.add.related` or `item.edit.patch.related` takes item numbers
  or batch refs: `["3.2","notes"]` or `[{"id":"3.2"},{"ref":"notes"}]`.
  Adds accept later refs and nested children. Connections span this session,
  across topics, and show at both ends. Omit/null keeps them; `[]` clears them.
  Self, duplicate and new missing targets fail. Reads omit removed targets.
  Resent declared removed targets are pruned;
  receipt `pruned_related` maps source numbers to pruned numbers.
- Limits: `question`, `ask`, `note`, `outcome`, `why` at most 4096 bytes, `reply`
  64 KiB, 100 expanded operations, 12 options, 32 links and 32 related items per item.
- Types: question, decision, finding, task, explanation. Statuses: `open` and
  `in_progress` take a `reason` (only in `item.status`); `decided`, `done` and
  `dropped` need `outcome` and `why`; `replaced` only through `item.replace`;
  `waiting_on_me` only through an `ask`.

Link sync to [cache choice](item:1) and notes.

```json
{"summary":"Linked sync","operations":[{"op":"topic.add","name":"Notes sync","short":"Notes sync"},{"op":"item.add","ref":"notes","question":"Read notes offline","short":"Offline notes","type":"finding","status":"done","outcome":"Notes read offline","why":"Read offline."},{"op":"item.add","question":"Sync notes","short":"Sync local notes","type":"task","owner":{"kind":"other","name":"Sam"},"related":["1","notes"]}]}
```

## Failed commands

Exit 2 (`invalid_argument`, `invalid_ref`): the message names the offending field;
fix it and send a corrected request (without `op_id`, or with a new one). Exit 3
conflicts (`revision_conflict`, `invalid_transition`, `binding_mismatch`,
`operation_reused`): read the items again, rebuild with current revisions and no
`op_id`, except where a code below says otherwise. `ariadne apply --dry-run`
checks a request without committing it. A failing command is never a reason to edit `.ariadne/`
files.

| Code | Exit | Do |
|---|---|---|
| `stale_generation` | 3 | The generation is no longer current. If this conversation holds a newer connection note, setup instruction or `/ariadne-connect` output with a different generation, rebuild the request with it and no `op_id`. Otherwise stop writing and ask the owner for the current setup instruction. Never guess one. |
| `invalid_transition` with `details.reason: "topic_archived"` | 3 | The owner parked this topic. Do not retry. Ask the owner, in a live topic, to restore it. Reads still work (`--view items --topic <id> --archived`). |
| `attempt_sealed` | 3 | This input/attempt is closed. Do not retry or invent another attempt; tell the owner. |
| `result_already_committed` | 3 | The result is already saved. Send nothing more for this attempt; only an exact replay is valid. |
| `commit_uncertain`, `store_busy`, `io_error` | 4 | The save may have happened. Resend the identical request, at most 3 times, changing nothing: the CLI derives the same `op_id` from it, so a saved request replays (`"replayed":true`) and files nothing twice. If you set your own `op_id`, resend the same bytes. Still no receipt: stop and tell the owner. (`store_busy` saved nothing: resend.) |
| no reply at all (timeout, killed call) | 4 | A retry of the identical request is safe: it files once, and a replay shows `"replayed":true`. Change nothing in it; a changed request is new work. |
| any other exit 4 (e.g. `capacity_exceeded`, `host_unreachable`) | 4 | Stop and tell the owner; do not retry in a loop. |
| `unsupported`, `future_schema` | 5 | Stop and tell the owner. |

A replay of the same `op_id` and request writes nothing twice. Never resend the
owner's message, re-run completed work after a retry, scrape a transcript, or infer
non-delivery from missing output, presence, a timeout or a failed receipt.

## Result-only repair

An envelope with `"purpose":"result_repair"` is a repair turn for
`repair_for_attempt_id`: the earlier attempt may already have effects. Inspect
`original_message_ids`, `affected_item_ids` and `original_domain_result` with the
read commands, do not repeat its mutations, and publish only the missing
`input_result` for this new `attempt_id`, citing the verified original replies.
