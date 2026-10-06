# Ariadne shared agent rules

Use plain sentences. Ariadne holds structured topics, items, questions, full
replies, decisions and retained history; ordinary terminal prose does not update
that state. Read bounded canonical projections using the explicit binding and
generation supplied by setup or the dispatched input. Never infer a session from
cwd, filenames, a previous conversation or a foreign item reference.

Below, `ariadne` stands for the exact CLI invocation named in the setup
instruction. Run it verbatim: your tool shell may not inherit environment
variables or find the helper on PATH, so keep any `ARIADNE_HOME=...` prefix and
the absolute helper path.

Read with `ariadne read --binding B --generation G --view items|topics|messages|inputs --json`
and `ariadne item messages|rounds --binding B --generation G --item ID --json`.
Publish with `ariadne apply --binding B --generation G --json-stdin --json`,
passing one complete ApplyRequest on stdin (use a quoted heredoc). The same
operations exist as MCP tools `session_read`, `item_messages`, `item_rounds` and
`apply` only if the owner configured them; the CLI is the baseline. A malformed
CLI request fails with exit 2 and names the offending field (MCP returns only a
generic message).

Publish substantive findings through `apply`. Each new request gets a fresh
lowercase UUIDv4 `op_id`; for uncertainty see the error table. Only a saved
receipt proves commit. `expected_item_revisions` must give the current
revision of every existing item the request touches (reply, status, ask, edit,
replace, close a round, or a new child's parent); `expected_topic_revisions` does
the same for topics. Only item and topic revisions are guarded.

Words and their wire names: Activity = the request `summary`; Reply = op `reply`
(full text of an item reply, with the useful reasoning and outcome; an Activity is
only a concise shared summary, never a substitute); Ask round = op `item.ask` on
the existing item (another question about the same decision); Child = `item.add`
with `parent` (a different decision). Do not manufacture a parent or round
relationship from proximity. Statuses: `open` and `in_progress` need `reason` and
no outcome/why; `decided`, `done`, `dropped` need `outcome` and `why`; `replaced`
only through `item.replace`; `waiting_on_me` only through `item.ask` or `item.add`
(owner `{"kind":"me"}`). Owners: `{"kind":"me"}`, `{"kind":"agent","binding_id":B}`,
`{"kind":"other","name":"N"}`. `item.ask` sets the item `waiting_on_me` and needs
`recipient_binding_id` = your own binding ID. Item types: question, decision,
finding, task, explanation. Preserve closed outcome history.

References: `{"ref":"a"}` names an earlier `ref` (letter first, letters, digits or
`_`, at most 32) in the same request; `{"id":"1.2"}` is an existing item, or an
existing UUID for a topic or message. Every field shown in the examples is required;
use `null` when unused.

Working method. Whenever this session is connected to Ariadne, and whenever the
owner says "use Ariadne" or similar, organise the task in Ariadne yourself; the
owner never names topics or items. This holds for any task: a review, a bug, a
design, a refactor, research or planning; the task only changes which topics and
item types result. At the start, read the existing topics and items and reuse the
ones that fit. Otherwise create the topics the task needs with `topic.add`: you
choose how many and their names, one per concern area or workstream, never one
per trivial step. As the work proceeds, file each substantive result as an item
under the right topic with a full `reply` carrying the complete reasoning, not a
one-line title: a `finding` for something you established; a `decision` you took
yourself, closed with outcome and why so the owner can see and overturn it; an
`explanation` for something the owner should understand; a `task` for follow-up
work you cannot do now; a `question` only the owner can answer, raised through
`item.ask` with options so it appears under "Waiting on me", never only in the
terminal. Mark an item `in_progress` when you start it and `done`, `decided` or
`dropped` with outcome and why when you finish. File as you go, not in one dump at
the end; do not duplicate an existing item; do not wait for a dispatched input
before filing (without one, `source_input_id`, `attempt_id` and `input_result` are
null). End with a brief terminal summary that points at the topics you created.

For each dispatched Ariadne input (first line `[ARIADNE_INPUT:<input>:<attempt>]`,
then a JSON envelope), copy the envelope `source_input_id` and `attempt_id` into
the request, and commit exactly one `input_result` with outcome `answered`, `deferred` or `unable`, an
explanation, `reply_refs` (your replies), `followup_item_refs` and
`handled_through_message_number` = the envelope `owner_message_number`. Without a
dispatched input, set `source_input_id`, `attempt_id` and `input_result` to null.
Successful host completion alone is not a domain result. A normal terminal summary
may be brief once full replies and the result are committed.

Examples (UUIDs ending in small numbers are placeholders; item `1`, topic `...0005`,
binding `...0003`, input `...0010`, attempt `...0011`):

Reply, decide, answer the input:

```json
{"op_id":"00000000-0000-4000-8000-000000000101","source_input_id":"00000000-0000-4000-8000-000000000010","attempt_id":"00000000-0000-4000-8000-000000000011","expected_item_revisions":{"1":4},"expected_topic_revisions":{},"summary":"Answered item 1","operations":[{"op":"reply","ref":"r1","item":{"id":"1"},"text":"Full answer with reasoning.","round_id":null},{"op":"item.status","item":{"id":"1"},"status":"decided","outcome":"Use X","why":"Because Y","reason":null}],"input_result":{"outcome":"answered","explanation":"Replied and decided.","reply_refs":[{"ref":"r1"}],"followup_item_refs":[],"handled_through_message_number":7}}
```

Add an item and a child of existing item 1, defer the input:

```json
{"op_id":"00000000-0000-4000-8000-000000000102","source_input_id":"00000000-0000-4000-8000-000000000010","attempt_id":"00000000-0000-4000-8000-000000000011","expected_item_revisions":{"1":4},"expected_topic_revisions":{},"summary":"Recorded follow-ups","operations":[{"op":"item.add","ref":"a","topic":{"id":"00000000-0000-4000-8000-000000000005"},"parent":null,"question":"Should we migrate?","type":"decision","status":"open","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":null,"outcome":null,"why":null,"replaced_by":null,"source_round_id":null},{"op":"item.add","ref":"b","topic":{"id":"00000000-0000-4000-8000-000000000005"},"parent":{"id":"1"},"question":"Who reviews it?","type":"task","status":"open","owner":{"kind":"other","name":"Alice"},"ask":null,"options":null,"note":null,"links":null,"outcome":null,"why":null,"replaced_by":null,"source_round_id":null},{"op":"reply","ref":"r1","item":{"ref":"a"},"text":"Recorded for later.","round_id":null}],"input_result":{"outcome":"deferred","explanation":"Recorded follow-up items.","reply_refs":[{"ref":"r1"}],"followup_item_refs":[{"ref":"a"},{"ref":"b"}],"handled_through_message_number":7}}
```

Ask the owner a question on item 1 (new round):

```json
{"op_id":"00000000-0000-4000-8000-000000000103","source_input_id":"00000000-0000-4000-8000-000000000010","attempt_id":"00000000-0000-4000-8000-000000000011","expected_item_revisions":{"1":4},"expected_topic_revisions":{},"summary":"Asked which option","operations":[{"op":"item.ask","item":{"id":"1"},"ask":"Which option?","options":[{"id":"x","label":"X","consequence":"Faster","recommended":true}],"recipient_binding_id":"00000000-0000-4000-8000-000000000003"},{"op":"reply","ref":"r1","item":{"id":"1"},"text":"Blocked on the owner's choice.","round_id":null}],"input_result":{"outcome":"answered","explanation":"Asked the owner.","reply_refs":[{"ref":"r1"}],"followup_item_refs":[],"handled_through_message_number":7}}
```

Cannot do the work (no replies to cite, so `reply_refs` is empty):

```json
{"op_id":"00000000-0000-4000-8000-000000000104","source_input_id":"00000000-0000-4000-8000-000000000010","attempt_id":"00000000-0000-4000-8000-000000000011","expected_item_revisions":{},"expected_topic_revisions":{},"summary":"","operations":[],"input_result":{"outcome":"unable","explanation":"Cannot run the tests here.","reply_refs":[],"followup_item_refs":[],"handled_through_message_number":7}}
```

No dispatched input: start an item, then close an earlier round:

```json
{"op_id":"00000000-0000-4000-8000-000000000105","source_input_id":null,"attempt_id":null,"expected_item_revisions":{"2":3},"expected_topic_revisions":{},"summary":"Started item 2","operations":[{"op":"item.status","item":{"id":"2"},"status":"in_progress","outcome":null,"why":null,"reason":"Started work"},{"op":"round.close","round_id":"00000000-0000-4000-8000-000000000020"}],"input_result":null}
```

No dispatched input: create a topic and file a finding in it with a full reply:

```json
{"op_id":"00000000-0000-4000-8000-000000000106","source_input_id":null,"attempt_id":null,"expected_item_revisions":{},"expected_topic_revisions":{},"summary":"Filed a security finding","operations":[{"op":"topic.add","ref":"t","name":"Security"},{"op":"item.add","ref":"f","topic":{"ref":"t"},"parent":null,"question":"Token is logged on failure","type":"finding","status":"open","owner":{"kind":"agent","binding_id":"00000000-0000-4000-8000-000000000003"},"ask":null,"options":null,"note":null,"links":null,"outcome":null,"why":null,"replaced_by":null,"source_round_id":null},{"op":"reply","ref":"r1","item":{"ref":"f"},"text":"The retry path logs the bearer token at error level. Full reasoning and the fix.","round_id":null}],"input_result":null}
```

Errors. Exit 2 (`invalid_argument`, `invalid_ref`): fix the named field and send a
corrected request with a new `op_id`. Exit 3 conflicts (`revision_conflict`,
`invalid_transition`, `binding_mismatch`, `operation_reused`): reread the items,
rebuild with current revisions and a new `op_id`. Specific codes:

| Code | Exit | Do |
|---|---|---|
| `stale_generation` | 3 | The generation is no longer current. Stop writing for this input; ask the owner for the current setup instruction or a fresh `/ariadne-connect`. Never guess one. |
| `attempt_sealed` | 3 | This input/attempt is closed. Do not retry or invent another attempt; tell the owner. |
| `result_already_committed` | 3 | The result is already saved. Send nothing more for this attempt; only an exact replay is valid. |
| `commit_uncertain`, `store_busy`, `io_error`, or no reply at all (timeout, killed call) | 4 | The save may have happened. Replay the SAME bytes with the SAME `op_id`, at most 3 times, never a new `op_id`. If there is still no receipt, stop and tell the owner; uncertain delivery stays visible and nothing is resent automatically. |
| any other exit 4 (e.g. `capacity_exceeded`, `host_unreachable`) | 4 | Stop and tell the owner; do not retry in a loop. |
| `unsupported`, `future_schema` | 5 | Stop and tell the owner. |

Never resend the owner's message, re-run completed work (including after a
retry), scrape a transcript or infer non-delivery from missing output, presence,
a timeout or a failed persistence receipt.

When the owner explicitly attaches a fresh host conversation to an existing
Ariadne session, read its recorded topics, items, current questions/options,
answers, outcomes and full history before continuing. Reuse existing items and
respect cancelled/skipped inputs and closed or superseded history. This is
structured context, not a transfer of the prior host transcript, private memory
or authority over an old attempt. Use the exact routing IDs returned by the saved
setup receipt or `/ariadne-connect`; attachment does not itself dispatch work.
