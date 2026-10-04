# Application APIs, CLI and MCP — v1

All transports invoke the same typed core service below.
Canonical schemas derive from Rust; transport adapters only decode, construct context,
validate the envelope and encode. No raw snapshot replacement API exists.

### Core service interface

P0.6 publishes this synchronous, provider-neutral `CoreService` in
`ariadne-core`, with owned request/result DTOs and typed errors. Domain entities,
IDs, receipts and projections are the canonical P0.3b Rust-generated types;
command/query unions belong to this service, not alternate renderer schemas.
The canonical declarations are exported at `ariadne_core::service`; generated
schemas and the CLI/Tauri service and MCP tool manifests live in
`contracts/generated/core`, with TypeScript imports in
`apps/desktop/src/generated/core`. No transport owns a second command model.

```text
query(QueryContext, QueryRequest) -> Result<QueryResult, CoreError>
execute_owner(OwnerContext, OwnerCommand) -> Result<MutationReceipt, CoreError>
apply(AgentContext, ApplyRequest) -> Result<ApplyReceipt, CoreError>
claim(ValidatedDispatchContext, ClaimRequest) -> Result<Option<PreparedAttempt>, CoreError>
report(AdapterContext, NormalizedEvent) -> Result<EventReceipt, CoreError>
```

Trusted local entry points construct contexts from registered project/session or
binding IDs, validated actor scope and current generation. Query context retains
owner versus agent visibility and issued-watermark rules below. No caller-chosen
actor or arbitrary renderer path enters the service. Runtime constructs a
validated dispatch context only while holding the current binding lease; core
rechecks persisted scope/generation/dispatch state under the transaction.
Historical reports follow PROCESS section 2's verified reconciliation exception.

Contexts have private fields and no wire deserializer/schema. Explicitly trusted
local constructors retain registered project/session IDs, binding/current
generation, and owner versus agent scope. `AgentReadScope` distinguishes terminal
reads using the latest issued watermark from dispatched input/attempt reads.
`ValidatedDispatchContext` asserts the runtime currently holds the binding OS
lease; `AdapterContext` may additionally retain the requested historical attempt,
originating generation and verified host fingerprint. These typed assertions are
not unforgeable credentials: the real core rechecks persisted scope, generation,
lease and watermark under its transaction. Historical facts never reopen dispatch
or rewrite a sealed attempt. Models cannot select an actor or storage path.

`ClaimRequest={binding_id,generation,request_id}`. Replay the original claim
receipt first. `Ok(None)` means a healthy binding has no eligible work, including
an empty queue or an existing in-flight input. Bad scope/generation/lease, pause
or recovery barriers return the existing typed error with a reason in `details`;
they are not a healthy empty queue. `PreparedAttempt` contains the persisted
input/attempt IDs, originating generation, exact formatted payload, digest and
wire marker. The exact submitted payload starts with `wire_marker` followed by LF;
owner/context data follows safely encoded, and the saved digest covers all these
exact UTF-8 bytes. Providers submit those bytes unchanged; they cannot add the
marker after hashing. P2.2 owns the production claim formatter; P2.5 owns MCP
transport. P0.6 checks only this prefix/digest boundary. It does not claim host
acceptance. `EventReceipt` identifies the
reported event and persisted revision/effect, including a consistent replay;
ephemeral presence need not produce a new durable session receipt.
Its exact record is `{event_id,session_id,revision:positive_safe_integer|null,
durable_effect,replayed}`; consistent replay preserves saved revision/effect.
An invalid lease is `permission_denied`; disconnected dispatch is
`host_unreachable`. Explicit owner pause and otherwise blocked recovery are
`invalid_transition` with typed `details.reason=owner_paused|recovery_required`.
Actual missing result, uncertainty and contradictory facts retain `result_missing`,
`delivery_uncertain` and `protocol_conflict`; healthy in-flight work stays `Ok(None)`.

Filesystem calls run off the UI and async executor thread. Never keep a store
lock across an adapter/host wait. A scripted test/dev double may implement this
same interface using shared fixtures; actual domain/store acceptance remains
mandatory. See [module delivery](../MODULE_CONTRACTS.md).

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
receipt before revision checks; different digest is `operation_reused`.
Before a session exists, project registration keeps a small `(local_setup,op_id)`
receipt and digest in the project registry. Binding connect checks the existing
host identity and session binding before allocating IDs; its authoritative
binding and receipt live in that session. Update the rebuildable binding index
after the session commit. If metadata conflicts, stop and show the affected path.
No bootstrap journal, completion-stage tracking or automatic setup repair is
required; follow DOMAIN_AND_STORAGE section 4.

