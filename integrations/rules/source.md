## Commands

`ariadne` is the exact connect/setup command, including `ARIADNE_HOME=...` and
absolute path. Use only the CLI. Never access `.ariadne/` or `~/.ariadne` files:
this bypasses validation and can make the session unreadable.

- `ariadne read --binding B --generation G --view items|topics|messages|inputs --json`:
  20/page, `--limit N` up to 100; `--view items --topic <id|number>`
  for one topic, `--archived` for an archived one.
- `ariadne item messages|rounds|changes --binding B --generation G --item ID --json`:
  one item's history.
- `ariadne apply --binding B --generation G --json-stdin --json`: stdin (quoted
  heredoc); `--dry-run` validates without saving. Receipts list
  `op_id` and changed topic/item `id`, `short`, `revision`, `created`; topics have `number`.

`--json` puts warnings in JSON only; they never change saved work.

Unexpected `"replayed":true` files nothing new; use a fresh explicit `op_id` to file the same request again.

## Request

One JSON object; `operations` is required.

| Field | Meaning |
|---|---|
| `op_id` | Derived from binding/request, independent of generation; explicit: lowercase UUIDv4 (`errors.md`) |
| `expected_item_revisions`, `expected_topic_revisions` | `{"1":4}`: current revision of existing items/topics touched, including new children's parents; omit for new items |
| `summary` | One short line in each touched item's timeline |
| `source_input_id`, `attempt_id`, `input_result` | Only for dispatched inputs (`inputs.md`) |

Reuse receipt revisions/numbers as `{"id":...}`.

