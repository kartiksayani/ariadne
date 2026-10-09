# ADR-0032: Binding supervisors and volatile checkpoint acknowledgment

Status: accepted
Supersedes: none
Superseded by: none
Amended by: [ADR-0087](ADR-0087-supervisor-retry-health-and-log.md) (only the "on receipt failure upstream stops" rule; every other control is retained)

## Context

P3.2 consumes the published synchronous CoreService and asynchronous Adapter,
without a production queue/reporter/checkpoint writer yet. A lifecycle response
can contain more than 256 facts/diagnostics. Core IO can still commit after its
caller disappears. Startup and Quit must control the actual private claim route,
including existing receipt replay, rather than depend on an informal convention.

## Decision

The maintainer approved independent native per-binding tasks with mandatory closed
ClaimGate routes in ControlServer::bind. Verified startup scans/reconciliation and
validated Core receipts open the gate. Stop fences new admissions; scheduling a
blocking claim occurs in a brief gate critical section. The started Core closure
holds the physical lease until completion, even after timeout/drop. After startup,
control forwards original claim bytes/current lease context unchanged, preserving
Core's replay-first semantics. No renderer/wire method can open the gate.

Composition supplies registered session/binding facts and nonblocking fresh UUID
and time factories. Connect precedes lease acquisition, outside store locks.
Actual connection failure reports a sanitized generation-scoped disconnected fact
through the trusted current registered context without a dispatch lease; it never
implies host termination or non-delivery. Persistence failure returns the exact
pending fact plus separate connection/report causes. Stale failures are never
retargeted. Precondition validation does not invent a host observation.

Owner Input scans use canonical 100-item revision-bound pages, restart entirely
on SnapshotChanged (three attempts), reject non-progressing sequences/cursors,
and share the existing 16 MiB session budget through a counting sink. Reconcile
uses exact persisted originating generations, batches at most 100, fresh tokens,
and only verified provider identity for historical scope. Unknown/unresolved facts
leave dispatch closed. No supervisor duplicates Core's FIFO, claim, pause,
idempotency or result state machine; pull never proactively claims/submits.

One bounded provider response supplies serialized Core reports. There is no extra
producer queue: all durable lifecycle facts remain pending until validated durable
receipts. The 256-record/2 MiB diagnostic ring is separately lossy/redacted with
explicit gaps; it never limits lifecycle counts or changes reported event bytes.
Provider response handling stays within 8 MiB without another serialized buffer.
This composes the Codex queue's retained-batch acknowledgment rules in ADR-0027,
including durable dedupe that excludes observation timestamps but preserves every
other immutable semantic fact.

Checkpoint acknowledgment occurs only after all corresponding validated receipts.
It is runtime-local, not a durable Attempt.reconciliation_checkpoint update.
Restart reconciles persisted attempts explicitly with a fresh observer; old or
absent tokens never mean no delivery. No journal or new Core/Adapter method exists.
On receipt failure upstream stops and composition receives remaining exact events,
trusted contexts and candidate checkpoint. It must persist/reconcile these facts
before treating them as acknowledged or admitting fresh work.

Quit closes gates, stops scheduling, bounds pending flush to five seconds, and
bounds observer disconnect to five seconds. Interrupted possible submit becomes
uncertain; interrupted possible claim retains its original ID. Failed flush returns
pending facts and a typed error, never clean success. Composition must also stop
the listener/release route clones. Started blocking calls retain leases until done.
There is no host signal, automatic resend, generation change or persisted owner
pause change, and normal Quit does not report domain disconnected.

## Consequences

This is an implementation prerequisite with explicit partial acceptance. P1.4
registered native composition, P2.2 production durable claims/reports/checkpoints
and provider integration still own the real runtime acceptance join. Test-only
canonical scripted services/providers exercise consumers without persistence or a
production fallback. No new executor, shared DTO, business state or recovery
framework is introduced. Application logic remains measured; default-off fake
features are consumer dev dependencies and remain absent from normal release.

## Spec references

- [PROCESS: ownership and control](../planning/low-level/PROCESS_AND_PROTOCOLS.md#1-ownership-leases-and-app-control)
- [PROCESS: shared adapter contract](../planning/low-level/PROCESS_AND_PROTOCOLS.md#2-shared-adapter-contract)
- [MODULE_CONTRACTS: implementation/acceptance joins](../planning/MODULE_CONTRACTS.md#implementation-prerequisites-and-acceptance-joins)
- [ADR-0029: control and retained leases](ADR-0029-private-desktop-control-and-leases.md)
- [ADR-0027: native Codex queue](ADR-0027-native-codex-queue-and-observation.md)
