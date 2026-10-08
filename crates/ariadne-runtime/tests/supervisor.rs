use ariadne_agent_protocol::{fake as provider, *};
use ariadne_core::{fake as service, *};
use ariadne_domain::models::*;
use ariadne_runtime::{
    control::*,
    health::{SupervisorHealth, SupervisorState},
    leases::*,
    supervisor::*,
};
use std::{
    collections::HashMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    runtime::Runtime,
    sync::{oneshot, watch},
};
#[allow(dead_code)]
#[path = "../../../tests/support/core_service/mod.rs"]
mod cases;
#[path = "fixtures/paged_attempt_digests.rs"]
mod paged_attempt_digests;

fn root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
}
fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn at() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
}
fn rt() -> Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(3)
        .enable_all()
        .build()
        .unwrap()
}
fn home() -> tempfile::TempDir {
    let p = tempfile::Builder::new()
        .prefix("ariadne-supervisor-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(p.path(), fs::Permissions::from_mode(0o700)).unwrap();
    p
}
#[derive(Clone)]
struct Scope {
    session: RegisteredSession,
    binding: Binding,
    next: u64,
}
impl Scope {
    fn new(project: u64, session: u64, binding: u64, mode: DeliveryMode) -> Self {
        let demo: Session =
            serde_json::from_str(include_str!("../../../fixtures/domain/demo/session.json"))
                .unwrap();
        let mut b = demo.bindings.0[&id(0x20)].clone();
        b.id = id(binding);
        b.capabilities.delivery_mode = mode;
        Self {
            session: RegisteredSession::from_trusted_entrypoint(id(project), id(session)),
            binding: b,
            next: 0x1000 + binding,
        }
    }
    fn facts(&self) -> NativeFacts {
        let next = Arc::new(AtomicU64::new(self.next));
        NativeFacts {
            next_id: Arc::new(move || id(next.fetch_add(1, Ordering::SeqCst))),
            now: Arc::new(at),
        }
    }
    fn connection(&self) -> ConnectResult {
        ConnectResult {
            external_session_id: self.binding.external_session_id.clone(),
            endpoint_fingerprint: self.binding.endpoint_fingerprint.clone(),
            capabilities: self.binding.capabilities.clone(),
            observation: PresenceObservation {
                instance_id: id(0x3000),
                generation: self.binding.generation.clone(),
                connection_state: ConnectionState::Connected,
                execution_state: ExecutionState::Idle,
                last_seen_at: Some(at()),
                source: Some(PresenceSource::HostPoll),
                process_identity: None,
                freshness: Freshness::Fresh,
            },
        }
    }
    fn connect_request(&self) -> ConnectRequest {
        ConnectRequest {
            binding_id: self.binding.id.clone(),
            generation: self.binding.generation.clone(),
            external_session_id: self.binding.external_session_id.clone(),
            endpoint: self.binding.endpoint.clone(),
            configuration: self.binding.adapter_config.clone(),
        }
    }
    fn event(
        &self,
        event_id: &str,
        event: EventPayload,
        attempt: Option<&PreparedAttempt>,
        turn: Option<&str>,
    ) -> NormalizedEvent {
        NormalizedEvent {
            event_id: event_id.into(),
            binding_id: self.binding.id.clone(),
            generation: self.binding.generation.clone(),
            input_id: attempt.map(|a| a.input_id.clone()),
            attempt_id: attempt.map(|a| a.attempt_id.clone()),
            host_turn_id: turn.map(str::to_owned),
            observed_at: at(),
            event,
        }
    }
    fn connected(&self) -> NormalizedEvent {
        self.event(
            &format!(
                "runtime:connected:{}:{}",
                self.binding.id.as_str(),
                self.binding.generation.as_str()
            ),
            EventPayload::Connected {
                external_session_id: self.binding.external_session_id.clone(),
                endpoint_fingerprint: self.binding.endpoint_fingerprint.clone(),
                capabilities: Box::new(self.binding.capabilities.clone()),
            },
            None,
            None,
        )
    }
    fn report(
        &self,
        event: NormalizedEvent,
        result: Result<EventReceipt, CoreError>,
        historical: bool,
    ) -> service::ScriptStep {
        let evidence = historical.then(|| {
            VerifiedHistoricalScope::from_trusted_reconciliation(
                event.generation.clone(),
                event.input_id.clone().unwrap(),
                event.attempt_id.clone().unwrap(),
                self.binding.endpoint_fingerprint.clone(),
            )
        });
        service::ScriptStep {
            request: service::RecordedRequest::Report(
                AdapterContext::from_trusted_entrypoint(
                    self.session.clone(),
                    self.binding.id.clone(),
                    self.binding.generation.clone(),
                    evidence,
                ),
                Box::new(event),
            ),
            response: service::ScriptedResponse::Report(result),
        }
    }
    fn receipt(&self, event: &NormalizedEvent, durable: bool) -> EventReceipt {
        EventReceipt {
            event_id: event.event_id.clone(),
            session_id: self.session.session_id().clone(),
            revision: durable.then(|| PositiveSafeInteger::new(2).unwrap()),
            durable_effect: durable,
            replayed: false,
        }
    }
    fn saved(&self, event: NormalizedEvent, historical: bool) -> service::ScriptStep {
        let r = self.receipt(
            &event,
            !matches!(
                event.event,
                EventPayload::Presence { .. } | EventPayload::VisibleOutput { .. }
            ),
        );
        self.report(event, Ok(r), historical)
    }
    fn inputs(&self, inputs: Vec<Input>) -> service::ScriptStep {
        let context = QueryContext::owner(OwnerContext::from_trusted_entrypoint(
            OwnerScope::Session(self.session.clone()),
        ));
        service::ScriptStep {
            request: service::RecordedRequest::Query(
                context,
                Box::new(QueryRequest::SessionRead(SessionReadRequest {
                    selection: ReadView::Inputs {
                        topic_id: None,
                        item_id: None,
                        states: vec![InputState::InFlight, InputState::NeedsAttention],
                    },
                    cursor: None,
                    limit: PageLimit::new(100).unwrap(),
                    item_pages: vec![],
                })),
            ),
            response: service::ScriptedResponse::Query(Box::new(Ok(QueryResult::SessionRead(
                SessionReadResult::Inputs(Page {
                    items: inputs,
                    next_cursor: None,
                    snapshot_revision: PositiveSafeInteger::new(1).unwrap(),
                }),
            )))),
        }
    }
    fn claim(&self, attempt: Option<PreparedAttempt>) -> service::ScriptStep {
        service::ScriptStep {
            request: service::RecordedRequest::Claim(
                ValidatedDispatchContext::from_trusted_current_lease(
                    self.session.clone(),
                    self.binding.id.clone(),
                    self.binding.generation.clone(),
                ),
                ClaimRequest {
                    binding_id: self.binding.id.clone(),
                    generation: self.binding.generation.clone(),
                    request_id: id(self.next),
                },
            ),
            response: service::ScriptedResponse::Claim(Ok(attempt)),
        }
    }
    fn provider_start(
        &self,
        attempts: Vec<AttemptEvidenceRequest>,
        result: ReconcileResult,
    ) -> Vec<provider::ScriptStep> {
        vec![
            provider::ScriptStep {
                request: provider::RecordedRequest::Connect(self.connect_request()),
                response: provider::ScriptedResponse::connect(Ok(self.connection())),
            },
            provider::ScriptStep {
                request: provider::RecordedRequest::Reconcile(ReconcileRequest {
                    binding_id: self.binding.id.clone(),
                    generation: self.binding.generation.clone(),
                    attempts,
                    checkpoint: None,
                }),
                response: provider::ScriptedResponse::Reconcile(Ok(result)),
            },
        ]
    }
    fn observe(
        &self,
        checkpoint: Option<Checkpoint>,
        events: Vec<NormalizedEvent>,
        next: Option<Checkpoint>,
    ) -> provider::ScriptStep {
        provider::ScriptStep {
            request: provider::RecordedRequest::Observe(ObserveRequest {
                binding_id: self.binding.id.clone(),
                generation: self.binding.generation.clone(),
                checkpoint,
                limit: ObserveLimit::new(100).unwrap(),
            }),
            response: provider::ScriptedResponse::Observe(Ok(ObserveResult {
                events,
                next_checkpoint: next,
            })),
        }
    }
    fn start(
        &self,
        rt: &Runtime,
        owner: &DesktopOwner,
        core: Arc<dyn CoreService>,
        adapter: Arc<dyn Adapter>,
    ) -> SupervisorHandle {
        let connected = rt
            .block_on(ConnectedSupervisor::connect(
                core,
                adapter,
                self.session.clone(),
                self.binding.clone(),
                self.facts(),
            ))
            .unwrap();
        let lease = owner
            .binding_lease(
                self.session.clone(),
                self.binding.id.clone(),
                self.binding.generation.clone(),
            )
            .unwrap();
        rt.block_on(async { connected.start(lease) }).unwrap()
    }
}
fn empty_reconcile() -> ReconcileResult {
    ReconcileResult {
        attempt_evidence: vec![],
        unresolved_attempt_ids: vec![],
        next_checkpoint: None,
    }
}

#[test]
fn presence_follows_validated_receipts_and_exact_connected_instance() {
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let scope = Scope::new(1, 2, 3, DeliveryMode::Pull);
    let mut observation = scope.connection().observation;
    observation.execution_state = ExecutionState::Running;
    let observed = scope.event(
        "presence:accepted",
        EventPayload::Presence {
            observation: observation.clone(),
        },
        None,
        None,
    );
    let mut foreign = observation.clone();
    foreign.instance_id = id(0x3999);
    let foreign_event = scope.event(
        "presence:foreign-instance",
        EventPayload::Presence {
            observation: foreign,
        },
        None,
        None,
    );
    let core = Arc::new(service::ScriptedCoreService::new(vec![
        scope.saved(scope.connected(), false),
        scope.inputs(vec![]),
        scope.saved(observed.clone(), false),
        scope.saved(foreign_event.clone(), false),
    ]));
    let mut steps = scope.provider_start(vec![], empty_reconcile());
    steps.push(scope.observe(None, vec![observed, foreign_event], None));
    let adapter = IdleProvider::new(steps);
    let updates = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = updates.clone();
    let connected = rt
        .block_on(ConnectedSupervisor::connect(
            core.clone(),
            adapter.clone(),
            scope.session.clone(),
            scope.binding.clone(),
            scope.facts(),
        ))
        .unwrap()
        .with_presence_observer(Arc::new(move |update| sink.lock().unwrap().push(update)));
    let lease = owner
        .binding_lease(
            scope.session.clone(),
            scope.binding.id.clone(),
            scope.binding.generation.clone(),
        )
        .unwrap();
    let handle = rt.block_on(async { connected.start(lease) }).unwrap();
    rt.block_on(progress(handle.progress(), |p| p.validated_reports == 3));
    let exit = rt.block_on(handle.stop()).unwrap();
    assert!(exit.error.is_none());
    let updates = updates.lock().unwrap();
    assert_eq!(updates.len(), 3);
    assert!(
        matches!(&updates[0], PresenceUpdate::Connected { hint, endpoint } if hint.observation.instance_id == id(0x3000) && endpoint == &scope.binding.endpoint_fingerprint)
    );
    assert!(
        matches!(&updates[1], PresenceUpdate::Observed { hint, .. } if hint.observation == observation)
    );
    assert!(
        matches!(&updates[2], PresenceUpdate::Stopped { hint, .. } if hint.observation.last_seen_at == observation.last_seen_at && hint.observation.execution_state == ExecutionState::Unknown)
    );
}

#[test]
fn stopped_presence_observer_drains_before_releasing_real_binding_lease() {
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let scope = Scope::new(1, 2, 3, DeliveryMode::Pull);
    let core = Arc::new(service::ScriptedCoreService::new(vec![
        scope.saved(scope.connected(), false)
    ]));
    let adapter = IdleProvider::new(vec![scope
        .provider_start(vec![], empty_reconcile())
        .remove(0)]);
    let (entered, admitted) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let released = std::sync::Mutex::new(released);
    let connected = rt
        .block_on(ConnectedSupervisor::connect(
            core,
            adapter,
            scope.session.clone(),
            scope.binding.clone(),
            scope.facts(),
        ))
        .unwrap()
        .with_presence_observer(Arc::new(move |update| {
            if matches!(update, PresenceUpdate::Connected { .. }) {
                entered.send(()).unwrap();
                released.lock().unwrap().recv().unwrap();
            }
        }));
    let lease = owner
        .binding_lease(
            scope.session.clone(),
            scope.binding.id.clone(),
            scope.binding.generation.clone(),
        )
        .unwrap();
    let handle = rt.block_on(async { connected.start(lease) }).unwrap();
    admitted.recv_timeout(Duration::from_secs(2)).unwrap();
    let stop = rt.spawn(handle.stop());
    std::thread::sleep(Duration::from_millis(30));
    assert!(!stop.is_finished());
    probe_lease(home.path(), &scope.binding.id, false);
    release.send(()).unwrap();
    let exit = rt.block_on(stop).unwrap().unwrap();
    assert!(exit.pending.is_none());
    assert!(exit.error.is_none());
    probe_lease(home.path(), &scope.binding.id, true);
}
fn prepared() -> PreparedAttempt {
    cases::load(root())
        .cases
        .into_iter()
        .find(|c| c.name == "claim_replay_precedes_new_generation")
        .unwrap()
        .steps
        .into_iter()
        .find_map(|step| match step {
            cases::CaseStep::Claim { response, .. } => cases::result(&response).unwrap(),
            _ => None,
        })
        .unwrap()
}
fn stored(scope: &Scope, prepared: &PreparedAttempt) -> Input {
    let mut page: Page<Input> = serde_json::from_str(include_str!(
        "../../../fixtures/domain/projections/inputs.json"
    ))
    .unwrap();
    let mut input = page.items.remove(0);
    input.id = prepared.input_id.clone();
    input.binding_id = scope.binding.id.clone();
    input.state = InputState::InFlight;
    input.active_attempt_id = Some(prepared.attempt_id.clone());
    let mut attempt = input.attempts.remove(0);
    attempt.id = prepared.attempt_id.clone();
    attempt.binding_generation = prepared.binding_generation.clone();
    attempt.formatted_payload = prepared.formatted_payload.clone();
    attempt.payload_sha256 = prepared.payload_sha256.clone();
    attempt.wire_marker = prepared.wire_marker.clone();
    attempt.sealed_at = None;
    attempt.host_turn_id = None;
    attempt.acceptance = AcceptanceState::Prepared;
    attempt.acceptance_receipt = None;
    attempt.acceptance_observed_at = None;
    attempt.turn_state = TurnState::Unknown;
    attempt.turn_observed_at = None;
    attempt.domain_result = None;
    attempt.result_state = ResultState::Pending;
    attempt.error = None;
    attempt.reconciliation_checkpoint = None;
    input.attempts = vec![attempt];
    input
}
fn evidence(p: &PreparedAttempt) -> AttemptEvidenceRequest {
    AttemptEvidenceRequest {
        input_id: p.input_id.clone(),
        attempt_id: p.attempt_id.clone(),
        binding_generation: p.binding_generation.clone(),
        payload_sha256: p.payload_sha256.clone(),
        wire_marker: p.wire_marker.clone(),
        host_turn_id: None,
    }
}

// Only script timing differs: once all provider observations have been supplied,
// an idle observer waits. No state transition, persistence, fallback or host call.
struct IdleProvider {
    script: provider::ScriptedAdapter,
    stopped: AtomicU64,
}
impl IdleProvider {
    fn new(steps: Vec<provider::ScriptStep>) -> Arc<Self> {
        Arc::new(Self {
            script: provider::ScriptedAdapter::new(steps),
            stopped: AtomicU64::new(0),
        })
    }
}
impl Adapter for IdleProvider {
    fn probe(&self, r: ProbeRequest) -> AdapterFuture<'_, ProbeResult> {
        self.script.probe(r)
    }
    fn connect(&self, r: ConnectRequest) -> AdapterFuture<'_, ConnectResult> {
        self.script.connect(r)
    }
    fn submit(&self, r: SubmitRequest) -> AdapterFuture<'_, SubmitOutcome> {
        self.script.submit(r)
    }
    fn observe(&self, r: ObserveRequest) -> AdapterFuture<'_, ObserveResult> {
        if self.script.remaining().unwrap() == 0 {
            Box::pin(std::future::pending())
        } else {
            self.script.observe(r)
        }
    }
    fn reconcile(&self, r: ReconcileRequest) -> AdapterFuture<'_, ReconcileResult> {
        self.script.reconcile(r)
    }
    fn disconnect(&self, _: DisconnectRequest) -> AdapterFuture<'_, DisconnectResult> {
        Box::pin(async {
            self.stopped.fetch_add(1, Ordering::SeqCst);
            Ok(DisconnectResult {})
        })
    }
}
async fn progress(
    mut observed: watch::Receiver<SupervisorProgress>,
    wanted: impl Fn(&SupervisorProgress) -> bool,
) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if wanted(&observed.borrow().clone()) {
                break;
            }
            observed.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
}
struct Routes(HashMap<UuidV4, Arc<service::ScriptedCoreService>>);
impl Routes {
    fn get(&self, s: &RegisteredSession) -> &service::ScriptedCoreService {
        self.0[&s.session_id().clone()].as_ref()
    }
}
impl CoreService for Routes {
    fn query(&self, c: QueryContext, r: QueryRequest) -> Result<QueryResult, CoreError> {
        let QueryVisibility::Owner(owner) = c.visibility() else {
            panic!("not an owner scan")
        };
        let OwnerScope::Session(s) = owner.scope() else {
            panic!("unregistered route")
        };
        self.get(s).query(c, r)
    }
    fn execute_owner(
        &self,
        _: OwnerContext,
        _: OwnerCommand,
    ) -> Result<MutationReceipt, CoreError> {
        panic!("supervisor never mutates owner business state")
    }
    fn apply(&self, _: AgentContext, _: ApplyRequest) -> Result<ApplyReceipt, CoreError> {
        panic!("terminal text is not a domain reply")
    }
    fn claim(
        &self,
        c: ValidatedDispatchContext,
        r: ClaimRequest,
    ) -> Result<Option<PreparedAttempt>, CoreError> {
        self.get(c.session()).claim(c, r)
    }
    fn report(&self, c: AdapterContext, e: NormalizedEvent) -> Result<EventReceipt, CoreError> {
        self.get(c.session()).report(c, e)
    }
}

