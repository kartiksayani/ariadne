# FIFO delivery, explicit results and recovery

Scope: normal quit/reopen, dropped connections, duplicate submissions and uncertain
sends remain covered. Machine crashes, disk exhaustion, corrupted/lost data and
exhaustive fault-injection recovery are deferred by [PERSONAL_RELEASE](../PERSONAL_RELEASE.md).
Keep safe errors and avoid automatic resends; do not build recovery machinery for
those deferred scenarios.

## 1. Save, claim, join

One active binding per Ariadne session; many sessions may share a project.
Save all owner submissions immediately, assigning increasing input sequence under
session lock. Clear draft only after durable receipt. Message any status through
an appropriate intent; answer validates question revision/options. Saving never
changes agent-owned item status. Reply or follow-up on terminal items is allowed.

Scheduler eligibility: connected compatible binding + enabled dispatch + desktop
lease + no unresolved earlier input + no other active attempt. Items, timestamps,
UI selection and presence labels do not determine queue order. A stale/offline
host leaves saved messages queued. No automatic alternate-agent routing.

```text
claim(binding, generation, request_id):
  under session transaction:
    return existing receipt for the same binding/generation/request_id first
    verify current generation, app supervisor lease and dispatch enabled
    reject if active input or earlier needs_attention barrier
    choose smallest seq among queued, skipping only cancelled/explicitly skipped
    validate request bounds; snapshot current target context
    allocate attempt; persist claim_request_id and exact payload/digest + marker
    set input=in_flight, acceptance=prepared, active_input_id=input.id
    advance issued_through_message_number to this input owner message number
  return that same attempt to adapter
submit outside filesystem locks
report facts under normal core transactions (deduplicated):
  acceptance, host turn and result may arrive in either order
  never regress a started turn because acceptance was late
join(input, attempt):
  if turn==completed and result==committed and no contradictory evidence:
    seal attempt; input=handled; clear active_input_id
    next input becomes eligible
  if turn==failed/interrupted or conflicting/uncertain delivery:
    input=needs_attention; dispatch=recovery_required
```

A successful result may say deferred/unable; that handles this owner message but
leaves domain items exactly as the agent explicitly set them. Parent/children
never close because a host turn ended. No receipt is a tool approval.

## 2. Race and failure table

| Observed condition | Persist / UI | Next dispatch |
|---|---|---|
| saved, no available desktop/host | queued / Queued · waiting for connection | wait |
| submit returned acceptance, no turn yet | in_flight / Sent · waiting to start | wait |
| matching host turn observed | running / Received · agent working | wait |
| result committed, host still running | result committed / Reply published · agent working | wait |
| completed, no result | wait up to5s to reconcile core/report ordering; then result_missing | pause |
| completed + result arrives late | join and seal; preserve warning history | resume only if paused solely for result_missing |
| domain call validation fails | agent sees typed error; no partial batch | same turn may repair |
| domain result committed then host fails | retain domain data, mark needs_attention | pause |
| submit timeout/connection lost mid-send | uncertain; never label failed-unsent | pause |
| proven rejection before any host delivery | rejected; no turn | owner Prepare retry then Resume |
| app quits or crashes after acceptance | host may still run; no new app dispatch | reconcile on reopen |
| unrelated terminal or subagent turn | activity/presence only | never consume pending input |
| disk/lock/capacity failure | no successful save receipt; retain draft/event evidence | pause until writable |
| user pause/disconnect | explicit persisted pause | no implicit restart |

A5s missing-result grace is UI policy, not proof a late result cannot arrive.
Process deaths and expiry never authorize resending. Changing bindings or moving
projects requires reconciliation of outstanding attempts first.

## 3. Idempotency and exactly-once limits

Ariadne guarantees one stored effect for the same validated operation ID/digest.
It cannot guarantee exactly-once provider execution across a lost queue receipt.
Persist before send, correlate actual host evidence and leave uncertainty visible.
Internal event IDs and immutable payload digests deduplicate lifecycle replay.
The semantic digest excludes envelope observation time and an accepted host
receipt's observation time. Fresh scans of the same fact may report new times;
identical remaining facts replay the original durable receipt without changing
revision or stored timestamps. A changed scope, provider reference, status,
reason or diagnostic remains a conflict; see PROCESS's normalized event contract.
Native queue IDs are not assumed idempotency keys. Do not automatically drain,
reorder or delete user/provider queue entries belonging to other clients.

