//! V08/V09: real native Core/atomic Store, with only host adapters faked.
use ariadne_agent_protocol::*;
use ariadne_core::{
    bindings::VerifiedHost,
    native::{AgentResolver, NativeCoreService},
    *,
};
use ariadne_domain::models::*;
use ariadne_runtime::{control::*, leases::DesktopOwner, supervisor::*};
use std::{
    collections::VecDeque,
    fs,
    os::unix::fs::PermissionsExt,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::oneshot;

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn at() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
}
fn reference(name: &str) -> RequestRef {
    RequestRef::new(name).unwrap()
}
fn request(op_id: UuidV4) -> ApplyRequest {
    ApplyRequest {
        op_id,
        source_input_id: None,
        attempt_id: None,
        expected_item_revisions: UniqueMap(Default::default()),
        expected_topic_revisions: UniqueMap(Default::default()),
        summary: String::new(),
        operations: vec![],
        input_result: None,
    }
}
async fn until(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("supervisor must make the expected durable progress");
}

/// A host fact source, with no queue eligibility, result join or persistence logic.
struct Host {
    binding: Binding,
    submissions: Mutex<Vec<SubmitRequest>>,
    events: Mutex<VecDeque<NormalizedEvent>>,
    reconciliations: Mutex<Vec<ReconcileRequest>>,
    reconciliation_result: Mutex<Option<ReconcileResult>>,
    connects: AtomicU64,
    observations: AtomicU64,
    hold_observation: AtomicBool,
    observation_held: AtomicBool,
    disconnects: AtomicU64,
}
impl Host {
    fn new(binding: Binding) -> Arc<Self> {
        Arc::new(Self {
            binding,
            submissions: Mutex::new(vec![]),
            events: Mutex::new(VecDeque::new()),
            reconciliations: Mutex::new(vec![]),
            reconciliation_result: Mutex::new(None),
            connects: AtomicU64::new(0),
            observations: AtomicU64::new(0),
            hold_observation: AtomicBool::new(false),
            observation_held: AtomicBool::new(false),
            disconnects: AtomicU64::new(0),
        })
    }
    fn event(&self, input: &Input, payload: EventPayload) -> NormalizedEvent {
        let attempt = &input.attempts[0];
        let kind = match payload {
            EventPayload::Accepted { .. } => "accepted",
            EventPayload::TurnStarted {} => "started",
            EventPayload::TurnFinished { .. } => "finished",
            _ => panic!("unexpected fixture lifecycle"),
        };
        NormalizedEvent {
            event_id: format!("fixture:{kind}:{}", attempt.id.as_str()),
            binding_id: self.binding.id.clone(),
            generation: self.binding.generation.clone(),
            input_id: Some(input.id.clone()),
            attempt_id: Some(attempt.id.clone()),
            host_turn_id: (kind != "accepted").then(|| format!("turn:{}", attempt.id.as_str())),
            observed_at: at(),
            event: payload,
        }
    }
    fn emit(&self, input: &Input, payload: EventPayload) {
        self.events
            .lock()
            .unwrap()
            .push_back(self.event(input, payload));
    }
}
impl Adapter for Host {
    fn probe(&self, _: ProbeRequest) -> AdapterFuture<'_, ProbeResult> {
        panic!("fixture starts from a qualified saved binding")
    }
    fn connect(&self, request: ConnectRequest) -> AdapterFuture<'_, ConnectResult> {
        Box::pin(async move {
            assert_eq!(request.binding_id, self.binding.id);
            assert_eq!(request.generation, self.binding.generation);
            self.connects.fetch_add(1, Ordering::SeqCst);
            Ok(ConnectResult {
                external_session_id: self.binding.external_session_id.clone(),
                endpoint_fingerprint: self.binding.endpoint_fingerprint.clone(),
                capabilities: self.binding.capabilities.clone(),
                observation: PresenceObservation {
                    instance_id: id(900),
                    generation: self.binding.generation.clone(),
                    connection_state: ConnectionState::Connected,
                    execution_state: ExecutionState::Idle,
                    last_seen_at: Some(at()),
                    source: Some(PresenceSource::HostPoll),
                    process_identity: None,
                    freshness: Freshness::Fresh,
                },
            })
        })
    }
    fn submit(&self, request: SubmitRequest) -> AdapterFuture<'_, SubmitOutcome> {
        Box::pin(async move {
            assert_eq!(self.binding.capabilities.delivery_mode, DeliveryMode::Push);
            assert_eq!(request.binding_id, self.binding.id);
            assert_eq!(request.generation, self.binding.generation);
            self.submissions.lock().unwrap().push(request);
            Ok(SubmitOutcome::Accepted { receipt: None })
        })
    }
    fn observe(&self, request: ObserveRequest) -> AdapterFuture<'_, ObserveResult> {
        Box::pin(async move {
            assert_eq!(request.binding_id, self.binding.id);
            assert_eq!(request.generation, self.binding.generation);
            self.observations.fetch_add(1, Ordering::SeqCst);
            if self.hold_observation.load(Ordering::SeqCst) {
                self.observation_held.store(true, Ordering::SeqCst);
                // Cancellation detaches this observer, not the running host turn.
                std::future::pending::<()>().await;
            }
            Ok(ObserveResult {
                events: self.events.lock().unwrap().drain(..).collect(),
                next_checkpoint: None,
            })
        })
    }
    fn reconcile(&self, request: ReconcileRequest) -> AdapterFuture<'_, ReconcileResult> {
        Box::pin(async move {
            self.reconciliations.lock().unwrap().push(request.clone());
            if let Some(result) = self.reconciliation_result.lock().unwrap().take() {
                return Ok(result);
            }
            Ok(ReconcileResult {
                attempt_evidence: vec![],
                unresolved_attempt_ids: request
                    .attempts
                    .iter()
                    .map(|a| a.attempt_id.clone())
                    .collect(),
                next_checkpoint: None,
            })
        })
    }
    fn disconnect(&self, _: DisconnectRequest) -> AdapterFuture<'_, DisconnectResult> {
        Box::pin(async move {
            self.disconnects.fetch_add(1, Ordering::SeqCst);
            Ok(DisconnectResult {})
        })
    }
}