Bootstrap keeps that session/actor namespace. With `existing_session_id`, check
only the requested owner/session receipt. Without it, scan the requested project's
authoritative sessions for one exact route/owner/command digest match: unrelated
mismatches are ignored, one match replays, multiple exact matches return
`binding_ambiguous`. Other projects' operation keys are unrelated. With no match,
verify the explicitly chosen host outside every filesystem lock, then recheck
replay and global selected routes under setup locks. Only the intended session's
conflicting operation key returns `operation_reused`. Command normalization
includes its discriminant and complete typed params, excluding op ID and the
already validated envelope version. Pause and resume are different intents even
with identical params.

First connect commits session plus receipt at revision 1 before publishing the
rebuildable index. Index failure reports `commit_uncertain` with op ID; same-op
retry refreshes the index and returns saved IDs/generation without another
mutation or provider check. Native `bindings::BindingService` retains typed
core/registry/store errors and paths; ordinary pre-publication I/O is not an
uncertain commit. Registration derives its initial display name from the
canonical root basename under lock and preserves an existing metadata name;
that derived name is not a request field or digest input.

`MutationReceipt` is an untagged typed union: session commands return the existing
`SavedReceipt` directly, project registration returns
`{operation_id,project_id,registry_revision}`, and preference writes return
`{operation_id,preferences_revision}`. Required IDs/revisions distinguish these
records and mixed/unknown fields reject. `ApplyReceipt` reuses `SavedReceipt` and
must have `data.kind=apply`. No extra session wrapper changes the public success
shape. Application `ok` is a literal boolean; absent optional error revision/details
are omitted, while nullable domain/service fields emit explicit null.

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
| `input_cancel` | queued input_id, expected_revision, op_id | only before any preparation; preserve history, persist cancelled state + receipt |
| `input_resolve` | input_id, attempt_id, decision (retry_unexecuted/resend/skip/request_result_repair/confirm_evidence), reason, expected_revision, op_id | queue recovery; decisions in queue spec |
| `topic_archive/restore` | topic_id, expected_revision, op_id | lifecycle only; archive guards active items/unresolved inputs |
| `session_close/reopen` | session_id, expected_revision, op_id | close requires dispatch paused, all items terminal and no unresolved inputs; never terminate host |
| `topic_continue_preview` | source session/topic, target session | snapshot revision/hash, mapping preview, full summary, readiness |
| `topic_continue` | source refs/revision/hash, target session/binding, op_id | atomic target copy + input + origin mapping; source untouched |
| `preferences_patch` | expected_preferences_revision, patch | UI-only Later, drafts, theme, rail, tabs, geometry |
| `preferences_get` | none | local owner-only versioned UI preferences, including unsent drafts |
| `reveal_item` | registered project/session/item IDs | focus route; no mutation |

`input_submit` constructs ordinary item-targeted inputs. Continue and topic-only
submission return `invalid_argument` directing the caller to `topic_continue`,
whose preview/mapping and copied history commit atomically in P2.6. A supplied
`expected_question_revision` remains a real locked guard for every item intent;
staleness returns `question_changed`. `supersedes_answer_id` is valid only for
Answer corrections. A changed current eligible Answer returns `revision_conflict`
with the current session revision and guidance to reload that Answer.

`input_cancel.expected_revision` guards the session revision. Cancellation requires
queued state, no attempt history and no active attempt. It changes only Input state
plus session update/revision and the durable `InputCancel` receipt; Message, Answer,
frozen payload and round/item history remain intact. It creates no attempt-bound
resolution history entry. Both commands replay the exact saved owner/session
operation before mutable guards; changed normalized intent under the same operation
key returns `operation_reused`. Native `inputs::InputService` supplies these real
transactions; application composition delegates without changing CoreService.

Owner transports use the generated `OwnerQueryRequest={session:SessionRef|null,
request:QueryRequest}` and `OwnerMutationRequest={session:SessionRef|null,
command:OwnerCommand}`. Single-session commands/reads route only through this
registered session handle; `session_get` has empty params, lifecycle params retain
only expected revision, input submission params retain binding/target/content,
and reveal params retain item ID. The table's project/session IDs describe routing,
not duplicate IDs in those params. Missing, unexpected and contradictory routes
reject. Registry/preferences/global list reads and bootstrap registration/connect
use null. Continue preview uses null and explicit source/target refs; Continue
commit uses the target route and verifies its explicit target agrees. Entry points
resolve registered scope before constructing trusted contexts. No caller selects
an actor or arbitrary storage path through these routing wrappers.

