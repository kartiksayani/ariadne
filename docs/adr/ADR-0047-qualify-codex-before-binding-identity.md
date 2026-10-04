# ADR-0047: Qualify Codex before allocating binding identity

Status: accepted
Supersedes: none
Superseded by: none

## Context

Binding setup must verify the explicitly selected existing host outside all
Registry/Store locks before allocating durable IDs. Codex's initialized reader
already verifies a selected thread during final binding, but that operation
requires final IDs. Placeholder IDs would confuse verification with persisted
authority, and a global selected-root cache could qualify another thread.

## Decision

The maintainer approved a provider-owned `QualifiedCodexThread` that consumes
one initialized `CodexDaemonReader`, verifies one exact selected thread against
the explicit registered canonical project root, and retains that reader and root.
Its borrowed `CodexHostFacts` contain provider identity, version, fingerprint,
capabilities, compatibility and availability; neither type deserializes trusted
authority or allocates Ariadne IDs. Dropping the qualification closes only the
observer transport. Initialization and qualification share the caller's absolute
admission deadline; qualification is additionally capped at ten seconds.
Native callers use public `open_before(options, endpoint, deadline)` followed by
`qualify_selected_thread(..., deadline)`. The existing `open` convenience retains
its ten-second default. A fixture holds initialization or the following thread
response to prove that a shorter combined budget is not reset between stages.

Pre-ID qualification and final binding reuse the same executable/socket identity,
thread/read, bounded queue/list and full turn-items checks. After Core persists
final IDs, consuming `bind` rejects another thread/endpoint and repeats those
checks, including canonical root equality. The expected root belongs only to
that owned qualification. General CodexOptions and raw low-level bind retain
their existing behavior; raw bind alone does not establish project-qualified
bootstrap. Blocking provider and filesystem checks run off the executor and
outside Registry/Store locks.

Queue capability construction is shared with the full adapter, preserving its
installed pinned queue and runtime claim/lease conditions. Qualification facts
describe the full provider capability; the standalone history client's existing
read-only ConnectResult remains unchanged. No queue operation, host launch,
resume, Adapter trait or canonical DTO is added.

## Consequences

Native composition can obtain grounded provider facts before locked final-ID
allocation. It must preserve exact owner-operation replay before verification,
copy only verified facts into Core's native context, and establish the final
runtime adapter connection before lease/dispatch. The complete consuming wiring
remains a separate join; these fixture tests do not establish live-session or
installed CLI acceptance.

The existing closed-desktop contract promises bound domain operations and
reporting, not new host connections. The approved follow-up direction is direct
native saved-connect replay and a BindingConnect-only relay over the existing
private UID-checked socket for new verification. This PR implements neither that
relay nor its Core replay helper, and introduces no serialized authority file.

Tests use an owned fake daemon and real temporary project directories to prove
canonical aliases, wrong/missing roots, exact thread ownership, final root
recheck, full wire requirements and absolute deadline rejection. No live provider
is launched. MCP/the review tool remain disabled under the owner's current-session waiver;
organization security guidance was not checked.

## Spec references

- [PROCESS: binding preflight and final IDs](../planning/low-level/PROCESS_AND_PROTOCOLS.md#2-shared-adapter-contract)
- [PROCESS: Codex existing daemon](../planning/low-level/PROCESS_AND_PROTOCOLS.md#4-codex-01600-adapter)
- [API: owner replay](../planning/low-level/API_AND_MCP.md#1-envelope-actors-and-replay)
- [SETUP: bound operations while closed](../planning/low-level/SETUP_AND_DELIVERY.md#1-installed-files-project-data-and-bindings)