#[test]
fn independent_sessions_in_one_project_and_another_project_progress_without_proactive_pull_claims()
{
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let scopes = [
        Scope::new(1, 2, 0x20, DeliveryMode::Pull),
        Scope::new(1, 3, 0x21, DeliveryMode::Push),
        Scope::new(4, 5, 0x22, DeliveryMode::Pull),
    ];
    let mut routes = HashMap::new();
    let mut adapters = vec![];
    for scope in &scopes {
        let mut steps = vec![scope.saved(scope.connected(), false), scope.inputs(vec![])];
        if scope.binding.capabilities.delivery_mode == DeliveryMode::Push {
            steps.push(scope.claim(None));
        }
        routes.insert(
            scope.session.session_id().clone(),
            Arc::new(service::ScriptedCoreService::new(steps)),
        );
        let mut provider = scope.provider_start(vec![], empty_reconcile());
        provider.push(scope.observe(None, vec![], None));
        adapters.push(IdleProvider::new(provider));
    }
    let core = Arc::new(Routes(routes.clone()));
    let mut handles = vec![];
    for (scope, adapter) in scopes.iter().zip(&adapters) {
        handles.push(scope.start(&rt, &owner, core.clone(), adapter.clone()));
    }
    for (scope, h) in scopes.iter().zip(&handles) {
        rt.block_on(progress(h.progress(), |p| {
            p.reconciled
                && (scope.binding.capabilities.delivery_mode == DeliveryMode::Pull
                    || p.validated_claims == 1)
        }));
    }
    // The push claim is allowed only by its own scope; pull scripts contain none.
    for (scope, h) in scopes.iter().zip(handles) {
        let result = rt.block_on(h.stop()).unwrap();
        assert!(result.pending.is_none());
        assert!(result.error.is_none(), "{:?}", result.error);
        assert_eq!(routes[scope.session.session_id()].remaining().unwrap(), 0);
        assert!(!routes[scope.session.session_id()]
            .history()
            .unwrap()
            .iter()
            .any(|r| matches!(
                r,
                service::RecordedRequest::Apply(..) | service::RecordedRequest::Owner(..)
            )));
    }
    assert!(adapters
        .iter()
        .all(|p| p.stopped.load(Ordering::SeqCst) == 1));
}

#[test]
fn checkpoint_echo_waits_for_all_validated_receipts_and_repeated_provider_facts_replay() {
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let scope = Scope::new(1, 2, 0x20, DeliveryMode::Pull);
    let p = prepared();
    let event = scope.event(
        "provider:finished",
        EventPayload::TurnFinished {
            status: TurnFinishedStatus::Completed,
            reason: None,
            diagnostic_text: Some("diagnostic text is not a reply".into()),
            truncated: false,
        },
        Some(&p),
        Some("turn-1"),
    );
    let cp = Checkpoint::new("instance:page:1").unwrap();
    let mut replay = scope.receipt(&event, true);
    replay.replayed = true;
    let core = Arc::new(service::ScriptedCoreService::new([
        scope.saved(scope.connected(), false),
        scope.inputs(vec![]),
        scope.saved(event.clone(), false),
        scope.report(event.clone(), Ok(replay), false),
    ]));
    let mut provider = scope.provider_start(vec![], empty_reconcile());
    provider.push(scope.observe(None, vec![event.clone()], Some(cp.clone())));
    provider.push(scope.observe(Some(cp.clone()), vec![event], Some(cp.clone())));
    let adapter = IdleProvider::new(provider);
    let handle = scope.start(&rt, &owner, core.clone(), adapter.clone());
    rt.block_on(progress(handle.progress(), |p| p.validated_reports == 3));
    let result = rt.block_on(handle.stop()).unwrap();
    assert_eq!(result.acknowledged_checkpoint, Some(cp));
    assert!(result.error.is_none());
    assert_eq!(core.remaining().unwrap(), 0);
    assert_eq!(result.diagnostics.len(), 2);
    assert_eq!(adapter.script.remaining().unwrap(), 0);
}

