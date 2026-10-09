# ADR-0020: Publish the provider-neutral adapter contract

Status: accepted
Supersedes: none
Superseded by: none

## Context

P0.5 must publish callable adapter methods and exact normalized events before
runtime, core reports and first-party providers depend on them. The initial
specification named async methods and historical evidence without fixing object
safety, typed errors or which generation historical events carry. Domain DTOs
already publish capability, presence, checkpoint and receipt records.

## Decision

The maintainer adjudicated an object-safe `Adapter: Send + Sync` with `&self`,
owned requests and boxed pinned `Send` futures using only std. The runtime owns
executors, deadlines and lease validation; no extra async runtime or macro is
needed to publish the seam. The six methods share canonical domain support types.

Protocol errors contain typed code, bounded actionable message and retryable.
The exact PROCESS vocabulary maps exhaustively into P0.6's public envelope.
Possible host send/execution yields `SubmitOutcome::Uncertain`; retryable never
authorizes resending uncertainty. Rejection requires proof before delivery.

Observation uses current generation. Reconciliation is authorized through the
current supervisor after exact host identity verification, while each historical
attempt and matched event retains its originating generation. Validation rejects
cross-scope facts without rewriting old dispatch or implementing core state.

Event envelopes flatten a tagged kind/payload union and explicitly emit nullable
fields. Identifiers remain opaque nonempty bounded strings. Diagnostic bounds use
UTF-8 bytes, with explicit truncation/gap flags. Rust-authored schemas/TypeScript
extend existing generation and import canonical domain declarations.

Terminal fallback IDs use lowercase SHA256 over serde_json's compact UTF-8 JSON
array `[binding_id,generation,attempt_id,host_turn_id,kind]` in that order, with
explicit null for an absent turn. Only finished/rejected/uncertain kinds use the
helper; valid source identity is preserved verbatim. Status/diagnostics are
excluded so conflicting facts still reach core. A fixed vector and boundary
distinctions anchor producer/consumer convergence.

Reconciliation must represent every requested attempt with an evidence entry or
unresolved ID, without duplicates within either collection. Partial evidence may
overlap unresolved IDs. This finite completeness validates response shape; it
never proves delivery or terminal outcome. A malformed response retains callers'
persisted unresolved state.

## Consequences

Providers and consumers can compile against one reviewed seam without provider
wire types, duplicate domain records or a public plugin loader. Callable checks
enforce shape/correlation/scope; core still owns replay conflicts, committed
results, attempt progress and outcome joins. Schema/TypeScript cannot enforce
cross-field correlation or UTF-8 byte semantics alone.

An explicit test-support feature exposes the scripted fake only for test/dev
consumers. It preserves configured facts and request history, without hidden
checkpoint advance, host execution or resend. Default library doctests prove the
fake is unavailable without that feature. Contract publication is implementation
evidence; P0.5 completion retains P0.3 fixtures and all original acceptance.

## Spec references

- [PROCESS: adapter contract](../planning/low-level/PROCESS_AND_PROTOCOLS.md#2-shared-adapter-contract)
- [Required v1 adapter scope](../planning/AGENT_ADAPTERS.md#required-in-v1)
- [Module contracts and acceptance joins](../planning/MODULE_CONTRACTS.md)