struct Lane {
    route: RegisteredSession,
    host: Arc<Host>,
    inputs: Vec<UuidV4>,
}
impl Lane {
    fn owner(&self) -> OwnerContext {
        OwnerContext::from_trusted_entrypoint(OwnerScope::Session(self.route.clone()))
    }
    fn adapter(&self) -> AdapterContext {
        AdapterContext::from_trusted_entrypoint(
            self.route.clone(),
            self.host.binding.id.clone(),
            self.host.binding.generation.clone(),
            None,
        )
    }
}
struct Setup {
    home: tempfile::TempDir,
    _projects: Vec<tempfile::TempDir>,
    core: Arc<NativeCoreService>,
    next: Arc<AtomicU64>,
    owner: Arc<DesktopOwner>,
    lanes: Vec<Lane>,
}
impl Setup {
    fn new() -> Self {
        let home = tempfile::Builder::new()
            .prefix("ariadne-fifo-")
            .tempdir_in("/tmp")
            .unwrap();
        fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let next = Arc::new(AtomicU64::new(1000));
        let allocated = next.clone();
        let seed: Session =
            serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json"))
                .unwrap();
        let template = seed.bindings.0[&id(3)].clone();
        let core = Arc::new(NativeCoreService::new(
            AgentResolver::open_data_directory(home.path()).unwrap(),
            move || id(allocated.fetch_add(1, Ordering::SeqCst)),
            at,
            move |params| {
                let mut capabilities = template.capabilities.clone();
                capabilities.delivery_mode = if params.external_session_id == "pull" {
                    DeliveryMode::Pull
                } else {
                    DeliveryMode::Push
                };
                Ok(VerifiedHost {
                    adapter_id: params.adapter_id.clone(),
                    adapter_version: template.adapter_version.clone(),
                    protocol_major: template.protocol_major,
                    config_version: template.config_version,
                    external_session_id: params.external_session_id.clone(),
                    endpoint: params.endpoint.clone(),
                    endpoint_fingerprint: template.endpoint_fingerprint.clone(),
                    configuration: params.configuration.clone(),
                    capabilities,
                    compatibility: Compatibility::Compatible,
                    availability: Availability::Available,
                    connection_state: ConnectionState::Connected,
                    cli_invocation: "ariadne".into(),
                    host_location: None,
                    setup_instruction: "Fixture qualified host; no live process.".into(),
                })
            },
        ));
        let projects: Vec<_> = (0..2).map(|_| tempfile::tempdir().unwrap()).collect();
        let mut project_ids = vec![];
        for root in &projects {
            let MutationReceipt::ProjectRegistered(receipt) = core
                .execute_owner(
                    OwnerContext::from_trusted_entrypoint(OwnerScope::Registry),
                    OwnerCommand::ProjectRegister {
                        api_version: SchemaVersion::new(1).unwrap(),
                        op_id: id(next.fetch_add(1, Ordering::SeqCst)),
                        params: ProjectRegisterParams {
                            canonical_root: root.path().to_str().unwrap().into(),
                        },
                    },
                )
                .unwrap()
            else {
                panic!("project registration receipt")
            };
            project_ids.push(receipt.project_id);
        }
        let owner = Arc::new(DesktopOwner::acquire(home.path()).unwrap());
        let mut setup = Self {
            home,
            _projects: projects,
            core,
            next,
            owner,
            lanes: vec![],
        };
        for (project, name) in [(0, "push-a"), (0, "push-b"), (1, "pull")] {
            setup.add_lane(project_ids[project].clone(), name);
        }
        setup
    }
    fn uuid(&self) -> UuidV4 {
        id(self.next.fetch_add(1, Ordering::SeqCst))
    }
    fn add_lane(&mut self, project_id: UuidV4, name: &str) {
        let MutationReceipt::Session(receipt) = self
            .core
            .execute_owner(
                OwnerContext::from_trusted_entrypoint(OwnerScope::Registry),
                OwnerCommand::BindingConnect {
                    api_version: SchemaVersion::new(1).unwrap(),
                    op_id: self.uuid(),
                    params: BindingConnectParams {
                        project_id: project_id.clone(),
                        adapter_id: "fake.local".into(),
                        external_session_id: name.into(),
                        endpoint: EndpointRef::LocalBridge { name: name.into() },
                        configuration: AdapterConfig {
                            namespace: "fake.local".into(),
                            values: UniqueMap(Default::default()),
                        },
                        existing_session_id: None,
                    },
                },
            )
            .unwrap()
        else {
            panic!("binding connect receipt")
        };
        let SavedReceiptData::BindingConnect { binding_id, .. } = &receipt.data else {
            panic!("binding connect data")
        };
        let route =
            RegisteredSession::from_trusted_entrypoint(project_id, receipt.session_id.clone());
        let session = self.read_route(&route);
        let binding = session.bindings.0[binding_id].clone();
        let mut initial = request(self.uuid());
        initial.operations = vec![
            Operation::TopicAdd {
                r#ref: reference("topic"),
                name: format!("{name} topic"),
                short: None,
            },
            Operation::ItemAdd(Box::new(ItemAddOperation {
                r#ref: reference("item"),
                topic: UuidRef::Local(LocalRef {
                    r#ref: reference("topic"),
                }),
                parent: None,
                question: format!("{name} question"),
                short: None,
                item_type: ItemType::Question,
                status: ItemStatus::Open,
                owner: ItemOwner::Agent {
                    binding_id: binding.id.clone(),
                },
                ask: None,
                options: None,
                note: None,
                links: None,
                related: None,
                outcome: None,
                why: None,
                replaced_by: None,
                source_round_id: None,
            })),
        ];
        self.core
            .apply(
                AgentContext::from_trusted_entrypoint(
                    route.clone(),
                    binding.id.clone(),
                    binding.generation.clone(),
                    AgentReadScope::Terminal {
                        issued_through_message_number: binding.issued_through_message_number,
                    },
                ),
                initial,
            )
            .unwrap();
        let mut lane = Lane {
            route,
            host: Host::new(binding),
            inputs: vec![],
        };
        let session = self.read(&lane);
        let topic_id = session.topics.0.keys().next().unwrap().clone();
        for number in 0..5 {
            let MutationReceipt::Session(receipt) = self
                .core
                .execute_owner(
                    lane.owner(),
                    OwnerCommand::InputSubmit {
                        api_version: SchemaVersion::new(1).unwrap(),
                        op_id: self.uuid(),
                        params: InputSubmitParams {
                            binding_id: lane.host.binding.id.clone(),
                            target: InputTarget {
                                topic_id: topic_id.clone(),
                                item_id: Some(ItemRef::new("1").unwrap()),
                            },
                            kind: InputKind::Reply,
                            text: format!("{name} owner input {number}: exact café\n"),
                            selected_option_id: None,
                            expected_question_revision: None,
                            supersedes_answer_id: None,
                        },
                    },
                )
                .unwrap()
            else {
                panic!("input receipt")
            };
            let SavedReceiptData::InputSubmit { input_id, .. } = receipt.data else {
                panic!("input data")
            };
            lane.inputs.push(input_id);
        }
        self.lanes.push(lane);
    }
    fn read_route(&self, route: &RegisteredSession) -> Session {
        let QueryResult::SessionGet(snapshot) = self
            .core
            .query(
                QueryContext::owner(OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
                    route.clone(),
                ))),
                QueryRequest::SessionGet {},
            )
            .unwrap()
        else {
            panic!("session projection")
        };
        snapshot.session
    }
    fn read(&self, lane: &Lane) -> Session {
        self.read_route(&lane.route)
    }
    fn result_request(&self, lane: &Lane, number: usize) -> (AgentContext, ApplyRequest) {
        let session = self.read(lane);
        let input = &session.inputs.0[&lane.inputs[number]];
        let attempt = &input.attempts[0];
        let message = session
            .messages
            .iter()
            .find(|m| m.id == input.message_id)
            .unwrap();
        let context = AgentContext::from_trusted_entrypoint(
            lane.route.clone(),
            lane.host.binding.id.clone(),
            lane.host.binding.generation.clone(),
            AgentReadScope::Dispatched {
                source_input_id: input.id.clone(),
                attempt_id: attempt.id.clone(),
                issued_through_message_number: NonnegativeSafeInteger::new(message.number.value())
                    .unwrap(),
            },
        );
        let mut result = request(self.uuid());
        result.source_input_id = Some(input.id.clone());
        result.attempt_id = Some(attempt.id.clone());
        result.expected_item_revisions.0.insert(
            ItemRef::new("1").unwrap(),
            session.items.0[&ItemRef::new("1").unwrap()].revision,
        );
        result.operations.push(Operation::Reply {
            r#ref: reference("reply"),
            item: EntityRef::Existing(ExistingRef {
                id: ItemRef::new("1").unwrap(),
            }),
            text: format!(
                "{} explicit reply {number}",
                lane.host.binding.external_session_id
            ),
            round_id: None,
        });
        result.input_result = Some(ResultDraft {
            outcome: ResultOutcome::Deferred,
            explanation: format!("{} result {number}", lane.host.binding.external_session_id),
            reply_refs: vec![UuidRef::Local(LocalRef {
                r#ref: reference("reply"),
            })],
            followup_item_refs: vec![],
            handled_through_message_number: message.number,
        });
        (context, result)
    }
    fn publish_result(&self, lane: &Lane, number: usize) {
        let (context, request) = self.result_request(lane, number);
        let receipt = self.core.apply(context.clone(), request.clone()).unwrap();
        assert_eq!(
            self.core.apply(context, request).unwrap(),
            receipt,
            "exact result retry must not duplicate reply or sealing"
        );
    }
    async fn pull_claim(&self, lane: &Lane) -> Option<PreparedAttempt> {
        let request_id = self.uuid();
        let ControlResult::Claim(attempt) = call(
            self.home.path().into(),
            ControlRequest::new(
                request_id.clone(),
                ControlMethod::Claim(ClaimRequest {
                    binding_id: lane.host.binding.id.clone(),
                    generation: lane.host.binding.generation.clone(),
                    request_id,
                }),
            )
            .unwrap(),
        )
        .await
        .unwrap() else {
            panic!("claim response")
        };
        attempt
    }
    async fn launch(
        &self,
    ) -> (
        Vec<SupervisorHandle>,
        oneshot::Sender<()>,
        tokio::task::JoinHandle<Result<(), CoreError>>,
    ) {
        let mut handles = vec![];
        for lane in &self.lanes {
            lane.host.observation_held.store(false, Ordering::SeqCst);
            lane.host.hold_observation.store(false, Ordering::SeqCst);
            let next = self.next.clone();
            let connected = ConnectedSupervisor::connect(
                self.core.clone(),
                lane.host.clone(),
                lane.route.clone(),
                lane.host.binding.clone(),
                NativeFacts {
                    next_id: Arc::new(move || id(next.fetch_add(1, Ordering::SeqCst))),
                    now: Arc::new(at),
                },
            )
            .await
            .unwrap();
            handles.push(
                connected
                    .start(
                        self.owner
                            .binding_lease_shared(
                                lane.route.clone(),
                                lane.host.binding.id.clone(),
                                lane.host.binding.generation.clone(),
                            )
                            .unwrap(),
                    )
                    .unwrap(),
            );
        }
        let server = ControlServer::bind_shared(
            self.owner.clone(),
            self.core.clone(),
            handles
                .iter()
                .map(SupervisorHandle::control_binding)
                .collect(),
        )
        .unwrap();
        let (stop, stopped) = oneshot::channel();
        let server = tokio::spawn(server.serve(stopped));
        (handles, stop, server)
    }
    async fn start(
        &self,
    ) -> (
        Vec<SupervisorHandle>,
        oneshot::Sender<()>,
        tokio::task::JoinHandle<Result<(), CoreError>>,
    ) {
        let started = self.launch().await;
        until(|| started.0.iter().all(|h| h.progress().borrow().reconciled)).await;
        started
    }
    async fn begin(&self, lane: &Lane, number: usize) {
        if lane.host.binding.capabilities.delivery_mode == DeliveryMode::Pull {
            assert!(lane.host.submissions.lock().unwrap().is_empty());
            let attempt = self.pull_claim(lane).await.expect("eligible pull input");
            assert_eq!(attempt.input_id, lane.inputs[number]);
            let input = self.read(lane).inputs.0[&lane.inputs[number]].clone();
            lane.host
                .emit(&input, EventPayload::Accepted { receipt: None });
        } else {
            until(|| lane.host.submissions.lock().unwrap().len() == number + 1).await;
            let request = lane.host.submissions.lock().unwrap()[number].clone();
            let session = self.read(lane);
            let input = &session.inputs.0[&lane.inputs[number]];
            let attempt = &input.attempts[0];
            assert_eq!(request.input_id, input.id);
            assert_eq!(request.attempt_id, attempt.id);
            assert_eq!(request.formatted_payload, attempt.formatted_payload);
            assert_eq!(request.payload_sha256, attempt.payload_sha256);
            assert_eq!(request.wire_marker, attempt.wire_marker);
        }
        let input = self.read(lane).inputs.0[&lane.inputs[number]].clone();
        lane.host.emit(&input, EventPayload::TurnStarted {});
        until(|| {
            self.read(lane).inputs.0[&lane.inputs[number]].attempts[0].turn_state
                == TurnState::Running
        })
        .await;
        self.assert_one_active(lane, number);
    }
    fn assert_one_active(&self, lane: &Lane, number: usize) {
        let session = self.read(lane);
        assert_eq!(
            session
                .inputs
                .0
                .values()
                .filter(|i| i.active_attempt_id.is_some())
                .count(),
            1
        );
        let input = &session.inputs.0[&lane.inputs[number]];
        assert_eq!(input.state, InputState::InFlight);
        assert_eq!(input.attempts.len(), 1);
        assert!(input.attempts[0].sealed_at.is_none());
        for id in &lane.inputs[number + 1..] {
            let next = &session.inputs.0[id];
            assert_eq!(next.state, InputState::Queued);
            assert!(next.attempts.is_empty());
        }
    }
    async fn finish_host(&self, lane: &Lane, number: usize) {
        let input = self.read(lane).inputs.0[&lane.inputs[number]].clone();
        lane.host.emit(
            &input,
            EventPayload::TurnFinished {
                status: TurnFinishedStatus::Completed,
                reason: None,
                diagnostic_text: Some("terminal output is diagnostic only".into()),
                truncated: false,
            },
        );
        until(|| {
            self.read(lane).inputs.0[&lane.inputs[number]].attempts[0].turn_state
                == TurnState::Completed
        })
        .await;
    }
    async fn complete(&self, lane: &Lane, number: usize) {
        let result_first = number.is_multiple_of(2);
        if result_first {
            self.publish_result(lane, number);
        } else {
            self.finish_host(lane, number).await;
        }
        // Observe actual additional scheduling passes while the other half is absent.
        let observed = lane.host.observations.load(Ordering::SeqCst);
        until(|| lane.host.observations.load(Ordering::SeqCst) >= observed + 2).await;
        self.assert_one_active(lane, number);
        if lane.host.binding.capabilities.delivery_mode == DeliveryMode::Pull {
            assert!(self.pull_claim(lane).await.is_none());
        } else {
            assert_eq!(lane.host.submissions.lock().unwrap().len(), number + 1);
        }
        let held = self.read(lane).inputs.0[&lane.inputs[number]].attempts[0].clone();
        assert_eq!(
            held.result_state,
            if result_first {
                ResultState::Committed
            } else {
                ResultState::Pending
            }
        );
        assert_eq!(
            held.turn_state,
            if result_first {
                TurnState::Running
            } else {
                TurnState::Completed
            }
        );
        if result_first {
            self.finish_host(lane, number).await;
        } else {
            self.publish_result(lane, number);
        }
        until(|| self.read(lane).inputs.0[&lane.inputs[number]].state == InputState::Handled).await;
        let done = self.read(lane).inputs.0[&lane.inputs[number]].attempts[0].clone();
        assert!(done.sealed_at.is_some());
        assert_eq!(done.result_state, ResultState::Committed);
        assert_eq!(done.turn_state, TurnState::Completed);
    }
    fn pause(&self, lane: &Lane, paused: bool) {
        let params = BindingStateParams {
            binding_id: lane.host.binding.id.clone(),
            expected_generation: lane.host.binding.generation.clone(),
        };
        self.core
            .execute_owner(
                lane.owner(),
                if paused {
                    OwnerCommand::BindingPause {
                        api_version: SchemaVersion::new(1).unwrap(),
                        op_id: self.uuid(),
                        params,
                    }
                } else {
                    OwnerCommand::BindingResume {
                        api_version: SchemaVersion::new(1).unwrap(),
                        op_id: self.uuid(),
                        params,
                    }
                },
            )
            .unwrap();
    }
    async fn quiesce_observers(&self) {
        for lane in &self.lanes {
            lane.host.hold_observation.store(true, Ordering::SeqCst);
        }
        until(|| {
            self.lanes
                .iter()
                .all(|lane| lane.host.observation_held.load(Ordering::SeqCst))
        })
        .await;
        // A worker reaches observe only after its prior Core call has returned.
        // Holding it here prevents the next push claim while keeping saved host
        // execution untouched. Counts alone cannot identify this safe boundary.
    }
}

