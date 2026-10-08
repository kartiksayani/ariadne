use ariadne_core::{native::NativeCoreService, recovery::RecoveryObservation, *};
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
use std::{
    fs,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tempfile::TempDir;

/// Project store directory under a data-root home, as `Registry::project_dir` derives it.
fn store_dir(home: &std::path::Path, project: u64) -> std::path::PathBuf {
    home.join(".ariadne/projects").join(id(project).as_str())
}
fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn at(seconds: &str) -> UtcMillis {
    UtcMillis::new(format!("2026-10-04T12:00:{seconds}.000Z")).unwrap()
}
fn route() -> RegisteredSession {
    RegisteredSession::from_trusted_entrypoint(id(1), id(2))
}
fn owner() -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Session(route()))
}

struct Setup {
    _home: TempDir,
    _root: TempDir,
    native: NativeCoreService,
    next: Arc<AtomicU64>,
    attempt: PreparedAttempt,
}
impl Setup {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        registry.register(root.path(), &id(99), || id(1)).unwrap();
        let session: Session =
            serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json"))
                .unwrap();
        Store::open_registered(&store_dir(home.path(), 1), id(1))
            .unwrap()
            .create(&session)
            .unwrap();
        let next = Arc::new(AtomicU64::new(10000));
        let allocate = next.clone();
        let native = NativeCoreService::new(
            registry,
            move || id(allocate.fetch_add(1, Ordering::SeqCst)),
            || at("08"),
            |_| panic!("recovery must never verify a host"),
        );
        native
            .execute_owner(
                owner(),
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
                        text: "Exact owner text\n".into(),
                        selected_option_id: None,
                        expected_question_revision: None,
                        supersedes_answer_id: None,
                    },
                },
            )
            .unwrap();
        let generation = session.bindings.0[&id(3)].generation.clone();
        let attempt = native
            .claim(
                ValidatedDispatchContext::from_trusted_current_lease(
                    route(),
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
            _home: home,
            _root: root,
            native,
            next,
            attempt,
        }
    }
    fn saved(&self) -> Session {
        Store::open_registered(&store_dir(self._home.path(), 1), id(1))
            .unwrap()
            .read(&id(2))
            .unwrap()
    }
    fn bytes(&self) -> Vec<u8> {
        fs::read(
            store_dir(self._home.path(), 1)
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
                reason: "Deliberate recovery after reviewing original effects.".into(),
                expected_revision: self.saved().revision,
                evidence: attested.then(|| OwnerResolutionEvidence {
                    source: OwnerEvidenceSource::OwnerAttestation,
                    turn_state: TurnState::Unknown,
                    host_turn_id: None,
                    owner_attested_idle: true,
                    at: at("07"),
                }),
            },
        }
    }
    fn presence(&self, execution_state: ExecutionState) -> RecoveryObservation {
        RecoveryObservation {
            binding_id: id(3),
            instance_id: id(800),
            observation: PresenceObservation {
                instance_id: id(800),
                generation: self.attempt.binding_generation.clone(),
                connection_state: ConnectionState::Connected,
                execution_state,
                last_seen_at: Some(at("07")),
                source: Some(PresenceSource::HostPoll),
                process_identity: None,
                freshness: Freshness::Fresh,
            },
        }
    }
}

#[test]
fn fresh_qualified_idle_recovers_without_attestation_or_another_attempt() {
    let s = Setup::new();
    let before = s.saved();
    let allocated = s.next.load(Ordering::SeqCst);
    let presence = s.presence(ExecutionState::Idle);
    s.native
        .execute_recovery_with_observation(owner(), s.command(200, false), Some(&presence))
        .unwrap();
    let saved = s.saved();
    let input = &saved.inputs.0[&s.attempt.input_id];
    let previous = &before.inputs.0[&s.attempt.input_id];
    assert_eq!(input.state, InputState::Queued);
    assert_eq!(input.payload, previous.payload);
    assert_eq!(input.seq, previous.seq);
    let mut sealed = previous.attempts[0].clone();
    sealed.sealed_at = Some(at("08"));
    assert_eq!(input.attempts, vec![sealed]);
    assert_eq!(input.active_attempt_id, None);
    assert_eq!(input.resolution_history.len(), 1);
    assert_eq!(input.resolution_history[0].evidence, None);
    // Owner rule: settling the last input needing attention lifts the barrier
    // and re-enables dispatch; resolve never adds an owner pause.
    let binding = &saved.bindings.0[&id(3)];
    assert_eq!(binding.owner_paused, before.bindings.0[&id(3)].owner_paused);
    assert_eq!(binding.pause_reason, None);
    assert_ne!(binding.dispatch_state, DispatchState::RecoveryRequired);
    assert_eq!(binding.active_input_id, None);
    assert_eq!(saved.messages, before.messages);
    assert_eq!(s.next.load(Ordering::SeqCst), allocated);
}

#[test]
fn qualified_busy_presence_blocks_recovery_even_with_idle_attestation() {
    for state in [ExecutionState::Running, ExecutionState::WaitingForApproval] {
        let s = Setup::new();
        let presence = s.presence(state);
        let before = s.bytes();
        for attested in [false, true] {
            let error = s
                .native
                .execute_recovery_with_observation(
                    owner(),
                    s.command(200, attested),
                    Some(&presence),
                )
                .unwrap_err();
            assert_eq!(error.code, CoreErrorCode::InvalidTransition);
            assert_eq!(s.bytes(), before);
        }
    }
}

