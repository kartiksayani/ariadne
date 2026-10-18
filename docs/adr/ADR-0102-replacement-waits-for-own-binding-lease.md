# ADR-0102: A replacement activation waits for this desktop's own binding lease

Status: accepted
Supersedes: none
Superseded by: none

## Context

A binding lease is an exclusive, nonblocking `flock` on `run/leases/<binding>.lock`.
Every clone keeps it, including a started blocking call that outlives its caller:
a supervisor's core call cancelled by stop, or a control claim past its socket
timeout. On wake the old activation stops, but such a call can still hold a clone.
A bound announcement right after wake starts a replacement activation, whose lease
try failed with `permission_denied` ("Another desktop or supervisor holds this
nonblocking lease"). The plugin shows that as advice the owner must act on, and the
owner has nothing to do. It was seen on CI and under load in the composition wake
test.

## Decision

1. **Who holds it.** Each `DesktopOwner` lists the bindings whose lease it holds.
   Under the list's lock a binding is listed exactly while this owner holds the
   lock on its lease file. A locked file whose binding is not listed is held by
   another desktop or supervisor.
2. **Another holder stays `permission_denied`, at once.** Cross-process exclusivity
   is unchanged: still one `LOCK_EX|LOCK_NB` per open file, never a blocking lock.
3. **This desktop's own holder is `store_busy`.** The replacement activation's
   lease (`binding_lease_shared_before`) waits for the release, for at most
   `LEASE_RELEASE_WAIT` (2 s, the store's lock wait) and never past the request's
   deadline, then returns the retryable `store_busy`. Nothing was started; the
   plugin's next announcement retries. Plain `binding_lease` calls never wait.
4. Two activations never hold the lease at once: the replacement takes it only
   after the last clone is dropped and the OS lock is released.

## Consequences

- A session that reconnects right after the Mac wakes connects once the old call
  returns, or gets a background retry instead of a permission error.
- A replacement can spend up to 2 s of its control deadline waiting.
- No file, field or saved format changes.

## Spec references

- [Control and leases](../planning/low-level/PROCESS_AND_PROTOCOLS.md)
- [Errors](../planning/low-level/API_AND_MCP.md)
