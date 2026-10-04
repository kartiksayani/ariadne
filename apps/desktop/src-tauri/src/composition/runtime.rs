use super::{instructions, presence::PresenceCache, CoreBridge};
use crate::watchers::RegisteredWatcher;
use ariadne_adapter_claude::ClaudeOptions;
use ariadne_adapter_codex::CodexOptions;
use ariadne_core::{native::NativeCoreService, *};
use ariadne_domain::models::*;
use ariadne_runtime::{
    activation::{registered_announcement_resolver, ActivationOutcome, NativeActivation},
    control::{BindingScope, ControlRoutes, ControlServer},
    discovery::{CodexEndpoint, Discovery, DiscoveryPoller, DiscoverySnapshot},
    leases::DesktopOwner,
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
    presence_stop: tokio::sync::oneshot::Sender<()>,
    presence_task: tokio::task::JoinHandle<()>,
}
pub struct NativeRuntime {
    core: Arc<NativeCoreService>,
    discovery: Discovery,
    workers: Mutex<Option<Workers>>,
    shutdown_gate: Mutex<()>,
    stopping: AtomicBool,
    replacing: AtomicBool,
    presence: Arc<PresenceCache>,
    reconciliation_errors: Mutex<Vec<CoreError>>,
}
impl NativeRuntime {
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
        std::thread::spawn(move || Self::start_off_executor(config, outcomes, emit, presence))
            .join()
            .map_err(|_| unavailable())?
    }
    fn start_off_executor(
        config: NativeConfiguration,
        outcomes: Arc<dyn Fn(ActivationOutcome) + Send + Sync>,
        emit: Arc<dyn Fn(SessionChangedHint) -> bool + Send + Sync>,
        presence_emit: Arc<dyn Fn(PresenceChangedHint) -> bool + Send + Sync>,
    ) -> Result<Arc<Self>, CoreError> {
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
        let providers = ProviderFactory::new(
            roots,
            discovery.clone(),
            config.claude,
            config.codex,
            NativeFacts {
                next_id: Arc::new(next_id),
                now: Arc::new(now),
            },
            instructions(),
        );
        let executor = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|_| unavailable())?;
        let routes = ControlRoutes::new();
        let presence = PresenceCache::new(core.clone(), presence_emit);
        let activation = NativeActivation::new_with_presence(
            core.clone(),
            providers.clone(),
            owner.clone(),
            routes.clone(),
            executor.handle().clone(),
            outcomes.clone(),
            Some(presence.observer()),
        );
        let runtime = Arc::new(Self {
            core: core.clone(),
            discovery: discovery.clone(),
            workers: Mutex::new(None),
            shutdown_gate: Mutex::new(()),
            stopping: AtomicBool::new(false),
            replacing: AtomicBool::new(false),
            presence: presence.clone(),
            reconciliation_errors: Mutex::new(Vec::new()),
        });
        let connect_runtime = Arc::downgrade(&runtime);
        let announcement_runtime = Arc::downgrade(&runtime);
        let server = ControlServer::bind_shared(owner.clone(), core.clone(), vec![])?
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
                    .activation()?
                    .announce_before(scope, deadline)
            }));
        let poller = {
            let _entered = executor.enter();
            DiscoveryPoller::start(discovery.clone(), config.discovery_endpoints)?
        };
        let watcher = RegisteredWatcher::start(
            Registry::open_data_directory(&config.home)?,
            config.home,
            move |hint| emit(hint),
        )
        .map_err(|_| unavailable())?;
        let (control_stop, stopped) = tokio::sync::oneshot::channel();
        let control = executor.spawn(server.serve(stopped));
        let (presence_stop, mut stopped) = tokio::sync::oneshot::channel();
        let presence_task = executor.spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
            loop {
                tokio::select! {
                    biased;
                    _ = &mut stopped => break,
                    _ = tick.tick() => {
                        let cache = presence.clone();
                        // Store qualification and timer work remain off UI and
                        // are awaited before this owned timer can finish.
                        let _ = tokio::task::spawn_blocking(move || cache.sweep()).await;
                    }
                }
            }
        });
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
        });
        Ok(runtime)
    }
    pub fn bridge(self: &Arc<Self>) -> CoreBridge {
        CoreBridge::new(self.core.clone(), Arc::downgrade(self))
    }
    pub(super) fn overlay_presence(&self, result: &mut QueryResult) {
        self.presence.overlay(result);
    }
    pub(super) fn run_owned<T: Send + 'static>(
        &self,
        deadline: Instant,
        timeout: CoreError,
        work: impl FnOnce() -> Result<T, CoreError> + Send + 'static,
    ) -> Result<T, CoreError> {
        if OWNED_BRIDGE.with(Cell::get) {
            return work();
        }
        let (sent, received) = std::sync::mpsc::sync_channel(1);
        {
            let workers = self.workers.lock().map_err(|_| unavailable())?;
            if self.stopping.load(Ordering::Acquire) || self.replacing.load(Ordering::Acquire) {
                return Err(unavailable());
            }
            let workers = workers.as_ref().ok_or_else(unavailable)?;
            // Scheduling under the admission lock makes executor shutdown wait
            // for this actual closure. The lock ends before Core/provider IO.
            workers.executor.spawn_blocking(move || {
                let _owned = OwnedBridgeGuard(OWNED_BRIDGE.with(|owned| owned.replace(true)));
                let result = work();
                let _ = sent.send(result);
            });
        }
        received
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| timeout)?
    }
    pub(super) fn spawn_reconciliation(&self, runtime: Arc<Self>) {
        let workers = self
            .workers
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(workers) = workers.as_ref() {
            workers.executor.spawn_blocking(move || {
                if let Err(error) = runtime.reconcile() {
                    eprintln!(
                        "Ariadne persisted binding reconciliation remains unavailable: {:?}.",
                        error.code
                    );
                }
            });
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
        self.run_owned(deadline, uncertain(), move || {
            activation.bootstrap_before(request, deadline)
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
        if self.stopping.load(Ordering::Acquire) || self.replacing.swap(true, Ordering::AcqRel) {
            return Err(unavailable());
        }
        let result = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let mut workers = self.workers.lock().map_err(|_| unavailable())?;
                    let workers = workers.as_mut().ok_or_else(unavailable)?;
                    self.presence.fence();
                    workers.poller.refresh_after_wake()?;
                    workers.watcher.reconcile();
                    workers.executor.block_on(workers.activation.shutdown())?;
                    if self.stopping.load(Ordering::Acquire) {
                        return Err(unavailable());
                    }
                    workers.activation = NativeActivation::new_with_presence(
                        self.core.clone(),
                        workers.providers.clone(),
                        workers.owner.clone(),
                        workers.routes.clone(),
                        workers.executor.handle().clone(),
                        workers.outcomes.clone(),
                        Some(self.presence.observer()),
                    );
                    self.presence.reopen();
                    Ok(())
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
        let _shutdown = self.shutdown_gate.lock().map_err(|_| unavailable())?;
        self.stopping.store(true, Ordering::Release);
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
        let _ = presence_stop.send(());
        let presence_result = executor.block_on(presence_task).map_err(|_| unavailable());
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
        "The admitted desktop operation has not returned a saved receipt within its original deadline.",
        "Retain the original operation ID and contents; reconcile its saved receipt before any new operation.")
}
fn next_id() -> UuidV4 {
    UuidV4::new(uuid::Uuid::new_v4().to_string()).expect("native UUIDv4")
}
pub(super) fn now() -> UtcMillis {
    UtcMillis::new(
        chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    )
    .expect("native UTC clock")
}
