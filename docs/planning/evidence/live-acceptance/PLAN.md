# Live acceptance plan — preparation only

Covers roadmap items P7.2 (Claude) and P7.3 (Codex). This is a manual runbook,
with no execution evidence or task-completion claim. The run uses the **final main
artifact** (the packaged App, helper and Mods built from merged main), not a
candidate build. Follow the pinned
[setup](../../low-level/SETUP_AND_DELIVERY.md),
[API](../../low-level/API_AND_MCP.md) and
[verification](../../low-level/VERIFICATION.md) contracts (V07–V13, V17–V20).
There is no runnable `npm run test:live` or `tests/live` suite.

## Before you approve (plain language, for the owner)

**What will run.** Two scratch projects per host, each with its own conversation
(Claude, P7.2) or thread (Codex, P7.3): four scratch sessions in all. Both hosts run on **paid host sessions**
(your Claude and Codex accounts are billed or drawn against their usage limits). At
most **24 short paid turns in total, 12 per host**, with no retries. If a turn fails,
it still counts and the run stops for that host instead of resending. The setup
paste for the second project's connection is also a paid turn and counts against
that host's 12-turn cap.

**What you do by hand.**
- Create both scratch projects per host yourself, each with its own Claude
  conversation or Codex thread (four in all), and log in if the host asks. Nothing is
  created or resumed for you.
- Approve any host trust or plugin prompt Claude shows.
- Confirm, at the moment asked, that the named conversation or thread is idle before
  the repair step. Nobody else may stand in for this confirmation.
- Quit and relaunch the Ariadne app when asked (once per host: one quit, one relaunch).
- For Codex, if a Codex background service is already running, decide whether it may
  be stopped and restarted so it carries the scratch Ariadne data location (see
  host prerequisites below). Stopping it can interrupt other Codex work.

**What gets written outside the scratch folders (your real home).** In plain terms,
approving means you allow these changes under your real home folder:
- Claude's plugin list gains an Ariadne marketplace and plugin (`ariadne-local`,
  `ariadne@ariadne-local`), plus a copy Claude caches in its own folder.
- A link `~/.agents/skills/ariadne` (Codex skill), only if you want the skill
  observed.
- Scratch histories: Ariadne's test sessions, items and history go in the approved
  `ARIADNE_HOME` folder (default `~/.ariadne`) and in the scratch projects' own
  `.ariadne` folders; the scratch Claude and Codex conversations also leave history
  in those tools' own folders.
- A restart of the Codex background service (daemon), if one is running, so it
  carries the scratch data location. This can interrupt other Codex work.

The exact list is "Real-home writes" below; each item needs your approval. Nothing
else in your home, shell startup files, provider settings, logins or MCP
configuration is changed, and no credentials are read.

**Codex weekly limit.** The Codex weekly usage limit must have reset before P7.3
starts. Do not begin P7.3 on a nearly exhausted limit.

**Separate approvals.** P7.2 and P7.3 can be approved and run separately. Each has
its own 12-turn cap, its own scratch session and its own real-home writes.

The Codex skill (ADR-0070, `$ariadne`) and the reworked rule sheet (PR #107,
merged) are part of what the live run observes; see "Observe skill and rule
sheet" below.

## Readiness and approval boundary

