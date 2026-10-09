## Commands

`ariadne` is the exact connect/setup command, including `ARIADNE_HOME=...` and
absolute path. Use only the CLI for state. Never access `.ariadne/` or
`~/.ariadne` files: bypassing validation can make the session unreadable.

- `ariadne read --binding B --generation G --view items|topics|messages|inputs --json`:
  20 entries a page, `--limit N` up to 100. `--view items --topic <id|number>`
  reads one topic; add `--archived` for an archived one.
- `ariadne item messages|rounds --binding B --generation G --item ID --json`:
  one item's full history.
- `ariadne apply --binding B --generation G --json-stdin --json`: one request on
  stdin (use a quoted heredoc). `--dry-run` validates without committing. The
  receipt lists `op_id`, and each changed topic/item's `id`, `short` label,
  new `revision` and `created` flag (topics also have a `number`).

An unexpected `"replayed":true` files nothing new; use a fresh explicit `op_id` to deliberately file the identical request again.

Read topics/items; no context is pushed. Reuse what fits.

## Request

One JSON object on stdin. Only `operations` is required.

| Field | Meaning |
|---|---|
| `op_id` | Optional: derived from binding and request, independent of generation. Explicit: lowercase UUIDv4 (`errors.md`) |
| `expected_item_revisions`, `expected_topic_revisions` | `{"1":4}`: current revision of every existing item/topic touched, including parents of new children; unnecessary for items created in this request |
| `summary` | Optional; one short line shown in the timeline of every item touched |
| `source_input_id`, `attempt_id`, `input_result` | Optional; only to answer a dispatched input (`inputs.md`) |

Reuse receipt revisions and item numbers as `{"id":...}`. Omit optional fields.

Set `related` only when a connection helps the owner: a point depends on,
duplicates or follows from another. Omit it by default; declare it once on either
item, across topics in this session. In prose use `[label](item:3.2)`, never bare
item numbers: clickable prose links do not create `related` connections.

