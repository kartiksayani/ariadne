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
   comes from the code: `CoreErrorCode::is_transient` is true only for `store_busy`.
   Usually a lock wait ran out before anything was read or written. A removal can
   also report it after a resumable step (`remove_session` saved its backup,
   `evict_all` moved some sessions), and sending it again resumes there. The wire
   shape and the code names are unchanged.
2. **Reads ride out Busy, within a budget.** Read-only entrypoints retry
   `store_busy` with a doubling backoff (50 ms to 400 ms), then return the plain
   busy error. A busy try has already spent the store's full 2 s lock wait
   (`LOCK_WAIT`) on each lock it touched. So a new try starts only while the backoff
   plus one full lock wait still fits in the entrypoint's budget:

   | Entrypoint | Caller | Budget |
   |---|---|---|
   | agent `read`, `item messages\|changes\|rounds`, `apply --dry-run` | agent CLI | 5 s |
   | owner queries | owner CLI | 5 s |
   | MCP queries | MCP server | 5 s |
   | `bridge connection-status` | plugin, helper timeout 5 s (8 s with quieter hook notices) | 2.5 s |
   | `owner binding connect --replay-only` (saved-connect lookup) | plugin, same helper timeout | 2.5 s |

   5 s fits a second try after one full lock wait, with about 1 s of headroom. 2.5 s fits only one: the
   lock's own 2 s wait rides out a short hold, and the call ends well inside the
   helper timeout. The plugin's other helper calls (`bridge claim`, `report`,
   `announce`, owner connect, register and disconnect) are not retried here. A plugin read can still wait on two locks in its one try (the registry lock, then the session lock), so its worst case is about 4 s plus process start; that stays inside the 5 s helper timeout, and the 8 s one once quieter hook notices land.
   Writes never retry here; their caller resends the same operation.
3. **Lock-free claim check.** `Store::peek` reads the committed session file without
   the session lock. Every session write publishes a complete, synced temp file by
   rename, so one open sees exactly one committed version, the newest at that
   instant. Claim runs its unchanged selection on that snapshot and answers
   "nothing to send" and guard refusals directly. When the snapshot may hold work
   (an input to send, or a saved receipt for this request id) it takes the lock,
   rereads and decides again; a snapshot never authorizes a write.
4. **Parse cache.** `peek` caches each parsed, validated session by the file's
   identity from one fstat: `(dev, ino)` plus size, mtime and ctime in nanoseconds.
   It keeps that file open, so the inode number cannot be reused while cached. A
   commit changes the inode. A rewrite in place from outside Ariadne (`cp
   backup.json sessions/<id>.json`) keeps the inode but changes ctime, so it is
   re-parsed too. A peek that finds the file gone drops its entry and open file at
   once; any insert first drops cached files that have no link left. At most 32
   sessions are kept, least recently used evicted first.

No file, field or saved format is added; older releases read the store unchanged.

## Consequences

- An idle poll costs one open and fstat and never contends with readers or writers.
- A write landing after a poll's open is seen by the next poll: no input is lost or
  delayed past one poll interval, and each input is still claimed exactly once.
- A read that stays busy still fails, with `retryable: true`. A try that waits on
  one busy lock never runs past the budget: 5 s, or 2.5 s for the plugin's reads.
  One agent CLI try can wait on `k` busy locks, because the catalogue read touches
  every session's lock, and so cost `k × 2 s`. The bound is then
  `budget − 2 s + k × 2 s`: 2.5 s + `k` × 2 s for the agent CLI, for example
  6.5 s with two busy sessions.
- The desktop process keeps up to 32 parsed sessions in memory.

## Spec references

- [Storage transactions](../planning/low-level/DOMAIN_AND_STORAGE.md#4-transaction-and-lock-algorithm)
- [Errors](../planning/low-level/API_AND_MCP.md)