#[test]
fn successful_unchanged_lifecycle_receipts_acknowledge_without_fabricating_writes() {
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let scope = Scope::new(1, 2, 0x20, DeliveryMode::Pull);
    let p = prepared();
    let started = scope.event(
        "redundant:start",
        EventPayload::TurnStarted {},
        Some(&p),
        Some("turn-1"),
    );
    let completed = scope.event(
        "redundant:completed",
        EventPayload::TurnFinished {
            status: TurnFinishedStatus::Completed,
            reason: None,
            diagnostic_text: None,
            truncated: false,
        },
        Some(&p),
        Some("turn-1"),
    );
    let connected = scope.connected();
    let core = Arc::new(service::ScriptedCoreService::new([
        scope.report(
            connected.clone(),
            Ok(scope.receipt(&connected, false)),
            false,
        ),
        scope.inputs(vec![]),
        scope.report(started.clone(), Ok(scope.receipt(&started, false)), false),
        scope.report(
            completed.clone(),
            Ok(scope.receipt(&completed, false)),
            false,
        ),
    ]));
    let cp = Checkpoint::new("page:unchanged-facts").unwrap();
    let mut provider = scope.provider_start(vec![], empty_reconcile());
    provider.push(scope.observe(None, vec![started, completed], Some(cp.clone())));
    let adapter = IdleProvider::new(provider);
    let handle = scope.start(&rt, &owner, core.clone(), adapter.clone());
    rt.block_on(progress(handle.progress(), |p| p.validated_reports == 3));
    let result = rt.block_on(handle.stop()).unwrap();
    assert_eq!(result.acknowledged_checkpoint, Some(cp));
    assert!(result.pending.is_none());
    assert!(result.error.is_none());
    assert_eq!(core.remaining().unwrap(), 0);
    assert_eq!(adapter.script.remaining().unwrap(), 0);
}

fn store_busy() -> CoreError {
    CoreError::new(
        CoreErrorCode::StoreBusy,
        "Store temporarily locked",
        "Retry the same event ID after the lock is released.",
    )
}
fn accepted_and_finished(scope: &Scope, p: &PreparedAttempt) -> (NormalizedEvent, NormalizedEvent) {
    let accepted = scope.event(
        "host:accepted",
        EventPayload::Accepted { receipt: None },
        Some(p),
        None,
    );
    let finished = scope.event(
        "host:finished",
        EventPayload::TurnFinished {
            status: TurnFinishedStatus::Completed,
            reason: None,
            diagnostic_text: None,
            truncated: false,
        },
        Some(p),
        Some("turn"),
    );
    (accepted, finished)
}
#[test]
fn failed_receipt_retains_page_original_fact_and_checkpoint_while_retrying() {
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let scope = Scope::new(1, 2, 0x20, DeliveryMode::Pull);
    let p = prepared();
    let (accepted, finished) = accepted_and_finished(&scope, &p);
    let core = Arc::new(service::ScriptedCoreService::new([
        scope.saved(scope.connected(), false),
        scope.inputs(vec![]),
        scope.saved(accepted.clone(), false),
        scope.report(finished.clone(), Err(store_busy()), false),
        // The shutdown flush retries the identical fact once more.
        scope.report(finished.clone(), Err(store_busy()), false),
    ]));
    let cp = Checkpoint::new("page:unacknowledged").unwrap();
    let mut provider = scope.provider_start(vec![], empty_reconcile());
    provider.push(scope.observe(None, vec![accepted, finished.clone()], Some(cp.clone())));
    let adapter = IdleProvider::new(provider);
    let h = scope.start(&rt, &owner, core.clone(), adapter.clone());
    // The worker keeps running after the failure (backing off) instead of ending.
    rt.block_on(eventually(|| core.remaining().unwrap() == 1));
    assert!(h.progress().has_changed().is_ok(), "worker must stay alive");
    let result = rt.block_on(h.stop()).unwrap();
    let pending = result.pending.unwrap();
    assert_eq!(pending.reports.len(), 1);
    assert_eq!(pending.reports[0].event, finished);
    assert_eq!(pending.next_checkpoint, Some(cp));
    assert_eq!(result.error.unwrap().code, CoreErrorCode::StoreBusy);
    assert_eq!(result.acknowledged_checkpoint, None);
    assert_eq!(core.remaining().unwrap(), 0);
    assert_eq!(adapter.script.remaining().unwrap(), 0);
}

#[test]
fn failed_receipt_is_retried_with_the_same_fact_and_then_acknowledges_the_page() {
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let scope = Scope::new(1, 2, 0x20, DeliveryMode::Pull);
    let p = prepared();
    let (accepted, finished) = accepted_and_finished(&scope, &p);
    let core = Arc::new(service::ScriptedCoreService::new([
        scope.saved(scope.connected(), false),
        scope.inputs(vec![]),
        scope.saved(accepted.clone(), false),
        scope.report(finished.clone(), Err(store_busy()), false),
        // After backoff the identical event ID is reported again, never skipped.
        scope.saved(finished.clone(), false),
    ]));
    let cp = Checkpoint::new("page:retried").unwrap();
    let mut provider = scope.provider_start(vec![], empty_reconcile());
    provider.push(scope.observe(None, vec![accepted, finished], Some(cp.clone())));
    let adapter = IdleProvider::new(provider);
    let h = scope.start(&rt, &owner, core.clone(), adapter.clone());
    let progress = h.progress();
    rt.block_on(eventually(|| {
        progress.borrow().acknowledged_checkpoint.as_ref() == Some(&cp)
    }));
    let exit = rt.block_on(h.stop()).unwrap();
    assert!(exit.error.is_none(), "{:?}", exit.error);
    assert!(exit.pending.is_none());
    assert_eq!(exit.acknowledged_checkpoint, Some(cp));
    assert_eq!(core.remaining().unwrap(), 0);
}

#[test]
fn push_health_reports_backing_off_in_plain_words_then_running_and_reuses_the_claim_id() {
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let scope = Scope::new(1, 2, 0x20, DeliveryMode::Push);
    let mut busy_claim = scope.claim(None);
    busy_claim.response = service::ScriptedResponse::Claim(Err(store_busy()));
    let core = Arc::new(service::ScriptedCoreService::new([
        scope.saved(scope.connected(), false),
        scope.inputs(vec![]),
        busy_claim,
        // The retry carries the same request ID, so a saved claim would replay.
        scope.claim(None),
    ]));
    let mut provider = scope.provider_start(vec![], empty_reconcile());
    provider.push(scope.observe(None, vec![], None));
    provider.push(scope.observe(None, vec![], None));
    let adapter = IdleProvider::new(provider);
    let (seen, observer) = health_sink();
    let connected = rt
        .block_on(ConnectedSupervisor::connect(
            core.clone(),
            adapter,
            scope.session.clone(),
            scope.binding.clone(),
            scope.facts(),
        ))
        .unwrap()
        .with_health_observer(observer);
    let lease = owner
        .binding_lease(
            scope.session.clone(),
            scope.binding.id.clone(),
            scope.binding.generation.clone(),
        )
        .unwrap();
    let h = rt.block_on(async { connected.start(lease) }).unwrap();
    rt.block_on(eventually(|| seen.lock().unwrap().len() == 2));
    let exit = rt.block_on(h.stop()).unwrap();
    assert!(exit.error.is_none(), "{:?}", exit.error);
    assert!(exit.pending_claim.is_none());
    assert_eq!(core.remaining().unwrap(), 0);
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2, "stop on request publishes nothing: {seen:?}");
    assert_eq!(seen[0].binding_id, scope.binding.id);
    assert_eq!(seen[0].state, SupervisorState::BackingOff);
    assert_eq!(
        seen[0].reason.as_deref(),
        Some("Ariadne couldn't save to its data folder. It will keep trying.")
    );
    assert_eq!(seen[0].retry_in_seconds, Some(1));
    assert_eq!(seen[1].state, SupervisorState::Running);
    assert_eq!(seen[1].reason, None);
}

fn stale() -> CoreError {
    CoreError::new(
        CoreErrorCode::StaleGeneration,
        "Binding generation was replaced.",
        "Reconnect the session.",
    )
}
fn start_with_health(
    rt: &Runtime,
    owner: &DesktopOwner,
    scope: &Scope,
    core: Arc<dyn CoreService>,
    adapter: Arc<dyn Adapter>,
) -> (
    SupervisorHandle,
    Arc<std::sync::Mutex<Vec<SupervisorHealth>>>,
) {
    let (seen, observer) = health_sink();
    let connected = rt
        .block_on(ConnectedSupervisor::connect(
            core,
            adapter,
            scope.session.clone(),
            scope.binding.clone(),
            scope.facts(),
        ))
        .unwrap()
        .with_health_observer(observer);
    let lease = owner
        .binding_lease(
            scope.session.clone(),
            scope.binding.id.clone(),
            scope.binding.generation.clone(),
        )
        .unwrap();
    (rt.block_on(async { connected.start(lease) }).unwrap(), seen)
}

#[test]
fn pull_bindings_never_publish_health_while_backing_off_or_when_their_scope_ends() {
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let scope = Scope::new(1, 2, 0x20, DeliveryMode::Pull);
    let p = prepared();
    let (accepted, finished) = accepted_and_finished(&scope, &p);
    let core = Arc::new(service::ScriptedCoreService::new([
        scope.saved(scope.connected(), false),
        scope.inputs(vec![]),
        scope.saved(accepted.clone(), false),
        scope.report(finished.clone(), Err(store_busy()), false),
        scope.report(finished.clone(), Err(stale()), false),
    ]));
    let mut provider = scope.provider_start(vec![], empty_reconcile());
    provider.push(scope.observe(None, vec![accepted, finished.clone()], None));
    let (h, seen) = start_with_health(
        &rt,
        &owner,
        &scope,
        core.clone(),
        IdleProvider::new(provider),
    );
    // Retried once, then the replaced generation ends the worker by itself.
    let progress = h.progress();
    rt.block_on(eventually(|| progress.has_changed().is_err()));
    let exit = rt.block_on(h.stop()).unwrap();
    assert_eq!(exit.error.unwrap().code, CoreErrorCode::StaleGeneration);
    assert_eq!(exit.pending.unwrap().reports[0].event, finished);
    assert_eq!(core.remaining().unwrap(), 0);
    assert!(
        seen.lock().unwrap().is_empty(),
        "{:?}",
        seen.lock().unwrap()
    );
}

