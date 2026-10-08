use ariadne_agent_protocol::{EventPayload, NormalizedEvent, TurnFinishedStatus};
use ariadne_core::{delivery::DeliveryService, inputs::InputService, *};
use ariadne_domain::models::*;
use ariadne_runtime::{control::MAX_FRAME_BYTES, leases::DesktopOwner};
use ariadne_store::{registry::Registry, session::Store};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
};

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn at() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
}
fn route() -> RegisteredSession {
    RegisteredSession::from_trusted_entrypoint(id(1), id(2))
}
struct Setup {
    home: tempfile::TempDir,
    _root: tempfile::TempDir,
    registry: Registry,
}
impl Setup {
    fn new() -> Self {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        registry.register(root.path(), &id(99), || id(1)).unwrap();
        let session: Session =
            serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json"))
                .unwrap();
        Store::open_registered(&registry.project_dir(&id(1)), id(1))
            .unwrap()
            .create(&session)
            .unwrap();
        Self {
            home,
            _root: root,
            registry,
        }
    }
    fn data(&self) -> std::path::PathBuf {
        self.home.path().join(".ariadne")
    }
    fn store(&self) -> Store {
        Store::open_registered(&self.registry.project_dir(&id(1)), id(1)).unwrap()
    }
    fn saved(&self) -> Session {
        self.store().read(&id(2)).unwrap()
    }
    fn bytes(&self) -> Vec<u8> {
        fs::read(
            self.registry
                .project_dir(&id(1))
                .join(format!("sessions/{}.json", id(2).as_str())),
        )
        .unwrap()
    }
    fn prepared(&self) -> PreparedAttempt {
        InputService::new(&self.registry)
            .execute(
                &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(route())),
                &OwnerCommand::InputSubmit {
                    api_version: SchemaVersion::new(1).unwrap(),
                    op_id: id(100),
                    params: InputSubmitParams {
                        binding_id: id(3),
                        target: InputTarget {
                            topic_id: id(5),
                            item_id: Some(ItemRef::new("1").unwrap()),
                        },
                        kind: InputKind::Reply,
                        text: "Exact pending owner input".into(),
                        selected_option_id: None,
                        expected_question_revision: None,
                        supersedes_answer_id: None,
                    },
                },
                || UuidV4::new(uuid::Uuid::new_v4().to_string()).unwrap(),
                at(),
            )
            .unwrap();
        // Fixture preparation uses the real durable claim service. The installed
        // report itself must work after the actual desktop lease is released.
        DeliveryService::new(&self.registry)
            .claim(
                &ValidatedDispatchContext::from_trusted_current_lease(route(), id(3), id(4)),
                &ClaimRequest {
                    binding_id: id(3),
                    generation: id(4),
                    request_id: id(101),
                },
                || UuidV4::new(uuid::Uuid::new_v4().to_string()).unwrap(),
                at(),
            )
            .unwrap()
            .unwrap()
    }
    fn completion(&self) -> NormalizedEvent {
        let prepared = self.prepared();
        NormalizedEvent {
            event_id: "original-completion".into(),
            binding_id: id(3),
            generation: prepared.binding_generation,
            input_id: Some(prepared.input_id),
            attempt_id: Some(prepared.attempt_id),
            host_turn_id: Some("original-host-turn".into()),
            observed_at: at(),
            event: EventPayload::TurnFinished {
                status: TurnFinishedStatus::Completed,
                reason: None,
                diagnostic_text: None,
                truncated: false,
            },
        }
    }
    fn call(&self, binding: &UuidV4, generation: &UuidV4, bytes: &[u8]) -> (i32, Value) {
        let mut child = Command::new(env!("CARGO_BIN_EXE_ariadne"))
            .args([
                "bridge",
                "report",
                "--binding",
                binding.as_str(),
                "--generation",
                generation.as_str(),
                "--json-stdin",
            ])
            .env("ARIADNE_HOME", self.data())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(bytes).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.stderr.is_empty(), "{output:?}");
        (
            output.status.code().unwrap(),
            serde_json::from_slice(&output.stdout).unwrap(),
        )
    }
    fn report(&self, event: &NormalizedEvent) -> (i32, Value) {
        self.call(
            &event.binding_id,
            &event.generation,
            &serde_json::to_vec(event).unwrap(),
        )
    }
    fn rebind_fixture(&self, replacement_selected: bool) {
        self.store()
            .transact(
                &id(2),
                &ReceiptActorScope::Owner {},
                &id(200),
                &serde_json::json!({"test":"rebind"}),
                |session| {
                    session.bindings.0.get_mut(&id(3)).unwrap().generation = id(777);
                    if replacement_selected {
                        let mut replacement = session.bindings.0[&id(3)].clone();
                        replacement.id = id(888);
                        replacement.active_input_id = None;
                        session.bindings.0.insert(id(888), replacement);
                        session.active_binding_id = Some(id(888));
                    }
                    let binding = &session.bindings.0[&id(3)];
                    Ok::<_, ()>(SavedReceiptData::BindingState {
                        binding_id: id(3),
                        generation: binding.generation.clone(),
                        dispatch_state: binding.dispatch_state.clone(),
                        owner_paused: binding.owner_paused,
                        pause_reason: binding.pause_reason.clone(),
                        connection_state: binding.connection_state.clone(),
                    })
                },
            )
            .unwrap();
    }
}

