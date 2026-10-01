# Ordered input, approvals, and recovery

## 1. Three independent state machines

1. **Item state:** open/waiting_on_me/in_progress/decided/done/dropped/replaced — meaning of the work.
2. **Input delivery + turn state:** queued/sending/accepted/uncertain/etc. and not_started/running/completed/etc. — transport and execution evidence.
3. **Run/request state:** live process and pending host interactions — whether a conversation can accept more work.

Do not derive any one from another. A received answer may have an unfinished turn. An item in progress may belong to a stopped agent. An idle process may have a question waiting for the owner.

## 2. Exact N-message contract

Each explicit Send creates one durable `Input` and one per-consumer `input_seq` under the session lock. UI submission order is the order commits receive those sequences; simultaneous sends from different views are ordered by the store. A renderer retries the same op ID until it learns the result, never creates a second input for an uncertain save.

**One submission → one host turn.** Never combine separate prompts or answer submissions on a timer, even if several are already queued. A future explicit multi-answer Submit action could contain several answers in one input, but v1 sends one item answer per submission. The provider only receives the next input after successful completion of the preceding turn. Claude's ability to queue/coalesce messages internally is deliberately unused.

Example: owner submits P1, P2, A3 while P0 is active. Queue stores seq 11/12/13. On P0 success send P1 only; await its result; then P2; then A3. Each input retains its ID and sequence through Stop, restart and resume. Cross-project workers can progress independently. There is no global total ordering across conversations.

The UI shows queue position, submitted text/answer, and states. Allow cancellation of queued **prompts** only. No drag-to-reorder or in-place edit in v1; Cancel + Send creates a later sequence with a new message. Answers use the explicit correction flow instead of cancellation, preserving the invariant that closing an item accounts for its latest owner answer. Already-sending input requires Stop/recovery, not queue cancellation.

## 3. Scheduler algorithm

Only the worker holding the project lease dispatches managed inputs. Store change events wake it; a 500 ms reconciliation timer covers missed events. Timer execution never calls a model unless a real eligible input is queued.

```text
on wake:
  if parent pipe closed: stop and clean up
  if an unanswered permission/native request blocks active turn:
      return matching decided responses; do not submit a new turn
  if stopping, dispatch paused, active turn, or recovery unresolved: return
  inspect earliest unresolved route=turn input for this consumer
  if failed/interrupted/uncertain without owner resolution: pause and return
  skip completed turns, cancelled prompts, owner-reviewed do_not_resend entries
  choose earliest queued input; omit already satisfied answer IDs
  if no remaining payload: mark satisfied; repeat without provider call
  validate current binding, run epoch, trust/config digest and capacity
  transact: mark sending, allocate attempt and input UUID, set active_input_id,
            issue exact full answer IDs included, record payload digest
  write exactly one newline-terminated host user-input/request frame
  wait for host acceptance and turn events while serving other event channels
```

The persisted payload is constructed from immutable prompt/answers and a versioned formatter; retry on the same formatter version reproduces the same text. The envelope identifies input ID, item IDs, question snapshot, selected label/ID, free text, correction reference, and instructions to acknowledge the listed answer IDs. It never invents owner text. Size overflow uses explicit fetch references instead of truncating content.

Acceptance and turn-completion handlers run through core transactions with deduplication keys `(run,epoch,event identity)`. Replayed host events cannot create a second provenance message or complete a newer turn. A host response with a mismatched session/thread/input/turn ID is a protocol error and pauses dispatch.

Completion success: persist completed turn, clear active_input_id, set run idle, then loop once for the next queued input. Failure/interruption/quota/auth/protocol error: pause dispatch, retain later inputs, require Retry/Resume action. Do not proceed to P2 when P1 failed and P2 may depend on it. Agent omitting an answer receipt is different: a successful turn can drain the next input, showing the old answer as awaiting acknowledgment with one contextual reminder.

`input_retry` is available only for an input with authoritative proof of rejection before execution. It appends a resolution, resets that same logical input to queued/not_started, preserves sequence/content/answer IDs and all previous attempts, and leaves dispatch paused. The next explicit Resume creates the next send attempt at the original FIFO position. It does not create another owner Message. An ordinary provider error is insufficient proof of non-execution.

