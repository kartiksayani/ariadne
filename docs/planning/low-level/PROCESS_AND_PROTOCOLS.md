# Processes and agent protocols — existing-session baseline

## 1. Ownership, leases and app control

Desktop single-instance owns a Tokio runtime, one dispatch supervisor per active
binding, and a local Unix listener `~/.ariadne/run/control.sock`. Directory0700,
socket0600; verify peer UID on accepted connections, bound request size1MiB and
idle timeout5s. Only local IPC, no TCP listener. Check macOS Unix path byte limit
before binding; return `control_path_too_long` with a shorter ARIADNE_HOME remedy.
Never unlink an endpoint until the single-instance/runtime lock proves no prior
Ariadne instance owns it; validate owner/type before removing a stale socket.

Each supervisor holds `run/leases/<binding>.lock` (nonblocking `flock`) until it
stops. Session file writes use different locks. One desktop process can supervise
many bindings/projects. No lease authorizes signalling a Claude/Codex process.
The app can spawn short-lived CLI queue senders in v1. External adapter
executable spawning belongs to the deferred plugin extension. It may stop its helpers, but an interrupted sender means uncertain
submission, not cancellation at the host.

`ariadne bridge claim` uses this socket, never directly claims from disk. Desktop
validates generation, its lease, enabled dispatch and FIFO eligibility under the
session transaction, persists the attempt, then returns the exact payload. A
lost claim response retains the prepared attempt; the same claim request ID
recovers its receipt, never claims another input. Prepared is not proof the host
received it; if the adapter may have submitted before dying, reconciliation must
classify host-delivery uncertainty before any new send. CLI `bridge report` persists
normalized events through core directly, so current-turn completion can be saved
when desktop is closed. Hook/report retries reuse event IDs.

The runtime owns the private codec, reused by the installed CLI. Each Unix
connection carries one request and one response: a four-byte unsigned big-endian
byte length followed by UTF-8 JSON. Reject zero or more than 1 MiB before
allocating the frame. One absolute 5-second deadline covers complete frame IO;
partial bytes never extend it. There is no multiplexing or automatic retry.

Control request: `{v:1,kind:"request",id:UuidV4,method,params}`. A response has
`{v:1,kind:"response",id,result}` or `{v:1,kind:"response",id,error:CoreError}`,
exactly one of result/error and the same ID. Malformed frames without a trusted
UUID ID may close; never invent an ID. Unknown fields and mismatched method
params reject. Producers and consumers validate canonical CoreError values; valid
errors remain exact. Malformed errors return bounded nonretryable protocol_conflict
without raw invalid data, retaining original request/event/operation ID guidance
and no inference that effects were absent. Typed methods are:

| Method | Params | Result |
| --- | --- | --- |
| `ping` | `{binding_id:UuidV4,generation:UuidV4}` | the same binding/generation; proves scoped control reachability only |
| `claim` | canonical `ClaimRequest={binding_id,generation,request_id}`; envelope `id=request_id` | canonical `PreparedAttempt|null`, validated against that request |
| `connection_status` | `{binding_id:UuidV4,generation:UuidV4}` | canonical `BindingSummary` from the current registered binding; presence is null unless actually qualified |
| `binding_connect` | unchanged canonical `OwnerMutationRequest={session:null,command:BindingConnect}`; envelope `id=command.op_id` | canonical `MutationReceipt` with exact operation ID, `SavedReceiptData::BindingConnect` and the explicitly requested existing session when supplied |
| `session_announcement` | strict private SDK identity described in section 5; no client timestamp or compatibility claim | `{adapter_id:"claude_code_mod",external_session_id:string}` matching the request exactly; candidate admission only |

Announcement intake uses this same UID-checked socket and framing, separately
from lease-required claim routes. `ariadne bridge announce --request-id UUID
--json-stdin` forwards its strict params and emits the existing application
envelope containing only that acknowledgement. It accepts no binding/generation
argv flags; optional captured bound scope is part of the validated private body.
An unbound announcement needs neither a route nor lease and never calls Core.

Ping/status require the current held generation. Claim routing verifies request
syntax, peer UID and the registered binding, and retains the actual current
binding lease throughout the blocking core call. Its trusted dispatch context
contains the current lease generation, while the original ClaimRequest is
forwarded unchanged. Core replays the exact saved claim before generation/state
guards; a fresh stale request still rejects. A socket timeout, caller drop or
shutdown cannot release a lease while its already-started core call may commit.
Every installed claim route has a mandatory native claim gate, initially closed.
The binding supervisor opens it only after its complete startup scan and verified
reconciliation have been reported through validated Core receipts. Stop closes
it before admitting more blocking claims. Closed gates return nonretryable
host_unreachable with the original claim ID and no inference about prior effects.
After the gate opens, exact existing-claim replay retains the routing and current
lease context described above; the original request is still forwarded unchanged.

Reuse the same claim ID after a possibly saved claim; no local claim cache or
new-ID retry is authorized. Core calls run off the executor and socket waits
never overlap a store transaction. Connection admission is bounded to 16,
including blocking calls retained after socket timeout; shutdown stops accepts
and pending IO while those calls retain their physical lease.

Binding connect is a separate native bootstrap whitelist on this same socket,
not a lease-required claim route or general owner RPC. It is disabled unless native
composition opts in with its actual configured CoreService. The server supplies
trusted Registry OwnerContext and forwards the original canonical command unchanged.
The helper first uses the native saved-connect replay seam directly: an exact stored
receipt or operation-reused conflict remains available while desktop is closed,
without provider verification or new IDs. Only a new operation requires the matching
open desktop and its fresh qualified selected candidate; missing/unconfigured
composition returns actionable nonretryable host_unreachable/unsupported, with no
launch or guessed provider identity.

