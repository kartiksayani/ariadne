# Errors

Exit 2 (`invalid_argument`, `invalid_ref`): the message names the offending field;
fix it and send a corrected request (without `op_id`, or with a new one). Exit 3
conflicts (`revision_conflict`, `invalid_transition`, `binding_mismatch`,
`operation_reused`): read the items again, rebuild with current revisions and no
`op_id`, except where a code below says otherwise. `ariadne apply --dry-run`
checks a request without committing it. A failing command is never a reason to edit `.ariadne/`
files.

| Code | Exit | Do |
|---|---|---|
| `stale_generation` | 3 | The generation is no longer current. If this conversation holds a newer connection note, setup instruction or `/ariadne-connect` output with a different generation, rebuild the request with it and no `op_id`. Otherwise stop writing and ask the owner for the current setup instruction. Never guess one. |
| `invalid_transition` with `details.reason: "topic_archived"` | 3 | The owner parked this topic. Do not retry. Ask the owner, in a live topic, to restore it. Reads still work (`--view items --topic <id> --archived`). |
| `attempt_sealed` | 3 | This input/attempt is closed. Do not retry or invent another attempt; tell the owner. |
| `result_already_committed` | 3 | The result is already saved. Send nothing more for this attempt; only an exact replay is valid. |
| `commit_uncertain`, `store_busy`, `io_error` | 4 | The save may have happened. Resend the identical request, at most 3 times, changing nothing: the CLI derives the same `op_id` from it, so a saved request replays (`"replayed":true`) and files nothing twice. If you set your own `op_id`, resend the same bytes. Still no receipt: stop and tell the owner. (`store_busy` saved nothing: resend.) |
| no reply at all (timeout, killed call) | 4 | A retry of the identical request is safe: it files once, and a replay shows `"replayed":true`. Change nothing in it; a changed request is new work. |
| any other exit 4 (e.g. `capacity_exceeded`, `host_unreachable`) | 4 | Stop and tell the owner; do not retry in a loop. |
| `unsupported`, `future_schema` | 5 | Stop and tell the owner. |

A replay of the same `op_id` and request writes nothing twice. Never resend the
owner's message, re-run completed work after a retry, scrape a transcript, or infer
non-delivery from missing output, presence, a timeout or a failed receipt.
