# ADR-0029: Private desktop control and retained leases

Status: accepted
Supersedes: none
Superseded by: none

## Context

P3.1 must give the installed helper a real local claim route without creating a
second business state machine. CoreService is synchronous and replay-first;
socket callers can disappear while a blocking transaction still commits. The
published service has trusted native contexts but no production registration
composition or durable queue reporter yet.

## Decision

The maintainer approved a runtime-owned codec reused by CLI: one Unix connection,
one u32 big-endian length-prefixed UTF-8 JSON request and response, a 1 MiB limit
before frame allocation, and one absolute 5-second IO deadline. Version 1 uses
typed ping/claim/connection_status params and canonical CoreError results, as
specified in PROCESS section 1. Claim envelope ID equals canonical request_id;
response ID/version/method/scope and prepared evidence are validated. Ping proves
control reachability, never provider readiness. Status queries the canonical
registered session binding and supplies no invented presence.

CoreError::validate guards the IPC producer, peer error consumer, direct report
and CLI envelope output. Valid errors are preserved exactly. Malformed errors
become a bounded nonretryable protocol_conflict without raw diagnostic/panic
data; guidance retains the original request/event/operation IDs and warns that
effects may already exist. No malformed uncertainty authorizes resend or a new ID.

Native owned directories are 0700; owned socket and stable single-link regular
lock files are 0600. Open private directory/lock targets without following
symlinks, verify peer UID in both directions, check the native Unix path byte
limit, and remove a validated stale socket only while holding runtime.lock.
Per-binding nonblocking flock leases are separate from storage locks. Setup is
blocking native work; async frame IO and offloaded synchronous core calls do not
hold a storage lock while waiting on sockets.

A started core call retains the actual physical binding lease and its admission
slot after socket timeout/drop or listener shutdown. The 16 admitted connection
slots bound pending IO and active blocking calls. Shutdown stops new accepts and
aborts pending socket IO; it cannot cancel an already-started core transaction or
claim that a timed-out request was unsent. Closed listeners leave validated stale
endpoints for the next owner; there is no blocking filesystem cleanup in async
Drop. A retry uses the original claim ID, with no provider resend or local receipt
cache.

Runtime supplies the current registered lease generation in its trusted context
and forwards the original canonical ClaimRequest unchanged, including an older
generation. Core replays an exact durable receipt before rejecting fresh stale
work. Ping/status remain current-generation checks. Direct report similarly
preserves event bytes and leaves durable replay/generation guards to core. An
ordinary registered report context has no VerifiedHistoricalScope; callers cannot
manufacture historical trust from old event IDs. Actual verified reconciliation
owns fresh historical facts.

The direct-report function accepts an injected canonical service and trusted
registered route and needs neither desktop nor lease. Until production core
composition is available, the executable report command returns nonretryable
unsupported with a concrete reason. It must not manufacture persistence or use a
scripted service in production. Test-only canonical scripted consumers exercise
shared claim/report fixtures through native sockets and real subprocesses.

## Consequences

P3.1 can publish private IPC, lease behavior and the installed claim route now.
Its original durable acceptance remains joined with P2.2, P1.4 registered native
composition and P3.2 runtime wiring. No new CoreService method, DTO signature,
TCP transport, provider lifecycle or alternate persistence engine is introduced.

MCP/Seezo remain disabled under the owner’s current-session waiver. Organization
security guidance was not checked; no organizational approval is claimed.

## Spec references

- [PROCESS: ownership and app control](../planning/low-level/PROCESS_AND_PROTOCOLS.md#1-ownership-leases-and-app-control)
- [SETUP: local registration](../planning/low-level/SETUP_AND_DELIVERY.md#1-installed-files-project-data-and-bindings)
- [MODULE_CONTRACTS: service](../planning/MODULE_CONTRACTS.md)
- [ADR-0023: canonical service and trusted contexts](ADR-0023-publish-core-service-contract.md)
