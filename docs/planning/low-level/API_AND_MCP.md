# Application APIs, CLI and MCP — v1

All transports invoke the same `Core.execute(actor, Command)` and query service.
Canonical schemas derive from Rust; transport adapters only decode, select actor,
validate the envelope and encode. No raw snapshot replacement API exists.

## 1. Envelope, actors and replay

Mutation input: `{api_version:1,op_id,command,params}`. Agent requests also require
`binding_id,generation`; dispatched work requires `source_input_id,attempt_id`.
UUID operation ID is generated once per deliberate action, retained on retry.
Public success: `{api_version:1,ok:true,data:{operation_id,session_id,revision,...}}`.
Failure: `{api_version:1,ok:false,error:{code,message,hint,retryable,
field_errors:[],current_revision?,details?}}`. Query results use the same envelope.
MCP returns this JSON as structured/text content and sets isError for a domain
failure; protocol failures use the SDK's JSON-RPC error path. Plain CLI prints a
compact sentence/IDs; `--json` is exactly the application envelope.

Actors are owner (desktop/local explicit owner commands), agent (bound domain
CLI/MCP), adapter (internal normalized events) and setup. There is no model-chosen
`actor` parameter. Agent calls cannot pause/skip owner inputs, install adapters,
change root mappings or grant permissions. These are local routing safeguards,
not a security boundary against arbitrary code running as the owner OS account.

Idempotency scope is session + actor binding/owner + op_id. SHA256 digest covers
normalized command, routing and exact content. Same op+digest returns the saved
receipt before revision checks; different digest is `operation_reused`. Pre-session bootstrap uses
`(local_setup,op_id)` in the global registry journal with the same digest rule.
Project registration/binding creation receipts persist there before a session
scope exists, and retain allocated IDs plus completion stage for crash repair.

## 2. Query and owner command inventory

| Command | Parameters | Result / effect |
|---|---|---|
| `project_list` | cursor, limit | registered roots, availability, counts completeness |
| `project_register` | canonical root, op_id | idempotent project UUID + registry receipt |
| `session_list` | project_id?, state?, cursor | summaries, binding/presence observations |
| `session_get` | project_id, session_id | validated full snapshot, revision, freshness |
| `session_read` | binding or owner session ref, view, filters, cursor, limit | bounded items/topics/messages/inputs projection |
| `item_messages` | session ref, item_id, cursor | full owner inputs + explicit replies, ordered number; no shared-summary duplicates |
| `item_rounds` | session ref, item_id, cursor | ask/choices/replies/result/fork projections |
| `binding_connect` | op_id, project_id, adapter_id, external_session_id, endpoint config, existing_session_id? | validated session+binding IDs, generation, capabilities, setup instruction |
| `binding_pause/resume/disconnect` | binding_id, expected_generation, op_id | persisted dispatch state; disconnect does not kill host |
| `input_submit` | session_id, binding_id, item_id or topic_id, kind, text, selected_option_id?, expected_question_revision?, supersedes_answer_id? | atomically owner Message + Answer if applicable + Input; status unchanged |
| `input_cancel` | queued input_id, expected_revision, op_id | only before prepare; preserve message + cancellation record |
| `input_resolve` | input_id, attempt_id, decision (retry_unexecuted/resend/skip/request_result_repair/confirm_evidence), reason, expected_revision, op_id | queue recovery; decisions in queue spec |
| `topic_archive/restore` | topic_id, expected_revision, op_id | lifecycle only; archive guards active items/unresolved inputs |
| `session_close/reopen` | session_id, expected_revision, op_id | close requires dispatch paused, all items terminal and no unresolved inputs; never terminate host |
| `topic_continue_preview` | source session/topic, target session | snapshot revision/hash, mapping preview, full summary, readiness |
| `topic_continue` | source refs/revision/hash, target session/binding, op_id | atomic target copy + input + origin mapping; source untouched |
| `preferences_patch` | expected_preferences_revision, patch | UI-only Later, drafts, theme, rail, tabs, geometry |
| `reveal_item` | registered project/session/item IDs | focus route; no mutation |

`binding_connect` creates a new Ariadne session by default. With
existing_session_id it requires active state, no outstanding input and paused or
disconnected old binding; preserve old binding history. Same host identity returns
its existing binding, not another session. A different second enabled binding
returns `binding_conflict`. Changing the active binding never silently retargets
queued messages. Rebind requires resolving/cancelling old inputs first.

Tauri command names use the snake_case names above; CLI uses nouns/verbs
(`input submit`, `binding connect`, `topic continue`). `apply` uses operation
names with dots below. All commands document `--help` and stdin JSON examples.
`session_get` is local desktop-only; MCP queries use bounded `session_read`.

### Summary projections and command naming

