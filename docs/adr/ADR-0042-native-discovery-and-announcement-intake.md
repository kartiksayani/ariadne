# ADR-0042: Native candidate discovery on the private control endpoint

Status: accepted
Supersedes: none
Superseded by: none

## Context

PROCESS section 5 includes discovery before an owner has chosen a binding.
Lease-required control routes cannot represent that unbound read-only identity.
Loaded daemon membership and Mod heartbeats also do not prove Idle or dispatch
authority. P3.4 provides native Claude resource qualification; P3.7 supplies its
actual UID-checked SDK evidence without another transport or lifecycle broker.

## Decision

Reuse the private Unix endpoint, peer UID, owner/mode/path checks, UUID correlation,
one 1 MiB length-prefixed JSON exchange and absolute 5-second control bound.
`session_announcement` has the exact strict params in PROCESS section 5 and an
identity-only acknowledgement. The installed `bridge announce` helper forwards
those params with an explicit request ID. There is no client timestamp, parity
boolean, route, lease, Core call or domain write. Mod startup and 30-second timers
use actual SDK plugin `{name,root}`, original session/cwd/version and the imported
immutable descriptor. One pending helper coalesces timer ticks; stop prevents new
heartbeats. Discovery never submits a prompt or synthesizes lifecycle facts.

Keep 256 live candidates across provider/endpoint/session identities. Refresh in
place, expire native receipt age at 90 seconds before admission, and reject
overflow with an actionable existing capacity error. Canonicalize project and
loaded root natively. An optional bound scope must match a trusted native
resolver's exact binding ID, SessionRef, project, adapter, external session and
current generation. The resolver returns owned non-deserializable authority;
locks end before path/resource IO, and association is checked again afterward.
Unbound admission needs no resolver or binding lease. Existing claim gates and
replay-first routing remain unchanged when discovery is absent or enabled.

After the actual P3.4 surface is merged, its narrow native qualifier reuses
existing executable/version/resource comparisons and returns opaque verified Mod
evidence. A received_at constructor preserves the original native Instant and
UTC time; qualification cannot create a new heartbeat. The caller's shorter
deadline wins, with 5 seconds as the maximum. Runtime offloads probes and rechecks
the unchanged candidate/resource identity plus authoritative association before
filling its slot. Failed, expired, replaced or rotated candidates remain Unknown.
Include discovery.js in the exact installed/loaded resource inventory. P6's
immutable version directories refuse same-version replacement with different
bytes; this is version/cache compatibility, not memory-byte attestation.

Codex discovery reuses the verified initialized unbound reader. Only native
`set_connection_ui_open(true)` starts scans, every 30 seconds. Use absolute
10-second page budgets, maximum 50 pages, cursor progress/identity checks and the
shared 256 candidate bound. Publish a complete scan atomically; retain the last
complete snapshot as stale/error after failure or overflow. Closing UI, wake or
stop cancels later pages/publication, while owned started IO retains its original
bound. No host is launched, resumed or signalled. Wake marks evidence Unknown
until refreshed, preserving original observation time.

## Consequences

Real private-socket and executable tests prove unbound admission without Core or
claim routes, exact acknowledgement correlation, current association checks and
native UI activation/stop. Candidate tests cover capacity/expiry, canonical paths,
rotation and incomplete-scan retention; provider fixture transport tests prove
read-only initialized reuse and identity/deadline checks. SDK tests use actual
source with helper barriers, no live model calls.

Lifecycle facts retain the existing Mod bridge report-to-Core path. Candidate
presence cannot override persisted terminal/conflict state or establish execution.
Actual desktop activation, bounded snapshot serialization, installed resource
composition and registered connection join remain explicit consuming acceptance
work; this implementation does not claim those joins or infer compatibility from
installed files alone. No shared Core/adapter DTO or second event cache is added.