#[test]
fn installed_report_saves_completion_after_desktop_exit_and_replays_exactly() {
    let setup = Setup::new();
    let event = setup.completion();
    let owner = DesktopOwner::acquire(&setup.data()).unwrap();
    drop(owner);
    let before = setup.bytes();
    let (exit, envelope) = setup.report(&event);
    assert_eq!(exit, 0, "{envelope}");
    let receipt: EventReceipt = serde_json::from_value(envelope["data"].clone()).unwrap();
    assert_eq!(receipt.event_id, event.event_id);
    assert_eq!(receipt.session_id, id(2));
    assert_eq!(receipt.revision, Some(setup.saved().revision));
    assert!(receipt.durable_effect);
    assert!(!receipt.replayed);
    assert_ne!(before, setup.bytes());
    let saved = setup.saved();
    let attempt = &saved.inputs.0[event.input_id.as_ref().unwrap()].attempts[0];
    assert_eq!(attempt.turn_state, TurnState::Completed);
    assert_eq!(attempt.host_turn_id, event.host_turn_id);
    let committed = setup.bytes();
    let (exit, replay) = setup.report(&event);
    assert_eq!(exit, 0, "{replay}");
    assert_eq!(replay["data"]["revision"], envelope["data"]["revision"]);
    assert_eq!(replay["data"]["replayed"], true);
    assert_eq!(committed, setup.bytes());
    let claim = Command::new(env!("CARGO_BIN_EXE_ariadne"))
        .args([
            "bridge",
            "claim",
            "--binding",
            event.binding_id.as_str(),
            "--generation",
            event.generation.as_str(),
            "--request-id",
            id(101).as_str(),
        ])
        .env("ARIADNE_HOME", setup.data())
        .output()
        .unwrap();
    assert!(!claim.status.success());
    let failure: Value = serde_json::from_slice(&claim.stdout).unwrap();
    assert_eq!(failure["ok"], false);
    assert_eq!(committed, setup.bytes());
    let owner = DesktopOwner::acquire(&setup.data()).unwrap();
    drop(owner);
}

#[test]
fn saved_report_replays_after_generation_and_selected_binding_rebind_but_new_facts_fail() {
    for replacement_selected in [false, true] {
        let setup = Setup::new();
        let event = setup.completion();
        let (exit, original) = setup.report(&event);
        assert_eq!(exit, 0);
        setup.rebind_fixture(replacement_selected);
        let before = setup.bytes();
        let (exit, replay) = setup.report(&event);
        assert_eq!(exit, 0, "{replay}");
        assert_eq!(replay["data"]["replayed"], true);
        assert_eq!(replay["data"]["revision"], original["data"]["revision"]);
        assert_eq!(before, setup.bytes());
        let mut fresh = event.clone();
        fresh.event_id = "new-old-generation-fact".into();
        let (exit, rejected) = setup.report(&fresh);
        assert_ne!(exit, 0);
        // A rotated generation and a binding replaced by a rebind are both
        // stale: the old conversation's loop drops the report.
        assert_eq!(rejected["error"]["code"], "stale_generation");
        assert_eq!(before, setup.bytes());
        // Changing flags to the current generation cannot grant historical scope.
        fresh.generation = id(777);
        assert_ne!(setup.report(&fresh).0, 0);
        assert_eq!(before, setup.bytes());
        let mut changed = event.clone();
        changed.event = EventPayload::TurnFinished {
            status: TurnFinishedStatus::Failed,
            reason: Some("changed fact".into()),
            diagnostic_text: None,
            truncated: false,
        };
        assert_ne!(setup.report(&changed).0, 0);
        assert_eq!(before, setup.bytes());
    }
}

