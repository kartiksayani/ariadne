# Existing-session Codex queue POC

Tests `codex queue` against a conversation already open on the shared local
Codex daemon. Uses Python's standard library and installed `rtk`/`codex`.
Protocol shapes were inspected on CLI **0.160.0**.

**Live result: all eight checks passed** against an already-open conversation on
2 October 2026. See [results and limits](RESULTS.md) and
[retained evidence](evidence/live-exercise.json).

## Run

Keep a small test conversation open in the Codex terminal. From a normal shell:

```sh
rtk proxy python3 /Users/owner/Documents/Code/ariadne/poc/codex-queue/exercise.py THREAD_UUID
```

For a nondefault daemon socket, add `--socket /absolute/path/to/socket`. Both
sender and observer use that exact socket. The default follows `CODEX_HOME` or
`~/.codex` without modifying either. The assistant sandbox cannot access the
local daemon socket; this script must run in the user's normal terminal.

The exercise uses the existing thread's model and authentication for **three
real turns**: remember a phrase, recall it, then acknowledge completion. It asks
for no tool use and makes no model-selection or permission changes.

## What it does

1. Connects using WebSocket-over-Unix (HTTP Upgrade and masked client frames),
   then initializes one protocol connection to the running daemon.
2. Reads the specified thread and verifies its identity, loaded status, empty
   native queue, and history-read capability before sending anything.
3. Runs `codex queue --remote unix://SOCKET --thread UUID --message TEXT`.
4. Polls `thread/turns/list` with full items and matches the input marker inside
   the actual user-message item. It never matches assistant prose.
5. Once the first turn is observed, queues two follow-ups. Records whether the
   first turn was still running after both sender commands returned.
6. Captures matching visible agent-message items, turn IDs, client message IDs,
   lifecycle status and times. Writes a report under `.runtime/`.

No `thread/start`, `thread/resume`, `turn/start`, `thread/queue/start`, daemon
startup, or notification-subscription mutation is sent by the observer. Only
the three explicit CLI queue commands submit messages. The test intentionally
does not infer the internals of that CLI command.

## Reading results

Checks cover three completed distinct turns, the specified thread, ordered host
turn timestamps, nonce recall, final acknowledgement, full item views, and busy
submission. FIFO timing has the precision supplied by Codex's timestamps;
the fixture retains observed times and turn IDs for inspection.

The history reader limits this POC to a conversation with at most 100 turns.
It reads earlier turns in memory for matching but saves only the marked test
turns and their replies. General terminal conversation and reasoning are not
included in the evidence. Thread-read support and actual CLI queue scheduling
are live compatibility checks, not assumptions to hide with resume/start calls.

An error or timeout writes a report and stops. It does **not** retry, dequeue
messages, interrupt turns, or stop the daemon. Already accepted messages may
still run. Inspect the target terminal before repeating an interrupted test.

Current limitation: this version tests queueing through the CLI, which chooses
its own client-message IDs. It records those IDs but does not prove that a
caller-supplied ID survives a direct `thread/queue/add` request.

Organization security guidance was not checked under the existing the review tool waiver.
