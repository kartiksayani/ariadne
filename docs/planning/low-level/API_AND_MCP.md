# Application APIs and MCP tools

## 1. Shared service boundary

The UI is not an MCP client. Tauri commands, CLI commands and MCP tools are adapters over one Rust `ApplicationService`. Provider control uses `RuntimeManager`, which commits lifecycle/input changes through that same service before signaling its worker.

```text
ApplicationService
  query(SessionRef, Query) -> QueryResult
  execute(SessionRef, ActorContext, OperationId, DomainCommand) -> MutationResult
  register_project(CanonicalRoot) -> ProjectRef
  reconcile_project(ProjectRef) -> DiscoveryResult

RuntimeManager
  start(StartSpec, OperationId) -> RunRef
  resume(ResumeSpec, OperationId) -> RunRef
  stop(RunRef, OperationId) -> StopReceipt
  wake(RunRef, revision) -> void
  snapshot(RunRef) -> LiveRunState
```

`ActorContext` is supplied by the adapter, never accepted verbatim from an agent's tool payload: owner_ui, owner_cli, agent(consumer/run), external_hook(consumer), runtime(run), or setup. MCP agent scope cannot call owner-submit, permission-response, setup, repair, arbitrary filesystem, or runtime-state mutation. Runtime cannot invent agent item outcomes. The local user's arbitrary shell already has OS access; these API boundaries prevent accidental misuse and do not claim isolation from hostile code running as that user.

Service mutation receipts contain `{operation_id,session_id,revision,...command_result_fields}`. Public success envelope is `{api_version:1,ok:true,data:<receipt-or-query-result>,warnings?:[]}`. Public failure is `{api_version:1,ok:false,error:{code,message,hint,retryable,field_errors:[],current_revision?,details?}}`. Tauri/CLI/MCP adapters use that same application envelope; their outer transport framing differs. Paths/text in errors are bounded, escaped and redacted; never embed raw stderr/environment in renderer errors.

## 2. Tauri command inventory

Input/output DTOs are generated from Rust. The only frontend root-path input is Add/Locate project via a native directory picker result validated by Rust. Session commands accept registered IDs.

| Command | Essential input | Result / effects |
| --- | --- | --- |
| `project_list` | none | Known roots, unavailable/error flags, session counts |
| `project_register` / `project_locate` | picker root, expected project ID for locate, op_id | Registered project; no provider launch |
| `project_forget` | project ID, op_id | Removes registry entry only; rejects active run |
| `session_list` | optional project ID, cursor/limit | Summaries with revision, waiting count and known host mode |
| `session_get` | session ID | Full validated snapshot up to domain limit plus freshness/error metadata |
| `waiting_list` | none | Global summaries + inaccessible-project count; no false all-clear |
| `answer_submit` | item ID, question revision, selection/text, op_id | Answer/input IDs and committed revision |
| `answer_correct` | item ID, latest answer ID, question revision, text/selection, op_id | Immutable correction/input IDs |
| `agent_start` | project ID, title, initial prompt, launch profile ID, trust digest, op_id | Durable session/consumer/input/run IDs; launch failures remain inspectable |
| `agent_resume` | consumer ID, trust digest, continue_queued boolean, op_id | New run, same host conversation; no silent new-session fallback |
| `agent_send` | consumer ID, prompt, optional related item IDs, op_id | Queue ID/position; one separate future turn |
| `agent_stop` | run ID, op_id | Dispatch paused immediately; cleanup completion arrives asynchronously |
| `agent_status` / `activity_get` | run ID, optional event cursor | Live evidence + bounded recent activity, gap marker |
| `input_cancel` | queued prompt input ID, expected state/revision, op_id | Cancelled record; answers use correction; does not undo executed work |
| `input_retry` | input ID, rejected attempt ID, expected state/revision, op_id | Only proven pre-execution rejection: preserve logical ID/sequence/content, prepare queued retry; explicit Resume still required |
| `permission_respond` | run/request/epoch, expected revision, decision, op_id | Durable decision; return to provider tracked separately |
| `user_input_respond` | run/request/epoch, request revision, question-ID→selection/text map, per-item question revisions, op_id | Atomic grouped native answers + one response input; no ordinary new turn |
| `delivery_resolve` | input ID, failed/interrupted/uncertain attempt, resolution resend/do_not_resend, reason, expected state/revision, op_id | Audited owner resolution; resend retains logical content IDs, may repeat executed work, and requires explicit Resume; do_not_resend releases FIFO barrier without inventing success/receipt |
| `recovery_recheck` / `recovery_cleanup` | project/run ID, op_id for cleanup | Identity-based evidence or safe owned cleanup; never arbitrary PID kill |
| `launch_profile_get` / `launch_preflight` / `project_trust` | profile/project IDs; reviewed digest | Sanitized configuration manifest and version/trust compatibility |
| `preferences_get` / `preferences_patch` | typed fields only | Local theme/window/draft/view preferences |
| `app_open_route` / `window_set_pinned` | validated route / boolean | Native navigation/window state |
| `notifications_request_permission` | explicit UI action | Native permission state |
| `doctor` | project/profile IDs | Read-only structured diagnostics; no automatic repair |