On reconnect, same-host identity is checked, generation rotates, old attempts
remain blocked until current adapter reconciles them. Codex polls its exact known
thread history; Claude uses persisted events and current Mod-local facts. No
private transcript recovery is assumed. 'No evidence found yet' is uncertain,
not proof that work never ran. A snapshot unavailable during result lookup does
not mean result_missing; it means store unavailable.

## 4. Owner recovery commands

All require expected current revision/attempt, reason, operation ID, and no
currently observed running turn. Unknown host liveness prevents resend until
owner confirms the terminal is stopped/idle; record this as owner attestation,
not machine-proven absence. Show target identity and prior result/side effects.

- **Prepare retry:** only proven pre-execution rejection; new attempt on same
  immutable input, same queue position. Resume is a separate explicit action.
- **Resend:** potentially repeats work; owner reviews warning. Retain old attempt;
  new attempt ID/marker, same logical input/content. Never automatic.
- **Request missing result:** after known completed host turn, new attempt with
  `purpose=result_repair`, `repair_for_attempt_id` and an instruction to inspect
  prior committed work and publish a result only. It is an explicit new model
  turn, not a repeat of the original action prompt. Still use normal result/turn
  join. Preserve original evidence; do not promise the model cannot make mistakes.
- **Skip and continue:** records skipped, not handled; releases barrier, retains
  prior results/replies; user Resume enables later inputs. No late operation may
  mutate a sealed/skipped attempt except an exact receipt replay.
- **Confirm evidence:** owner supplies explicit known outcome to reconciliation;
  store owner attribution. This never fabricates an agent result or successful
  turn. Owner may then skip; automatic 'handled' still needs host/domain evidence.

Queue cancel is only before attempt preparation. Once delivered into the host's
native queue, Pause means no additional sends and does not retract it. Release1
has no 'Stop agent' button. UI tells the owner to interrupt in the terminal.

## 5. Desktop shutdown and worker recovery

Quit never disconnects or rotates the binding generation: registered bound
domain and lifecycle writes stay eligible. Only explicit host disconnect/rebind
changes those states; shutdown of the observer alone does not imply host exit.

App emits a clear Quit note when a delivered turn remains active: that host work
continues and queued unsent inputs wait until reopen. Flush already-observed
lifecycle events, stop own adapter helpers, release socket/leases. Never signal
external PID or kill daemon. A forced shutdown can lose transient diagnostics;
source domain history persists through independent CLI/MCP writes. On startup
subscribe/watch, read all active bindings, run reconcile, then enable eligible
previously-enabled queues. Explicit pauses remain paused.

Multiple desktop-start attempts converge via single-instance + OS binding lease.
A killed dispatcher releases OS lease but a prepared attempt remains on disk;
replacement cannot send it until reconciliation. Never let a time-based lease
alone declare the provider never received the message.

## 6. Delivery labels and full history

Saved/Queued, Sent, Received, Published, Handled, Missing result, Failed,
Uncertain, Cancelled and Skipped are derived delivery labels, not new persisted
Input.state values or item statuses. The mockup
stepper's 'Resolved' means this submission handled; display separate item status.
A result published while the turn continues is immediately visible on its target
item; full body persists. The rail uses excerpts derived from full Messages.
A terminal summary captured by the bridge remains bounded diagnostic activity.
All corrections, rounds, branches and superseded answers remain inspectable.

### Derived label precedence

Read in this order: input cancelled→Cancelled; skipped→Skipped; handled→Handled;
attempt uncertain→Uncertain; failed/interrupted turn→Failed; result missing→Missing
result; result committed and turn not completed→Published; running→Received;
accepted→Sent; prepared→Sending; queued with unavailable/busy host→Queued;
otherwise queued→Saved. Set input needs_attention and recovery_required when the
missing-result grace expires, retaining its unsealed attempt. If a late result
joins successfully, clear only that automatic pause, never an explicit owner pause.
Store independent owner_paused plus automatic pause_reason (`result_missing`, `uncertain`, `host_failure`,
`store_error`, `incompatible`) beside dispatch_state so that distinction is durable.

A queued answer retains the exact question/option snapshot it was saved against.
If the agent later changes the item before dispatch, show the changed-question
context alongside the immutable original answer in the payload; do not reinterpret
an old option ID against new options. Revisions are checked when the owner saves
and when the agent mutates, while a saved owner message is not silently discarded.
