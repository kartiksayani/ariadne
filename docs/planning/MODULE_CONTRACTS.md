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

Desktop composition joins P3.2/P4.1 through the actual NativeCoreService,
ProviderFactory, shared DesktopOwner/control routes and registered-parent watcher.
Its native-only qualified connect callback preserves the command admission
Instant. The opt-in supervisor presence observer publishes only accepted scoped
facts; the existing SessionList presence projection supplies late-reader seeds.
Ordinary App/WebView receipt-and-disk acceptance remains required; these additive
internal seams do not change public CoreService/DTOs or complete live-host and
packaged-default milestones. See [ADR0059](../adr/ADR-0059-desktop-core-and-runtime-composition.md).

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

Desktop composition owns the native startup, executor and shutdown wiring. Its
private bridge admits Core calls onto that owned executor and returns their
authoritative results; it must not mask saved replay or persistence with an outer
deadline. Provider admission retains the original deadline. Wake fences new
admissions and drains admitted work before replacing activation; Quit wins over
wake and retains ownership until admitted work has drained. Both fences also
synchronously stop the current activation's claim/delivery gates before any
preference or admitted-work drain. Activation supervisor start/installation is
serialized with that fence; wake fences the old activation before taking it out
of shared runtime state. Its later replacement is published only while Quit has
not begun. The synchronous fence performs no Core/provider IO or waits; actual
worker shutdown remains off the UI thread. No ordinary worker lock is held
across Core/provider IO or result waits.

The composition-only `DesktopService::with_native_preferences(read, write)`
builder preserves existing request and receipt validation. Its parameterless
read returns only the fixed global preferences snapshot; its write accepts only
the validated global preferences patch. It serves the two native window/tray
preference writers on the same owned executor. Quit fences ordinary
renderer/control/provider admission and the two preference producers, then
drains their already queued or frozen saves through this preferences-only
callback before releasing the executor. A writer-owned save may reach its first
Core call after the fence; a second runtime request tracker must not mistake
that drain for a new user action. This is not a renderer or CoreService admission
bypass. Writers own exact retry identity, reject new producer actions after the
fence, and never substitute a pending request after an unknown failure. Drain
off the UI thread without holding the worker lock across IO. Only a validated
receipt or a replay-first preference revision rejection with a differing
canonical current revision clears an attempted request.

The tray consumes the existing validated desktop query envelope through the
additive `DesktopService::native_query` method. Composition installs `NativeTray`
after managing the real service, feeds `refresh` from existing watcher/fallback/
focus events, and calls `stop` before runtime shutdown. Tray owns its bounded
coalescing feed and notification policy, not a second global scanner. Lifecycle
diagnostics replace a bounded display snapshot; they never consume recovery
facts or grant dispatch authority. Install the single notification delegate on
the main thread before launch callbacks, retain it there, and fence callbacks
before draining the feed. Shutdown failure does not reactivate callbacks.

Recovery action controllers live for the application lifetime, independently of
open views. Reopening a session may attach its new data reader only to the same
immutable project/session route; pending request bodies and operation IDs remain
frozen. Generic pre-Core errors cannot prove an earlier uncertain action was
unsaved. Only verified replay-first transactional rejections permit a corrected
new deliberate action. Actual restart reloads canonical state without automatic
resend or a new persisted client journal.

Native recovery consumes qualified presence through the additive
`NativeCoreService::execute_recovery_with_observation(context, command, observation)`
entry point, accepting only InputResolve and an optional native-only
RecoveryObservation. Ordinary CoreService calls retain Unknown by default.
Desktop composition selects the existing presence-cache fact for the registered
session's current binding/generation/instance, rechecks freshness at execution,
and passes it off the UI thread without a cache lock across Core IO. Missing,
stale or unqualified facts remain Unknown; fresh Running/WaitingForApproval
blocks recovery, and Idle permits the existing explicit recovery command.
Observation lookup must not reject an exact saved replay before Core's
transaction: it supplies an optional fact, while Core owns replay and current
binding guards. No renderer-supplied presence is trusted and no new wire DTO,
second presence cache, provider call or automatic resend is introduced.

Instance and binding leases retain physical locks until their final owning
reference is dropped, including references held by already admitted work. The
acquiring process explicitly unlocks at that final drop before closing its file:
a concurrent fork may temporarily retain an inherited descriptor despite
close-on-exec. An inherited descriptor does not give the child ownership. A child
dropping an inherited Rust object must only close its copy, never unlock the
parent's still-live lease; compare the acquiring process ID before explicit
unlock. A shared binding lease continues to retain the instance owner until its
own final drop. This preserves drain order and introduces no early release or
new dispatch authority.

