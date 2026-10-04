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
New admissions are fenced while the old activation and all route monitors stop,
before the replacement is published. This avoids an old same-generation monitor
removing a new route. It then qualifies only the current persisted selected
bindings; Claude requires a genuinely fresh matching bound announcement. Started
blocking calls retain old leases until actual completion. Busy or missing evidence
remains unavailable. Owner pause, unresolved attempts, generation and all durable
recovery guards stay authoritative; wake never rebinds, resumes or resends work.
Native outcome callbacks retain and expose exact pending facts/errors for explicit
inspection, rather than interpreting missing receipts as non-delivery.

The registered-parent watcher adapts unpublished task/desktop-watchers work from
0e4a3da and b266e66 under new ownership and review. Its pinned notify 8.2.0 watches
registered parents before initial snapshot reconciliation, emits only validated
SessionChangedHint IDs/revisions, coalesces changes and preserves last valid
revision through failed/deleted/unavailable reads. Selection changes priority,
never membership. Focus/wake and fallback reconciliation reuse this same worker.

## Acceptance boundary

Module tests join actual Core/Store, scripted provider resources, private control,
physical leases, watcher hints and explicit lifecycle. Actual ordinary App native
WebView/invoke/receipt/disk acceptance remains separate from mocked Tauri runtime
tests. Live/billable host acceptance and complete packaged default setup remain
their original milestones. No skipped native check or component test proves them.

MCP/Seezo remain disabled under the owner's current-session waiver. Organization
security guidance was not checked; no organizational approval is claimed.

## References

- [Native provider activation](ADR-0056-native-provider-activation.md)
- [Native window and registered routes](ADR-0053-native-window-and-registered-open-routes.md)
- [UI and native contract](../planning/low-level/UI_AND_NATIVE.md)
