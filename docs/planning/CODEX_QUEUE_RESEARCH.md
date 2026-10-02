> Historical research/evidence, not the current implementation contract. Use
> [LOW_LEVEL_DESIGN](LOW_LEVEL_DESIGN.md) and [BUILD_HANDOFF](BUILD_HANDOFF.md).

# Codex queue: existing-session integration research

Researched 2 October 2026 against installed **codex-cli 0.160.0**.

**POC transport correction:** the first user-run observer timed out during
initialization and sent zero queue messages. It incorrectly treated the raw
control-socket proxy as JSONL. The Unix transport requires a WebSocket HTTP
Upgrade and WebSocket frames; only the standalone stdio transport is JSONL.
The [POC harness](../../poc/codex-queue/README.md) now uses WebSocket-over-Unix
directly. [Official transport specification](https://learn.chatgpt.com/docs/app-server#protocol).

**Live proof passed:** the owner ran the corrected harness against an already-open
conversation. All eight checks passed: idle start, three separate ordered turns,
busy submissions, retained context and full reply retrieval on the same thread.
See [results and scope](../../poc/codex-queue/RESULTS.md).

**Recommendation:** use Codex's existing-session queue as the inbound adapter,
with an Ariadne adapter connected to the same app-server daemon for receipts and
reply reads. No Claude-style Mod is required for this route. CLI-based delivery
and read-only reply retrieval are live-proven on 0.160.0; production recovery and
direct queue API equivalence remain unverified.

## What is established

| Surface | Observed evidence | What it establishes |
|---|---|---|
| `codex queue --thread <THREAD> --message <TEXT>` | Installed CLI help | Targets an existing session by UUID or exact name; also accepts a remote endpoint |
| `codex app-server proxy --sock <PATH>` | Installed CLI help | Proxies stdio to a running app-server control socket |
| `thread/queue/add` | Installed experimental schema | Requires thread ID, client user-message ID and input; returns a queued submission |
| `thread/queue/start` | Installed experimental schema | Accepts thread ID and optional queued-submission ID; returns a Turn |
| Queue list/update/delete/reorder | Installed experimental schema | Queue entries are distinct objects that can be inspected and managed |
| `thread/queue/changed` | Installed experimental schema | Signals only the thread ID; re-read the queue for its actual contents |
| `turn/started`, `turn/completed` | Installed schema and official docs | Report thread/turn identity and lifecycle separately from queue acceptance |
| `userMessage` item | Installed schema | Has `id`, `content`, and optional nullable `clientId` |
| `agentMessage` item | Installed schema | Has `id`, `text`, optional phase and delivery metadata |

The installed CLI is a standalone executable with no adjacent implementation
source. Generated schemas establish shapes, not scheduling behavior. The CLI
help offers no `--json` output flag for `queue`. The live run printed
`Queued message <id> for thread <id>.`; that observed text is not a stable typed
contract. The POC correlates replies through the original user-message marker.

## Candidate request and receipt

After initialization with `capabilities.experimentalApi: true`, the installed
schema permits this request (illustrative IDs):

```json
{
  "id": 2,
  "method": "thread/queue/add",
  "params": {
    "threadId": "codex-thread-uuid",
    "clientUserMessageId": "ariadne-delivery-attempt-uuid",
    "input": [{
      "type": "text",
      "text": "[ARIADNE_INPUT:input-uuid:attempt-uuid]\nItem 4, topic PR review\nOwner: Explain this finding."
    }]
  }
}
```

The response shape is:

```json
{
  "id": 2,
  "result": {
    "queuedSubmission": {
      "id": "codex-queue-entry-id",
      "clientUserMessageId": "ariadne-delivery-attempt-uuid",
      "input": [{"type":"text","text":"..."}]
    }
  }
}
```

This is a queue receipt. It does not contain a turn ID or an answer. Neither
the request ID nor `clientUserMessageId` has a verified idempotency guarantee.

## Sending and receiving without taking over the terminal

```text
Owner writes on an Ariadne item
  → core saves message + item association + durable input
  → Codex adapter addresses the bound existing thread
  → queue command [live-proven; native API equivalence still unverified]
  → Codex runs a separate turn when ready
  → adapter identifies the turn's original user input
  → adapter reads its completed agent messages and terminal status
  → core appends the reply to the original item's conversation
  → UI refreshes the stored item thread
```

For the product, prefer the typed queue API over shell-output parsing if live
tests establish equivalent behavior. Connect to the **same daemon** as the
terminal. Launching an unrelated `codex app-server` process does not establish
access to the terminal's loaded conversation.

### Return path without assuming event subscription

Official docs provide `thread/read` and paginated `thread/turns/list` for reading
history without resuming. This polling return path passed the live POC, while
second-client event subscription remains unverified. Request full items rather
than the default summary, retain cursors, and query only the bound thread.
This does not require importing its unrelated history into Ariadne.
[Official App Server documentation](https://learn.chatgpt.com/docs/app-server)

Correlation design (marker-to-turn matching and full reply reads live-proven):

1. Store Ariadne input/attempt ID, target item, Codex thread ID and queue receipt.
2. Look for the delivery's unique marker in a turn's **userMessage input**, not in
   model output. Validate it against the saved payload. Prefer `clientId` if a
   live test proves it preserves our `clientUserMessageId`; the schema alone
   does not establish that relationship.
3. Bind the matched Codex turn ID to that input. An unrelated terminal turn must
   never consume Ariadne's outstanding input just because it ran next.
4. Collect that turn's agent-message items by their stable item IDs; treat a
   missing/summary items collection as incomplete and request full data.
5. On terminal turn status, persist the outcome and replies once. Completion
   status and stored item status remain independent.

`agentMessage.phase` may distinguish `commentary` from `final_answer`. The local
schema explicitly says providers do not emit it consistently. Preserve visible
text with its actual phase; for unknown phase retain it as unclassified visible
output, not as an invented authoritative final answer. Never import reasoning
items. Whether to show progress messages collapsed is a UI decision; final
replies and owner messages form the persistent item conversation.

Event subscriptions could later replace routine polling. The documented
`thread/read` does not subscribe or load a thread. We found no dedicated
subscribe/attach method in the installed request schema. Do not call
`thread/resume` on a user's active conversation merely to obtain notifications
until second-client behavior and effects on session settings are proven.

## Remaining scheduling and recovery tests

1. **Idle:** the CLI began processing in the live test. Does raw
   `thread/queue/add` do the same, or does a terminal client drive
   `thread/queue/start`? The separate start API does not by itself answer this.
2. **Busy:** three CLI submissions ran separately and in order. Do interruption,
   failure or approval waits stop progression? What happens when terminal input
   arrives between Ariadne messages?
3. **Terminal detached/closed:** does the daemon drain the queue on its own?
   Is behavior different for a stored but unloaded thread?
4. **Correlation:** does `clientUserMessageId` appear as `userMessage.clientId`,
   as a caller-supplied ID? Read APIs already exposed completed turns and full
   answers promptly in the live test.
5. **Two clients:** read-only polling worked without settings mutations or
   approval responses. Event subscription remains untested. Does `thread/resume` attach
   harmlessly to a loaded thread, or have additional effects?
6. **Restart and retry:** are queued entries durable across daemon restart?
   Does repeating a client message ID deduplicate, reject, or duplicate work?
7. **Compatibility:** which daemon version is actually running? The installed
   CLI version alone is not proof. Sessions using `--no-daemon` or a different
   app-server endpoint need explicit compatibility checks.

Until those are answered, Ariadne keeps its own durable FIFO and sends at most
one outstanding input to Codex. Never automatically call queue/start while
another controller may be draining it, or blindly resend after a lost receipt.
An unknown outcome is paused for reconciliation.

## Probe outcome in this environment

This read-only command failed:

```sh
rtk proxy codex app-server daemon version
```

It could not connect to the local `app-server-control.sock`: **Operation not
permitted**. This is a sandbox-access limitation; it does not establish that the
daemon is absent or that queueing is broken. No message was queued, no thread
was resumed, and no daemon was started or reconfigured during this research.

The owner subsequently ran the three-message exercise in a normal terminal;
[all eight checks passed](../../poc/codex-queue/RESULTS.md). It proved idle start,
busy FIFO processing, context retention and read-only answer retrieval. It
recorded CLI-generated client IDs; caller-supplied client-ID propagation remains
untested. The sandbox limitation applies to this assistant process, not to the
user's terminal or the product's ordinary local execution environment.

## Evidence and verification commands

- `rtk proxy codex --version` → `codex-cli 0.160.0`.
- `rtk proxy codex queue --help` → existing-session queue command and arguments.
- `rtk proxy codex app-server proxy --help` → running control-socket proxy.
- `rtk proxy codex app-server generate-json-schema --experimental --out /private/tmp/ariadne-codex-0160-schema` → version-local protocol schemas, no inference.
- [Retained schema extracts](evidence/codex-queue-0.160.0.json).
- [Official App Server documentation](https://learn.chatgpt.com/docs/app-server): history reads, item phases and lifecycle events. The fetched page did not document the new queue methods.

Organization security guidance was not checked under the existing the review tool waiver.