#[test]
fn push_binding_whose_scope_ended_stops_and_says_why_without_retrying() {
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let scope = Scope::new(1, 2, 0x20, DeliveryMode::Push);
    let p = prepared();
    let (accepted, _) = accepted_and_finished(&scope, &p);
    let core = Arc::new(service::ScriptedCoreService::new([
        scope.saved(scope.connected(), false),
        scope.inputs(vec![]),
        scope.report(accepted.clone(), Err(stale()), false),
    ]));
    let mut provider = scope.provider_start(vec![], empty_reconcile());
    provider.push(scope.observe(None, vec![accepted], None));
    let (h, seen) = start_with_health(
        &rt,
        &owner,
        &scope,
        core.clone(),
        IdleProvider::new(provider),
    );
    rt.block_on(ended(h.progress()));
    let exit = rt.block_on(h.stop()).unwrap();
    assert_eq!(exit.error.unwrap().code, CoreErrorCode::StaleGeneration);
    assert_eq!(core.remaining().unwrap(), 0);
    assert_eq!(
        core.history().unwrap().len(),
        3,
        "no retry after the scope ended"
    );
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1, "{seen:?}");
    assert_eq!(seen[0].state, SupervisorState::Stopped);
    assert_eq!(
        seen[0].reason.as_deref(),
        Some("This connection was replaced. Reconnect to send again.")
    );
}

/// Every claim is an eligible empty claim; everything else follows the script.
struct ClaimIdle {
    inner: service::ScriptedCoreService,
    claims: AtomicU64,
}
impl CoreService for ClaimIdle {
    fn query(&self, c: QueryContext, r: QueryRequest) -> Result<QueryResult, CoreError> {
        self.inner.query(c, r)
    }
    fn execute_owner(
        &self,
        c: OwnerContext,
        r: OwnerCommand,
    ) -> Result<MutationReceipt, CoreError> {
        self.inner.execute_owner(c, r)
    }
    fn apply(&self, c: AgentContext, r: ApplyRequest) -> Result<ApplyReceipt, CoreError> {
        self.inner.apply(c, r)
    }
    fn claim(
        &self,
        _: ValidatedDispatchContext,
        _: ClaimRequest,
    ) -> Result<Option<PreparedAttempt>, CoreError> {
        self.claims.fetch_add(1, Ordering::SeqCst);
        Ok(None)
    }
    fn report(&self, c: AdapterContext, r: NormalizedEvent) -> Result<EventReceipt, CoreError> {
        self.inner.report(c, r)
    }
}
/// Observes nothing and answers reconciliation from a queue.
struct Rechecking {
    inner: Arc<IdleProvider>,
    reconciles: std::sync::Mutex<std::collections::VecDeque<ReconcileResult>>,
}
impl Adapter for Rechecking {
    fn probe(&self, r: ProbeRequest) -> AdapterFuture<'_, ProbeResult> {
        self.inner.probe(r)
    }
    fn connect(&self, r: ConnectRequest) -> AdapterFuture<'_, ConnectResult> {
        self.inner.connect(r)
    }
    fn submit(&self, _: SubmitRequest) -> AdapterFuture<'_, SubmitOutcome> {
        panic!("nothing is eligible to submit")
    }
    fn observe(&self, _: ObserveRequest) -> AdapterFuture<'_, ObserveResult> {
        Box::pin(async {
            Ok(ObserveResult {
                events: vec![],
                next_checkpoint: None,
            })
        })
    }
    fn reconcile(&self, _: ReconcileRequest) -> AdapterFuture<'_, ReconcileResult> {
        let next = self.reconciles.lock().unwrap().pop_front().unwrap();
        Box::pin(async move { Ok(next) })
    }
    fn disconnect(&self, r: DisconnectRequest) -> AdapterFuture<'_, DisconnectResult> {
        self.inner.disconnect(r)
    }
}

#[test]
fn unsettled_earlier_attempts_are_rechecked_with_backoff_and_then_open_sending() {
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let mut scope = Scope::new(1, 2, 0x20, DeliveryMode::Push);
    let p = prepared();
    scope.binding.generation = id(0x999);
    let mut event = scope.event(
        "old:finished",
        EventPayload::TurnFinished {
            status: TurnFinishedStatus::Completed,
            reason: None,
            diagnostic_text: None,
            truncated: false,
        },
        Some(&p),
        Some("old-turn"),
    );
    event.generation = p.binding_generation.clone();
    let core = Arc::new(ClaimIdle {
        inner: service::ScriptedCoreService::new([
            scope.saved(scope.connected(), false),
            scope.inputs(vec![stored(&scope, &p)]),
            scope.inputs(vec![stored(&scope, &p)]),
            scope.saved(event.clone(), true),
        ]),
        claims: AtomicU64::new(0),
    });
    let adapter = Arc::new(Rechecking {
        inner: IdleProvider::new(vec![provider::ScriptStep {
            request: provider::RecordedRequest::Connect(scope.connect_request()),
            response: provider::ScriptedResponse::connect(Ok(scope.connection())),
        }]),
        reconciles: std::sync::Mutex::new(
            [
                ReconcileResult {
                    attempt_evidence: vec![],
                    unresolved_attempt_ids: vec![p.attempt_id.clone()],
                    next_checkpoint: None,
                },
                ReconcileResult {
                    attempt_evidence: vec![AttemptEvidence {
                        input_id: p.input_id.clone(),
                        attempt_id: p.attempt_id.clone(),
                        events: vec![event],
                    }],
                    unresolved_attempt_ids: vec![],
                    next_checkpoint: None,
                },
            ]
            .into(),
        ),
    });
    let (h, seen) = start_with_health(&rt, &owner, &scope, core.clone(), adapter);
    rt.block_on(eventually(|| !seen.lock().unwrap().is_empty()));
    {
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].state, SupervisorState::BackingOff);
        assert_eq!(
            seen[0].reason.as_deref(),
            Some("Checking whether an earlier answer reached Codex.")
        );
        assert_eq!(seen[0].retry_in_seconds, Some(1));
    }
    assert!(!h.progress().borrow().reconciled);
    assert_eq!(core.claims.load(Ordering::SeqCst), 0, "gate stays closed");
    rt.block_on(eventually(|| seen.lock().unwrap().len() == 2));
    assert!(h.progress().borrow().reconciled);
    // The counter moves inside `core.claim`; only a validated claim is settled,
    // so stopping earlier could interrupt one still in flight.
    rt.block_on(progress(h.progress(), |p| p.validated_claims > 0));
    assert!(core.claims.load(Ordering::SeqCst) > 0);
    assert_eq!(seen.lock().unwrap()[1].state, SupervisorState::Running);
    let exit = rt.block_on(h.stop()).unwrap();
    assert!(exit.error.is_none(), "{:?}", exit.error);
    assert_eq!(core.inner.remaining().unwrap(), 0);
}

#[test]
fn historical_attempts_are_reconciled_unchanged_before_gate_and_never_submitted() {
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let mut scope = Scope::new(1, 2, 0x20, DeliveryMode::Pull);
    let p = prepared();
    scope.binding.generation = id(0x999);
    let mut event = scope.event(
        "old:finished",
        EventPayload::TurnFinished {
            status: TurnFinishedStatus::Completed,
            reason: None,
            diagnostic_text: None,
            truncated: false,
        },
        Some(&p),
        Some("old-turn"),
    );
    event.generation = p.binding_generation.clone();
    let core = Arc::new(service::ScriptedCoreService::new([
        scope.saved(scope.connected(), false),
        scope.inputs(vec![stored(&scope, &p)]),
        scope.saved(event.clone(), true),
    ]));
    let result = ReconcileResult {
        attempt_evidence: vec![AttemptEvidence {
            input_id: p.input_id.clone(),
            attempt_id: p.attempt_id.clone(),
            events: vec![event],
        }],
        unresolved_attempt_ids: vec![],
        next_checkpoint: None,
    };
    let adapter = IdleProvider::new(scope.provider_start(vec![evidence(&p)], result));
    let h = scope.start(&rt, &owner, core.clone(), adapter.clone());
    rt.block_on(progress(h.progress(), |p| p.reconciled));
    let result = rt.block_on(h.stop()).unwrap();
    assert!(result.error.is_none());
    assert_eq!(core.remaining().unwrap(), 0);
    assert!(!adapter
        .script
        .history()
        .unwrap()
        .iter()
        .any(|r| matches!(r, provider::RecordedRequest::Submit(_))));
}

#[test]
fn actual_control_claims_are_gated_at_startup_and_stop_and_preserve_ready_replay() {
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let corpus = cases::load(root());
    let route = &corpus.routing;
    let lease = owner
        .binding_lease(
            route.session(),
            route.binding_id.clone(),
            route.generation.clone(),
        )
        .unwrap();
    let gate = ClaimGate::new();
    let prepared = prepared();
    let request = ClaimRequest {
        binding_id: route.binding_id.clone(),
        generation: prepared.binding_generation.clone(),
        request_id: id(0x500),
    };
    let core = Arc::new(service::ScriptedCoreService::new([service::ScriptStep {
        request: service::RecordedRequest::Claim(
            route.dispatch(route.generation.clone()),
            request.clone(),
        ),
        response: service::ScriptedResponse::Claim(Ok(Some(prepared.clone()))),
    }]));
    let server = ControlServer::bind(owner, core.clone(), vec![(lease, gate.clone())]).unwrap();
    let (stop, stopped) = oneshot::channel();
    let server = rt.spawn(server.serve(stopped));
    let req =
        ControlRequest::new(request.request_id.clone(), ControlMethod::Claim(request)).unwrap();
    assert_eq!(
        rt.block_on(call(home.path().to_owned(), req.clone()))
            .unwrap_err()
            .code,
        CoreErrorCode::HostUnreachable
    );
    assert!(core.history().unwrap().is_empty());
    gate.reconciled_from_trusted_native().unwrap();
    assert_eq!(
        rt.block_on(call(home.path().to_owned(), req.clone()))
            .unwrap(),
        ControlResult::Claim(Some(prepared))
    );
    gate.stop();
    assert_eq!(
        rt.block_on(call(home.path().to_owned(), req))
            .unwrap_err()
            .code,
        CoreErrorCode::HostUnreachable
    );
    assert_eq!(core.history().unwrap().len(), 1);
    stop.send(()).unwrap();
    rt.block_on(server).unwrap().unwrap();
    assert!(gate.reconciled_from_trusted_native().is_err());
}