| `op` | Required | Optional |
|---|---|---|
| `topic.add` | `name` | `short,brief,ref` |
| `topic.edit` | `topic` | `name,short,brief` |
| `item.add` | `question,type` | `topic` (the only `topic.add`; children inherit their parent's topic), `short,status,ack_to,owner,ask,options,parent,note,links,related,affects,depends_on,outcome,why,children,ref` |
| `item.edit` | `item,patch` | `reason,wording_only`; patch: `question,type,note,links,related,affects,depends_on,short,ack_to` (Open/InProgress Ack) |
| `item.ask` | `item,ask` | `options` |
| `item.status` | `item,status` | `ack_to,outcome,why,reason` |
| `item.replace` | `item,replacement,outcome,why` | |
| `item.delete` | `item` | |
| `topic.delete` | `topic` | |
| `reply` | `item,text` | `ref,round_id` |
| `round.close` | `round_id` | |

Set `topic` if neither default applies.
Defaults, children, refs, transitions, limits: `errors.md`.

Delete accepts number/UUID strings, `{id}`, earlier batch refs or `{ref}`.
Guard the existing root item/topic; history stays.

New topics/items need stable `short`: 2–4 words, at most 40 characters.

Markdown text; plain topic names, `short`, option labels.

## Shape the work

Owner instructions win; apply these rules while connected or told "use Ariadne".

1. **Keep only useful work.** File decisions, risks and results the owner needs.
   Otherwise use chat. Put routine lists the owner needs in one
   checklist; split only for independent discussion/tracking. Chat points to
   filed work in 1–3 lines.
2. **One point, one place.** Update the existing item instead of repeating it in
   reports/follow-ups. Answering a point once settles it everywhere. Merge
   duplicates with `item.replace`; children need independent usefulness.
3. **Topics are owner actions.** Name the owner action plainly, without
   codes/ticket numbers. `topic.edit` keeps a 2–3 sentence `brief`: where
   things stand and what it means. Do not repeat Ariadne's decided/waiting/replaced
   lists or add a summary item.
4. **Make questions easy to answer.** In this order: the decision in plain words;
   "I recommend X (fairly sure / not sure) because Y; if that's wrong, Z";
   2–3 real options with a consequence each; "If you don't answer, I'll …";
   named affected items and `affects`. Mark the
   recommendation `recommended`; include "Not now"/"Neither" when real.
   Put questions in Ariadne; no options means free text.
5. **Ask only what needs the owner.** Explore the code and evidence before asking,
   ask scope up front before building if it is not already settled, and keep
   at most three questions `waiting_on_me` at once. Continue independent work;
   no-answer defaults respect permissions and never assume consent.
6. **Layer the explanation.** Use a clear `question` title, bottom line first,
   "What this means for you", then details. Define every
   term on first use; keep paragraphs to three sentences or fewer.
7. **Name connections.** Write `[retry cap](item:3.2)`, never bare item numbers.
   Prose links need receipt item numbers; use batch refs in `affects`/`depends_on`/`related` for new items, then add prose links.
   Use `affects` for consequences, `depends_on` for prerequisites, `related`
   for other useful connections. Prose links alone declare nothing;
   leave unrelated items alone.
8. **Carry answers through.** After an owner answer, update every affected item
   across topics in one request, with a one-line `reason` per edit/status change
   and useful `affects`/`depends_on`. Pure rewording uses
   `item.edit` with `wording_only: true` (only `question`, `short`, `note`).
   For free text, start `input_result.explanation` with "Read as: …" and name
   affected items. Ask before reversing an owner decision elsewhere; ambiguity
   becomes a question on the item (`inputs.md`).
9. **Leave results for Ack.** New results start `open` with a deliberate `ack_to`,
   result/evidence; never create `decided`, `done`, `dropped` or `replaced`.
   Keep unanswered asks `waiting_on_me`.

| Point | Type | New status / Ack choice |
|---|---|---|
| Only the owner can decide | decision or question | `waiting_on_me`: set `ask` |
| Nonblocking question | question | `open` |
| Your finished decision | decision | `open`, `ack_to: "decided"` |
| Finding under investigation | finding | `open`, `ack_to: "open"` |
| Work still running | explanation | `open`, `ack_to: "in_progress"` |
| Finished result, once read | finding, explanation or task | `open`, `ack_to: "done"` |
| Work you are doing now | task | `in_progress`, with a `note` |
| Work for later or someone else | task | `open`, owner `other` |
| Something you will not do | any | `open`, `ack_to: "dropped"` |

**Ack:** type never chooses it. Findings/explanations without asks and
Open/InProgress results need `ack_to`; Ack sets its target and sends no input.
`item.edit.patch.ack_to` changes that choice without changing prose/status.
Finished tasks await Ack. Strict validation, CLI repairs and exceptions: `errors.md`.

**Fields:** `ask`/`options`: answer box (`label`, `consequence`, at most one
`recommended`); `item.ask`: new round. `outcome`/`why`: result/evidence; `note`:
progress; `links`: `pr`, `file`, `doc`; `reply`: detail. Permission needs an ask
with "Got it, go ahead".

**Delete:** remove clearly wrong/duplicate/obsolete work you created or the
owner asks to delete; prefer Drop/Replace for real work. Explain with `reply`
before item deletion; for empty topics, use a live item or chat. Owner requests
include `input_result` in that request (`inputs.md`). Reads omit Bin work with
a notice; owner Restore: `errors.md`.

## Examples

A brief replaces summary items; related checks stay together.

```json
{"summary":"Reviewed retry safety","operations":[{"op":"topic.add","ref":"review","name":"Choose safe retry behavior","short":"Retry behavior"},{"op":"topic.edit","topic":{"ref":"review"},"brief":"The retry cap and error handling pass their checks. We can focus the remaining work on retry timing."},{"op":"item.add","question":"Retry checks pass","short":"Retry checks","type":"finding","status":"open","ack_to":"done","outcome":"The cap and error handling work. What this means for you: the remaining change can stay small.","why":"- Retry cap tested\n- Original error preserved"}]}
```

Delete a duplicate at revision 3, explaining first:

```json
{"expected_item_revisions":{"1":3},"operations":[{"op":"reply","item":{"id":"1"},"text":"Deleted this duplicate; [retry checks](item:2) remains."},{"op":"item.delete","item":{"id":"1"}},{"op":"topic.add","ref":"empty","name":"Remove duplicate work","short":"Duplicate cleanup"},{"op":"topic.delete","topic":{"ref":"empty"}}]}
```
