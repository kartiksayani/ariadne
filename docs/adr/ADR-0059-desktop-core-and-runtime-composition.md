# ADR0059: Desktop Core and owning-runtime composition

Status: Accepted

## Decision

The desktop composes the merged NativeCoreService, ProviderFactory,
NativeActivation, Discovery and ControlServer. It acquires one DesktopOwner
before starting workers and shares that same Arc with activation and the private
socket. Registered project resolution and bound announcements consume the
existing Registry and registered_announcement_resolver. There is no second
registration, provider-readiness or dispatch authority.

CoreBridge installs the real Core and registered-session resolver into the
existing DesktopService. Its native BindingConnect callback holds a weak runtime
reference, so managed renderer services cannot retain physical dispatch ownership
after shutdown. An unavailable/stopped runtime returns a canonical typed error.
Other commands continue delegating domain effects to the real Core. DTOs,
CoreService and renderer command names remain unchanged.

Ordinary run uses a private runner without an initial service. Its trusted
startup installs the actual managed DesktopService exactly once after ownership.
The existing public run_with_startup supplies its service before the callback,
preserving callbacks that read managed state. Early geometry events wait for
service installation. Initial persisted-selection reconciliation runs on the
owned blocking executor after publication; offline domain reads remain usable.

DesktopService adds a native-only from_trusted_startup_with_connect constructor:
CoreService, a registered SessionRef resolver, and an
Fn(OwnerMutationRequest, Instant) -> Result<MutationReceipt, CoreError> callback.
The existing constructor retains its behavior. Each actual Tauri mutation
allocates its admission deadline before spawn_blocking; owner_before forwards
that exact Instant through qualification, canonical connection and activation.
No worker, bridge, Core callback or provider resets it. Canonical wire validation,
registered membership and saved-receipt validation remain at the command boundary.
Exact replay remains the Core transaction's responsibility and precedes provider
work/deadline rejection.

The Tauri command offload belongs to Tauri's global pool, so it alone cannot
prove owning-runtime shutdown. CoreBridge delegates its admitted work to the
composition runtime's blocking pool and waits on a capacity-one result channel;
BindingConnect carries the original admission Instant. Scheduling is atomic with
shutdown under the existing workers mutex, which ends before work or waiting.
An owned-call marker prevents recursive rescheduling. The caller is already off
the UI thread and waits for the actual authoritative result, including an expired
exact replay or a commit completed after the provider admission deadline. An outer
wait deadline must never mask that receipt. Channel capacity is bounded; result
waiting duration and filesystem persistence are not claimed wall-clock bounded.
The original Instant still bounds provider admission/IO. A disconnected worker
returns typed uncertainty for mutations or unavailability for reads, and its real
worker remains covered by executor drain.
No extra waiter thread, duplicate Core authority or public signature is needed.

Provider instructions include the existing generated integrations/rules/claude.md
and codex.md at compile time. The single authored source and xtask generator stay
authoritative; no runtime copy, CLI dependency cycle or new rule export is needed.
Trusted startup parses explicit absolute executable/helper/Mod/Codex endpoint
flags and the existing ARIADNE_HOME/HOME/CODEX_HOME data-root semantics. Parsing
does no filesystem or provider IO before single-instance interception. Missing
provider configuration leaves domain reads/owner saves available and fresh
provider connection unavailable. There is no PATH crawl, host launch or ambient
provider configuration/credential read. Persistent packaged defaults and
installer consumption remain P6.4 integration work.

One composition-owned Tokio runtime supports the existing workers. This is needed
because stopping ControlServer drops its async connection JoinSet while an
already started spawn_blocking operation can still retain its physical owner,
slot and BindingLease. Explicit Quit fences admission, awaits activation and
route monitors, stops intake/discovery, joins the registered watcher, and drops
the owned executor only on a dedicated joined native thread. Its destruction
awaits started blocking operations before reporting shutdown complete. Nothing
stops an external host or persists a binding disconnect/generation rotation.
Unexpected destruction on an owned task transfers cleanup to a real draining
thread to avoid waiting for itself; ordinary explicit Quit always joins cleanup.