The existing 16 permits and absolute five-second deadline bound bootstrap admission
and frame IO. Work not started before its deadline cannot call Core. Once the blocking
Core call starts it retains its permit until completion even if the socket times out,
the caller disappears or the listener stops. Response loss does not prove absence of
commit; retain the exact original operation ID and parameters and check the saved
receipt before repeating that operation. Validate the response's canonical saved
variant, operation ID and explicit target session; preserve setup_instruction bytes.
A saved connection receipt grants no dispatch lease or supervisor readiness. Actual
provider verification, final adapter connect and dynamic supervisor/claim-route
activation remain native composition work, not behavior supplied by this relay.

The native runtime library now supplies `ProviderFactory` and `NativeActivation`
for that join (ADR-0056); installed desktop startup remains a consuming integration.
The native Core `connect_before` seam keeps both exact replay checks before
deadline guards and prevents fresh allocation/write after a registry-lock wait
exhausts the original deadline. It never cancels a transaction already started.
Concrete adapter `connect_before` methods carry that same deadline through their
existing worker queues without changing the shared Adapter trait. Claude still
returns Unknown/Disconnected bootstrap IDs before a separately bounded matching
bound announcement can activate it. Qualified active heartbeats reuse the same
evidence slot after saved identity/fingerprint checks. Dynamic control routes
publish real lease/gate pairs only after canonical reporting, reconciliation and
an authoritative current-generation reread; stale completion removes only its
own generation. Shared desktop ownership survives in-flight blocking calls.

Stable owned single-link regular lease files have mode 0600. Home, run and
lease directories have mode 0700; opening these targets does not follow
symlinks. The runtime-instance lock is `run/runtime.lock`. Socket setup/removal
requires that lock and validates owned socket type/mode. A closed listener may
leave a stale endpoint for the next proven owner to remove.

Direct event reporting forwards the original event to CoreService using trusted
current registered binding context; it must not reject an exact durable replay
solely because its originating generation is old. Ordinary reports have no
historical scope. Caller-supplied old IDs/generation cannot create a trusted
VerifiedHistoricalScope; fresh historical evidence needs verified reconciliation.
Until the real registered core composition exists, the production `bridge report`
command returns nonretryable `unsupported` with a concrete reason, never a saved
receipt. The injected direct-report function works without the desktop socket or
lease. Durable claim/report integration remains P2.2, P1.4 registration and P3.2
runtime wiring; P3.1 implementation alone does not close that acceptance join.
CLI stdout is the canonical structured application envelope. Domain bootstrap
and event persistence use ordinary CLI core commands.
Startup drains persisted state before enabling dispatch. Window close hides;
Quit pauses scheduling in memory and releases leases. New saved messages wait
until reopening; already accepted turns can still run. User pause persists and
is never undone by app restart. No provider launch/resume is performed.

## 2. Shared adapter contract

Binding setup performs a trusted read-only provider/config/version/endpoint and
explicit-thread qualification outside registry/project/session locks. Native
core-owned `VerifiedHost` facts carry no active provider handle; exact operation
replay is checked before verification and again when locks are reacquired. Final
IDs/generation are allocated only during locked persistence. Runtime then calls
Adapter.connect with those durable IDs outside locks before lease/dispatch;
failure reports generation-scoped disconnected and never dispatches. Unknown
preflight connection remains Unknown with a disconnected dispatch barrier.
Provider/runtime tasks own that final connection and report wiring. Codex's
initialized reader now supplies an owned pre-ID qualification for the exact
selected thread and canonical registered project root. Native composition may
consume that initialized reader with `CodexAdapter::from_qualified_thread`; final
Adapter.connect supplies saved binding/generation IDs and rechecks the same
thread/root and full-item/transport requirements under its original admission
deadline. This qualified adapter retains the selected endpoint, fingerprint and
existing executable identity across reconnect; a changed identity requires fresh
qualification rather than retargeting the selection. Native composition still
owns configuration validation, copying verified facts into Core, final runtime
connection/reporting/reconciliation and lease activation. No placeholder-ID
connection or shared adapter method is added.

See [Agent adapters](../AGENT_ADAPTERS.md) for the shared interface and later
executable-extension design. Public registration/negotiation is deferred. Rust trait
uses owned DTOs and async operations `probe`, `connect`, `submit`, `observe`,
`reconcile`, `disconnect`. Reserve `hello` for the later executable protocol;
first-party adapters and their in-process test fake do not need a plugin loader.
First-party Claude submit is pull-driven: scheduler supplies work in response to
the Mod claim. Codex submit is push-driven through its native CLI. Both use the
same core attempt/result state machine, not a mandatory artificial push socket.

### Owned method DTOs

P0.5 publishes the object-safe `Adapter: Send + Sync` in
`ariadne-agent-protocol`. Each method takes `&self` and one owned request, returning
`AdapterFuture<'_, OwnedResult>`: a boxed, pinned `Send` future whose output is
`Result<OwnedResult, AdapterError>`. The seam requires no async runtime or macro;
runtime supplies the executor, deadlines and dispatch lease validation.
`AdapterError={code:AdapterErrorCode,message:string,retryable:boolean}` uses the
shared error vocabulary, not provider stderr. Its exact codes are
`invalid_argument`, `binding_mismatch`, `stale_generation`, `incompatible_adapter`,
`host_unreachable`, `delivery_uncertain`, `permission_denied`, `unsupported`,
`protocol_conflict`, `unsupported_host_version`. P0.6 maps every variant into the
public API envelope. Message/reason text is at most 4 KiB UTF-8. Retryable means the
same safe operation may retry; `delivery_uncertain` is never retryable and no error
authorizes uncertain submit resend. Domain primitives, `EndpointRef`,
`EndpointFingerprint`, adapter configuration and qualified presence are imported
from the canonical Rust contract. P0.3b/P0.5 settle every member before consumers
start; no consumer-local dictionaries or provider wire types enter this seam.

