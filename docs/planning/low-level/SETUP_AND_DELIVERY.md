# Configuration, setup, installation and operations

This is the setup contract for the existing-terminal production workflow. Ariadne
does not launch, resume, kill, or change the permissions of a provider terminal.
Claude's installed Mod submits into its already-open conversation through the
local bridge. Codex's desktop adapter queues through the existing Codex daemon and
reads that thread's history over the same Unix socket. See [Integrations](../INTEGRATIONS.md)
for the end-to-end user flow and [POC results](../INTEGRATIONS.md#live-evidence-and-limits).

## 1. Installed files, project data, and bindings

```text
~/.local/share/ariadne/
  versions/<version>/bin/ariadne       # immutable versioned CLI/helper
  versions/<version>/bin/ariadne-mcp   # thin standalone stdio server
  versions/<version>/integrations/     # matching rules and Claude Mod
  current -> versions/<version>        # atomically replaced install pointer
~/.local/bin/ariadne -> ../share/ariadne/current/bin/ariadne
~/.local/bin/ariadne-mcp -> ../share/ariadne/current/bin/ariadne-mcp
~/Applications/Ariadne.app              # personal app install
~/.ariadne/
  projects.json                        # explicit canonical roots + setup receipts
  bindings.json                        # rebuildable selected binding route index
  registry.lock                        # stable global registry lock
  run/control.sock                     # desktop-owned private Unix control socket
  run/                                 # owner-only directory, mode 0700
  ui.json                     # UI/window state and drafts
  logs/                                # bounded redacted diagnostics
<project>/.ariadne/
  project.json                         # immutable project UUID and metadata
  project.lock                         # stable project metadata/setup lock
  sessions/<uuid>.json                 # authoritative domain, binding and outbox state
  locks/<session-uuid>.lock             # stable session transaction lock
  backups/                              # previous snapshot; automated repair deferred
```

Directories are mode 0700 and data files mode 0600 where supported. Executable
bits belong only on package-owned binaries. Session data is one JSON snapshot per
session and remains the authority. The project registry retains explicit roots
and setup receipts, including unavailable roots; only the separate binding index
is rebuilt from registered roots and validated authoritative sessions. Malformed
or future-version data is never silently repaired or overwritten.
Multiple bindings and independent queues may exist in one project. Dispatch is
serialized per binding, not per project. Store writes remain serialized by the
session transaction lock.

A binding persists `binding_id`, arbitrary `adapter_id`, opaque
`external_session_id`, project and Ariadne session IDs, endpoint fingerprint,
generation, capabilities, connection facts, and timestamps. External IDs are
opaque and need not be UUIDs. Every CLI/MCP request names its `binding_id`; core
resolves that binding to project/session and validates the generation. There is
no mutable current-session pointer derived from cwd, process state, or whichever
terminal most recently connected. A random binding ID prevents accidental routing
but is not a security boundary against another process running as the same OS user.

Binding creation/removal follows global-registry → project-metadata → session
lock order. Persist the binding in its session before updating the rebuildable
index. Repeat connect validates existing identity; inconsistent metadata stops
connection with a path-specific error. No setup journal or automatic repair is
required. Release locks before host I/O. Normal domain mutations take only the
session lock; no host or
socket wait may occur while holding a store lock. Never wait for an adapter
lease while holding a session lock.

The private desktop control endpoint is `~/.ariadne/run/control.sock`. Create the
parent directory mode 0700 and the socket mode 0600, verify the owning UID, and
fail with an actionable path/permission error if the OS path limit is exceeded.
The Claude Mod uses the installed bridge CLI to contact this endpoint for input
claims. If the desktop is closed, no new Claude input is dispatched. The Mod and
provider CLI can still perform explicitly bound domain CLI operations against
the project store while the desktop is closed. The Codex adapter is owned by the
desktop and stops observation/dispatch when it exits; it never stops the Codex
daemon or terminal.

Reject symlinked project data, settings, lock and temporary targets. The
installer's `current` and PATH symlinks may point only inside Ariadne's version
directory. Canonicalize project roots and verify every data operation remains
contained. Codex's existing daemon socket is the exception: resolve its final
target deliberately, permit a symlinked endpoint, and verify socket type and
owner UID before connecting. These checks prevent ordinary path mistakes; they
do not isolate Ariadne from hostile processes under the same OS account.

## 2. Supported hosts and preflight

The initial compatibility baseline is Claude Code **2.1.287** and Codex CLI
**0.160.0**, the versions used for the live existing-session proofs. These are
tested candidates, not broad minimum-version guarantees. `doctor` reports the
detected version and whether the matching adapter gate is passed. Unknown
versions may be inspected but cannot be advertised as supported without running
the compatibility acceptance suite. Ariadne never downloads or updates provider
CLIs.

`ariadne doctor` is read-only and reports:

1. Canonical project path, project UUID, filesystem support, permissions, session
   schema/backup health, and whether the requested binding exists and is current.
2. Ariadne app, helper, rules, and integration resource versions and checksums.
3. Provider version, adapter capability result, external session ID, and endpoint
   fingerprint. For Codex, validate the configured/default `CODEX_HOME`, socket
   owner UID and live daemon handshake. For Claude, validate the installed Mod
   resources and binding heartbeat/claim path when the session is connected.
4. Whether the Claude plugin needs host-side trust or reload, and whether Codex
   discovery/liveness is available from its running daemon.
5. Outbox counts and any unresolved or uncertain input attempts. No unresolved
   attempt is silently resent during preflight.

Do not read provider credential files, keychains, OAuth data, or environment
values for diagnostics. Provider authentication remains inside its own CLI and
host UI. Ariadne does not edit provider permission settings, loosen policy, or
add automatic approvals. Claude and Codex tool approvals remain visible and
decided in the host terminal. An Ariadne item answer is never a permission
decision.

## 3. Claude Mod installation and binding

Install the generated Mod at the stable resource path under
`~/.local/share/ariadne/current/integrations/claude-mod/`. The path stays stable
across upgrades; the installer atomically advances `current` only after the new
version is complete. Do not require `--plugin-dir` or a development checkout.
Package this stable root with `.claude-plugin/marketplace.json` named
`ariadne-local` listing plugin `ariadne` at `./plugin`; plugin resources include
`.claude-plugin/plugin.json`, hooks/register.js and shared rule skill. Setup
prints these exact commands with the absolute installed root substituted:

```text
/plugin marketplace add /absolute/home/.local/share/ariadne/current/integrations/claude-mod
/plugin install ariadne@ariadne-local
/reload-plugins
/ariadne-connect
```

The placeholder /absolute/home is replaced with the resolved user's directory;
quote spaces for the host command parser. Record observed installed plugin version
and require reload after upgrades; a stale cached plugin fails doctor instead of
silently mixing wire versions. The owner runs them in Claude's supported host UI/command flow and
starts or reloads the Mod in the target terminal. Setup must not rewrite unrelated
Claude settings or host trust records.

In the already-open target conversation, `/ariadne-connect` explicitly creates
or selects a binding and returns its `binding_id`, external session ID, project
identity, current connection state, and a short usage instruction. It does not
send a model prompt. The owner can copy/paste the printed Ariadne connection
instruction into the existing conversation to record original terminal work;
this is explicit and never an automatic boot prompt. Each Ariadne-dispatched
prompt includes the binding ID, input ID and attempt ID in its correlation marker.
The Mod polls the bridge CLI for claims. One input per binding may be in flight;
the next Ariadne input waits for the correlated turn to finish successfully and
for its explicit domain result to commit.

On `/ariadne-connect`, validate that the running session ID and project match the
chosen binding. Rebinding rotates the generation UUID and fences callbacks from the
old connection. A reload or lost control socket marks the binding stale; it does
not kill or restart Claude. A queued input stays saved until the app/bridge is
available again. An input already claimed or submitted without conclusive host
evidence becomes uncertain and requires reconciliation before resend.

P6 renders plugin/hooks/installed.js as a static ESM export of
`Object.freeze({helperPath:absoluteInstalledHelperPath,appVersion:matchingAppAndPluginVersion,apiVersion:1})`.
The source artifact exports null. The Mod uses supported plugin-local static
imports and SDK argv/stdin calls, with no Node/filesystem/environment/PATH/cache
fallback. Missing or mismatched resources give actionable local status and no
connect/poll. Exact supported SDK engine2.1.287 remains required; observed CLI
2.1.289 remains unqualified until new-version conformance and live existing-session proof.

Connect uses canonical owner receipts plus scoped BindingSummary to show the
actual connection state. It does not invent canonical Connected from receipts
that lack a verified endpoint fingerprint; native qualified connection owns
that evidence under PROCESS §2. Current owner/durable report composition and
installer generation remain explicit P2.4/P2.2/P3.4/P6 acceptance work.

The SDK supplies loaded plugin name/root, not `plugin.version`. Native parity checks
use only that exact reported root's manifest/resources plus imported descriptor,
engine/session/project identity and fresh native-validated announcement. Files and
version strings alone do not prove a Mod is loaded. Immutable version installs must
never replace same-version resources with different bytes; otherwise show actionable
reload/unsupported status. Missing or unverifiable evidence stays Unknown. This is
version/cache parity, not an in-memory attestation protocol (ADR0037). P3.7 owns the
actual announcement intake/association/freshness; P6 owns production rendering and
immutable installation. PR54/ADR0038 adds explicit structured existing-session handoff,
while owner CLI/native qualification and durable report composition remain required.

The Mod announces its session ID, working directory, and Claude version to the
private app control socket at startup and every 30 seconds, whether bound or not.
Announcements do not claim input, prompt the model, or write domain data. Keep
discovered candidates in memory for 90 seconds and let the owner choose a
candidate to connect; expire it from the UI when its heartbeat goes stale.

Setup copies only Ariadne's plugin files into its own stable resource directory.
If host registration is needed, add only Ariadne's named marketplace/plugin
entry and preserve all other marketplace, plugin, skill, command, hook, and
instruction entries. If Claude reports trust or plugin approval, show the host
action and wait for the owner. Do not treat plugin installation as proof that a
Mod is loaded in an existing terminal. Uninstall removes the Ariadne-owned entry
only while it still matches the value Ariadne installed; otherwise preserve it
and print its location for manual cleanup.

## 4. Codex existing-daemon binding

Codex's desktop adapter connects to the already-running app-server over its Unix
WebSocket endpoint. Respect `CODEX_HOME`; otherwise use the documented default
Codex home. Resolve the endpoint without starting a daemon, starting/resuming a
thread, or changing host configuration. Validate the target socket and daemon
identity and perform the read-only handshake. V1 uses `thread/loaded/list` to
discover loaded-thread IDs, then `thread/read` to retrieve available project
metadata from the already-running app-server. Refresh this metadata every 30
seconds while the connection UI is open. The owner selects a discovered thread
to bind. Loaded does not mean terminal-visible or active. If metadata discovery
is unavailable, allow manual binding using the thread ID from Codex `/status`
and report that limitation. Never guess the selected target or discover private
rollout/transcript files. Do not use `thread/list`, which enumerates persisted
threads rather than currently loaded threads, as the open-session discovery
source.

Only one Ariadne input per binding is outstanding. The adapter submits through
the installed `codex queue` CLI with the explicit socket and thread, then polls
full thread history over the same daemon socket. Match the input marker in the
original user-message item to exactly one turn and correlate its visible lifecycle
and final output. Do not use `thread/start`, `thread/resume`, `turn/start`, or
direct `thread/queue/add` as a substitute. The live POC did not prove caller-ID
propagation or direct queue scheduling. Use explicit Ariadne domain CLI commands
when Codex has no Ariadne MCP server; do not rewrite Codex's existing MCP config.

The desktop worker may disconnect its observer and stop dispatch, but must not
interrupt a turn, terminate the daemon, close the user's terminal, or respond to
approval requests. On desktop restart it revalidates the same socket/thread and
reconciles history. If it cannot determine whether an attempt was consumed, leave
it uncertain and require an owner decision; never fall back to a different
thread. Discovery and liveness are version-gated against the supported Codex
daemon APIs; a daemon PID alone never proves that a particular thread is ready.

## 5. Domain CLI and optional MCP

The installed CLI and optional MCP wrapper call the same core service. Baseline
existing-terminal workflows require only the explicit domain CLI; no host MCP
configuration change or terminal restart is required. When an MCP server is
available, it is a thin generic wrapper over the same commands and every tool
request includes an explicit `binding_id`. Resolve authority from the persisted
binding, not model-provided project/session paths, current cwd, prompt text, or a
global “active binding.” Reject missing, stale, cross-session, and wrong-generation
bindings with typed errors.

Ship `ariadne-mcp` beside the CLI. `ariadne mcp serve` is an equivalent alias
calling the same library entry, not spawning another writer/service. Both use
stdio only, send logs to stderr, and expose identical tools. An explicit MCP
configuration can reference the stable absolute `current/bin/ariadne-mcp` path;
installation alone never enables a host MCP configuration. Build/install the MCP
binary with the app/helper version and remove it with other Ariadne-owned CLI
files on uninstall.

Every mutation has an operation ID and returns a durable receipt. Replies,
status updates, topics, and children are explicit domain operations. A successful
host turn does not create an item reply by itself. An input result record commits
with its referenced domain mutations; queue advancement waits for both successful
host completion and committed input result. Terminal prose remains diagnostic
activity. Host turn completion, item status, answer acknowledgment, and explicit
input result are distinct facts.

## 6. Simple personal setup and uninstall

`ariadne setup --agent claude|codex|both` installs the selected resources and
registers the explicitly selected project. It never initializes arbitrary
repositories, launches a host, or changes permissions. Setup prints the files it
creates and the host commands the owner needs to run. Running setup again is
safe and reports resources that are already present.

Use `--project /absolute/project` for explicit registration; omission performs
global integration setup without selecting a repository. The matching personal
app/helpers must already be installed. Resources reference the validated immutable
version root; P6.4 owns binary/app installation and the `current` pointer. Setup's
ownership receipt records only newly created files. Matching pre-existing files
remain unowned, and different same-version bytes are never replaced. Permanent
coordination files and empty owned directories may remain after resource removal.

Keep integration resources under Ariadne-owned paths. For a required host
registration, edit only the named Ariadne entry and preserve surrounding
settings. If the host format cannot be updated without rewriting foreign
content, print the exact manual step. Uninstall removes Ariadne's files and a
named host entry only if it still matches the value Ariadne installed. Preserve
all project data and history; deleting project data is a separate explicit
owner action.

## 7. Build and personal install

Use the installed Rust and Node toolchains. Commit `Cargo.lock` and
`package-lock.json` and use locked dependencies. Generate schemas, DTOs, and
rules from their authored sources and check generated files for drift. Node is a
build dependency only; production does not bundle a language runtime.

`make install` builds the Tauri app, Rust CLI, MCP binary, and Claude Mod from
this checkout, then installs them for the current user. Keep versioned helper
files under `~/.local/share/ariadne/versions/<version>/`, update the `current`
symlink, and install the app at `~/Applications/Ariadne.app`. Create
`~/.local/bin/ariadne` and `ariadne-mcp` symlinks when that directory exists;
otherwise print the PATH instruction. Do not edit shell startup files, use
`sudo`, install toolchains, or download provider CLIs. Print the installed
version and paths, then run `ariadne doctor`.

P6.4 writes the same package-owned `current/install.json` consumed by P6.1
open routing. Its required v1 fields are `schema_version: 1`, `version` and
absolute `app_path`; helper and manifest versions must agree. `current` must
resolve inside the existing `versions/<version>` directory. A later owned-file
inventory for uninstall extends this manifest rather than introducing another
descriptor. Unknown non-routing inventory fields may be added within v1;
required fields and versions remain strict. Only `current` is constrained to the
versioned directory; `app_path` may point to the installed `~/Applications` app.
P6.1 tests use temporary package fixtures and never alter an actual
installation (ADR0053).

The commit hook runs cheap changed-language format, lint and type checks. CI
runs relevant tests, coverage and native gates for each pushed head, with full
checks for unknown paths or missing bases. Keep weighted application coverage
at or above 80%. End-to-end tests for setup, both existing-session
adapters, explicit domain results, and recovery are required release gates.

`make uninstall` removes the personal app, Ariadne-owned versioned helpers, and
CLI symlinks while preserving all project data and history. `ariadne uninstall`
removes Ariadne's integration files and only an unchanged named host entry. Do
not kill unknown processes or touch provider processes. Local unsigned builds may
document macOS's Open Anyway flow; do not recommend disabling Gatekeeper or imply
public distribution.

## 8. `doctor`, diagnostics, and retention

`ariadne doctor [--project PATH] [--json]` is read-only. Each check returns
`status: ok|warning|error`, stable `code`, concise `message`, and actionable
`hint`; JSON output also includes app/helper versions and check timestamps.

Select trusted provider executables with additive `--claude-bin /absolute/claude`
and `--codex-bin /absolute/codex` options; without them, provider version/capability
checks report unknown and the required option. Existing `CODEX_HOME`/default
semantics select the endpoint without provider configuration or credential reads.
Doctor opens only existing coordination files, using bounded lock admission;
missing/busy coordination stays unknown. Index comparison needs complete validated
authoritative observations and never rebuilds it. These timestamped diagnostics
are not an atomic dispatch-readiness guarantee. See [ADR-0058](../../adr/ADR-0058-owned-integrations-and-read-only-doctor.md).

It reports:

- App/CLI/helper/plugin version parity and supported Claude/Codex baselines.
- Project canonical path/identity, data permissions, symlink/path validation,
  session schema/backups, and registry reconciliation state.
- Binding adapter ID, external ID (redacted or truncated in summary), generation,
  endpoint/socket health, last observation, and capability state. Unknown or
  stale never means ready to dispatch.
- Required Claude plugin reload/trust action and Codex socket/daemon/thread
  compatibility.
- Queued, claimed, uncertain, missing-result, and unresolved input counts;
  explicit next recovery action. No automatic resend or host process cleanup.

Example summary:

```text
Claude 2.1.287: supported
Codex 0.160.0: supported
Project: /work/payments (registered)
Bindings: Claude connected; Codex stale (last seen 4m ago)
Recovery: 1 uncertain input requires review; dispatch paused for that binding
Result: warning — run `ariadne recovery show <binding-id>` to inspect
```

Logs retain component, error code, binding/run/operation IDs, sequence, timing,
and redacted provenance only. Do not log prompt/answer/tool bodies, host
environment, credentials, raw protocol payloads, or full host transcripts by
default. Rotation is bounded to five 1 MiB files under owner-only storage.
Diagnostic export includes sanitized versions and metadata; session contents are
included only when explicitly selected. There is no telemetry or automatic
upload. Explain storage limits before accepting work that cannot be persisted.