`binding_connect` creates a new Ariadne session by default unless the host identity
already belongs to a selected binding. Same-host validated reconnect keeps the
session/binding, rotates generation and preserves owner pause/history/original
attempt generations. Unresolved prepared work requires reconciliation; unsent
queued work and resolved/sealed history alone do not imply uncertainty. Selected
routes remain reserved while paused/disconnected/recovering or closed; a new
connect to a closed session returns `invalid_transition` until explicit reopen.
Different-host `existing_session_id` rebind requires active state, no queued,
in-flight or needs-attention input and a paused/disconnected old binding. The old
binding/history stays intact and its inactive former route is freed for a new
default-connect session. A different enabled binding or route conflict returns
`binding_conflict`; no queued message is silently retargeted.

Trusted composition supplies read-only verified endpoint/config/version/thread
facts through native `core::bindings::VerifiedHost`, outside all store locks.
These facts are not a wire DTO or active provider handle. Unknown/incompatible
qualification or unavailable host fails preflight; verified identity without an
active connection observation persists Unknown with disconnected dispatch.
Runtime later calls Adapter.connect using durable IDs/generation before acquiring
dispatch authority. That provider wiring belongs to P3.6/runtime, not P1.4.

Tauri command names use the snake_case names above; CLI uses nouns/verbs
(`input submit`, `binding connect`, `topic continue`). `apply` uses operation
names with dots below. All commands document `--help` and stdin JSON examples.
`session_get` is local desktop-only; MCP queries use bounded `session_read`.

Tauri invokes each exact command with `{request:OwnerQueryRequest}` or
`{request:OwnerMutationRequest}`. The command must match the nested canonical
request/command tag; mismatches are `invalid_argument`, never alternate routing.
Trusted Rust startup supplies CoreService and registered-session lookup, verifies
resolved project/session IDs and validates canonical responses before emitting an
application envelope. Continue resolves both sessions. Registry bootstrap commands
retain Registry owner scope and Core performs their project/root trust checks.
An ordinary uncomposed entrypoint returns nonretryable `unsupported` with the
specific unavailable feature. Renderer code cannot install a service or assert
registration. Successful durable session mutations publish best-effort revision
hints; event publication failure cannot turn a saved receipt into a failed command.

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

Every bounded collection uses
`Page<T>={items:T[],next_cursor:QueryCursor|null,snapshot_revision}`. `QueryCursor`
is the existing DOMAIN section 5 structured cursor
`{schema,view,filter_digest,after,revision}`, not a second opaque-string format.
Each nested round-message list has its own `Page<Message>` and cursor; fetching
more rounds cannot silently truncate or advance a message list. Complete message
bodies and provenance remain intact under the existing entity/page limits;
revision changes return `snapshot_changed` rather than mixed history.
An explicit nested selector must identify a parent returned in that outer page,
must be unique for that parent/collection, and controls its own limit/cursor.
Unfulfilled or contradictory selectors are rejected. Nested page revisions match
the outer snapshot; continuation view, sort key and filter digest stay scoped to
that collection. Option-only `input_submit` Answers may preserve empty or whitespace
text with a selected option; the real core validates the frozen question/option.

Canonical P0.3b records make those projections explicit:

- `ItemSnapshot` contains the stored Item fields except the unbounded
  `updated_message_ids` and `status_history` arrays.
  `ItemReadProjection={item:ItemSnapshot,updated_messages:Page<Message>,
  status_history:Page<StatusHistoryEntry>}` preserves both histories separately.
- `RoundSnapshot` contains the stored Round fields except the four historical
  ID lists: owner/agent messages, result inputs and fork items.
  `RoundProjection={round:RoundSnapshot,answers:Page<Answer>,
  owner_messages:Page<Message>,agent_messages:Page<Message>,
  results:Page<ResultProjection>,forks:Page<ItemLink>}`.
  `ResultProjection={input_id,attempt_id,result:DomainResult}`;
  `ItemLink={project_id,session_id,item_id,question,status}`.
- `ItemMessagesProjection={item_id,messages:Page<Message>,timeline_context}`;
  `TimelineContext={parent_item_id,created_message:Message|null,source_round_id}`
  keeps nullable parent/creation/fork context apart from the deduplicated timeline.
  `ItemRoundsProjection={item_id,rounds:Page<RoundProjection>}` retains independent
  cursors inside each round; advancing outer pages never advances nested pages.
