//! Native bootstrap and final-ID runtime activation. No provider is launched.
use crate::{
    control::{BindingScope, ControlRoutes, NativeAnnouncement, NativeConnect},
    discovery::AnnouncementBinding,
    leases::DesktopOwner,
    providers::{within, ProviderFactory, QualifiedProvider},
    supervisor::{ConnectFailure, ConnectedSupervisor, SupervisorExit, SupervisorHandle},
};
use ariadne_core::{
    native::{AgentResolver, NativeCoreService},
    *,
};
use ariadne_domain::models::*;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};

/// Native composition must inspect/retain exact unacknowledged facts in these
/// handoffs. Neither failure authorizes automatic provider delivery retries.
pub enum ActivationOutcome {
    ConnectFailed {
        scope: BindingScope,
        failure: Box<ConnectFailure>,
    },
    Stopped {
        scope: BindingScope,
        exit: Result<SupervisorExit, CoreError>,
    },
    Failed {
        scope: BindingScope,
        error: CoreError,
    },
}
type OutcomeHandler = dyn Fn(ActivationOutcome) + Send + Sync;
struct Active {
    generation: UuidV4,
    handle: SupervisorHandle,
    claude_slot: Option<ariadne_adapter_claude::ModEvidenceSlot>,
}
struct State {
    active: BTreeMap<UuidV4, Active>,
    admitting: BTreeSet<UuidV4>,
    monitors: Vec<tokio::task::JoinHandle<()>>,
}
pub struct NativeActivation {
    core: Arc<NativeCoreService>,
    providers: ProviderFactory,
    owner: Arc<DesktopOwner>,
    routes: ControlRoutes,
    runtime: tokio::runtime::Handle,
    outcomes: Arc<OutcomeHandler>,
    state: Mutex<State>,
    stopping: AtomicBool,
}
impl NativeActivation {
    pub fn new(
        core: Arc<NativeCoreService>,
        providers: ProviderFactory,
        owner: Arc<DesktopOwner>,
        routes: ControlRoutes,
        runtime: tokio::runtime::Handle,
        outcomes: Arc<OutcomeHandler>,
    ) -> Arc<Self> {
        Arc::new(Self {
            core,
            providers,
            owner,
            routes,
            runtime,
            outcomes,
            state: Mutex::new(State {
                active: BTreeMap::new(),
                admitting: BTreeSet::new(),
                monitors: Vec::new(),
            }),
            stopping: AtomicBool::new(false),
        })
    }
    pub fn routes(&self) -> ControlRoutes {
        self.routes.clone()
    }
    pub fn connect_callback(self: &Arc<Self>) -> Arc<NativeConnect> {
        let activation = self.clone();
        Arc::new(move |request, deadline| activation.bootstrap_before(request, deadline))
    }
    pub fn announcement_callback(self: &Arc<Self>) -> Arc<NativeAnnouncement> {
        let activation = self.clone();
        Arc::new(move |scope, deadline| activation.announce_before(scope, deadline))
    }
    /// Startup selects actual persisted active bindings. This qualification does
    /// not reconnect/rebind through an owner mutation or rotate durable IDs.
    /// Claude remains unavailable until a matching current bound announcement.
    pub fn activate_registered_before(
        self: &Arc<Self>,
        scope: BindingScope,
        deadline: Instant,
    ) -> Result<(), CoreError> {
        within(deadline)?;
        if self.stopping.load(Ordering::Acquire) {
            return Err(unavailable());
        }
        let (session, binding) = self.current(&scope)?;
        if self
            .state
            .lock()
            .map_err(|_| unavailable())?
            .active
            .get(&scope.binding_id)
            .is_some_and(|active| active.generation == scope.generation)
        {
            return Ok(());
        }
        if binding.adapter_id == "claude_code_mod" {
            return self.announce_before(scope, deadline);
        }
        let params = BindingConnectParams {
            project_id: session.project_id().clone(),
            adapter_id: binding.adapter_id,
            external_session_id: binding.external_session_id,
            endpoint: binding.endpoint,
            configuration: binding.adapter_config,
            existing_session_id: Some(session.session_id().clone()),
        };
        let provider = self.providers.qualify_before(&params, deadline)?;
        self.runtime
            .block_on(self.activate(scope, provider, deadline))
    }
    /// Registry/catalogue locks are released by Core before this returns. The
    /// returned root is owned; callers may then perform provider IO safely.
    pub fn resolve_announcement(
        &self,
        scope: &BindingScope,
    ) -> Result<AnnouncementBinding, CoreError> {
        let (session, binding) = self.current(scope)?;
        let canonical_root = self.providers.project_root(session.project_id())?;
        Ok(AnnouncementBinding {
            binding_id: binding.id,
            session: SessionRef {
                project_id: session.project_id().clone(),
                session_id: session.session_id().clone(),
            },
            canonical_root,
            adapter_id: binding.adapter_id,
            external_session_id: binding.external_session_id,
            generation: binding.generation,
        })
    }
    /// Run only on the existing blocking control offload. Qualified ownership
    /// stays on this call's stack, and exact replay never reactivates a provider.
    pub fn bootstrap_before(
        self: &Arc<Self>,
        request: OwnerMutationRequest,
        deadline: Instant,
    ) -> Result<MutationReceipt, CoreError> {
        if request.session.is_some()
            || !matches!(request.command, OwnerCommand::BindingConnect { .. })
        {
            return Err(invalid(
                "Native bootstrap accepts only canonical registry BindingConnect.",
            ));
        }
        let mut qualified = None;
        let receipt = self.core.connect_before(
            OwnerContext::from_trusted_entrypoint(OwnerScope::Registry),
            request.command.clone(),
            deadline,
            |params, deadline| {
                if self.stopping.load(Ordering::Acquire) {
                    return Err(unavailable());
                }
                let provider = self.providers.qualify_before(params, deadline)?;
                let host = provider.host.clone();
                qualified = Some(provider);
                Ok(host)
            },
        )?;
        let Some(provider) = qualified else {
            return Ok(receipt);
        };
        let MutationReceipt::Session(saved) = &receipt else {
            return Err(invalid("Bootstrap returned a different receipt."));
        };
        let SavedReceiptData::BindingConnect {
            binding_id,
            generation,
            ..
        } = &saved.data
        else {
            return Err(invalid("Bootstrap returned a different saved operation."));
        };
        let scope = BindingScope {
            binding_id: binding_id.clone(),
            generation: generation.clone(),
        };
        // Claude must return its canonical receipt before the Mod can announce
        // actual B/G. Pre-ID evidence, including an older bound scope, is insufficient.
        if provider.host.adapter_id == "claude_code_mod" {
            return Ok(receipt);
        }
        if let Err(error) = self
            .runtime
            .block_on(self.activate(scope.clone(), provider, deadline))
        {
            (self.outcomes)(ActivationOutcome::Failed { scope, error });
        }
        // A committed receipt stays recoverable even if current activation fails.
        Ok(receipt)
    }
    /// A later bound announcement is a distinct operation with its own original
    /// control deadline. It never extends a still-serving bootstrap deadline.
    pub fn announce_before(
        self: &Arc<Self>,
        scope: BindingScope,
        deadline: Instant,
    ) -> Result<(), CoreError> {
        within(deadline)?;
        if self.stopping.load(Ordering::Acquire) {
            return Err(unavailable());
        }
        let (session, binding) = self.current(&scope)?;
        if binding.adapter_id != "claude_code_mod" {
            return Err(invalid(
                "Bound Mod activation requires the registered Claude provider.",
            ));
        }
        let active_slot = self
            .state
            .lock()
            .map_err(|_| unavailable())?
            .active
            .get(&scope.binding_id)
            .filter(|active| active.generation == scope.generation)
            .and_then(|active| active.claude_slot.clone());
        if let Some(slot) = active_slot {
            self.providers.refresh_bound_claude_before(
                session.project_id().clone(),
                &binding,
                slot,
                deadline,
            )?;
            return Ok(());
        }
        let provider = self.providers.qualify_bound_claude_before(
            session.project_id().clone(),
            &binding,
            deadline,
        )?;
        self.runtime
            .block_on(self.activate(scope, provider, deadline))
    }
    async fn activate(
        self: &Arc<Self>,
        scope: BindingScope,
        provider: QualifiedProvider,
        deadline: Instant,
    ) -> Result<(), CoreError> {
        within(deadline)?;
        self.current_async(scope.clone()).await?;
        if self
            .state
            .lock()
            .map_err(|_| unavailable())?
            .active
            .get(&scope.binding_id)
            .is_some_and(|active| active.generation == scope.generation)
        {
            return Ok(());
        }
        let _admission = self.admit(&scope)?;
        let previous = self
            .state
            .lock()
            .map_err(|_| unavailable())?
            .active
            .remove(&scope.binding_id);
        if let Some(mut previous) = previous {
            self.routes
                .remove_current(&scope.binding_id, &previous.generation)?;
            previous.handle.request_stop();
            let old_scope = BindingScope {
                binding_id: scope.binding_id.clone(),
                generation: previous.generation,
            };
            (self.outcomes)(ActivationOutcome::Stopped {
                scope: old_scope,
                exit: previous.handle.stop().await,
            });
        }
        within(deadline)?;
        let (session, binding) = self.current_async(scope.clone()).await?;
        if binding.endpoint_fingerprint != provider.host.endpoint_fingerprint {
            return Err(invalid(
                "Qualified provider differs from the canonical saved identity.",
            ));
        }
        let claude_slot = provider.claude_slot();
        let prepared = provider.into_adapter((self.providers.facts().next_id)())?;
        let connect = prepared.initial_connect;
        let connected = match ConnectedSupervisor::connect_before(
            self.core.clone(),
            prepared.adapter,
            session.clone(),
            binding,
            self.providers.facts().clone(),
            deadline,
            move |request| connect(request, deadline),
        )
        .await
        {
            Ok(connected) => connected,
            Err(failure) => {
                let cause = failure.cause.clone();
                (self.outcomes)(ActivationOutcome::ConnectFailed { scope, failure });
                return Err(cause);
            }
        };
        within(deadline)?;
        self.current_async(scope.clone()).await?;
        let owner = self.owner.clone();
        let selected = scope.clone();
        let lease = tokio::task::spawn_blocking(move || {
            within(deadline)?;
            owner.binding_lease_shared(session, selected.binding_id, selected.generation)
        })
        .await
        .map_err(|_| unavailable())??;
        if self.stopping.load(Ordering::Acquire) {
            return Err(unavailable());
        }
        let mut handle = connected.start(lease)?;
        let observed = handle.progress();
        let route = handle.control_binding();
        {
            let mut state = self.state.lock().map_err(|_| unavailable())?;
            if self.stopping.load(Ordering::Acquire) {
                handle.request_stop();
                return Err(unavailable());
            }
            state.active.insert(
                scope.binding_id.clone(),
                Active {
                    generation: scope.generation.clone(),
                    handle,
                    claude_slot,
                },
            );
            state.monitors.retain(|task| !task.is_finished());
            let activation = self.clone();
            state.monitors.push(self.runtime.spawn(async move {
                activation
                    .publish_when_reconciled(scope, observed, route)
                    .await;
            }));
        }
        Ok(())
    }
    async fn publish_when_reconciled(
        self: Arc<Self>,
        scope: BindingScope,
        mut progress: tokio::sync::watch::Receiver<crate::supervisor::SupervisorProgress>,
        route: (crate::leases::BindingLease, crate::supervisor::ClaimGate),
    ) {
        let mut published = false;
        loop {
            if !published && progress.borrow().reconciled {
                let result = self.current_async(scope.clone()).await.and_then(|_| {
                    let state = self.state.lock().map_err(|_| unavailable())?;
                    if self.stopping.load(Ordering::Acquire)
                        || !state
                            .active
                            .get(&scope.binding_id)
                            .is_some_and(|active| active.generation == scope.generation)
                    {
                        return Err(unavailable());
                    }
                    self.routes.install(route.0.clone(), route.1.clone())
                });
                if let Err(error) = result {
                    (self.outcomes)(ActivationOutcome::Failed {
                        scope: scope.clone(),
                        error,
                    });
                    break;
                }
                published = true;
            }
            if progress.changed().await.is_err() {
                break;
            }
        }
        let _ = self
            .routes
            .remove_current(&scope.binding_id, &scope.generation);
        let active = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            if state
                .active
                .get(&scope.binding_id)
                .is_some_and(|active| active.generation == scope.generation)
            {
                state.active.remove(&scope.binding_id)
            } else {
                None
            }
        };
        if let Some(active) = active {
            (self.outcomes)(ActivationOutcome::Stopped {
                scope,
                exit: active.handle.stop().await,
            });
        }
    }
    /// Explicit Quit fences admission, removes routes and awaits actual workers.
    /// It does not persist a domain disconnect, rotate generations or stop hosts.
    pub async fn shutdown(&self) -> Result<(), CoreError> {
        self.stopping.store(true, Ordering::Release);
        self.routes.close()?;
        let (active, monitors) = {
            let mut state = self.state.lock().map_err(|_| unavailable())?;
            (
                std::mem::take(&mut state.active),
                std::mem::take(&mut state.monitors),
            )
        };
        for (binding_id, mut active) in active {
            active.handle.request_stop();
            let scope = BindingScope {
                binding_id,
                generation: active.generation,
            };
            (self.outcomes)(ActivationOutcome::Stopped {
                scope,
                exit: active.handle.stop().await,
            });
        }
        for monitor in monitors {
            monitor.await.map_err(|_| unavailable())?;
        }
        Ok(())
    }
    fn current(&self, scope: &BindingScope) -> Result<(RegisteredSession, Binding), CoreError> {
        current_binding(&self.core, scope)
    }
    async fn current_async(
        self: &Arc<Self>,
        scope: BindingScope,
    ) -> Result<(RegisteredSession, Binding), CoreError> {
        let activation = self.clone();
        tokio::task::spawn_blocking(move || activation.current(&scope))
            .await
            .map_err(|_| unavailable())?
    }
    fn admit(&self, scope: &BindingScope) -> Result<Admission<'_>, CoreError> {
        let mut state = self.state.lock().map_err(|_| unavailable())?;
        if self.stopping.load(Ordering::Acquire)
            || state.active.len() + state.admitting.len() >= 256
            || !state.admitting.insert(scope.binding_id.clone())
        {
            return Err(unavailable());
        }
        Ok(Admission {
            activation: self,
            binding_id: scope.binding_id.clone(),
        })
    }
}
struct Admission<'a> {
    activation: &'a NativeActivation,
    binding_id: UuidV4,
}
impl Drop for Admission<'_> {
    fn drop(&mut self) {
        self.activation
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .admitting
            .remove(&self.binding_id);
    }
}
fn unavailable() -> CoreError {
    CoreError::new(CoreErrorCode::HostUnreachable, "Native activation is busy, stopping or unavailable.",
        "Keep original routing and operation IDs; reconcile existing facts before a deliberate retry.")
}
fn invalid(message: &str) -> CoreError {
    CoreError::new(
        CoreErrorCode::BindingMismatch,
        message,
        "Use the canonical registered provider and saved binding generation.",
    )
}