| Method | Request fields | Result fields / semantics |
| --- | --- | --- |
| `probe` | `endpoint:EndpointRef,configuration:AdapterConfig` | `host_version:string|null,compatibility:compatible|incompatible|unknown,availability:available|unavailable|unknown,setup_steps:string[]`; unknown never enables dispatch |
| `connect` | `binding_id,generation,external_session_id:string,endpoint:EndpointRef,configuration:AdapterConfig` | verified `external_session_id:string,endpoint_fingerprint:EndpointFingerprint,capabilities:Capabilities,observation:PresenceObservation`; mismatch rejects |
| `submit` | `binding_id,generation,input_id,attempt_id,formatted_payload:string,payload_sha256:Sha256,wire_marker:string` | `SubmitOutcome=Accepted{receipt:HostReceipt|null}\|RejectedBeforeDelivery{reason:string}\|Uncertain{reason:string}`; consume the exact persisted dispatch values |
| `observe` | `binding_id,generation,checkpoint:Checkpoint|null,limit:ObserveLimit` (integer 1..100) | `ObserveResult={events:NormalizedEvent[],next_checkpoint:Checkpoint|null}` |
| `reconcile` | `binding_id,generation,attempts:AttemptEvidenceRequest[],checkpoint:Checkpoint|null` | `ReconcileResult={attempt_evidence:AttemptEvidence[],unresolved_attempt_ids:UuidV4[],next_checkpoint:Checkpoint|null}` |
| `disconnect` | `binding_id,generation` | `DisconnectResult={}` after stopping observation/releasing adapter-owned resources; never stops the host |

`Capabilities` is the typed capability set from AGENT_ADAPTERS, with
`{supported:boolean,conditions:string[]}` per declared capability and
`delivery_mode:pull|push`; core never branches on provider names.
`Checkpoint` is the canonical domain opaque adapter checkpoint bounded to 4 KiB,
not a query cursor. `HostReceipt` is also imported from domain;
`{provider_reference:string,observed_at:UtcMillis}` is bounded
provider acceptance evidence, not a successful turn/result.
`AttemptEvidenceRequest={input_id:UuidV4,attempt_id:UuidV4,
binding_generation:UuidV4,payload_sha256:Sha256,wire_marker:string,
host_turn_id:string|null}` carries persisted dispatch evidence unchanged;
`AttemptEvidence={input_id,attempt_id,events:NormalizedEvent[]}`. Read-only
reconciliation does not resubmit. Advance a checkpoint only after core persists
all corresponding effects; unresolved evidence cannot prove non-delivery.
Optional reads accept omitted/null fields and emit explicit null; collections
remain required. Method DTOs are protocol-owned
records using canonical primitives, not copies of persisted entity schemas.

### Runtime supervision and acknowledgment

Each binding has an independent supervisor over the canonical CoreService and
Adapter seams. Native composition supplies a trusted RegisteredSession, durable
Binding and fresh UUID/time factories. Adapter.connect and all host IO run outside
store locks; connect precedes acquiring the dispatch lease. An actual failed or
timed-out connection reports generation-scoped disconnected through the trusted
registered route without a dispatch lease. This describes failure to establish
Ariadne's connection, never host termination or non-delivery. A failed Core report
returns both connection cause and the exact unacknowledged event/context; no stale
failure is retargeted to a new generation. Precondition rejection before a host
attempt does not fabricate a connection observation.

Startup pages owner Inputs (in_flight/needs_attention, limit 100), retaining
unsealed attempts for this binding. SnapshotChanged restarts the entire scan;
three failed scans stop with that typed error. Sequences and continuation cursors
must make actual progress. The compact input scan shares the existing 16 MiB
session budget, without a duplicate serialized buffer; exceeding it returns
capacity_exceeded with the gate closed, never omits persisted attempts. Reconcile
uses batches of at most 100 exact persisted evidence records and fresh tokens,
including originating generations. Only genuinely verified reconciliation facts
receive native historical scope. Unresolved attempts keep the claim gate closed.
Pull bindings never proactively claim or submit; push bindings ask Core for FIFO
eligibility and send only its exact saved PreparedAttempt. Core alone owns pauses,
one active attempt, replay, authorization and result joins.

Supervisors serialize one bounded provider response and its Core reports. They do
not read another response while lifecycle receipts are outstanding. An 8 MiB
provider response may include a full diagnostic ring plus durable facts; 256 is
the lossy diagnostic record capacity, not a lifecycle event limit. Validate each
fact, canonical error and correlated receipt before advancing. A successful
lifecycle receipt confirms either a durable effect or Core's validated unchanged
observation; unchanged facts need no fabricated write or revision. Malformed,
mismatched or failed receipts retain the pending fact and block progress.
Text stays diagnostic, never a domain reply; the
separate display copy is redacted and bounded to 256 records/2 MiB with explicit
gap/truncation. It does not alter the event submitted to Core.

A next checkpoint is candidate progress. Runtime echoes it only after every
corresponding Core receipt has been validated. That acknowledgment is volatile:
this implementation has no durable checkpoint writer or journal, and does not
claim that Attempt.reconciliation_checkpoint has been saved. Restart explicitly
reconciles persisted attempts with a fresh observer; an absent/old token never
proves delivery absence. Receipt failure stops upstream and returns the exact
remaining events, trusted contexts and candidate checkpoint for composition.

Quit closes claim gates, stops scheduling and bounds its own pending-fact flush
to five seconds, then disconnects observation within the adapter's five-second
bound. A failed flush returns a pending page plus typed error, never clean success.
A possibly saved interrupted claim retains its request ID. Submission cancellation
after possible admission reports uncertainty, never automatically resends. Native
composition also stops the control listener and releases its route-held lease
clones; an already-started blocking Core call retains its actual lease until it
finishes even after timeout or caller drop. Normal Quit emits no domain disconnected
fact, changes no generation/user pause, and sends no signal to external hosts.

