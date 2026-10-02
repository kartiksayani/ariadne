# Ariadne product contract

**First-release scope:** [Personal release decisions](PERSONAL_RELEASE.md) and
[commit quality checks](DEVELOPMENT_CHECKS.md) govern what ships now. Public
plugin installation and exotic-failure recovery are deferred; organized crates,
discovery/liveness and optimized graphs remain required.

Revision 3 · 2 October 2026. Existing-terminal workflow; implementation pending.
Ariadne is the second screen for questions, decisions, findings and tasks arising
in coding conversations. Claude Code is primary; Codex is required; additional
compatible agents use adapters. The supplied design ZIP determines appearance.
Owner clarifications determine delivery, structured results and complete history.

## Primary journey

1. Install app/CLI; register a project and set up the desired host integration.
2. Connect the already-open Claude or Codex conversation. Claude's Mod obtains
   its own session identity; Codex's manual path uses its displayed session ID.
   Discovery and liveness are v1 features; manual ID entry remains available.
3. Give the connected agent work in its terminal. Shared rules and the returned
   connection instruction let it publish topics and items through CLI/MCP.
4. Read the tree/global waiting panel. Open any item to see its complete thread,
   prior decisions, rounds and children. Select an option plus optional explanation
   or send any item a free-form message, even if it is Open or terminal.
5. Ariadne saves immediately and delivers one input per turn in FIFO order to
   that existing conversation. Five messages become five inputs, not a batch.
6. The agent explicitly publishes replies, chooses statuses and creates follow-up
   topics/children through Ariadne's domain tools. UI updates on each commit.
7. The bridge records the host turn outcome. Core advances after both successful
   completion and an explicit structured result. No extra terminal message is
   required. Tool permissions remain in the host terminal.

## Required interface

Projects and All sessions; closable session tabs; persistent Waiting/Sent panel;
Tree/Graph/Archive views; topic and status filters; sentence-based rows; question,
outcome and why; complete item conversation and rounds/forks; optional-width
message rail toggle; theme; keyboard navigation; search; tray count/quick list;
native item notifications; pin-window; terminal open/focus; setup/uninstall/demo.
Every mockup frame is mapped in [DESIGN_TRACEABILITY](DESIGN_TRACEABILITY.md).

Owner controls Bring it up / Reply / Add note / Follow up / Back to Open / Drop
queue explicit intents. Only the agent changes item status. Later/Unpark is a
local preference, never a hidden domain status or agent instruction. Answers do
not automatically set In progress; Sent shows delivery independently.
Archive is available for all-terminal topics without unresolved inputs. Close
session requires all-terminal items, no unresolved inputs and paused dispatch;
it never closes a terminal. Continue previews and copies a topic into a selected
bound session with provenance, then queues the approved summary. Shared mutable
cross-session topics are not used; the UI explicitly calls this a copy.

## Identity, history and states

Ariadne session ID, binding ID, host session ID, item reference and turn ID are
separate. IDs are secondary/copyable; headings use plain sentences. One active
binding per Ariadne session; many sessions in the same project are supported.
Changing agents makes a new binding and preserves past authorship; no implicit
context transfer. Terminal-originated updates require explicit binding too.

Types: question, decision, finding, task, explanation. Statuses: open,
waiting_on_me, in_progress, decided, done, dropped, replaced. Explanation+done
may display 'Explained'. Closed parents can have active descendants. Replacements
have a target and their own history; never reuse an item's meaning silently.

Store the complete Ariadne item conversation, all rounds, option/question
snapshots, explicit replies and branches. Keep unrelated terminal conversation
and private reasoning out of the store. Captured visible terminal output is
bounded diagnostics; it cannot create an item reply or status transition.

Waiting is global across registered accessible sessions, independent of tabs or
filters. An unanswered current waiting episode appears in Waiting; an outstanding
owner answer for that episode appears in Sent until its handling is resolved.
Missing/corrupt project data marks counts incomplete, never zero. Questions from
an unavailable host may still be answered and queued for that binding.

## Operational boundaries

Window close hides to tray. Quit stops new dispatch, not external agent work.
Queued inputs survive; accepted work may finish and write results while app is
off. Reopen reconciles before sending. Pause only affects later delivery; it does
not retract a message already queued in Claude/Codex. Failed/uncertain/missing
results have explicit recovery UI and no blind automatic resend.

Discovery/liveness is included in v1 through Mod announcements/heartbeats and
read-only known-host metadata. Traditional hooks are supplementary.
Running, Connected idle, Last seen and Unknown are distinct observations. Never
infer active work from PID existence or an open MCP connection alone. Presence
observation failure cannot prevent manual connection and queue inspection.

No accounts/cloud/telemetry, model API client, terminal emulator, private rollout
parsing, automatic remote setup, provider downloads, automatic worktrees, PR
execution UI or managed-host launching in release1. Adapter APIs permit later
capabilities without promising unsupported controls today.

## Quality and acceptance

Target on a documented reference Mac: normal external writes visible within1s,
local save p95≤250ms, first usable view≤2s, local search p95≤150ms with2,000 items /
5,000 messages. These are measurements to pass, not current performance claims.
Both themes, keyboard/focus, errors/recovery and offline assets must pass. Use
the canonical SDK-cache example from DESIGN_PROMPT and handoff scenario fixtures.
The [verification ledger](low-level/VERIFICATION.md) specifies executable gates.
