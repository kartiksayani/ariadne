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
getter uses the same conditional constructor as the full adapter. The installed
Mod/helper/native/Core/Store acceptance join qualifies domain CLI command support
for release `0.1.0` after the existing exact helper path/version, original SDK
identity/project, Claude `2.1.287` and nine-resource loaded/installed parity checks.
Unknown helper releases and domain MCP remain unsupported. Command support grants
no Core authority, dispatch admission, host approval or per-operation success.
These facts are an owned read-only observation, not a Core authority, connection handle,
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

The installed Mod validates the entire saved receipt and explicit target before
publishing that exact bound scope through its existing announcement path, then
asks for route-dependent connection status. It retains that announcement scope
and the original connect request/operation ID when the announcement acknowledgement
or status is unavailable. The owner explicitly retries the same selector once
native reconciliation publishes the route. Pending status enables no claims,
Connected fact or new binding. Session-end and retained original-scope report
guards still fence admission and rotation.
The validated saved scope immediately retains a quiesced existing claim-loop
reporter before announcement/status awaits. Actual session end uses that reporter
even while activation is pending or the receipt arrives after session end. A
distinct original loop keeps its captured callbacks and unsaved reports; identical
scope reuse preserves report event IDs. Neither reporter's outstanding evidence
may be discarded by a later owner receipt.

## Consequences

Native composition activates after the matching bound announcement without
waiting for it before returning bootstrap IDs. The original qualification seam
and consuming activation remain distinct from dispatch authority. Tests verify
provider facts agree with final connection fingerprint/capabilities, preserve
receipt age, and retain the caller's shorter budget through native discovery.

The consuming CLI test imports the setup-rendered installed Mod and forwards its
helper argv/stdin to the production executable. Native activation, private control,
Core and Store stay real; only the Claude SDK/host and host version response are
scripted. It proves explicit existing-session attachment, the saved owner-context
ceiling and later unissued-input isolation, no implicit prompt, both domain-result
and completion orders, and captured original-scope reports after desktop closure.
This is deterministic installed composition evidence; live-host M7 remains separate.

Release identity retains the existing immutable-version assumption: version
checks cannot distinguish different helper builds both reporting `0.1.0`.
A release changing supported command semantics must change its release identity.
No cryptographic helper attestation or organizational security approval is claimed.
