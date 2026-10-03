# ADR-0023: Publish one synchronous typed CoreService contract

Status: accepted by maintainer for P0.6.

The domain and adapter contracts are merged. Independent runtime, CLI/MCP and
Tauri consumers need a callable seam without inventing entity models or building
an alternate core implementation.

Publish owned synchronous query, execute_owner, apply, claim and report calls in
`ariadne-core`. Import canonical domain DTOs, pages, cursors and saved receipts
and protocol NormalizedEvent. Rust generates the service schemas, TypeScript and
transport manifests. No new production package or generic JSON command escapes
the typed inventory.

Keep trusted routing contexts private-field, non-deserializable values constructed
by local entrypoints. They carry registered IDs, actor visibility, issued
watermark, current lease/generation and verified historical reconciliation scope.
Constructors assert prior local validation; real core rechecks persisted scope
under its transaction. This preserves the same-owner-OS trust boundary.
Owner transport wrappers carry a nullable registered session handle, never an
actor. Single-session params do not repeat it; global/bootstrap calls use null.
Cross-session preview names both sessions with null wrapper; Continue commit
uses the target wrapper and checks agreement with its explicit target. Required,
unexpected or contradictory routing is rejected by the published validators.

Preserve the existing session success data shape through an untagged typed
MutationReceipt union. Registry/preferences use distinct required receipt fields;
apply reuses SavedReceipt. Presence may return an EventReceipt without a durable
revision. Replay precedes stale revision/generation/state guards. Healthy empty or
in-flight claims return None; pause/recovery/lease/scope return typed errors.

Publish typed local owner-only preference patches and their missing read route.
Drafts remain unsent. Agent input reads return queue metadata, with full issued
history separately visible through canonical bounded projections. Nested cursor
continuations stay inside existing queries. Continue previews propose actions and
readiness without allocating target IDs.

Option-only owner Answers preserve empty/whitespace submitted bytes when an option
is selected; core still validates that option against the frozen question. Explicit
nested selectors must match returned parents and their requested limits/cursors;
every nested page shares the outer snapshot. The persisted prepared payload starts
with the exact marker and LF before safely encoded owner/context data. Its digest
covers all submitted bytes, including that prefix. P2.2 owns the production claim
formatter, while P2.5 owns MCP transport; P0.6 supplies prefix/digest validation only.

The default-off scripted double holds only steps and call history. Shared cases
exercise producer/consumer serialization and caller ordering, including checkpoint
advancement after reports persist. It has no business state machine, persistence,
runtime, host calls or normal-release fallback. Actual core/store effects, native
acceptance and provider joins remain the original later task requirements.

Declarations use the existing `src/dto` coverage convention; contexts, bounds,
serde helpers, error mapping and fake execution remain measured. Existing release
selection is narrowly extended to core Rust changes because its test-support
feature must remain absent from ordinary builds.

Organization security guidance was not checked under the owner's MCP/the review tool waiver;
no organizational approval is claimed.