async fn ended(mut p: watch::Receiver<SupervisorProgress>) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while p.changed().await.is_ok() {}
    })
    .await
    .unwrap();
}
/// Waits (bounded) for a native fact such as "the failing call was made".
async fn eventually(check: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !check() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}
fn health_sink() -> (
    Arc<std::sync::Mutex<Vec<SupervisorHealth>>>,
    Arc<ariadne_runtime::health::HealthObserver>,
) {
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = seen.clone();
    (
        seen,
        Arc::new(move |health| sink.lock().unwrap().push(health)),
    )
}
#[test]
fn late_facts_core_already_settled_are_acknowledged_and_later_claims_continue() {
    // A late host fact about a sealed attempt, or a contradiction Core already
    // retained, gets the same answer on every retry. The worker acknowledges it
    // instead of retrying it forever, so observation and claims carry on.
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let scope = Scope::new(1, 2, 0x20, DeliveryMode::Push);
    let p = prepared();
    let started = scope.event(
        "history:started",
        EventPayload::TurnStarted {},
        Some(&p),
        Some("turn"),
    );
    let (_, finished) = accepted_and_finished(&scope, &p);
    let sealed = CoreError::new(
        CoreErrorCode::AttemptSealed,
        "This attempt is sealed; new nonredundant facts cannot rewrite it",
        "Keep original IDs.",
    );
    let mut retained = CoreError::new(
        CoreErrorCode::ProtocolConflict,
        "Contradictory host facts were retained with an atomic dispatch barrier",
        "Keep original IDs.",
    );
    retained.current_revision = Some(PositiveSafeInteger::new(7).unwrap());
    retained.details = Some(Box::new(ErrorDetails {
        reason: Some(BarrierReason::DeliveryUncertain),
        binding_id: Some(scope.binding.id.clone()),
        input_id: Some(p.input_id.clone()),
        attempt_id: Some(p.attempt_id.clone()),
        blocking_item_ids: vec![],
        blocking_input_ids: vec![],
        dispatch_must_pause: true,
        partial_removal: None,
    }));
    let core = Arc::new(ClaimIdle {
        inner: service::ScriptedCoreService::new([
            scope.saved(scope.connected(), false),
            scope.inputs(vec![]),
            scope.report(started.clone(), Err(sealed), false),
            scope.report(finished.clone(), Err(retained), false),
        ]),
        claims: AtomicU64::new(0),
    });
    let cp = Checkpoint::new("page:late-facts").unwrap();
    let mut script = scope.provider_start(vec![], empty_reconcile());
    script.push(scope.observe(None, vec![started, finished], Some(cp.clone())));
    let (h, seen) = start_with_health(&rt, &owner, &scope, core.clone(), IdleProvider::new(script));
    // `ClaimIdle` counts inside `core.claim`, before the worker has the answer;
    // stopping then would interrupt a claim still in flight. Wait for the
    // validated claim instead.
    let observed = h.progress();
    rt.block_on(progress(observed.clone(), |p| p.validated_claims > 0));
    let settled = observed.borrow().clone();
    assert_eq!(settled.acknowledged_checkpoint, Some(cp));
    let exit = rt.block_on(h.stop()).unwrap();
    assert!(exit.error.is_none(), "{:?}", exit.error);
    assert!(exit.pending.is_none());
    assert_eq!(core.inner.remaining().unwrap(), 0);
    assert_eq!(
        core.inner.history().unwrap().len(),
        4,
        "each verdict is taken once, never retried"
    );
    assert!(
        seen.lock()
            .unwrap()
            .iter()
            .all(|health| health.state == SupervisorState::Running),
        "{:?}",
        seen.lock().unwrap()
    );
}

#[test]
fn the_log_names_error_codes_but_never_provider_or_core_message_text() {
    // ADR-0087: the log holds IDs and codes only. Error messages can carry text
    // a provider sent (for example a Codex server error), so they stay out.
    let rt = rt();
    let home = home();
    let log = ariadne_runtime::logging::init(home.path()).unwrap();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let scope = Scope::new(1, 2, 0x21, DeliveryMode::Push);
    let p = prepared();
    let (accepted, _) = accepted_and_finished(&scope, &p);
    let provider_text = |n: u8| {
        CoreError::new(
            if n == 1 {
                CoreErrorCode::HostUnreachable
            } else {
                CoreErrorCode::StaleGeneration
            },
            format!("codex server said: PROVIDER-SECRET-{n} for the owner's text"),
            "Keep original IDs.",
        )
    };
    let core = Arc::new(service::ScriptedCoreService::new([
        scope.saved(scope.connected(), false),
        scope.inputs(vec![]),
        scope.report(accepted.clone(), Err(provider_text(1)), false),
        scope.report(accepted.clone(), Err(provider_text(2)), false),
    ]));
    let mut script = scope.provider_start(vec![], empty_reconcile());
    script.push(scope.observe(None, vec![accepted], None));
    let (h, _) = start_with_health(&rt, &owner, &scope, core.clone(), IdleProvider::new(script));
    rt.block_on(ended(h.progress()));
    let exit = rt.block_on(h.stop()).unwrap();
    assert_eq!(exit.error.unwrap().code, CoreErrorCode::StaleGeneration);
    let text = fs::read_to_string(log).unwrap();
    let label = format!("binding={}", scope.binding.id.as_str());
    let lines: Vec<_> = text.lines().filter(|line| line.contains(&label)).collect();
    assert!(
        lines
            .iter()
            .any(|line| line.contains("cycle failed: HostUnreachable")),
        "{text}"
    );
    assert!(
        lines
            .iter()
            .any(|line| line.contains("stopped: StaleGeneration")),
        "{text}"
    );
    assert!(!text.contains("PROVIDER-SECRET"), "{text}");
    assert!(!text.contains("codex server said"), "{text}");
}

#[test]
fn full_diagnostic_ring_does_not_limit_durable_reconciliation_facts() {
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let scope = Scope::new(1, 2, 0x20, DeliveryMode::Pull);
    let p = prepared();
    let mut events: Vec<_> = (0..256)
        .map(|i| {
            scope.event(
                &format!("output:{i}"),
                EventPayload::VisibleOutput {
                    host_message_id: None,
                    phase: OutputPhase::Commentary,
                    operation: OutputOperation::Append,
                    text: format!("diagnostic {i}"),
                    truncated: false,
                    gap_before: false,
                },
                Some(&p),
                Some("turn"),
            )
        })
        .collect();
    events.push(scope.event(
        "output:redaction",
        EventPayload::VisibleOutput {
            host_message_id: None,
            phase: OutputPhase::Final,
            operation: OutputOperation::Replace,
            text: "public text\nauthorization: bearer example\nprivate reasoning example".into(),
            truncated: false,
            gap_before: false,
        },
        Some(&p),
        Some("turn"),
    ));
    events.push(scope.event(
        "terminal:completed",
        EventPayload::TurnFinished {
            status: TurnFinishedStatus::Completed,
            reason: None,
            diagnostic_text: Some("診".repeat(21000)),
            truncated: true,
        },
        Some(&p),
        Some("turn"),
    ));
    let mut steps = vec![
        scope.saved(scope.connected(), false),
        scope.inputs(vec![stored(&scope, &p)]),
    ];
    steps.extend(events.iter().cloned().map(|e| scope.saved(e, true)));
    let core = Arc::new(service::ScriptedCoreService::new(steps));
    let adapter = IdleProvider::new(scope.provider_start(
        vec![evidence(&p)],
        ReconcileResult {
            attempt_evidence: vec![AttemptEvidence {
                input_id: p.input_id.clone(),
                attempt_id: p.attempt_id.clone(),
                events,
            }],
            unresolved_attempt_ids: vec![],
            next_checkpoint: None,
        },
    ));
    let h = scope.start(&rt, &owner, core.clone(), adapter);
    rt.block_on(progress(h.progress(), |p| p.reconciled));
    let exit = rt.block_on(h.stop()).unwrap();
    assert!(exit.error.is_none(), "{:?}", exit.error);
    assert_eq!(core.remaining().unwrap(), 0);
    assert_eq!(exit.diagnostics.len(), 256);
    assert!(exit.diagnostics.first().unwrap().gap_before);
    assert!(exit.diagnostics.last().unwrap().truncated);
    assert!(exit.diagnostics.last().unwrap().text.len() <= 64 * 1024);
    let redacted = &exit.diagnostics[254].text;
    assert_eq!(
        redacted,
        "public text\n[redacted diagnostic]\n[redacted diagnostic]"
    );
    assert!(!core
        .history()
        .unwrap()
        .iter()
        .any(|r| matches!(r, service::RecordedRequest::Apply(..))));
}
#[test]
fn startup_unresolved_attempts_keep_real_control_claim_gate_closed() {
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let scope = Scope::new(1, 2, 0x20, DeliveryMode::Pull);
    let p = prepared();
    let core = Arc::new(service::ScriptedCoreService::new([
        scope.saved(scope.connected(), false),
        scope.inputs(vec![stored(&scope, &p)]),
    ]));
    let adapter = IdleProvider::new(scope.provider_start(
        vec![evidence(&p)],
        ReconcileResult {
            attempt_evidence: vec![],
            unresolved_attempt_ids: vec![p.attempt_id.clone()],
            next_checkpoint: None,
        },
    ));
    let h = scope.start(&rt, &owner, core.clone(), adapter);
    rt.block_on(progress(h.progress(), |p| p.validated_reports == 1));
    let server = ControlServer::bind(owner, core.clone(), vec![h.control_binding()]).unwrap();
    let (stop, stopped) = oneshot::channel();
    let server = rt.spawn(server.serve(stopped));
    let claim = ClaimRequest {
        binding_id: scope.binding.id.clone(),
        generation: scope.binding.generation.clone(),
        request_id: id(0x999),
    };
    let claim = ControlRequest::new(claim.request_id.clone(), ControlMethod::Claim(claim)).unwrap();
    assert_eq!(
        rt.block_on(call(home.path().into(), claim))
            .unwrap_err()
            .code,
        CoreErrorCode::HostUnreachable
    );
    let exit = rt.block_on(h.stop()).unwrap();
    assert!(exit.error.is_none());
    assert!(!core
        .history()
        .unwrap()
        .iter()
        .any(|r| matches!(r, service::RecordedRequest::Claim(..))));
    stop.send(()).unwrap();
    rt.block_on(server).unwrap().unwrap();
}
#[test]
fn failed_connection_reports_current_scoped_disconnect_without_a_dispatch_lease() {
    for (error, durable) in [
        (None, true),
        (None, false),
        (Some(CoreErrorCode::StaleGeneration), false),
        (Some(CoreErrorCode::StoreBusy), false),
    ] {
        let rt = rt();
        let home = home();
        let scope = Scope::new(1, 2, 0x20, DeliveryMode::Pull);
        let event = scope.event(
            &format!("runtime:disconnected:{}", id(scope.next).as_str()),
            EventPayload::Disconnected {
                reason: Some(
                    "Ariadne could not establish a qualified connection to this binding.".into(),
                ),
            },
            None,
            None,
        );
        let result = match error {
            None => Ok(scope.receipt(&event, durable)),
            Some(code) => Err(CoreError::new(
                code,
                "Connection fact could not be saved",
                "Retain this exact failure fact and its original event ID.",
            )),
        };
        let core = Arc::new(service::ScriptedCoreService::new([scope.report(
            event.clone(),
            result,
            false,
        )]));
        let adapter = IdleProvider::new(vec![provider::ScriptStep {
            request: provider::RecordedRequest::Connect(scope.connect_request()),
            response: provider::ScriptedResponse::connect(Err(AdapterError {
                code: AdapterErrorCode::HostUnreachable,
                message: "Endpoint unavailable".into(),
                retryable: false,
            })),
        }]);
        let failure = match rt.block_on(ConnectedSupervisor::connect(
            core.clone(),
            adapter,
            scope.session.clone(),
            scope.binding.clone(),
            scope.facts(),
        )) {
            Err(f) => f,
            Ok(_) => panic!("unexpected connection"),
        };
        assert_eq!(failure.cause.code, CoreErrorCode::HostUnreachable);
        match error {
            None => {
                assert!(failure.pending.is_none());
                assert!(failure.report_error.is_none());
            }
            Some(code) => {
                assert_eq!(failure.report_error.unwrap().code, code);
                let pending = failure.pending.unwrap();
                assert_eq!(pending.event, event);
                assert_eq!(
                    pending.context.current_generation(),
                    &scope.binding.generation
                );
            }
        }
        assert!(!home.path().join("run").exists());
        assert_eq!(core.remaining().unwrap(), 0);
        assert_eq!(core.history().unwrap().len(), 1);
    }
}

