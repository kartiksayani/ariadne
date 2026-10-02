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

See [Agent adapters](../AGENT_ADAPTERS.md) for the shared interface and later
executable-extension design. Public registration/negotiation is deferred. Rust trait
uses owned DTOs and async operations `probe`, `connect`, `submit`, `observe`,
`reconcile`, `disconnect`. Reserve `hello` for the later executable protocol;
first-party adapters and their in-process test fake do not need a plugin loader.
First-party Claude submit is pull-driven: scheduler supplies work in response to
the Mod claim. Codex submit is push-driven through its native CLI. Both use the
same core attempt/result state machine, not a mandatory artificial push socket.

Normalize `connected`, `accepted`, `turn_started`, `visible_output`,
`turn_finished`, `rejected`, `uncertain`, `presence`, `disconnected`.
Event: `{event_id,binding_id,generation,input_id?,attempt_id?,host_turn_id?,
observed_at,kind,payload}`. Deterministic IDs for terminal events use source event
identity where supplied, else hash(binding,generation,attempt,turn,kind). Presence
is ephemeral and need not have a persistent event receipt. Do not deduplicate
legitimately different output chunks using identical text hashes.

New work requires current generation. Reconciliation can report historical
attempt evidence only through the current supervisor after verifying exact
host identity; it cannot reopen old dispatch or rewrite a sealed attempt.
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
in the injected envelope. Payload contains exact owner text, kind, item path,
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
