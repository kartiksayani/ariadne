# Domain model and storage algorithms

This document fixes schema semantics before Rust/TypeScript/schema generation. Field names are snake_case on Ariadne interfaces. Provider wire formats keep their own names inside adapters.

## 1. Primitive conventions

- UUID v4 lower-case strings: project/session/consumer/run/input/answer/operation/request IDs. Host IDs are opaque strings, never filesystem names. Host request IDs may be string or integer; preserve their JSON type and namespace by run/connection epoch.
- Persist sequence numbers/revisions as unsigned integers capped at `2^53-1` so TypeScript represents them exactly. Checked increment fails on exhaustion. Sequences start at 1. UI time is never an ordering source.
- RFC3339 UTC timestamps assigned by core clock; persisted precision milliseconds. Timeouts use monotonic clocks while a process lives; expiry after restart cancels requests instead of extending them accidentally.
- Empty collections are present; optional scalars use null. Unknown fields in application commands fail validation. Unsupported snapshot schema versions are read errors; no best-effort writeback.
- Text is preserved as UTF-8, apart from rejecting NUL/invalid encoding and treating whitespace-only required content as empty. Never normalize an owner's text or interpolate it into shell commands. Sizes mean UTF-8 bytes.
- Named IDs such as `4.2` are item references, not paths. Root number is unique across the entire session, even across topics. Roots and each parent's child suffixes increase monotonically; numeric segment ordering, never lexicographic ordering.

## 2. Persistent session shape

One `<project>/.ariadne/sessions/<session_uuid>.json` contains the fields below. Maps keyed by ID avoid ambiguous duplicate entries; serialize in deterministic key order. Ordered views use explicit numeric order/sequence, not JSON map order.

| Field | Shape and ownership |
| --- | --- |
| `schema_version`, `id`, `project_id` | `1`, UUID, UUID; immutable |
| `title`, `created_at`, `updated_at`, `revision` | Human title (256 bytes), timestamps, transaction revision |
| `counters` | `next_root`, `next_topic_order`, `next_message`, `next_answer`; allocated only in core |
| `topics` | ID → `{id,name,order,created_at}`; name ≤256 bytes |
| `items` | Hierarchical ID → Item below |
| `messages` | Array ordered by `number`; Message below |
| `answers` | Array ordered by `seq`; Answer below |
| `consumers` | UUID → Consumer below |
| `runs` | UUID → Run below; old run metadata retained |
| `outbox` | UUID → Input below; input sequence scoped to consumer |
| `host_requests` | Local UUID → HostRequest below |
| `operation_receipts` | `(actor_scope,op_id)` → `{input_sha256,result,committed_revision,created_at}` |

### Item

`id`, `topic_id`, `parent`, `question`, `type`, `status`, `owner`, `revision`, `question_revision`, `next_child`, `created_at`, `updated_at`, `created_in_message`, `updated_in_messages`, `links`, `options`, `status_history`, `outcome`, `why`, `replaced_by`, `waiting_since`, `recipient_consumer_id`, `last_answer_seq`.

`owner` is `{kind:"me"}`, `{kind:"agent",consumer_id}`, or `{kind:"other",name}`. Types and statuses stay exactly those in PRODUCT. `question_revision` changes only when question/options/recipient or answerability changes, not when delivery receipts or unrelated children change. Item `revision` changes for every item mutation. A waiting re-entry increments question revision even if wording matches an earlier question. This prevents accepting an old draft in a new waiting episode.

Options are `{id,label,consequence,recommended}` with item-local stable string IDs. Replacing an option set preserves previous options in answer snapshots/history. Links are `{kind,label,target}` and are display/copy-only. Terminal state fields are nullable on active items and mandatory on terminal items. `status_history` holds `{from,to,at,message_number,previous_outcome,previous_why,previous_replaced_by}`; changes are append-only. `waiting_since` exists only during the current waiting episode.

### Message and answer