No frontend `execute_shell`, `write_file(path,content)`, raw provider frame or unrestricted Tauri filesystem command. Setup/repair are explicit CLI flows in v1; UI may show instructions and their results but cannot invoke a generic shell to perform them.

Typed events:

- `ariadne://session_changed`: `{session_id,revision}` — invalidation hint.
- `ariadne://catalog_changed`: `{project_id?,catalog_revision}` — index refresh.
- `ariadne://runtime`: normalized run/epoch/event_seq + allowlisted activity/lifecycle.
- `ariadne://route`: `{project_id,session_id,item_id?}` — focus/reveal route.
- `ariadne://diagnostic`: bounded availability/storage failure code, no secret payload.

On subscribe, register listeners first and fetch snapshots second. Buffer received revisions during fetch; reload if newer. Duplicate/out-of-order events are ignored. Periodic reconcile and focus/wake recover dropped notifications.

## 3. MCP lifecycle and binding

Provider launches bundled helper `ariadne mcp serve --binding-file <owned-runtime-binding.json>`. File is 0600, parent dirs 0700, immutable per run and contains `{schema_version:1,project_id,canonical_root,session_id,consumer_id,run_id,connection_epoch,mode:"managed"}`; it contains no token. Validate containment, project identity and current run before serving. It is not supplied by the model or renderer. A moved/stopped/wrong-epoch binding rejects mutation with `stale_binding`.

Standard MCP initialization negotiates protocol via rmcp. Advertise tools only. No sampling, elicitation, remote resources, prompt fetching, Channels or autonomous notifications are needed. Tool descriptions contain concise rules and complete input schemas; mutation tools have explicit non-read-only annotations. Domain results contain both structured JSON and a compact text representation where client compatibility requires it.

Tool/application validation error is an MCP tool result with `isError:true`, an Ariadne error code and corrective hint. Malformed MCP envelopes/unknown methods use protocol errors. An operation receipt makes application retry safe; MCP request ID alone does not deduplicate a mutation.

| Tool | Parameters | Result |
| --- | --- | --- |
| `session_read` | view summary/items/messages/item_history/item_messages/item_links, optional topic/item/status filters, cursor, limit | Bounded projection/page, relevant revisions, collection counts and continuation cursors |
| `apply` | op_id, message excerpt, expected item revisions, operations | Allocated refs, touched IDs, message number, committed revisions |
| `answer_fetch` | optional eligible answer IDs, cursor, limit | Full answers + question/option snapshots, eligibility/continuation |
| `answer_ack` | op_id, exact answer IDs | Idempotent receipt IDs/times |
| `permission_prompt` | Claude compatibility schema only | Host allow/deny result on the original live invocation |

Project/session/consumer are fixed; any attempt to supply alternate routing is rejected. `session_read` never returns credential/profile details. Reads for answers use scheduler eligibility, not all future queued submissions. Cursor encodes view/filter digest, after-key and schema version; reject reuse with different filters. It is opaque base64url JSON, not a security token. Each page is a fresh consistent snapshot; return its revision and let the caller restart for a single-revision query if it changed.

The 64 KiB cap applies to serialized application results, including JSON escaping and envelope. Item views return fixed fields plus history/link/backlink counts and cursors; those growing collections have dedicated views. A single fixed record is validated to fit within 60 KiB at mutation time. Never return a truncated answer and mark it fully issued. Paging stops before adding a record that would exceed the response budget and resumes from that record on the next cursor.

## 4. Your example: two children from one parent

Assume parent item `4` exists in topic `t-cache`, revision 7; the run is bound to consumer `c-claude`. These shortened IDs below are illustrative references; real identity fields use UUIDs. Agent wants one Open child and one Waiting on me child.

MCP `tools/call` invokes `apply` with:

