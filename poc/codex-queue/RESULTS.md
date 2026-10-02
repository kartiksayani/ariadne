# Codex existing-session queue: live result

**Passed on 2 October 2026, codex-cli 0.160.0.** The daemon initialization
response also identified `codex-tui/0.160.0`. The owner ran the harness in a
normal shell while the target terminal conversation remained open.

[Retained evidence](evidence/live-exercise.json) contains only the marked test
inputs, their visible replies, lifecycle observations and connection metadata.
The local account directory was removed from the retained copy. The original is
`.runtime/exercise-5e3f90f9-039d-48e0-a31b-563fbdafca31.json`.

## Observed behavior

Existing thread: `01a0fba3-6ed9-76c2-a84e-a462929cef91`; initial status: idle.

| Input | Turn | Final reply | Duration |
|---|---|---|---|
| `b38e6400-540d-42f5-8a35-1cd30ab86974` | `01a0fc15-b03c-7283-8134-f53ebc025864` | `ACK` | 10,918 ms |
| `4fb83fca-0dcc-44ca-b686-c8adc68c330e` | `01a0fc15-daeb-7961-b89b-9773c43eb633` | `ariadne-2eae452a57ed` | 4,485 ms |
| `163ea1c2-a331-4072-af1d-9e599c272dcd` | `01a0fc15-ec75-7211-8fa6-313294ec730e` | `ARIADNE_CODEX_POC_DONE` | 9,381 ms |

All eight checks passed: three completed turns, the same addressed thread read
without resume, distinct turn IDs, ordered turn timestamps, context retained,
final acknowledgement, both follow-ups accepted while the first was still
running, and full item views. Total exercise time was **25.920 seconds**.
The trace was independently checked against its messages, timestamps and replies.

The idle conversation began work after the first queue command. Both follow-ups
were accepted about nine seconds before the first turn completed; an additional
history read still observed the first turn in progress. Each follow-up became a
separate turn automatically. The second message recalled a phrase supplied only
in the first. FIFO timestamps have the server's one-second precision.

## Exact communication path

```text
Harness → codex queue --remote unix://SOCKET --thread THREAD --message TEXT
        → existing Codex conversation processes one turn per message

Harness → WebSocket over the same Unix socket → initialize / initialized
        → thread/read + thread/queue/list + thread/turns/list (full items)
        ← original user-message marker + turn ID + final agent-message text
        → save reply against the marker's original Ariadne item
```

The observer never sent start, resume, queue/start, or approval responses.
The sender used the official queue CLI; its internal RPC choices were not
instrumented. The marker was found in the turn's user input, so Codex did not
have to repeat an item ID in its answer. The saved report associates each answer
with its fixture item; production item storage remains to be implemented.

## Scope and remaining work

This proves the communication primitive for an open conversation on the tested
shared daemon. It does not prove direct `thread/queue/add` scheduling or
caller-supplied client-ID propagation. The CLI generated its own client IDs.

Not yet exercised: terminal closure, daemon restart, interrupted delivery,
approvals, failures, mixed terminal/app inputs, retries and deduplication,
other versions/endpoints, or production tree mutations and persistence.
Keep Ariadne's durable outbox and uncertain-delivery reconciliation in the plan.

Ten offline tests also passed, including WebSocket framing and mocked lifecycle
handling. Those are separate from this live proof. The earlier initialize timeout
was a harness framing bug and queued no messages; the corrected live run passed.

Organization security guidance was not checked under the existing the review tool waiver.