| `op` | Required | Optional |
|---|---|---|
| `topic.add` | `name` | `short`, `ref` |
| `item.add` | `question`, `type` | `topic` (the only `topic.add`; children inherit their parent's topic), `short`, `status`, `ack_to`, `owner`, `ask`, `options`, `parent`, `note`, `links`, `related`, `outcome`, `why`, `children`, `ref` |
| `item.edit` | `item`, `patch` | patch: `question`, `type`, `note`, `links`, `related`, `short`, `ack_to` (on an Open/InProgress Ack item) |
| `item.ask` | `item`, `ask` | `options` |
| `item.status` | `item`, `status` | `ack_to`, `outcome`, `why`, `reason` |
| `item.replace` | `item`, `replacement`, `outcome`, `why` | |
| `reply` | `item`, `text` | `ref`, `round_id` |
| `round.close` | `round_id` | |

Set `topic` explicitly if neither default applies.
For defaults, refs and transitions, read `errors.md`.

Give new topics/items a stable `short` label: a 2-4 word tree title,
at most 40 characters ("Notes sync review").

Text is markdown; topic names, `short` and option labels are plain text.

## Shape the work

When connected, organise the work in Ariadne.

- **File as you go.** Start with a topic and an `in_progress` summary. Update
  items in place (`item.edit` note, `item.status`, `reply`). Finish the summary
  with `item.status` `open` and `ack_to`, result and evidence. Never wait until
  the end or post the same report twice.
- **Route.** File findings and multi-point results. Chat is 1-3 lines pointing
  at the topic. Owner instructions win.
- **Topic.** One per concern (PR, test run, incident, plan), not per step.
- **Tree.** Summary first: result and what waits on the owner; then whole-work
  decisions and sections in reading order. Points are children; sub-points nest.
  Each point the owner may act on appears once, with its ask.
- **Type and status** say what the owner has to do. Never create an item
  `decided`, `done`, `dropped` or `replaced`; new results start `open` for Ack.

| The point is | Type | New status / Ack target |
|---|---|---|
| A decision only the owner can make | decision or question | `waiting_on_me`: set `ask` |
| A nonblocking question | question | `open` |
| A decision you already took, now finished | decision | `open`, `ack_to: "decided"` |
| A finding still being investigated | finding | `open`, `ack_to: "open"` |
| An explanation of work still running | explanation | `open`, `ack_to: "in_progress"` |
| A finished result, once read | finding, explanation or task | `open`, `ack_to: "done"` |
| Work you are doing now | task | `in_progress`, with a `note` |
| Work for later or someone else | task | `open`, owner `other` |
| Something you will not do | any | `open`, `ack_to: "dropped"` |

- **Ack.** Choose `ack_to`: `open` for reading while work continues,
  `in_progress` if underway, `done`/`decided` only if finished once read,
  `dropped` if ruled out. Type alone never chooses it. New findings/explanations
  without an ask require it: strict filing says "choose ack_to ..."; the CLI
  reports a repair using the current `open` or `in_progress` status.
  New Open/InProgress items need `ack_to` for `outcome` or `why`.
  Ack clears it, sets that status and sends no input. Change an Open/InProgress
  Ack choice with `item.edit.patch.ack_to`, preserving status and prose.
  Keep it open for reading; owner-directed completion and replacement exceptions
  are in `errors.md`. Ack waits for unanswered asks; keep them
  `waiting_on_me`. Permission to act needs a real ask and a "Got it, go ahead"
  option. Finished progress tasks also await Ack.
- **Fields.** `question`: one-sentence heading; `ask` and `options`: answer box;
  `outcome` and `why`: result and evidence; `note`: progress line;
  `links`: `pr`, `file` or `doc` targets; `reply`: owner answer or long detail.
  Do not repeat text.
- **Ask.** One decision per item: set `ask` (and `options`) on the `item.add`; it
  starts `waiting_on_me`, owned by the owner, with one round. Give options with a
  `label` and a `consequence` each and at most one `recommended`; no `options`
  leaves a free-text answer. A question you would write in prose is an ask, never
  a sentence in chat. `item.ask` asks on an item that already exists, and
  another question on the same decision is a new ask round on that item.
- **Proposals** (comments to post, fixes to apply): one child each with its own
  `ask` and options. The parent is a summary with no ask. Never file them `done`
  under one blanket ask on the parent.
- **Choice notes.** Free text overrides the option's consequence; ask there if
  ambiguous and reflect the note in the input result (`inputs.md`).
- **Ripple updates.** After an owner answer or reply, check other items across
  topics for wrong outcomes, moot questions or needed follow-ups. Update affected
  items together where possible, naming each in the input result as
  `[label](item:<id>)`. Never silently reverse an owner decision on another item:
  raise a new ask on that item instead. Leave unrelated items alone.
- **Spend few tokens.** One request per result, nested `children`. Data nobody
  discusses row by row is one item with a table.

## Examples

Start a topic with an in-progress summary and finding:

```json
{"summary":"Started the retry review","operations":[{"op":"topic.add","name":"Review: notes sync retries","short":"Notes sync review"},{"op":"item.add","question":"Notes sync retry review","short":"Review summary","type":"task","status":"in_progress","note":"Reading the diff","children":[{"question":"Backoff has no jitter","short":"No jitter","type":"finding","status":"open","ack_to":"open","outcome":"Clients retry in lockstep","why":"The delay is fixed at 2s."}]}]}
```

Reading leaves the finding and summary Open while the fix is tracked. File the
report using receipt revision 3:

```json
{"expected_item_revisions":{"1":3},"operations":[{"op":"item.status","item":{"id":"1"},"status":"open","ack_to":"open","reason":"Review ready to read","outcome":"Notes sync needs one fix","why":"See [no jitter](item:1.1)."}]}
```
