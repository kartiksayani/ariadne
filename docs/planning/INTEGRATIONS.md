# Existing-terminal integrations, setup, and installation

Ariadne attaches to conversations the owner already has open in Claude Code or
Codex. Claude's installed Mod polls the Ariadne bridge for queued input and uses
the host's prompt submission API. The desktop adapter queues to an already
loaded Codex thread with `codex queue` and reads full thread history through the
same daemon's Unix WebSocket. Ariadne never launches, resumes, interrupts, kills,
or changes permissions for either host. See [Setup and delivery](low-level/SETUP_AND_DELIVERY.md)
for filesystem, binding, setup, installation, recovery, and diagnostic contracts.

## One behavioral rule source

Maintain `packages/agent-rules/RULES.md` as the authored behavior source. Generate
the Claude Mod instructions and Codex copyable instructions from it and check
generated content for drift. Provider adapters contain only host-specific
connection, submission, observation, and correlation behavior. Release one ships
Claude and Codex in organized crates behind the shared adapter boundary. Public
executable-adapter registration and proof are deferred.

Both agents must:

1. Use the explicit binding supplied with each request. Read eligible owner
answers, fetch referenced full answers/pages, and acknowledge exact answer IDs.
2. Record meaningful questions, decisions, findings, tasks, and explanations in
full sentences, without duplicating items for repeated discussion.
3. Record follow-up questions under the causal item. Preserve earlier answers
when refining a question.
4. Mark an item waiting only when owner input is needed. Give useful options and
consequences when appropriate. A question tool returns promptly; continue
independent work and finish the turn if blocked on the owner.
5. Give every terminal item an outcome and short explanation. Replace an item
with a linked item when its meaning changes; do not silently repurpose IDs.
6. Publish substantive replies and tree changes through explicit Ariadne domain
CLI operations or optional MCP tools. Never claim an uncommitted change succeeded.
7. Supply stable operation IDs on mutation retries and reread current state after
conflicts.
8. Treat owner answers as attributed information for the named item. They do not
override host instructions, security policy, or host permission prompts.
9. If Ariadne is unavailable, say so briefly, continue independent authorized
work, and retry later. Do not discard an answer or claim it was recorded.

## Installation and setup flow

The app and version-matched Rust CLI/helper are installed locally. The helper is
versioned under `~/.local/share/ariadne/versions/<version>/`; an atomically
updated `current` pointer and optional `~/.local/bin/ariadne` PATH symlink provide
stable invocation paths. The app bundle carries a helper of the same version.
The Claude Mod is installed at a stable path under the current version pointer.
Provider CLIs remain user-installed and retain their own authentication and
settings.

Project setup creates `.ariadne/` and registers the canonical project root.
`setup --agent claude|codex|both` installs the selected Ariadne-owned resources
and prints any host steps the owner needs to run. It preserves history and all
foreign host settings. Setup does not change tool permissions, enable
auto-approval, or restart a terminal.

### Claude Code

Setup prints the local marketplace/plugin installation and reload commands for
the stable Mod path. The owner runs them through Claude's host interface, then
uses `/ariadne-connect` in the already-open target conversation. It returns the
binding ID, session/project identity, connection status, and brief usage text.
It does not trigger a model call. For terminal work that should create original
Ariadne findings, the owner copies the printed Ariadne connection instruction
into the conversation explicitly.

The Mod obtains the input via the bridge CLI and private desktop control socket.
If the app is closed, it does not dispatch new owner messages. Existing bound
domain CLI calls still write to the project store while the app is closed. A
prompt carries binding, input, and attempt IDs for correlation. Binding changes
rotate the generation UUID so late callbacks from a previous connection cannot
advance the queue.

The Mod announces its session ID, working directory, and provider version to the
private app control socket on startup and every 30 seconds, including before it
is bound. These announcements do not claim input, prompt the model, or write
domain state. Keep candidates in memory for 90 seconds; the UI presents fresh
sessions for explicit owner binding. The app reports stale candidates after the
freshness window expires.