For a failed/interrupted turn that may already have done work, or an uncertain send, use `delivery_resolve`: **Resend this input** (with the displayed risk of repeated work) or **Do not resend; continue later inputs**. Store the owner's decision and reason; never label the failed turn completed. Both choices still require explicit Resume. If later input has already begun after a skip, recovering that old work requires a new follow-up input rather than inserting an old sequence ahead of work in progress. Neither skip nor resend fabricates acknowledgment of an answer, and skipped answers remain available as eligible previously dispatched answers. Resume alone cannot bypass an unresolved earlier failure.

An acknowledgment may arrive through MCP before a host replay/acceptance event. It establishes that the answer was read; store that evidence without inferring turn success. The worker still waits for the matching result. Similarly, a result correlated to the input can establish acceptance if a replay event was omitted; a raw successful pipe write never can.

## 4. Answer eligibility and concurrent changes

For managed consumers, `answer_fetch` exposes only dispatched/accepted answers and the currently sending input's referenced full answers, plus previously delivered unacknowledged answers. It **does not expose later queued submissions**. Otherwise a fetch during P1 could read A3 before P2, breaking FIFO. External consumers have no scheduler and fetch all unacknowledged answers.

The fetch tool records fully issued IDs before returning; reading a summary/reference is not a full issue. Ack checks consumer, eligibility and full issuance. If a late fetch satisfies an unsent batch, dispatcher removes those satisfied IDs before constructing a frame. The per-consumer active-input pointer and worker lease prevent a second active send race.

If question/options changed before answer commit, core rejects with current question revision and preserves the draft. If the item closes after a committed answer, close must incorporate/acknowledge that answer. If an item is replaced after answer commit, the answer remains scoped to the original item; never reroute it silently. A correction queued behind an active answer is available only at its own turn; close protection still prevents resolving over the newer committed correction.

## 5. Host interaction lane

Permissions are **responses to the active turn**, not queued ordinary messages. They bypass the FIFO of future prompts solely to unblock that turn. They cannot start another turn.

1. Provider produces a permission request. Claude uses `permission_prompt`; Codex sends a server RPC request. Normalize IDs/kind/display data and commit HostRequest pending.
2. UI displays project/session, exact operation and affected paths, plus Allow once / Deny. No recommendation is a preselected approval. If full operation cannot fit safely, deny with an explanation rather than showing a truncated approval target.
3. UI invokes `permission_respond` with request revision and current run/epoch. Core rejects stale, expired, different-run or already-differently-decided responses.
4. Waiting bridge or worker re-reads the decided record and sends the host-specific response. Record returned evidence. Duplicate UI submits are idempotent; never answer a provider request twice.
5. Provider continues the same turn or reports denial/error. A permission decision does not imply the tool completed successfully.

Initial permission timeout: 10 minutes of wall time; show deadline. Claude's Ariadne MCP server uses an 11-minute timeout and disabled auto-background, as specified in SETUP_AND_DELIVERY; C03 must verify that a pending decision stays blocking beyond two minutes. A timer/cancellation expires the local request and returns deny. Sleep/wake rechecks expiry; expired approvals cannot become valid again. Ordinary domain tools have a 5-second service budget, including the 2-second lock budget. Do not hold a transaction lock while waiting for UI.

Native `requestUserInput` is also a response lane. Create one waiting item per question with a unique source key `(run,epoch,request,question_id)`; persist the ordered question/item mapping in HostRequest, so duplicate notifications reuse it. Selecting any of these items opens one grouped form. V1 requires an answer for every displayed question before Submit answers (an Ariadne UI policy; the provider schema has no required flag). Keep partial drafts in preferences. Submit stores all answers, one owner message and one host_response input/map atomically; return it to the exact live request without a new turn.

Native answered IDs become eligible for MCP fetch after response dispatch; the agent must fetch/ack them before closing their items. Do not alter the provider's answer labels to smuggle in IDs. The canonical rules direct the agent to read eligible native-question records after receiving a native response. Native receipt can therefore remain pending if the agent omits that step, with the same honest UI as ordinary answers.

`isBlocking:false` does not justify assuming the host will keep the request alive. If completion/interruption/serverRequest-resolved clears it first, expire the local request and preserve drafts/committed answers for review; never return into a newer turn or automatically turn that answer into another message. N03 must prove this lifecycle. Ariadne-created questions use ordinary MCP logging and the turn queue instead.

