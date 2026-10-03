# ADR-0028: Publish the renderer service and trusted native composition

Status: accepted by maintainer adjudication; early P4.1 implementation.

## Context

Parallel screens need one generated DTO service and one registered reveal route.
P0.6 publishes a synchronous typed CoreService but its production core/store/runtime
composition is not ready. Renderer IDs cannot establish registered membership, and
the default desktop must not silently install a scripted service.

## Decision

Publish canonical Rust `SessionChangedHint`, `PresenceChangedHint` and `OpenRoute`
records through the existing generator. Presence generation equals its observation;
session-only routes emit explicit null, and item routes reuse `ItemRoute`.

Desktop calls use exact canonical snake_case command names with one `request`
argument containing `OwnerQueryRequest` or `OwnerMutationRequest`. Trusted Rust
startup may inject an `Arc<dyn CoreService>` and a private resolver closure backed
by actual Registry/SessionRepository membership. Every resolved session must match
the requested project/session before Core is called. Continue checks both source
and target. Registry bootstrap commands retain `OwnerScope::Registry`; Core owns
their actual project/root trust checks. No renderer command installs composition.
Ordinary uncomposed commands return concrete nonretryable `unsupported`.
Async Tauri commands move the complete trusted lookup and synchronous core call
onto Tauri's existing blocking executor. A terminated read worker returns a
nonretryable `io_error`; a terminated mutation worker returns `commit_uncertain`
with reconciliation guidance retaining the original operation ID, since durable
effects may already exist. Neither response includes panic diagnostics.

Each opened session has one immutable external snapshot store. Subscribe before
loading; coalesce newer revision hints; reconcile on focus, wake and every2s;
preserve the last valid snapshot on failed, older or misrouted reads. UI drafts and
filters stay separate. Registered item reveal validates the backend route, loads
the session and derives temporary ancestry from explicit parent fields. Backend
`SummaryCounts` retain incomplete scope rather than being rebuilt from visible rows.

Add `io_error` for definite ordinary local I/O (CLI exit4), nonretryable by default.
More precise permission/capacity/busy/commit-uncertain errors take precedence. An
explicit transient classification may retry the same operation; this code neither
asserts an irreversible operation was unsent nor permits uncertain provider resend.

## Consequences

Scripted CoreService is restricted to tests/dev. Native command transport tests
exercise the actual shared Tauri handler and canonical request inventory; they do
not prove store persistence or a real provider. Existing native/release gates remain.
Actual Registry-backed startup, registered-parent OS watching, production CoreService
and the original on-disk UI acceptance join remain P4.1 completion prerequisites.
The early reusable seam does not switch the reference gallery or claim P4.1 complete.

See [API and events](../planning/low-level/API_AND_MCP.md#5-events-and-errors),
[UI synchronization](../planning/low-level/UI_AND_NATIVE.md#2-snapshot-and-event-synchronization)
and [implementation joins](../planning/MODULE_CONTRACTS.md#implementation-prerequisites-and-acceptance-joins).