P3.2 publishes this scheduling/control implementation against test-only canonical
Core/provider seams. Real registration composition, durable queue/report/checkpoint
production and end-to-end acceptance remain joined with P1.4/P2.2 and the provider
wiring tasks. A scripted test service is never production persistence or fallback.

`cargo xtask gen-contracts` emits adapter JSON Schemas under
`contracts/generated/adapter` and TypeScript under
`apps/desktop/src/generated/adapter`. TypeScript imports canonical domain types.
Schemas describe emitted shapes; callable protocol validators additionally check
UTF-8 byte bounds, event correlation and batch binding/generation scope. Producers
validate before returning facts; consumers validate before persisting effects.
These validators do not perform replay, outcome joins or core state transitions.
The `fake::ScriptedAdapter` is available only in crate tests or via the default-off
`test-support` feature for consumer dev dependencies. Owned request/response steps
and call history exercise this seam without production fallback, host execution,
implicit checkpoint advance, automatic resubmit or business state.

The existing method deadlines remain 10s probe/connect, 20s submit, 5s observe,
10s per reconciliation batch and 5s disconnect. A timeout/error after possible
send returns `Uncertain`, including interrupted queue senders. Rejection means
proven failure before any host delivery/execution; no automatic retry follows
uncertainty. Pull delivery offers the already persisted claim to the Mod; it does
not add a Claude push socket. Both modes retain runtime lease validation and
domain-core claim/result ownership.

### Normalized event payloads

Normalize `connected`, `accepted`, `turn_started`, `visible_output`,
`turn_finished`, `rejected`, `uncertain`, `presence`, `disconnected`.
Event: `{event_id,binding_id,generation,input_id?,attempt_id?,host_turn_id?,
observed_at,kind,payload}`. Deterministic IDs for terminal events use source event
identity where supplied, else hash(binding,generation,attempt,turn,kind). Presence
is ephemeral and need not have a persistent event receipt. Do not deduplicate
legitimately different output chunks using identical text hashes.

Durable lifecycle replay uses event ID plus an immutable semantic digest. Exclude
both envelope `observed_at` and accepted `HostReceipt.observed_at` from that digest:
they describe observation time, so fresh verified scans may differ. The same ID
and all other identical facts replay the original durable receipt without a
revision or timestamp rewrite. Changed scope, provider reference, status, reason
or diagnostic facts conflict. Cached observation batches retain their original
timestamps exactly; ephemeral presence still uses qualified freshness. P2.2's
production reporter owns this digest/replay behavior; P0.6 validates the wire.

The terminal fallback is lowercase hexadecimal SHA256 over UTF-8 compact JSON
array `[binding_id,generation,attempt_id,host_turn_id,kind]` in that exact order,
serialized by serde_json. IDs use their canonical string spelling; absent turn
is explicit JSON null. Only `turn_finished`, `rejected`, `uncertain` use this
helper. Valid source identity is preserved verbatim. Status, diagnostics and
reception time are excluded: contradictory facts must reach core adjudication.

P0.5 publishes this tagged payload union in the protocol package. Envelope IDs
use canonical primitives; `observed_at:UtcMillis`, `host_turn_id:string|null`.
All optional envelope fields emit explicit null when absent. `event_id` and host
identifiers (external session, turn, message, provider receipt reference) are
nonempty opaque strings, at most 4 KiB UTF-8; never impose UUID/ASCII grammar,
normalize or truncate identity. `kind`/`payload` form one tagged union flattened
into the envelope, so an event cannot carry a payload for a different kind.

| `kind` | Exact payload |
| --- | --- |
| `connected` | `{external_session_id:string,endpoint_fingerprint:EndpointFingerprint,capabilities:Capabilities}` |
| `accepted` | `{receipt:HostReceipt|null}` |
| `turn_started` | `{}` |
| `visible_output` | `{host_message_id:string|null,phase:commentary|final|unknown,operation:append|replace,text:string,truncated:boolean,gap_before:boolean}` |
| `turn_finished` | `{status:completed|failed|interrupted,reason:string|null,diagnostic_text:string|null,truncated:boolean}` |
| `rejected` | `{reason:string}`; proven before delivery/execution |
| `uncertain` | `{reason:string}`; delivery/execution cannot be ruled out |
| `presence` | `{observation:PresenceObservation}`; canonical DOMAIN binding/presence fields and PROCESS section 5 qualification |
| `disconnected` | `{reason:string|null}` |

Matched attempt events (`accepted`, `turn_started`, `visible_output`,
`turn_finished`, `rejected`, `uncertain`) require input and attempt IDs together.
Started/output/finished also require the matching host turn ID; accepted/rejected/
uncertain allow null before correlation. Connection/presence/disconnect events
have null input/attempt/turn IDs. Unrelated host turns produce qualified
presence/activity only; they cannot consume pending work or create domain replies.
Stable event/chunk identity remains required when host message IDs are absent;
generated identity never pretends to be a host ID. Payload nullable fields are
always explicit. `EndpointFingerprint` is the canonical bounded identity type,
not an invented SHA256 constraint; it is distinct from `payload_sha256`.

Visible/terminal text follows the existing diagnostic bounds and shows truncation
or a dropped/coalesced gap. No raw tools, private reasoning, environment or auth
payloads. A completed host turn remains separate from a committed domain result.

New work requires current generation. Ordinary `observe` returns only events for
its requested binding/current generation. `reconcile.generation` identifies the
current supervisor; each evidence request retains the originating
`binding_generation`, and its returned matched events retain that same historical
generation. The adapter verifies exact host identity before historical
reconciliation; scope validation alone does not prove host identity. Historical
facts never reopen old dispatch or rewrite a sealed attempt. Unrequested,
duplicate or mismatched evidence scopes reject. Every requested attempt must be
represented by an evidence entry or unresolved ID; omission is a malformed
response, leaving callers' persisted unresolved state intact. Each collection
contains no duplicate attempts, but evidence and unresolved IDs may overlap when
facts remain incomplete. Empty requests/results are valid. This response
completeness proves neither delivery nor outcome; partial facts never prove
non-delivery.
Repeated consistent facts are no-ops. Conflicting turn IDs or outcomes pause
with `protocol_conflict`; arrival order must not regress progress.