- `ProjectSummary={project_id,project:Project|null,canonical_root,availability:available|unavailable,
  counts:SummaryCounts}`. `SessionSummary={project_id,session_id,title,state,
  revision,created_at,updated_at,closed_at,active_binding:BindingSummary|null,
  counts:SummaryCounts}`. `BindingSummary={id,adapter_id,external_session_id,
  generation,dispatch_state,owner_paused,pause_reason,connection_state,
  presence:PresenceObservation|null}`. Closed time and pause reason are nullable.

Available project summaries require verified metadata matching project_id.
Unavailable registered roots retain their trusted ID/path; metadata may be null
when unreadable. Counts are partial, with actual known unreadable session IDs or
an empty list when those IDs are unknown. No cached or fabricated Project is used.
Aggregate cursors bind the full captured inventory digest as well as actor,
route and filters; a mismatch, including a changed aggregate filter, returns
snapshot_changed. Single-session filter mismatches remain invalid_argument.
Counts use the captured scope before pagination and session-state filtering.
Requested nested history families get byte-budget priority; defaults may return
empty pages with truthful after:null continuations, then progress when explicitly
requested. Complete bodies are never truncated.

These are owned domain records, not renderer copies or executable transforms.
Full bodies and source author/identity remain in canonical Message/Answer/origin
records. Projection execution must enforce page/entity caps; it cannot silently
truncate historical bodies. QueryCursor's exact tagged sort/tie-break keys and
nested cursor scopes are in DOMAIN section 5. Service command/query unions and
list wrapper totals, including active/closed session totals, remain P0.6; they do
not extend SummaryCounts. The typed saved replay receipt union is in DOMAIN
section 2; application envelopes wrap those records without arbitrary saved JSON.

Design symbols use dots; transport uses underscores: input.submit→input_submit,
input.resolve→input_resolve, binding.connect/pause/resume/disconnect→corresponding
binding_* commands, topic.archive/restore→topic_*, session.close/reopen→session_*,
topic.continue→topic_continue_preview then topic_continue. The agent `apply`
operation tags keep dots exactly as specified below. No owner UI status-write API.
Guard errors return `details.blocking_item_ids`, `blocking_input_ids` and
`dispatch_must_pause`; unresolved means queued/in_flight/needs_attention. Handled,
cancelled and explicitly skipped inputs do not block archive/close.

### Service-owned read and preference records

`QueryRequest` uses `{command,params}`; `QueryResult` uses `{kind,data}` and the
matching command name. `session_read.selection` is a view/filter union:
topics have an archived filter, items topic/item/parent/status/archive filters,
messages topic/item filters, and inputs topic/item/state filters. Each request
has the canonical cursor and a validated limit of 1..100. Item history continuation
selectors inside `session_read.item_pages` and round selectors inside
`item_rounds.round_pages` identify the parent item/round plus the existing DOMAIN
cursor view and their independent cursor/limit; they add no endpoints. Cursor
filter digest includes those parent/scope selectors, and execution validates
view, filters, sort key and snapshot revision together.

Owner input pages contain complete canonical `Input` records. Agent input pages
use `inputs_queue` with `InputQueueEntry={id,seq,binding_id,state}`; context selects
visibility and callers cannot request private payloads. Messages, item updated
messages, answers and nested round histories still honor the issued watermark
and preserve complete visible bodies and provenance. List results carry their
canonical Page and completeness counts; session lists separately carry active
and closed totals. No inaccessible data becomes a complete zero.

Preference records belong to the local owner backend. `PreferencesSnapshot`
contains schema/revision, global theme (system/light/dark), optional window
geometry/monitor, pin and notification watermark; per-session selection, tab
order, expansion, filters, rail and scroll; qualified Later routes; and unsent
`OwnerDraft` records. Drafts retain a stable operation ID, registered session,
binding, canonical target, intent, exact text/option and target/question revisions.
They are never submitted inputs or agent query data. A revision-checked
`PreferencesPatch` uses typed entries to set global/session view, set/clear Later,
upsert or delete drafts. Explicit null clears nullable UI fields; deleting a draft
is explicit. The existing request/entity/page bounds apply. See
[UI state](UI_AND_NATIVE.md).

Continue previews identify the validated source revision/hash, full approved
summary, source item IDs and proposed copy or imported-drop action for external
replacement edges, and ready/blocked target reasons. They allocate no target IDs.
A known valid target binding can queue while its host is unavailable; unknown or
ambiguous bindings cannot. Confirmation passes the source refs/revision/hash,
target session/binding and exact approved summary. Allocation and commit remain
under the target lock.

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

