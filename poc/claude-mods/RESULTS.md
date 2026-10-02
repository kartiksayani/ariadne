# POC results — 2 October 2026

Claude Code version: **2.1.287**, confirmed by the local binary and its generated
`.claude-plugin/types/claude-code/index.d.ts` header.

**Live communication POC passed.** The user installed and connected the mod in
an existing interactive Claude conversation, then ran the external sender.
The assistant independently read the saved evidence and copied the fixture to
[evidence/live-exercise.json](evidence/live-exercise.json).

## Completed checks

| Check | Result |
|---|---|
| Plugin and local marketplace strict validation | Passed |
| Actual Claude loads mod and executes `/ariadne-status` | Passed |
| Actual Claude executes `/ariadne-connect` and persists session binding | Passed |
| SQLite queue transaction tests | 6 passed |
| Actual mod with simulated host lifecycle | 6 passed |
| Existing user terminal loads plugin and connects | Confirmed by user; binding observed in local database |
| Three real model turns, busy queue, context and reply capture | All 7 live assertions passed |

The existing user session is `3de8b10a-8023-4ab1-8298-6cba2c9a70c4`.
Its connection is distinct from our headless command-loading check. The sender
does not launch Claude, write to its stdin, or use `--resume`.

## Observed live exchange

| Input | Item | Claude reply | Host-reported turn duration |
|---|---|---|---|
| 1: remember a random phrase | finding-1 | `ACK` | 3,598 ms |
| 2: recall it without repeating it in the prompt | finding-2 | `ariadne-23c9a075b41c` | 2,846 ms |
| 3: final acknowledgement | finding-3 | `ARIADNE_POC_DONE` | 2,527 ms |

The three turns had distinct IDs and the same bound session ID. Inputs 2 and 3
were committed while input 1 was running, approximately **2.97 seconds before**
its completion. Each subsequent input was claimed after the previous turn
completed. From first enqueue to final stored completion took **11.489 seconds**.

Every submit result identified its origin as `plugin`, name `ariadne-poc`.
Submit-result logging occurred before the recorded start on turns 2 and 3,
and after it on turn 1. This confirms the adapter must tolerate either ordering
and use matching lifecycle events to establish running/completed status.

All checks passed: three completed inputs, same session, distinct turns, FIFO
turn lifecycle, retained conversation context, final acknowledgement, and two
messages enqueued while busy. Final replies reached the local mailbox with their
original item/input IDs through `turn.complete`.

## Execution constraints

The assistant sandbox's `claude auth status` reports no accessible login.
A bounded real request returned `Not logged in · Please run /login`, exit 1.
An interactive PTY reached Claude's workspace trust dialog; this was not a
successful model interaction. Those probe processes were stopped.

The user loaded the local plugin into an existing logged-in terminal. That
conversation's project is outside the assistant's writable workspace, so the
user runs `exercise.py` from a normal shell. The assistant can inspect its
recorded results read-only. No credentials were copied or settings changed to
work around the sandbox.

## Interpretation limits

The live exercise establishes matching start/completion events and real answers;
the separate simulated-host tests establish only adapter behavior. The exercise leaves pre-connection
context, interruption, reload, two concurrent terminals, and session switching
as separate runtime acceptance cases. Queue fixture tests cover some of their
state handling but cannot stand in for Claude's actual lifecycle behavior.

Organization security guidance was not checked under the existing the review tool waiver.
