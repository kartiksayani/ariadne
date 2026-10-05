//! Deterministic provider fixture, real native composition/Core/Store/control.
//! This proves owned shutdown isolation, not physical tray Quit or a live host.
use super::*;
use crate::native::window::lifecycle::NativeLifecycle;
use ariadne_agent_protocol::{EventPayload, NormalizedEvent, TurnFinishedStatus};
use std::{
    io::Write,
    process::{Child, Command, Stdio},
};

struct HeldHost {
    child: Child,
    transcript: PathBuf,
    received: Vec<u8>,
}
impl HeldHost {
    fn new(root: &std::path::Path) -> Self {
        let transcript = root.join("external-host-turn.txt");
        let child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(fs::File::create(&transcript).unwrap())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        Self {
            child,
            transcript,
            received: Vec::new(),
        }
    }
    fn receive(&mut self, text: &str) {
        assert!(
            self.child.try_wait().unwrap().is_none(),
            "External host exited"
        );
        self.child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
        self.received.extend_from_slice(text.as_bytes());
        let deadline = Instant::now() + Duration::from_secs(2);
        while fs::read(&self.transcript).unwrap() != self.received {
            assert!(
                self.child.try_wait().unwrap().is_none(),
                "External host exited before receiving input"
            );
            assert!(
                Instant::now() < deadline,
                "External host stopped accepting input"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for HeldHost {
    fn drop(&mut self) {
        // Test cleanup owns this fixture process. The preservation assertions
        // happen before cleanup and cannot use a replacement process.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn submit(
    core: &impl CoreService,
    owner: &OwnerContext,
    scope: &BindingScope,
    topic: &UuidV4,
    n: u64,
) -> UuidV4 {
    let MutationReceipt::Session(receipt) = core
        .execute_owner(
            owner.clone(),
            OwnerCommand::InputSubmit {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: id(n),
                params: InputSubmitParams {
                    binding_id: scope.binding_id.clone(),
                    target: InputTarget {
                        topic_id: topic.clone(),
                        item_id: Some(ItemRef::new("1").unwrap()),
                    },
                    kind: InputKind::Reply,
                    text: format!("Owner input {n} stays exact.\n"),
                    selected_option_id: None,
                    expected_question_revision: None,
                    supersedes_answer_id: None,
                },
            },
        )
        .unwrap()
    else {
        panic!("saved input")
    };
    let SavedReceiptData::InputSubmit { input_id, .. } = receipt.data else {
        panic!("input receipt")
    };
    input_id
}

#[test]
fn quit_preserves_running_external_turn_and_queued_input_with_real_native_runtime() {
    let fixture = Fixture::new();
    let outcomes = Arc::new(Mutex::new(Vec::new()));
    let recorded = outcomes.clone();
    let runtime = NativeRuntime::start(
        fixture.configuration(),
        Arc::new(move |outcome| recorded.lock().unwrap().push(outcome)),
        Arc::new(|_| true),
    )
    .unwrap();
    let (route, scope, _, _) = fixture.connected(&runtime);
    let core = runtime.bridge().core().clone();
    let registered = core.resolve_session(&route).unwrap();
    let owner = OwnerContext::from_trusted_entrypoint(OwnerScope::Session(registered.clone()));
    let agent = AgentContext::from_trusted_entrypoint(
        registered.clone(),
        scope.binding_id.clone(),
        scope.generation.clone(),
        AgentReadScope::Terminal {
            issued_through_message_number: NonnegativeSafeInteger::new(0).unwrap(),
        },
    );
    core.apply(
        agent,
        ApplyRequest {
            op_id: id(100),
            source_input_id: None,
            attempt_id: None,
            expected_item_revisions: UniqueMap(Default::default()),
            expected_topic_revisions: UniqueMap(Default::default()),
            summary: String::new(),
            operations: vec![
                Operation::TopicAdd {
                    r#ref: RequestRef::new("topic").unwrap(),
                    name: "Held external turn".into(),
                },
                Operation::ItemAdd(Box::new(ItemAddOperation {
                    r#ref: RequestRef::new("item").unwrap(),
                    topic: UuidRef::Local(LocalRef {
                        r#ref: RequestRef::new("topic").unwrap(),
                    }),
                    parent: None,
                    question: "Continue external work?".into(),
                    item_type: ItemType::Question,
                    status: ItemStatus::Open,
                    owner: ItemOwner::Agent {
                        binding_id: scope.binding_id.clone(),
                    },
                    ask: None,
                    options: None,
                    note: None,
                    links: None,
                    outcome: None,
                    why: None,
                    replaced_by: None,
                    source_round_id: None,
                })),
            ],
            input_result: None,
        },
    )
    .unwrap();
    let topic = read(&core, &route).items.0[&ItemRef::new("1").unwrap()]
        .topic_id
        .clone();
    let first = submit(core.as_ref(), &owner, &scope, &topic, 101);
    let queued = submit(core.as_ref(), &owner, &scope, &topic, 102);
    core.execute_owner(
        owner,
        OwnerCommand::BindingResume {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(103),
            params: BindingStateParams {
                binding_id: scope.binding_id.clone(),
                expected_generation: scope.generation.clone(),
            },
        },
    )
    .unwrap();
    let ControlResult::Claim(Some(attempt)) = fixture
        .call(
            104,
            ControlMethod::Claim(ClaimRequest {
                binding_id: scope.binding_id.clone(),
                generation: scope.generation.clone(),
                request_id: id(104),
            }),
        )
        .unwrap()
    else {
        panic!("actual control route must claim first input")
    };
    assert_eq!(attempt.input_id, first);
    let mut host = HeldHost::new(&fixture.root);
    let external_pid = host.child.id();
    host.receive(&attempt.formatted_payload);
    let adapter = AdapterContext::from_trusted_entrypoint(
        registered,
        scope.binding_id.clone(),
        scope.generation.clone(),
        None,
    );
    let event = |event_id: &str, event| NormalizedEvent {
        event_id: event_id.into(),
        binding_id: scope.binding_id.clone(),
        generation: scope.generation.clone(),
        input_id: Some(first.clone()),
        attempt_id: Some(attempt.attempt_id.clone()),
        host_turn_id: Some(format!("fixture-host/{external_pid}/held-turn")),
        observed_at: super::super::runtime::now(),
        event,
    };
    // Only the provider facts are scripted. Canonical lifecycle report handling,
    // FIFO barriers, persisted state and the owning supervisor are production.
    core.report(
        adapter.clone(),
        event("fixture-accepted", EventPayload::Accepted { receipt: None }),
    )
    .unwrap();
    core.report(
        adapter.clone(),
        event("fixture-started", EventPayload::TurnStarted {}),
    )
    .unwrap();
    let before = read(&core, &route);
    let active = &before.inputs.0[&first];
    assert_eq!(active.state, InputState::InFlight);
    assert_eq!(active.attempts[0].turn_state, TurnState::Running);
    assert_eq!(active.attempts[0].acceptance, AcceptanceState::Accepted);
    assert!(active.attempts[0].sealed_at.is_none());
    assert_eq!(before.inputs.0[&queued].state, InputState::Queued);
    assert!(before.inputs.0[&queued].attempts.is_empty());
    let path = fixture
        .root
        .join(".ariadne/sessions")
        .join(format!("{}.json", route.session_id.as_str()));
    let original_bytes = fs::read(&path).unwrap();
    assert!(fixture.home.join("run/control.sock").exists());
    assert!(DesktopOwner::acquire(&fixture.home).is_err());
    let shutdown = runtime.clone();
    let reconcile = runtime.clone();
    let lifecycle = NativeLifecycle::from_trusted_owner(
        move || shutdown.shutdown(),
        move || reconcile.reconcile_after_wake(),
    );
    runtime.begin_shutdown().unwrap();
    lifecycle.prepare_exit().unwrap();
    lifecycle.prepare_exit().unwrap();
    assert_eq!(
        fs::read(&path).unwrap(),
        original_bytes,
        "Quit changed durable host/queue/history state"
    );
    assert_eq!(read(&core, &route), before);
    assert!(!fixture.home.join("run/control.sock").exists());
    let replacement = DesktopOwner::acquire(&fixture.home).unwrap();
    let lease = replacement
        .binding_lease(
            core.resolve_session(&route).unwrap(),
            scope.binding_id.clone(),
            scope.generation.clone(),
        )
        .unwrap();
    assert_eq!(host.child.id(), external_pid);
    host.receive("External turn continues after Ariadne Quit.\n");
    assert!(runtime.reconcile_after_wake().is_err());
    let outcomes = outcomes.lock().unwrap();
    assert!(outcomes.iter().any(|outcome| matches!(
        outcome,
        ariadne_runtime::activation::ActivationOutcome::Stopped { .. }
    )));
    assert!(outcomes.iter().all(|outcome| matches!(outcome,
        ariadne_runtime::activation::ActivationOutcome::Stopped { exit: Ok(exit), .. }
            if exit.pending.is_none() && exit.pending_claim.is_none() && exit.error.is_none())));
    drop(outcomes);
    drop(lease);
    drop(replacement);
    // An independently delivered host completion remains eligible after the
    // desktop observer stops; completion alone cannot seal without a result.
    core.report(
        adapter,
        event(
            "fixture-finished-after-quit",
            EventPayload::TurnFinished {
                status: TurnFinishedStatus::Completed,
                reason: None,
                diagnostic_text: None,
                truncated: false,
            },
        ),
    )
    .unwrap();
    let finished = read(&core, &route);
    assert_eq!(finished.bindings, before.bindings);
    assert_eq!(
        finished.inputs.0[&first].attempts[0].turn_state,
        TurnState::Completed
    );
    assert!(finished.inputs.0[&first].attempts[0].sealed_at.is_none());
    assert_eq!(finished.inputs.0[&queued], before.inputs.0[&queued]);
    assert_eq!(finished.messages, before.messages);
}