Wake invalidates discovery freshness and replaces only the volatile activation,
using the same DesktopOwner, ProviderFactory, ControlRoutes, Core and runtime.
New admissions are fenced and the actual admitted bridge/startup-reconciliation
closures are awaited before the old activation and all route monitors stop and
before replacement is published. Private control Core calls share that same
bridge and drain. The workers mutex ends before every IO/wait; the distinct
lifecycle gate serializes only wake/Quit. Quit marks stopping before waiting for
that gate, and its flag is checked atomically with final wake publication under
the short admission lock. It cannot publish a replacement after Quit has won.
This avoids an old same-generation monitor
removing a new route. It then qualifies only the current persisted selected
bindings; Claude requires a genuinely fresh matching bound announcement. Started
blocking calls retain old leases until actual completion. Busy or missing evidence
remains unavailable. Owner pause, unresolved attempts, generation and all durable
recovery guards stay authoritative; wake never rebinds, resumes or resends work.
Native outcome callbacks retain and expose exact pending facts/errors for explicit
inspection, rather than interpreting missing receipts as non-delivery.

The native lifecycle wrapper clones its wake callback under a brief lock and
invokes it outside that lock, so Quit can reach the runtime fence while wake is
draining. Accepted Quit synchronously fences both native preference producers
and ordinary runtime admission before joining anything. Window geometry and tray
Pin intents already owned by those producers may finish their first read/save
after that fence; their frozen pending requests alone own exact retry identity.
`DesktopService::with_native_preferences` installs one private paired Rust-only
callback: a fixed global PreferencesGet returning PreferencesSnapshot, and a
validated global PreferencesPatch returning PreferencesPatchedReceipt. They use
the same owning executor, waiting for in-flight wake off UI during Quit, and are
unavailable after its removal. General renderer/control Core calls and provider
work remain fenced. No second runtime operation tracker or dispatch authority is
introduced. Generic errors retain native writer requests; only a verified
replay-first RevisionConflict with a differing current_revision establishes the
frozen edit unsaved. Window confirmation and the fenced tray feed drain before
runtime shutdown; shutdown failure never reopens admission or callbacks.

Presence adds an opt-in PresenceObserver Fn(PresenceUpdate) to the existing
ConnectedSupervisor and a compatible NativeActivation::new_with_presence.
Connected, Observed and Stopped updates carry the existing PresenceChangedHint
plus the qualified endpoint fingerprint. Accepted connected/report receipts
precede publication. Connected establishes a current instance; observations and
stops must match it. The supervisor retains and drains observation offloads on
stop, including when cancellation interrupted the await. No store IO happens
under the observer cache mutex, and an old instance cannot erase a replacement.

The composition-owned volatile cache validates actual selected binding identity,
generation and endpoint, uses the existing Discovery PRESENCE_LIFETIME, preserves
the original last_seen_at and ignores duplicate/out-of-order observations. An
owned timer emits expiry; wake/disconnect/shutdown invalidate it. Unknown/Stale
never infer Idle or dispatch readiness. SessionList overlays the existing
BindingSummary.presence; SessionSnapshot stays unchanged. After subscription and
SessionGet, SessionStore seeds from bounded project-scoped SessionList pages,
terminating on the current session. A live hint supersedes any delayed seed;
selection/generation changes or closure abort it. These facts remain separate
from durable domain status and session snapshot freshness.

The registered-parent watcher adapts unpublished task/desktop-watchers work from
0e4a3da and b266e66 under new ownership and review. Its pinned notify 8.2.0 watches
registered parents before initial snapshot reconciliation, emits only validated
SessionChangedHint IDs/revisions, coalesces changes and preserves last valid
revision through failed/deleted/unavailable reads. Selection changes priority,
never membership. Focus/wake and fallback reconciliation reuse this same worker.
Composition installs the tray after managing the real DesktopService and before
launch callbacks. Existing validated revision hints, unchanged scan completion,
focus and saved preference changes request its coalesced refresh; no separate
tray scanner/timer is added. Native notification permission has its explicit
main-window command and never runs automatically during startup.

## Acceptance boundary

Module tests join actual Core/Store, scripted provider resources, private control,
physical leases, watcher hints and explicit lifecycle. Actual ordinary App native
WebView/invoke/receipt/disk acceptance remains separate from mocked Tauri runtime
tests. Live/billable host acceptance and complete packaged default setup remain
their original milestones. No skipped native check or component test proves them.

This checkpoint has not run desktop/native compilation or the ordinary App
WebView journey. The final integration still requires actual UI Send, canonical
saved receipt/on-disk correlation, scripted real-provider queue/completion and
explicit agent CLI Apply, plus native quit/inflight-connect/wake race tests and
packaged isolation in CI. No task-completion status changes accompany this draft.

MCP/the review tool remain disabled under the owner's current-session waiver. Organization
security guidance was not checked; no organizational approval is claimed.

## References

- [Native provider activation](ADR-0056-native-provider-activation.md)
- [Native window and registered routes](ADR-0053-native-window-and-registered-open-routes.md)
- [UI and native contract](../planning/low-level/UI_AND_NATIVE.md)
