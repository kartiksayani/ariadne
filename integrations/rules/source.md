## Commands

`ariadne` means the exact setup command, including `ARIADNE_HOME=...` and its
absolute path. Use only the CLI; never access `.ariadne/` files directly.

- `ariadne read --binding B --generation G --view items|topics|messages|inputs --json`:
  20 entries a page, `--limit N` up to 100. `--view items --topic <id|number>`
  reads one topic; add `--archived` for an archived one.
- `ariadne item messages|rounds --binding B --generation G --item ID --json`:
  one item's full history.
- `ariadne apply --binding B --generation G --json-stdin --json`: one request on
  stdin (quoted heredoc). `--dry-run` validates without committing. Receipts list
  `op_id` and changed topic/item `id`, `short`, `revision`, `created`; topics have `number`.

An unexpected `"replayed":true` files nothing new; use a fresh explicit `op_id` to deliberately file the identical request again.

## Request

One JSON object; `operations` is required.

| Field | Meaning |
|---|---|
| `op_id` | Optional: derived from binding and request, independent of generation. Explicit: lowercase UUIDv4 (`errors.md`) |
| `expected_item_revisions`, `expected_topic_revisions` | `{"1":4}`: current revision of every existing item/topic touched, including parents of new children; unnecessary for items created in this request |
| `summary` | Optional; one short line shown in the timeline of every item touched |
| `source_input_id`, `attempt_id`, `input_result` | Optional; only to answer a dispatched input (`inputs.md`) |

Reuse receipt revisions and numbers as `{"id":...}`.

Set `related` for useful dependencies, duplicates or consequences, once on either
item in this session; otherwise omit it.
In prose use `[label](item:3.2)`, never bare numbers: clickable prose links do not create `related` connections.

