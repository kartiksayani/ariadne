# ADR-0036: Persist FIFO claims and join verified delivery facts

Status: Accepted

## Context

Owner inputs are durable before dispatch. A provider receipt, matching completed
host turn, and explicit structured domain result are separate facts, and may
arrive in either order. Neither missing evidence nor a timeout authorizes resend.

## Decision

Native `DeliveryService` prepares the smallest queued sequence under the existing
session transaction. It validates dispatch and current lease context, formats
exact owner content plus frozen and current target context, then saves one
Attempt, `Claim {input_id,attempt_id}` receipt, active backlinks and issued owner
watermark before returning. The canonical marker line and LF are included in the
whole 64 KiB payload digest. Bounded recent context omits whole older records;
queries retain the full history. A capacity failure does not allocate or write.
Exact request replay derives the same immutable payload from the retained Attempt
before mutable generation, dispatch or queue guards. Healthy no-work does not
allocate, save a receipt or increase revision.

`Store::transact_event` scans full opaque event IDs and canonical adapter actor
under that same stable session lock. It reuses Store's route/actor/command digest
and atomic commit, without another index or turning a hash into a UUID. Only
envelope and accepted host-receipt observation timestamps are omitted from the
semantic digest. New effects allocate an ordinary native UUID after validation.
Unchanged means the candidate equals live structurally: no allocation, receipt,
revision or write. Successful and rejected durable facts are distinct outcomes.

A contradictory known-ID proposal preserves the original receipt scope; incoming
replacement IDs cannot retarget another input or binding. Core validates current
native authority or exact verified historical reconciliation before new effects,
then atomically retains `EventConflict {event_id,input_id,attempt_id}`, pauses the
affected binding and returns `ProtocolConflict`. Original facts/results/receipts
remain immutable. Exact original facts replay success; exact conflicting facts
replay their saved rejection without another effect. Contradictory fresh-ID facts
use the same atomic barrier. Sealed/skipped Input and Attempt bytes are preserved:
redundant fresh observations are unchanged, contradictions pause only the binding,
and nonredundant noncontradictory additions reject `AttemptSealed`. There is no
second transaction gap or reopened delivery authority.

Apply and reporter use the existing pure delivery join. Only completed host turn
plus committed result without failure/uncertainty/contradictory error seals and
handles. Failed/interrupted/uncertain facts retain domain data and require owner
recovery. A retained EventConflict for the exact originating adapter binding,
input and attempt is also contradictory evidence; resolved prior attempts cannot
poison a distinct attempt. It replaces an automatic ResultMissing pause with
Uncertain while preserving the original warning and other recovery reasons.
Late acceptance/start cannot regress a terminal turn. Late valid result
clears only the automatic ResultMissing barrier and preserves owner pause,
disconnection, other recovery reasons and retained warning history; it cannot
seal or clear a retained contradiction.

Native `expire_missing_result` is an explicit idempotent scheduler entrypoint
with exact attempt/current trusted context and native operation ID. After five
seconds from the persisted completion observation it saves `DeliveryExpiry`
and Missing/needs_attention, retaining the unsealed attempt. Future/negative
elapsed time, committed result, existing Missing, sealed work or failure/uncertainty
has no effect. Five seconds is UI grace policy, never proof that a result cannot
arrive. The real off-UI native timer and CoreService/provider composition remain
an explicit P3.2/P2.2/P4.1 integration join; this task creates no provider event,
CoreService method, background timer or automatic resend.

Domain's pure persisted validator checks introduced identities/backlinks,
receipt attempt scope and prepared bytes. One `validate_prepared_payload` helper
serves both persisted and existing Core wire validation, using already pinned
sha2 without a Domain-to-Core dependency. It does not reapply fresh admission or
current-generation guards to historical/sealed/repair retention. Existing fixture
attempts without the marker prefix, and cloned test attempts whose IDs changed,
are mechanically corrected to the same dialect while retaining original bodies;
there is no migration or alternate historical payload dialect.

## Consequences

Ordinary filesystem failures stay native Store/Registry causes, and errors after
a durable atomic rename keep existing commit-uncertain semantics. Every host or
socket wait stays outside Store locks. Real filesystem and separate writer tests
exercise claim races, concurrent Apply/report joins, replay, conflicting facts,
grace boundaries and preservation of earlier records. Provider execution and
final production scheduling acceptance remain separately owned integration work.