Provider frames max8MiB; private control JSON frames max1MiB. The deferred
executable plugin draft uses JSONL with the same 1MiB bound. Drain
stdout/stderr concurrently. Frame before UTF8/JSON decoding, reject malformed
required fields, split Unicode safely, bound unterminated lines. Unknown optional
events may be ignored; unknown requests return unsupported. Use bounded channels
256 diagnostic records; lifecycle facts backpressure/pause dispatch rather than
drop. The in-process supervisor may instead serialize one bounded response,
retaining all lifecycle facts until validated Core receipts.
Transient visible text may coalesce33ms/8KiB or drop with explicit gap notice.
Diagnostics ring max2MiB/binding in memory, individual displayed text64KiB with
truncation label; no private reasoning/raw tool args/env/auth payloads.

## 3. Claude Code 2.1.287 adapter

Live starting point: [archived Mod implementation](https://github.com/kartiksayani/ariadne/blob/a5e306f/poc/claude-mods/plugin/hooks/register.js)
and [its tests](https://github.com/kartiksayani/ariadne/tree/a5e306f/poc/claude-mods).
Ship JavaScript Mod + shared rule skill with the plugin; replace Python/SQLite
broker calls with the installed version-matched Rust CLI. No Node daemon or
Python runtime dependency. Use `$.process.run([absolute_helper,"bridge",...],
{stdin:JSON.stringify(payload),timeoutMs:5000})`; never interpolate owner text
into shell commands. Helper resolves state via explicit binding handles.

1. On `session.start`, register `/ariadne-connect`, `/ariadne-status`,
   `/ariadne-disconnect`; install a1s `$.clock.every` poll with reentrancy guard.
2. Connect gets `$.session.id()` and `$.session.cwd()`, registers/validates project
   and host binding through CLI, returns IDs/instruction snippet and generation.
   After validating the full saved receipt and explicit target, publish its exact
   binding/generation through the existing bound announcement before requesting
   lease-backed status. Retain saved scope and the original connect request when
   its acknowledgement or status is pending; explicitly retry the same selector
   once native reconciliation publishes the route. Pending status enables no
   claims and cannot manufacture Connected or a fresh binding.
   Retain a quiesced existing claim-loop reporter for the validated saved scope
   before those awaits: actual session end still reports Disconnected while status
   or its acknowledgement is pending, including a late saved receipt. Preserve
   distinct original-loop callbacks and unsaved reports, and reuse identical
   scope/report identities on failure instead of overwriting them.
   Reconnect with outstanding work is recovery_required, not an automatic replay.
3. When no local active claim, poll desktop through `bridge claim`. Desktop alone
   decides eligibility; no claim if app absent, paused or incompatible.
4. Set local active attempt BEFORE `$.prompt.submit({text})`. Submit detached
   from the timer callback; promise may resolve before or after turn.start.
5. Record `{drop}` as rejection only if no turn evidence exists. Late rejection
   conflicting with a started turn is uncertain. Preserve captured binding/claim
   in callbacks, never use a newly connected global variable for old work.
6. On main `turn.start`, match the full input marker at its defined envelope
   position and verify text digest/identity; bind `e.turnId`. Check current session
   equals bound external ID. Unrelated terminal/subagent turns cannot consume a
   claim. Session switch pauses and invalidates the old connection.
7. On matching main `turn.complete`, report turnId, reason, isAborted and bounded
   visible text diagnostic. Core records lifecycle only; agent CLI/MCP results
   supply actual item messages. Locally clear active after a matching validated
   successful Core report receipt, including an unchanged observation;
   next claim still waits for core's domain-result/turn join.
8. On `session.end`, stop polling and report disconnected best-effort. Missing
   end event is handled by stale heartbeat/reconciliation, never assumed clean.

Identity uses `[ARIADNE_INPUT:<input_uuid>:<attempt_uuid>]` plus binding/generation
in the injected envelope. The canonical persisted submitted payload begins with
that exact marker line and LF, then safely encoded owner/context data; the digest
covers the entire exact payload. A provider must not add the marker after hashing.
P2.2 owns the production claim formatter; P2.5 owns MCP transport.
Payload contains exact owner text, kind, item path,
question revision/snapshot, references to bounded recent item messages, and
instructions for `apply.input_result`. Escape owner content as a JSON value or
clearly delimited data block; it cannot change envelope routing. Total prompt
content≤64KiB; include recent context≤16KiB and tool read references for older
history. Owner text is never silently shortened.

Helpers may fail; retain unsaved events in a bounded memory retry queue and stop
new claims. If the host exits before evidence can persist, core remains uncertain.
Do not claim a durable recovery guarantee from hook delivery. No blocking Stop
hook to force another inference, permission changes, hidden transcript read or
next-user-message dependency. Exact Mod APIs above were live-proven; transport
POC did not exercise production domain tools or full recovery.

The installed Mod imports an installer-local immutable JS descriptor carrying
absolute helperPath, matching appVersion and apiVersion1; source checkouts have
no descriptor and cannot fall back to PATH, plugin cache roots, environment or
development helpers. Require a Claude SDK engine version equal to the CLI version,
both 2.1.287 or a newer 2.1.x patch, and matching helper/plugin version before
connect/poll. A newer patch is accepted and marked `untested`; other minors/majors
and older patches stay rejected ([ADR-0071](../../adr/ADR-0071-accept-newer-host-patch-versions-as-untested.md)).

The actual2.1.287 SDK plugin identity is `{name,root}`, without a version property.
Use its explicit loaded root and imported immutable descriptor; native qualification
compares that exact root's manifest/fixed resource checksums against the installed
bundle and verifies canonical executable/helper/project identities and both version
commands. It never crawls cache roots or interprets installed files alone as a loaded
Mod. P3.7 supplies fresh UID-checked scoped announcements; P6 preserves immutable
version directories and rejects different bytes at the same version. This is reload
version/cache compatibility, not in-memory code attestation. Missing/unverifiable
runtime evidence is Unknown; concrete mismatch requires reload/update. See ADR0037.

Native first-party pull submit is Unsupported. Lifecycle remains bridge report→Core;
normalization retains original captured scope and canonical ISO millisecond timestamps.
No independent host history is available: reconciliation returns all requested attempts
unresolved and never treats an old token/absence as no delivery. It is bounded to100
attempts per request and nonempty markers≤4KiB, with actionable invalid_argument for a
narrower batch. Presence-only observation has no lifecycle checkpoint. Fresh/stale
snapshots keep original last-seen times and Unknown execution; a known cleared native
evidence slot emits Unknown connection/execution/freshness with no last-seen/source
and native observation time, never Disconnected/Idle or resend permission. Private
observation identity includes the complete presence snapshot, including freshness.
Actual composition must re-evaluate persisted unsealed attempts after later Mod report
commits before admitting claims; P2.2/P3.2/P3.7 still own that durable runtime join.

Native qualified connection owns canonical `connected` evidence: only it supplies
verified endpoint fingerprint/capabilities under §2. Mod connect validates the
canonical saved receipt and scoped status/external session ID; reachability alone
does not mean readiness. Installed Claude identity is adapter_id/config namespace
`claude_code_mod`, local_bridge name `claude-mod`, values={}. The callbacks report
actual captured lifecycle and best-effort session-end `disconnected`, without
inventing connection facts or provider receipts. Unchanged SDK submit result.text
or exact matching turn.start supports accepted with receipt:null.

SDK answer&&!isAborted maps to completed; aborted/isAborted to interrupted;
refusal/error to failed. Unknown evidence is uncertain. Keep final visible text
as bounded diagnostic only. Retain exact report events until matching validated
receipts and prevent reconnect/new claims while a detached submission remains
unsettled. Serialize owner connect/disconnect transitions: close prior-loop claim
admission before mutation awaits, drain any admitted bounded poll and recheck
original claims/callbacks/pending reports before rotating. A late claimed attempt
remains in its original scope without submission; failed/uncertain helper responses
retain original request/event IDs and block rotation. Recheck after owner receipts
as well, retaining any late original-scope evidence rather than replacing its loop.
A committed owner receipt is exposed with recovery required; retained evidence
does not restore old claim authority or imply a clean rollback.
Identical terminal facts coalesce ignoring observation timestamps.
Retain original and first contradictory terminal snapshot with the same terminal
fallback identity, pause claims and require reconciliation. Further unsupported
distinct terminal revisions retain one bounded explicit uncertainty/gap fact,
stop intake for that claim and expose failure; additional raw callbacks are not
claimed persisted. They never overwrite retained unsaved facts. The consuming
installed test renders shipped immutable setup resources, imports that actual
Mod and forwards helper argv/stdin to the production executable, with actual
native activation/private control/Core/Store. Only Claude SDK/host and its version
response are scripted. Existing-session history and future-input isolation,
result/completion ordering and late original-scope reports are deterministic
installed-composition evidence; live-host M7 remains separate.

Following native qualification, pre-ID facts and final Adapter.connect share the
same conditional capability constructor: installed helper release `0.1.0` supports
domain CLI commands, unknown releases and domain MCP remain unsupported. Support
still requires the exact selected helper/version, fresh SDK identity/project,
Claude `2.1.287` and all nine loaded/installed resources. It grants no Core authority,
dispatch admission, host approval or individual operation success. Immutable release
identity cannot distinguish different helper builds reporting the same version;
changed command semantics require a changed release identity. No cryptographic
helper attestation is claimed. See ADR-0051.

## 4. Codex 0.160.0 adapter

Use installed `codex`, existing shared daemon, and selected known thread. Resolve
socket from configured endpoint or `$CODEX_HOME/app-server-control/app-server-control.sock`
(default `~/.codex/...`). Resolve socket symlink (the POC needed this), require
local Unix socket owned by current user and validate peer UID. This exception
for provider sockets does not permit symlinked Ariadne data files. Record resolved
endpoint identity; daemon replacement reconnects require fresh initialize/probe.
Do not read auth files, reset config home or spawn an unrelated app-server.

Open WebSocket over Unix with standard HTTP Upgrade, validated accept response,
masked client frames, ping/pong and bounded fragmented-text handling. Use Rust
tungstenite on UnixStream; the [archived Python framing reference](https://github.com/kartiksayani/ariadne/blob/a5e306f/poc/codex-queue/unix_websocket.py)
is transport evidence. This endpoint is NOT JSONL. Application requests inside WS messages
are JSON-RPC-shaped without a `jsonrpc` member.

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"ariadne","version":"0.1.0"},"capabilities":{"experimentalApi":true}}}
```

After successful response send `{"method":"initialized"}`. Probe `thread/read`
with `{threadId,includeTurns:false}`, `thread/queue/list`, and
`thread/turns/list` with `{threadId,limit:20,sortDirection:"desc",itemsView:"full"}`.
Validate returned identity, loaded/available state and readable full items.
Initialize userAgent + CLI version are compatibility evidence, not identity alone.
Manual thread ID comes from Codex `/status` (session ID); connection UI explains it.

Persist attempt, then spawn explicit argv:

```text
codex queue --remote unix://<resolved_socket> --thread <exact_id> --message <payload>
```

No shell. One command timeout20s; exit0 is queue acceptance only. CLI text receipt
is optional diagnostics, not a stable parser dependency. A nonzero exit or timeout
after spawn is uncertain unless the adapter can prove rejection before delivery.
No retry by default. Marker in the original user message binds the actual turn.
Verified exact original user-message marker/full-payload evidence normalizes
acceptance before turn-start, even after a lost sender receipt. Preserve a valid
actual clientId as the opaque receipt provider reference, else the actual bounded
user-message ID; unusable optional clientId is absent, never truncated. Provider
references alone never match or deduplicate Ariadne attempts. Receipt timestamps
remain the original observation time and stay out of stable accepted event IDs.

The native Adapter executes blocking observer/sender IO on one bounded provider
worker, never the UI/executor thread; its absolute budgets include waiting time.
Worker/correlation bounds reject only a new proven-unadmitted sender. Retained
identical pending submissions remain uncertain and completed submissions replay
saved outcomes; cancellation after possible send never authorizes resend.
Provider-private context is capped at 100 simultaneous attempts and retires after
acknowledged terminal facts. Core/runtime remains durable replay/lease authority;
cache retirement or restart does not request retrying a possibly sent attempt.

Observation checkpoints are provider-private versioned instance/scope/offset
candidates. Echo them only after committing that page's durable effects; retained
batches replay until acknowledgement. Old/foreign/unoffered observation tokens
reject clearly, while explicit persisted-attempt reconciliation remains usable
with fresh provider pagination after restart. Presence-only observations are
ephemeral and cannot block idle disconnect/reconnect. Pending durable lifecycle
batches prevent changing connection scope; same-generation same-identity reconnect
preserves context, and a generation change retires old context only after pending
facts have been acknowledged. Runtime P3.2 owns this composition and the P3.6
acceptance join; see [ADR-0027](../../adr/ADR-0027-native-codex-queue-and-observation.md).

While outstanding: poll full turn pages every250ms, back off to1s on transient
read errors while showing reconnecting. Traverse newest-first until the saved
pre-submit turn anchor, retaining cursor; cap work at1000 turns/poll and schedule
remaining pages without starving the UI. No POC's100-turn production restriction.
On missing anchor perform bounded multi-pass reconciliation; never interpret an
incomplete search as 'not sent'. Match exact input marker and payload in
`userMessage` content only; zero matches stays unresolved, multiple matches pause.
Keep user-message `clientId` as evidence, not Ariadne ID (CLI chooses it).

Read matching turn status and timestamps and visible agent-message IDs/phases.
Persist lifecycle; text is diagnostic only. Store checkpoint after core commits
all durable effects in that batch. Restart can re-read/replay safely. Do not
write notifications subscription state, claim approval requests, call thread/start,
thread/resume, turn/start or queue/start. `thread/queue/add` is not production v1;
its equivalence and caller-client-ID mapping were not proved.

## 5. Session discovery and presence — included in v1

Claude's Mod session.start/end and turn.start/complete are lifecycle sources.
Traditional `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, `SessionEnd`
hooks may supply supplemental hints when explicitly installed by setup. They
return success without blocking/injecting prompts. Deduplicate against Mod facts;
Stop means a response ended, not that the process exited or input was handled.
Official hook semantics: https://code.claude.com/docs/en/hooks .