Ordinary App assembly reuses NavigationWorkspace and ReferenceWorkspace with
optional Waiting and rail content, the existing detail slot, and explicit
query/view/rail/theme callbacks. Default reference-gallery output remains stable.
NavigationStore keeps canonical theme changes on its existing serialized
preferences writer; graph display mode stays local because it is not a canonical
session preference. Application-lifetime routing and recovery controllers share
one desktop service. Nonvisual session/item data attributes on the real controls
support native acceptance without adding a separate test flow.

### Claude installed-helper acceptance join

P3.3 joins the actual setup-rendered immutable Mod, executable CLI, native
activation/private control and Core/Store in one deterministic fixture. Only the
Claude SDK/host and its version response are scripted. Prove explicit attachment
to a populated existing session, the saved historical snapshot ceiling, isolation
of later unissued inputs, no implicit prompt, exact claim/payload/turn/result
correlation in both completion orders, and captured late CLI reports after desktop
closure. Reuse existing transport and normalization tests; do not add a parallel
transport framework. This is installed-composition evidence, not live-host M7.

After validating the exact saved connect receipt and explicit target, the Mod
retains and announces its binding/generation before requesting route-dependent
connection status. Native qualification/reconciliation still owns route publication.
If announcement acknowledgement or status is unavailable, retain the original
connect operation and saved scope, report activation as pending and retry that
exact operation on the owner's next connect attempt. Do not invent Connected,
enable claims early, or allocate new IDs to recover a lost response. Session-end
and outstanding original-scope report guards remain in force.

An actual Claude SDK `session.end` is terminal for that saved binding generation,
including when its original native activation is still pending. Reserve the
normalized event ID `claude:session-ended:<binding UUID>:<generation UUID>` for
that non-attempt `Disconnected` fact on a Claude binding only. Validate its exact
scope and kind; ordinary transport-disconnection events keep ordinary IDs and
remain reconnectable. The Mod retains the original event and retries unchanged.

Core records this terminal fact in the existing durable Event receipt even when
the binding was already disconnected. Under the same Store transaction lock,
a fresh Connected event cannot re-enable a generation with that terminal receipt.
Preserve Store's existing exact-event replay before mutable guards: replaying an
old Connected receipt does not change the now-disconnected state. Native
activation checks the authoritative terminal receipt at its current-scope
admission and publication checks; claims still require Core's current dispatch
admission. Qualification, timeouts, lost acknowledgements, restarts, and replay
must not remove this fence. A new explicit connect rotates generation and is not
fenced by the previous generation's receipt. No new DTO or CoreService method is
needed; shared receipt lookup/identity helpers must have one implementation.

The protocol exports `claude_session_end_event_id(&UuidV4, &UuidV4) -> String`
and `is_claude_session_end_event(&NormalizedEvent) -> bool`. Core exports
`lifecycle::claude_generation_ended(&Session, &UuidV4, &UuidV4) -> bool` for its
transaction and native activation. The lookup requires the actual Claude binding,
matching Adapter receipt actor, exact event ID, non-attempt scope, and a durable
Event receipt. Reject reserved-namespace misuse before receipt allocation. These
are shared helpers; the existing service and serialized interfaces are unchanged.

Prove the actual installed-Mod/native activation race, already-disconnected end,
failed-report identity preservation, delayed/replayed Connected, restart, ordinary
disconnect/reconnect and a new generation with real Core/Store. This is a durable
ordering correction; do not interpret arbitrary diagnostic reason text as a fence.

After that joined proof, `domain_cli` may report support for the current supported
installed helper release only following existing native qualification: fresh SDK
identity/project, qualified Claude version, exact selected helper path/version,
and loaded/installed resource parity. Unsupported helper releases remain false;
`domain_mcp` remains false. Pre-ID `QualifiedClaudeHost` and final Adapter.connect
must use the same conditional capability constructor so saved and Connected facts
agree. Support grants neither binding authority nor dispatch admission and does
not promise host approval or success of an individual operation.

