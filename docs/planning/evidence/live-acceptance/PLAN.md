# Live acceptance plan — preparation only

Prepared against reviewed candidate `954ab4b9291fb79dbc2aabe1e31736c1bb596b83`.
Product dependencies still await CI/merges. This is a manual runbook, with no
execution evidence or task-completion claim. Follow the pinned
[setup](../../low-level/SETUP_AND_DELIVERY.md),
[API](../../low-level/API_AND_MCP.md) and
[verification](../../low-level/VERIFICATION.md) contracts (V07–V13, V17–V20).
There is no runnable `npm run test:live` or `tests/live` suite in this candidate.

## Readiness and approval boundary

Before requesting live approval, finish prerequisite merges, exact-head review,
green application CI/native smoke and packaged release-isolation checks; obtain
the separate public isolated-install preparation's artifact paths, version,
source SHA and validation evidence. Candidate preparation succeeded in a private
home: public install 228.833s, installed doctor 0.049s (warning; resource parity
ok), 18 inventory records with zero mismatches, uninstall 0.608s; source stayed
clean. [Local evidence](/private/tmp/ariadne-public-install.m19JDw/evidence/README.md)
is candidate evidence only. **No installation remains**; final artifact availability
and equivalence to merged main are still prerequisites. Do not repeat preparation.

The approval record must name absolute disposable project roots, Ariadne data
root, package/App/helper/Mod paths, the proposed install destination (owner-home
installation needs explicit approval), host configuration locations and permitted
writes: scratch project `.ariadne` stores, isolated registry/UI/socket/log data,
Ariadne-only integration resources/receipts, named Claude marketplace/plugin
registration and explicit binding operations. Preserve foreign settings/history;
no MCP configuration, permission relaxation or automatic approvals. MCP/Seezo
remain disabled; organization guidance was not checked or approved.

Require **Claude Code 2.1.287 and Codex CLI plus daemon 0.160.0**. Approval must
explicitly allow creation of two dedicated scratch hosts, then identify the
newly owned Claude conversation and Codex thread before binding or paid prompts.
Record their real IDs from the approved creation and host UI; never infer the
owner's current conversation. IDs cannot be filled in during this preparation.
Use two Ariadne sessions in one approved project for same-project isolation;
reserve any second disposable project for approved unavailable-path checks.

Proposed cap: **24 model turns total, at most 12 per host**: one reserved
model-invoked connect/bootstrap turn, one domain bootstrap, five baseline queued
inputs, one delayed-result input, one missing-result input, one result-repair turn
and two quit/relaunch inputs. Every model invocation, including `/ariadne-connect`,
failed/interrupted turns and unexpected bootstrap, counts. If connect is non-model,
its reservation remains unused; no retry/resend allowance. Stop before exceeding
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
`/reload-plugins`, `/ariadne-connect`. Record trust/reload and loaded Mod parity.
For Codex, use `/status`, then explicitly select that thread in App discovery or
manual binding. Record actual socket, CLI/daemon versions and endpoint fingerprint.
Use saved connect receipts/routing instructions, including binding/generation;
new connect requires the running App's qualified candidate.

**Operational facts to resolve before approval:** exact pinned-host interactive
creation procedure; Codex daemon startup/environment inheritance when a daemon
already exists; isolated installation versus normal host-authentication environment;
Claude's exact loaded plugin root and whether connect invokes a model turn.
Do not guess host flags, reuse an unverified daemon or substitute direct queue,
start/resume APIs. If isolated helper inheritance cannot be demonstrated, stop.

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

**Execution prerequisite for both missing-result cases:** implement, independently
review and verify the production native/runtime caller of
`DeliveryService::expire_missing_result` (the `native_result_expiry` work), then
qualify its merged artifact through required CI. Candidate `954ab4b` has the Core
method but no production caller; it cannot prove automatic missing-result expiry.
Follow the [queue contract](../../low-level/QUEUES_AND_RECOVERY.md): after actual
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
