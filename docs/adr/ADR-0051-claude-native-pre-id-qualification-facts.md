# ADR-0051: Claude read-only qualification facts before binding allocation

Status: accepted
Supersedes: none
Superseded by: none

## Context

Binding bootstrap verifies the chosen host outside Registry/Store locks before
allocating final durable IDs. Claude discovery already qualifies actual SDK
announcements, but its opaque presence snapshot discarded the verified endpoint
fingerprint. Native composition needs those provider facts without constructing
a temporary adapter with invented binding IDs or duplicating resource checks.

## Decision

Expose provider-owned `QualifiedClaudeHost`, with private fields and no
Deserialize implementation or public constructor. The existing version/exact-root
resource qualifier constructs it; it retains the verified fingerprint, original
SDK identity and native receipt Instant/UTC observation time. Its capability
getter uses the same constructor as the full adapter. Domain CLI/MCP capabilities
remain unsupported until their installed composition is qualified. These facts
are an owned read-only observation, not a Core authority, connection handle,
binding, lease or promise of continued availability.

The existing `qualify_identity` API delegates to the same qualifier. A qualified
snapshot can fill the existing ModEvidenceSlot without copying history or
refreshing its original age. Final Adapter.connect still verifies current scoped
evidence, exact resources and freshness with actual saved binding/generation IDs.
Clearing or replacing a slot cannot be undone merely by retaining facts elsewhere.

Runtime's blocking `qualify_claude_host_before` is for an already-blocking native
verifier outside all Registry/Store locks. It reuses the existing candidate and
registered-association checks, resource probe, post-IO rechecks and short slot
publication. Its absolute caller deadline covers all work, with a 5-second
maximum. It shares the same sixteen qualification permits and failure
invalidation behavior as the existing async API; no second worker/runtime or
serialized authority is introduced. The async API delegates and discards the
returned facts, preserving its signature.

Pre-ID qualification proves the selected provider identity/resources, not a
connection scoped to future binding/generation IDs. Native bootstrap composition
must save ConnectionState::Unknown; existing Core maps it to disconnected
dispatch readiness. It returns the original saved receipt promptly so the Mod can
announce the exact saved binding/generation. A newly native-qualified bound
announcement then permits final Adapter.connect, canonical Connected report,
validated reconciliation receipts, and only then physical-lease/ClaimGate route
activation. Owner pause and recovery barriers remain. Exact bootstrap replay
returns the original immutable receipt even after current state progresses.

## Consequences

This PR provides only the qualification facts seam. Real native composition must
activate/retry qualification after a matching bound announcement without waiting
for that announcement before returning bootstrap IDs, synthesizing Connected,
resending delivery or implying a lease. Dynamic supervisor/control route
activation remains a consuming integration, as do Core VerifiedHost mapping and
the Codex qualified-reader factory. A test-only fake-provider closed loop must
prove the ordering before bootstrap is claimed complete. Current tests verify
provider facts agree with final connection fingerprint/capabilities, preserve
receipt age, and retain the caller's shorter budget through native discovery.