Use Mod heartbeat every30s, stale after90s. A heartbeat reports bridge presence,
not activity. Ignore stale timestamps after app/machine wake until refreshed.
Record actual observed turn state separately. Codex known-thread read-only state
poll every30s while idle; active-delivery polling already supplies freshness.
Discovery is included in the first version. Claude's installed Mod announces
session ID, cwd and Mod version to the app's private control socket on session
start and every 30 seconds, even before binding. This only advertises a candidate;
it never claims work, submits a prompt or writes domain data. Failed announcements
are ignored until the next timer; no inference is triggered. The app keeps these
candidates in memory, expires their freshness after 90 seconds and offers Connect.
A fresh announcement after app launch makes an already-open session discoverable.

The private announcement params are exactly
`{adapter_id:"claude_code_mod",external_session_id,cwd,host_version,
plugin:{name:"ariadne",root},descriptor:{helperPath,appVersion,apiVersion:1},
binding_scope:{binding_id:UuidV4,generation:UuidV4}|null}`. SDK plugin name/root
and imported immutable descriptor are actual loaded identity inputs; no imaginary
SDK plugin version, own registration capture or guessed cache root is used.
All metadata strings are nonempty UTF-8 at most 4 KiB, and paths must be absolute
without traversal. Native intake canonicalizes cwd and loaded root. Native
receipt time alone controls age; a caller cannot supply freshness or parity.