struct FaultCore {
    inner: service::ScriptedCoreService,
    target: String,
    fault: Fault,
}
enum Fault {
    Error(CoreError),
    Receipt,
    ReceiptScope,
}
impl CoreService for FaultCore {
    fn query(&self, c: QueryContext, r: QueryRequest) -> Result<QueryResult, CoreError> {
        self.inner.query(c, r)
    }
    fn execute_owner(
        &self,
        c: OwnerContext,
        r: OwnerCommand,
    ) -> Result<MutationReceipt, CoreError> {
        self.inner.execute_owner(c, r)
    }
    fn apply(&self, c: AgentContext, r: ApplyRequest) -> Result<ApplyReceipt, CoreError> {
        self.inner.apply(c, r)
    }
    fn claim(
        &self,
        c: ValidatedDispatchContext,
        r: ClaimRequest,
    ) -> Result<Option<PreparedAttempt>, CoreError> {
        self.inner.claim(c, r)
    }
    fn report(&self, c: AdapterContext, e: NormalizedEvent) -> Result<EventReceipt, CoreError> {
        let mut result = self.inner.report(c, e.clone());
        if e.event_id == self.target {
            match &self.fault {
                Fault::Error(error) => result = Err(error.clone()),
                Fault::Receipt => result.as_mut().unwrap().revision = None,
                Fault::ReceiptScope => result.as_mut().unwrap().event_id = "different-event".into(),
            }
        }
        result
    }
}
#[test]
fn malformed_core_errors_and_inconsistent_lifecycle_receipts_never_acknowledge() {
    let mut bad = CoreError::new(
        CoreErrorCode::DeliveryUncertain,
        "Delivery uncertain",
        "Keep original IDs.",
    );
    bad.retryable = true;
    for (fault, expected_code) in [
        (Fault::Error(bad), CoreErrorCode::ProtocolConflict),
        (Fault::Receipt, CoreErrorCode::InvalidArgument),
        (Fault::ReceiptScope, CoreErrorCode::BindingMismatch),
    ] {
        let rt = rt();
        let home = home();
        let owner = DesktopOwner::acquire(home.path()).unwrap();
        let scope = Scope::new(1, 2, 0x20, DeliveryMode::Pull);
        let p = prepared();
        let event = scope.event(
            "accepted",
            EventPayload::Accepted { receipt: None },
            Some(&p),
            None,
        );
        let core = Arc::new(FaultCore {
            inner: service::ScriptedCoreService::new([
                scope.saved(scope.connected(), false),
                scope.inputs(vec![]),
                scope.saved(event.clone(), false),
                // Retries (backoff, shutdown flush) meet the same fault.
                scope.saved(event.clone(), false),
                scope.saved(event.clone(), false),
            ]),
            target: event.event_id.clone(),
            fault,
        });
        let cp = Checkpoint::new("pending").unwrap();
        let mut script = scope.provider_start(vec![], empty_reconcile());
        script.push(scope.observe(None, vec![event.clone()], Some(cp.clone())));
        let adapter = IdleProvider::new(script);
        let h = scope.start(&rt, &owner, core.clone(), adapter.clone());
        rt.block_on(eventually(|| core.inner.remaining().unwrap() <= 2));
        let exit = rt.block_on(h.stop()).unwrap();
        let error = exit.error.unwrap();
        assert_eq!(error.code, expected_code);
        assert!(!error.retryable);
        assert_eq!(exit.acknowledged_checkpoint, None);
        let pending = exit.pending.unwrap();
        assert_eq!(pending.next_checkpoint, Some(cp));
        assert_eq!(pending.reports[0].event, event);
        assert_eq!(adapter.script.remaining().unwrap(), 0);
    }
}

struct SubmitBlocked {
    inner: Arc<IdleProvider>,
    began: std::sync::Mutex<Option<oneshot::Sender<SubmitRequest>>>,
}
impl Adapter for SubmitBlocked {
    fn probe(&self, r: ProbeRequest) -> AdapterFuture<'_, ProbeResult> {
        self.inner.probe(r)
    }
    fn connect(&self, r: ConnectRequest) -> AdapterFuture<'_, ConnectResult> {
        self.inner.connect(r)
    }
    fn reconcile(&self, r: ReconcileRequest) -> AdapterFuture<'_, ReconcileResult> {
        self.inner.reconcile(r)
    }
    fn observe(&self, r: ObserveRequest) -> AdapterFuture<'_, ObserveResult> {
        self.inner.observe(r)
    }
    fn disconnect(&self, r: DisconnectRequest) -> AdapterFuture<'_, DisconnectResult> {
        self.inner.disconnect(r)
    }
    fn submit(&self, r: SubmitRequest) -> AdapterFuture<'_, SubmitOutcome> {
        Box::pin(async move {
            self.began.lock().unwrap().take().unwrap().send(r).unwrap();
            std::future::pending().await
        })
    }
}
#[test]
fn cancellation_after_submit_admission_reports_uncertainty_and_keeps_external_host_alive() {
    use std::process::{Command, Stdio};
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let scope = Scope::new(1, 2, 0x20, DeliveryMode::Push);
    let p = prepared();
    let uncertain = scope.event(
        &terminal_event_id(
            &scope.binding.id,
            &scope.binding.generation,
            &p.attempt_id,
            None,
            TerminalEventKind::Uncertain,
            None,
        )
        .unwrap(),
        EventPayload::Uncertain {
            reason: "Desktop stopped during possible submission; delivery cannot be ruled out."
                .into(),
        },
        Some(&p),
        None,
    );
    let core = Arc::new(service::ScriptedCoreService::new([
        scope.saved(scope.connected(), false),
        scope.inputs(vec![]),
        scope.claim(Some(p.clone())),
        scope.saved(uncertain, false),
    ]));
    let mut script = scope.provider_start(vec![], empty_reconcile());
    script.push(scope.observe(None, vec![], None));
    let idle = IdleProvider::new(script);
    let (began, observed) = oneshot::channel();
    let adapter = Arc::new(SubmitBlocked {
        inner: idle.clone(),
        began: std::sync::Mutex::new(Some(began)),
    });
    let mut external = Command::new("/bin/cat")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let h = scope.start(&rt, &owner, core.clone(), adapter);
    let submitted = rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(2), observed)
            .await
            .unwrap()
            .unwrap()
    });
    assert_eq!(submitted.formatted_payload, p.formatted_payload);
    assert_eq!(submitted.payload_sha256, p.payload_sha256);
    assert_eq!(submitted.attempt_id, p.attempt_id);
    let exit = rt.block_on(h.stop()).unwrap();
    assert!(exit.error.is_none(), "{:?}", exit.error);
    assert!(exit.pending.is_none());
    assert_eq!(core.remaining().unwrap(), 0);
    assert_eq!(idle.stopped.load(Ordering::SeqCst), 1);
    assert!(external.try_wait().unwrap().is_none());
    drop(external.stdin.take());
    assert!(external.wait().unwrap().success());
    assert_eq!(
        core.history()
            .unwrap()
            .iter()
            .filter(|r| matches!(r, service::RecordedRequest::Claim(..)))
            .count(),
        1
    );
}
struct ClaimBlocked {
    inner: service::ScriptedCoreService,
    began: std::sync::Mutex<Option<oneshot::Sender<()>>>,
    release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    finished: std::sync::Mutex<Option<oneshot::Sender<()>>>,
}
impl CoreService for ClaimBlocked {
    fn query(&self, c: QueryContext, r: QueryRequest) -> Result<QueryResult, CoreError> {
        self.inner.query(c, r)
    }
    fn execute_owner(
        &self,
        c: OwnerContext,
        r: OwnerCommand,
    ) -> Result<MutationReceipt, CoreError> {
        self.inner.execute_owner(c, r)
    }
    fn apply(&self, c: AgentContext, r: ApplyRequest) -> Result<ApplyReceipt, CoreError> {
        self.inner.apply(c, r)
    }
    fn report(&self, c: AdapterContext, r: NormalizedEvent) -> Result<EventReceipt, CoreError> {
        self.inner.report(c, r)
    }
    fn claim(
        &self,
        c: ValidatedDispatchContext,
        r: ClaimRequest,
    ) -> Result<Option<PreparedAttempt>, CoreError> {
        let result = self.inner.claim(c, r);
        self.began.lock().unwrap().take().unwrap().send(()).unwrap();
        self.release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        self.finished
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .send(())
            .unwrap();
        result
    }
}
// Instrumented child inherits LLVM_PROFILE_FILE, following the control tests.
#[test]
fn binding_flock_child() {
    use std::os::fd::AsRawFd;
    let Some(path) = std::env::var_os("ARIADNE_SUPERVISOR_FLOCK") else {
        return;
    };
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .unwrap();
    let actual = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0 };
    assert_eq!(
        actual,
        std::env::var("ARIADNE_SUPERVISOR_FLOCK_FREE").unwrap() == "yes"
    );
}
fn probe_lease(home: &Path, binding: &UuidV4, free: bool) {
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "binding_flock_child", "--nocapture"])
        .env(
            "ARIADNE_SUPERVISOR_FLOCK",
            home.join(format!("run/leases/{}.lock", binding.as_str())),
        )
        .env(
            "ARIADNE_SUPERVISOR_FLOCK_FREE",
            if free { "yes" } else { "no" },
        )
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stdout)
    );
}
#[test]
fn stopped_started_claim_retains_physical_lease_and_original_id_while_other_binding_progresses() {
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let blocked = Scope::new(1, 2, 0x20, DeliveryMode::Push);
    let healthy = Scope::new(1, 3, 0x21, DeliveryMode::Pull);
    let (began, started) = oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let (done, finished) = oneshot::channel();
    let core = Arc::new(ClaimBlocked {
        inner: service::ScriptedCoreService::new([
            blocked.saved(blocked.connected(), false),
            blocked.inputs(vec![]),
            blocked.claim(None),
        ]),
        began: std::sync::Mutex::new(Some(began)),
        release: std::sync::Mutex::new(released),
        finished: std::sync::Mutex::new(Some(done)),
    });
    let mut script = blocked.provider_start(vec![], empty_reconcile());
    script.push(blocked.observe(None, vec![], None));
    let h = blocked.start(&rt, &owner, core.clone(), IdleProvider::new(script));
    rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(2), started)
            .await
            .unwrap()
            .unwrap()
    });
    let good_core = Arc::new(service::ScriptedCoreService::new([
        healthy.saved(healthy.connected(), false),
        healthy.inputs(vec![]),
    ]));
    let good = healthy.start(
        &rt,
        &owner,
        good_core,
        IdleProvider::new(healthy.provider_start(vec![], empty_reconcile())),
    );
    rt.block_on(progress(good.progress(), |p| p.reconciled));
    let exit = rt.block_on(h.stop()).unwrap();
    assert_eq!(exit.error.unwrap().code, CoreErrorCode::HostUnreachable);
    assert_eq!(exit.pending_claim.unwrap().request_id, id(blocked.next));
    probe_lease(home.path(), &blocked.binding.id, false);
    assert!(rt.block_on(good.stop()).unwrap().error.is_none());
    release.send(()).unwrap();
    rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(2), finished)
            .await
            .unwrap()
            .unwrap()
    });
    // A second scheduling barrier ensures the blocking closure has returned and
    // released its captured lease, rather than merely reaching its last line.
    rt.shutdown_timeout(Duration::from_secs(2));
    probe_lease(home.path(), &blocked.binding.id, true);
}