```json
{
  "op_id": "22222222-2222-4222-8222-222222222222",
  "message": {"excerpt": "I will investigate invalidation, and I need your choice about expiry."},
  "expected_item_revisions": {"4": 7},
  "operations": [
    {
      "op": "item.add", "ref": "invalidation", "topic_id": "t-cache", "parent": "4",
      "question": "Investigate how cache invalidation works.", "type": "task",
      "status": "open", "owner": {"kind": "agent", "consumer_id": "c-claude"}
    },
    {
      "op": "item.add", "ref": "expiry", "topic_id": "t-cache", "parent": "4",
      "question": "Should cached results expire?", "type": "question",
      "status": "waiting_on_me", "owner": {"kind": "me"},
      "recipient_consumer_id": "c-claude",
      "options": [
        {"id": "expire", "label": "Expire after one hour", "consequence": "Bounds staleness but refreshes more often.", "recommended": true},
        {"id": "invalidate", "label": "Use explicit invalidation", "consequence": "Avoids periodic refresh but relies on every change invalidating.", "recommended": false}
      ]
    }
  ]
}
```

Agent author/consumer/run context is filled by the adapter. Under the lock, validate parent revision/topic/recipient, allocate 4.1/4.2, increment parent's next_child and revision, allocate one agent message and all backlinks, validate full snapshot, persist once, and return:

```json
{
  "api_version": 1, "ok": true,
  "data": {
    "operation_id": "22222222-2222-4222-8222-222222222222", "session_id": "<bound-session-uuid>",
    "revision": 28, "message_number": 12,
    "refs": {"invalidation": "4.1", "expiry": "4.2"},
    "item_revisions": {"4": 8, "4.1": 1, "4.2": 1}
  }
}
```

The MCP response returns promptly. The app sees revision 28 through watch/reconcile, reloads the session, computes visible rows and global waiting summaries, and shows 4.2 in Waiting on me. If a filter hides 4.2, the global queue still shows it. Native notification is deduplicated by the new waiting episode. The agent can continue independent work or finish its current turn; it does not wait inside `apply`.

If the MCP response is lost, retrying the same op ID/payload returns those same IDs. If another writer changed parent 4 first, the whole batch gets `revision_conflict` and creates neither child; agent reads current state and uses a new operation ID for the revised command. A partial success with only one child is impossible.

When the owner answers 4.2, `answer_submit` stores its answer, owner message, item transition and input in one commit. Runtime dispatch follows FIFO; the agent later uses `answer_ack` and `item.close` with outcome/why and handled sequence. The human-readable stream can say “I added two follow-ups,” but that prose alone never creates tree records.

## 5. Agent rules and provenance discipline

Canonical managed rules are always supplied at launch and on resume through host-supported context. They instruct the agent to make `apply` calls for substantive work, use full sentences, link follow-ups, give outcome/why, use explicit receipts/revisions, and end a blocked turn rather than spin. Questions can be logged before the final conversational reply so the owner can answer early.

One response may touch several items and one item may appear in several messages. The model supplies truthful concise excerpts; Ariadne does not scrape chat prose into guessed items. Runtime text events never allocate Messages automatically. This avoids duplicate provenance from partial/final assistant frames. Owner prompts create a Message with related_item_ids chosen through the UI; a general prompt may have an empty list. Answer Messages always touch their item.

All stores and commands remain usable without a provider through CLI/demo. Optional external hooks use the same core answer protocol and consumer binding but have no managed worker. Hooks detect the managed-run environment marker and emit no duplicate context if accidentally discovered during a managed launch.

## 6. Error catalog

| Code | Meaning / caller action |
| --- | --- |
| `validation_failed` | Field errors; correct input, new op ID |
| `revision_conflict` / `question_changed` | Read fresh item; preserve UI draft; re-review before resubmit |
| `operation_reused` | Same op ID/different payload; caller bug, never auto-retry |
| `store_busy` | Nothing committed; bounded retry with same op ID |
| `commit_uncertain` | Query/retry same op ID to inspect receipt; never new mutation ID |
| `corrupt_session` / `future_schema` | Disable writes; deliberate repair/compatible version |
| `capacity_reached` / `queue_full` | Preserve draft, expose bound and next action |
| `stale_binding` / `stale_request` | Old run/epoch/request; do not redirect to current session |
| `runtime_in_use` / `recovery_required` | Existing lease or uncertain child; focus/reconcile safely |
| `host_incompatible` / `host_auth_required` / `host_rate_limited` | Pause queue; diagnostic and explicit correction/resume |
| `protocol_error` / `delivery_uncertain` | Preserve evidence, stop automatic drain, review |

Retry only errors marked retryable and only with the same operation ID. UI retries a store-busy submission at most twice (100 ms, 300 ms), then shows Retry. No exponential endless agent/model retries are hidden behind a spinner.
