# Data, command, and answer contracts

These are implementation contracts. Examples below specify the intended CLI; they are not commands available today.

## Session schema v1

| Entity | Required fields and semantics |
| --- | --- |
| Session | `schema_version: 1`, `id`, `project_id`, `title`, `revision`, `created_at`, `updated_at`, `topics`, `items`, `messages`, `answers`, `consumers`, `operation_receipts` |
| Topic | `id`, `name`, `order`, `created_at`; exists in one session |
| Item | `id`, `topic_id`, `parent: null\|id`, `question`, `type`, `status`, `owner`, `created_at`, `updated_at`, `revision`, `created_in_message`, `updated_in_messages`, `links`, `options`, `status_history` |
| Conditional item fields | `outcome`, `why` for terminal states; `replaced_by` for replaced; `waiting_since` and `recipient_consumer_id` for waiting; `last_answer_seq` when answered |
| Owner | Tagged value `me`, `agent` with consumer ID, or `other` with display name; ownership is independent of who created an item |
| Option | Stable item-local `id`, `label`, `consequence`, `recommended: boolean` |
| Link | `kind: pr\|file\|doc`, `label`, `target` (display/copy only in v1) |
| Message | Monotonic `number`, `author: me\|agent`, optional `consumer_id`, `timestamp`, `excerpt`, `items_touched` |
| Answer | Monotonic `seq`, UUID `id`, `item_id`, `question_revision`, copied question/options, `selected_option_id?`, `text?`, `recipient_consumer_id`, `created_at`, `message_number`, `supersedes_answer_id?` |
| Consumer | `id`, `agent: claude\|codex`, host session identifier, optional human label, `created_at`, `last_seen_at`, issued and acknowledged answer sequences |
| Status history entry | Previous/new status, time, message number, previous outcome/why when applicable; immutable |
| Operation receipt | Client operation key, canonical input digest, resulting IDs/revision; persistent for the session lifetime |

All timestamps are RFC 3339 UTC; UI renders local time. Session revision gives total transaction order; message number gives provenance order; answer sequence gives delivery order. Timestamp ties never determine correctness. Item IDs are hierarchical agent references, not filesystem paths. An answer requires a valid selected option, nonempty text, or both. When both exist, preserve and deliver both explicitly; the text supplements the choice rather than silently replacing it.

The first schema needs no migration from the prototype's JavaScript data. Build the canonical demo with the same core commands used by the CLI. Produce a validated complete JSON fixture and generated schema in M1.

## Status transitions

| Current | Allowed next state | Required evidence |
| --- | --- | --- |
| open | waiting_on_me / in_progress / decided / done / dropped / replaced | Waiting recipient; terminal outcome/why; replacement target where relevant |
| waiting_on_me | in_progress through answer submission | Owner answer and provenance message atomically recorded |
| waiting_on_me | open / decided / done / dropped / replaced through agent action | Agent message explaining withdrawal/resolution; no unincorporated owner answer |
| in_progress | open / waiting_on_me / decided / done / dropped / replaced | Agent message and required state fields |
| decided / done / dropped | open via explicit `reopen` | Reason and a new message; preserve prior terminal outcome in history |
| replaced | no direct reopening | Follow its replacement or create a new follow-up item |

`decided` records a settled choice; `done` records completed work or an explanation. Type does not force status, although CLI help should suggest useful combinations. Reopening clears the current terminal outcome only after copying it to history. A new question needing different options is a new child or an explicit return to waiting with a revised question; changing the meaning of a previously decided item without history is rejected.

## Command surface

Global flags: `--project PATH`, `--session ID`, `--consumer ID`, `--json`. Mutations accept `--op-id UUID` for safe retries. Complex input uses a JSON object on stdin or a file; never require shell-escaped nested JSON as the primary interface.

| Command family | Contract |
| --- | --- |
| `project list`, `project register PATH` | Known roots and registration; no whole-disk discovery |
| `session new --title TEXT`, `session list`, `session show ID` | Session lifecycle and summary |
| `session use ID` | Sets terminal convenience default in project metadata; does not rebind existing agent consumers |
| `session bind --agent claude\|codex --host-session ID` | Returns a stable consumer/session association; `--session` can explicitly attach to an existing session |
| `topic add --name TEXT` | Creates named top-level grouping |
| `item add --topic ID [--parent ID] --question TEXT --type TYPE` | Creates item; accepts owner/status/options/recipient via input JSON |
| `item update ID`, `item reopen ID --why TEXT` | Validated field patch or explicit reopen; revisions supported |
| `item close ID --status decided\|done --outcome TEXT --why TEXT` | Closes with a readable result and reasoning |
| `item drop ID --outcome TEXT --why TEXT` | Records deliberate abandonment |
| `item replace ID --with NEW_ID --outcome TEXT --why TEXT` | Sets a validated replacement; batch form can create its target atomically |
| `item list [--status ...] [--owner ...] [--topic ...]`, `item show ID` | Queries; `--open` includes all three nonterminal statuses; `--waiting` means waiting_on_me only |
| `message add --excerpt TEXT --items ID,...` | Adds provenance; author defaults to current agent consumer |
| `apply --input FILE` or `apply --stdin` | One atomic message plus multiple item operations, using local refs for new IDs |
| `answer submit ITEM --input FILE`, `answer fetch`, `answer ack --ids ID,...` | Shared UI/CLI answer protocol; fetch is non-destructive |
| `hook claude`, `hook codex` | Read host JSON on stdin; emit only host-compatible context output on stdout |
| `setup --agent claude\|codex\|both [--global] [--dry-run]` | Install owned integration resources and print exact changes |
| `uninstall [--agent ...] [--global] [--dry-run]` | Reverse integration changes; preserve session history |
| `demo [--project PATH]`, `open [--item ID]` | Seed isolated demo, open/focus app |
| `doctor`, `session validate ID`, `session repair ID --from-backup` | Diagnose store/discovery/integration; deliberate backup recovery |

