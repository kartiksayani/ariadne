use super::{
    expiry::ResultExpiry, health::HealthHub, installed_codex_rules, instructions,
    presence::PresenceCache, CoreBridge,
};
use crate::watchers::RegisteredWatcher;
use ariadne_adapter_claude::ClaudeOptions;
use ariadne_adapter_codex::CodexOptions;
use ariadne_core::{native::NativeCoreService, *};
use ariadne_domain::models::*;
use ariadne_runtime::{
    activation::{registered_announcement_resolver, ActivationOutcome, NativeActivation},
    control::{BindingScope, ControlRoutes, ControlServer},
    discovery::{CodexEndpoint, Discovery, DiscoveryPoller, DiscoverySnapshot},
    health::{SupervisorHealth, HEARTBEAT},
    leases::DesktopOwner,
    logging,
    providers::{ProjectRootResolver, ProviderFactory},
    supervisor::NativeFacts,
};
use ariadne_store::registry::Registry;
use std::{
    cell::Cell,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
thread_local! { static OWNED_BRIDGE: Cell<bool> = const { Cell::new(false) }; }
struct OwnedBridgeGuard(bool);
impl Drop for OwnedBridgeGuard {
    fn drop(&mut self) {
        OWNED_BRIDGE.with(|owned| owned.set(self.0));
    }
}

/// Explicit installed paths. No PATH probing or provider credential/config reads.
pub struct NativeConfiguration {
    pub home: PathBuf,
    pub claude: Option<ClaudeOptions>,
    pub codex: Option<CodexOptions>,
    pub discovery_endpoints: Vec<CodexEndpoint>,
    /// Exact shell prefix for the Ariadne CLI named in saved setup instructions.
    pub cli_invocation: String,
}
struct Workers {
    executor: tokio::runtime::Runtime,
    activation: Arc<NativeActivation>,
    poller: DiscoveryPoller,
    control_stop: tokio::sync::oneshot::Sender<()>,
    control: tokio::task::JoinHandle<Result<(), CoreError>>,
    owner: Arc<DesktopOwner>,
    providers: ProviderFactory,
    routes: ControlRoutes,
    outcomes: Arc<dyn Fn(ActivationOutcome) + Send + Sync>,
    watcher: RegisteredWatcher,
    presence_stop: Option<tokio::sync::oneshot::Sender<()>>,
    presence_task: Option<tokio::task::JoinHandle<()>>,
    admitted: Vec<tokio::task::JoinHandle<()>>,
}
pub struct NativeRuntime {
    core: Arc<NativeCoreService>,
    discovery: Discovery,
    workers: Mutex<Option<Workers>>,
    shutdown_gate: Mutex<()>,
    stopping: AtomicBool,
    replacing: AtomicBool,
    presence: Arc<PresenceCache>,
    expiry: Arc<ResultExpiry>,
    reconciliation_errors: Mutex<Vec<CoreError>>,
    /// Configured Codex app-server socket, offered as the connect dialog default.
    codex_socket: Option<String>,
    health: Arc<HealthHub>,
}
impl NativeRuntime {
    pub fn codex_default_socket(&self) -> Option<String> {
        self.codex_socket.clone()
    }
    /// Latest health per push-delivery (Codex) binding.
    pub fn supervisor_health(&self) -> Vec<SupervisorHealth> {
        self.health.snapshot()
    }
    /// Installs the renderer event sink for later health changes.
    pub fn set_supervisor_health_emitter(&self, emit: Arc<dyn Fn(SupervisorHealth) + Send + Sync>) {
        self.health.set_emitter(emit);
    }
    /// Blocking startup, after single-instance interception and off the UI thread.
    /// The one actual owner is acquired before any Core/provider worker starts.
    pub fn start(
        config: NativeConfiguration,
        outcomes: Arc<dyn Fn(ActivationOutcome) + Send + Sync>,
        emit: Arc<dyn Fn(SessionChangedHint) -> bool + Send + Sync>,
    ) -> Result<Arc<Self>, CoreError> {
        Self::start_with_presence(config, outcomes, emit, Arc::new(|_| true))
    }
    pub fn start_with_presence(
        config: NativeConfiguration,
        outcomes: Arc<dyn Fn(ActivationOutcome) + Send + Sync>,
        emit: Arc<dyn Fn(SessionChangedHint) -> bool + Send + Sync>,
        presence: Arc<dyn Fn(PresenceChangedHint) -> bool + Send + Sync>,
    ) -> Result<Arc<Self>, CoreError> {
        Self::start_with_presence_and_refresh(config, outcomes, emit, presence, Arc::new(|| {}))
    }
    pub(crate) fn start_with_presence_and_refresh(
        config: NativeConfiguration,
        outcomes: Arc<dyn Fn(ActivationOutcome) + Send + Sync>,
        emit: Arc<dyn Fn(SessionChangedHint) -> bool + Send + Sync>,
        presence: Arc<dyn Fn(PresenceChangedHint) -> bool + Send + Sync>,
        reconciled: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Arc<Self>, CoreError> {
        std::thread::spawn(move || {
            Self::start_off_executor(config, outcomes, emit, presence, reconciled)
        })
        .join()
        .map_err(|_| unavailable())?
    }
    fn start_off_executor(
        config: NativeConfiguration,
        outcomes: Arc<dyn Fn(ActivationOutcome) + Send + Sync>,
        emit: Arc<dyn Fn(SessionChangedHint) -> bool + Send + Sync>,
        presence_emit: Arc<dyn Fn(PresenceChangedHint) -> bool + Send + Sync>,
        reconciled: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Arc<Self>, CoreError> {
        if let Err(error) = logging::init(&config.home) {
            eprintln!("Ariadne could not open its log file: {:?}.", error.kind());
        }
        let health = HealthHub::new(Some(&config.home));
        let outcomes: Arc<dyn Fn(ActivationOutcome) + Send + Sync> = {
            let health = health.clone();
            Arc::new(move |outcome| {
                health.observe_outcome(&outcome);
                outcomes(outcome)
            })
        };
        let codex_socket = config.discovery_endpoints.first().and_then(|configured| {
            let path = configured
                .options
                .endpoint_path(&configured.endpoint)
                .ok()?;
            path.to_str().map(str::to_owned)
        });
        let owner = Arc::new(DesktopOwner::acquire(&config.home)?);
        let core = Arc::new(NativeCoreService::new(
            Registry::create_data_directory(&config.home)?,
            next_id,
            now,
            |_| Err(unavailable()),
        ));
        let root_core = core.clone();
        let roots: Arc<ProjectRootResolver> = Arc::new(move |project| {
            root_core
                .registry()
                .resolve_project(project)
                .map(|registered| registered.root)
                .map_err(CoreError::from)
        });
        let discovery = Discovery::new(
            Arc::new(now),
            Some(registered_announcement_resolver(
                core.clone(),
                roots.clone(),
            )),
        );
        let codex_rules = installed_codex_rules(std::env::var_os("HOME").map(PathBuf::from));
        let instructions = instructions(&config.cli_invocation, codex_rules.as_deref());
        let providers = ProviderFactory::new(
            roots,
            discovery.clone(),
            config.claude,
            config.codex,
            NativeFacts {
                next_id: Arc::new(next_id),
                now: Arc::new(now),
            },
            instructions,
        );
        let executor = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|_| unavailable())?;
        let routes = ControlRoutes::new();
        let presence = PresenceCache::new(core.clone(), presence_emit);
        let expiry = ResultExpiry::new(core.clone());
        let activation = NativeActivation::new_with_observers(
            core.clone(),
            providers.clone(),
            owner.clone(),
            routes.clone(),
            executor.handle().clone(),
            outcomes.clone(),
            Some(presence.observer()),
            Some(health.observer()),
        );
        let runtime = Arc::new(Self {
            core: core.clone(),
            discovery: discovery.clone(),
            workers: Mutex::new(None),
            shutdown_gate: Mutex::new(()),
            stopping: AtomicBool::new(false),
            replacing: AtomicBool::new(false),
            presence: presence.clone(),
            expiry: expiry.clone(),
            reconciliation_errors: Mutex::new(Vec::new()),
            codex_socket,
            health: health.clone(),
        });
        let connect_runtime = Arc::downgrade(&runtime);
        let announcement_runtime = Arc::downgrade(&runtime);
        let server = ControlServer::bind_shared(owner.clone(), Arc::new(runtime.bridge()), vec![])?
            .with_routes(routes.clone())
            .with_discovery(discovery.clone())
            .with_native_connect(Arc::new(move |request, deadline| {
                connect_runtime
                    .upgrade()
                    .ok_or_else(unavailable)?
                    .connect_before(request, deadline)
            }))
            .with_native_announcement(Arc::new(move |scope, deadline| {
                announcement_runtime
                    .upgrade()
                    .ok_or_else(unavailable)?
                    .announce_before(scope, deadline)
            }));
        let poller = {
            let _entered = executor.enter();
            DiscoveryPoller::start(discovery.clone(), config.discovery_endpoints)?
        };
        let changed = expiry.clone();
        let watcher = RegisteredWatcher::start_with_reconciled(
            Registry::open_data_directory(&config.home)?,
            config.home,
            move |hint| {
                changed.changed(hint.session_id.clone());
                emit(hint)
            },
            reconciled,
        )
        .map_err(|_| unavailable())?;
        let (control_stop, stopped) = tokio::sync::oneshot::channel();
        let control = executor.spawn(server.serve(stopped));
        let (presence_stop, presence_task) = start_timer(&executor, presence, expiry, health);
        *runtime.workers.lock().map_err(|_| unavailable())? = Some(Workers {
            executor,
            activation,
            poller,
            control_stop,
            control,
            owner,
            providers,
            routes,
            outcomes,
            watcher,
            presence_stop,
            presence_task,
            admitted: Vec::new(),
        });
        Ok(runtime)
    }
    pub fn bridge(self: &Arc<Self>) -> CoreBridge {
        CoreBridge::new(self.core.clone(), Arc::downgrade(self))
    }
    pub(super) fn overlay_presence(&self, result: &mut QueryResult) {
        self.presence.overlay(result);
    }
    pub(super) fn recovery_observation(
        &self,
        context: &OwnerContext,
        command: &OwnerCommand,
    ) -> Option<ariadne_core::recovery::RecoveryObservation> {
        self.presence.recovery_observation(context, command)
    }
    pub(super) fn run_owned<T: Send + 'static>(
        &self,
        disconnected: CoreError,
        work: impl FnOnce() -> Result<T, CoreError> + Send + 'static,
    ) -> Result<T, CoreError> {
        if OWNED_BRIDGE.with(Cell::get) {
            return work();
        }
        self.run_owned_admitted(
            disconnected,
            |_| {
                if self.stopping.load(Ordering::Acquire) || self.replacing.load(Ordering::Acquire) {
                    Err(unavailable())
                } else {
                    Ok(())
                }
            },
            work,
        )
    }
    fn run_owned_admitted<T: Send + 'static>(
        &self,
        disconnected: CoreError,
        admit: impl FnOnce(&mut Workers) -> Result<(), CoreError>,
        work: impl FnOnce() -> Result<T, CoreError> + Send + 'static,
    ) -> Result<T, CoreError> {
        let (sent, received) = std::sync::mpsc::sync_channel(1);
        {
            let mut workers = self.workers.lock().map_err(|_| unavailable())?;
            let workers = workers.as_mut().ok_or_else(unavailable)?;
            admit(workers)?;
            // Scheduling under the admission lock makes executor shutdown wait
            // for this actual closure. The lock ends before Core/provider IO.
            workers.admitted.retain(|task| !task.is_finished());
            let task = workers.executor.spawn_blocking(move || {
                let _owned = OwnedBridgeGuard(OWNED_BRIDGE.with(|owned| owned.replace(true)));
                let result = work();
                let _ = sent.send(result);
            });
            workers.admitted.push(task);
        }
        // Core owns replay/persistence authority. An outer deadline could hide
        // a receipt already committed by this admitted worker, including exact
        // replay admitted after the provider deadline. Only provider IO uses
        // that original deadline; filesystem completion is not wall-clock bound.
        received.recv().map_err(|_| disconnected)?
    }
    pub(super) fn native_preferences_write(
        &self,
        request: &OwnerMutationRequest,
    ) -> Result<PreferencesPatchedReceipt, CoreError> {
        let core = self.core.clone();
        let original = request.clone();
        self.native_preferences_owned(request, move || {
            match core.execute_owner(
                OwnerContext::from_trusted_entrypoint(OwnerScope::Preferences),
                original.command,
            )? {
                MutationReceipt::PreferencesPatched(receipt) => Ok(receipt),
                _ => Err(uncertain()),
            }
        })
    }
    pub(super) fn native_preferences_read(&self) -> Result<PreferencesSnapshot, CoreError> {
        let core = self.core.clone();
        self.run_native_preferences(unavailable(), move || {
            match core.query(
                QueryContext::owner(OwnerContext::from_trusted_entrypoint(
                    OwnerScope::Preferences,
                )),
                QueryRequest::PreferencesGet {},
            )? {
                QueryResult::PreferencesGet(snapshot) => Ok(snapshot),
                _ => Err(unavailable()),
            }
        })
    }
    pub(super) fn native_preferences_owned(
        &self,
        request: &OwnerMutationRequest,
        work: impl FnOnce() -> Result<PreferencesPatchedReceipt, CoreError> + Send + 'static,
    ) -> Result<PreferencesPatchedReceipt, CoreError> {
        request.validate_wire()?;
        let OwnerCommand::PreferencesPatch { .. } = &request.command else {
            return Err(unavailable());
        };
        if request.session.is_some() {
            return Err(unavailable());
        }
        let original = request.clone();
        self.run_native_preferences(uncertain(), move || {
            let receipt = work()?;
            validate_owner_receipt(
                &original,
                &MutationReceipt::PreferencesPatched(receipt.clone()),
            )?;
            Ok(receipt)
        })
    }
    fn run_native_preferences<T: Send + 'static>(
        &self,
        disconnected: CoreError,
        work: impl FnOnce() -> Result<T, CoreError> + Send + 'static,
    ) -> Result<T, CoreError> {
        // Only a Quit confirmation waits for the lifecycle gate. An ordinary
        // admitted preference closure must not wait on a wake that drains it.
        let _drain = if self.stopping.load(Ordering::Acquire) {
            Some(self.shutdown_gate.lock().map_err(|_| unavailable())?)
        } else {
            None
        };
        self.run_owned_admitted(
            disconnected,
            |_| {
                let stopped = self.stopping.load(Ordering::Acquire);
                if self.replacing.load(Ordering::Acquire) && !stopped {
                    return Err(unavailable());
                }
                // Only the fenced native preference producers possess this
                // private callback. They own queued/frozen saves and exact
                // retries; renderer/control/provider paths cannot call it.
                Ok(())
            },
            work,
        )
    }
    pub(super) fn spawn_reconciliation(&self, runtime: Arc<Self>) {
        let mut workers = self
            .workers
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.stopping.load(Ordering::Acquire) || self.replacing.load(Ordering::Acquire) {
            return;
        }
        if let Some(workers) = workers.as_mut() {
            workers.admitted.retain(|task| !task.is_finished());
            let task = workers.executor.spawn_blocking(move || {
                let _owned = OwnedBridgeGuard(OWNED_BRIDGE.with(|owned| owned.replace(true)));
                if let Err(error) = runtime.reconcile() {
                    logging::error(
                        "runtime",
                        &format!("Persisted binding reconciliation failed: {:?}.", error.code),
                    );
                    eprintln!(
                        "Ariadne persisted binding reconciliation remains unavailable: {:?}.",
                        error.code
                    );
                }
            });
            workers.admitted.push(task);
        }
    }
    pub fn take_reconciliation_errors(&self) -> Vec<CoreError> {
        std::mem::take(
            &mut *self
                .reconciliation_errors
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        )
    }
    pub(super) fn reconciliation_diagnostics(&self) -> Vec<String> {
        self.reconciliation_errors
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .rev()
            .take(16)
            .map(|error| error.message.clone())
            .collect()
    }
    #[cfg(test)]
    pub(super) fn expiry_for_test(&self) -> &Arc<ResultExpiry> {
        &self.expiry
    }
    #[cfg(test)]
    pub(super) fn executor_for_test(&self) -> tokio::runtime::Handle {
        self.workers
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .executor
            .handle()
            .clone()
    }
    #[cfg(test)]
    pub(super) fn lease_for_test(
        &self,
        route: &SessionRef,
        scope: BindingScope,
    ) -> ariadne_runtime::leases::BindingLease {
        let owner = self.workers.lock().unwrap().as_ref().unwrap().owner.clone();
        owner
            .binding_lease_shared(
                self.core.resolve_session(route).unwrap(),
                scope.binding_id,
                scope.generation,
            )
            .unwrap()
    }
    pub fn discovery(&self) -> Result<DiscoverySnapshot, CoreError> {
        self.discovery.snapshot()
    }
    pub fn set_connection_ui_open(&self, open: bool) -> Result<(), CoreError> {
        let workers = self.workers.lock().map_err(|_| unavailable())?;
        workers
            .as_ref()
            .ok_or_else(unavailable)?
            .poller
            .set_connection_ui_open(open);
        Ok(())
    }
    pub fn select(&self, route: Option<SessionRef>) -> Result<(), CoreError> {
        if let Some(route) = &route {
            self.core.resolve_session(route)?;
        }
        let workers = self.workers.lock().map_err(|_| unavailable())?;
        workers
            .as_ref()
            .ok_or_else(unavailable)?
            .watcher
            .select(route);
        Ok(())
    }
    pub fn refresh_snapshots(&self) -> Result<(), CoreError> {
        let workers = self.workers.lock().map_err(|_| unavailable())?;
        workers
            .as_ref()
            .ok_or_else(unavailable)?
            .watcher
            .reconcile();
        Ok(())
    }
    pub(crate) fn connect_before(
        &self,
        request: OwnerMutationRequest,
        deadline: Instant,
    ) -> Result<MutationReceipt, CoreError> {
        let activation = self.activation()?;
        self.run_owned(uncertain(), move || {
            activation.bootstrap_before(request, deadline)
        })
    }
    fn announce_before(&self, scope: BindingScope, deadline: Instant) -> Result<(), CoreError> {
        let activation = self.activation()?;
        self.run_owned(unavailable(), move || {
            activation.announce_before(scope, deadline)
        })
    }
    fn activation(&self) -> Result<Arc<NativeActivation>, CoreError> {
        if self.stopping.load(Ordering::Acquire) || self.replacing.load(Ordering::Acquire) {
            return Err(unavailable());
        }
        let workers = self.workers.lock().map_err(|_| unavailable())?;
        if self.stopping.load(Ordering::Acquire) || self.replacing.load(Ordering::Acquire) {
            return Err(unavailable());
        }
        workers
            .as_ref()
            .map(|workers| workers.activation.clone())
            .ok_or_else(unavailable)
    }
    /// Blocking startup/wake reconciliation of current persisted selected IDs.
    /// A failed provider remains unavailable; no rebind/resume/receipt is created.
    pub fn reconcile(&self) -> Result<(), CoreError> {
        let activation = self.activation()?;
        let outcomes = self
            .workers
            .lock()
            .map_err(|_| unavailable())?
            .as_ref()
            .ok_or_else(unavailable)?
            .outcomes
            .clone();
        let catalogue = self.core.registry().catalogue()?;
        let mut first_error = None;
        for project in catalogue.projects {
            let sessions = project
                .result
                .map_err(CoreError::from)
                .and_then(|catalogue| catalogue.sessions.map_err(CoreError::from));
            match sessions {
                Err(error) => {
                    self.reconciliation_errors
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .push(error.clone());
                    first_error.get_or_insert(error);
                }
                Ok(sessions) => {
                    for read in sessions {
                        match read.result.map_err(CoreError::from) {
                            Err(error) => {
                                self.reconciliation_errors
                                    .lock()
                                    .unwrap_or_else(|error| error.into_inner())
                                    .push(error.clone());
                                first_error.get_or_insert(error);
                            }
                            Ok(session) => {
                                if let Some(id) = session.active_binding_id {
                                    if let Some(binding) = session.bindings.0.get(&id) {
                                        let deadline = Instant::now()
                                            + ariadne_runtime::control::CONTROL_TIMEOUT;
                                        let scope = BindingScope {
                                            binding_id: id,
                                            generation: binding.generation.clone(),
                                        };
                                        let result = activation
                                            .activate_registered_before(scope.clone(), deadline);
                                        if let Err(error) = result {
                                            (outcomes)(ActivationOutcome::Failed {
                                                scope,
                                                error: error.clone(),
                                            });
                                            first_error.get_or_insert(error);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
    pub fn reconcile_after_wake(&self) -> Result<(), CoreError> {
        {
            let workers = self.workers.lock().map_err(|_| unavailable())?;
            if self.stopping.load(Ordering::Acquire) || self.replacing.swap(true, Ordering::AcqRel)
            {
                return Err(unavailable());
            }
            if let Some(workers) = workers.as_ref() {
                workers.activation.stop_admission()?;
            }
        }
        let _lifecycle = self.shutdown_gate.lock().map_err(|_| unavailable())?;
        let result = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let mut workers = self
                        .workers
                        .lock()
                        .map_err(|_| unavailable())?
                        .take()
                        .ok_or_else(unavailable)?;
                    self.presence.fence();
                    self.expiry.fence();
                    // No admission can join this set after the fence. Actual
                    // started work must return before its activation is replaced.
                    // Neither the workers mutex nor any cache lock spans IO/wait.
                    let result = (|| {
                        workers.executor.block_on(async {
                            if let Some(stop) = workers.presence_stop.take() {
                                let _ = stop.send(());
                            }
                            if let Some(task) = workers.presence_task.take() {
                                task.await.map_err(|_| unavailable())?;
                            }
                            let mut result = Ok(());
                            for task in std::mem::take(&mut workers.admitted) {
                                result = result.and(task.await.map_err(|_| unavailable()));
                            }
                            result.and(workers.activation.shutdown().await)
                        })?;
                        workers.poller.refresh_after_wake()?;
                        workers.watcher.reconcile();
                        Ok(())
                    })();
                    let mut published = self.workers.lock().map_err(|_| unavailable())?;
                    let result = if self.stopping.load(Ordering::Acquire) {
                        Err(unavailable())
                    } else {
                        result
                    };
                    if result.is_ok() {
                        workers.activation = NativeActivation::new_with_observers(
                            self.core.clone(),
                            workers.providers.clone(),
                            workers.owner.clone(),
                            workers.routes.clone(),
                            workers.executor.handle().clone(),
                            workers.outcomes.clone(),
                            Some(self.presence.observer()),
                            Some(self.health.observer()),
                        );
                        self.presence.reopen();
                        self.expiry.reopen();
                        (workers.presence_stop, workers.presence_task) = start_timer(
                            &workers.executor,
                            self.presence.clone(),
                            self.expiry.clone(),
                            self.health.clone(),
                        );
                    }
                    // Even a failed refresh retains the owner and stopped
                    // activation for a subsequent explicit lifecycle action.
                    *published = Some(workers);
                    result
                })
                .join()
                .map_err(|_| unavailable())?
        });
        self.replacing.store(false, Ordering::Release);
        result?;
        self.reconcile()
    }
    /// Explicit Quit only, off UI and outside any Tokio execution context.
    /// Await supervisors and scans, stop control, then await admitted blocking IO
    /// by dropping this owned executor. Dropping only ControlServer's JoinSet
    /// would leave started blocking calls retaining the physical owner/leases.
    pub fn shutdown(&self) -> Result<(), CoreError> {
        self.begin_shutdown()?;
        let _shutdown = self.shutdown_gate.lock().map_err(|_| unavailable())?;
        self.presence.stop();
        let workers = self.workers.lock().map_err(|_| unavailable())?.take();
        let Some(workers) = workers else {
            return Ok(());
        };
        // Tauri's blocking pool may still carry an entered Tokio handle. A
        // dedicated joined thread makes executor destruction safe there too.
        std::thread::spawn(move || workers.shutdown())
            .join()
            .map_err(|_| unavailable())?
    }
    /// Pure admission fence, before any window/tray drain or lifecycle wait.
    pub(crate) fn begin_shutdown(&self) -> Result<(), CoreError> {
        // Quit wins before waiting for wake's lifecycle gate. Its flag and
        // wake publication are serialized by the short admission lock.
        let workers = self.workers.lock().map_err(|_| unavailable())?;
        self.stopping.store(true, Ordering::Release);
        self.expiry.fence();
        if let Some(workers) = workers.as_ref() {
            workers.activation.stop_admission()?;
        }
        Ok(())
    }
}
impl Drop for NativeRuntime {
    fn drop(&mut self) {
        // An unexpected last weak-callback owner can disappear on this runtime's
        // own IO pool. It must return before that pool can be drained. Normal Quit
        // already joined shutdown; this fallback transfers real ownership to a
        // draining thread rather than dropping a runtime inside its own task.
        if tokio::runtime::Handle::try_current().is_ok() {
            if let Some(workers) = self
                .workers
                .get_mut()
                .unwrap_or_else(|poison| poison.into_inner())
                .take()
            {
                std::thread::spawn(move || {
                    let _ = workers.shutdown();
                });
            }
        } else {
            let _ = self.shutdown();
        }
    }
}
impl Workers {
    fn shutdown(self) -> Result<(), CoreError> {
        let Workers {
            executor,
            activation,
            poller,
            control_stop,
            control,
            owner,
            watcher,
            presence_stop,
            presence_task,
            ..
        } = self;
        let activation_result = executor.block_on(activation.shutdown());
        let _ = control_stop.send(());
        let control_result = executor
            .block_on(control)
            .map_err(|_| unavailable())
            .and_then(|result| result);
        let poller_result = executor.block_on(poller.stop());
        if let Some(stop) = presence_stop {
            let _ = stop.send(());
        }
        let presence_result = presence_task.map_or(Ok(()), |task| {
            executor.block_on(task).map_err(|_| unavailable())
        });
        drop(watcher);
        drop(activation);
        drop(executor);
        drop(owner);
        activation_result
            .and(control_result)
            .and(poller_result)
            .and(presence_result)
    }
}
pub(super) fn unavailable() -> CoreError {
    CoreError::new(
        CoreErrorCode::HostUnreachable,
        "The desktop owning runtime is unavailable or shutting down.",
        "Retain original operation and routing IDs; check saved receipts before repeating setup.",
    )
}
pub(super) fn uncertain() -> CoreError {
    CoreError::new(CoreErrorCode::CommitUncertain,
        "The admitted desktop worker stopped before returning its authoritative receipt.",
        "Retain the original operation ID and contents; reconcile its saved receipt before any new operation.")
}
pub(super) fn next_id() -> UuidV4 {
    UuidV4::new(uuid::Uuid::new_v4().to_string()).expect("native UUIDv4")
}

fn start_timer(
    executor: &tokio::runtime::Runtime,
    presence: Arc<PresenceCache>,
    expiry: Arc<ResultExpiry>,
    health: Arc<HealthHub>,
) -> (
    Option<tokio::sync::oneshot::Sender<()>>,
    Option<tokio::task::JoinHandle<()>>,
) {
    let (stop, mut stopped) = tokio::sync::oneshot::channel();
    let task = executor.spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
        let mut ticks: u64 = 0;
        loop {
            tokio::select! {
                biased;
                _ = &mut stopped => break,
                _ = tick.tick() => {
                    let cache = presence.clone();
                    let expiry = expiry.clone();
                    // The doctor reads this heartbeat to tell whether the app runs.
                    let heartbeat = ticks.is_multiple_of(HEARTBEAT.as_secs()).then(|| health.clone());
                    ticks = ticks.wrapping_add(1);
                    // Both sweeps stay off UI; actual blocking work is awaited
                    // before wake replacement or shutdown can finish the timer.
                    let _ = tokio::task::spawn_blocking(move || {
                        cache.sweep();
                        expiry.sweep();
                        if let Some(health) = heartbeat {
                            health.heartbeat();
                        }
                    }).await;
                }
            }
        }
    });
    (Some(stop), Some(task))
}
pub(super) fn now() -> UtcMillis {
    UtcMillis::new(
        chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    )
    .expect("native UTC clock")
}

#[cfg(test)]
#[path = "tests/recovery.rs"]
mod recovery_tests;