At most 256 live candidates are retained across providers. Expire native-age
90 seconds before admission, refresh the same provider/endpoint/session in place,
and return actionable `capacity_exceeded` rather than evicting a fresh candidate.
An announcement acknowledges an Unknown candidate, not compatibility, readiness,
dispatch, execution or Ariadne identity. A bound scope is a claim checked against
trusted registration: exact binding, SessionRef, canonical project, provider,
external session and current generation. Resolve owned facts before path IO and
recheck afterward; no Registry/Store lock spans provider/resource IO.

Only explicit native version/resource comparison may qualify the candidate and
fill its Claude evidence slot. Preserve the original receipt Instant and UTC
time through the bounded qualifier, never qualification-completion time. Recheck
the exact candidate plus current registered association before publication;
expired, replaced or rotated evidence cannot refresh or retarget a binding.
Track only one evidence-slot reference per live candidate. Replacing that slot
or changing project/loaded-root/descriptor/engine-version/registered-generation
clears prior qualification and requires explicit requalification. An identical
heartbeat updates the candidate without refreshing earlier qualified evidence.
Wake clears qualification; expiry drops the cache reference and lets outside
readers age the original evidence to stale. Sixteen bounded offloaded probes
retain their permits after caller cancellation; busy admission returns actionable
`capacity_exceeded`. Missing/stale evidence remains Unknown;
it never means Idle or authorizes reconnect, claims or resending. See
[ADR-0042](../../adr/ADR-0042-native-discovery-and-announcement-intake.md).