Before requesting live approval, finish prerequisite merges (including PR #106),
exact-head review, green application CI/native smoke and packaged release-isolation
checks on final main; obtain that main artifact's paths, version, source SHA and
validation evidence. Earlier candidate preparation is not evidence for this run.

The approval record must name absolute disposable project roots, Ariadne data
root, package/App/helper/Mod paths, the proposed install destination (owner-home
installation needs explicit approval), host configuration locations and permitted
writes: scratch project `.ariadne` stores, isolated registry/UI/socket/log data,
Ariadne-only integration resources/receipts, named Claude marketplace/plugin
registration and explicit binding operations. Preserve foreign settings/history;
no MCP configuration, permission relaxation or automatic approvals. MCP/Seezo
remain disabled; organization guidance was not checked or approved.

Use **the installed Claude Code and Codex CLI/daemon versions, recorded in the
evidence** (owner decision, ADR-0069). The version rule is a minimum: Claude Code
2.1.287 or newer and Codex CLI 0.160.0 or newer. A newer host shows an informational
"newer than tested" note and is accepted; an older host is refused. At the time of
writing the installed hosts are Claude Code 2.1.289 and codex-cli 0.160.1; record the
actual `--version` output and `codex app-server daemon version` JSON at run time.
Stop before any paid turn if the final main artifact refuses an installed host
version or shows anything other than the informational note. Approval must
explicitly allow creation of two scratch projects per host, each with its own
conversation (Claude) or thread (Codex), then identify those newly owned
conversations and threads before binding or paid prompts.
Record their real IDs from the approved creation and host UI; never infer the
owner's current conversation. IDs cannot be filled in during this preparation.
Use **two disposable projects per host, both required**: the baseline queues,
recovery and relaunch run in the first, and the second proves that a binding in
another project does not see or receive the first's inputs/results
(tasks.json acceptance requires "another project" isolation). The second project
needs its own connected Ariadne session. Any model turn it uses (for example its
bootstrap) counts inside the same 24/12 cap, so the extra-turn rows are trimmed
before the cap is raised. Two Ariadne sessions in the first project still prove
same-project isolation.

Proposed cap: **24 model turns total, at most 12 per host**: one reserved
turn for pasting the setup instruction, one domain bootstrap, five baseline queued
inputs, one delayed-result input, one missing-result input, one result-repair turn
and two quit/relaunch inputs. Connecting itself sends nothing to the model
(`/ariadne-connect` and Codex **Connect existing session** only produce the
instruction), but the owner's paste of that instruction is an ordinary model turn and
counts, once per connection. Every other model invocation, including failed or
interrupted turns and unexpected bootstrap, also counts; no retry/resend
allowance. Stop before exceeding
either cap; report unmet rows and seek a revised explicit budget. Registration,
read-only checks, UI actions and direct CLI mutations are not model turns.

## Approved setup and routes

Use the prepared immutable helper (`CLI`) and packaged executable (`APP_BIN`),
not checkout binaries. All App, owner CLI, bridge and agent helper processes must
receive the same absolute `ARIADNE_HOME` (`DATA`). Launch the dedicated provider
process from a shell with `env ARIADNE_HOME="$DATA"` so its immutable helper
children inherit it; exporting in the operator shell cannot alter an already
running host. Retain provider-managed normal authentication only after approval;
do not read/copy credentials, environment dumps or private transcripts.

After substituting approved absolute paths, these are existing supported commands:

```sh
env ARIADNE_HOME="$DATA" "$CLI" setup --agent both --project "$PROJECT" --json
env ARIADNE_HOME="$DATA" "$APP_BIN" \
  --claude-executable "$CLAUDE_BIN" --claude-plugin "$INSTALLED_PLUGIN" \
  --ariadne-helper "$CLI" --codex-executable "$CODEX_BIN" \
  --codex-home "$HOST_CODEX_HOME" --codex-endpoint "$HOST_SOCKET"
env ARIADNE_HOME="$DATA" "$CLI" doctor --project "$PROJECT" \
  --claude-bin "$CLAUDE_BIN" --codex-bin "$CODEX_BIN" --json
```

Setup resolves its package under process `HOME`; use the installation handoff's
validated process environment, not an invented `--install-root` flag or an
owner-home install. Follow its printed Claude commands exactly:
`/plugin marketplace add <installed-root>`, `/plugin install ariadne@ariadne-local`,
`/reload-plugins`, `/ariadne-connect`. `/ariadne-connect` prints a setup instruction
that the owner pastes into the same conversation, once per connection. Record
trust/reload and loaded Mod parity.
For Codex: Projects page, **Register project** (or **Discover host sessions**), open
the project, **Connect existing session**, pick the thread shown by `/status`, click
**Connect existing session** again, then paste the setup instruction Ariadne shows
into that Codex thread, once per connection. Manual binding by thread ID is the
fallback. Record actual socket, CLI/daemon versions and endpoint fingerprint.
Use saved connect receipts/routing instructions, including binding/generation;
new connect requires the running App's qualified candidate.

## Host prerequisites, resolved from source and local help

Sources: the Ariadne source tree; `claude --help`, `codex --help`,
`codex app-server daemon --help` (read-only). Do not guess other host flags, reuse
an unverified daemon or substitute direct queue/start/resume APIs. If isolated
helper inheritance cannot be demonstrated, stop.

**(a) Creating the scratch conversation and thread.** Ariadne never launches,
resumes or creates a host session (`docs/planning/INTEGRATIONS.md:95-105`;
`docs/planning/low-level/SETUP_AND_DELIVERY.md:4-7`). The owner creates both by hand.
- Claude: in the scratch project directory run interactive `claude` (optionally
  `-n <name>` for a display name, or `--session-id <uuid>` to fix the ID; both are in
  `claude --help`). The Mod reads the real session ID and cwd itself when
  `/ariadne-connect` runs (`integrations/claude/plugin/hooks/setup.js`), so no ID is
  typed by hand.
- Codex: in the scratch project directory run interactive `codex`. The owner reads
  the thread ID with `/status`, registers the project, and picks that thread in the
  **Connect existing session** dialog (discovery lists loaded threads) or enters it
  for manual binding
  (`docs/planning/INTEGRATIONS.md:95-105`). Whether an interactive `codex` TUI
  registers its thread on the shared daemon (so that discovery lists it) is not
  stated in help; the live attempt settles it, and manual binding is the fallback.

**(b) Codex daemon and `ARIADNE_HOME`.** Ariadne only connects to an existing
daemon socket at `<codex-home>/app-server-control/app-server-control.sock`
(`crates/ariadne-adapter-codex/src/history/mod.rs:60-67`), with the Codex home taken
from `--codex-home`, then `CODEX_HOME`, then `$HOME/.codex`
(`apps/desktop/src-tauri/src/composition/configuration.rs:70-90`); the socket may be
overridden with `--codex-endpoint`. Ariadne never starts or restarts the daemon.
The `ariadne` helper the agent runs is a child of the Codex shell tool, so it can
only see an `ARIADNE_HOME` that the daemon (or the Codex process) had when it
started; exporting it later cannot change a running daemon. Therefore:
**the owner must stop any running daemon and start it from a shell with
`env ARIADNE_HOME="$DATA"`** (`codex app-server daemon stop` / `start`, listed in
`codex app-server daemon --help`; stopping may interrupt other Codex work, so this
needs explicit approval), then confirm with `codex app-server daemon version`. Codex's
`shell_environment_policy` (`-c` help) may filter variables passed to the agent's
shell; no source or help proves `ARIADNE_HOME` survives it. This is **unresolved
until a live check**: before any paid turn, the owner must see the agent's helper
report the scratch `DATA` root through a read-only `ariadne doctor`-type command;
if it does not, stop (as the paragraph above requires).

**(c) Isolated install versus the owner's real logins.** Yes, Ariadne data can be
isolated while Claude/Codex keep the real login. `ARIADNE_HOME` (`DATA`) moves only
Ariadne's own data (`crates/ariadne-cli/src/bridge/command.rs:19`;
ADR-0039). Provider logins live under the providers' own homes, which are untouched
as long as the provider processes keep the real `HOME`/`CODEX_HOME`. But the
installer and `ariadne setup` resolve the package from process `HOME`
(`scripts/install/install.py:599`; `crates/ariadne-cli/src/setup/mod.rs:196`), so:
- Installing with `HOME=<isolated>` keeps the app, helper, `~/.local/bin` links and
  the Ariadne package in the isolated tree. The Codex skill link `.agents/skills/ariadne`
  is then also created under the isolated `HOME`, where the real Codex does not look,
  so the run would not exercise the skill unless the owner links it by hand in the
  real `~/.agents/skills` (a real-home write, listed below).