| `op` | Required | Optional |
|---|---|---|
| `topic.add` | `name` | `short`, `ref` |
| `item.add` | `question`, `type` | `topic` (the only `topic.add`; children inherit their parent's topic), `short`, `status`, `ack_to`, `owner`, `ask`, `options`, `parent`, `note`, `links`, `related`, `outcome`, `why`, `children`, `ref` |
| `item.edit` | `item`, `patch` | patch: `question`, `type`, `note`, `links`, `related`, `short` |
| `item.ask` | `item`, `ask` | `options` |
| `item.status` | `item`, `status` | `ack_to`, `outcome`, `why`, `reason` |
| `item.replace` | `item`, `replacement`, `outcome`, `why` | |
| `item.delete` | `item` | |
| `topic.delete` | `topic` | |
| `reply` | `item`, `text` | `ref`, `round_id` |
| `round.close` | `round_id` | |

Set `topic` explicitly if neither default applies.
Read `errors.md` for defaults, children, refs, transitions or limits.

Delete refs accept number/UUID strings or `{id}` and earlier batch refs or `{ref}`.
Guard the existing root item or topic; history stays in Bin.

Give new topics/items a stable `short` label: 2-4 words, at most 40 characters
("Notes sync review").

Text is markdown; topic names, `short` and option labels are plain text.

## Shape the work

When connected or told "use Ariadne", file work there.

- **File as you go.** Start a topic with an `in_progress` summary; update items
  in place. Finish `open` with `ack_to`, result and evidence. Never repeat a report.
- **Route.** File results over a few lines or with multiple points, including
  findings. Chat is 1-3 lines pointing at the topic. Owner instructions win.
- **Topic.** One per concern, not per step.
- **Tree.** Summary first: result and what waits on the owner. Then decisions
  and sections in reading order; points are children, each once with its ask.
  Keep this tree for later writes.
- **Type and status** say what the owner has to do. Never create an item
  `decided`, `done`, `dropped` or `replaced`; new results start `open` for Ack.

| The point is | Type | New status / Ack target |
|---|---|---|
| A decision only the owner can make | decision or question | `waiting_on_me`: set `ask` |
| A nonblocking question | question | `open` |
| A decision you already took | decision | `open`, `ack_to: "decided"` |
| Something you established | finding | `open`, `ack_to: "done"` |
| Something the owner should understand | explanation | `open`, `ack_to: "done"` |
| Work you are doing now | task | `in_progress`, with a `note` |
| Work for later or someone else | task | `open`, owner `other` |
| Something you will not do | any | `open`, `ack_to: "dropped"` |

- **Ack.** Finish results and progress tasks `open` with `ack_to`. Owner Ack
  needs no delivery and waits for any owner answer. Keep the target unless an
  Answer, Reply or Drop input on that item directs completion; terminal
  `item.status` with `source_input_id` then clears it. Other existing work closes
  normally; superseded work uses `item.replace`. Keep unanswered asks
  `waiting_on_me`; explain withdrawal with a new `ack_to: "dropped"` item.
  Permission needs an ask and a "Got it, go ahead" option.
- **Fields.** `question`: heading; `ask`/`options`: answer box; `outcome`/`why`:
  result/evidence; `note`: progress; `links`: `pr`, `file`, `doc`; `reply`: detail.
- **Ask.** One decision per item: `item.add` with `ask` starts `waiting_on_me`,
  owned by the owner. Each option needs `label` and `consequence`; at most one
  is `recommended`. Without options the answer is free text. Ask questions
  there, not in chat. `item.ask` starts another round on an existing item.
- **Proposals**: one child each with its own
  `ask` and options. The parent is a summary with no ask. Never file them `done`
  under one blanket ask on the parent.
- **Choice notes.** Free text overrides the option's consequence; ask there if
  ambiguous and reflect the note in the input result (`inputs.md`).
- **Ripple updates.** After an owner answer/reply, update affected items across
  topics together, naming each as `[label](item:<id>)` in the input result.
  Ask before reversing an owner decision elsewhere. Leave unrelated work alone.
- **Spend few tokens.** One request per result, nested `children`. Data nobody
  discusses row by row is one item with a table.
- **Delete.** Delete clearly wrong, duplicate or obsolete work you created, or
  work the owner asks to delete. Prefer Drop/Replace for real work no longer
  needed. Briefly explain what and why: `reply` before deleting an item; for an
  empty topic, explain in your next reply on another live item or in turn text.
  Include `input_result` in the same request when you delete because the owner
  asked (`inputs.md`).
  Reads omit Bin work with a notice; the owner can restore it (`errors.md`).

## Examples

Open a topic with an in-progress summary item and a finding under it:

```json
{"summary":"Started the retry review","operations":[{"op":"topic.add","name":"Review: notes sync retries","short":"Notes sync review"},{"op":"item.add","question":"Notes sync retry review","short":"Review summary","type":"task","status":"in_progress","note":"Reading the diff","children":[{"question":"Backoff has no jitter","short":"No jitter","type":"finding","status":"open","ack_to":"done","outcome":"Clients retry in lockstep","why":"The delay is fixed at 2s."}]}]}
```

Finish [review summary](item:1) for Ack, using receipt revision 3:

```json
{"expected_item_revisions":{"1":3},"operations":[{"op":"item.status","item":{"id":"1"},"status":"open","ack_to":"done","reason":"Review ready to read","outcome":"Notes sync needs one fix","why":"See [no jitter](item:1.1)."}]}
```

Delete an accidental duplicate, explaining why first:

```json
{"operations":[{"op":"topic.add","name":"Duplicate review","short":"Duplicate review","ref":"t"},{"op":"item.add","ref":"i","short":"Duplicate item","question":"Duplicate review summary","type":"finding"},{"op":"reply","item":{"ref":"i"},"text":"Deleted duplicate work; the original review is filed."},{"op":"item.delete","item":"i"},{"op":"topic.delete","topic":"t"}]}
```

Delete an existing duplicate at revision 3:

```json
{"expected_item_revisions":{"1":3},"operations":[{"op":"reply","item":{"id":"1"},"text":"Deleted this duplicate; the original remains."},{"op":"item.delete","item":{"id":"1"}}]}
```