async fn stop_all(
    setup: &Setup,
    handles: Vec<SupervisorHandle>,
    stop: oneshot::Sender<()>,
    server: tokio::task::JoinHandle<Result<(), CoreError>>,
) {
    setup.quiesce_observers().await;
    for handle in handles {
        let exit = handle.stop().await.unwrap();
        assert!(exit.error.is_none(), "{exit:?}");
        assert!(exit.pending.is_none());
        assert!(exit.pending_claim.is_none());
    }
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn three_bindings_run_five_fifo_turns_with_both_join_orders_and_independent_pause() {
    let setup = Setup::new();
    let (handles, stop, server) = setup.start().await;
    let a = &setup.lanes[0];
    let b = &setup.lanes[1];
    let c = &setup.lanes[2];
    assert_eq!(a.route.project_id(), b.route.project_id());
    assert_ne!(a.route.session_id(), b.route.session_id());
    assert_ne!(a.route.project_id(), c.route.project_id());
    for lane in &setup.lanes {
        setup.begin(lane, 0).await;
    }
    // All three have actual in-flight work before any one is allowed to finish.
    for lane in &setup.lanes {
        setup.assert_one_active(lane, 0);
    }
    setup.pause(a, true);
    for number in 0..5 {
        if number > 0 {
            setup.begin(b, number).await;
            setup.begin(c, number).await;
        }
        tokio::join!(setup.complete(b, number), setup.complete(c, number));
        setup.assert_one_active(a, 0);
        assert_eq!(a.host.submissions.lock().unwrap().len(), 1);
        assert!(setup.read(a).bindings.0[&a.host.binding.id].owner_paused);
    }
    setup.complete(a, 0).await;
    let observed = a.host.observations.load(Ordering::SeqCst);
    until(|| a.host.observations.load(Ordering::SeqCst) >= observed + 2).await;
    assert_eq!(a.host.submissions.lock().unwrap().len(), 1);
    assert_eq!(
        setup.read(a).inputs.0[&a.inputs[1]].state,
        InputState::Queued
    );
    setup.pause(a, false);
    for number in 1..5 {
        setup.begin(a, number).await;
        setup.complete(a, number).await;
    }
    stop_all(&setup, handles, stop, server).await;
    // Reopen the actual registry/Core instead of relying on a worker's memory.
    let reopened = NativeCoreService::new(
        AgentResolver::open_data_directory(setup.home.path()).unwrap(),
        || panic!("read only"),
        at,
        |_| panic!("read only"),
    );
    for lane in &setup.lanes {
        let QueryResult::SessionGet(snapshot) = reopened
            .query(
                QueryContext::owner(lane.owner()),
                QueryRequest::SessionGet {},
            )
            .unwrap()
        else {
            panic!("session")
        };
        let session = snapshot.session;
        assert_eq!(session.inputs.0.len(), 5);
        let replies: Vec<_> = session
            .messages
            .iter()
            .filter(|m| m.kind == MessageKind::Reply)
            .collect();
        assert_eq!(
            replies.len(),
            5,
            "terminal text and result retries must not create extra replies"
        );
        for (number, input_id) in lane.inputs.iter().enumerate() {
            let input = &session.inputs.0[input_id];
            assert_eq!(input.seq.value(), number as u64 + 1);
            assert_eq!(input.binding_id, lane.host.binding.id);
            assert_eq!(
                input.payload.text,
                format!(
                    "{} owner input {number}: exact café\n",
                    lane.host.binding.external_session_id
                )
            );
            assert_eq!(input.state, InputState::Handled);
            assert!(input.active_attempt_id.is_none());
            assert_eq!(input.attempts.len(), 1);
            let attempt = &input.attempts[0];
            assert_eq!(attempt.binding_generation, lane.host.binding.generation);
            assert_eq!(
                attempt.host_turn_id.as_deref(),
                Some(format!("turn:{}", attempt.id.as_str()).as_str())
            );
            let result = attempt.domain_result.as_ref().unwrap();
            assert_eq!(
                result.explanation,
                format!("{} result {number}", lane.host.binding.external_session_id)
            );
            assert_eq!(result.reply_message_ids.len(), 1);
            let owner = session
                .messages
                .iter()
                .find(|m| m.id == input.message_id)
                .unwrap();
            assert_eq!(
                result.handled_through_message_number.value(),
                owner.number.value()
            );
            let reply = replies
                .iter()
                .find(|m| m.id == result.reply_message_ids[0])
                .unwrap();
            assert_eq!(
                reply.body,
                format!(
                    "{} explicit reply {number}",
                    lane.host.binding.external_session_id
                )
            );
            assert_eq!(reply.binding_id.as_ref(), Some(&lane.host.binding.id));
            assert_eq!(reply.input_id.as_ref(), Some(input_id));
            assert_eq!(reply.attempt_id.as_ref(), Some(&attempt.id));
            assert!(attempt.sealed_at.is_some());
        }
        assert_eq!(
            session.bindings.0[&lane.host.binding.id].generation,
            lane.host.binding.generation
        );
        assert_eq!(lane.host.disconnects.load(Ordering::SeqCst), 1);
        let submissions = lane.host.submissions.lock().unwrap();
        if lane.host.binding.capabilities.delivery_mode == DeliveryMode::Pull {
            assert!(submissions.is_empty());
        } else {
            assert_eq!(
                submissions.iter().map(|s| &s.input_id).collect::<Vec<_>>(),
                lane.inputs.iter().collect::<Vec<_>>()
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn actual_core_rejects_foreign_binding_and_generation_events_and_results_without_writes() {
    let setup = Setup::new();
    let (handles, stop, server) = setup.start().await;
    for lane in &setup.lanes {
        setup.begin(lane, 0).await;
    }
    let a = &setup.lanes[0];
    let before: Vec<_> = setup.lanes.iter().map(|lane| setup.read(lane)).collect();
    let input = before[0].inputs.0[&a.inputs[0]].clone();
    let finished = a.host.event(
        &input,
        EventPayload::TurnFinished {
            status: TurnFinishedStatus::Completed,
            reason: None,
            diagnostic_text: None,
            truncated: false,
        },
    );
    let (context, result) = setup.result_request(a, 0);
    for recipient in &setup.lanes[1..] {
        assert_eq!(
            setup
                .core
                .report(recipient.adapter(), finished.clone())
                .unwrap_err()
                .code,
            CoreErrorCode::BindingMismatch
        );
        // Even an envelope retargeted to the recipient cannot borrow A's attempt.
        let mut foreign_attempt = finished.clone();
        foreign_attempt.binding_id = recipient.host.binding.id.clone();
        foreign_attempt.generation = recipient.host.binding.generation.clone();
        assert_eq!(
            setup
                .core
                .report(recipient.adapter(), foreign_attempt)
                .unwrap_err()
                .code,
            CoreErrorCode::InvalidRef
        );
        let wrong_binding = AgentContext::from_trusted_entrypoint(
            recipient.route.clone(),
            recipient.host.binding.id.clone(),
            recipient.host.binding.generation.clone(),
            context.read_scope().clone(),
        );
        assert_eq!(
            setup
                .core
                .apply(wrong_binding, result.clone())
                .unwrap_err()
                .code,
            CoreErrorCode::InvalidRef
        );
    }
    let mut stale = finished.clone();
    stale.generation = id(999);
    let stale_context = AdapterContext::from_trusted_entrypoint(
        a.route.clone(),
        a.host.binding.id.clone(),
        id(999),
        None,
    );
    assert_eq!(
        setup.core.report(stale_context, stale).unwrap_err().code,
        CoreErrorCode::StaleGeneration
    );
    let stale = AgentContext::from_trusted_entrypoint(
        a.route.clone(),
        a.host.binding.id.clone(),
        id(999),
        context.read_scope().clone(),
    );
    assert_eq!(
        setup.core.apply(stale, result).unwrap_err().code,
        CoreErrorCode::StaleGeneration
    );
    for (lane, snapshot) in setup.lanes.iter().zip(before) {
        assert_eq!(
            setup.read(lane),
            snapshot,
            "rejected foreign facts/results must make no durable changes"
        );
    }
    for lane in &setup.lanes {
        setup.complete(lane, 0).await;
    }
    stop_all(&setup, handles, stop, server).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn quit_and_supervisor_restart_reconcile_saved_work_before_claiming_without_resend() {
    let setup = Setup::new();
    let lane = &setup.lanes[0];
    // Other bindings retain queued work throughout this bounded restart journey.
    for other in &setup.lanes[1..] {
        setup.pause(other, true);
    }
    let (mut handles, stop, server) = setup.start().await;
    setup.begin(lane, 0).await;
    until(|| handles[0].progress().borrow().validated_claims >= 2).await;
    setup.quiesce_observers().await;
    let saved = setup.read(lane);
    let input = saved.inputs.0[&lane.inputs[0]].clone();
    let attempt = &input.attempts[0];
    handles[0].request_stop();
    let request_id = setup.uuid();
    let claim = ControlRequest::new(
        request_id.clone(),
        ControlMethod::Claim(ClaimRequest {
            binding_id: lane.host.binding.id.clone(),
            generation: lane.host.binding.generation.clone(),
            request_id,
        }),
    )
    .unwrap();
    assert_eq!(
        call(setup.home.path().into(), claim)
            .await
            .unwrap_err()
            .code,
        CoreErrorCode::HostUnreachable
    );
    stop_all(&setup, handles, stop, server).await;
    assert_eq!(
        setup.read(lane),
        saved,
        "quit must not mutate the saved attempt, binding generation or user pause"
    );
    assert_eq!(lane.host.submissions.lock().unwrap().len(), 1);
    assert_eq!(lane.host.disconnects.load(Ordering::SeqCst), 1);
    // Shutdown releases the physical dispatch lease, while the same fake host
    // still owns its running turn. It disconnects observation, not host execution.
    drop(
        setup
            .owner
            .binding_lease_shared(
                lane.route.clone(),
                lane.host.binding.id.clone(),
                lane.host.binding.generation.clone(),
            )
            .unwrap(),
    );
    assert_eq!(attempt.turn_state, TurnState::Running);
    lane.host.reconciliations.lock().unwrap().clear();
    let (handles, stop, server) = setup.launch().await;
    until(|| lane.host.reconciliations.lock().unwrap().len() >= 2).await;
    let expected = AttemptEvidenceRequest {
        input_id: input.id.clone(),
        attempt_id: attempt.id.clone(),
        binding_generation: attempt.binding_generation.clone(),
        payload_sha256: attempt.payload_sha256.clone(),
        wire_marker: attempt.wire_marker.clone(),
        host_turn_id: attempt.host_turn_id.clone(),
    };
    for request in lane.host.reconciliations.lock().unwrap().iter() {
        assert_eq!(
            request.attempts,
            vec![expected.clone()],
            "restart must inspect the exact persisted attempt"
        );
        assert!(
            request.checkpoint.is_none(),
            "new observer cannot inherit volatile progress"
        );
    }
    assert_eq!(lane.host.connects.load(Ordering::SeqCst), 2);
    assert!(!handles[0].progress().borrow().reconciled);
    assert_eq!(handles[0].progress().borrow().validated_claims, 0);
    assert_eq!(
        lane.host.submissions.lock().unwrap().len(),
        1,
        "unresolved work must not be blindly resent"
    );
    assert_eq!(setup.read(lane), saved);
    let request_id = setup.uuid();
    let claim = ControlRequest::new(
        request_id.clone(),
        ControlMethod::Claim(ClaimRequest {
            binding_id: lane.host.binding.id.clone(),
            generation: lane.host.binding.generation.clone(),
            request_id,
        }),
    )
    .unwrap();
    assert_eq!(
        call(setup.home.path().into(), claim)
            .await
            .unwrap_err()
            .code,
        CoreErrorCode::HostUnreachable
    );
    // The original host finishes after desktop observation has stopped. On
    // reconnection it supplies correlated evidence, without another submission.
    let finished = lane.host.event(
        &input,
        EventPayload::TurnFinished {
            status: TurnFinishedStatus::Completed,
            reason: None,
            diagnostic_text: Some("Original host completed while observer was detached.".into()),
            truncated: false,
        },
    );
    *lane.host.reconciliation_result.lock().unwrap() = Some(ReconcileResult {
        attempt_evidence: vec![AttemptEvidence {
            input_id: input.id.clone(),
            attempt_id: attempt.id.clone(),
            events: vec![finished],
        }],
        unresolved_attempt_ids: vec![],
        next_checkpoint: None,
    });
    until(|| {
        handles[0].progress().borrow().reconciled
            && handles[0].progress().borrow().validated_claims >= 2
    })
    .await;
    setup.assert_one_active(lane, 0);
    assert_eq!(
        lane.host.submissions.lock().unwrap().len(),
        1,
        "host completion without a result cannot admit queued input 2"
    );
    let reconciled = setup.read(lane);
    assert_eq!(
        reconciled.inputs.0[&input.id].attempts[0].turn_state,
        TurnState::Completed
    );
    assert_eq!(
        reconciled.inputs.0[&input.id].attempts[0].result_state,
        ResultState::Pending
    );
    setup.publish_result(lane, 0);
    setup.begin(lane, 1).await;
    assert_eq!(
        setup.read(lane).inputs.0[&input.id].state,
        InputState::Handled
    );
    assert_eq!(
        lane.host
            .submissions
            .lock()
            .unwrap()
            .iter()
            .map(|s| &s.input_id)
            .collect::<Vec<_>>(),
        lane.inputs[..2].iter().collect::<Vec<_>>()
    );
    setup.pause(lane, true);
    setup.complete(lane, 1).await;
    let observed = lane.host.observations.load(Ordering::SeqCst);
    until(|| lane.host.observations.load(Ordering::SeqCst) >= observed + 2).await;
    stop_all(&setup, handles, stop, server).await;
    let final_state = setup.read(lane);
    assert_eq!(
        final_state.bindings.0[&lane.host.binding.id].generation,
        lane.host.binding.generation
    );
    assert_eq!(final_state.inputs.0[&input.id].attempts.len(), 1);
    assert_eq!(final_state.inputs.0[&input.id].attempts[0].id, attempt.id);
    for id in &lane.inputs[2..] {
        assert_eq!(final_state.inputs.0[id].state, InputState::Queued);
        assert!(final_state.inputs.0[id].attempts.is_empty());
    }
    for other in &setup.lanes[1..] {
        assert!(other.host.submissions.lock().unwrap().is_empty());
        assert!(setup
            .read(other)
            .inputs
            .0
            .values()
            .all(|input| input.state == InputState::Queued && input.attempts.is_empty()));
    }
    assert_eq!(lane.host.disconnects.load(Ordering::SeqCst), 2);
}