In `item.edit.patch`, omitted `note` leaves it unchanged, explicit null clears it,
and a string preserves its exact text, including an empty string. Other optional
patch fields emit null when absent and update only when present with a value;
an empty links array clears links. Scope/reference/revision and domain-transition
checks belong to the real core, after exact operation replay lookup.

`ref` is a request-local name `[A-Za-z][A-Za-z0-9_]{0,31}`. Reference objects are
`{id:"existing-id"}` or `{ref:"earlier-operation-ref"}`. No forward references;
core allocates IDs on its copy and resolves earlier refs in order, validates the
whole candidate, and commits all or none. Operations touching existing items
must have expected revisions unless replay returns a prior receipt. Newly created
items need no expected revision. New-parent ref handles topic/child creation
without round trips. Every mutation produces activity provenance; replies produce
separate full Message records with explicit item and round links.

Core checks all supplied item/topic guards once against the locked original
snapshot; ordered operations then use current staged revisions. Existing parents
whose child counters change and items owning a closed round need their original
item guard. Merely referencing an existing topic when adding an item needs no
mandatory topic guard; any supplied guard is still checked. One batch Activity
records mutation provenance and the union of touched items, preserving exact
nonblank summary text or using a deterministic fallback for blank summaries.
An empty no-result batch with a blank summary saves only its receipt/revision.

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

The native `apply::ApplyService` uses the registered Store transaction and pure
domain/history helpers. Fresh source writes require both the trusted current
binding generation and the attempt's originating generation to be current;
historical read permission grants no write authority. A result watermark obeys
source owner message <= handled watermark <= trusted issued watermark <= latest
persisted message. Narrower trusted grants never widen. Exact operation replay
returns original IDs and receipt before mutable guards. Transport composition
remains with the owning CLI/MCP/runtime tasks.

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

The Mod sends `project register --json-stdin`, `binding connect --json-stdin` and
`binding disconnect --json-stdin` exact OwnerMutationRequest `{session,command}`
bodies; command must match argv. Bootstrap uses session:null, disconnect the
registered SessionRef. Helpers return canonical ApplicationEnvelope<MutationReceipt>.
`bridge claim --binding B --generation G --request-id UUID` keeps the original
request ID after uncertainty. Read-only `bridge connection-status` uses the same
explicit flags with a fresh request UUID and returns ApplicationEnvelope<BindingSummary>
from the existing private control projection. `bridge report --binding B
--generation G --json-stdin` receives one canonical NormalizedEvent and returns
ApplicationEnvelope<EventReceipt>; exact pending event IDs/bytes survive failures.
None of these helper consumers add a local DTO or authorize dispatch from status.
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
`ariadne://route {project_id,session_id,item_id}` (explicit null for a session-only
route). The canonical core records are `SessionChangedHint`, `PresenceChangedHint`
and `OpenRoute`; presence generation must match its observation. Non-null item
routes reuse `ItemRoute` and resolve registered membership before revealing.
Events are hints; subscribe,
load, compare revisions, reconcile on focus/wake and every2s. CLI/MCP mutations
are observed by directory watch even if they cannot publish in-memory events.

Errors include `invalid_argument`, `not_found`, `binding_ambiguous`,
`binding_mismatch`, `binding_conflict`, `stale_generation`, `incompatible_adapter`, `host_unreachable`,
`revision_conflict`, `question_changed`, `unhandled_owner_message`, `invalid_ref`,
`invalid_transition`, `operation_reused`, `result_already_committed`,
`attempt_sealed`, `result_missing`, `delivery_uncertain`, `queue_full`,
`topic_not_archivable`, `session_not_closable`, `preview_stale`, `snapshot_changed`,
`io_error`, `store_busy`, `capacity_exceeded`, `commit_uncertain`, `corrupt_session`,
`future_schema`, `permission_denied`, `unsupported`, `protocol_conflict`.

`protocol_conflict` is the PROCESS error for contradictory normalized turn IDs
or outcomes; it pauses the affected binding. Existing process-specific errors
retain their documented recovery; P0.6 publishes their typed transport mapping.

`io_error` is a definite ordinary local I/O failure (CLI exit4), nonretryable by
default. A classified transient failure may explicitly permit the same operation
to retry. Prefer permission, capacity, busy or commit-uncertain codes when known.
This code does not assert that an irreversible operation was unsent; uncertain
provider delivery retains `delivery_uncertain` and must never authorize a resend.

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
at most the binding's latest issued watermark, permitting a narrower grant;
dispatched reads also stay within source-input issuance. Historical attempts can
be read under a newly trusted current generation after reconciliation while
retaining their original attempt generation, without lease or write authority.
Unissued owner inputs are not fetched as
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