For a development checkout, the POC sequence is `/plugin marketplace add <path>`,
`/plugin install ariadne-poc@ariadne-poc-local`, `/reload-plugins`, then
`/ariadne-connect`; packaged setup prints equivalent commands using its installed
plugin identity and path. Production install never depends on a checkout or
`--plugin-dir`. Preserve Claude's trust prompts and host permission UI. See
[Claude plugin loading](https://code.claude.com/docs/en/plugins/loading#plugins-shared-through-a-repository)
and [Claude Mod POC](../../poc/claude-mods/README.md).

### Codex

The desktop adapter resolves the running app-server Unix socket from the
configured `CODEX_HOME` or the default Codex home, verifies the socket owner,
then uses `thread/loaded/list` to discover loaded thread IDs and `thread/read` to
retrieve available project context. Do not use `thread/list`, which enumerates
persisted threads rather than currently loaded ones. Loaded means available in
the daemon; it does not mean terminal-visible or active. While the connection UI
is open, refresh loaded IDs and metadata every 30 seconds and let the owner
select a thread to bind. If discovery is unavailable, allow manual binding with
a known thread ID from `/status` and show the limitation. It does not start a
daemon, start/resume a thread, or edit Codex configuration. The selected thread
remains owned by the user's existing Codex terminal.

For each bound thread, the adapter submits at most one Ariadne input at a time
using `codex queue` with the explicit socket and thread ID. It reads
`thread/turns/list` with full items over WebSocket on that same socket, correlates
the Ariadne input marker in the original user message, and polls until a terminal
turn state is observed. If observation becomes uncertain, stop dispatch for that
binding and require reconciliation; never queue again blindly or switch threads.
The baseline works without adding or replacing the user's Codex MCP servers. The
agent uses the explicit Ariadne CLI unless an optional MCP wrapper is already
configured.

Codex approval requests stay in Codex's host UI. Ariadne does not send approval
responses, change sandbox policy, or infer permission from an owner item answer.
See the [Codex queue POC](../../poc/codex-queue/README.md).

## Bindings, routing, and domain operations

Each Ariadne session retains historical bindings but has only one dispatch-enabled
binding. Discovery can show multiple candidate host sessions; the owner explicitly
chooses which session to bind. Multiple Ariadne sessions in one project may bind different agents. Each binding
has a stable `binding_id`,
`adapter_id`, opaque external session/thread ID, endpoint fingerprint, generation,
and independent FIFO. Only one Ariadne input may be outstanding per binding.
Owner messages for another binding can progress independently.

Every domain CLI or optional MCP call includes `binding_id`. Core resolves the
binding to its project/session and checks generation and operation scope. It
never derives a routing target from cwd, current selection, a globally active
session, model-written IDs, or prose. Binding IDs prevent accidental cross-route
and are not authorization against another process running as the same OS user.
The UI can select a binding explicitly when an owner works with more than one
terminal.

The domain CLI is the baseline for both adapters. Optional MCP is a generic
wrapper over the same core operations; all its tools pass explicit `binding_id`
and use the same receipts and validation. MCP availability does not deliver
incoming messages. Host completion alone is not a reply: agents explicitly
publish replies, status updates, topics, children, and an input result through
CLI/MCP. The input result references committed domain operations and its source
input/attempt. The queue advances only after both successful correlated host
completion and committed input result. Missing result pauses the binding for
owner recovery; terminal text stays diagnostic activity and is never routed
automatically to an item.

## Ownership and safety boundaries

- Provider authentication remains in official CLIs and host sessions. Ariadne
  does not read credentials, copy tokens, or promise a billing route.
- Host permission prompts remain host-owned. No integration auto-approves tools
  or changes a host's permission/sandbox settings.
- Ariadne may stop its bridge or observer and pause its own dispatch. It does not
  kill or resume provider processes, terminals, or the Codex daemon.
- Setup and uninstall touch Ariadne-owned files and only its unchanged named host
  entry. Host trust databases, user credentials, unrelated settings, and session
  history remain untouched.
- Codex socket symlinks may be resolved only after checking the final socket's
  type and owner UID. Project data, settings, lock, temporary, and install targets
  reject symlinks and must remain contained under their canonical roots.
- The private desktop control socket is in `~/.ariadne/run/`, whose mode is
  0700; the socket is 0600. An inaccessible/overlong socket path is an actionable
  setup error, not a reason to fall back to shell or network transport.

## Live evidence and limits

The supported baseline is Claude Code **2.1.287** and Codex CLI **0.160.0**.
These versions passed the following transport exercises; production domain
storage, automatic discovery/liveness, binding UI, explicit input results, and
recovery remain implementation gates.

- [Claude Mod results](../../poc/claude-mods/RESULTS.md): a user-installed Mod
connected to an existing interactive session; three real turns preserved
context, queued while busy, and captured matching `turn.start`/`turn.complete`
replies. Submission-result and turn-start events arrived in either order, so the
adapter must reconcile by IDs rather than assume callback order. The exercise
did not prove reload/recovery, interruption, concurrent terminals, or switching
sessions (`../../poc/claude-mods/RESULTS.md:35-48,63-69`).
- [Codex queue results](../../poc/codex-queue/RESULTS.md): `codex queue` submitted
three turns to a known open thread; same-socket Unix WebSocket history returned
full user/assistant items, preserved context, and showed busy FIFO turns. It did
not prove caller-supplied client IDs, direct queue RPC, terminal closure/daemon
restart, approvals, retries, deduplication, mixed terminal/app input, discovery,
or production mutations (`../../poc/codex-queue/RESULTS.md:34-61`).

V1 discovery is limited to active-session metadata exposed through the loaded
Claude announces session ID, cwd, and version at startup and every 30 seconds;
the app keeps unbound candidates in memory for 90 seconds. Codex uses
`thread/loaded/list` then `thread/read` every 30 seconds while its connection UI
is open. `thread/list` enumerates persisted threads, not loaded sessions, and is
not used for discovery. Show provider-reported candidates and liveness to the
owner, who explicitly binds one. Loaded Codex threads are not necessarily
terminal-visible or active. Unknown liveness is shown as unknown. Do not inspect
private transcripts or treat a live daemon PID as proof that a particular
session is ready. The current Codex POC did not prove discovery; the
compatibility test below is a release gate.

## Scratch-project acceptance flow

Run one disposable-project exercise per supported host and retain redacted
evidence with OS, app/helper, provider, and adapter versions. The live POCs above
are transport evidence; they do not satisfy these production acceptance gates.

1. Install and initialize a scratch project. Run setup twice and confirm it
reports the existing resources without duplicating them. Confirm installed paths
and app/helper version parity.
2. Connect an already-open host conversation explicitly. Confirm correct
project/session binding and that connection sends no model prompt. Use the
printed instruction explicitly to create terminal-originated findings and verify
CLI/MCP mutations carry the intended `binding_id`.
3. Send two Ariadne inputs to one binding, one while its host turn is busy.
Confirm distinct ordered turns and exact input/attempt correlation. Send an input
to a second binding in the same project and confirm the queues remain isolated.
4. Publish an explicit reply, a tree mutation, and an input result from a test
turn. Confirm the UI updates on committed operations, no plain-text automatic
reply is created, and the next input waits until both result and successful turn
are committed. Omit the result and confirm only that binding pauses.
5. Close the Ariadne app during a pending Claude input: no further input should be
dispatched; reopening must reconcile without blind replay. For Codex, close the
observer/app while leaving the host thread open, then reconnect to the same
daemon/thread and reconcile history. Neither path may kill/restart the host.
6. Verify discovery shows only sessions/threads returned by the provider metadata
   API, refreshes liveness while connected, marks disconnected sessions stale,
   and never inspects private transcripts or chooses a binding automatically.
   Run this against each supported host version.
7. Exercise ordinary reconnects after app close, Claude plugin reload, and Codex
   daemon restart. An uncertain send must pause for owner resolution and must not
   duplicate an owner message.
8. Verify unsupported provider versions are reported, unavailable MCP falls back
   to CLI, `doctor` is read-only, and uninstall leaves session history and foreign
   settings untouched.
9. Verify Claude and Codex permission prompts still appear and are answered only
   in their host UI. Confirm Ariadne item answers cannot grant permissions and
   Codex's existing MCP configuration remains unchanged.

Record each row as **proved on exact version**, **failed**, or **not run**. Do not
promote a transport POC or schema inspection into proof of production recovery,
permission behavior, session discovery, or domain-result persistence.
