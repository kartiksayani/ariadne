# ADR-0052: Consume the qualified Codex reader in the full adapter

Status: accepted
Supersedes: none
Superseded by: none

## Context

ADR-0047 owns a read-only initialized reader for an exact selected thread and
registered canonical root before Core allocates final IDs. Native composition
needs the full queue-capable adapter after persistence without discarding that
reader, opening another initial connection or using placeholder binding IDs.

## Decision

The maintainer approved `CodexAdapter::from_qualified_thread(qualified,
instance_id)`. The real native instance identity is supplied by its caller;
Adapter.connect later supplies the final durable binding and generation. The
existing bounded provider IO worker consumes the initialized reader for this
first bind, retaining all required final thread/read, queue/list and full turn
checks and canonical root equality. Its original worker admission deadline also
bounds final binding; queued time does not create a fresh ten-second budget.

The adapter privately retains the exact selected thread, root, endpoint, socket
fingerprint and the executable metadata identity already verified by the reader.
Reconnect can reopen that same endpoint with the original options, repeat version,
peer and full selected-thread checks, and compare against those retained identities.
A changed root, thread, endpoint or identity fails closed and requires fresh native
qualification; reconnect cannot silently replace the qualified selection. These
are the existing identity checks, with no new digest or attestation policy. The
ordinary `CodexAdapter::new` and raw low-level reader paths keep their established
behavior. All provider IO remains off the executor and outside Registry/Store locks.

## Consequences

This is the adapter-owned constructor join. Native composition still owns exact
owner replay before preflight, configuration validation, locked final-ID allocation,
canonical connection reporting, persisted-attempt reconciliation and actual
lease/ClaimGate activation. Consuming a reader neither grants dispatch authority
nor establishes the installed CLI/native composition or live-host acceptance.

Existing Unix fake-daemon and argv fixtures prove initialization reuse with final
reads, no pre-connect queue send, immutable selection, root/full-item rejection,
same-target reconnect, replaced socket/executable rejection, and a queued final
bind bounded by its original deadline. No provider host is launched.

## Spec references

- [ADR-0047: pre-ID qualification](ADR-0047-qualify-codex-before-binding-identity.md)
- [PROCESS: final-ID connection](../planning/low-level/PROCESS_AND_PROTOCOLS.md#2-shared-adapter-contract)
- [PROCESS: Codex existing daemon](../planning/low-level/PROCESS_AND_PROTOCOLS.md#4-codex-01600-adapter)