`SummaryCounts={items_by_status:{<seven statuses>:count},waiting_unanswered,
sent_inputs:{queued,in_flight,needs_attention},archived_topics,completeness:
complete|partial,unavailable_session_ids}`. Project/global counts aggregate
accessible registered sessions; task Waiting/tray use waiting_unanswered,
not raw waiting status. Topic and selected-session chips count nonarchived items
before local search/filter; footer also shows visible vs total. Archived view has
its own topic counts. All-sessions tabs use active/closed counts separately.
Unknown inaccessible data yields partial, never zero. Sent includes generic
requests as well as answers. Its entries preserve the original target snapshot.

`item_rounds` expands answer option/question snapshots, selected option/text,
full reply bodies, result outcome and child links; paginate rounds and each large
message list with explicit continuation cursors. `item_messages` returns stable
message IDs/numbers and origin metadata; timeline context is a separate field.

Design symbols use dots; transport uses underscores: input.submit→input_submit,
input.resolve→input_resolve, binding.connect/pause/resume/disconnect→corresponding
binding_* commands, topic.archive/restore→topic_*, session.close/reopen→session_*,
topic.continue→topic_continue_preview then topic_continue. The agent `apply`
operation tags keep dots exactly as specified below. No owner UI status-write API.
Guard errors return `details.blocking_item_ids`, `blocking_input_ids` and
`dispatch_must_pause`; unresolved means queued/in_flight/needs_attention. Handled,
cancelled and explicitly skipped inputs do not block archive/close.

## 3. Agent API: explicit results and tree operations

Tools: `session_read`, `item_messages`, `item_rounds`, `apply`.
Public CLI equivalent: `ariadne apply --binding UUID --generation UUID --json-stdin`.
MCP `apply` takes the same binding/generation and request as tool arguments.
The MCP server may serve several sessions, so **every call** has explicit routing;
no cwd/latest-session default, global mutable 'current agent', or inferred PID.
Binding maps to a registered session; callers cannot provide an alternate path.

`ApplyRequest`:

```text
op_id: UUID
source_input_id: UUID|null
attempt_id: UUID|null                 # both source fields present or both null
expected_item_revisions: {item_id: revision}
expected_topic_revisions: {topic_id: revision}
summary: string                      # <=4KiB, session activity, not an item reply
operations: Operation[]              # 0..100, sequential refs within atomic batch
input_result: ResultDraft|null
```

| Operation | Required fields and optional fields |
|---|---|
| `topic.add` | `ref,name` |
| `item.add` | `ref,topic,parent?,question,type,status,owner`; optional ask/options/note/links/outcome/why/replaced_by/source_round_id |
| `item.edit` | `item,patch` restricted to question/type/note/links; expected revision |
| `item.ask` | `item,ask,options,recipient_binding_id`; opens new round + waiting episode, owner=me |
| `item.status` | `item,status`; `outcome,why` required for decided/done/dropped; `reason` required for other transitions; replaced uses item.replace; waiting uses item.ask |
| `item.replace` | `item,replacement,outcome,why` |
| `reply` | `ref,item,text,round_id?`; exactly one full item reply |
| `round.close` | `round_id`; immutable history retained |

`ref` is a request-local name `[A-Za-z][A-Za-z0-9_]{0,31}`. Reference objects are
`{id:"existing-id"}` or `{ref:"earlier-operation-ref"}`. No forward references;
core allocates IDs on its copy and resolves earlier refs in order, validates the
whole candidate, and commits all or none. Operations touching existing items
must have expected revisions unless replay returns a prior receipt. Newly created
items need no expected revision. New-parent ref handles topic/child creation
without round trips. Every mutation produces activity provenance; replies produce
separate full Message records with explicit item and round links.

`ResultDraft`: `{outcome:answered|deferred|unable,explanation,
reply_refs:Ref[],followup_item_refs:Ref[],handled_through_message_number}`.
Requires a valid open input/attempt in this binding; terminal-originated apply
has no result. `answered` requires at least one reply or follow-up; `deferred` and
`unable` require a reply explaining why, optionally follow-up questions. All
referenced replies must have this input/attempt provenance (a result_repair
attempt may additionally cite verified effects of its repair_for_attempt_id); item follow-ups must
be in the session and actually created/linked by this input. Max100 refs.
The handled watermark must include this input's owner message and cannot
acknowledge future unissued messages. Result commits once per attempt. Incremental
applies before result are allowed; subsequent new operations after result returns
`result_already_committed` (exact operation retries remain valid).

### Concrete reply + two children + result

The CLI routing flags supply binding/generation. UUIDs below are illustrative;
item4 and topicUUID must exist and revision7 must be current.