This uses the existing immutable release/version identity assumption: version
checks do not distinguish different helper builds sharing a version. A release
changing the supported command contract must change its release identity; no
cryptographic attestation is claimed. Keep the qualification limit in ADR-0051
and PROCESS_AND_PROTOCOLS with the implementation. This amendment changes no
CoreService signature or serialized provider DTO. The maintainer owns this
contract; the assigned worker owns the adapter condition, joined fixture and
affected conformance tests, and reports any insufficient qualification facts
before changing the contract.

## Desktop discovery consumer

DesktopService receives trusted composition callbacks for the existing native
discovery snapshot and connection-panel activation. RendererService exposes
`discovery(): Promise<DesktopDiscoverySnapshot>` and
`setConnectionUiOpen(open: boolean): Promise<void>` through desktop-only
`discovery_snapshot` and `discovery_ui_open` commands. CoreService, provider methods
and durable domain state do not change. Declare the wire projection once in core
`dto/desktop_discovery.rs`, exported by the existing core DTO generator; reuse
domain/protocol types rather than a parallel generator or handwritten TS copy.

Project candidate adapter, endpoint, external session, cwd, title, host version,
observation time, freshness, compatibility, availability, loaded state and nullable
binding/session identity. Keep native Instants, resource descriptors, qualification
slots and announcement authority private. Validate at most 256 candidates and a
1 MiB serialized response; invalid/oversized snapshots return a visible error,
without silent truncation or replacing the last valid renderer snapshot. The open
request is a strict boolean object. Accept no renderer-selected scan roots,
provider configuration, timestamps or qualification. Native calls follow existing
off-thread admission/shutdown rules; discovery never registers or binds anything.

One application controller serializes activation changes and permits one snapshot
read at a time. Either a visible BindSession dialog or the explicitly expanded
Projects "Discover host sessions" section activates it. Poll snapshots every five
seconds while open; the existing native poller owns immediate-on-open and thirty-
second scans. Closing either consumer updates their combined visibility; dismissal,
disposal and StrictMode replay must not leave scans open. Ignore obsolete reads.
Existing native wake reconciliation remains the sole wake/probe path.

Projects groups candidate cwd facts and offers explicit Register project, which
only prefills the existing form. Registration then opens that project; Connect is
a separate explicit action. BindSession shows candidates for its selected project,
retains manual entry/Codex status guidance and the new/existing Ariadne-session
choice, and only prefills on selection. Explicit Connect uses the existing canonical
request and immutable retry identity. Candidate identity includes adapter, endpoint
and external session. Grouping never authorizes a project or binding; native
qualification, current binding and rebind guards remain authoritative.

Loaded means daemon membership only; Unknown/Stale never imply Idle or readiness.
Refresh preserves manually typed fields and visibly invalidates a selected candidate
that vanished, changed identity or became stale. Failed refresh retains the last
complete snapshot with an error/freshness indication. Tests prove projection bounds,
actual runtime callbacks, serialized open/close, obsolete reads, explicit registration
and connection, manual fallback and exact retry identity. Native acceptance uses the
existing scripted provider and actual App/Core/Store; no live host or new scanner.

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

## Personal package resource export

P6.4 reuses the CLI's compiled integration inventory through the read-only
`ariadne package-resources --helper-path /absolute/final/bin/ariadne` command.
Its JSON response is `{schema_version: 1, version, files}`, where `files` maps
the existing `setup::resources::bundle` relative names to UTF-8 contents. The
helper path is absolute and normalized, may name a not-yet-installed binary,
and is rendered as data; this command neither writes files nor invokes a host.
Invalid arguments or an unrepresentable resource return a nonzero status.

The installer validates the bounded response and version, installs these files
under the version's `integrations/` directory, and rejects absolute or escaping
resource names. It must not maintain a second resource inventory. The existing
v1 `install.json` routing fields stay unchanged; fixed-path ownership digests
may extend that manifest for conservative uninstall. Unknown inventory paths
never authorize filesystem deletion. Tests use isolated temporary homes, and
actual installed-artifact acceptance remains a CI/release gate.

## Shared contract changes

Workers propose signature or semantic changes to the maintainer **before**
dependent work. The maintainer adjudicates, updates the authoritative contract,
and dispatches all affected producer, consumer and conformance changes. There
are no worker-local contract forks. Important architecture decisions receive a
short ADR with the affected implementation; routine compatible amendments are
documented in their PR.

MCP/Seezo remain disabled under the owner's current-session waiver. Organization
security guidance was not checked; no approval is claimed.
