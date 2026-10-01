# Processes, interfaces, and provider adapters

## 1. Executables and ownership

`Ariadne.app` bundles the desktop binary, version-matched `ariadne` CLI/helper, generated rules/plugin resources, frontend and local fonts/icons. The helper exposes internal `agent-worker` and public `mcp serve`; those subcommands reuse workspace crates. A PATH-installed CLI is for terminal use. Managed launches always use the bundled helper, avoiding a mismatched PATH binary.

Per active project: desktop → one worker → one provider process → its Ariadne MCP process. Every process has separate stdin/stdout/stderr pipes; MCP stdout is exclusively protocol. The worker places the provider in an owned process group, uses close-on-exec for unrelated FDs, and monitors parent stdin EOF. It never shells out through `sh -c`. Launch uses explicit executable/cwd/argv/environment, not a login shell or sourced rc file.

The runtime lease is `locks/runtime.lock`, nonblocking exclusive OS lock held by the worker. Start serializes in the desktop with a project-keyed mutex, but only the OS lease is authoritative across processes. The worker confirms lease acquisition and checks nonterminal previous runs before any provider launch. UUID run/worker identities supplement PID/start-time evidence. Failure to acquire the lease creates no provider process.

## 2. Desktop ↔ worker protocol (Ariadne-owned v1)

UTF-8 newline-delimited JSON, one object per line, versioned envelope. The first parent frame includes IDs and a reference to already-validated launch configuration; no owner prompt text or secrets are passed through argv. Worker stores/retrieves input through core.

```json
{"v":1,"kind":"request","id":"req-1","method":"start","params":{"project_id":"<uuid>","session_id":"<uuid>","consumer_id":"<uuid>","run_id":"<uuid>","launch_profile_id":"<uuid>","mode":"new"}}
```

Worker result: `{v:1,kind:"response",id,result:{worker_instance_id,run_id,state}}` or `error:{code,message,retryable}`. IDs in this section are schematic placeholders, not valid domain fixtures.

| Direction | Message | Semantics |
| --- | --- | --- |
| Parent → worker | `start` (exactly once) | Acquire lease, preflight, initialize new/resumed provider; respond when worker has accepted lifecycle ownership, not when inference finished |
| Parent → worker | `wake` | Hint that durable queue/request state changed; contains revision, never replacement state |
| Parent → worker | `stop` | Idempotent run-scoped stop; dispatch pause was already committed by parent |
| Parent → worker | `ping` | Liveness check only; no model call |
| Worker → parent | `ready`, `run_state`, `input_state` | Run/epoch scoped facts; persisted transitions include session revision |
| Worker → parent | `activity` | Bounded transient text/tool events with monotonically increasing event_seq |
| Worker → parent | `request_changed` | Permission/native input invalidation; UI reloads canonical request |
| Worker → parent | `diagnostic`, `fatal`, `stopped` | Redacted error or final cleanup evidence |

Parent request IDs deduplicate per worker lifetime. Durable side effects also have core operation IDs. Events contain `{v,kind:"event",run_id,worker_instance_id,connection_epoch,event_seq,event,payload}`. Parent ignores events for old epochs, detects gaps, and reloads authoritative state. Activity gaps are marked visibly; no implication of missing saved domain data.

Parent and worker continuously drain both stdout/stderr to avoid pipe deadlock. Incoming provider frames: 8 MiB maximum; helper frames: 256 KiB maximum, activity payloads ≤16 KiB. Owner text is ≤16 KiB UTF-8; the formatted input content is ≤32 KiB before JSON escaping, and its complete serialized outbound frame is ≤256 KiB. Measure both limits explicitly: escaping can expand control characters sixfold. Oversized answer context becomes a fetch reference; never silently truncate owner text. Parse bytes through newline framing before UTF-8/JSON decoding; handle split Unicode, CRLF, partial final frames and long lines. An unterminated frame at EOF is a protocol error if nonempty. Keep at most one max-size pending frame per stream.

