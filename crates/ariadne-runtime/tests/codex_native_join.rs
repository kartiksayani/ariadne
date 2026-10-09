//! P3.6: native Core/Store/supervisor with the real Codex adapter and queue subprocess.
use ariadne_agent_protocol::*;
use ariadne_core::{
    native::{AgentResolver, NativeCoreService},
    *,
};
use ariadne_domain::models::*;
use ariadne_runtime::{
    discovery::Discovery,
    health::{SupervisorHealth, SupervisorState},
    leases::DesktopOwner,
    providers::{PreparedProviderAdapter, ProviderFactory, ProviderInstructions},
    supervisor::*,
};
use serde_json::json;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

#[path = "fixtures/codex_native_join/host.rs"]
mod host;
use host::{Host, THREAD};

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn at() -> UtcMillis {
    UtcMillis::new("2026-10-05T12:00:00.000Z").unwrap()
}
fn empty_apply(op_id: UuidV4) -> ApplyRequest {
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
    tokio::time::timeout(Duration::from_secs(6), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("expected durable native progress");
}
struct Setup {
    home: tempfile::TempDir,
    _project: tempfile::TempDir,
    host: Host,
    core: Arc<NativeCoreService>,
    owner: Arc<DesktopOwner>,
    factory: ProviderFactory,
    route: RegisteredSession,
    binding_id: UuidV4,
    inputs: Vec<UuidV4>,
    next: Arc<AtomicU64>,
    prepared: Option<PreparedProviderAdapter>,
    initial: Option<SupervisorHandle>,
    /// Every supervisor health entry published by any started worker.
    health: Arc<std::sync::Mutex<Vec<SupervisorHealth>>>,
}
impl Setup {
    async fn new(lose_receipt: bool) -> Self {
        let home = tempfile::Builder::new()
            .prefix("ariadne-codex-core-")
            .tempdir_in("/tmp")
            .unwrap();
        fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let project = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(project.path()).unwrap();
        let host = Host::new(&root, lose_receipt);
        let next = Arc::new(AtomicU64::new(100));
        let allocated = next.clone();
        let core = Arc::new(NativeCoreService::new(
            AgentResolver::open_data_directory(home.path()).unwrap(),
            move || id(allocated.fetch_add(1, Ordering::SeqCst)),
            at,
            |_| panic!("native request-local qualification is authoritative"),
        ));
        let MutationReceipt::ProjectRegistered(project_receipt) = core
            .execute_owner(
                OwnerContext::from_trusted_entrypoint(OwnerScope::Registry),
                OwnerCommand::ProjectRegister {
                    api_version: SchemaVersion::new(1).unwrap(),
                    op_id: id(1),
                    params: ProjectRegisterParams {
                        canonical_root: root.to_str().unwrap().into(),
                    },
                },
            )
            .unwrap()
        else {
            panic!("project receipt")
        };
        let roots = core.clone();
        let allocated = next.clone();
        let factory = ProviderFactory::new(
            Arc::new(move |project| Ok(roots.registry().resolve_project(project)?.root)),
            Discovery::new(Arc::new(at), None),
            None,
            Some(host.options.clone()),
            NativeFacts {
                next_id: Arc::new(move || id(allocated.fetch_add(1, Ordering::SeqCst))),
                now: Arc::new(at),
            },
            ProviderInstructions {
                claude: "unused".into(),
                codex: "Publish full item replies and one explicit result for every input.".into(),
                cli_invocation: "ariadne".into(),
            },
        );
        let mut qualified = None;
        let MutationReceipt::Session(receipt) = core
            .connect_before(
                OwnerContext::from_trusted_entrypoint(OwnerScope::Registry),
                OwnerCommand::BindingConnect {
                    api_version: SchemaVersion::new(1).unwrap(),
                    op_id: id(2),
                    params: BindingConnectParams {
                        project_id: project_receipt.project_id.clone(),
                        adapter_id: "codex".into(),
                        external_session_id: THREAD.into(),
                        endpoint: host.endpoint.clone(),
                        configuration: AdapterConfig {
                            namespace: "codex".into(),
                            values: UniqueMap(Default::default()),
                        },
                        existing_session_id: None,
                    },
                },
                Instant::now() + Duration::from_secs(10),
                |params, deadline| {
                    let provider = factory.qualify_before(params, deadline)?;
                    let result = provider.host.clone();
                    qualified = Some(provider);
                    Ok(result)
                },
            )
            .unwrap()
        else {
            panic!("binding receipt")
        };
        let SavedReceiptData::BindingConnect { binding_id, .. } = &receipt.data else {
            panic!("binding data")
        };
        let route = RegisteredSession::from_trusted_entrypoint(
            project_receipt.project_id,
            receipt.session_id,
        );
        let owner = Arc::new(DesktopOwner::acquire(home.path()).unwrap());
        let mut setup = Self {
            home,
            _project: project,
            host,
            core,
            owner,
            factory,
            route,
            binding_id: binding_id.clone(),
            inputs: vec![],
            next,
            prepared: Some(qualified.unwrap().into_adapter(id(3)).unwrap()),
            initial: None,
            health: Default::default(),
        };
        let initial_handle = setup.start().await;
        until(|| initial_handle.progress().borrow().reconciled).await;
        let binding = setup.binding();
        let mut initial = empty_apply(setup.uuid());
        initial.operations = vec![
            Operation::TopicAdd {
                r#ref: RequestRef::new("topic").unwrap(),
                name: "Codex native join".into(),
                short: None,
            },
            Operation::ItemAdd(Box::new(ItemAddOperation {
                r#ref: RequestRef::new("item").unwrap(),
                topic: UuidRef::Local(LocalRef {
                    r#ref: RequestRef::new("topic").unwrap(),
                }),
                parent: None,
                question: "Preserve this full item question and owner reply".into(),
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
        setup.initial = Some(initial_handle);
        setup
            .core
            .apply(
                AgentContext::from_trusted_entrypoint(
                    setup.route.clone(),
                    binding.id.clone(),
                    binding.generation,
                    AgentReadScope::Terminal {
                        issued_through_message_number: binding.issued_through_message_number,
                    },
                ),
                initial,
            )
            .unwrap();
        let topic_id = setup.read().topics.0.keys().next().unwrap().clone();
        for number in 0..2 {
            let MutationReceipt::Session(receipt) = setup
                .core
                .execute_owner(
                    setup.owner_context(),
                    OwnerCommand::InputSubmit {
                        api_version: SchemaVersion::new(1).unwrap(),
                        op_id: setup.uuid(),
                        params: InputSubmitParams {
                            binding_id: setup.binding_id.clone(),
                            target: InputTarget {
                                topic_id: topic_id.clone(),
                                item_id: Some(ItemRef::new("1").unwrap()),
                            },
                            kind: InputKind::Reply,
                            text: format!(
                                "owner {number}: exact café\n`$HOME` $(touch ignored) ' \""
                            ),
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
            setup.inputs.push(input_id);
        }
        setup
    }
    fn uuid(&self) -> UuidV4 {
        id(self.next.fetch_add(1, Ordering::SeqCst))
    }
    fn owner_context(&self) -> OwnerContext {
        OwnerContext::from_trusted_entrypoint(OwnerScope::Session(self.route.clone()))
    }
    fn read(&self) -> Session {
        let QueryResult::SessionGet(snapshot) = self
            .core
            .query(
                QueryContext::owner(self.owner_context()),
                QueryRequest::SessionGet {},
            )
            .unwrap()
        else {
            panic!("session")
        };
        snapshot.session
    }
    fn binding(&self) -> Binding {
        self.read().bindings.0[&self.binding_id].clone()
    }
    fn first(&self) -> Input {
        self.read().inputs.0[&self.inputs[0]].clone()
    }
    async fn start(&mut self) -> SupervisorHandle {
        if let Some(initial) = self.initial.take() {
            return initial;
        }
        let binding = self.binding();
        let prepared = match self.prepared.take() {
            Some(prepared) => prepared,
            None => self
                .factory
                .qualify_before(
                    &BindingConnectParams {
                        project_id: self.route.project_id().clone(),
                        adapter_id: binding.adapter_id.clone(),
                        external_session_id: binding.external_session_id.clone(),
                        endpoint: binding.endpoint.clone(),
                        configuration: binding.adapter_config.clone(),
                        existing_session_id: Some(self.route.session_id().clone()),
                    },
                    Instant::now() + Duration::from_secs(10),
                )
                .unwrap()
                .into_adapter(self.uuid())
                .unwrap(),
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        ConnectedSupervisor::connect_before(
            self.core.clone(),
            prepared.adapter,
            self.route.clone(),
            binding.clone(),
            self.factory.facts().clone(),
            deadline,
            move |request| (prepared.initial_connect)(request, deadline),
        )
        .await
        .unwrap()
        .with_health_observer({
            let sink = self.health.clone();
            Arc::new(move |health| sink.lock().unwrap().push(health))
        })
        .start(
            self.owner
                .binding_lease_shared(self.route.clone(), binding.id, binding.generation)
                .unwrap(),
        )
        .unwrap()
    }
    fn assert_original(&self, original: &Input) {
        let actual = self.first();
        assert_eq!(actual.id, original.id);
        assert_eq!(actual.seq, original.seq);
        assert_eq!(actual.payload, original.payload);
        assert_eq!(actual.attempts.len(), 1);
        let held = &original.attempts[0];
        let current = &actual.attempts[0];
        assert_eq!(current.id, held.id);
        assert_eq!(current.claim_request_id, held.claim_request_id);
        assert_eq!(current.prepared_at, held.prepared_at);
        assert_eq!(current.purpose, held.purpose);
        assert_eq!(current.repair_for_attempt_id, held.repair_for_attempt_id);
        assert_eq!(current.binding_generation, held.binding_generation);
        assert_eq!(current.formatted_payload, held.formatted_payload);
        assert_eq!(current.payload_sha256, held.payload_sha256);
        assert_eq!(current.wire_marker, held.wire_marker);
        assert!(current.sealed_at.is_none());
        let next = &self.read().inputs.0[&self.inputs[1]];
        assert_eq!(next.state, InputState::Queued);
        assert!(next.attempts.is_empty());
        assert_eq!(self.host.sends(), 1);
        self.host.assert_read_only();
    }
    fn publish_result(&self) {
        let session = self.read();
        let input = &session.inputs.0[&self.inputs[0]];
        let attempt = &input.attempts[0];
        let message = session
            .messages
            .iter()
            .find(|m| m.id == input.message_id)
            .unwrap();
        let context = AgentContext::from_trusted_entrypoint(
            self.route.clone(),
            self.binding_id.clone(),
            self.binding().generation,
            AgentReadScope::Dispatched {
                source_input_id: input.id.clone(),
                attempt_id: attempt.id.clone(),
                issued_through_message_number: NonnegativeSafeInteger::new(message.number.value())
                    .unwrap(),
            },
        );
        let mut request = empty_apply(self.uuid());
        request.source_input_id = Some(input.id.clone());
        request.attempt_id = Some(attempt.id.clone());
        request.expected_item_revisions.0.insert(
            ItemRef::new("1").unwrap(),
            session.items.0[&ItemRef::new("1").unwrap()].revision,
        );
        request.operations.push(Operation::Reply {
            r#ref: RequestRef::new("reply").unwrap(),
            item: EntityRef::Existing(ExistingRef {
                id: ItemRef::new("1").unwrap(),
            }),
            text: "Full structured reply from this Codex input.".into(),
            round_id: None,
        });
        request.input_result = Some(ResultDraft {
            outcome: ResultOutcome::Deferred,
            explanation: "Explicit result; host text alone was insufficient.".into(),
            reply_refs: vec![UuidRef::Local(LocalRef {
                r#ref: RequestRef::new("reply").unwrap(),
            })],
            followup_item_refs: vec![],
            handled_through_message_number: message.number,
        });
        let receipt = self.core.apply(context.clone(), request.clone()).unwrap();
        assert_eq!(self.core.apply(context, request).unwrap(), receipt);
    }
    fn reopen(&mut self) {
        let allocated = self.next.clone();
        self.core = Arc::new(NativeCoreService::new(
            AgentResolver::open_data_directory(self.home.path()).unwrap(),
            move || id(allocated.fetch_add(1, Ordering::SeqCst)),
            at,
            |_| panic!("no reconnect mutation"),
        ));
    }
    async fn stop(&self, mut handle: SupervisorHandle) {
        // Hold the external read after the previous Core call and checkpoint echo.
        // This proves quit without racing an unrelated next claim's admission.
        self.host.read_held.store(false, Ordering::Release);
        self.host.hold_read.store(true, Ordering::Release);
        until(|| self.host.read_held.load(Ordering::Acquire)).await;
        handle.request_stop();
        self.host.hold_read.store(false, Ordering::Release);
        let exit = handle.stop().await.unwrap();
        assert!(exit.error.is_none(), "{exit:?}");
        assert!(exit.pending.is_none());
        assert!(exit.pending_claim.is_none());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn full_original_item_native_argv_unique_turn_and_explicit_result_join() {
    let mut setup = Setup::new(false).await;
    let handle = setup.start().await;
    until(|| setup.host.sends() == 1 && !setup.first().attempts.is_empty()).await;
    let original = setup.first();
    let attempt = &original.attempts[0];
    let EndpointRef::UnixSocket { path } = &setup.host.endpoint else {
        panic!()
    };
    assert_eq!(
        setup.host.argv(),
        [
            "queue",
            "--remote",
            &format!("unix://{}", fs::canonicalize(path).unwrap().display()),
            "--thread",
            THREAD,
            "--message",
            &attempt.formatted_payload
        ]
    );
    let payload: serde_json::Value =
        serde_json::from_str(attempt.formatted_payload.split_once('\n').unwrap().1).unwrap();
    // The slim envelope names the item; its question is read on demand, not shipped.
    assert_eq!(
        payload["item_id"],
        original.target.item_id.as_ref().unwrap().as_str()
    );
    assert!(payload.get("current_item").is_none());
    assert_eq!(payload["text"], original.payload.text);
    assert_eq!(payload["source_input_id"], original.id.as_str());
    // A complete marker with altered bytes and an exact payload in agent output are not delivery evidence.
    let changed = Host::turn(
        "wrong-full-payload",
        &format!("{} altered", attempt.formatted_payload),
        "completed",
    );
    let mut agent_only = Host::turn("agent-only-marker", "foreign owner message", "completed");
    agent_only["items"][1]["text"] = json!(attempt.formatted_payload);
    setup.host.set_turns(vec![changed, agent_only]);
    let reports = handle.progress().borrow().validated_reports;
    until(|| handle.progress().borrow().validated_reports > reports).await;
    assert_eq!(setup.first().attempts[0].host_turn_id, None);
    setup.assert_original(&original);
    setup.host.set_turns(vec![Host::turn(
        "actual-one-turn",
        &attempt.formatted_payload,
        "inProgress",
    )]);
    until(|| setup.first().attempts[0].turn_state == TurnState::Running).await;
    assert_eq!(
        setup.first().attempts[0].host_turn_id.as_deref(),
        Some("actual-one-turn")
    );
    assert_eq!(
        setup.first().attempts[0]
            .acceptance_receipt
            .as_ref()
            .unwrap()
            .provider_reference,
        "client-actual-one-turn"
    );
    setup.host.set_turns(vec![Host::turn(
        "actual-one-turn",
        &attempt.formatted_payload,
        "completed",
    )]);
    until(|| setup.first().attempts[0].turn_state == TurnState::Completed).await;
    setup.assert_original(&original);
    assert!(setup.first().attempts[0].domain_result.is_none());
    // Pause prevents input 2 from hiding whether result 1 actually sealed the original attempt.
    setup
        .core
        .execute_owner(
            setup.owner_context(),
            OwnerCommand::BindingPause {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: setup.uuid(),
                params: BindingStateParams {
                    binding_id: setup.binding_id.clone(),
                    expected_generation: setup.binding().generation,
                },
            },
        )
        .unwrap();
    setup.publish_result();
    until(|| setup.first().state == InputState::Handled).await;
    let sealed = setup.first();
    assert_eq!(sealed.attempts[0].id, attempt.id);
    assert!(sealed.attempts[0].sealed_at.is_some());
    assert_eq!(
        sealed.attempts[0]
            .domain_result
            .as_ref()
            .unwrap()
            .reply_message_ids
            .len(),
        1
    );
    // Echo the committed observation checkpoint before disconnecting the adapter.
    let reports = handle.progress().borrow().validated_reports;
    until(|| handle.progress().borrow().validated_reports > reports).await;
    setup.stop(handle).await;
    setup.reopen();
    assert_eq!(setup.first(), sealed);
    assert_eq!(setup.host.sends(), 1);
    setup.host.assert_read_only();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn lost_receipt_reconnect_and_later_exact_evidence_keep_uncertainty_without_resend() {
    let mut setup = Setup::new(true).await;
    let handle = setup.start().await;
    until(|| setup.first().state == InputState::NeedsAttention).await;
    let original = setup.first();
    assert_eq!(original.attempts[0].acceptance, AcceptanceState::Uncertain);
    assert_eq!(original.attempts[0].host_turn_id, None);
    setup.stop(handle).await;
    setup.reopen();
    let handle = setup.start().await;
    let reports = handle.progress().borrow().validated_reports;
    until(|| handle.progress().borrow().validated_reports > reports).await;
    assert!(!handle.progress().borrow().reconciled);
    assert_eq!(setup.first().state, InputState::NeedsAttention);
    assert_eq!(
        setup.binding().dispatch_state,
        DispatchState::RecoveryRequired
    );
    setup.assert_original(&original);
    // A later successful history scan identifies what ran, but does not clear durable uncertainty.
    setup.host.set_turns(vec![Host::turn(
        "recovered-original-turn",
        &original.attempts[0].formatted_payload,
        "completed",
    )]);
    until(|| setup.first().attempts[0].turn_state == TurnState::Completed).await;
    assert_eq!(
        setup.first().attempts[0].host_turn_id.as_deref(),
        Some("recovered-original-turn")
    );
    assert_eq!(
        setup.first().attempts[0]
            .acceptance_receipt
            .as_ref()
            .unwrap()
            .provider_reference,
        "client-recovered-original-turn"
    );
    assert_eq!(
        setup.first().attempts[0].acceptance,
        AcceptanceState::Uncertain
    );
    assert_eq!(setup.first().state, InputState::NeedsAttention);
    assert_eq!(
        setup.binding().dispatch_state,
        DispatchState::RecoveryRequired
    );
    assert!(setup.first().attempts[0].domain_result.is_none());
    setup.assert_original(&original);
    let reports = handle.progress().borrow().validated_reports;
    until(|| handle.progress().borrow().validated_reports > reports).await;
    setup.stop(handle).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn late_history_for_a_doubtful_send_whose_result_committed_never_stalls_the_queue() {
    // The submit receipt is lost (uncertain), the agent still commits its
    // result, so the attempt seals with an unknown turn. History then shows
    // the turn ran: Core ignores that and the next input is still sent.
    let mut setup = Setup::new(true).await;
    let handle = setup.start().await;
    until(|| setup.first().state == InputState::NeedsAttention).await;
    let state = |command: fn(BindingStateParams) -> OwnerCommand| {
        setup
            .core
            .execute_owner(
                setup.owner_context(),
                command(BindingStateParams {
                    binding_id: setup.binding_id.clone(),
                    expected_generation: setup.binding().generation,
                }),
            )
            .unwrap();
    };
    // Paused, so the late history is read before input 2 can be claimed.
    state(|params| OwnerCommand::BindingPause {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(900),
        params,
    });
    setup.publish_result();
    until(|| setup.first().state == InputState::Handled).await;
    let handled = setup.first();
    assert_eq!(handled.attempts[0].turn_state, TurnState::Unknown);
    setup.health.lock().unwrap().clear();
    setup.host.set_turns(vec![Host::turn(
        "late-original-turn",
        &handled.attempts[0].formatted_payload,
        "completed",
    )]);
    for _ in 0..3 {
        let reports = handle.progress().borrow().validated_reports;
        until(|| handle.progress().borrow().validated_reports > reports).await;
    }
    assert_eq!(setup.first(), handled, "late history rewrites nothing");
    state(|params| OwnerCommand::BindingResume {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(901),
        params,
    });
    until(|| setup.host.sends() == 2).await;
    assert!(
        setup
            .health
            .lock()
            .unwrap()
            .iter()
            .all(|h| h.state == SupervisorState::Running),
        "{:?}",
        setup.health.lock().unwrap()
    );
    setup.stop(handle).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn two_exact_original_user_turns_on_restart_preserve_uncertainty_and_never_choose_or_resend()
{
    let mut setup = Setup::new(true).await;
    let handle = setup.start().await;
    until(|| setup.first().state == InputState::NeedsAttention).await;
    let original = setup.first();
    setup.stop(handle).await;
    setup.host.set_turns(vec![
        Host::turn(
            "match-a",
            &original.attempts[0].formatted_payload,
            "completed",
        ),
        Host::turn(
            "match-b",
            &original.attempts[0].formatted_payload,
            "completed",
        ),
    ]);
    setup.reopen();
    setup.health.lock().unwrap().clear();
    let handle = setup.start().await;
    let exit = tokio::time::timeout(Duration::from_secs(5), async {
        // Ambiguous matching evidence never picks a turn: the worker keeps the
        // gate closed, backs off in plain words, and stop hands back the cause.
        until(|| {
            setup
                .health
                .lock()
                .unwrap()
                .iter()
                .any(|h| h.state == SupervisorState::BackingOff)
        })
        .await;
        assert!(
            handle.progress().has_changed().is_ok(),
            "worker stays alive"
        );
        assert!(!handle.progress().borrow().reconciled);
        handle.stop().await.unwrap()
    })
    .await
    .unwrap();
    assert_eq!(
        exit.error.as_ref().map(|e| e.code),
        Some(CoreErrorCode::ProtocolConflict)
    );
    let health = setup.health.lock().unwrap()[0].clone();
    assert_eq!(health.state, SupervisorState::BackingOff);
    assert_eq!(
        health.reason.as_deref(),
        Some("Codex answered in a way Ariadne didn't expect. It will check again.")
    );
    assert!(exit.pending.is_none());
    assert_eq!(setup.first().attempts[0].host_turn_id, None);
    assert_eq!(setup.first().state, InputState::NeedsAttention);
    setup.assert_original(&original);
}
