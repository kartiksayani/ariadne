# Module contracts and three-stream delivery

The low-level specifications remain the behavior authority. Rust-authored domain
types and their generated schemas/TypeScript are the single entity contract;
provider wire types stay private to their adapters. This plan adds callable seams
and shared conformance cases so producers and consumers can build independently.
It does not replace the ten product packages, original task acceptance or native
proof. See [ROADMAP](ROADMAP.md) and [tasks.json](../delivery/tasks.json).

## Published boundaries

| Boundary / contract owner | Canonical contract | Independent consumers / acceptance join |
| --- | --- | --- |
| Domain DTOs / A, P0.3a–P0.3b | [DOMAIN sections 1–2](low-level/DOMAIN_AND_STORAGE.md#1-primitive-conventions); Rust models, deterministic schema/TS exports | Store, core, protocol, UI; P0.3 completes shared demo/invalid fixtures, P1.1/P1.2 prove semantics/history |
| Pure validation / A, P1.1 | Domain invariant/transition calls over owned canonical DTOs; typed validation errors, no IO | Store can use the published callable validator; P1.3 completion still proves real validation under transactions |
| Core service / A, P0.6 | [API service seam](low-level/API_AND_MCP.md#core-service-interface); typed query/owner/apply/claim/report and scripted shared cases | Runtime, CLI/MCP, Tauri; P1/P2 supply actual domain/store behavior before acceptance |
| Adapter / B, P0.5 | [PROCESS section 2](low-level/PROCESS_AND_PROTOCOLS.md#2-shared-adapter-contract); six async methods, owned DTOs, pull/push capability, normalized events | Runtime plus Claude/Codex implementations; P3 and P7.1 join actual core/runtime/providers |
| Renderer / C, P4.1 | [UI service and route seam](low-level/UI_AND_NATIVE.md#module-service-and-route-contract); generated DTOs, revision hints, registered reveal route | Screens, graph, native routes/counts; each retains real Tauri/core/store acceptance |

P0.3b publishes exact stored entities, receipts and query projection shapes. P0.5
publishes exact adapter method DTOs and normalized event payloads. P0.6 publishes
the callable core trait, typed command/query unions and shared semantic fixtures.
Its implementation can begin after P0.3b and the merged P0.5 adapter event
contract, which its report methods consume; full acceptance retains P0.3
canonical demo/invalid-fixture prerequisites.
Consumer work starts only once its required published surface is reviewed and
merged; a prose name or a draft PR is insufficient. Do not copy entity schemas
into this document or create local variants of shared interfaces.

Core service calls are synchronous and return owned typed results. Tauri/runtime
run filesystem calls off the UI or async executor thread. Trusted local entry
points construct scoped contexts from registered IDs and the current generation;
the model/renderer cannot choose actors or arbitrary storage paths. Runtime
validates its dispatch lease; core owns persisted claims, results and joins.
Never hold a store lock across a host wait. The existing local OS-user trust
boundary remains unchanged.

Native binding fresh-work admission follows registration/session scans and the
final Store lock, with exact replay preceding the guard. Store's additive
`create_with_receipt_guarded` checks after validation and before the first temp
write; existing `create_with_receipt` remains a compatible no-op wrapper. Existing
session mutation checks in `transact`'s apply callback. Deadline rejection never
cancels persistence already begun or changes commit uncertainty/replay semantics.

## Streams and owned shared files

| Stream | First independent assignment | Subsequent module work |
| --- | --- | --- |
| A: domain/store/core | Original P0.3a primitives and working generator | P0.3b/P0.3; P0.6 service contract; validation/history/store/registry; owner/apply/query/join/history/recovery core |
| B: provider/runtime/entry points | P0.5 private pinned Codex schema/wire fixtures only; its shared DTO work waits for P0.3b | Shared protocol, runtime/control, Claude/Codex adapters/discovery, then CLI/MCP/setup |
| C: UI/graph/native | Original P0.4a licensed assets/inventory | Reference components/gallery; published service/route consumer; navigation/Waiting/tree/history/actions, graph, native routes/tray/notifications |

Private wire capture and assets can start independently. Full P0.5 completion
retains its P0.3 prerequisite. After contract publication, build full modules in
parallel, connect actual boundaries whenever available, and finish assembled
acceptance at the declared joins. P4.1 is a real domain integration task, not a
cross-roadmap priority that holds other modules behind a walking slice.

The maintainer declares one owner for root manifests/lockfiles, crate exports,
composition wiring and each shared path before dispatch. A owns domain generator
registration during P0.3a/b. B owns private Codex generated files and
`tools/xtask/src/codex_wire.rs`; changes to generator registration are handed to
A, with no simultaneous xtask edits. Once registration is handed over, the
maintainer records its new owner. Broad path globs are scope, not permission to
edit another worker's current files. Serialize overlaps; preserve others' edits.

## Implementation prerequisites and acceptance joins

The existing `depends_on` list is the full acceptance/integration prerequisite.
An optional `implementation_depends_on` list allows an earlier start only on the
published contracts/components it names. Absence means use `depends_on`.
The maintainer checks the actual merged contract and owned paths before assigning
work; the chart does not authorize tasks or resolve missing prerequisites.

A prerequisite's merged implementation can satisfy an implementation edge when
it publishes the required stable contract/component. Record its real PR as
`implementation_pr_url`. Such a task remains in progress until **all** original
acceptance, real dependencies and required checks pass. `completion.pr_url` is
recorded only for full acceptance; contract doubles or an early implementation
merge never count as completion. Any remaining integration work stays with the
original task and owner. No test, coverage, native or release check is waived.

P3.8's durable recovery module can start on merged P2.2/P2.3/P0.6. The merged
supervisor contracts already publish its consumer boundary; completed native
supervisor composition is an acceptance join, not a prerequisite for pure Core/
Store recovery decisions. Full P3.8 retains its original P3.2 dependency, audited
CLI and actual runtime composition acceptance.

P4.6's independent form/draft module starts after the actual merged P0.6 Core
commands, P4.1 renderer service and P4.4 navigation/tree components. Waiting
(P4.3) remains an original full acceptance dependency; it is not required to
implement the independent controls. The reusable controls join actual merged
Waiting/history modules when available and retain assembled/native acceptance.
See [ADR-0057](../adr/ADR-0057-contract-first-owner-inputs-and-restored-operation-identity.md).

P7.1 joins every product module and unresolved task integration acceptance.
P7.2/P7.3 retain live five-input existing-host acceptance with owner approval;
P8.1 retains the clean-install release handoff. There is no fixed integration
duration or delivery-date promise.

## Test/dev doubles and conformance

P0.6 may add a small test/dev core double that returns scripted canonical
responses/events from shared fixtures. It has no business state machine,
persistence or background runtime, and is never a normal-release fallback.
Native acceptance always exercises actual core/store. Deterministic provider
fakes remain distinct from this service double.

Both producer and consumer test the same cases: operation replay versus changed
payload conflict; stale generation/question; complete body/provenance and cursor
history; result before host completion and the reverse; uncertain delivery and
checkpoint-after-persist ordering. Tests that merely echo fixture fields do not
prove producer semantics. Actual core/store/module integration completes each
original task, then P7.1 proves the assembly.

## Shared contract changes

Workers propose signature or semantic changes to the maintainer **before**
dependent work. The maintainer adjudicates, updates the authoritative contract,
and dispatches all affected producer, consumer and conformance changes. There
are no worker-local contract forks. Important architecture decisions receive a
short ADR with the affected implementation; routine compatible amendments are
documented in their PR.

MCP/the review tool remain disabled under the owner's current-session waiver. Organization
security guidance was not checked; no approval is claimed.