Use a bounded event channel of 256 entries. Coalesce text deltas for the same block every 33 ms/8 KiB and drop only transient activity with an explicit gap event when needed. Lifecycle/permission/result events bypass that lossy buffer through a separate bounded priority channel; inability to service it pauses dispatch. No UI consumer may block provider pipe draining indefinitely.

## 3. Adapter interface

```text
trait AgentAdapter:
  preflight(profile) -> Capabilities
  launch_or_resume(binding, owned_process) -> connection
  send_input(input_id, formatted_payload) -> transport request identity
  respond_host_request(request_id, typed_response)
  interrupt(active_turn)
  graceful_close()
  decode_frame(bytes) -> list<ProviderEvent>

ProviderEvent:
  Initialized(host_id, reported_model, tool_inventory)
  InputAccepted(input_id, evidence)
  TurnStarted(input_id, host_turn_id)
  TextBlockDelta / TextBlockComplete / ToolActivity
  HostRequest / HostRequestResolved
  TurnCompleted(input_id, host_turn_id, success|failed|interrupted, error)
  ProviderError / Exited
```

Scheduler owns state transitions; adapters translate protocol only. `Capabilities` includes exact tested protocol baseline, per-input correlation, permissions, native input, cancellation, resume, and optional model metadata. Unknown optional notifications are ignored with sampled metadata diagnostics. Unknown server requests receive a method/unsupported error or a safe denial; they are never left waiting without UI explanation. Malformed required response is fatal to that connection.

## 4. Claude Code wire contract

Evidence: installed CLI **2.1.287** help/version; Anthropic's published SDK **0.3.287** type declarations; official [CLI reference](https://code.claude.com/docs/en/cli-reference), [streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), and [streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output). SDK types are protocol evidence, not a decision to ship that SDK. Raw CLI behavior must pass C01–C05 in VERIFICATION.

Planned argv (each displayed token/value is a separate argument):

```text
claude -p
  --input-format stream-json --output-format stream-json
  --verbose --include-partial-messages --replay-user-messages
  --permission-mode default
  --strict-mcp-config --mcp-config <generated-mcp-config>
  --settings <generated-settings-overlay>
  --permission-prompt-tool mcp__ariadne__permission_prompt
  --append-system-prompt-file <canonical-managed-rules>
```

For resumed runs add `--resume <recorded-host-id>`. A fresh run uses a fresh Ariadne binding and captures the provider's init ID. Do not assume init appears before the first input: allow the **initial prompt** to be sent while awaiting initialization; bind the returned ID before any later input or receipt is routed. The pre-created MCP binding uses Ariadne IDs and does not require the host ID. Initial crash before the ID is known is recovery_required, never automatic “new session” retry.

Set `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` in this child only. The generated Ariadne MCP server has `timeout:660000` milliseconds; its permission request expires locally after 600000 milliseconds. These settings prevent a pending approval from being automatically backgrounded at the host's default two-minute threshold. `MCP_TIMEOUT` is a separate connection/startup budget, not the permission deadline. The official [environment variable reference](https://code.claude.com/docs/en/env-vars) documents these controls; their combined raw-CLI behavior is still C03/C04 evidence to collect.

Validate that init reports the sole configured Ariadne server connected and the required tools available. Missing integration stops the run and pauses the input; it is never a successful managed launch. Since the first prompt may precede init, do not claim that failure proves no execution occurred. C04 must establish the permission server's startup wait and failure path; preserve any uncertain first-turn evidence rather than silently resending it.

Input frame seed:

```json
{"type":"user","uuid":"11111111-1111-4111-8111-111111111111","message":{"role":"user","content":"<formatted owner input>"},"parent_tool_use_id":null}
```

Use a fresh attempt UUID and persist it before writing. Top-level owner input has null parent_tool_use_id. Do not fabricate a `session_id` in the first input. Preserve stdin between turns. Correlate only the one Ariadne input currently in flight.