Message: `{number,author,consumer_id,run_id,host_turn_id,source_input_id,timestamp,excerpt,items_touched}`. All IDs except number/author/time/excerpt/items are nullable where inapplicable. Author is `me|agent`; permission audit records do not masquerade as conversation messages. One agent `apply` creates one message; retries create none. `items_touched` is a deduplicated set rendered in numeric ID order.

Answer: `{id,seq,item_id,question_revision,question_snapshot,options_snapshot,selected_option_id,text,recipient_consumer_id,created_at,message_number,supersedes_answer_id,input_id}`. At least one of selected option/nonempty text. Both may coexist. The answer references its owner's submission input. An answer never changes after creation; a correction is another answer with its own input and sequence. Corrections are allowed while the item is active and target the latest answer in that correction chain. Terminal items require explicit agent reopening first.

### Consumer and run

Consumer: `{id,agent,mode,label,created_at,last_seen_at,host_conversation_id,next_input_seq,active_run_id,active_input_id,dispatch_state,issued_answer_ids,acknowledged_answer_ids}`. `agent=claude|codex`; `mode=managed|external`; `dispatch_state=enabled|paused|recovery_required`. Host conversation ID may be null only before initialization. A consumer's agent/mode never changes in-place. Sets are arrays in JSON with uniqueness validation. Receipt timestamps/evidence can be stored in keyed companion `answer_receipts` within the consumer.

Run: `{id,consumer_id,worker_instance_id,connection_epoch,executable_path,executable_version,launch_profile_id,launch_profile_digest,host_conversation_id,state,started_at,ended_at,terminal_reason,process_identity,active_host_turn_id,cleanup_confirmed}`. `process_identity` contains pid, process start-time identity, process group and executable identity for diagnostics/reconciliation; a pid alone never authorizes a signal. No credentials or inherited environment dump.

Live states: starting/idle/running/awaiting_permission/stopping/stopped/failed/recovery_required. An outstanding native question is represented by a `host_request`; it pauses ordinary dispatch while the run remains running. On restart persisted liveness is historical, pending reconciliation. Connection epoch is fresh per provider connection; old responses cannot cross epochs.

### Input/outbox

Input: `{id,consumer_id,input_seq,kind,route,prompt,answer_ids,related_item_ids,host_request_id,request_run_id,created_at,message_number,dispatch_status,turn_status,attempts,host_turn_id,completed_at,cancellation_reason,resolutions}`.

- `kind=prompt|answers`; prompt payload or answer IDs, never conflicting payloads.
- `route=turn|host_response|external_fetch`. Ordinary owner messages and Ariadne answers use turn; native host input uses host_response; terminal integrations use external_fetch.
- `dispatch_status=queued|sending|accepted|uncertain|failed|cancelled|acknowledged`. `acknowledged` applies only after all included answers have receipts. It does **not** mean the host turn finished.
- `turn_status=not_started|running|completed|failed|interrupted|uncertain|not_applicable`. Only successful completion permits automatic next ordinary input. Native responses/external fetch have not_applicable.
- Attempt: `{id,run_id,connection_epoch,prepared_at,wire_input_id,payload_sha256,answer_ids,accepted_at,acceptance_evidence,error}`. Do not store another copy of text. Every retry attempt is recorded; owner-approved resend retains the same logical input/answer IDs.
- Resolution: `{operation_id,kind,at,reason,previous_dispatch_status,previous_turn_status,attempt_id}`; append-only, `kind=retry_unexecuted|resend|do_not_resend`. These owner decisions never create an agent acknowledgment or turn success. A do_not_resend resolution removes that input's FIFO barrier while retaining its actual failure/uncertainty. A later resend reopens it explicitly and is forbidden after a subsequent input has begun.

### HostRequest

