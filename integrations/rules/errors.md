# Errors

Exit 2 (`invalid_argument`, `invalid_ref`): the message names the offending field;
fix it and send a corrected request (a new `op_id`, or none). Exit 3 conflicts
(`revision_conflict`, `invalid_transition`, `binding_mismatch`, `operation_reused`):
read the items again, rebuild with current revisions and a new `op_id`, except
where a code below says otherwise. `ariadne apply --dry-run` checks a request
without committing it. A failing command is never a reason to edit `.ariadne/`
files.

| Code | Exit | Do |
|---|---|---|
| `stale_generation` | 3 | The generation is no longer current. If this conversation holds a newer connection note, setup instruction or `/ariadne-connect` output with a different generation, rebuild the request with it and a new `op_id`. Otherwise stop writing and ask the owner for the current setup instruction. Never guess one. |
| `invalid_transition` with `details.reason: "topic_archived"` | 3 | The owner parked this topic. Do not retry. Ask the owner, in a live topic, to restore it. Reads still work (`--view items --topic <id> --archived`). |
| `attempt_sealed` | 3 | This input/attempt is closed. Do not retry or invent another attempt; tell the owner. |
| `result_already_committed` | 3 | The result is already saved. Send nothing more for this attempt; only an exact replay is valid. |
| `commit_uncertain`, `store_busy`, `io_error`, or no reply at all (timeout, killed call) | 4 | The save may have happened. Replay the SAME bytes with the SAME `op_id`, at most 3 times, never a new `op_id`. With no receipt after that, stop and tell the owner. |
| any other exit 4 (e.g. `capacity_exceeded`, `host_unreachable`) | 4 | Stop and tell the owner; do not retry in a loop. |
| `unsupported`, `future_schema` | 5 | Stop and tell the owner. |

Replaying needs the same `op_id`: if you omitted it, the receipt printed the one
the CLI generated; with no receipt, set your own `op_id` before the first try next
time. Never resend the owner's message, re-run completed work after a retry,
scrape a transcript, or infer non-delivery from missing output, presence, a
timeout or a failed receipt.