#[test]
fn changed_payload_with_same_event_is_rejected_and_retains_core_conflict_barrier() {
    let setup = Setup::new();
    let mut event = setup.completion();
    assert_eq!(setup.report(&event).0, 0);
    event.event = EventPayload::TurnFinished {
        status: TurnFinishedStatus::Failed,
        reason: Some("contradictory completion".into()),
        diagnostic_text: None,
        truncated: false,
    };
    let (exit, error) = setup.report(&event);
    assert_ne!(exit, 0);
    assert_eq!(error["error"]["code"], "protocol_conflict");
    assert_eq!(error["error"]["details"]["dispatch_must_pause"], true);
    let saved = setup.saved();
    assert_eq!(
        saved.bindings.0[&id(3)].dispatch_state,
        DispatchState::RecoveryRequired
    );
    assert_eq!(
        saved.inputs.0[event.input_id.as_ref().unwrap()].attempts[0].turn_state,
        TurnState::Completed
    );
}

#[test]
fn installed_report_rejects_cross_route_stale_and_invalid_input_without_writing() {
    let setup = Setup::new();
    let event = setup.completion();
    let before = setup.bytes();
    let payload = serde_json::to_vec(&event).unwrap();
    assert_eq!(
        setup.call(&id(404), &event.generation, &payload).1["error"]["code"],
        "invalid_argument"
    );
    assert_eq!(
        setup.call(&event.binding_id, &id(777), &payload).1["error"]["code"],
        "invalid_argument"
    );
    let mut stale = event.clone();
    stale.generation = id(777);
    assert_eq!(setup.report(&stale).1["error"]["code"], "stale_generation");
    let mut cross = event.clone();
    cross.binding_id = id(404);
    assert_eq!(setup.report(&cross).1["error"]["code"], "not_found");
    for bytes in [
        b"{".to_vec(),
        b"{}".to_vec(),
        vec![b' '; MAX_FRAME_BYTES + 1],
    ] {
        let (exit, envelope) = setup.call(&event.binding_id, &event.generation, &bytes);
        assert_eq!(exit, 2, "{envelope}");
        assert_eq!(envelope["error"]["code"], "invalid_argument");
        assert_eq!(before, setup.bytes());
    }
    assert_eq!(before, setup.bytes());
}

#[test]
fn retained_binding_in_another_session_cannot_report_the_original_attempt() {
    let setup = Setup::new();
    let mut event = setup.completion();
    let other: Session = serde_json::from_str(
        &include_str!("../../../fixtures/domain/history/seed.json")
            .replace(id(2).as_str(), id(12).as_str())
            .replace(id(3).as_str(), id(13).as_str()),
    )
    .unwrap();
    setup.store().create(&other).unwrap();
    let path = setup
        .registry
        .project_dir(&id(1))
        .join(format!("sessions/{}.json", id(12).as_str()));
    let original = setup.bytes();
    let sibling = fs::read(&path).unwrap();
    event.binding_id = id(13);
    let (exit, error) = setup.report(&event);
    assert_ne!(exit, 0);
    assert_eq!(error["error"]["code"], "invalid_ref");
    assert_eq!(original, setup.bytes());
    assert_eq!(sibling, fs::read(path).unwrap());
}

#[test]
fn report_requires_an_existing_registered_data_directory() {
    let setup = Setup::new();
    let event = setup.completion();
    let original = setup.bytes();
    let missing = setup.home.path().join("missing-data");
    let output = Command::new(env!("CARGO_BIN_EXE_ariadne"))
        .args([
            "bridge",
            "report",
            "--binding",
            event.binding_id.as_str(),
            "--generation",
            event.generation.as_str(),
            "--json-stdin",
        ])
        .env("ARIADNE_HOME", &missing)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map(|mut child| {
            child
                .stdin
                .take()
                .unwrap()
                .write_all(&serde_json::to_vec(&event).unwrap())
                .unwrap();
            child.wait_with_output().unwrap()
        })
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    let envelope: ApplicationEnvelope<EventReceipt> =
        serde_json::from_slice(&output.stdout).unwrap();
    assert!(matches!(envelope, ApplicationEnvelope::Failure(_)));
    assert!(!missing.exists());
    assert_eq!(original, setup.bytes());
}
