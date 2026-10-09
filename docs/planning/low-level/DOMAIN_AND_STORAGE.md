# Domain model and storage — schema v1

Revision 3. This replaces the earlier consumer/run/host-request model before any
production schema has shipped. Prototype SQLite and host transcripts are not
migration inputs. Rust serde types are canonical; generate JSON Schema and
TypeScript types from them in M0/M1, checked into `contracts/generated/`.

## Storage format decision

Keep the build prompt's one-JSON-file-per-session requirement. All app, CLI and
MCP writes use `ariadne-store`; no transport writes JSON directly. The stable
cross-process lock and atomic commit protocol in section 4 are mandatory, with
ordinary concurrent-writer and save/read checks before integrations depend on the store.
Exotic-failure recovery is deferred by [PERSONAL_RELEASE](../PERSONAL_RELEASE.md).
Human readability does not make manual edits during a running writer safe.

JSONL is not the canonical store: a single operation may change replies, tree
structure, statuses, queue attempts and idempotency receipts together. An append
log would require transaction records, serialization, torn-tail detection,
replay, snapshots and compaction; simple append does not solve those problems.
Do not add a parallel authoritative log that can diverge from the snapshot.

SQLite is the preferred alternative if the file-format requirement is later
relaxed or recorded write latency/capacity evidence shows a real problem. It would
replace storage behind the core command/query boundary, with a separately
specified and tested migration; JSON export could retain human-readable sharing.
It is not silently introduced by this plan. SQLite WAL permits readers alongside
a writer but still serializes writers ([SQLite WAL documentation](https://sqlite.org/wal.html)).

## 1. Primitive conventions

UUID v4 lowercase strings for project/session/topic/binding/input/attempt/message/
round/operation IDs; host IDs and adapter IDs are opaque bounded strings. Item
references `1`, `1.2` are session-local display IDs, never paths. Parent is an
explicit field: never infer ancestry by parsing an ID. Root/suffix counters never
reuse numbers. Sort siblings by assigned numeric ordinal, not string comparison.
All counters/revisions are integers in 1..2^53-1 with checked increments. Timestamp
is RFC3339 UTC milliseconds assigned by core; ordering uses sequences/revisions.
Optional fields serialize as explicit null and accept omitted or null values on
read; collections are required and never defaulted. Entity and nested record
shapes reject unknown fields. Reject unknown
command fields, duplicate map keys, invalid UTF-8/NUL and whitespace-only required
text. Preserve actual text, including newlines; no normalization of stored prose.

Validated wire primitives are `UuidV4`, `ItemRef`, `UtcMillis`, `SchemaVersion`,
`PositiveSafeInteger`, `NonnegativeSafeInteger`, `Sha256` and `RequestRef`.
UUIDs retain lowercase RFC4122 variant v4 spelling. `ItemRef` is dot-separated
positive decimal segments without leading zeros, each in 1..9007199254740991;
it supplies no inferred ancestry. `SchemaVersion` is exactly 1 for the initial
schema. Positive safe integers are 1..9007199254740991; nonnegative safe integers
are 0..9007199254740991. `RequestRef` uses `[A-Za-z][A-Za-z0-9_]{0,31}`;
`Sha256` text uses 64 lowercase hexadecimal characters. Constructors and
deserialization reject alternate spellings rather than normalizing them.

`UtcMillis` accepts canonical RFC3339 UTC with uppercase T/Z and exactly three
fractional digits. Pinned Chrono parsing and millisecond/Z formatting must
round-trip to exactly the same string. Second 60 is accepted only at 23:59Z,
matching the pinned JSON Schema `date-time` assertion. Calendar validity remains
the pinned libraries' responsibility; no independent length cap, year range,
month-end rule or historical leap-second table is added. Core assigns timestamps;
sequence and revision determine ordering.

`cargo xtask gen-contracts` generates Rust-authored primitive and complete model
JSON Schema and TypeScript; read-only `--check` rejects missing, stale or unexpected
artifacts. Schemas describe canonical emitted records, including required nullable
fields; optional-read compatibility is proved separately by Rust tests. TypeScript
expresses scalar wire kinds, tagged variants and literal schema version 1;
lexical forms, integrality and safe bounds require Rust or JSON Schema validation.
Typed maps use deterministic `UniqueMap<K,V>` with lexical primitive keys and
duplicate-key rejection, including nested adapter-configuration objects. JSON
Schema validates map-key spelling but cannot detect duplicate keys already lost
by a JSON parser. Prose byte limits, blank/NUL checks, relationship invariants,
scope and transitions remain P1.1; full canonical demo/invalid fixtures remain P0.3.
See [ADR-0012](../../adr/ADR-0012-complete-the-domain-v1-contract.md) and
[ADR-0013](../../adr/ADR-0013-validate-domain-primitives.md).

## 2. Files and entity inventory

```text
~/.ariadne/                      # data root: $ARIADNE_HOME or ~/.ariadne (ADR-0082)
  projects/<project_uuid>/        # per-project store; nothing lives in the project root
    project.json                 # schema_version, id, display_name
    sessions/<session_uuid>.json  # canonical domain + delivery snapshot
    locks/<session_uuid>.lock     # never renamed/deleted
    backups/<session>.previous.json
    backups/<session>.v<old>.<uuid>.json # future concrete migration only
  projects.json                  # registered canonical roots + IDs
  bindings.json                  # host identity → session/binding index, rebuildable
  adapters/                      # reserved for deferred executable registrations
  ui.json                        # preferences, drafts, tabs, local Later flags
  run/                           # private control socket, leases, presence
```

A legacy `<project>/.ariadne/` store is migrated to `projects/<project_uuid>/`
automatically when its registered project is opened: copy, verify byte-for-byte,
then remove. A failure leaves both in place; if both exist the new store wins and
the open fails until the owner removes the legacy one. See
[ADR-0082](../../adr/ADR-0082-project-store-under-data-root.md).

Project: `{schema_version:1,id,display_name}`.

Session: `{schema_version:1,id,project_id,title,state,created_at,updated_at,
revision,closed_at,counters,active_binding_id,topics,items,messages,rounds,
answers,bindings,inputs,operation_receipts,continuations,name?,description?,archived_at?}`.
`archived_at` is absent for ordinary sessions. Archive closes an active session
with Close's cancellation and pause semantics before setting it; Restore clears
it while keeping the session Closed. Undo of an Active session restores and reopens
in one revision-guarded transaction. History and IDs remain intact (ADR-0095).
`name` and `description` are the owner's own label for the session: trimmed, a
name of 1 to 60 characters and a one-line description of at most 200, both
omitted when unset (ADR-0091). `title` holds the external session id and is not
shown to the owner. `state=active|closed`. Counters: `next_root,next_topic_order,next_message,
next_input,next_answer`. Collections except messages/answers are ID-keyed maps;
messages and answers are ordered arrays. Binding, not provider name, routes work.
`operation_receipts` maps operation UUIDs to ordered arrays of actor-scoped
receipts: the same operation UUID may occur in different actor scopes; one receipt
per actor scope in a bucket is a semantic invariant. No new composite-key syntax
or global operation-ID namespace is introduced.
An active session has at most one dispatch-enabled binding. Historical bindings
remain for provenance; multiple sessions in one project may run concurrently.

### Topic and item

Topic: `{id,name,order,revision,created_at,archived_at,origin}`. `origin` is null or
`{project_id,session_id,topic_id,source_revision,continued_at}` for a snapshot copy.
Topic and Item also carry optional `short` (ADR-0084): an agent-written 2-4 word
label, trimmed, one line, at most 40 characters; omitted from JSON when absent, so
stores written before it load and re-serialize unchanged.

Item also carries optional `related: ItemRef[]`, at most 32 declarations
([ADR-0094](../../adr/ADR-0094-item-links.md)).
Declarations mean related in both directions within the same session, including
across topics. Absent stays absent on serialization. Explicit writes reject self
and duplicate targets and require existing targets, except a removed target
already declared by that item may be resent. That related-list write prunes the
removed targets and records their numbers in the saved receipt's `pruned_related`
map. Stored dangling targets are tolerated after removal; reads and the UI show
only live targets. New missing targets are refused with the operation and target.
Continuation remaps only targets
in the copied set. Inline Markdown item references do not declare relations.

Item: `{id,ordinal,topic_id,parent,question,type,status,ack_to?,owner,revision,
question_revision,next_child,ask,note,options,links,outcome,why,replaced_by,
created_at,updated_at,created_message_id,updated_message_ids,status_history,
waiting_since,recipient_binding_id,current_round_id,source_round_id,origin}`.
`type=question|decision|finding|task|explanation`;
`status=open|waiting_on_me|in_progress|decided|done|dropped|replaced`.
`ack_to`, when present, is `open|in_progress|decided|done|dropped` (ADR-0093,
alpha.12). The agent chooses it per item; there is no implicit Done. It is omitted when
absent, so old items load without adding a field or rewriting their stored bytes.
New agent items cannot have a terminal status. Strict core rejects such creation;
the lenient CLI repairs Decided/Done/Dropped to Open with the requested target,
including nested children, and reports the repair. New Open/InProgress findings
and explanations without an ask require an explicit `ack_to` in strict filing;
lenient filing repairs an omitted value to `open` and reports the repair.
Tasks, decisions and questions without reading material retain their existing
creation behavior. Open or InProgress items may retain outcome/why text,
including after acknowledgment. item.status open/in_progress
can set a target; omission keeps it and its existing text. Strict core refuses an
agent terminal status while the item has a target, unless an authenticated Answer,
Reply or Drop input targets that same item and directs completion. Such completion
and item.replace clear ack_to. Existing items without a target retain terminal
transitions. The lenient CLI repairs other terminal status requests on existing
Ack items to Open with the requested target and full completion text. The repair
uses live state under the store lock after replay lookup; operation identity and
digest still follow the original request, so exact retries remain stable after Ack.
`item.edit` can change an existing Ack choice on an Open/InProgress item;
it cannot add Ack again after acknowledgment. Owner Ack sets the chosen status
and clears the target, retaining outcome/why. An unanswered ask must keep its owner answer route: new asks
start Waiting on me with a round; lenient filing repairs explicit Open/InProgress
asks accordingly, preserving the proposal.
`owner={kind:me}|{kind:agent,binding_id}|{kind:other,name}`.
`ask` is the agent's current concrete request (nullable); `note` is a progress
sentence, not the reply thread. Links: `{kind:pr|file|doc,label,target}`.
Options: `{id,label,consequence,recommended}`; no scripts or response templates.
At most one recommendation; choosing it is still an explicit owner action.

Terminal statuses require nonempty outcome + why. Replaced requires a different
existing item in the same session and acyclic replacement links; parent/topic
and IDs are immutable. Parents may be terminal with active children. No implicit
cascade. Reopening decided/done/dropped requires reason; preserve previous
status/outcome/why in append-only history before clearing terminal fields.
Replaced items accept follow-up messages but cannot be reopened in place.

`question_revision` increments when question, ask, options, recipient or the
waiting episode changes. Ordinary replies/notes/children change item revision,
not question revision. `waiting_since` is the UTC timestamp of the current
waiting episode, null outside waiting; its identity is item_id + question_revision.
The ask round/opening message supplies asked-in-message provenance. History entries include old/new status, previous terminal
fields, cause message ID, time, acting binding, and handled owner-message number.
`StatusHistoryEntry={old_status,new_status,previous_outcome,previous_why,
previous_replaced_by,cause_message_id,at,binding_id,
handled_through_message_number,reason}`; previous terminal fields, binding and
reason are nullable. The handled watermark is a nonnegative safe integer.
The agent's validated domain operation changes an item status. The owner can
also `ack` an Open/InProgress item at its expected revision, moving it to its
recorded target and clearing that target. An unanswered ask, absent target or
terminal state refuses Ack with a plain message. An archived session also refuses
Ack with instructions to restore and reopen it. Ack records an owner Activity
and status history without creating an Input or delivery. Owner input save,
transport acknowledgement and host completion never change status.

### Full messages, answers and rounds

Message: `{id,number,author,kind,body,created_at,item_id,topic_id,items_touched,
binding_id,input_id,attempt_id,host_turn_id,round_id,origin}`.
`author=owner|agent|system`; `kind=owner_input|reply|activity|lifecycle`.
`body` is the complete submitted text, not an excerpt. Excerpts for rail/search
are derived views. A reply has exactly one `item_id`; `topic_id` is derived.
Activity summaries may touch several items but are not copied into every item's
conversation. System lifecycle records describe close/archive/recovery, not agent
speech. Message bodies are append-only; corrections create new messages.
`items_touched` and item backlinks are core-derived from operations, deduplicated.

An atomic agent apply uses one batch Activity for mutation/status provenance,
with exact nonblank summary text or a deterministic fallback for actual changes.
Replies remain separate full Messages. A blank no-op batch adds no Activity.
Supplied revision guards refer to the locked original snapshot; ordered operations
use staged revisions thereafter. A newly created waiting item starts round 1 at
question revision 1; a later Ask creates a distinct frozen history episode.

Answer: `{id,seq,item_id,question_revision,question_snapshot,ask_snapshot,
options_snapshot,selected_option_id,text,message_id,input_id,
supersedes_answer_id,created_at}`. At least one valid option/nonempty text.
Selected option and explanation are preserved together. Correction appends a
new answer linked to a prior answer; it never edits an accepted payload. If the
question changed, offer a generic follow-up instead of mislabelling it an answer.

Round: `{id,item_id,ordinal,opened_message_id,question_snapshot,ask_snapshot,
options_snapshot,question_revision,owner_message_ids,agent_message_ids,
result_input_ids,fork_item_ids,closed_at,origin}`. Ask, close time and origin are
nullable; options and every historical ID list are present. `Item.source_round_id`
is the nullable reverse link for a round fork.
Agent `item.ask` starts a new round and freezes question/options/ask snapshots.
A generic owner message uses the current round, or creates one with the current
question when none is open. Agent replies reference the current/explicit valid
round. A completed input result can close a round only explicitly; an answered
input need not end ongoing discussion. A new ask starts a new round after closing
the earlier round with history intact. New child operations can carry
`source_round_id`; core validates the round belongs to their parent and records
the fork both ways. This renders the mockup's ask → owner response → result →
branches cards without guessing from chronology. Unrelated messages stay in the
ordinary timeline. Imported round/message IDs are remapped on topic continuation.

The pure `ariadne_domain::history` helpers assemble an owned `Session` candidate:

- `record_owner_history(session, message, answer, new_round_id)` records canonical
  caller-prepared records after the caller stages their matching Input. It validates
  the original target/snapshots/text and an Answer's current question revision,
  deliberate choice/text and correction link. A correction explicitly supersedes
  the latest answer in that same item/question episode. It increments message/answer
  counters, adds round/item backlinks and leaves every Input/Attempt unchanged.
- `open_ask_round(session, asked_item, opened_message_id, at)` consumes the candidate
  from the agent Ask transition while the original session retains the previous
  Item. It closes the previous open round, freezes the new snapshots and inserts
  the candidate without another item revision increment.
- `append_reply(session, context, draft)` validates binding/generation and paired
  input/attempt provenance, then creates one full targeted reply. An explicit
  historical closed round remains closed. Otherwise it uses the current round,
  or null when none exists; it never opens a round by guessing from agent prose.
- `close_round(session, round_id, at)` retains an existing close timestamp and clears
  a matching current-round pointer, incrementing that item's revision/time once.
  `link_round_fork(session, round_id, child_item_id, at)` checks the existing child's
  actual parent/topic, records both directions and increments child revision/time
  once only when assigning a new reverse link; it cannot reassign an old fork.
- `link_result_history(session, input_id, attempt_id, close_round_ids, at)` reads an
  already committed canonical result and links its input to target/reply/fork-source
  rounds. It accepts verified original-attempt effects for a result-repair attempt.
  Follow-up items require their creation message to belong to this input and its
  current attempt, or the verified original-work attempt allowed for repair. An
  earlier incremental apply of that same input qualifies. An existing item's
  ordinary reply/edit/update is insufficient. If a created follow-up carries a
  source round, its actual parent and reciprocal fork link must agree. V1's
  item.add owns child creation/source-round assignment; there is no existing-item
  reparent or source-round patch operation.
  Only the explicitly named related rounds close; queue, result and host-completion
  states remain unchanged.

Owner/reply appends increment item revision/update time once and add the message
backlink; they never change status or question revision. A generic owner message
opens a new round when the current pointer is absent or names a closed round.
No helper rewrites old bodies, answers, snapshots or close timestamps. Failed calls
leave the input snapshot unchanged. These native callable inputs are not additional
wire DTOs. P1.5 owns Input construction/submission; core/store own actor/revision
checks, session revision, operation replay, final validation and atomic persistence.

`validate_session_history` checks ordered counters, unique IDs, targeted messages,
existing creation/update backlinks, answer/correction snapshots, round lists/forks,
result references and source attribution. Compose it with item-tree and delivery
validation before committing. A reply has one direct `item_id`, but its deduplicated
`items_touched` may include other operations' provenance. Shared activity can name a
round with null `item_id` and several touched items; it is not a reply copied into
that round's conversation list. Topic-only owner Continue and system lifecycle
input/attempt evidence remain valid. Existing current-round pointers must resolve
to the same item and may name a closed historical round. Created/update backlinks
and Message targets serve different purposes: targeted history is selected through
`Message.item_id` and round links, never solely through update backlinks.

Imported history still validates local item/message/round/answer IDs and matching
continuation maps plus source project/session/topic/revision. An origin-qualified
copied Message may retain source binding/input/attempt identities without target
live records, preserving source authorship. Copied Answers may retain source input
IDs only with a consistent answer map and mapped local owner Message/snapshots.
Origin Round result input IDs remain source history only with matching round-map
lineage; they never become target work or committed target results. This validation
adds no source-store access or copy construction; those belong to P2.6.
See [ADR-0022](../../adr/ADR-0022-record-pure-item-history.md).

### Binding and presence

Binding: `{id,adapter_id,adapter_version,protocol_major,config_version,
external_session_id,endpoint,endpoint_fingerprint,generation,created_at,
dispatch_state,owner_paused,pause_reason,connection_state,capabilities,active_input_id,issued_through_message_number,adapter_config,host_location?}`.
`host_location` is an optional one-line label of at most 60 characters ("iTerm window 1"), written on connect and reconnect from the agent-side terminal environment; older stores omit it (ADR-0085).
`dispatch_state=enabled|paused|recovery_required|disconnected`.
`owner_paused` persists independently of automatic pause_reason; no result or
reconnect can clear it. Dispatch state is recomputed with disconnected/recovery
barriers first, then owner pause, then enabled. Explicit Resume clears the owner
flag only after blockers are resolved.
`endpoint` is a validated local connection reference, not credentials.
`adapter_config` is namespaced JSON validated against the adapter's configuration
schema and contains no credentials/tokens/environment dumps. Session host identity is `(adapter_id,endpoint_fingerprint,external_id)`;
one live binding per identity across registered roots. Generation is a fresh UUIDv4 on a
validated reconnect; prior attempts retain their originating generation.

The selected `active_binding_id` reserves that host identity even when paused,
disconnected, recovering or closed. Inactive historical bindings never win routing.
Connect into a closed session requires explicit reopen; exact saved replay still
returns its original receipt. Same-host reconnect retains the session/binding IDs,
owner pause, immutable input context and original attempt generations. Unresolved
prepared/in-flight/needs-attention work or an existing recovery reason requires
reconciliation; never-prepared queued work and resolved/sealed attempts do not
alone imply uncertain delivery. Different-host rebind requires an active session,
paused/disconnected old binding and no queued/in-flight/needs-attention inputs.
History stays intact. In the same different-host transaction, current item Agent
owners and recipient assignments matching the retired selected binding move to
the new binding, including terminal items and archived topics. Me, Other and
unrelated binding assignments remain unchanged. Each changed item advances its
revision once and records the connect timestamp; question revision, round and
all message/input/attempt provenance remain unchanged. Overflow rejects the whole
transaction. The former inactive host route becomes available for a new
default-connect session and is never implicitly reactivated.

Trusted read-only verification precedes persistence outside all filesystem locks.
Native `core::bindings::VerifiedHost` retains canonical endpoint/configuration,
compatibility, availability, capability and qualified connection facts, without
wire deserialization or an active provider handle. Core rechecks facts against
the explicit request, replay and authoritative routes under setup locks before
allocating final IDs. Unknown connection persists disconnected dispatch while
retaining owner pause/recovery reasons. Only verified Connected may derive
recovery/paused/enabled; preflight never grants a runtime dispatch lease.

`EndpointRef={kind:unix_socket,path}|{kind:local_bridge,name}`. A symbolic bridge
name identifies an already registered local bridge, resolved by trusted local
wiring; it is not another transport or a caller-selected network endpoint.
`EndpointFingerprint` is opaque string identity, at most 4 KiB UTF-8, not a SHA256
digest; this semantic byte limit remains P1.1. `AdapterConfig={namespace,values}`
holds a string-keyed map of canonical JSON values validated by the adapter schema.
`protocol_major` and `config_version` are positive safe integers.

`Capabilities` has exactly `existing_session,deferred_delivery,turn_correlation,
turn_completion,domain_cli,domain_mcp,history_reconcile,streaming_output,
final_text_read,discover_sessions` each `{supported:boolean,conditions:string[]}`
and `delivery_mode=pull|push`. It exposes no deferred plugin controls.
`connection_state=connected|disconnected|reconnecting|unknown`;
`pause_reason=null|result_missing|uncertain|host_failure|store_error|incompatible`.

High-frequency presence is ephemeral in `run/presence/<binding>.json` with
`instance_id,generation,connection_state,execution_state,last_seen_at,source,
process_identity,freshness`. The canonical `PresenceObservation` uses
`execution_state=idle|running|waiting_for_approval|unknown`,
`source=null|bridge_heartbeat|host_poll|host_event|process_hint`,
`freshness=fresh|stale|historical|unknown`, nullable `last_seen_at` and nullable
`process_identity={pid:positive_safe_integer,started_at:UtcMillis}`. Source is
actual evidence provenance; historical is a freshness qualifier. Heartbeat
freshness or missing events never establish idle or approval state.
Do not rewrite the whole session for every heartbeat. On app
restart it is historical until revalidated. Session stores only meaningful
connection/dispatch transitions. Detailed presence algorithm: process spec.

### Input, attempt and result

Input: `{id,seq,binding_id,kind,target,message_id,answer_id,created_at,
expected_question_revision,payload,state,attempts,
active_attempt_id,resolution_history}`.
`kind=answer|bring|reply|note|followup|reopen|drop|continue`;
`target={topic_id,item_id:ItemRef|null}`; topic-only is allowed only for continue.
`InputPayload={text,intent,target_snapshot,selected_option_id,context}`;
`intent` uses the same InputKind and matches Input.kind.
`InputTargetSnapshot={topic_name,item_question,question_revision,ask,options}`;
item question/revision, ask and selected option are nullable. Options are complete
frozen ItemOption records. `InputContext={message_ids,item_ids,round_id,
continuation_operation_id}` with required ID arrays and nullable scalar IDs.
This is immutable owner text and its original target/context, including the
question/options displayed in Sent after the live question changes.
P1.5 ordinary item submissions freeze `context.item_ids=[target]`, no caller-selected
message IDs, the chosen existing or fresh round ID, and no continuation operation.
P2.2 renders additional current-target context into the immutable prepared Attempt;
it never rewrites the original Input payload. Continue construction belongs to
P2.6's atomic topic continuation with preview/mapping, not ordinary input submission.
Do not treat the user's text as permission to run arbitrary tools.
`state=queued|in_flight|handled|cancelled|needs_attention|skipped`.
Attempts and resolution history are ordered arrays; active attempt is nullable.
Owner cancellation requires queued, never-prepared state (empty attempts and no
active attempt) and the expected session revision. It preserves the full Message,
Answer, payload, counters and item/round history, saving cancelled state with an
`InputCancel` receipt and one session revision. No fabricated attempt, resolution
entry, time or reason accompanies cancellation. Exact operation replay still
precedes these mutable guards.

Attempt: `{id,purpose,repair_for_attempt_id,claim_request_id,binding_generation,prepared_at,formatted_payload,payload_sha256,wire_marker,
acceptance,acceptance_receipt,acceptance_observed_at,host_turn_id,turn_state,turn_observed_at,domain_result,
result_state,sealed_at,error,reconciliation_checkpoint}`.
`purpose=work|result_repair`; repair_for_attempt_id is null for work, otherwise
references an earlier completed attempt of the same input. The new attempt keeps
its own host turn and result. Its formatted_payload is persisted independently of
the immutable original Input.payload: a repair payload includes original attempt
ID, committed effects and repair-only instruction. payload_sha256 covers exactly
that submitted payload. Normal attempts render the original input plus context. A repair may reference verified original-attempt
replies/children without repeating their mutations. claim_request_id persists
the mapping (binding,generation,request_id) → exact attempt/payload receipt.
`acceptance=prepared|accepted|rejected|uncertain`;
`turn_state=unknown|running|completed|failed|interrupted`;
`result_state=pending|committed|missing`.
`HostReceipt={provider_reference,observed_at}` is nullable acceptance evidence;
`acceptance_observed_at` independently records observed acceptance/rejection/
uncertainty and is nullable. The canonical HostReceipt is reused by protocol DTOs.
`AttemptError={code,reason,retryable,observed_at}` and reconciliation checkpoint are
nullable. `Checkpoint` is opaque string, at most 4096 UTF-8 bytes, validated now
by its constructor/deserializer. Its schema `maxLength:4096` bounds characters
and is necessary but insufficient for the byte bound; no complete byte-semantic
parity is claimed. Provider reference/host turn identifiers remain opaque strings.
`domain_result` is null or `{operation_id,outcome,explanation,reply_message_ids,
followup_item_ids,handled_through_message_number,committed_revision,committed_at}`;
`outcome=answered|deferred|unable`. It belongs to one input+attempt, and becomes
immutable after first commit. Exact operation replay returns its receipt.

Core seals when turn=completed AND result=committed. Until then it can accept the
late domain result for that same still-open attempt; a wall-clock timeout alone
cannot seal. Host failures retain committed domain work. Resolutions are
append-only `{op_id,kind,reason,at,attempt_id,evidence}` with
`kind=retry_unexecuted|resend|skip|request_result_repair|confirm_evidence`.
Nullable `OwnerResolutionEvidence={source:owner_attestation,turn_state,
host_turn_id,owner_attested_idle,at}` preserves owner-supplied facts explicitly.
It cannot claim adapter-observed evidence or fabricate a committed agent result.
Recovery rules, including repair without redoing business work, are in queues.
No `received` bool or answer-fetch cursor controls dispatch.

### Typed operation receipts

`OperationReceipt={operation_id,actor_scope,command_digest:Sha256,result}`;
`actor_scope={kind:owner}|{kind:agent,binding_id}|{kind:adapter,binding_id}`.
`SavedReceipt={operation_id,session_id,revision,data}` has a tagged `data.kind`
union of exact saved outcome shapes:

| kind | data members other than kind |
| --- | --- |
| input_submit | input_id, message_id, message_number, answer_id nullable, input_seq |
| input_cancel | input_id, state |
| input_resolve | input_id, attempt_id, resolution_kind, state |
| topic_lifecycle | topic_id, topic_revision, archived_at nullable, cancelled_input_ids (omitted when empty) |
| session_lifecycle | state, closed_at nullable, archived_at optional, cancelled_input_ids (omitted when empty) |
| binding_connect | binding_id, generation, capabilities, setup_instruction |
| binding_state | binding_id, generation, dispatch_state, owner_paused, pause_reason nullable, connection_state |
| apply | allocated_refs, messages, item_revisions, topic_revisions, input_result_state nullable, queue_join_state nullable |
| claim | input_id, attempt_id |
| delivery_expiry | input_id, attempt_id |
| event | event_id, input_id nullable, attempt_id nullable, durable_effect |
| event_conflict | event_id, input_id nullable, attempt_id nullable |
| continuation | continuation: ContinuationReceipt |

Apply `messages` is an array of `{id,number}`, never parallel positional arrays.
`allocated_refs` is RequestRef-keyed with values
`{kind:topic,id:UuidV4}|{kind:item,id:ItemRef}|{kind:message,id:UuidV4}|{kind:round,id:UuidV4}`.
Item and topic revision maps have ItemRef and UUID keys respectively. Saved results
are typed records, never generic JSON. Command/query unions and actual replay
behavior belong to P0.6 and the core tasks.

## 3. Domain invariants and transitions

- Topic and parent exist, agree, and are in this session; allocated hierarchical
  references and parent links agree. No parent cycles, orphans or duplicate IDs.
- Agent mutations require a registered non-disconnected binding and current
  generation. Source input/attempt must match that binding; closed attempts allow
  exact replay only. Terminal-originated updates have null input/attempt, but
  still require a binding. Cwd or 'most recent session' is never a routing rule.
- Agent operations with an Ariadne input must acknowledge that input's owner
  message number. Closing/replacing an item cannot skip a newer unhandled owner
  message targeting it. Return `unhandled_owner_message` with IDs; agent can reply
  now but must handle the newer message before terminalizing the item. This guard
  considers live owner inputs still queued/in_flight/needs_attention. Handled,
  cancelled or skipped inputs and copied origin history do not block. Exemption
  never marks an input handled or rewrites history. Orphan live owner-input
  messages are invalid. Unissued owner bodies cannot be read/acknowledged by an
  earlier turn, so explicitly cancelling such an input must remove that blocker.
- Owner can message any unarchived item in an active session, including terminal
  items. Drop/reopen/bring are requests; only the agent decides the transition.
- Waiting selects waiting items with no Answer for the current question_revision
  whose input is neither cancelled nor skipped. An answered episode stays out of
  Waiting even after handling; only a new ask/revision makes it unanswered again.
  Sent shows inputs in queued/in_flight/needs_attention, one row per input, with
  links to its original question snapshot. A new ask on the same item can be in
  Waiting while an older input is in Sent. This never changes the item status.
- Item timelines deduplicate by message ID and include parent-creation context
  separately; rounds, replies, status history and references never silently prune.
- Archive always succeeds (ADR-0090): it cancels the owner inputs targeting the
  topic as close does, and items keep their status. Agent writes to an archived
  topic return `topic_archived`. Close session is one step (ADR-0088).
  Restore/reopen changes presentation lifecycle only.
- Full validation runs for every commit; expected revisions are per touched item,
  question, topic or session lifecycle, not unrelated snapshot edits.

### Pure item validation and transition seam

`ariadne-domain` publishes native Rust calls over canonical DTOs:

```rust
validation::validate_session_items(&Session) -> Result<(), ValidationError>
validation::validate_item(&Session, &Item) -> Result<(), ValidationError>
transitions::transition_item(
    &Session, &ItemRef, &ItemChange, &TransitionContext,
) -> Result<Item, TransitionError>
```

These calls perform no IO and never mutate their arguments. The session validator
checks item-tree identities, explicit parent/topic/reference agreement, parent and
replacement cycles, allocation counters, relevant message/round references and
individual prose bounds, including frozen round/answer/input snapshots. It is one
component of final store validation; history immutability, actor/source-attempt
scope, receipts, delivery/result joins and lifecycle guards remain their owning
history/core modules. `validate_item` expects its referenced messages, rounds and
bindings in the assembled session. Primitive constructors/deserialization already
reject invalid lexical references and duplicate JSON map keys.
An imported item's origin supplies source context for historical binding IDs,
which may be absent from the target session. Copied history retains those IDs;
live item owner/recipient and every new transition require registered target
bindings. No historical authorization or per-entry source chronology is inferred
from this reference check.

`ItemChange` is a native enum, not another serialized API DTO:

- `Edit { question: Option<String>, item_type: Option<ItemType>,
  note: Option<Option<String>>, links: Option<Vec<ItemLinkTarget>> }`.
  Outer `None` retains a field; `note: Some(None)` clears it.
- `Ask { ask: String, options: Vec<ItemOption>, recipient_binding_id: UuidV4,
  round_id: UuidV4 }`.
- `Status { status: ItemStatus, outcome: Option<String>, why: Option<String>,
  reason: Option<String> }`.
- `Replace { replacement: ItemRef, outcome: String, why: String }`.

`TransitionContext` contains `binding_id: UuidV4`, `generation: UuidV4`,
`cause_message_id: UuidV4`, `at: UtcMillis`,
`handled_through_message_number: NonnegativeSafeInteger`,
`expected_revision: PositiveSafeInteger` and
`expected_question_revision: Option<PositiveSafeInteger>`. Core assembles the
agent activity/reply cause message before calling; the helper requires matching
registered non-disconnected binding, current generation, agent cause authorship
and supplied revisions. A handled watermark cannot exceed that binding's issued
watermark. Closing/replacing reports newer unresolved live owner-message IDs
targeting the item, excluding handled/cancelled/skipped inputs and imported
history; an orphan live owner-input message is a validation failure. Core still
validates the source input/attempt and operation replay; owner
input save and host events do not invoke a domain status transition.

| Prior status | Edit | Ask | Status open/in_progress | Status decided/done/dropped | Replace |
| --- | --- | --- | --- | --- | --- |
| open/waiting_on_me/in_progress | allowed | allowed | reason required | fresh outcome + why required | outcome + why + valid target required |
| decided/done/dropped | allowed | first reopen with reason | reason required; clear terminal fields | fresh outcome + why required | outcome + why + valid target required |
| replaced | allowed | rejected | rejected | rejected | rejected |

`Status` never targets waiting or replaced: use `Ask` or `Replace`. Same-status
`Status` calls are allowed with the same required fields, revision and audit rules.
Every successful call increments item revision and deduplicates its cause-message
backlink. Status/Ask/Replace append history with old/new status and prior terminal
fields; reopening clears those fields only on the returned candidate. No child
status cascades. Terminal-to-terminal updates retain the previous outcome/why.

Each Ask, including waiting-to-waiting, increments question revision, sets owner
to me and starts a fresh waiting timestamp and round ID. The supplied round ID
must be unused. The caller/P1.2 closes the old round and constructs the canonical
new Round with frozen question/ask/options before inserting the item and running
assembled-session validation. The helper does not require that new round to exist
yet. Question edits and leaving a waiting episode increment question revision;
ordinary note/type/link edits do not. No existing parent/topic/ID can change.
Stored waiting items created with `item.add` may retain any valid explicit owner;
the owner-to-me rule belongs specifically to `item.ask`.

`ValidationError { path: String, kind: ValidationErrorKind }` returns a field path
without stored prose. Kinds are `Blank`, `Nul`, `TooLong { maximum_bytes: usize }`,
`TooMany { maximum: usize }`, `Duplicate`, `MissingReference`, `IdentityMismatch`,
`HierarchyMismatch`, `Cycle`, `CounterNotAhead` and `InvalidState`.
`TransitionError` variants are `Validation(ValidationError)`, `MissingItem`,
`StaleRevision`, `StaleQuestionRevision`, `MissingBinding`, `DisconnectedBinding`,
`StaleGeneration`, `InvalidCauseMessage`, `InvalidTransition`, `MissingReason`,
`UnhandledOwnerMessages { message_ids: Vec<UuidV4> }`, `InvalidHandledWatermark`
and `CounterOverflow`. Entry points map these typed failures to their shared API
error vocabulary; they do not copy a local validation contract.

See [ADR-0021](../../adr/ADR-0021-pure-item-transitions.md).

## 4. Transaction and lock algorithm

All writers use the synchronous native `ariadne_store::session::Store` seam:

```rust
Store::open_registered(&Path, project_id: UuidV4) -> Result<Store, StoreError>
Store::create(&Session) -> Result<(), StoreError>
Store::read(&UuidV4) -> Result<Session, StoreError>
Store::transact<E>(
    &UuidV4, &ReceiptActorScope, &UuidV4, &serde_json::Value,
    impl FnOnce(&mut Session) -> Result<SavedReceiptData, E>,
) -> Result<SavedReceipt, TransactionError<E>>
```

Trusted registry wiring selects the canonical project root and project UUID;
opening verifies existing `project.json` identity. The root is never a renderer
command path. Session UUIDs generate filenames, and create validates matching
project/session identity under the same stable lock and rejects any existing
target. First creation has no previous snapshot and publishes the synced
temporary file with directory-relative
`linkat`, which atomically rejects any target appearing after the initial absence
check; it then removes the temporary name and syncs the sessions directory.
Failures after publication return `commit_uncertain`; existing target bytes
remain unchanged on a creation conflict. Core owns setup metadata and
the registry, authorization, expected revisions, timestamps/IDs and meaningful
domain/history assembly inside the callback. Callbacks perform local domain
work without host, socket, inference or lease waits.

The JSON argument is ephemeral normalized command input, never a persisted
arbitrary command or success shape. Core supplies explicit defaults, expected
revisions and exact text, excluding transport IDs. Store adds project/session
routing and canonical actor scope, then hashes the recursively sorted tuple.
The operation UUID selects the actor-scoped receipt; it is not part of that
command digest. Durable results remain the canonical typed receipt union.

Read-only snapshots capture owned bytes under the same stable session mutex/file
lock and directory-relative safety checks. They release those guards and any
enclosing project lock before decoding and fully validating the capture. Project
metadata identity is still checked before coordination files can be created.
No unvalidated snapshot reaches a caller. Locked byte capture is the read's
freshness observation point; a subsequent writer does not change its owned bytes.
Catalogue captures preserve per-session errors and diagnostic no-write behavior.
This does not change the mutation algorithm below; see
[ADR-0065](../../adr/ADR-0065-validate-captured-reads-outside-storage-locks.md).

The transaction follows this algorithm:

1. Resolve project/session from registered IDs, not arbitrary renderer paths. Open the data root and the project's `projects/<id>` descendants with no-follow checks; the registered canonical root must still exist as a real directory. Reject symlinked store/lock targets and unsafe filesystem types; account for path-to-use races using directory-relative opens in the OS module.
2. Open stable `locks/<session>.lock` and acquire `flock(LOCK_EX|LOCK_NB)` in a bounded retry loop: 10 ms initial, cap 50 ms, deadline 2 s. Never rename/delete the lock file. Failed lock returns `store_busy` and no effects.
3. Re-read live snapshot under the lock, enforcing schema/structural/semantic checks without introducing a snapshot hard cap. Compute idempotency key `(actor_scope,op_id)`; canonical digest is SHA-256 of the normalized route/actor/command tuple (sorted keys, explicit defaults, exact text). Exclude transport request IDs; include routing, actor scope and expected revisions.
4. If a receipt exists: same digest returns its saved result even if current revisions differ; different digest is `operation_reused`. Otherwise validate authorization, revisions and transitions, then apply to an owned copy.
5. Core's callback supplies message IDs/times and business effects. Store preserves session/project identity and pre-existing receipts, increments session revision once, records the typed receipt, validates the candidate and serializes deterministically. Never hold a session lock across provider/network waits.
6. Write candidate with mode 0600 to same-directory exclusive temp file; write_all and fsync. Write/sync previous validated live bytes to a temporary backup and rename into `backups/<session>.previous.json`; sync backup directory. First creation has no previous backup.
7. Rename candidate over live file and sync sessions directory. If rename succeeded but sync failed, return `commit_uncertain` with op ID. Retry re-reads receipt to resolve it. It must not blindly repeat the mutation.
8. Release lock; publish invalidation hints only after commit. Slow UI or dead watchers do not roll back a saved command.

Native event transactions use the same lock/reread/validation/atomic saver and
scan full opaque event ID plus adapter actor. Exact successful or conflicting
proposal replay precedes new command guards. `Unchanged` requires a structurally
unchanged candidate and has no UUID allocation, receipt or revision. Core can
commit `EventConflict` and its original-scope recovery barrier atomically before
returning `protocol_conflict`; original event facts and receipts remain retained.
There is no hashed event UUID, additional index, TTL or pruning.

Current store validation composes typed shape/primitive decoding, P1.1
`validate_session_items`, P1.2 `validate_session_history`, P2.2
`validate_session_delivery` and receipt bucket/result identity, revision bounds and
actor-scope uniqueness. Delivery validation checks saved identity/backlinks,
receipt attempt scope and canonical prepared marker/LF/full-byte digest, retaining
historical/sealed/repair records. Core/history helpers own append-only assembly,
authorization and delivery joins; these checks do not claim future lifecycle or
recovery state machines. Owning tasks extend pure validation as behavior appears. Store errors separate ordinary
IO/path failures, invalid/future data, identity mismatch, item/history validation,
busy/poisoned locks, existing creation, operation reuse, counter overflow and
uncertain commit. `TransactionError::Command(E)` preserves core's typed rejection
without saving the abandoned candidate. Entry points map these to shared API
errors. See [ADR-0025](../../adr/ADR-0025-locked-session-transactions.md).

One session lock at a time; intra-process keyed mutex plus OS `flock`. Registry
and binding setup use global-registry → project-metadata → session lock order.
Keep registration simple: under the registry lock, validate existing project
metadata, locate an existing matching binding in its session files, then write
missing metadata/session/index entries using atomic file replacement. Persist
binding identity in the session before updating the rebuildable index. Repeat
connect checks existing identities before creating another binding. No bootstrap
journal, automatic interrupted-setup repair or distributed transaction is required.
If metadata is inconsistent, stop connection and show the affected path; do not
route messages by guessing. No lock is held across a host call or inference.

Native `Registry::open` accepts a trusted selected home. Its private schema-1
project registry retains canonical roots/UUIDs and local-setup receipt digests;
first persisted revision is 1. Registration derives only the first display name
from the canonical UTF-8 root basename under the metadata lock and preserves an
existing name. A separate schema-1 binding index uses typed host identity tuples.
Complete rebuild scans only explicit registered roots and validated session files.
Unavailable roots remain registered; duplicate metadata or selected routes stop
with affected paths. Missing/stale typed-valid index data can be rebuilt, while
malformed/future index or authoritative data remains unchanged with a typed error.

First session plus owner receipt uses `Store::create_with_receipt` at revision 1
and the same canonical route/actor/command hashing and no-clobber publication.
Session commit precedes index publication. Post-commit index failure reports
`commit_uncertain` with the operation ID; exact retry refreshes the index and
returns saved IDs/generation without another session mutation. There is no
journal, staged bootstrap transaction or automatic corruption repair.
See [ADR-0026](../../adr/ADR-0026-register-roots-and-verify-binding-setup.md).

## 5. Capacity, queries and errors

Owner preferences use fixed global `ui.json` and stable sibling `ui.lock` in the
verified owner data root. Core strictly validates its canonical snapshot plus
retained owner operation/digest/typed preference receipts under that lock; Store
provides only fixed-file anchored IO and atomic publication. Absent preferences
return revision1 defaults without creating a data file. First patch saves
revision2; exact replay precedes mutable revision guards and never writes. First
publication is no-clobber; replacement fsyncs a validated `ui.previous.json`
backup before publication and directory sync. Malformed/future records remain
untouched. The canonical framed preference response stays within1MiB, while
full receipt history has no invented aggregate file quota or pruning. Drafts
and stale/unavailable view routes remain inert and preserved during unrelated
writes. Explicit owner reset/recovery and consuming native wiring remain their
own acceptance joins; see [ADR-0041](../../adr/ADR-0041-native-core-and-owner-preferences.md).

Warn at 16 MiB per session to surface unexpectedly large personal history. There
is no first-version snapshot hard cap, item/message quota or reserved-byte ledger.
Keep bounded individual requests/messages below, and never silently truncate saved
history. Add scale limits only with a demonstrated need and a clear user flow.
Questions/ask/outcome/why each ≤4 KiB; note ≤4 KiB; owner input ≤16 KiB; full agent
reply ≤64 KiB; 12 options each label/consequence≤1 KiB; 32 links/item each target
≤4 KiB. 100 pending inputs/session. Operation batch≤100, serialized request≤512
KiB. Response page≤100 entities/1 MiB; a single fixed entity projection≤768 KiB
including escaping. Large histories/backlinks are separate paginated queries.
No silent truncation of durable content. Diagnostic output is separately bounded.

These individual content limits count UTF-8 bytes, not characters. Required
question/ask/outcome/why and option label/consequence are nonblank; optional note
may be absent or empty. NUL is rejected and prose is otherwise preserved exactly.
An option-only owner answer may preserve empty/whitespace submitted text in its
Message body, Input payload and Answer text. The Message exception requires a
canonical Answer with the same message/input/item and a selected option present
in its frozen options; other owner messages and agent replies remain nonblank.
History/core separately enforce complete answer/payload linkage and snapshots.
The pure item validator also enforces the existing 4 KiB endpoint-fingerprint
bound. It introduces no blanket bound for unrelated names, labels or opaque host
IDs. Request/batch/query limits and pending-input capacity are enforced by their
core/protocol/query owners, not by this item-tree seam.

No result/control capacity reservations. A write error returns failure, keeps
the last saved data, and pauses dispatch until writes succeed. Keep unsent drafts;
do not acknowledge a save that exists only in memory. No full-disk remediation,
automatic lost-data recovery or deliberate power-loss testing is required now.

Queries use `QueryCursor`, the structured sequence/keyset cursor
`{schema,view,filter_digest,after,revision}`. Bounded collections return the shared
`Page<T>={items:T[],next_cursor:QueryCursor|null,snapshot_revision}`; nested round
message collections use their own `Page<Message>`. Rust-generated domain types
own both shapes; no opaque-string cursor or consumer-local entity copy is added.
Single-session queries reject mismatched filters. Aggregate queries bind the full
captured inventory (registered roots, current verified Project metadata, session
revisions and availability) plus actor/route/filter in filter_digest; any digest
mismatch, including changed aggregate filters, returns snapshot_changed. Their
positive revision is the captured registry revision or one for an empty registry.
Current-page counts and rows share captured snapshots; if session revision
changes between pages, return `snapshot_changed` so UI restarts rather than
mixing histories. `session_get` may return the full validated snapshot to local
Tauri; agent tools use bounded projections.

`QueryCursor.schema=1`, `filter_digest:Sha256`, `revision:positive_safe_integer`;
`after` is null or a `kind`-tagged `CursorPosition`:
sequence `{number,id}`, topic `{order,id}`, item `{ordinals:positive_safe_integer[],id:ItemRef}`,
round `{ordinal,id}`, project `{canonical_root,id}`, session
`{updated_at,project_id,id}`, history `{index:nonnegative_safe_integer}`, or result
`{input_seq,attempt_ordinal,input_id,attempt_id}`. UUID IDs are lexical primitives.
Ordinal paths are derived from explicit parent+ordinal data, never ItemRef parsing.
`view=projects|sessions|topics|items|messages|inputs|item_messages|item_rounds|
round_answers|round_owner_messages|round_agent_messages|round_results|round_forks|
item_status_history|item_updated_messages`. Nested views identify continuation
cursor scopes within existing queries; they add no endpoints. Execution validates
the view, filter, sort key and snapshot revision together.

ProjectSummary carries required project_id and required nullable project.
Available requires matching current verified Project metadata; Unavailable may
retain verified metadata when session reads fail, or null when metadata itself
is unreadable. Partial counts identify only known unreadable session IDs; [] is
valid when the catalogue is unknown. Reads preserve authoritative content and
do not create missing session/backup directories; only genuine catalogue absence
is complete empty data. Existing stable coordination locks may be created.
Nested pages reserve the fixed parent and truthful continuations, prioritize
requested families, then defaults. A deferred default can be empty with an
after:null continuation; explicitly selecting it progresses when a complete
entity fits. No saved historical body is truncated. See ADR-0033.

## 6. Continuation, repair and migration

Item/Message/Round `origin`, when copied, is
`{project_id,session_id,topic_id,entity_id,source_revision}`; original entities
have null origin. Item entity_id is an ItemRef; message/round entity_id is UUID.
MessageOrigin additionally carries required `source_target`
`{project_id,session_id,topic_id,item_id,round_id}` (the last three nullable) and
`author,binding_id,adapter_id,external_session_id`
with the three identity strings/IDs nullable, preserving actual source authorship.
Copied message author/binding provenance never becomes that of the target agent.
`ContinuationReceipt={operation_id,source_project_id,source_session_id,
source_topic_id,source_revision,source_sha256,target_topic_id,target_input_id,
item_id_map,message_id_map,round_id_map,answer_id_map,summary,confirmed_at}`.
The item map is ItemRef→ItemRef; all other old→new maps are UUID→UUID.
These maps, summary and confirmed time are immutable. Answers retain source
lineage through their receipt map rather than an additional invented origin field.
Origin routes retain IDs when the source is offline;
the UI displays unavailable-source metadata and the complete local copy. Copied
messages preserve original author identity in origin metadata and do not claim
the target agent authored them. Live target binding IDs are not retroactively
substituted for source authors. Round has an origin field as well.

A copied Reply whose direct item is outside the copy retains its kind/full body and qualified `source_target`, with all local
topic/item/round pointers null. Only exact continuation-map and origin validation
permit this provenance-only form; live Replies remain strictly targeted. Included
direct pointers must match source mappings. Recopying that form preserves its
original qualified source target, while a normally targeted copy may record its
immediate source route. Activity/Lifecycle contextual topic grouping stays intact.
These source pointers never grant target routing/authority or create item
conversation links through `items_touched`.

The native `HistoryActionService` implements archive/restore, close/reopen,
read-only preview and target-only continuation. Archive is one step (ADR-0090): it
cancels the topic's queued inputs, abandons its in-flight and needs-attention
inputs, and lists them in `cancelled_input_ids`. Close is one step (ADR-0088). In one commit it records an
owner pause on the active binding, cancels queued inputs and abandons in-flight and
needs-attention inputs, and leaves items as they are. Reopen clears that owner
pause. Restore/reopen preserve domain/delivery history and IDs. CLI/CoreService
consumer routing is a separate composition task.

Continue is a **copy**, not shared mutable topic membership. Read a validated
source snapshot and include source revision/hash in preview. An archived source
session must be restored before continuing; a closed unarchived source remains
eligible. Owner chooses an
existing bound target session and confirms. Under target lock allocate new topic,
items, messages and rounds; remap all internal refs in two passes; preserve full
bodies and origin references. Continue is the owner's action, so terminal copies
stay terminal and within-topic replacements retain their live remapped links
(ADR-0093). External replacements become Dropped with their original link and
completion preserved in source-qualified history; preview explains that import.
Unanswered Open/InProgress asks without a current round become Waiting on me with
a fresh owner answer round. Answered episodes and pending Ack proposals stay intact.
Atomically add continuation receipt and a topic-targeted input containing the
approved summary. Source remains untouched; no two-session transaction or hidden
retargeting. Duplicate operation returns the original mapping. Source changed
since preview returns `preview_stale` before any target mutation; origin is the
validated snapshot revision even if source changes just after that check.

The canonical hash covers deterministic full Session serialization plus selected
topic ID; unrelated source revision changes conservatively stale the preview.
Target receipt replay occurs before source IO and again under the target lock.
The stable locked read captures immutable source bytes and is the freshness
observation/linearization point. After releasing the lock, decode and fully validate
those bytes, then check the owned snapshot's hash/revision before the sole target transaction. There are
no simultaneous session locks, source publication or cross-file journal. Reject source == target.
Two-pass maps include answers as well as topics/items/messages/rounds. Only live
Agent owner/recipient routing moves to the explicitly selected target binding;
Me/Other owners and source authorship/history remain. The preview discloses this
assignment and each imported external replacement transformation.

The concise owner-approved summary is bounded by the existing 16KiB UTF-8
OwnerInput limit, while full copied bodies remain complete separate history. The
staged target input passes the actual delivery formatter's 64KiB payload bound
before publication. Its frozen context points to the immutable continuation
operation/mapping; it does not duplicate every copied body's IDs or copy source
inputs/attempts/delivery authority. Oversized summaries/payloads, target conflicts
and definite prepublication failures save no target entities or handoff.

Unavailable projects stay registered and show their missing path. Initial
registration/forget and reconnect to a known project are enough for normal use.
Automatic relocation, copied-project identity remapping, registry-repair UI and
cross-file crash recovery are later work. Never silently merge matching UUIDs.

Invalid data returns an error and is not overwritten. A previous validated
snapshot may be kept by the write algorithm, but no repair wizard or automatic
restoration is required. Keep schema_version and reject unknown future versions
for writes. Add a concrete migration and its test when the first real stored
schema changes; no generic migration registry is needed beforehand. Uninstall
preserves session files and backups.

## Recoverable agent removals (Alpha.12, ADR-0097)

Item and Topic have optional `removed_at` and `removed_by` fields, omitted in old
and ordinary records. `removed_by` is `{binding_id,message_id}`, pointing to the
acting agent and the saved lifecycle notice. Only a selected item subtree root
or topic receives the marker; descendants inherit removal through their parent
chain and topic. Markers do not change statuses, acknowledgments, owner text,
questions, answers, rounds, ordering or provenance. Restore clears the marker,
keeping the entire prior state and leaving cancelled inputs cancelled.
Queued inputs with earlier accepted attempts remain held while their work is
removed. The bin retains their text and warns that they send if restored; Restore
states how many become eligible to send. Recovery refuses resend and retry on
removed work until it is restored.

Effective removal excludes work from ordinary counts, Waiting, acknowledgments,
Sent, tree, graph and search. Raw owner session snapshots retain every record for
the bin and its conversation. A removed topic appears only in the session's
folded Removed by agent group; removed item subtrees appear in the topic's folded
group. Each deletion saves an owner notice and receipt with question and cancelled
message counts. The owner can Restore or use existing permanent Remove.

Saved related/replaced_by references across the bin remain valid. Live projections
skip removed destinations and expose them again after Restore. Continuation
refuses a removed source topic and copies only effectively live items. References
are remapped only within the copied set; external related links are omitted and
replacement links outside it use the existing imported-drop behavior. Source
history and removed work stay untouched.