- Providers still register and cache Ariadne's Claude plugin in the real Claude home
  (provider-managed, via `/plugin marketplace add`).

Real-home writes a live run needs (each needs owner approval; no others are allowed):

| # | Real-home write | Needed for | Source |
| --- | --- | --- | --- |
| 1 | Claude plugin registration: marketplace `ariadne-local` pointing at the isolated installed `claude-mod` root, and plugin `ariadne@ariadne-local` enabled; Claude also stores a cached copy of the plugin under its own home | P7.2 | `SETUP_AND_DELIVERY.md:113-137`; `crates/ariadne-adapter-claude/src/probe.rs:294-312` (loaded copy must equal installed plugin byte for byte) |
| 2 | Claude session transcript/history for the scratch conversation, and Codex thread/rollout history for the scratch thread, in the providers' own homes (created by running the hosts, not by Ariadne) | P7.2, P7.3 | provider behavior; Ariadne reads only bounded known history |
| 3 | `~/.agents/skills/ariadne` symlink to the Ariadne package's `integrations/codex-skills/ariadne` (and `~/.agents`, `~/.agents/skills`, mode 0700, if absent). Only if the owner wants the skill observed; skipped if any foreign file or redirect exists | P7.3 (skill observation) | `scripts/install/install.py:202-225`; ADR-0070 |
| 4 | If the daemon is restarted for (b): Codex daemon state and socket under the real Codex home | P7.3 | `codex app-server daemon --help` |

