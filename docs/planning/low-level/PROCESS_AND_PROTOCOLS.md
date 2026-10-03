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

Control envelope: `{v:1,kind:"request",id,method,params}`; response
`{v:1,kind:"response",id,result}` or `error`. Methods: `ping`, `claim`,
`connection_status`; domain bootstrap and event persistence use ordinary CLI core
commands. Requests include binding/generation. stdout is structured JSON only.
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
current reader qualifies its selected thread during bind, so production setup
also needs a provider-private read-only qualifier before IDs; P1.4 does not add a
placeholder-ID connection or an unused shared adapter method.

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
256 events; lifecycle events backpressure/pause dispatch rather than drop.
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
   supply actual item messages. Locally clear active after durable report receipt;
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