`{id,consumer_id,run_id,connection_epoch,provider_request_id,provider_request_kind,kind,questions,display_payload,payload_sha256,created_at,expires_at,revision,state,response,responded_at,return_evidence}`. Native `questions` is an ordered array of `{provider_question_id,header,prompt,options,allow_free_text,item_id,answer_id}`; it is empty for permissions. IDs are unique within a request, max8 questions. Preserve provider choice labels and question IDs exactly. `answer_id` starts null and is assigned on grouped owner submission. This maps each source question to one item and makes duplicate notifications idempotent without text matching.

`kind=permission|user_input`; `state=pending|decided|returned|expired`. Permission response is `{decision:allow_once|deny}`; Cancel maps to deny/cancel plus Stop only when the owner chooses Stop. Native user input uses a distinct typed answer map. The request display payload and response are bounded; no arbitrary raw protocol object is persisted. A returned response records transport evidence, not proof that the tool succeeded.

For native multi-question input, v1 UI requires an answer to every displayed question before a single Submit answers action. This is Ariadne policy, not an invented provider `required` field. Drafts persist in UI preferences; no partial answer is sent. `user_input.respond` validates request/epoch plus all item question revisions, then atomically creates all Answer records, one owner Message, one `host_response` Input containing all answer IDs, and the complete HostRequest response map; sets question items in_progress and request decided. Duplicate operation returns the same group. Native question items reject ordinary `answer.submit` and route the UI to this grouped form.

## 3. Mutations and conflicts

| Command | Preconditions and atomic effects |
| --- | --- |
| `topic.add` | Unique operation; allocate UUID + order |
| `item.add` | Topic/parent exist and agree; allocate root/child suffix; validate type/status/options/recipient; add creation message backlink |
| `item.update` | Expected item revision; patch only question/type/owner/options/links through allowed transitions; cannot change id/topic/parent |
| `item.wait` | Active item, prompt/options/recipient valid; set me/waiting_on_me and new question revision/episode |
| `item.close/drop` | Expected revision, terminal outcome + why, no unhandled answer; append history |
| `item.replace` | Target exists or batch local ref, same session, not self/cycle; preserve old meaning, record replacement |
| `item.reopen` | Terminal decided/done/dropped; nonempty reason, history snapshot, clear current terminal fields; replaced cannot reopen |
| `answer.submit` | Waiting item + expected question revision; validate chosen option; create answer/message/input and transfer item to in_progress with designated agent owner |
| `answer.correct` | Active item, latest answer + expected question revision; append correction/message/input; never silently overwrite |
| `answer.ack` | Bound consumer, eligible fully issued IDs; idempotent receipts; advance related outbox receipt state without implying turn completion |
| `permission.respond` | Owner actor, exact run/epoch/request revision, pending + unexpired; commit decision only |
| `input.cancel` | Owner actor, queued/not_started prompt only; terminal tombstone remains; answer correction uses answer.correct instead; already sending requires Stop/recovery |
| `input.retry` | Owner actor, exact failed input/attempt/revision, authoritative pre-execution rejection, no active turn or unresolved process; append retry_unexecuted resolution, reset delivery to queued and turn to not_started, retain IDs/seq/content/old attempts; dispatch remains paused |
| `delivery.resolve` | Owner actor, unresolved uncertain/failed/interrupted input, no active turn or unresolved process; explicit resend or do_not_resend plus reason. Resend resets queued/not_started while retaining attempts and IDs; do_not_resend preserves factual states but releases its FIFO barrier. Both retain paused dispatch |

All transitions from CONTRACTS apply. A parent may close while descendants remain active; UI derives active-descendant counts. An agent cannot close an item over a newer answer: `handled_through_answer_seq` must equal its latest answer sequence and the consumer must have acknowledged it. A generic update cannot bypass close/replace/answer invariants.

MCP `apply` is one message and at most 100 operations/256 KiB. Resolve local refs in deterministic topological order, ties in submitted order; reject cycles/unknown refs. Validate the *final* candidate state before allocating committed counters. A validation failure commits nothing, including no message/counter increments. Dry-run allocation is local to the candidate snapshot.