#[test]
fn restart_reconciles_persisted_attempts_with_fresh_checkpoint_and_never_resubmits() {
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let scope = Scope::new(1, 2, 0x20, DeliveryMode::Pull);
    let p = prepared();
    let terminal = scope.event(
        "persisted:finished",
        EventPayload::TurnFinished {
            status: TurnFinishedStatus::Completed,
            reason: None,
            diagnostic_text: None,
            truncated: false,
        },
        Some(&p),
        Some("turn"),
    );
    let cp = Checkpoint::new("old-instance:unacknowledged").unwrap();
    let core = Arc::new(service::ScriptedCoreService::new([
        scope.saved(scope.connected(), false),
        scope.inputs(vec![]),
        scope.report(
            terminal.clone(),
            Err(CoreError::new(
                CoreErrorCode::StoreBusy,
                "Store locked",
                "Retain the same event ID.",
            )),
            false,
        ),
        // The shutdown flush meets the same lock and hands the fact back.
        scope.report(
            terminal.clone(),
            Err(CoreError::new(
                CoreErrorCode::StoreBusy,
                "Store locked",
                "Retain the same event ID.",
            )),
            false,
        ),
        scope.saved(scope.connected(), false),
        scope.inputs(vec![stored(&scope, &p)]),
        scope.saved(terminal.clone(), true),
    ]));
    let mut first = scope.provider_start(vec![], empty_reconcile());
    first.push(scope.observe(None, vec![terminal.clone()], Some(cp)));
    let adapter = IdleProvider::new(first);
    let h = scope.start(&rt, &owner, core.clone(), adapter);
    rt.block_on(eventually(|| core.remaining().unwrap() == 4));
    let stopped = rt.block_on(h.stop()).unwrap();
    assert_eq!(stopped.error.unwrap().code, CoreErrorCode::StoreBusy);
    assert!(stopped.pending.is_some());
    assert_eq!(stopped.acknowledged_checkpoint, None);
    let recovered = ReconcileResult {
        attempt_evidence: vec![AttemptEvidence {
            input_id: p.input_id.clone(),
            attempt_id: p.attempt_id.clone(),
            events: vec![terminal],
        }],
        unresolved_attempt_ids: vec![],
        next_checkpoint: None,
    };
    let adapter = IdleProvider::new(scope.provider_start(vec![evidence(&p)], recovered));
    let restarted = scope.start(&rt, &owner, core.clone(), adapter.clone());
    rt.block_on(progress(restarted.progress(), |p| p.reconciled));
    let exit = rt.block_on(restarted.stop()).unwrap();
    assert!(exit.error.is_none());
    assert_eq!(core.remaining().unwrap(), 0);
    assert!(!adapter
        .script
        .history()
        .unwrap()
        .iter()
        .any(|r| matches!(r, provider::RecordedRequest::Submit(_))));
}
#[test]
fn revision_conflict_restarts_entire_paged_scan_before_enabling_dispatch() {
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let scope = Scope::new(1, 2, 0x20, DeliveryMode::Pull);
    let p = prepared();
    let cursor = QueryCursor {
        schema: SchemaVersion::new(1).unwrap(),
        view: QueryView::Inputs,
        filter_digest: Sha256::new("a".repeat(64)).unwrap(),
        after: Some(CursorPosition::Sequence {
            number: PositiveSafeInteger::new(2).unwrap(),
            id: p.input_id.clone(),
        }),
        revision: PositiveSafeInteger::new(1).unwrap(),
    };
    let mut first = scope.inputs(vec![stored(&scope, &p)]);
    if let service::ScriptedResponse::Query(response) = &mut first.response {
        let Ok(QueryResult::SessionRead(SessionReadResult::Inputs(page))) = response.as_mut()
        else {
            unreachable!()
        };
        page.next_cursor = Some(cursor.clone());
    }
    let mut later = scope.inputs(vec![]);
    if let service::RecordedRequest::Query(_, request) = &mut later.request {
        let QueryRequest::SessionRead(request) = request.as_mut() else {
            unreachable!()
        };
        request.cursor = Some(cursor);
    }
    later.response = service::ScriptedResponse::Query(Box::new(Err(CoreError::new(
        CoreErrorCode::SnapshotChanged,
        "Snapshot changed",
        "Restart from the first page.",
    ))));
    let core = Arc::new(service::ScriptedCoreService::new([
        scope.saved(scope.connected(), false),
        first,
        later,
        scope.inputs(vec![stored(&scope, &p)]),
    ]));
    let adapter = IdleProvider::new(scope.provider_start(
        vec![evidence(&p)],
        ReconcileResult {
            attempt_evidence: vec![AttemptEvidence {
                input_id: p.input_id.clone(),
                attempt_id: p.attempt_id.clone(),
                events: vec![],
            }],
            unresolved_attempt_ids: vec![],
            next_checkpoint: None,
        },
    ));
    let h = scope.start(&rt, &owner, core.clone(), adapter);
    rt.block_on(progress(h.progress(), |p| p.reconciled));
    let exit = rt.block_on(h.stop()).unwrap();
    assert!(exit.error.is_none(), "{:?}", exit.error);
    assert_eq!(core.remaining().unwrap(), 0);
}
#[test]
fn diagnostic_byte_budget_is_lossy_with_explicit_gap_but_lifecycle_is_retained() {
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let scope = Scope::new(1, 2, 0x20, DeliveryMode::Pull);
    let p = prepared();
    let mut events: Vec<_> = (0..40)
        .map(|i| {
            scope.event(
                &format!("large:{i}"),
                EventPayload::VisibleOutput {
                    host_message_id: None,
                    phase: OutputPhase::Commentary,
                    operation: OutputOperation::Append,
                    text: "x".repeat(64 * 1024),
                    truncated: false,
                    gap_before: false,
                },
                Some(&p),
                Some("turn"),
            )
        })
        .collect();
    events.push(scope.event(
        "finished",
        EventPayload::TurnFinished {
            status: TurnFinishedStatus::Completed,
            reason: None,
            diagnostic_text: None,
            truncated: false,
        },
        Some(&p),
        Some("turn"),
    ));
    let mut script = vec![
        scope.saved(scope.connected(), false),
        scope.inputs(vec![stored(&scope, &p)]),
    ];
    script.extend(events.iter().cloned().map(|e| scope.saved(e, true)));
    let core = Arc::new(service::ScriptedCoreService::new(script));
    let adapter = IdleProvider::new(scope.provider_start(
        vec![evidence(&p)],
        ReconcileResult {
            attempt_evidence: vec![AttemptEvidence {
                input_id: p.input_id.clone(),
                attempt_id: p.attempt_id.clone(),
                events,
            }],
            unresolved_attempt_ids: vec![],
            next_checkpoint: None,
        },
    ));
    let h = scope.start(&rt, &owner, core.clone(), adapter);
    rt.block_on(progress(h.progress(), |p| p.reconciled));
    let exit = rt.block_on(h.stop()).unwrap();
    assert!(exit.error.is_none());
    assert_eq!(exit.diagnostics.len(), 32);
    assert!(exit.diagnostics[0].gap_before);
    assert_eq!(
        exit.diagnostics.iter().map(|d| d.text.len()).sum::<usize>(),
        2 * 1024 * 1024
    );
    assert_eq!(core.remaining().unwrap(), 0);
}

