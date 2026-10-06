//! Actual NativeRuntime bridge, existing presence cache and real Core/Store.
use super::super::tests::Fixture;
use super::*;
use ariadne_runtime::supervisor::PresenceUpdate;
use ariadne_store::session::Store;
use std::{fs, os::unix::fs::PermissionsExt};

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
struct Setup {
    _fixture: Fixture,
    root: PathBuf,
    runtime: Arc<NativeRuntime>,
    context: OwnerContext,
    attempt: PreparedAttempt,
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
        let seed: Session = serde_json::from_str(include_str!(
            "../../../../../../fixtures/domain/history/seed.json"
        ))
        .unwrap();
        Store::open_registered(&root, id(1))
            .unwrap()
            .create(&seed)
            .unwrap();
        // No host configured: only provider facts at the existing observer seam
        // are scripted, while every owner mutation/claim uses real Core/Store.
        let runtime = NativeRuntime::start(config, Arc::new(|_| {}), Arc::new(|_| true)).unwrap();
        let route = RegisteredSession::from_trusted_entrypoint(id(1), id(2));
        let context = OwnerContext::from_trusted_entrypoint(OwnerScope::Session(route.clone()));
        let core = runtime.bridge().core().clone();
        core.execute_owner(
            context.clone(),
            OwnerCommand::InputSubmit {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: id(100),
                params: InputSubmitParams {
                    binding_id: id(3),
                    target: InputTarget {
                        topic_id: id(5),
                        item_id: Some(ItemRef::new("1").unwrap()),
                    },
                    kind: InputKind::Reply,
                    text: "Exact queued owner input\n".into(),
                    selected_option_id: None,
                    expected_question_revision: None,
                    supersedes_answer_id: None,
                },
            },
        )
        .unwrap();
        let generation = seed.bindings.0[&id(3)].generation.clone();
        let attempt = core
            .claim(
                ValidatedDispatchContext::from_trusted_current_lease(
                    route,
                    id(3),
                    generation.clone(),
                ),
                ClaimRequest {
                    binding_id: id(3),
                    generation,
                    request_id: id(101),
                },
            )
            .unwrap()
            .unwrap();
        Self {
            _fixture: fixture,
            root,
            runtime,
            context,
            attempt,
        }
    }
    fn saved(&self) -> Session {
        Store::open_registered(&self.root, id(1))
            .unwrap()
            .read(&id(2))
            .unwrap()
    }
    fn bytes(&self) -> Vec<u8> {
        fs::read(
            self.root
                .join("sessions")
                .join(format!("{}.json", id(2).as_str())),
        )
        .unwrap()
    }
    fn command(&self, n: u64, attested: bool) -> OwnerCommand {
        OwnerCommand::InputResolve {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(n),
            params: InputResolveParams {
                input_id: self.attempt.input_id.clone(),
                attempt_id: self.attempt.attempt_id.clone(),
                decision: ResolutionKind::Resend,
                reason: "Review original effects before explicit recovery.".into(),
                expected_revision: self.saved().revision,
                evidence: attested.then(|| OwnerResolutionEvidence {
                    source: OwnerEvidenceSource::OwnerAttestation,
                    turn_state: TurnState::Unknown,
                    host_turn_id: None,
                    owner_attested_idle: true,
                    at: now(),
                }),
            },
        }
    }
    fn observe(&self, state: ExecutionState, seen: UtcMillis, instance: u64) {
        let binding = self.saved().bindings.0[&id(3)].clone();
        (self.runtime.presence.observer())(PresenceUpdate::Connected {
            endpoint: binding.endpoint_fingerprint,
            hint: PresenceChangedHint {
                binding_id: id(3),
                generation: binding.generation.clone(),
                observation: PresenceObservation {
                    instance_id: id(instance),
                    generation: binding.generation,
                    connection_state: ConnectionState::Connected,
                    execution_state: state,
                    last_seen_at: Some(seen),
                    source: Some(PresenceSource::HostPoll),
                    process_identity: None,
                    freshness: Freshness::Fresh,
                },
            },
        });
    }
}
impl Drop for Setup {
    fn drop(&mut self) {
        self.runtime.shutdown().unwrap();
    }
}
#[test]
fn bridge_qualified_idle_recovers_without_renderer_attestation_or_dispatch() {
    let s = Setup::new();
    s.observe(ExecutionState::Idle, now(), 800);
    let before = s.saved();
    let receipt = s
        .runtime
        .bridge()
        .execute_owner(s.context.clone(), s.command(200, false))
        .unwrap();
    let after = s.saved();
    let input = &after.inputs.0[&s.attempt.input_id];
    assert_eq!(input.state, InputState::Queued);
    assert_eq!(input.payload, before.inputs.0[&s.attempt.input_id].payload);
    assert_eq!(input.attempts.len(), 1);
    assert!(input.attempts[0].sealed_at.is_some());
    assert_eq!(input.resolution_history[0].evidence, None);
    assert!(after.bindings.0[&id(3)].owner_paused);
    assert_eq!(
        after.bindings.0[&id(3)].dispatch_state,
        DispatchState::Paused
    );
    let MutationReceipt::Session(saved) = receipt else {
        panic!("real saved recovery receipt")
    };
    assert!(matches!(
        saved.data,
        SavedReceiptData::InputResolve {
            resolution_kind: ResolutionKind::Resend,
            ..
        }
    ));
}
#[test]
fn bridge_qualified_busy_blocks_even_attested_idle_without_writes() {
    for state in [ExecutionState::Running, ExecutionState::WaitingForApproval] {
        let s = Setup::new();
        s.observe(state, now(), 800);
        let before = s.bytes();
        for attested in [false, true] {
            assert_eq!(
                s.runtime
                    .bridge()
                    .execute_owner(s.context.clone(), s.command(200, attested))
                    .unwrap_err()
                    .code,
                CoreErrorCode::InvalidTransition
            );
            assert_eq!(s.bytes(), before);
        }
    }
}
#[test]
fn bridge_missing_or_expired_presence_requires_current_explicit_attestation() {
    for expired in [false, true] {
        let s = Setup::new();
        if expired {
            s.observe(
                ExecutionState::Idle,
                UtcMillis::new("2026-01-01T00:00:00.000Z").unwrap(),
                800,
            );
        }
        let before = s.bytes();
        assert_eq!(
            s.runtime
                .bridge()
                .execute_owner(s.context.clone(), s.command(200, false))
                .unwrap_err()
                .code,
            CoreErrorCode::DeliveryUncertain
        );
        assert_eq!(s.bytes(), before);
        s.runtime
            .bridge()
            .execute_owner(s.context.clone(), s.command(201, true))
            .unwrap();
        assert_eq!(
            s.saved().inputs.0[&s.attempt.input_id].state,
            InputState::Queued
        );
    }
}
#[test]
fn bridge_exact_replay_survives_busy_missing_and_changed_binding_lookup() {
    let s = Setup::new();
    s.observe(ExecutionState::Idle, now(), 800);
    let command = s.command(200, false);
    let receipt = s
        .runtime
        .bridge()
        .execute_owner(s.context.clone(), command.clone())
        .unwrap();
    let before = s.bytes();
    s.observe(ExecutionState::Running, now(), 801);
    assert_eq!(
        s.runtime
            .bridge()
            .execute_owner(s.context.clone(), command.clone())
            .unwrap(),
        receipt
    );
    assert_eq!(s.bytes(), before);
    s.runtime.presence.invalidate();
    assert_eq!(
        s.runtime
            .bridge()
            .execute_owner(s.context.clone(), command.clone())
            .unwrap(),
        receipt
    );
    assert_eq!(s.bytes(), before);
    // A real later owner disconnect changes the durable binding state.
    // Optional presence lookup is no longer eligible; the saved operation still
    // replays before Core's current binding/revision/recovery guards.
    s.runtime
        .bridge()
        .core()
        .execute_owner(
            s.context.clone(),
            OwnerCommand::BindingDisconnect {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: id(201),
                params: BindingStateParams {
                    binding_id: id(3),
                    expected_generation: s.attempt.binding_generation.clone(),
                },
            },
        )
        .unwrap();
    let changed = s.bytes();
    assert!(s
        .runtime
        .recovery_observation(&s.context, &command)
        .is_none());
    assert_eq!(
        s.runtime
            .bridge()
            .execute_owner(s.context.clone(), command)
            .unwrap(),
        receipt
    );
    assert_eq!(s.bytes(), changed);
}
