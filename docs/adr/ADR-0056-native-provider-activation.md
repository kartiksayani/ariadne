# ADR-0056: Native provider qualification and dynamic activation

Status: accepted
Supersedes: none
Superseded by: none

## Context

The private bootstrap relay, opaque qualified Claude facts, owned qualified Codex
reader, real native Core and binding supervisors are merged. Their native join
must preserve replay, original admission deadlines and durable identity without
inventing readiness from a connection receipt. An immutable startup route map
cannot admit a newly connected binding or fence an obsolete generation.

## Decision

The maintainer approved a runtime ProviderFactory with trusted installed paths,
an owned registered-root resolver and provider instruction bodies. Composition
supplies the canonical single-source agent rules; runtime validates their bounds
and keeps no duplicate rules document or dependency on CLI. Registry/Store locks
end before provider IO. Claude uses immutable provider qualification facts;
Codex retains its initialized selected-thread reader on the request's stack.
Neither factory allocates placeholder binding IDs or starts/resumes a host.

NativeCoreService.connect_before delegates the existing binding transaction.
Both replay lookups precede deadline guards. Fresh work checks the original
deadline before qualification, after IO, and after reacquiring registration
locks before any allocation/write. A transaction already begun retains existing
commit/uncertainty/replay semantics. No thread-local/global deadline cache or
provider-operation stash is introduced. Concrete adapters expose an inherent
connect_before, carrying the original Instant through queue admission and IO;
the shared Adapter trait and ordinary default method budgets remain unchanged.

Fresh admission also follows all-project registration scans and final Store
lock waits. Existing-session mutation checks inside Store.transact's callback,
after its exact replay. New-session creation checks before speculative IDs, then
uses an additive guarded-create method under the final stable session lock after
exact replay and candidate validation, before the first transaction temp write.
The original create_with_receipt remains a no-op wrapper with identical errors.
Lock/read/validation entry is not persistence begun; once the first transaction
write starts, no deadline check cancels or claims rollback of that transaction.

Claude bootstrap saves Unknown/Disconnected and returns the canonical receipt
before waiting for the Mod's actual saved binding/generation announcement. A
matching bound announcement is a distinct operation with its own original
deadline. Its native qualification retains the actual receipt age and checks
the registered identity/root and saved fingerprint before publishing evidence.
Subsequent qualified heartbeats refresh the same active evidence slot without
recreating its adapter, supervisor or lease. Wrong or stale scope cannot refresh
the current slot. Codex consumes its request-local reader after the receipt and
performs final connection checks using actual saved IDs within the originating
bootstrap deadline. A concurrent exact replay never requires provider readiness.

Final connection precedes physical leasing. The supervisor validates canonical
Connected/reconciliation receipts before its ClaimGate opens. Dynamic control
routes publish only after reconciled progress and an authoritative binding reread.
The synchronized map contains existing real BindingLease/ClaimGate pairs; locks
end before Core/provider IO. Removal checks generation, so stale completion
cannot remove a newer route. Dynamic lease clones and started control calls retain
the same Arc-owned DesktopOwner until actual blocking work ends. Explicit Quit
fences admission, removes routes and waits for workers/route monitors; it does
not persist disconnect or rotate IDs. Owner pause and recovery guards remain in
Core. Native composition must inspect pending-fact/error handoffs.

## Consequences

Scripted-provider tests join actual native Core, private IPC, final connection,
canonical reports and physical route admission. They prove Claude's receipt-first
ordering, pause/replay preservation, qualified heartbeat instance reuse, Codex
reader initialization reuse and final-root rejection without dispatch, plus
deadline/lock-wait and conditional generation removal behavior. Tests use only
version stubs and local wire fixtures; no live/paid provider is launched.

Desktop startup and installed command composition must consume these APIs in a
subsequent owned join against actual merged prerequisites. This PR alone does
not complete runtime task acceptance, installed application behavior or live-host
acceptance. Direct registered native Core reporting remains available after the
desktop exits; a stopped socket is never a fallback write route.

## Spec references

- [Claude qualification facts](ADR-0051-claude-native-pre-id-qualification-facts.md)
- [Qualified Codex adapter](ADR-0052-consume-qualified-codex-reader-in-adapter.md)
- [Process and protocols](../planning/low-level/PROCESS_AND_PROTOCOLS.md)
- [Queues and recovery](../planning/low-level/QUEUES_AND_RECOVERY.md)