#[test]
fn more_than_one_hundred_persisted_attempts_are_scanned_and_reconciled_before_any_push_claim() {
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let scope = Scope::new(1, 2, 0x20, DeliveryMode::Push);
    let base = prepared();
    let digests: Vec<Sha256> = paged_attempt_digests::DIGESTS
        .into_iter()
        .map(|value| Sha256::new(value).unwrap())
        .collect();
    assert_eq!(digests.len(), 101);
    let attempts: Vec<_> = digests
        .into_iter()
        .enumerate()
        .map(|(n, digest)| {
            let mut p = base.clone();
            p.input_id = id(0x10000 + n as u64);
            p.attempt_id = id(0x20000 + n as u64);
            p.wire_marker = format!(
                "[ARIADNE_INPUT:{}:{}]",
                p.input_id.as_str(),
                p.attempt_id.as_str()
            );
            p.formatted_payload =
                base.formatted_payload
                    .replacen(&base.wire_marker, &p.wire_marker, 1);
            p.payload_sha256 = digest;
            p.validate_for(&ClaimRequest {
                binding_id: scope.binding.id.clone(),
                generation: scope.binding.generation.clone(),
                request_id: id(0x30000 + n as u64),
            })
            .unwrap();
            p
        })
        .collect();
    let inputs: Vec<_> = attempts
        .iter()
        .enumerate()
        .map(|(n, p)| {
            let mut input = stored(&scope, p);
            input.seq = PositiveSafeInteger::new(n as u64 + 1).unwrap();
            input.state = InputState::NeedsAttention;
            input
        })
        .collect();
    let cursor = QueryCursor {
        schema: SchemaVersion::new(1).unwrap(),
        view: QueryView::Inputs,
        filter_digest: Sha256::new("a".repeat(64)).unwrap(),
        after: Some(CursorPosition::Sequence {
            number: inputs[99].seq,
            id: inputs[99].id.clone(),
        }),
        revision: PositiveSafeInteger::new(1).unwrap(),
    };
    let mut first = scope.inputs(inputs[..100].to_vec());
    if let service::ScriptedResponse::Query(response) = &mut first.response {
        let Ok(QueryResult::SessionRead(SessionReadResult::Inputs(page))) = response.as_mut()
        else {
            unreachable!()
        };
        page.next_cursor = Some(cursor.clone());
    }
    let mut second = scope.inputs(inputs[100..].to_vec());
    if let service::RecordedRequest::Query(_, request) = &mut second.request {
        let QueryRequest::SessionRead(request) = request.as_mut() else {
            unreachable!()
        };
        request.cursor = Some(cursor);
    }
    let core = Arc::new(service::ScriptedCoreService::new([
        scope.saved(scope.connected(), false),
        first,
        second,
        scope.claim(None),
    ]));
    let result = |batch: &[PreparedAttempt]| ReconcileResult {
        attempt_evidence: batch
            .iter()
            .map(|p| AttemptEvidence {
                input_id: p.input_id.clone(),
                attempt_id: p.attempt_id.clone(),
                events: vec![],
            })
            .collect(),
        unresolved_attempt_ids: vec![],
        next_checkpoint: None,
    };
    let mut provider = scope.provider_start(
        attempts[..100].iter().map(evidence).collect(),
        result(&attempts[..100]),
    );
    provider.push(provider::ScriptStep {
        request: provider::RecordedRequest::Reconcile(ReconcileRequest {
            binding_id: scope.binding.id.clone(),
            generation: scope.binding.generation.clone(),
            attempts: attempts[100..].iter().map(evidence).collect(),
            checkpoint: None,
        }),
        response: provider::ScriptedResponse::Reconcile(Ok(result(&attempts[100..]))),
    });
    provider.push(scope.observe(None, vec![], None));
    let adapter = IdleProvider::new(provider);
    let h = scope.start(&rt, &owner, core.clone(), adapter.clone());
    rt.block_on(progress(h.progress(), |p| p.validated_claims == 1));
    let exit = rt.block_on(h.stop()).unwrap();
    assert!(exit.error.is_none());
    assert_eq!(core.remaining().unwrap(), 0);
    assert_eq!(adapter.script.remaining().unwrap(), 0);
    let history = core.history().unwrap();
    assert!(matches!(history[1], service::RecordedRequest::Query(..)));
    assert!(matches!(history[2], service::RecordedRequest::Query(..)));
    assert!(matches!(history[3], service::RecordedRequest::Claim(..)));
}

#[test]
fn push_uses_only_exact_prepared_payload_and_reports_validated_delivery_outcome() {
    for outcome in [
        SubmitOutcome::Accepted {
            receipt: Some(HostReceipt {
                provider_reference: "actual-provider-reference".into(),
                observed_at: at(),
            }),
        },
        SubmitOutcome::RejectedBeforeDelivery {
            reason: "Sender rejected before delivery".into(),
        },
    ] {
        let rt = rt();
        let home = home();
        let owner = DesktopOwner::acquire(home.path()).unwrap();
        let scope = Scope::new(1, 2, 0x20, DeliveryMode::Push);
        let p = prepared();
        let (event_id, payload) = match &outcome {
            SubmitOutcome::Accepted { receipt } => (
                format!(
                    "runtime:accepted:{}:{}:{}",
                    scope.binding.id.as_str(),
                    scope.binding.generation.as_str(),
                    p.attempt_id.as_str()
                ),
                EventPayload::Accepted {
                    receipt: receipt.clone(),
                },
            ),
            SubmitOutcome::RejectedBeforeDelivery { reason } => (
                terminal_event_id(
                    &scope.binding.id,
                    &scope.binding.generation,
                    &p.attempt_id,
                    None,
                    TerminalEventKind::Rejected,
                    None,
                )
                .unwrap(),
                EventPayload::Rejected {
                    reason: reason.clone(),
                },
            ),
            _ => unreachable!(),
        };
        let event = scope.event(&event_id, payload, Some(&p), None);
        let core = Arc::new(service::ScriptedCoreService::new([
            scope.saved(scope.connected(), false),
            scope.inputs(vec![]),
            scope.claim(Some(p.clone())),
            scope.saved(event, false),
        ]));
        let mut script = scope.provider_start(vec![], empty_reconcile());
        script.push(scope.observe(None, vec![], None));
        script.push(provider::ScriptStep {
            request: provider::RecordedRequest::Submit(SubmitRequest {
                binding_id: scope.binding.id.clone(),
                generation: scope.binding.generation.clone(),
                input_id: p.input_id.clone(),
                attempt_id: p.attempt_id.clone(),
                formatted_payload: p.formatted_payload,
                payload_sha256: p.payload_sha256,
                wire_marker: p.wire_marker,
            }),
            response: provider::ScriptedResponse::Submit(Ok(outcome)),
        });
        let adapter = IdleProvider::new(script);
        let h = scope.start(&rt, &owner, core.clone(), adapter.clone());
        rt.block_on(progress(h.progress(), |p| p.validated_reports == 2));
        let exit = rt.block_on(h.stop()).unwrap();
        assert!(exit.error.is_none());
        assert_eq!(core.remaining().unwrap(), 0);
        assert_eq!(adapter.script.remaining().unwrap(), 0);
        assert_eq!(
            adapter
                .script
                .history()
                .unwrap()
                .iter()
                .filter(|r| matches!(r, provider::RecordedRequest::Submit(_)))
                .count(),
            1
        );
    }
}
#[test]
fn repeated_input_sequence_and_cursor_stop_scan_without_enabling_claims() {
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let scope = Scope::new(1, 2, 0x20, DeliveryMode::Push);
    let p = prepared();
    let input = stored(&scope, &p);
    let cursor = QueryCursor {
        schema: SchemaVersion::new(1).unwrap(),
        view: QueryView::Inputs,
        filter_digest: Sha256::new("a".repeat(64)).unwrap(),
        after: Some(CursorPosition::Sequence {
            number: input.seq,
            id: input.id.clone(),
        }),
        revision: PositiveSafeInteger::new(1).unwrap(),
    };
    let mut first = scope.inputs(vec![input.clone()]);
    if let service::ScriptedResponse::Query(response) = &mut first.response {
        let Ok(QueryResult::SessionRead(SessionReadResult::Inputs(page))) = response.as_mut()
        else {
            unreachable!()
        };
        page.next_cursor = Some(cursor.clone());
    }
    let mut repeated = scope.inputs(vec![input]);
    if let service::RecordedRequest::Query(_, request) = &mut repeated.request {
        let QueryRequest::SessionRead(request) = request.as_mut() else {
            unreachable!()
        };
        request.cursor = Some(cursor);
    }
    let core = Arc::new(service::ScriptedCoreService::new([
        scope.saved(scope.connected(), false),
        first,
        repeated,
    ]));
    let adapter = IdleProvider::new(scope.provider_start(vec![], empty_reconcile()));
    let (h, seen) = start_with_health(&rt, &owner, &scope, core.clone(), adapter.clone());
    // The scan fails, the worker backs off with the gate closed, and stop
    // hands back the unresolved cause.
    rt.block_on(eventually(|| !seen.lock().unwrap().is_empty()));
    assert_eq!(seen.lock().unwrap()[0].state, SupervisorState::BackingOff);
    assert!(!h.progress().borrow().reconciled);
    let exit = rt.block_on(h.stop()).unwrap();
    assert_eq!(exit.error.unwrap().code, CoreErrorCode::ProtocolConflict);
    assert_eq!(core.remaining().unwrap(), 0);
    assert_eq!(adapter.script.remaining().unwrap(), 1);
    assert!(!core
        .history()
        .unwrap()
        .iter()
        .any(|r| matches!(r, service::RecordedRequest::Claim(..))));
}

struct QueryBlocked {
    inner: service::ScriptedCoreService,
    began: std::sync::Mutex<Option<oneshot::Sender<()>>>,
    release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
}
impl CoreService for QueryBlocked {
    fn query(&self, c: QueryContext, r: QueryRequest) -> Result<QueryResult, CoreError> {
        let result = self.inner.query(c, r);
        self.began.lock().unwrap().take().unwrap().send(()).unwrap();
        self.release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        result
    }
    fn execute_owner(
        &self,
        c: OwnerContext,
        r: OwnerCommand,
    ) -> Result<MutationReceipt, CoreError> {
        self.inner.execute_owner(c, r)
    }
    fn apply(&self, c: AgentContext, r: ApplyRequest) -> Result<ApplyReceipt, CoreError> {
        self.inner.apply(c, r)
    }
    fn claim(
        &self,
        c: ValidatedDispatchContext,
        r: ClaimRequest,
    ) -> Result<Option<PreparedAttempt>, CoreError> {
        self.inner.claim(c, r)
    }
    fn report(&self, c: AdapterContext, r: NormalizedEvent) -> Result<EventReceipt, CoreError> {
        self.inner.report(c, r)
    }
}
#[test]
fn stop_during_revision_conflict_scan_never_restarts_query_or_enables_dispatch() {
    let rt = rt();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let scope = Scope::new(1, 2, 0x20, DeliveryMode::Push);
    let mut query = scope.inputs(vec![]);
    query.response = service::ScriptedResponse::Query(Box::new(Err(CoreError::new(
        CoreErrorCode::SnapshotChanged,
        "Snapshot changed",
        "Restart the scan.",
    ))));
    let (began, started) = oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let core = Arc::new(QueryBlocked {
        inner: service::ScriptedCoreService::new([scope.saved(scope.connected(), false), query]),
        began: std::sync::Mutex::new(Some(began)),
        release: std::sync::Mutex::new(released),
    });
    let adapter = IdleProvider::new(scope.provider_start(vec![], empty_reconcile()));
    let h = scope.start(&rt, &owner, core.clone(), adapter.clone());
    let gate = h.control_binding();
    drop(gate.0);
    rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(2), started)
            .await
            .unwrap()
            .unwrap()
    });
    let exit = rt.block_on(h.stop()).unwrap();
    assert!(exit.error.is_none());
    assert!(gate.1.reconciled_from_trusted_native().is_err());
    release.send(()).unwrap();
    rt.shutdown_timeout(Duration::from_secs(2));
    assert_eq!(core.inner.history().unwrap().len(), 2);
    assert_eq!(core.inner.remaining().unwrap(), 0);
    assert_eq!(adapter.script.remaining().unwrap(), 1);
}