```json
{
  "op_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "source_input_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "attempt_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  "expected_item_revisions":{"4":7},
  "expected_topic_revisions":{},
  "summary":"Split the finding into an implementation task and a policy choice.",
  "operations":[
    {"op":"reply","ref":"response","item":{"id":"4"},"text":"The retry needs a stable key. I have separated the code change from the expiry-policy question."},
    {"op":"item.add","ref":"fix","topic":{"id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd"},"parent":{"id":"4"},"question":"Add a stable idempotency key to the retry.","type":"task","status":"open","owner":{"kind":"agent","binding_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"}},
    {"op":"item.add","ref":"choice","topic":{"id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd"},"parent":{"id":"4"},"question":"How long should the idempotency key remain valid?","type":"question","status":"waiting_on_me","owner":{"kind":"me"},"ask":"Choose an expiry period.","options":[{"id":"one_day","label":"24 hours","consequence":"Protects retries made during the following day.","recommended":true}]}
  ],
  "input_result":{"outcome":"answered","explanation":"Answered the finding and created follow-up work.","reply_refs":[{"ref":"response"}],"followup_item_refs":[{"ref":"fix"},{"ref":"choice"}],"handled_through_message_number":12}
}
```

For a new waiting item, core defaults recipient to the acting binding; it opens
round1. If the apply has a source input whose item is the new child's parent,
core defaults source_round_id to that input message's round. Otherwise caller
must supply it to claim a round fork. Return allocated IDs/ref mapping, new
message IDs/numbers, touched revisions, input result state and queue join state.
A reference to the wrong topic/parent rejects the entire batch.

## 4. Bootstrap and tool instructions

`project register` and `binding connect` are setup/owner commands, not model tools.
Claude /ariadne-connect supplies actual $.session.id/cwd through bridge; Codex
connect takes user-selected known thread and validates thread/read before writing.
Connect returns the stable binding handle and an instruction snippet:

```text
This conversation is connected to Ariadne binding <B>, generation <G>.
Use ariadne session read --binding <B> --generation <G> --view items --json.
Publish substantive findings/replies with ariadne apply --binding <B>
--generation <G> --json-stdin, or the equivalent configured MCP tool.
Use explicit item references; normal terminal prose does not update Ariadne.
```

The owner can paste that snippet in the existing terminal for initial findings;
no automatic boot inference is needed. Each dispatched message repeats current
binding, input/attempt, exact target and result instructions, so no reliance on
remembering a stale handle. Setup installs shared rules; existing Codex sessions
can use CLI without adding/reloading an MCP server. Missing MCP never silently
changes delivery semantics. CLI command execution retains the host's usual
permissions; no wildcard tool approval grants.

Rules include: plain sentences, distinguish same-decision rounds from new child
questions, publish full item replies, choose valid statuses, preserve closed
outcome history, use revisions/receipts, and finish each Ariadne input with one
result. A normal terminal summary may be brief because the detailed response is
already committed. On domain error inspect and correct the call; never claim a
commit without its receipt. Same rule source shipped for all adapters.

## 5. Events and errors

Tauri events: `ariadne://session_changed {session_id,revision}`,
`ariadne://presence_changed {binding_id,generation,observation}`,
`ariadne://route {project_id,session_id,item_id?}`. Events are hints; subscribe,
load, compare revisions, reconcile on focus/wake and every2s. CLI/MCP mutations
are observed by directory watch even if they cannot publish in-memory events.

Errors include `invalid_argument`, `not_found`, `binding_ambiguous`,
`binding_mismatch`, `binding_conflict`, `stale_generation`, `incompatible_adapter`, `host_unreachable`,
`revision_conflict`, `question_changed`, `unhandled_owner_message`, `invalid_ref`,
`invalid_transition`, `operation_reused`, `result_already_committed`,
`attempt_sealed`, `result_missing`, `delivery_uncertain`, `queue_full`,
`topic_not_archivable`, `session_not_closable`, `preview_stale`, `snapshot_changed`,
`store_busy`, `capacity_exceeded`, `commit_uncertain`, `corrupt_session`,
`future_schema`, `permission_denied`, `unsupported`.

Error messages explain a concrete recovery action and contain bounded IDs/revisions,
not raw stderr/environment/content dumps. Retryable means the **same operation**
can be retried; it never authorizes resending an uncertain provider message.
CLI exits: 0 success, 2 invalid input, 3 conflict, 4 unavailable/IO, 5 incompatible;
stdout remains one envelope in JSON mode, diagnostics go to stderr.


### Agent query visibility

Owner/UI queries see all saved messages. A dispatched agent request includes
source_input_id/attempt_id and its `issued_through_message_number`; agent query
projections hide later queued owner-message bodies/options until those inputs
are issued, while still showing current items/revisions and intervening agent
updates. Queue summaries may show counts/IDs only. Terminal-originated reads use
the binding's latest issued watermark; unissued owner inputs are not fetched as
an alternate delivery channel. This preserves one-at-a-time context. Shared
rules instruct the agent to use these projections, not open raw session JSON.
The restriction is application behavior, not a same-OS-user filesystem boundary.


### Restore and continue guards

Restoring an archived topic changes only archived_at/revision. Sending new owner
input still requires an active Ariadne session and a valid target binding; if
that session is closed, offer Reopen session first. Continue requires different
source/target sessions and an active target with a valid binding. An unavailable
host can receive a durable queued continuation, labelled queued, but an unknown
or ambiguous binding cannot. Source may be closed or topic archived because
copying is read-only there. No provider is launched by either action.
