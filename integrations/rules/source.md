## Commands

`ariadne` means the exact connect/setup command: keep its `ARIADNE_HOME=...`
prefix and absolute path; your shell may lack them. Use only the CLI for Ariadne
state. Never open, edit or create `.ariadne/` or `~/.ariadne` files: bypassing
revisions and validation can make the session unreadable.

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

Ariadne never pushes context: read the topics and items and reuse the ones that
fit.

## Request

One JSON object on stdin. Only `operations` is required.

| Field | Meaning |
|---|---|
| `op_id` | Optional: derived from binding and request, independent of generation. Explicit: lowercase UUIDv4 (`errors.md`) |
| `expected_item_revisions`, `expected_topic_revisions` | `{"1":4}`: the current revision of each existing item or topic the request replies to, edits, asks, closes or adds a child under. Not needed for what the same request creates |
| `summary` | Optional; one short line shown in the timeline of every item touched |
| `source_input_id`, `attempt_id`, `input_result` | Optional; only to answer a dispatched input (`inputs.md`) |

Reuse receipt revisions for your next request. An item's `id` is its number, used
in `{"id":...}`. Omit optional operation fields.

Refer to another item only as a markdown link `[short label](item:<item id>)`,
for example `[cache choice](item:3.2)`; never use a bare item number such as
"item 3.2" or "#3.2". The app turns `item:` links into clickable navigation.

| `op` | Required | Optional |
|---|---|---|
| `topic.add` | `name` | `short`, `ref` |
| `item.add` | `question`, `type` | `topic` (the request's only `topic.add`; nested `children` inherit their parent's topic), `short`, `status`, `owner`, `ask`, `options`, `parent`, `note`, `links`, `outcome`, `why`, `children`, `ref` |
| `item.edit` | `item`, `patch` | patch: `question`, `type`, `note`, `links`, `short` |
| `item.ask` | `item`, `ask` | `options` |
| `item.status` | `item`, `status` | `outcome`, `why`, `reason` |
| `item.replace` | `item`, `replacement`, `outcome`, `why` | |
| `reply` | `item`, `text` | `ref`, `round_id` |
| `round.close` | `round_id` | |

Set `topic` explicitly if neither default applies.
For other defaults, nested children, reference syntax, transitions and field limits,
read `errors.md` when preparing an unfamiliar request.

Every topic and item you create gets a `short` label: a 2-4 word noun phrase of
at most 40 characters, such as "SDK cache PR". It is the tree node title; keep
it stable.

Text renders as markdown; topic names, `short` labels and option labels are plain
text.

## Shape the work

When connected, or when the owner says "use Ariadne", organise the work there
yourself; the owner never names topics or items.

- **File as you go.** At the start of a piece of work, open its topic and an
  `in_progress` summary item. Update items in place as the work moves
  (`item.edit` note, `item.status`, `reply`); close each when it finishes. Do not
  file everything at the end, and never post the same report twice.
- **Route.** Results longer than a few lines or with multiple points go into
  Ariadne, findings included. Chat is then 1-3 lines pointing at the topic.
  Explicit owner instructions beat these defaults.
- **Topic.** One per piece of work or concern (a PR, a test run, an incident, a
  plan), named for what and which object; never one per step.
- **Tree.** First a one-line summary item with the result and what waits on the
  owner, then any decision about the whole work, then sections in reading order;
  each point is a child, nested deeper when it has sub-points. One item is one
  thing the owner might decide, comment on or track; the same thing in two
  sections is one item. An ask sits on the point it is about. Apply the same
  shaping to every later write, not only the first.
- **Type and status** say what the owner has to do; `done` is FYI.

| The point is | Type | Status |
|---|---|---|
| A decision only the owner can make | decision or question | `waiting_on_me`: set `ask` |
| A question that does not block you | question | `open` |
| A decision you already took | decision | `decided` |
| Something you established | finding | `done` |
| Something the owner should understand | explanation | `done` |
| Work you are doing now | task | `in_progress`, with a `note` |
| Work for later or someone else | task | `open`, owner `other` |
| Something you will not do | any | `dropped` |

- **Fields.** `question`: one-sentence heading; `ask` and `options`: answer box;
  `outcome` and `why`: closed result and evidence; `note`: progress line;
  `links`: `pr`, `file` or `doc` targets; `reply`: owner answer or long detail.
  Never repeat text across them.
- **Ask.** One decision per item: set `ask` (and `options`) on the `item.add`; it
  starts `waiting_on_me`, owned by the owner, with one round. Give options with a
  `label` and a `consequence` each and at most one `recommended`; no `options`
  leaves a free-text answer. A question you would write in prose is an ask, never
  a sentence in chat. `item.ask` asks on an item that already exists, and
  another question on the same decision is a new ask round on that item.
- **Proposals** (comments to post, fixes to apply): one child each with its own
  `ask` and options. The parent is a summary with no ask. Never file them `done`
  under one blanket ask on the parent.
- **Choice notes.** A choice can carry free text; follow the note even over the
  option's consequence, ask on that item if ambiguous, and reflect it in the
  input result (`inputs.md`).
- **Ripple updates.** After acting on an owner answer or reply, check the session's
  other items in the same topic and other topics for outcomes now wrong, questions
  now moot or follow-ups now needed. Update affected items in the same filing
  where possible, then name each changed item in the input result as
  `[label](item:<id>)`. Never silently reverse an owner decision on another item:
  raise a new ask on that item instead. Leave unrelated items alone.
- **Spend few tokens.** File a result in one request, children nested with
  `children`. Data nobody discusses row by row is one item with a table.

## Examples

[Review summary](item:1) below is a placeholder.

Open a topic with an in-progress summary item and a finding under it:

```json
{"summary":"Started the retry review","operations":[{"op":"topic.add","name":"Review: PR #812 retry backoff","short":"PR #812 review"},{"op":"item.add","question":"Reviewing PR #812; nothing concluded yet","short":"Review summary","type":"task","status":"in_progress","note":"Reading the diff","children":[{"question":"Backoff has no jitter","short":"No jitter","type":"finding","status":"done","outcome":"Clients retry in lockstep","why":"The delay is fixed at 2s."}]}]}
```

Later, finish [review summary](item:1) using receipt revision 3:

```json
{"expected_item_revisions":{"1":3},"operations":[{"op":"item.status","item":{"id":"1"},"status":"done","outcome":"PR #812 needs one fix","why":"See [no jitter](item:1.1)."}]}
```
