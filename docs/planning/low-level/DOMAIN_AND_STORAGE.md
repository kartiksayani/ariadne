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
relaxed or measured write latency/capacity fails the stated targets. It would
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
<project>/.ariadne/
  project.json                   # schema_version, id, display_name
  sessions/<session_uuid>.json    # canonical domain + delivery snapshot
  locks/<session_uuid>.lock       # never renamed/deleted
  backups/<session>.previous.json
  backups/<session>.v<old>.<uuid>.json # future concrete migration only
~/.ariadne/
  projects.json                  # registered canonical roots + IDs
  bindings.json                  # host identity → session/binding index, rebuildable
  adapters/                      # reserved for deferred executable registrations
  ui.json                        # preferences, drafts, tabs, local Later flags
  run/                           # private control socket, leases, presence
```

Project: `{schema_version:1,id,display_name}`.

Session: `{schema_version:1,id,project_id,title,state,created_at,updated_at,
revision,closed_at,counters,active_binding_id,topics,items,messages,rounds,
answers,bindings,inputs,operation_receipts,continuations}`.
`state=active|closed`. Counters: `next_root,next_topic_order,next_message,
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

Item: `{id,ordinal,topic_id,parent,question,type,status,owner,revision,
question_revision,next_child,ask,note,options,links,outcome,why,replaced_by,
created_at,updated_at,created_message_id,updated_message_ids,status_history,
waiting_since,recipient_binding_id,current_round_id,source_round_id,origin}`.
`type=question|decision|finding|task|explanation`;
`status=open|waiting_on_me|in_progress|decided|done|dropped|replaced`.
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
Only the agent's validated domain operation changes an item status. Owner input
save, transport acknowledgement and host completion never do so.

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

### Binding and presence

Binding: `{id,adapter_id,adapter_version,protocol_major,config_version,
external_session_id,endpoint,endpoint_fingerprint,generation,created_at,
dispatch_state,owner_paused,pause_reason,connection_state,capabilities,active_input_id,issued_through_message_number,adapter_config}`.
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
Do not treat the user's text as permission to run arbitrary tools.
`state=queued|in_flight|handled|cancelled|needs_attention|skipped`.
Attempts and resolution history are ordered arrays; active attempt is nullable.

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
union of exact saved success shapes:

| kind | data members other than kind |
| --- | --- |
| input_submit | input_id, message_id, message_number, answer_id nullable, input_seq |
| input_cancel | input_id, state |
| input_resolve | input_id, attempt_id, resolution_kind, state |
| topic_lifecycle | topic_id, topic_revision, archived_at nullable |
| session_lifecycle | state, closed_at nullable |
| binding_connect | binding_id, generation, capabilities, setup_instruction |
| binding_state | binding_id, generation, dispatch_state, owner_paused, pause_reason nullable, connection_state |
| apply | allocated_refs, messages, item_revisions, topic_revisions, input_result_state nullable, queue_join_state nullable |
| event | event_id, input_id nullable, attempt_id nullable, durable_effect |
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
  now but must handle the newer message before terminalizing the item.
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
- Archive requires every topic item terminal and no queued/in-flight/unresolved
  input targeting it. Close session requires all items terminal, no unresolved
  inputs and dispatch paused. Restore/reopen changes presentation lifecycle only.
- Full validation runs for every commit; expected revisions are per touched item,
  question, topic or session lifecycle, not unrelated snapshot edits.

## 4. Transaction and lock algorithm

All writers call `Store.transact(SessionRef, ActorContext, op_id, command)`:

1. Resolve project/session from registered IDs, not arbitrary renderer paths. Open canonical root and `.ariadne` descendants with no-follow checks. Reject symlinked store/lock targets and unsafe filesystem types; account for path-to-use races using directory-relative opens in the OS module.
2. Open stable `locks/<session>.lock` and acquire `flock(LOCK_EX|LOCK_NB)` in a bounded retry loop: 10 ms initial, cap 50 ms, deadline 2 s. Never rename/delete the lock file. Failed lock returns `store_busy` and no effects.
3. Re-read live snapshot under the lock, enforcing size/schema/structural/semantic checks. Compute idempotency key `(actor_scope,op_id)`; canonical digest is SHA-256 of normalized command JSON (sorted keys, explicit defaults, exact text). Exclude transport request IDs; include routing, actor scope and expected revisions.
4. If a receipt exists: same digest returns its saved result even if current revisions differ; different digest is `operation_reused`. Otherwise validate authorization, revisions and transitions, then apply to an owned copy.
5. Increment session revision once, generate message IDs/times, record receipt, validate candidate and serialize deterministically. Never serialize with a session lock held across provider/network waits.
6. Write candidate with mode 0600 to same-directory exclusive temp file; write_all and fsync. Write/sync previous validated live bytes to a temporary backup and rename into `backups/<session>.previous.json`; sync backup directory. First creation has no previous backup.
7. Rename candidate over live file and sync sessions directory. If rename succeeded but sync failed, return `commit_uncertain` with op ID. Retry re-reads receipt to resolve it. It must not blindly repeat the mutation.
8. Release lock; publish invalidation hints only after commit. Slow UI or dead watchers do not roll back a saved command.

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

## 5. Capacity, queries and errors

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

No result/control capacity reservations. A write error returns failure, keeps
the last saved data, and pauses dispatch until writes succeed. Keep unsent drafts;
do not acknowledge a save that exists only in memory. No full-disk remediation,
automatic lost-data recovery or deliberate power-loss testing is required now.

Queries use `QueryCursor`, the structured sequence/keyset cursor
`{schema,view,filter_digest,after,revision}`. Bounded collections return the shared
`Page<T>={items:T[],next_cursor:QueryCursor|null,snapshot_revision}`; nested round
message collections use their own `Page<Message>`. Rust-generated domain types
own both shapes; no opaque-string cursor or consumer-local entity copy is added.
Reject mismatched filters. Current-page consistency is one snapshot; if revision
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

## 6. Continuation, repair and migration

Item/Message/Round `origin`, when copied, is
`{project_id,session_id,topic_id,entity_id,source_revision}`; original entities
have null origin. Item entity_id is an ItemRef; message/round entity_id is UUID.
MessageOrigin additionally carries `author,binding_id,adapter_id,external_session_id`
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

Continue is a **copy**, not shared mutable topic membership. Read a validated
source snapshot and include source revision/hash in preview. Owner chooses an
existing bound target session and confirms. Under target lock allocate new topic,
items, messages and rounds; remap all internal refs in two passes; preserve full
bodies and origin references. External replacement links remain provenance links,
not invalid live replacement edges (copy terminal replaced items as dropped with
explicit imported outcome if target is outside copied topic; show preview).
Atomically add continuation receipt and a topic-targeted input containing the
approved summary. Source remains untouched; no two-session transaction or hidden
retargeting. Duplicate operation returns the original mapping. Source changed
since preview returns `preview_stale` before any target mutation; origin is the
validated snapshot revision even if source changes just after that check.

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