Native Claude pre-ID qualification returns owned provider facts from those same
checks, with the original receipt age and endpoint fingerprint; it grants no
future binding/generation connection or lease. The already-blocking owner
verifier may use the existing bounded discovery qualifier with its original
absolute deadline outside all Registry/Store locks. Bootstrap composition saves
connection Unknown (therefore disconnected dispatch readiness) and returns the
immutable receipt before awaiting a bound Mod announcement. The actual matching
saved binding/generation announcement must be qualified before final
Adapter.connect; persist canonical Connected and all reconciliation receipts
before activating the physical-lease/ClaimGate route. Owner pause/recovery
barriers remain. Exact bootstrap replay returns the original receipt even after
state progresses. Native activation and Core fact mapping remain a consuming
join; see [ADR-0051](../../adr/ADR-0051-claude-native-pre-id-qualification-facts.md).

For Codex, enumerate the existing daemon's loaded-thread IDs and join read-only
thread metadata to get cwd/title. Probe the pinned schema's thread/loaded/list
and thread/read; paginate and refresh every 30 seconds while the connection UI is
open. Loaded means available in the daemon, not proof of a visible terminal or
active inference. Do not start a daemon or resume a thread for discovery. Manual
ID entry remains available. If a provider capability is unsupported, display the
specific limitation and discuss pruning with the owner if solving it becomes
complex; do not silently remove discovery from the release. No transcript crawler.
Never infer idle from an absence of events.
PID+process-start identity may support connection evidence but not per-thread
activity, especially for shared daemons. Lost heartbeat marks stale, not dead.

Native discovery starts with connection UI closed. The consuming desktop sets
`set_connection_ui_open(bool)` and calls `refresh_after_wake()`; only an actually
open UI starts 30-second Codex scans. Each blocking page reuses the verified
unbound reader on the existing runtime offload with an absolute 10-second bound
covering initialization/metadata. Closing the UI or stopping discovery prevents
later pages/publication; started IO finishes within its original bound, without
signalling an external host. Cursor progress, duplicate IDs, 50 pages and 256
candidates bound complete scans. An incomplete/overflow scan retains the last
complete snapshot as stale/error, never silently clips a healthy list. Owned
read-only snapshots leave response-size-bounded serialization and actual UI
activation to the desktop consumer; no renderer-selected endpoint/root or new
public UI DTO is introduced here.

## 6. Compatibility and permissions

Release allowlist begins with the live-tested host versions above; ship exact
fixtures and `doctor` checks. New versions require conformance fixtures plus live
existing-session test before widening the allowlist; no automatic CLI downloads.
At app startup and binding connect, resolve the configured executable to its
canonical path, run its version command with a five-second timeout, and match
the adapter compatibility manifest. Recheck after executable identity/mtime
changes and after daemon reconnect. For Codex, require the initialized daemon's
reported version to match the tested CLI/daemon pair; an unparseable or mismatched
version disables dispatch with `unsupported_host_version`. History already in
Ariadne remains readable and owner inputs may still be saved. Do not auto-upgrade,
silently fall back to another endpoint or treat a newer semver as compatible.

The [official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)
describes experimental WebSocket transport and version-specific schema output.
Our existing Unix-socket proof demonstrates the selected primitive, not upstream
production support or future compatibility. Claude's Mod is similarly isolated
behind a version gate. It is required because it actively invokes
`$.prompt.submit()` in the existing conversation. Traditional lifecycle hooks
can supplement observation; they do not provide that proven inbound mechanism.

### Codex wire schema and code generation

During M0, generate with the exact tested CLI, never a downloaded floating version:

```sh
rtk proxy codex --version
rtk proxy codex app-server generate-json-schema --experimental --out contracts/providers/codex/0.160.0/schema
```

This command generates files only; it does not start a daemon or model turn.
Record executable version, command, schema file SHA-256 inventory and fixture
provenance in a sibling `manifest.json`. Keep original generated files unchanged.
The experimental flag includes the history methods this adapter consumes.
The CLI's schema is separate from Ariadne's Rust-authored domain/adapter schemas.

Implement `cargo xtask gen-codex-wire --version 0.160.0` using pinned `typify`
and `schemars` in the build tooling. Starting from the generated individual
InitializeParams/Response and ThreadRead, ThreadQueueList and ThreadTurnsList
Params/Response schemas, generate each root in its own Rust module (its local
definitions remain scoped there). This avoids name collisions from independently
generated roots. Include referenced definitions without hand-changing their
types. Rustfmt output into `crates/ariadne-adapter-codex/src/generated/v0_160_0/`.
Keep the small transport envelope and provider-to-Ariadne translation handwritten;
all method payload/result fields come from generated types. No generated provider
DTO appears in the public core or renderer contracts.

Check generated files into source control. `cargo xtask gen-codex-wire --check`
regenerates from vendored schemas into a temporary directory and fails on drift;
ordinary builds use checked-in code and do not need Codex installed. M0 gates
generator compilation; M3 fixtures gate decoding the live POC's full item views,
queue and initialization, explicit nulls, unknown optional fields and required
field failures. Unknown turn/item variants stop reconciliation with a compatibility
error, never imply successful completion. A schema alone cannot verify endpoint
semantics: extending the manifest still requires a live existing-session test.

Both hosts keep their existing authentication, sandbox and approvals. Ariadne
can show 'Check terminal' when the adapter observes approval waiting, but cannot
approve or deny host work. Missing observation displays unknown, not a invented
permission state. Optional future managed-launch/approval capabilities require
separate contracts and proofs; they are not release-one tasks.
