# Agent adapter interface and future extension reference

**Release scope:** implement the shared Rust adapter interface and DTOs now, with
Claude, Codex and an in-process fake exercising the same interface. Keep provider
specifics out of core/store/UI. Public executable registration, manifest loading,
capability negotiation and third-party conformance below are a later extension
reference, not first-version deliverables. See [PERSONAL_RELEASE](PERSONAL_RELEASE.md).
Do not freeze or expose that draft executable protocol as a supported public API
until the extension feature is built.

## Required in v1

The core never switches on Claude/Codex names. First-party adapters and an
in-process fake implement Rust traits with shared DTOs. The interface provides
`probe`, `connect`, `submit`, `observe`, `reconcile` and `disconnect`; adapters
normalize lifecycle and presence events while domain state remains in core.
Claude is pull-driven through Mod claims; Codex is push-driven through its queue
CLI. Test the same queue/result join and binding scope through the fake interface.
Adding a provider should require an adapter and composition-root wiring.
A public runtime plugin loader is not required.

The callable v1 seam and exact owned records are published in
[PROCESS section 2](low-level/PROCESS_AND_PROTOCOLS.md#2-shared-adapter-contract).
It uses an object-safe `Send + Sync` Rust trait with boxed `Send` futures; runtime
owns execution/deadlines. Canonical domain capability, presence, checkpoint and
host-receipt records are reused. The in-process scripted fake is test/dev only,
behind the default-off `test-support` feature for consumers, and never substitutes
for a normal release adapter. Shared cases live in `fixtures/contracts/adapter`;
they preserve replay, conflicting facts, uncertainty and distinct text chunks
for core/runtime to adjudicate. Checkpoint advance remains explicit after effects
are persisted. Full P0.5 acceptance still waits for P0.3 canonical fixtures.

## Deferred executable extension draft

The sections below are a proposed later extension. They do not define first
release commands or acceptance requirements. A future registered local
executable would implement serialized DTOs corresponding to the Rust seam.
[Process protocol](low-level/PROCESS_AND_PROTOCOLS.md) specifies runtime ownership
and host wires; [domain API](low-level/API_AND_MCP.md) specifies explicit results.

### Future manifest and registration

```json
{
  "id":"example.local-cli",
  "display_name":"Example Agent",
  "version":"1.0.0",
  "protocol_major":1,
  "executable":"/absolute/path/to/ariadne-example-adapter",
  "args":[],
  "configuration_schema":{"type":"object","additionalProperties":false,"properties":{}}
}
```

`ariadne adapters register /absolute/path/adapter.json` validates syntax, unique
namespaced ID `[a-z0-9][a-z0-9._-]{0,63}`, executable absolute regular file, owner
confirmation of local code, and protocol compatibility. Copy validated manifest
to the user registry; do not download or execute repository-provided manifests
on project open. Update is explicit with version/change preview. Unregister
requires disconnected bindings. Adapter code has normal OS-user privileges; it
is not sandboxed. Configuration excludes credentials; host retains its login.

### Future executable wire schema

Private stdin/stdout JSONL;1MiB per frame, stderr bounded diagnostics. Spawn argv
directly, no shell. Request `{v:1,kind:"request",id,method,params}`; response
`{v:1,kind:"response",id,result}` or `error:{code,message,retryable}`; event
`{v:1,kind:"event",event:<normalized event>}`. Requests/responses may interleave
with events. Caller-generated string request IDs are unique per connection.
Unknown major rejects before connect/submit; unknown optional fields/events are
ignored only where declared extensible. Required fields/type errors close the
connection and pause delivery. No omitted response to an unsupported request.

| Method | Params | Result / deadline |
|---|---|---|
| `hello` | protocol_major, app_version | adapter_id/version, protocol_major, configuration_schema, capabilities;5s |
| `probe` | endpoint/config | host_version, compatibility, availability, setup_steps;10s |
| `connect` | binding_id,generation,external_session_id,endpoint/config | verified external identity, endpoint_fingerprint, capabilities, host_state;10s |
| `submit` | binding_id,generation,input_id,attempt_id,text,payload_sha256 | accepted + optional receipt OR rejected_before_delivery OR uncertain;20s |
| `observe` | binding_id,generation,checkpoint?,limit≤100 | normalized events + next_checkpoint, or subscribe token;5s |
| `reconcile` | binding_id,generation,attempt records,checkpoint? | evidence per attempt + unresolved IDs + next_checkpoint;10s/batch |
| `disconnect` | binding_id,generation | stopped observing/released resources;5s |

A request timeout during submit is uncertain. Read-only operations may retry with
backoff. No submit retry after connection loss without durable reconciliation.
Checkpoint is opaque≤4KiB and advances only after core commits all batch effects.
If event streaming is used, adapter must replay from checkpoint or report a gap;
reporting a gap cannot imply missing inputs were never delivered.

Event `{event_id,binding_id,generation,input_id?,attempt_id?,host_turn_id?,
observed_at,kind,payload}` uses the canonical kinds in the process spec:
connected, accepted, turn_started, visible_output, turn_finished, rejected,
uncertain, presence, disconnected. `turn_finished.payload` includes
`status=completed|failed|interrupted`, optional reason and bounded diagnostic text.
`visible_output` identifies host_message_id, phase commentary/final/unknown,
operation append/replace, and text. Private reasoning is forbidden. No text event
creates a domain reply. Core owns validation, idempotency and state transitions.

### Capability reference

Map names to `{supported:boolean,conditions:string[]}`; conditions are explanatory,
not executable. Required for full existing-session mode: `existing_session`,
`deferred_delivery`, `turn_correlation`, `turn_completion`, `domain_cli` or
`domain_mcp`. Optional: `history_reconcile`, `streaming_output`, `final_text_read`,
`discover_sessions`. Reserve names `managed_launch`, `cancel_turn`,
`approval_response` for later releases; v1 exposes no UI controls for them.
A plugin cannot gain automatic tool approval by declaring a capability.

Probe the actual selected host/endpoint; manifest assertions alone do not prove
support. An adapter with limited recovery may leave uncertain deliveries for
owner resolution. A fresh-run-only CLI is not compatible with existing-session
mode. No terminal keystroke injection/resume fallback is hidden behind connect.

The Claude built-in is pull-driven inside its host: app's private claim service
implements dispatch readiness, while Mod bridge translates lifecycle. Codex and
ordinary executable adapters are push-driven. Scheduler uses a common dispatch
slot interface (`prepare`, `deliver_or_offer`, `observe`), not a provider-name
branch. Neither mode can claim a second input while one is active.

### Shared binding, lifecycle and domain separation

One active binding per Ariadne session; separate sessions may share a project.
Binding is arbitrary adapter ID + opaque external ID + endpoint + generation.
Host processes are externally owned; disconnect only stops the adapter. Changing
providers creates a new binding, never rewrites message authorship or silently
transfers context. Every dispatched payload includes explicit domain routing and
an input-result instruction. Agent uses core CLI/MCP to choose item replies,
statuses and branches. Normal host completion joins the structured result.

### Deferred extension acceptance

For the later public extension, ship a separate fake executable that registers through the public manifest route,
connects a fake session, accepts five item messages, emits correlated lifecycle
and invokes domain calls as a fixture agent. Verify the same tree/history UI,
FIFO/result join, busy handling, reconnect/replay, uncertain outcome and missing
result recovery without modifying core, storage or UI. Run version/frame/unknown
capability rejection tests. First-party adapters already require shared in-process contract tests and
provider-specific live tests on their recorded versions. Executable registration
and conformance are later extension gates.

Organization security guidance was not checked under the existing Seezo waiver.
