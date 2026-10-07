//! Actual native timer/watcher and durable Core/Store; no manual expiry calls.
use super::*;
use crate::composition::{runtime::now, tests::Fixture, NativeConfiguration, NativeRuntime};
use ariadne_agent_protocol::{EventPayload, NormalizedEvent, TurnFinishedStatus};
use ariadne_store::registry::Registry;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    time::{Duration, Instant},
};

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
struct Setup {
    fixture: Fixture,
    root: PathBuf,
    runtime: Arc<NativeRuntime>,
}
impl Setup {
    fn new() -> Self {
        let fixture = Fixture::new();
        let mut config = fixture.configuration();
        let root = config.claude.take().unwrap().project_root;
        fs::create_dir_all(&config.home).unwrap();
        fs::set_permissions(&config.home, fs::Permissions::from_mode(0o700)).unwrap();
        let registry = Registry::open_data_directory(&config.home).unwrap();
        registry.register(&root, &id(99), || id(1)).unwrap();
        let root = registry.project_dir(&id(1));
        let store = Store::open_registered(&root, id(1)).unwrap();
        let source = include_str!("../../../../../../fixtures/domain/history/seed.json");
        for (session, binding, generation) in [(2, 3, 4), (20, 30, 40)] {
            let seed: Session = serde_json::from_str(
                &source
                    .replace(id(2).as_str(), id(session).as_str())
                    .replace(id(3).as_str(), id(binding).as_str())
                    .replace(id(4).as_str(), id(generation).as_str()),
            )
            .unwrap();
            store.create(&seed).unwrap();
        }
        let runtime = NativeRuntime::start(config, Arc::new(|_| {}), Arc::new(|_| true)).unwrap();
        Self {
            fixture,
            root,
            runtime,
        }
    }
    fn config(&self) -> NativeConfiguration {
        let mut config = self.fixture.configuration();
        config.claude = None;
        config
    }
    fn saved(&self, session: u64) -> Session {
        Store::open_registered(&self.root, id(1))
            .unwrap()
            .read(&id(session))
            .unwrap()
    }
    fn queue(&self, session: u64, binding: u64, op: u64) -> UuidV4 {
        let receipt = self
            .runtime
            .bridge()
            .execute_owner(
                owner(session),
                OwnerCommand::InputSubmit {
                    api_version: SchemaVersion::new(1).unwrap(),
                    op_id: id(op),
                    params: InputSubmitParams {
                        binding_id: id(binding),
                        target: InputTarget {
                            topic_id: id(5),
                            item_id: Some(ItemRef::new("1").unwrap()),
                        },
                        kind: InputKind::Reply,
                        text: format!("Owner input {op}"),
                        selected_option_id: None,
                        expected_question_revision: None,
                        supersedes_answer_id: None,
                    },
                },
            )
            .unwrap();
        let MutationReceipt::Session(saved) = receipt else {
            panic!("input receipt")
        };
        let SavedReceiptData::InputSubmit { input_id, .. } = saved.data else {
            panic!("input receipt data")
        };
        input_id
    }
    fn claim(&self, session: u64, binding: u64, op: u64) -> PreparedAttempt {
        let generation = self.saved(session).bindings.0[&id(binding)]
            .generation
            .clone();
        self.runtime
            .bridge()
            .claim(
                ValidatedDispatchContext::from_trusted_current_lease(
                    route(session),
                    id(binding),
                    generation.clone(),
                ),
                ClaimRequest {
                    binding_id: id(binding),
                    generation,
                    request_id: id(op),
                },
            )
            .unwrap()
            .unwrap()
    }
    fn complete(&self, session: u64, binding: u64, attempt: &PreparedAttempt, at: UtcMillis) {
        self.runtime
            .bridge()
            .report(
                AdapterContext::from_trusted_entrypoint(
                    route(session),
                    id(binding),
                    attempt.binding_generation.clone(),
                    None,
                ),
                NormalizedEvent {
                    event_id: format!("completed:{}", attempt.attempt_id.as_str()),
                    binding_id: id(binding),
                    generation: attempt.binding_generation.clone(),
                    input_id: Some(attempt.input_id.clone()),
                    attempt_id: Some(attempt.attempt_id.clone()),
                    host_turn_id: Some(format!("turn:{session}")),
                    observed_at: at,
                    event: EventPayload::TurnFinished {
                        status: TurnFinishedStatus::Completed,
                        reason: None,
                        diagnostic_text: Some("Bounded host diagnostic only".into()),
                        truncated: false,
                    },
                },
            )
            .unwrap();
    }
    fn result(&self, attempt: &PreparedAttempt, op: u64) {
        let session = self.saved(2);
        let number = session
            .messages
            .iter()
            .find(|m| m.id == session.inputs.0[&attempt.input_id].message_id)
            .unwrap()
            .number;
        self.runtime
            .bridge()
            .apply(
                AgentContext::from_trusted_entrypoint(
                    route(2),
                    id(3),
                    attempt.binding_generation.clone(),
                    AgentReadScope::Dispatched {
                        source_input_id: attempt.input_id.clone(),
                        attempt_id: attempt.attempt_id.clone(),
                        issued_through_message_number: NonnegativeSafeInteger::new(number.value())
                            .unwrap(),
                    },
                ),
                ApplyRequest {
                    op_id: id(op),
                    source_input_id: Some(attempt.input_id.clone()),
                    attempt_id: Some(attempt.attempt_id.clone()),
                    expected_item_revisions: UniqueMap(std::collections::BTreeMap::from([(
                        ItemRef::new("1").unwrap(),
                        session.items.0[&ItemRef::new("1").unwrap()].revision,
                    )])),
                    expected_topic_revisions: UniqueMap(Default::default()),
                    summary: String::new(),
                    operations: vec![Operation::Reply {
                        r#ref: RequestRef::new("reply").unwrap(),
                        item: EntityRef::Existing(ExistingRef {
                            id: ItemRef::new("1").unwrap(),
                        }),
                        text: "Explicit structured reply".into(),
                        round_id: None,
                    }],
                    input_result: Some(ResultDraft {
                        outcome: ResultOutcome::Deferred,
                        explanation: "Explicit structured result".into(),
                        reply_refs: vec![UuidRef::Local(LocalRef {
                            r#ref: RequestRef::new("reply").unwrap(),
                        })],
                        followup_item_refs: vec![],
                        handled_through_message_number: number,
                    }),
                },
            )
            .unwrap();
    }
    fn wait(&self, session: u64, predicate: impl Fn(&Session) -> bool) -> Session {
        let end = Instant::now() + Duration::from_secs(9);
        loop {
            let saved = self.saved(session);
            if predicate(&saved) {
                return saved;
            }
            assert!(
                Instant::now() < end,
                "native timer did not produce expected durable state"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
impl Drop for Setup {
    fn drop(&mut self) {
        self.runtime.shutdown().unwrap();
    }
}
fn route(session: u64) -> RegisteredSession {
    RegisteredSession::from_trusted_entrypoint(id(1), id(session))
}
fn owner(session: u64) -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Session(route(session)))
}
fn old() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
}
fn expiry_count(session: &Session) -> usize {
    session
        .operation_receipts
        .0
        .values()
        .flatten()
        .filter(|r| matches!(r.result.data, SavedReceiptData::DeliveryExpiry { .. }))
        .count()
}

#[test]
fn native_timer_waits_for_saved_grace_expires_once_and_late_result_unblocks_only_its_binding() {
    let s = Setup::new();
    let input = s.queue(2, 3, 100);
    let next = s.queue(2, 3, 101);
    let untouched = s.queue(20, 30, 102);
    let attempt = s.claim(2, 3, 103);
    let other = s.saved(20);
    s.complete(2, 3, &attempt, now());
    std::thread::sleep(Duration::from_millis(1200));
    let grace = s.saved(2);
    assert_eq!(
        grace.inputs.0[&input].attempts[0].result_state,
        ResultState::Pending
    );
    assert_eq!(expiry_count(&grace), 0);
    let missing = s.wait(2, |saved| {
        saved.inputs.0[&input].attempts[0].result_state == ResultState::Missing
    });
    assert_eq!(missing.inputs.0[&input].state, InputState::NeedsAttention);
    assert_eq!(missing.inputs.0[&next].state, InputState::Queued);
    assert_eq!(
        missing.bindings.0[&id(3)].pause_reason,
        Some(PauseReason::ResultMissing)
    );
    assert_eq!(
        missing.bindings.0[&id(3)].dispatch_state,
        DispatchState::RecoveryRequired
    );
    assert_eq!(s.saved(20), other);
    assert_eq!(s.saved(20).inputs.0[&untouched].state, InputState::Queued);
    assert!(missing.inputs.0[&input].attempts[0].sealed_at.is_none());
    assert_eq!(expiry_count(&missing), 1);
    s.result(&attempt, 104);
    let handled = s.saved(2);
    assert_eq!(handled.inputs.0[&input].state, InputState::Handled);
    assert_eq!(handled.bindings.0[&id(3)].pause_reason, None);
    assert_eq!(
        handled.bindings.0[&id(3)].dispatch_state,
        DispatchState::Enabled
    );
    assert_eq!(
        handled.inputs.0[&input].attempts[0]
            .error
            .as_ref()
            .unwrap()
            .code,
        "result_missing"
    );
    std::thread::sleep(Duration::from_millis(1200));
    assert_eq!(s.saved(2), handled);
    assert_eq!(s.claim(2, 3, 105).input_id, next);
}

#[test]
fn result_before_timer_expiry_prevents_any_missing_receipt_and_preserves_owner_pause() {
    let s = Setup::new();
    let input = s.queue(2, 3, 200);
    let attempt = s.claim(2, 3, 201);
    s.complete(2, 3, &attempt, now());
    s.runtime
        .bridge()
        .execute_owner(
            owner(2),
            OwnerCommand::BindingPause {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: id(202),
                params: BindingStateParams {
                    binding_id: id(3),
                    expected_generation: attempt.binding_generation.clone(),
                },
            },
        )
        .unwrap();
    s.result(&attempt, 203);
    std::thread::sleep(Duration::from_millis(6200));
    let saved = s.saved(2);
    assert_eq!(saved.inputs.0[&input].state, InputState::Handled);
    assert_eq!(expiry_count(&saved), 0);
    assert!(saved.bindings.0[&id(3)].owner_paused);
    assert_eq!(
        saved.bindings.0[&id(3)].dispatch_state,
        DispatchState::Paused
    );
}

#[test]
fn reopened_native_runtime_discovers_pending_completion_without_selected_ui_or_host() {
    let mut s = Setup::new();
    let input = s.queue(2, 3, 300);
    let attempt = s.claim(2, 3, 301);
    s.runtime.begin_shutdown().unwrap();
    // Previously admitted host completion can persist during Quit; restarted
    // watcher discovery must not depend on a report notification or UI selection.
    s.runtime
        .bridge()
        .core()
        .report(
            AdapterContext::from_trusted_entrypoint(
                route(2),
                id(3),
                attempt.binding_generation.clone(),
                None,
            ),
            NormalizedEvent {
                event_id: "completion-during-quit".into(),
                binding_id: id(3),
                generation: attempt.binding_generation.clone(),
                input_id: Some(input.clone()),
                attempt_id: Some(attempt.attempt_id.clone()),
                host_turn_id: Some("retained-turn".into()),
                observed_at: old(),
                event: EventPayload::TurnFinished {
                    status: TurnFinishedStatus::Completed,
                    reason: None,
                    diagnostic_text: None,
                    truncated: false,
                },
            },
        )
        .unwrap();
    s.runtime.shutdown().unwrap();
    let stopped = s.saved(2);
    std::thread::sleep(Duration::from_millis(1200));
    assert_eq!(s.saved(2), stopped);
    assert_eq!(expiry_count(&stopped), 0);
    s.runtime = NativeRuntime::start(s.config(), Arc::new(|_| {}), Arc::new(|_| true)).unwrap();
    let saved = s.wait(2, |saved| {
        saved.inputs.0[&input].state == InputState::NeedsAttention
    });
    assert_eq!(
        saved.inputs.0[&input].attempts[0].result_state,
        ResultState::Missing
    );
    assert_eq!(expiry_count(&saved), 1);
}

#[test]
fn native_timer_expires_multiple_sessions_after_successful_wake_and_retained_generation_change() {
    let s = Setup::new();
    let first = s.queue(2, 3, 400);
    let second = s.queue(20, 30, 401);
    let a = s.claim(2, 3, 402);
    let b = s.claim(20, 30, 403);
    // The actual wake path drains and restarts the shared timer. Host activation
    // may fail with this hostless fixture, after timer restart has succeeded.
    assert!(s.runtime.reconcile_after_wake().is_err());
    s.complete(2, 3, &a, old());
    s.complete(20, 30, &b, old());
    // Emulate the settled reconnect transaction at the Core/Store seam. The
    // already-authorized saved completion remains valid clock evidence.
    Store::open_registered(&s.root, id(1))
        .unwrap()
        .transact(
            &id(2),
            &ReceiptActorScope::Owner {},
            &id(404),
            &serde_json::json!({"test":"generation rotation"}),
            |session| {
                let binding = session.bindings.0.get_mut(&id(3)).unwrap();
                binding.generation = id(777);
                Ok::<_, ()>(SavedReceiptData::BindingState {
                    binding_id: binding.id.clone(),
                    generation: binding.generation.clone(),
                    dispatch_state: binding.dispatch_state.clone(),
                    owner_paused: binding.owner_paused,
                    pause_reason: binding.pause_reason.clone(),
                    connection_state: binding.connection_state.clone(),
                })
            },
        )
        .unwrap();
    for (session, input) in [(2, first), (20, second)] {
        let saved = s.wait(session, |saved| {
            saved.inputs.0[&input].attempts[0].result_state == ResultState::Missing
        });
        assert_eq!(saved.inputs.0[&input].state, InputState::NeedsAttention);
        assert_eq!(expiry_count(&saved), 1);
    }
    assert_eq!(
        s.saved(2).inputs.0[&a.input_id].attempts[0].binding_generation,
        a.binding_generation
    );
}

#[test]
fn quit_drains_timer_read_already_started_before_releasing_desktop_ownership() {
    let s = Setup::new();
    let input = s.queue(2, 3, 500);
    let attempt = s.claim(2, 3, 501);
    s.complete(2, 3, &attempt, now());
    // Wait until the actual watcher/timer tracks the pending grace, then block
    // its next registered snapshot read under the real stable Store lock.
    let until = Instant::now() + Duration::from_secs(3);
    while !s
        .runtime
        .expiry_for_test()
        .pending
        .lock()
        .unwrap()
        .waiting
        .contains(&id(2))
    {
        assert!(
            Instant::now() < until,
            "timer never tracked saved completion"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let store = Store::open_registered(&s.root, id(1)).unwrap();
    let (entered, locked) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        let held = store.transact(
            &id(2),
            &ReceiptActorScope::Owner {},
            &id(502),
            &serde_json::json!({"test":"held store read"}),
            |_| {
                entered.send(()).unwrap();
                released.recv_timeout(Duration::from_secs(4)).unwrap();
                Err::<SavedReceiptData, ()>(())
            },
        );
        assert!(held.is_err());
    });
    locked.recv_timeout(Duration::from_secs(1)).unwrap();
    // Dirty is removed before the blocking read starts and cannot be replenished
    // by the held aborted transaction, proving the actual timer began its read.
    s.runtime.expiry_for_test().changed(id(2));
    let until = Instant::now() + Duration::from_secs(2);
    while s
        .runtime
        .expiry_for_test()
        .pending
        .lock()
        .unwrap()
        .dirty
        .contains(&id(2))
    {
        assert!(
            Instant::now() < until,
            "owned timer did not begin blocked read"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    std::thread::sleep(Duration::from_millis(100));
    let quitting = s.runtime.clone();
    let (sent, completed) = std::sync::mpsc::channel();
    let quit = std::thread::spawn(move || sent.send(quitting.shutdown()).unwrap());
    let before_release = completed.recv_timeout(Duration::from_millis(100));
    let owner_held = ariadne_runtime::leases::DesktopOwner::acquire(&s.config().home).is_err();
    release.send(()).unwrap();
    holder.join().unwrap();
    assert!(
        matches!(
            before_release,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ),
        "Quit returned before timer IO drained"
    );
    assert!(owner_held);
    completed
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .unwrap();
    quit.join().unwrap();
    let saved = s.saved(2);
    assert_eq!(
        saved.inputs.0[&input].attempts[0].result_state,
        ResultState::Pending
    );
    assert_eq!(expiry_count(&saved), 0);
    ariadne_runtime::leases::DesktopOwner::acquire(&s.config().home).unwrap();
}