The owner removes row 1 (`/plugin` uninstall/marketplace remove) and row 3 (remove
the link only if it is still Ariadne's) after the run. Without an installer run
under real `HOME` there is no write to `~/Applications` or `~/.local/bin`, and the
Ariadne package is not placed in `~/.local/share/ariadne`; Ariadne's scratch data
root `DATA` is written only where the approval names it (code default `~/.ariadne`;
each scratch project's sessions and items live in its own `.ariadne` folder). If instead the owner approves a real-home install,
all three locations are also written (`SETUP_AND_DELIVERY.md:284-302`) and must be
added.

**(d) Claude plugin root and connect cost.**
- Plugin root: the marketplace root is
  `<home>/.local/share/ariadne/current/integrations/claude-mod` (manifest
  `.claude-plugin/marketplace.json`, plugin at `./plugin`). The App's
  `--claude-plugin` flag must be the installed plugin directory
  `.../claude-mod/plugin`; the loaded root Claude reports must match it
  byte for byte, else Ariadne demands a plugin reload
  (`crates/ariadne-adapter-claude/src/probe.rs:294-312,440`). Record Claude's actual
  loaded root in the evidence.
- Model turn: `/ariadne-connect` is a plugin command handled by the Mod's
  `command.run` handler, which calls the helper and returns text
  (`integrations/claude/plugin/hooks/register.js:84-99`); the source contains no
  model call, so the command itself uses no model turn. The owner then pastes the
  printed setup instruction into the same conversation; that paste is a model turn
  and counts in the cap. Record observed usage for both.

## Five distinct queued inputs on each host

Bootstrap once using saved routing instructions and the shared agent rules:
ask the real agent to create topic `Live acceptance`, item `Q` waiting for owner
with option `blue` and recipient equal to this binding, open item `A`, done item
`B` with retained outcome, done item `C` with retained outcome and open item `D`.
These letters are aliases for **returned item refs**, not chosen IDs. Save the
bootstrap Apply receipt, actual topic/item refs and current question revisions.
Bootstrap is outside the five-input count.

Pause each binding, submit the five inputs in this order, verify five durable
queued records, then resume both bindings. Use App owner controls or the existing
[owner request constructor](../../../../apps/desktop/src/state/drafts/store.ts)
and [canonical DTO](../../../../crates/ariadne-core/src/dto/owner.rs) shape
through `input submit --json-stdin`:

```json
{"session":{"project_id":"P","session_id":"S"},"command":{"command":"input_submit","api_version":1,"op_id":"O","params":{"binding_id":"BINDING","target":{"topic_id":"T","item_id":"ITEM"},"kind":"KIND","text":"BODY","selected_option_id":null,"expected_question_revision":1,"supersedes_answer_id":null}}}
```

Substitute real route refs and question revisions, allocate five fresh UUIDv4
operation IDs per host, and preserve exact request bytes/IDs on uncertain CLI
response. For input 1 set `selected_option_id` to `blue`; other optional fields
stay null as shown. Each row's BODY below is literal owner text:

| # | Kind / target | BODY | Persisted pass check |
| --- | --- | --- | --- |
| 1 | `answer` / Q | `Choose blue. Publish a full reply and this input's explicit result, keep Q waiting_on_me, then wait 20 seconds using a local shell before ending this turn.` | Answer/options/question snapshot retained; Waiting becomes Sent without owner status mutation; result committed while real turn still running, not yet handled. |
| 2 | `reply` / A | `Explain why blue is suitable. Publish full replies to A and Q, and this input's explicit result. Keep their statuses unchanged.` | Two explicit replies with matching input/attempt provenance; no terminal-summary duplicate. |
| 3 | `note` / B | `Record that this note reached the already-done item B. Publish a full reply and this input's explicit result; keep B done and preserve its outcome.` | Closed-item owner message and reply retained; original outcome/status history preserved. |
| 4 | `reopen` / C | `Reopen C through an explicit agent status operation, explain the reason in a full reply, and publish this input's explicit result.` | Owner submission leaves C done; agent operation opens it with retained prior outcome/history. |
| 5 | `drop` / D | `Drop D with an explicit outcome and reason. Create topic Live follow-up. Add two open child tasks under A in A's existing topic. Publish a full reply to D and this input's explicit result naming both children.` | Owner submission leaves D open; atomic agent batch persists topic, two children, reply, drop outcome/reason and result refs. |

Observe genuine busy queuing during input 1: 2–5 stay saved and unissued until
successful host completion joins result 1. Per binding require five distinct
correlated host turns in input-sequence order, at most one in flight, five handled
inputs and one seal per attempt. Both sessions must progress independently;
foreign binding/generation replies/results must not appear. Record discovery
freshness and manual fallback honestly; loaded thread/PID alone proves no liveness.

## Extra turns: completion ordering and ordinary recovery

**Execution prerequisite for both missing-result cases:** the production caller of
`DeliveryService::expire_missing_result` (the `native_result_expiry` work) is
implemented in PR #106 (ADR-0067, own-missing-result-expiry), now merged. Confirm
it is in the final main artifact that passed required CI; if not, skip both
missing-result cases and report them as blocked. Follow the [queue contract](../../low-level/QUEUES_AND_RECOVERY.md): after actual
successful completion, allow the **five-second grace** for result/report ordering;
only after that grace may the production caller persist `result_missing` and
recovery-required state. Observe the genuine persisted transition, never invoke
the expiry method manually or manufacture a host event as live proof.

- **Completion before result (one turn/host):** submit a reply to A asking the
  agent to persist one full reply without `input_result`, return the exact
  result-only ApplyRequest referencing that receipt, then end normally. After
  the genuine completed host turn is persisted, wait for the production
  five-second expiry and verify `result_missing`/paused and no next dispatch.
  Feed the agent-authored draft through installed
  `apply --binding B --generation G --json-stdin`; retain original input/attempt,
  fresh operation ID, issued watermark and valid refs. Record operator submission
  explicitly. Verify late result joins/seals once, with no duplicate reply; exact
  operation replay returns the same receipt. Never fabricate `turn_finished`.
- **Missing-result repair (two turns/host):** repeat an intentional omitted result
  on A, without publishing a delayed result. After genuine completion and the
  production five-second expiry, inspect paused state/effects in App and owner
  `session read`/`item messages`. Use existing
  `input resolve --json-stdin` with `request_result_repair`, current session revision,
  exact input/attempt and reason. This CLI uses ordinary Core recovery with
  observation `None`/Unknown, so it requires `owner_attested_idle:true`: immediately
  before submission, obtain the actual owner's fresh, deliberate confirmation that
  the named Claude conversation or Codex thread is stopped or idle **at that moment**.
  Record its identity and confirmation time in owner-attributed evidence. An agent
  cannot infer this from completion, prior approval or general permission to test;
  without that current confirmation, stop before resolving.
  Recovery preserves owner pause; explicitly resume the binding. Require a new
  `result_repair` attempt referencing original work, no repeated mutation, one
  committed result and genuine completion. Other binding remains usable.
- **Quit/relaunch (two turns/host):** queue two additional replies to A, first
  asking for a full reply/result followed by a 20-second local wait, second asking
  for a distinct full reply/result. Quit App during the first real turn. Verify
  host survives, second input remains queued and no new dispatch occurs; installed
  CLI can still read/write. Relaunch the same isolated App: reconcile first, then
  deliver second once. If Claude evidence is inconclusive, require audited recovery
  rather than resend and mark this subcase incomplete within the cap. Also exercise
  explicit idle binding disconnect/reconnect to the same verified host, preserving
  queued data and fencing old generation; no provider shutdown/config rewrite.

## Observe skill and rule sheet

Both are observations only, with no added prompts or turns. During the Codex run,
record whether the agent follows the Ariadne rules **without extra prompting** from
the owner: does it recognise the `[ARIADNE_INPUT:<input>:<attempt>]` marker, load
the `$ariadne` skill (ADR-0070; present only if real-home write 3 was approved,
otherwise record that the skill was absent), use the exact binding/generation,
publish full replies and finish with one explicit `input_result`. Likewise record
whether both hosts follow the reworked rule sheet (PR #107, merged) from the saved
routing instructions alone. Report deviations as findings, not as reasons to add
corrective prompts.

## Evidence and stop conditions

For each host/subcase record date, macOS/architecture, source/artifact SHA/version,
commands and exit/envelope result, harmless exact input/request digest, project/
session/binding/generation, external identity/socket fingerprint, input/message/
sequence/attempt/op/host-turn IDs, before/after revision, actual result/completion
commit order, reply/child/result refs, state/pause/seal/queue counts, discovery
limitation, paid-turn count and sanitized evidence path. Use public CLI projections,
App views and Ariadne scratch snapshots for checks; only bounded known-provider
history observation belongs to the production adapter. Save no credentials,
private reasoning, full provider transcripts or unrelated owner data.

Stop on wrong identity/version/root, missing helper environment, failed packaging
readiness, ambiguous delivery, unexpected writes or exhausted budget. Planned,
mocked/scripted-provider admissions and `completeTurn` fixtures do not prove live
acceptance. Report each row as observed pass or concrete blocker; maintainer alone
records final acceptance after reviewing the evidence.