| Claude output | Adapter action |
| --- | --- |
| `system` / `init` | Capture session_id, validate reported cwd/MCP readiness/permission mode; allowlist non-secret metadata |
| `user` replay with matching uuid / `isReplay` | InputAccepted evidence, no new owner Message |
| `stream_event` text delta | Append block text, keyed by message/block identity; do not display thinking or tool JSON fragments |
| `assistant` complete text block | Finalize/replace matching streamed block; do not append the same text twice |
| Complete tool_use/tool_result metadata | Tool name/status summary; domain mutation is performed only by actual MCP call |
| `result` success | Correlate user_message_uuid when present; complete active turn, even though process stays open |
| `result` error subtype | Fail current turn and pause queue; keep result/usage as bounded diagnostics, not billing truth |
| EOF/exit before result | Interrupted/uncertain active turn; preserve pending input |

Published types expose user-message correlation on first response/result and possible multiple correlated inputs. Our scheduler never deliberately sends multiple inputs concurrently. If a result reports unexpected multiple inputs, stop dispatch and diagnose protocol/order violation rather than silently merging turns. Correlation assumptions are live-test gates. Explicit UUID reuse has no claimed server deduplication guarantee.

### Claude permission tool

Candidate compatibility schema: `{tool_name:string,input:object}`; allow result `{behavior:"allow",updatedInput:<exact original input>}`; deny result `{behavior:"deny",message:<reason>}` encoded in an MCP text content block as JSON. This shape is shown in Anthropic's [published CLI SDK permission example](https://docs.anthropic.com/fr/docs/claude-code/sdk); the current SDK [approval guide](https://code.claude.com/docs/en/agent-sdk/user-input) documents the related callback result shape. **Treat raw CLI compatibility as C03, not as already executed evidence.**

The permission tool creates a local request UUID because this payload need not provide a host request ID. The pending MCP invocation is the return channel. It polls/watches that exact store record and sends its result only on the same invocation. Timeout/EOF expires the request; a replacement invocation receives a new request. The tool may return allow only after the matching owner decision and must not alter tool input. Auto-allow only Ariadne's enumerated domain tools and bridge entry; no wildcard Bash/Edit allowance. Existing host rules may decide operations before the bridge; Ariadne does not promise to display preauthorized requests.

Stop sends SIGINT to the owned provider as the first cancellation step, then uses the common cleanup deadlines. The CLI's EOF behavior and child cleanup require executable proof. Do not use undocumented SDK control frames in the direct adapter. If C03 or cancellation cannot meet requirements, an SDK sidecar is a deliberate revised design with packaging/auth impact, not a silent fallback.

## 5. Codex wire contract

