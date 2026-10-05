# ADR-0060: Keep one owner for desktop integration seams

Status: accepted
Supersedes: none
Superseded by: none

## Context

The first assembled desktop PR exposed unassigned integration responsibilities:
shutdown ordering, supervisor admission, late-reader presence and shared native
wiring. Repeated integration and review rounds cost delivery time without adding
features. The module contracts did not name owners for these joins.

## Decision

The maintainer owns the composition contract and assigns one implementer at a time
to shared native wiring. Record current ownership in the delivery handoff. Other
workers propose shared-file changes to that owner instead of editing independently.

| Surface | Responsibility | Change owner |
| --- | --- | --- |
| Desktop startup | Composition installs actual Core, owned executor, provider activation, control server and watchers once | Assigned composition implementer; maintainer by default |
| Quit and wake | Runtime fences admissions and supervisor gates; window/tray fence new intents; retained work drains off the UI thread before executor/lease release; Quit wins over wake | Same composition implementer |
| Host presence | Runtime publishes qualified scoped observations; SessionList seeds late readers; SessionStore consumes seeds before subsequent hints | Composition owner for producer; named renderer owner for consumer, using the same contract |
| Shared native files | `src-tauri/src/lib.rs`, Cargo manifests/lockfile, Tauri config and generated-contract registration | One named integrator; maintainer until reassigned |

MODULE_CONTRACTS and ADR-0059 retain the authoritative behavior. This decision
does not change lifecycle ordering or saved-operation replay. Architecture changes
return to the maintainer before coding.

After the first composition PR merges, remaining work lands vertically on actual
main: implementation plus real Core/native acceptance where applicable. One worker
follows P3.2 → P4.1 → P4.4 without unrelated assignments; a second follows P3.3 and
its dependent discovery join once eligible. Parallel work uses disjoint paths.
New modules do not take priority over these unfinished acceptance joins.

## Consequences

Shared-file changes serialize a small part of delivery instead of requiring a
later combining PR. Original full acceptance remains required; mechanism-only
merges stay partial. Native, packaging and browser execution remains in CI, with
independent review, measured coverage and green quality before squash merge.

## Spec references

- [Composition contracts](../planning/MODULE_CONTRACTS.md)
- [Desktop composition](ADR-0059-desktop-core-and-runtime-composition.md)
- [Delivery and current ownership](../../ORCHESTRATOR.md)
