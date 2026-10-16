# ADR-0101: Lock-free claim check and busy-read retry

Status: accepted
Supersedes: [ADR-0065](ADR-0065-validate-captured-reads-outside-storage-locks.md) (only its "no cache ... no new retry" line, for claim polls and read-only entrypoints)
Superseded by: none

## Context

An agent's CLI reads of four topics all failed with `store_busy` and cleared about
5 s later. The error was not retryable and carried a hint written for data repair.
The busy lock was the per-session file lock (2 s wait). Every connected Claude
conversation's plugin polls `bridge claim` about once a second; each poll took that
lock for a full locked reread, even though almost every poll finds nothing to send.
The app supervisor, `bridge report` and agent writes take the same lock, and the
agent CLI's catalogue read touches every session's lock.

## Decision

1. **Plain error hints.** Local errors carry one plain hint per code. `retryable`
   comes from the code: `CoreErrorCode::is_transient` is true only for `store_busy`
   (a lock wait ran out before anything was read or written). The wire shape and
   the code names are unchanged.
2. **Reads ride out Busy.** Read-only entrypoints (agent `read`, `item
   messages|changes|rounds`, `apply --dry-run`, owner queries and saved-connect
   lookup, `bridge connection-status`, MCP queries) retry `store_busy` with a
   doubling backoff (50 ms to 400 ms) for 3 s, then return the plain busy error.
   Writes never retry here; their caller resends the same operation.
3. **Lock-free claim check.** `Store::peek` reads the committed session file without
   the session lock. Every session write publishes a complete, synced temp file by
   rename, so one open sees exactly one committed version, the newest at that
   instant. Claim runs its unchanged selection on that snapshot and answers
   "nothing to send" and guard refusals directly. When the snapshot may hold work
   (an input to send, or a saved receipt for this request id) it takes the lock,
   rereads and decides again; a snapshot never authorizes a write.
4. **Parse cache.** `peek` caches each parsed, validated session by the file's
   `(dev, ino)` and keeps that file open, so the inode number cannot be reused while
   cached. It re-parses only when a commit replaced the file. At most 32 sessions are
   kept.

No file, field or saved format is added; older releases read the store unchanged.

## Consequences

- An idle poll costs one open and fstat and never contends with readers or writers.
- A write landing after a poll's open is seen by the next poll: no input is lost or
  delayed past one poll interval, and each input is still claimed exactly once.
- A read that stays busy for longer than the window still fails, after 3 to 5 s
  (one more 2 s lock wait may run past the window), with `retryable: true`.
- The desktop process keeps up to 32 parsed sessions in memory.

## Spec references

- [Storage transactions](../planning/low-level/DOMAIN_AND_STORAGE.md#4-transaction-and-lock-algorithm)
- [Errors](../planning/low-level/API_AND_MCP.md)
