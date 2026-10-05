# ADR-0065: Validate captured reads outside storage locks

Status: accepted
Supersedes: ADR-0043 only for the read-side validation lock scope
Superseded by: none

## Context

Native run `39f1bb82` at `fdc7767` exhausted the existing bounded StoreBusy
retries while publishing the 2,000-item/5,000-message fixture. The retained App
sample found a catalogue reader decoding session JSON under the session lock in
all 692 samples; another catalogue reader, a watcher and SessionGet waited for
the same mutex. A later CLI read took 3,600ms while preferences took 11ms.

## Decision

Read-only Store and catalogue paths capture owned session bytes under the existing
process mutex and permanent file lock, using the same directory-relative safety
checks. They release the session guards, and any enclosing project guard, before
decoding and fully validating those bytes. No snapshot is returned before schema,
identity, item, history, delivery and receipt checks succeed.

The small project metadata decode and identity gate stays under the project lock,
before creating any coordination directory or lock. Catalogue reads capture each
session's bytes or read error serially, never holding multiple session locks.
They preserve per-session failures, partial counts and diagnostic no-write rules.

Locked byte capture is the read's freshness observation point. Later validation
uses that immutable capture even if a writer commits meanwhile. Continue compares
the validated capture's revision/hash before its sole target transaction; replay,
provenance and the prohibition on simultaneous source/target locks stay unchanged.

Mutations retain the full locked reread, validation, replay/admission, domain
change and atomic publication sequence. No cache, skipped validation, new retry,
longer lock deadline or new public interface is introduced.

## Consequences

Read-side JSON decoding and validation no longer occupy writer coordination locks.
CPU cost remains; this decision alone does not prove native latency acceptance.
Catalogue capture temporarily retains bytes before decoding its outcomes. Tests
pause after capture to prove writers can progress while readers still return the
captured revision; invalid snapshots must continue to fail closed.

## Spec references

- [Storage transactions](../planning/low-level/DOMAIN_AND_STORAGE.md#4-transaction-and-lock-algorithm)
- [Continue](../planning/low-level/API_AND_MCP.md#restore-and-continue-guards)
- [Prior Continue decision](ADR-0043-copy-validated-topic-history-into-one-target-commit.md)