Expected-revision map covers each existing item touched. An unrelated item change does not reject the batch. Explicit omission is allowed only for new items and read commands; agent updates must supply revisions. Answer submission uses the narrower question revision so a child addition does not invalidate the owner's draft.

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

One store transaction lock at a time. Metadata/registry updates follow the same atomic-file pattern with their own locks, outside a session transaction. Worker project lease is acquired first and held separately. OS `flock` is cross-process; intra-process callers also serialize through a keyed mutex so threads cannot defeat the intended exclusion. Readers validate an atomic snapshot without taking writer locks.

Receipt results contain small IDs/revisions, not entire snapshots. No pruning of domain receipts/history in v1. When sessions reach bounds, new work must move to a new session; no automatic SQLite migration, history deletion or topic transfer.

## 5. Limits and capacity

| Limit | Value/action |
| --- | --- |
| Snapshot | 20 MiB hard limit; reject new ordinary work above 19 MiB, reserving 1 MiB for active-turn receipts/decisions/stop metadata |
| Items/messages/depth | 10,000 / 50,000 / 32; explicit error |
| Question/outcome/why | 4 KiB each |
| Owner prompt/answer/excerpt | 16 KiB each |
| Options | 12; label/consequence each ≤1 KiB |
| Links | 32/item; target ≤4 KiB, label ≤256 bytes |
| Pending ordinary inputs | 100/consumer; preserve unsent composer draft when full |
| Pending host requests | 8/run, 64 KiB display payload each; excess requests deny with a reason |
| Read page | ≤50 entities and ≤64 KiB; cursor required for remainder |
| Fixed item/answer/message read projection | ≤60 KiB of serialized JSON, including escaping; validate before accepting the mutation, preserving the draft on error |

The fixed item read projection excludes growing `status_history`, `updated_in_messages` and `links` collections; return their counts and dedicated continuation cursors instead. History entries, backlink IDs and links are independently paginated. Full UI snapshots still contain these arrays. Answers include their complete immutable question/options/text snapshot, so a response-size validation runs at submission as well as the individual text limits; accepting an answer that cannot be fully fetched is forbidden. Message `items_touched` is limited to 100 IDs. Option IDs and owner display names are bounded at 128 and 256 bytes respectively. This second encoded-size bound handles JSON escaping expansion explicitly and leaves space for the 64 KiB response envelope.

Reserve space for an input's core control metadata at acceptance. If even control writes cannot commit (full disk/permissions/hard cap), stop dispatch and deny/cancel outstanding host permissions; report store failure. Never tell the user a response is durably saved when it is only in memory. Test capacity exhaustion mid-turn.

## 6. Discovery, repair and migration

`project.json` owns project UUID, session summaries and explicit convenience default. Session files remain authoritative. Global `~/.ariadne/projects.json` is a rebuildable registered-root index; do not scan home. Reconcile missing summaries by scanning only each registered root's sessions directory. Two roots with the same copied project UUID produce `duplicate_project_identity`; require explicit adopt-as-new-project (new UUID and validated session references) or Locate original. Never silently merge copies.

Relocation changes the global canonical-path mapping after validating project UUID; it does not rewrite historical paths in every item. Unavailable root remains listed. Forget removes the index entry only. Runtime lease prevents relocation while that project has an active managed run.

Corrupt live data never silently falls back. Keep last valid in-memory view marked stale; disable writes. `session repair --from-backup` under lock first preserves damaged bytes in a timestamp/UUID recovery file, validates backup, and commits it with an explicit repair record. Opened temp files are cleaned only if the transaction is known abandoned and owned; no broad directory deletion.

Schema migration: lock → copy original into `backups/<session>.v<old>.<uuid>.json` → pure migration chain → validate → normal atomic commit. Failed migration leaves original untouched. Future schema is read-only error, never reset. Backup files share privacy permissions and count as retained local history; uninstall never deletes them.