fn current_binding(
    core: &NativeCoreService,
    scope: &BindingScope,
) -> Result<(RegisteredSession, Binding), CoreError> {
    let resolved = AgentResolver::resolve(
        core.registry(),
        scope.binding_id.clone(),
        scope.generation.clone(),
        None,
        None,
    )?;
    let session = resolved.session().clone();
    let context = QueryContext::owner(OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        session.clone(),
    )));
    let request = QueryRequest::SessionGet {};
    let result = core.query(context.clone(), request.clone())?;
    result.validate_for(&context, &request)?;
    let QueryResult::SessionGet(snapshot) = result else {
        return Err(invalid("Activation read returned a different projection."));
    };
    if snapshot.session.active_binding_id.as_ref() != Some(&scope.binding_id) {
        return Err(invalid(
            "Activation does not target the authoritative selected binding.",
        ));
    }
    let binding = snapshot
        .session
        .bindings
        .0
        .get(&scope.binding_id)
        .ok_or_else(|| invalid("Activation binding is missing."))?
        .clone();
    if binding.generation != scope.generation {
        return Err(CoreError::new(
            CoreErrorCode::StaleGeneration,
            "Activation generation changed.",
            "Retain the original scope; qualify the explicitly selected current generation.",
        ));
    }
    if ariadne_core::lifecycle::claude_generation_ended(
        &snapshot.session,
        &scope.binding_id,
        &scope.generation,
    ) {
        return Err(CoreError::new(
            CoreErrorCode::HostUnreachable,
            "The original Claude session ended for this binding generation.",
            "Retain original reports; a new explicit connect must select a new generation.",
        ));
    }
    Ok((session, binding))
}

/// Resolve actual registration before provider IO without a runtime/Discovery
/// reference cycle. Roots and Core are the same trusted composition dependencies.
pub fn registered_announcement_resolver(
    core: Arc<NativeCoreService>,
    roots: Arc<crate::providers::ProjectRootResolver>,
) -> Arc<crate::discovery::BindingResolver> {
    Arc::new(move |scope| {
        let (session, binding) = current_binding(&core, scope)?;
        let canonical_root = roots(session.project_id())?;
        Ok(AnnouncementBinding {
            binding_id: binding.id,
            session: SessionRef {
                project_id: session.project_id().clone(),
                session_id: session.session_id().clone(),
            },
            canonical_root,
            adapter_id: binding.adapter_id,
            external_session_id: binding.external_session_id,
            generation: binding.generation,
        })
    })
}