Claude's built-in question UI is not assumed available via the permission bridge. The canonical rules use Ariadne question items. If a host emits an unsupported interactive control, show a specific unsupported-operation error and deny/cancel it; never treat it as an ordinary permission approval or hang silently.

## 6. Stop, close, quit, and resume

| Action | Semantics |
| --- | --- |
| Close window | Hide UI; worker, store watcher, tray, permissions and dispatch keep running |
| Close tab | View change only; never stop its run or hide its questions |
| Stop | Atomically pause consumer dispatch first; interrupt active turn; expire pending requests; gracefully close provider and worker; keep all unsent inputs |
| Quit with no active runs | Flush owned UI preferences and exit |
| Quit with active runs | Dialog lists runs; Cancel quitting or Stop all and quit; no automatic answer/approval |
| Resume | Preflight/trust/version/lease checks; reconcile prior uncertainty; resume exact host ID with same consumer; owner elects Continue queued inputs |
| New session | New consumer/host ID; never substitute for a broken Resume without explicit owner choice |

Stop latency budgets: send host interrupt, allow 5 s for a terminal event; request graceful exit/EOF and allow 5 s; SIGTERM owned process group and allow 2 s; SIGKILL only the still-owned verified group if necessary. Record interruption versus uncertain completion honestly. A closed worker stdin is the parent-death signal and invokes the same cleanup path. An app restart must not auto-resume queued paid work.

If initial launch failed before any host conversation was created and that absence is established, retry can initialize the same Ariadne session/consumer with its existing queued first input. This is an initialization retry, not a replacement for a known host conversation. An unknown host ID after a possibly consumed first input remains uncertain and requires owner resolution.

Do not clear a project lease file to unblock startup. A live holder reports **Another Ariadne run owns this project**; focus the existing app/run if it belongs to this instance. A worker killed with SIGKILL may leave provider descendants alive despite releasing the lease, so a nonterminal stored run still requires reconciliation.

## 7. Failure matrix

| Failure point | Durable observation | Required recovery |
| --- | --- | --- |
| UI dies before submit commit | No receipt or input | Restore local draft if available; no claimed send |
| Commit happened, response lost | Receipt + queued input | Retry same op ID returns saved IDs |
| Worker dies before preparing send | queued | Explicit Resume can send it |
| Marked sending, no acceptance captured | sending | Convert to uncertain; inspect supported host evidence; no blind resend |
| Acceptance captured, no terminal result | accepted/running | Interrupted/uncertain turn; show evidence and require Resume/recovery before later inputs |
| Result captured, UI misses event | completed in store | Reload revision; do not repeat provider work |
| Agent ack captured but result missing | receipt + unfinished turn | Received answer, unresolved turn; never infer completion |
| Provider rejects before execution | failed/rejection evidence | Pause queue, fix cause, input_retry then explicit Resume; preserve original input order |
| Turn fails after possible work | failed/interrupted with effects possible | Pause; owner chooses resend or do_not_resend with reason, then Resume; never silently skip |
| Permission response write lost | decided, no return evidence | Never carry allow to a new run; expire on disconnect; re-request if needed |
| Core write fails during host work | Last committed snapshot | Pause dispatch, surface store failure; stop/deny new operations |
| Parent app dies | Pipe EOF at worker | Cancel dispatch and owned child cleanup; next app reconciles |
| Worker/provider ownership uncertain | stale nonterminal run | Recovery view; no new writer in that project |

Recovery view shows non-secret run/host/input IDs, timestamps, last confirmed events and cleanup evidence. Actions: **Recheck**, **Retry owned cleanup** when identity is provable, **Resume conversation**, and for uncertain input **Resend this input** or **Do not resend** with an explicit record. The latter marks transport resolution reviewed; it never fabricates an agent receipt or successful turn. Require process absence/termination evidence before starting another managed writer. If escaped/orphaned process identity is unprovable, show manual inspection instructions and remain blocked; do not kill an unrelated process based on a recycled PID.

Provider history reconciliation uses supported APIs only. Codex can inspect the recorded thread's user items/turns. Claude uses known echoed/correlated input IDs captured while running; no private transcript scraper is introduced for recovery. If evidence cannot settle whether input was consumed, tell the owner that explicitly. Exactly-once arbitrary external actions cannot be guaranteed by local JSON receipts.