Simple item mutations take `--message NUMBER` or `--excerpt TEXT`. If no message is supplied, the CLI creates a truthful operation excerpt from the provided item text, rather than leaving provenance missing. `message add` deduplicates touched IDs and updates backlinks. `apply` is the preferred agent path: one call per meaningful reply instead of one process per field.

Example batch:

```json
{
  "op_id": "0e3534dc-6db6-4b0c-9250-f0c0f8621e40",
  "message": {"author": "agent", "excerpt": "I need your choice before removing the duplicate instruction."},
  "operations": [
    {
      "op": "item.add",
      "ref": "duplicate-rule",
      "topic_id": "t2",
      "question": "Should we keep the sub-agent rule only in AGENTS.md?",
      "type": "question",
      "status": "waiting_on_me",
      "owner": {"kind": "me"},
      "recipient_consumer_id": "c1",
      "options": [
        {"id": "only-agents", "label": "Keep it only in AGENTS.md", "consequence": "Remove the duplicated rule from CLAUDE.md.", "recommended": true},
        {"id": "both", "label": "Keep both copies", "consequence": "Leave both instruction files as they are.", "recommended": false}
      ]
    }
  ]
}
```

Each batch is all-or-nothing, with a receipt mapping `ref` to allocated ID. A retry with the same operation ID returns the same mapping without adding another message.

Default stdout is compact line-oriented text: predictable verb/IDs/status plus escaped one-line text, no ANSI unless interactive and explicitly enabled. Empty query: no item lines. With `--json`, stdout is one JSON object (`api_version`, `ok`, `data`, optional `warnings`) even on errors; failures use `{code,message,hint,details}` under `error`. Diagnostic logging goes to stderr. IDs/enum fields are stable; human prose is not a machine contract.

Exit codes: `0` success, `2` usage/validation, `3` unknown project/session/item, `4` conflict or store busy, `5` I/O/corruption/unsupported schema, `6` integration/install failure. Include field paths and corrective examples. A no-answer fetch succeeds with an empty array. Hook adapters deliberately translate internal errors into non-blocking host behavior; they do not reuse ordinary CLI exit codes blindly.

## Session and recipient resolution

An Ariadne session represents one working conversation by default. A host's stable session ID binds to exactly one Ariadne session and one consumer for that project. Resuming the same host session reuses it; a new conversation creates a new Ariadne session unless explicitly attached. UI tab selection never changes this routing. Binding lookup is project-local, with a lock around creation so duplicate hook calls cannot create duplicate sessions.

For ordinary terminal commands: explicit session wins, then explicit consumer binding, then project convenience default, then the only session if there is exactly one. If several sessions exist with no unambiguous choice, fail and list the choices; never pick “most recently modified.” Agent rules always use the returned session and consumer IDs explicitly. Hooks receive the host session identifier and working directory; they do not inspect private transcript formats.

Each waiting item has one recipient consumer. Two agents may share a session when explicitly bound, but their answer queues remain distinct. Transferring answers between agents or continuing a topic into another session is not automatic in v1. A stopped agent's answers stay queued for its bound conversation; the UI states this plainly.

## Answer delivery: at least once, explicit receipt

```mermaid
sequenceDiagram
    participant U as Owner / app
    participant S as Shared store
    participant H as Turn-start hook
    participant A as Coding agent
    U->>S: Submit answer + expected item revision + operation ID
    S-->>U: Saved answer ID; item in progress
    H->>S: Fetch unacknowledged answers for bound consumer
    S-->>H: Ordered answers and stable IDs
    H-->>A: Inject attributed question + answer context
    A->>S: Acknowledge exact answer IDs after reading
    A->>S: Apply resulting changes + message + outcome/why
```

Fetching does **not** advance a destructive cursor. Until acknowledged, an answer may appear again on a subsequent fetch; this is deliberate protection against hook failure, process termination, or context delivery failure. `answer ack` is idempotent and records that the agent received the answer, not that the requested work completed. Repeated answers carry the same ID so the agent can recognize them. Successive fetches after acknowledgment return only newer/unacknowledged answers, satisfying “since last fetch” without a silent loss window.

Fetch pages by sequence with an explicit continuation token, maximum 50 answers and 16 KiB returned content per hook payload. If a single answer plus context does not fit, emit its ID and a command to fetch it in full; do not acknowledge or pretend a preview is complete. Host rules must finish fetching pending pages before proceeding with dependent work. A fetch records the fully returned answer IDs in the consumer's issued set under the store lock before emitting output; issuance does not remove them from pending. Acknowledgment checks consumer ownership and issued answer IDs; acknowledgments cannot skip unseen future IDs. The CLI's explicit single-answer/full-page fetch may use a larger documented output bound than hook injection.

Submitting records an owner message, the answer, the change to `in_progress`, and owner `agent` with the designated consumer in one commit. A correction appends a new sequence and points to the prior answer. An answer already acknowledged remains immutable. The agent includes `handled_through_answer_seq` when closing an answered item; if a newer answer exists, reject closure and ask it to fetch again. The UI can therefore distinguish **Saved**, **Awaiting agent**, **Received**, and **Resolved** without claiming that file delivery equals task completion. A plain `in_progress` status created by answer submission does not justify “Agent is working” copy; that requires a subsequent agent-authored progress message.