Evidence: installed **0.159.3** schema generated read-only with an isolated temporary CODEX_HOME; [official app-server documentation](https://learn.chatgpt.com/docs/app-server). Newline JSON-RPC-shaped frames omit `jsonrpc`. Provider process is `codex app-server --listen stdio://` with generated command-line configuration overrides. Use one app-server process for one Ariadne consumer.

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"ariadne","title":"Ariadne","version":"0.1.0"},"capabilities":{"experimentalApi":true}}}
```

The pinned baseline opts into experimentalApi for native user-input handling; enable no unrelated experimental features. Verify this capability in N03. After response send `{"method":"initialized"}`. Then:

```json
{"id":2,"method":"thread/start","params":{"cwd":"<canonical-project>","approvalPolicy":"on-request","sandbox":"workspace-write","developerInstructions":"<canonical Ariadne rules>"}}
```

Use `thread/resume` with `threadId` and validated equivalent launch settings on Resume. Preserve normal host base instructions (`baseInstructions` unset). Managed policy can restrict the requested profile; do not retry by weakening it. Record returned `thread.id` before input. Native model/provider defaults stay inherited unless the owner chose a supported override.

```json
{"id":3,"method":"turn/start","params":{"threadId":"<recorded-thread>","clientUserMessageId":"<attempt-uuid>","input":[{"type":"text","text":"<formatted owner input>"}]}}
```

`turn/start` response supplies turn.id and establishes acceptance. Stream item/agentMessage/delta into text blocks. `turn/completed` with status `completed` advances FIFO; `failed`/`interrupted` pauses. Never equate request ID with turn ID. An `error` response contains no proof of side effects unless protocol evidence establishes pre-execution rejection; otherwise remain conservative.

Input UUID field is present in the local schema; no deduplication guarantee was found. On uncertain recovery, `thread/read` with `includeTurns:true` may establish persisted user-item and turn evidence; match by supported IDs, not merely coincidental text. If no unique match exists, remain uncertain. Do not inspect rollout files privately.

### Codex requests and responses

| Server method | Response on same JSON-RPC request ID |
| --- | --- |
| `item/commandExecution/requestApproval` | `{decision:"accept"}` for Allow once, `decline` for Deny, `cancel` for cancellation |
| `item/fileChange/requestApproval` | Same limited decision set; Ariadne intentionally does not offer session-wide grants or policy amendments |
| `item/tool/requestUserInput` | `{answers:{"question-id":{answers:["selected label or owner text"]}}}` per generated schema |

These objects go under `result`. The provider protocol supports more approval variants than Ariadne offers; intersect each request's availableDecisions with Allow once/Deny/Cancel and do not send a disallowed choice. If no safe supported choice exists, show the incompatibility and cancel safely. Preserve opaque IDs without casting. `serverRequest/resolved` may mean response, interruption or cleanup; it clears that request but does not imply allow. Native question support is experimental; test N03 and use Ariadne MCP for normal questions. Unsupported native requests fail explicitly.

`turn/interrupt` uses the exact recorded threadId and active turnId. Close stdin/process only after allowing completion/cancellation events. Optional `account/read` with `refreshToken:false` returns sanitized auth readiness (`requiresOpenaiAuth` and account presence); discard identifying account fields. Ariadne never calls login with token payloads.

## 6. Configuration and authentication boundaries

Provider CLIs read their normal user authentication. Ariadne never reads credential files/keychain, collects keys, changes config homes silently or promises subscription billing. Launch profiles hold executable paths, model/permission choices and non-secret config references. Scan only configuration necessary to determine sources/overrides; redact known sensitive fields before diagnostics. Never print full inherited environment.

Claude `--strict-mcp-config` fixes the MCP list for the managed run. Generated owned external hooks check `ARIADNE_MANAGED_RUN_ID` and return no answer injection when set. Other configured hooks require project trust and remain visible in the launch manifest; do not globally disable them or use bare/safe mode that would change required authentication/tool behavior. The marker cannot suppress unrelated hooks. A hook that independently fetches/injects Ariadne answers conflicts with managed FIFO: resolve that hook configuration before launch. Duplicate-free delivery assumes this reviewed hook inventory; it is not a guarantee against arbitrary hook programs. CLI flags and environment are tested against effective configuration in C04.

Codex uses spawn-time `-c` overrides for the Ariadne stdio MCP definition and `enabled=false` overrides for other discovered MCP entries in the default profile. No guessed per-thread `config.mcp_servers` behavior is required. Config names are serialized with TOML-safe quoting into individual argv values; no shell interpolation. Whether merge/precedence honors this profile is N02. If policy/config cannot be represented safely, block launch and explain the conflict; never silently enable extra services or write global config.

Provider auth/model errors pause the queue; they do not trigger a new account home or provider switch. Auth checks performed during real startup may contact the provider through its own process. No live provider process or auth operation was run during this planning work.

## 7. Version gate

Initially allow only versions that pass the recorded compatibility suite (starting candidates Claude 2.1.287, Codex 0.159.3). Exact-match allowlist is acceptable for local v1; broad minimum-version claims require testing. `doctor` reports selected executable, detected version, supported versions and corrective instruction. Do not auto-update/downgrade or download provider binaries. Store baseline schema/type evidence with checksums in implementation fixtures so a provider upgrade produces a reviewable diff.