#[test]
fn missing_stale_unqualified_or_mismatched_presence_requires_current_attestation() {
    for case in 0..10 {
        let s = Setup::new();
        let mut presence = s.presence(ExecutionState::Idle);
        match case {
            0 => {}
            1 => presence.observation.freshness = Freshness::Stale,
            2 => presence.observation.source = Some(PresenceSource::ProcessHint),
            3 => presence.binding_id = id(999),
            4 => presence.observation.generation = id(999),
            5 => presence.instance_id = id(999),
            6 => presence.observation.last_seen_at = None,
            7 => presence.observation.connection_state = ConnectionState::Disconnected,
            8 => presence.observation.execution_state = ExecutionState::Unknown,
            9 => presence.observation.source = None,
            _ => unreachable!(),
        }
        let presence = (case != 0).then_some(&presence);
        let before = s.bytes();
        let error = s
            .native
            .execute_recovery_with_observation(owner(), s.command(200, false), presence)
            .unwrap_err();
        assert_eq!(error.code, CoreErrorCode::DeliveryUncertain, "case {case}");
        assert_eq!(s.bytes(), before, "case {case}");
        s.native
            .execute_recovery_with_observation(owner(), s.command(201, true), presence)
            .unwrap();
        assert_eq!(
            s.saved().inputs.0[&s.attempt.input_id].state,
            InputState::Queued
        );
    }
}

#[test]
fn exact_saved_replay_precedes_changed_presence_and_current_recovery_guards() {
    let s = Setup::new();
    let idle = s.presence(ExecutionState::Idle);
    let command = s.command(200, false);
    let receipt = s
        .native
        .execute_recovery_with_observation(owner(), command.clone(), Some(&idle))
        .unwrap();
    let before = s.bytes();
    let running = s.presence(ExecutionState::Running);
    let waiting = s.presence(ExecutionState::WaitingForApproval);
    let mut stale = idle.clone();
    stale.observation.freshness = Freshness::Stale;
    let mut mismatch = idle.clone();
    mismatch.observation.generation = id(999);
    for presence in [
        None,
        Some(&running),
        Some(&waiting),
        Some(&stale),
        Some(&mismatch),
    ] {
        assert_eq!(
            s.native
                .execute_recovery_with_observation(owner(), command.clone(), presence)
                .unwrap(),
            receipt
        );
        assert_eq!(s.bytes(), before);
    }
    assert_eq!(
        s.native.execute_owner(owner(), command.clone()).unwrap(),
        receipt
    );
    assert_eq!(s.bytes(), before);
    let mut changed = command;
    if let OwnerCommand::InputResolve { params, .. } = &mut changed {
        params.reason.push_str(" changed");
    }
    assert_eq!(
        s.native
            .execute_recovery_with_observation(owner(), changed, Some(&idle))
            .unwrap_err()
            .code,
        CoreErrorCode::OperationReused
    );
    assert_eq!(s.bytes(), before);
}

#[test]
fn ordinary_owner_recovery_retains_unknown_without_native_presence() {
    let s = Setup::new();
    let before = s.bytes();
    assert_eq!(
        s.native
            .execute_owner(owner(), s.command(200, false))
            .unwrap_err()
            .code,
        CoreErrorCode::DeliveryUncertain
    );
    assert_eq!(s.bytes(), before);
    s.native
        .execute_owner(owner(), s.command(201, true))
        .unwrap();
    assert_eq!(
        s.saved().inputs.0[&s.attempt.input_id].state,
        InputState::Queued
    );
}

#[test]
fn native_recovery_rejects_other_commands_invalid_wire_and_wrong_owner_scope() {
    let s = Setup::new();
    let presence = s.presence(ExecutionState::Idle);
    let before = s.bytes();
    let command = OwnerCommand::BindingPause {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(200),
        params: BindingStateParams {
            binding_id: id(3),
            expected_generation: s.attempt.binding_generation.clone(),
        },
    };
    assert_eq!(
        s.native
            .execute_recovery_with_observation(owner(), command, Some(&presence))
            .unwrap_err()
            .code,
        CoreErrorCode::InvalidArgument
    );
    assert_eq!(s.bytes(), before);
    let mut command = s.command(201, false);
    // The reason may be empty (the owner need not explain) but stays bounded.
    if let OwnerCommand::InputResolve { params, .. } = &mut command {
        params.reason = "x".repeat(4097);
    }
    assert_eq!(
        s.native
            .execute_recovery_with_observation(owner(), command, Some(&presence))
            .unwrap_err()
            .code,
        CoreErrorCode::InvalidArgument
    );
    assert_eq!(s.bytes(), before);
    assert_eq!(
        s.native
            .execute_recovery_with_observation(
                OwnerContext::from_trusted_entrypoint(OwnerScope::Preferences),
                s.command(202, false),
                Some(&presence),
            )
            .unwrap_err()
            .code,
        CoreErrorCode::PermissionDenied
    );
    assert_eq!(s.bytes(), before);
}
