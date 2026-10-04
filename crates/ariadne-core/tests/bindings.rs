use ariadne_agent_protocol::{Availability, Compatibility};
use ariadne_core::bindings::{BindingError, BindingService, VerifiedHost};
use ariadne_core::queries::{QueryError, QueryService};
use ariadne_core::*;
use ariadne_domain::models::*;
use ariadne_store::registry::{Registry, RegistryError};
use ariadne_store::session::{Store, StoreError};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicU64, Ordering};
use tempfile::TempDir;

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn at() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
}
fn one() -> SchemaVersion {
    SchemaVersion::new(1).unwrap()
}
fn owner() -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Registry)
}
fn route(project: u64, session: &UuidV4) -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        RegisteredSession::from_trusted_entrypoint(id(project), session.clone()),
    ))
}
fn seed() -> Session {
    serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json")).unwrap()
}
fn command(project: u64, host: &str, op: u64, session: Option<UuidV4>) -> OwnerCommand {
    OwnerCommand::BindingConnect {
        api_version: one(),
        op_id: id(op),
        params: BindingConnectParams {
            project_id: id(project),
            adapter_id: "fake.local".into(),
            external_session_id: host.into(),
            endpoint: EndpointRef::LocalBridge {
                name: "fake".into(),
            },
            configuration: seed().bindings.0[&id(3)].adapter_config.clone(),
            existing_session_id: session,
        },
    }
}
fn facts(params: &BindingConnectParams) -> VerifiedHost {
    let b = seed().bindings.0[&id(3)].clone();
    VerifiedHost {
        adapter_id: params.adapter_id.clone(),
        adapter_version: b.adapter_version,
        protocol_major: b.protocol_major,
        config_version: b.config_version,
        external_session_id: params.external_session_id.clone(),
        endpoint: params.endpoint.clone(),
        endpoint_fingerprint: b.endpoint_fingerprint,
        configuration: params.configuration.clone(),
        capabilities: b.capabilities,
        compatibility: Compatibility::Compatible,
        availability: Availability::Available,
        connection_state: ConnectionState::Connected,
        setup_instruction: "Use the saved binding and generation for this explicit host thread."
            .into(),
    }
}
fn receipt(result: MutationReceipt) -> SavedReceipt {
    let MutationReceipt::Session(result) = result else {
        panic!("session receipt")
    };
    *result
}
fn handle(receipt: &SavedReceipt) -> (UuidV4, UuidV4) {
    let SavedReceiptData::BindingConnect {
        binding_id,
        generation,
        ..
    } = &receipt.data
    else {
        panic!("connect receipt")
    };
    (binding_id.clone(), generation.clone())
}
fn core_code(error: BindingError) -> CoreErrorCode {
    let BindingError::Core(error) = error else {
        panic!("expected core error: {error:?}")
    };
    error.code
}
struct Setup {
    home: TempDir,
    roots: Vec<TempDir>,
    registry: Registry,
    next: AtomicU64,
}
impl Setup {
    fn new(projects: u64) -> Self {
        let home = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        let roots: Vec<_> = (0..projects)
            .map(|_| tempfile::tempdir().unwrap())
            .collect();
        for (i, root) in roots.iter().enumerate() {
            registry
                .register(root.path(), &id(100 + i as u64), || id(i as u64 + 1))
                .unwrap();
        }
        Self {
            home,
            roots,
            registry,
            next: AtomicU64::new(1000),
        }
    }
    fn allocate(&self) -> UuidV4 {
        id(self.next.fetch_add(1, Ordering::Relaxed))
    }
    fn service(&self) -> BindingService<'_> {
        BindingService::new(&self.registry)
    }
    fn store(&self, project: u64) -> Store {
        Store::open_registered(self.roots[project as usize - 1].path(), id(project)).unwrap()
    }
    fn connect(&self, command: &OwnerCommand) -> SavedReceipt {
        receipt(
            self.service()
                .connect(
                    &owner(),
                    command,
                    |p| Ok(facts(p)),
                    || self.allocate(),
                    at(),
                )
                .unwrap(),
        )
    }
    fn seed(&self) {
        self.store(1).create(&seed()).unwrap();
    }
    fn live(&self, project: u64, session: &UuidV4) -> std::path::PathBuf {
        self.roots[project as usize - 1]
            .path()
            .join(format!(".ariadne/sessions/{}.json", session.as_str()))
    }
    fn edit(&self, session: &UuidV4, op: u64, change: impl FnOnce(&mut Session)) {
        self.store(1)
            .transact(
                session,
                &ReceiptActorScope::Owner {},
                &id(op),
                &serde_json::json!({"command":"test_fixture", "number":op}),
                |s| {
                    change(s);
                    Ok::<_, &'static str>(SavedReceiptData::SessionLifecycle {
                        state: s.state.clone(),
                        closed_at: s.closed_at.clone(),
                    })
                },
            )
            .unwrap();
    }
}
fn state(kind: &str, binding: UuidV4, generation: UuidV4, op: u64) -> OwnerCommand {
    let params = BindingStateParams {
        binding_id: binding,
        expected_generation: generation,
    };
    match kind {
        "pause" => OwnerCommand::BindingPause {
            api_version: one(),
            op_id: id(op),
            params,
        },
        "resume" => OwnerCommand::BindingResume {
            api_version: one(),
            op_id: id(op),
            params,
        },
        "disconnect" => OwnerCommand::BindingDisconnect {
            api_version: one(),
            op_id: id(op),
            params,
        },
        _ => panic!("test kind"),
    }
}

#[test]
fn registration_uses_canonical_receipt_and_preserves_metadata_name() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    let service = BindingService::new(&registry);
    let cmd = OwnerCommand::ProjectRegister {
        api_version: one(),
        op_id: id(9),
        params: ProjectRegisterParams {
            canonical_root: root.path().to_str().unwrap().into(),
        },
    };
    let first = service.register(&owner(), &cmd, || id(1)).unwrap();
    let path = root.path().join(".ariadne/project.json");
    let mut p: Project = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        p.display_name,
        root.path()
            .canonicalize()
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
    );
    p.display_name = "Authoritative custom project title".into();
    fs::write(&path, serde_json::to_vec(&p).unwrap()).unwrap();
    assert_eq!(
        service
            .register(&owner(), &cmd, || panic!("replay"))
            .unwrap(),
        first
    );
    let mut second = cmd.clone();
    if let OwnerCommand::ProjectRegister { op_id, .. } = &mut second {
        *op_id = id(10);
    }
    service
        .register(&owner(), &second, || panic!("existing metadata"))
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Project>(&fs::read(path).unwrap())
            .unwrap()
            .display_name,
        p.display_name
    );
}

#[test]
fn new_connect_creates_revision_one_and_exact_replay_skips_provider_and_ids() {
    let s = Setup::new(1);
    let cmd = command(1, "thread-one", 10, None);
    let first = s.connect(&cmd);
    assert_eq!(first.revision.value(), 1);
    let before = fs::read(s.live(1, &first.session_id)).unwrap();
    let again = receipt(
        s.service()
            .connect(
                &owner(),
                &cmd,
                |_| panic!("saved replay"),
                || panic!("saved IDs"),
                at(),
            )
            .unwrap(),
    );
    assert_eq!(first, again);
    assert_eq!(fs::read(s.live(1, &first.session_id)).unwrap(), before);
    let (binding, generation) = handle(&first);
    assert_eq!(
        s.store(1).read(&first.session_id).unwrap().bindings.0[&binding]
            .issued_through_message_number
            .value(),
        0
    );
    let route = s.registry.resolve_binding(&binding).unwrap();
    assert_eq!(route.session_id, first.session_id);
    assert_eq!(route.generation, generation);
    assert_eq!(s.store(1).sessions().unwrap().len(), 1);
}

#[test]
fn verifier_holds_no_registry_metadata_or_session_lock_and_second_replay_wins_even_over_failure() {
    let s = Setup::new(1);
    s.seed();
    let cmd = command(1, "existing-thread", 10, Some(id(2)));
    let saved = std::cell::RefCell::new(None);
    let result = s
        .service()
        .connect(
            &owner(),
            &cmd,
            |p| {
                s.registry.rebuild().unwrap();
                s.store(1).read(&id(2)).unwrap();
                // Another writer commits while this writer is in its read-only verifier.
                *saved.borrow_mut() = Some(receipt(
                    s.service()
                        .connect(&owner(), &cmd, |_| Ok(facts(p)), || s.allocate(), at())
                        .unwrap(),
                ));
                Err(CoreError::new(
                    CoreErrorCode::HostUnreachable,
                    "late verifier failure",
                    "Retry the saved operation.",
                ))
            },
            || panic!("race replay must not allocate"),
            at(),
        )
        .unwrap();
    assert_eq!(receipt(result), saved.borrow().clone().unwrap());
    assert_eq!(s.store(1).read(&id(2)).unwrap().revision.value(), 2);
}

#[test]
fn same_host_reconnect_preserves_history_pause_and_old_receipt_before_closed_guard() {
    let s = Setup::new(1);
    s.seed();
    let before = s.store(1).read(&id(2)).unwrap();
    s.edit(&id(2), 90, |v| {
        let b = v.bindings.0.get_mut(&id(3)).unwrap();
        b.owner_paused = true;
        b.dispatch_state = DispatchState::Paused;
    });
    let cmd = command(1, "existing-thread", 10, None);
    let first = s.connect(&cmd);
    let (_, generation) = handle(&first);
    assert_ne!(generation, id(4));
    assert_eq!(first.session_id, id(2));
    assert_eq!(handle(&first).0, id(3));
    let after = s.store(1).read(&id(2)).unwrap();
    assert_eq!(
        after.bindings.0[&id(3)]
            .issued_through_message_number
            .value(),
        0
    );
    assert_eq!(after.messages, before.messages);
    assert_eq!(after.items, before.items);
    assert!(after.bindings.0[&id(3)].owner_paused);
    assert_eq!(
        after.bindings.0[&id(3)].dispatch_state,
        DispatchState::Paused
    );
    s.edit(&id(2), 91, |v| {
        v.state = SessionState::Closed;
        v.closed_at = Some(at());
    });
    assert_eq!(
        receipt(
            s.service()
                .connect(
                    &owner(),
                    &cmd,
                    |_| panic!("closed replay"),
                    || panic!(),
                    at()
                )
                .unwrap()
        ),
        first
    );
    assert_eq!(
        core_code(
            s.service()
                .connect(
                    &owner(),
                    &command(1, "existing-thread", 11, None),
                    |p| Ok(facts(p)),
                    || s.allocate(),
                    at()
                )
                .unwrap_err()
        ),
        CoreErrorCode::InvalidTransition
    );
    assert_eq!(s.store(1).sessions().unwrap().len(), 1);
}

#[test]
fn independent_sessions_and_projects_do_not_share_operation_namespace() {
    let s = Setup::new(2);
    let a = s.connect(&command(1, "one", 10, None));
    let b = s.connect(&command(1, "two", 10, None));
    let c = s.connect(&command(2, "three", 10, None));
    assert_ne!(a.session_id, b.session_id);
    assert_ne!(a.session_id, c.session_id);
    assert_eq!(s.store(1).sessions().unwrap().len(), 2);
    assert_eq!(s.store(2).sessions().unwrap().len(), 1);
    for (project, saved, host) in [(1, a, "one"), (1, b, "two"), (2, c, "three")] {
        assert_eq!(s.connect(&command(project, host, 10, None)), saved);
    }
}

#[test]
fn explicit_session_conflicting_operation_rejects_before_preflight_and_other_scope_does_not() {
    let s = Setup::new(1);
    let first = s.connect(&command(1, "one", 10, None));
    assert!(matches!(
        s.service().connect(
            &owner(),
            &command(1, "one", 10, Some(first.session_id.clone())),
            |_| panic!("explicit mismatch preflight"),
            || panic!(),
            at()
        ),
        Err(BindingError::Store(StoreError::OperationReused))
    ));
    let second = s.connect(&command(1, "two", 10, None));
    assert_ne!(first.session_id, second.session_id);
    let mut changed = command(1, "one", 10, None);
    if let OwnerCommand::BindingConnect { params, .. } = &mut changed {
        params
            .configuration
            .values
            .0
            .insert("mode".into(), serde_json::json!("changed"));
    }
    let observed = std::cell::Cell::new(false);
    assert!(matches!(
        s.service().connect(
            &owner(),
            &changed,
            |p| {
                observed.set(true);
                Ok(facts(p))
            },
            || panic!("intended session conflict before IDs"),
            at()
        ),
        Err(BindingError::Store(StoreError::OperationReused))
    ));
    assert!(observed.get());
    assert!(s
        .service()
        .connect(
            &owner(),
            &command(1, "one", 10, None),
            |_| panic!("exact"),
            || panic!(),
            at()
        )
        .is_ok());
}

#[test]
fn host_route_collision_across_projects_and_explicit_other_session_reject_without_new_file() {
    let s = Setup::new(2);
    let a = s.connect(&command(1, "one", 10, None));
    let b = s.connect(&command(1, "two", 11, None));
    for cmd in [
        command(2, "one", 20, None),
        command(1, "one", 21, Some(b.session_id.clone())),
    ] {
        assert_eq!(
            core_code(
                s.service()
                    .connect(
                        &owner(),
                        &cmd,
                        |p| Ok(facts(p)),
                        || panic!("no conflicting IDs"),
                        at()
                    )
                    .unwrap_err()
            ),
            CoreErrorCode::BindingConflict
        );
    }
    assert_eq!(s.store(1).sessions().unwrap().len(), 2);
    assert!(s.store(2).sessions().unwrap().is_empty());
    assert_eq!(
        handle(&s.connect(&command(1, "one", 22, None))).0,
        handle(&a).0
    );
}

#[test]
fn pause_resume_disconnect_fence_generation_and_keep_command_discriminants_in_digest() {
    let s = Setup::new(1);
    let saved = s.connect(&command(1, "one", 10, None));
    let (b, g) = handle(&saved);
    let ctx = route(1, &saved.session_id);
    let pause = state("pause", b.clone(), g.clone(), 20);
    let first = s.service().state(&ctx, &pause, at()).unwrap();
    assert_eq!(s.service().state(&ctx, &pause, at()).unwrap(), first);
    assert!(matches!(
        s.service()
            .state(&ctx, &state("resume", b.clone(), g.clone(), 20), at()),
        Err(BindingError::Store(StoreError::OperationReused))
    ));
    s.service()
        .state(&ctx, &state("resume", b.clone(), g.clone(), 21), at())
        .unwrap();
    assert!(!s.store(1).read(&saved.session_id).unwrap().bindings.0[&b].owner_paused);
    let next = s.connect(&command(1, "one", 11, None));
    let (_, g2) = handle(&next);
    assert_ne!(g, g2);
    assert_eq!(
        core_code(
            s.service()
                .state(&ctx, &state("pause", b.clone(), g.clone(), 22), at())
                .unwrap_err()
        ),
        CoreErrorCode::StaleGeneration
    );
    assert_eq!(s.service().state(&ctx, &pause, at()).unwrap(), first);
    s.service()
        .state(&ctx, &state("disconnect", b.clone(), g2.clone(), 23), at())
        .unwrap();
    assert_eq!(
        core_code(
            s.service()
                .state(&ctx, &state("resume", b.clone(), g2, 24), at())
                .unwrap_err()
        ),
        CoreErrorCode::HostUnreachable
    );
    let v = s.store(1).read(&saved.session_id).unwrap();
    assert_eq!(
        v.bindings.0[&b].connection_state,
        ConnectionState::Disconnected
    );
    assert_eq!(v.bindings.0[&b].dispatch_state, DispatchState::Disconnected);
}

#[test]
fn unknown_observation_cannot_enable_dispatch_and_keeps_owner_pause_and_recovery_reason() {
    let s = Setup::new(1);
    s.seed();
    s.edit(&id(2), 90, |v| {
        let b = v.bindings.0.get_mut(&id(3)).unwrap();
        b.owner_paused = true;
        b.pause_reason = Some(PauseReason::ResultMissing);
        b.dispatch_state = DispatchState::RecoveryRequired;
    });
    let cmd = command(1, "existing-thread", 10, None);
    s.service()
        .connect(
            &owner(),
            &cmd,
            |p| {
                let mut f = facts(p);
                f.connection_state = ConnectionState::Unknown;
                Ok(f)
            },
            || s.allocate(),
            at(),
        )
        .unwrap();
    let v = s.store(1).read(&id(2)).unwrap();
    let b = &v.bindings.0[&id(3)];
    assert_eq!(b.connection_state, ConnectionState::Unknown);
    assert_eq!(b.dispatch_state, DispatchState::Disconnected);
    assert!(b.owner_paused);
    assert_eq!(b.pause_reason, Some(PauseReason::ResultMissing));
    assert_eq!(
        core_code(
            s.service()
                .state(
                    &route(1, &id(2)),
                    &state("resume", id(3), b.generation.clone(), 20),
                    at()
                )
                .unwrap_err()
        ),
        CoreErrorCode::InvalidTransition
    );
}

#[test]
fn failed_qualification_mismatched_facts_or_uuid_reuse_has_no_session_effect() {
    let s = Setup::new(1);
    let cmd = command(1, "one", 10, None);
    for (field, expected) in [
        ("compatibility", CoreErrorCode::IncompatibleAdapter),
        ("available", CoreErrorCode::HostUnreachable),
        ("identity", CoreErrorCode::BindingMismatch),
        ("fingerprint", CoreErrorCode::InvalidArgument),
        ("observation", CoreErrorCode::InvalidArgument),
    ] {
        let err = s
            .service()
            .connect(
                &owner(),
                &cmd,
                |p| {
                    let mut f = facts(p);
                    match field {
                        "compatibility" => f.compatibility = Compatibility::Unknown,
                        "available" => f.availability = Availability::Unavailable,
                        "identity" => f.external_session_id = "other".into(),
                        "fingerprint" => f.endpoint_fingerprint.0 = "x".repeat(4097),
                        "observation" => f.connection_state = ConnectionState::Reconnecting,
                        _ => unreachable!(),
                    };
                    Ok(f)
                },
                || panic!("no failed preflight IDs"),
                at(),
            )
            .unwrap_err();
        assert_eq!(core_code(err), expected);
        assert!(s.store(1).sessions().unwrap().is_empty());
    }
    assert_eq!(
        core_code(
            s.service()
                .connect(&owner(), &cmd, |p| Ok(facts(p)), || id(99), at())
                .unwrap_err()
        ),
        CoreErrorCode::BindingConflict
    );
    assert!(s.store(1).sessions().unwrap().is_empty());
}

#[test]
fn session_commit_survives_invalid_index_and_exact_retry_repairs_only_missing_index() {
    let s = Setup::new(1);
    let path = s.home.path().join(".ariadne/bindings.json");
    fs::write(&path, b"{invalid").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let cmd = command(1, "one", 10, None);
    assert!(
        matches!(s.service().connect(&owner(),&cmd,|p|Ok(facts(p)),||s.allocate(),at()),
        Err(BindingError::Registry(RegistryError::CommitUncertain{operation_id,..})) if operation_id==id(10))
    );
    assert_eq!(fs::read(&path).unwrap(), b"{invalid");
    let v = s.store(1).sessions().unwrap().remove(0);
    let bytes = fs::read(s.live(1, &v.id)).unwrap();
    let original = v.operation_receipts.0[&id(10)][0].result.clone();
    fs::remove_file(&path).unwrap();
    let retry = receipt(
        s.service()
            .connect(
                &owner(),
                &cmd,
                |_| panic!("saved before verifier"),
                || panic!(),
                at(),
            )
            .unwrap(),
    );
    assert_eq!(retry, original);
    assert_eq!(fs::read(s.live(1, &v.id)).unwrap(), bytes);
    assert!(path.exists());
}

#[test]
fn unavailable_registered_root_blocks_new_uniqueness_without_treating_it_absent() {
    let s = Setup::new(2);
    fs::rename(
        s.roots[1].path().join(".ariadne"),
        s.roots[1].path().join("unavailable"),
    )
    .unwrap();
    let err = s
        .service()
        .connect(
            &owner(),
            &command(1, "one", 10, None),
            |p| Ok(facts(p)),
            || panic!("incomplete global scan"),
            at(),
        )
        .unwrap_err();
    assert!(matches!(
        err,
        BindingError::Registry(RegistryError::Unavailable { .. })
    ));
    assert!(s.store(1).sessions().unwrap().is_empty());
    assert_eq!(s.registry.registered_projects().unwrap().len(), 2);
}

#[test]
fn native_owner_context_cannot_change_an_unrelated_scope() {
    let s = Setup::new(1);
    let cmd = command(1, "one", 10, None);
    let err = s
        .service()
        .connect(&route(1, &id(2)), &cmd, |_| panic!(), || panic!(), at())
        .unwrap_err();
    assert_eq!(core_code(err), CoreErrorCode::PermissionDenied);
    assert_eq!(
        core_code(
            s.service()
                .state(&owner(), &state("pause", id(3), id(4), 10), at())
                .unwrap_err()
        ),
        CoreErrorCode::PermissionDenied
    );
}

// Caller-prepared canonical input/attempt fixture, assembled with the published
// history helper. This tests binding preservation, not the future submit/claim API.
fn queued_input(mut session: Session) -> Session {
    let item_id = ItemRef::new("1").unwrap();
    let target = &session.items.0[&item_id];
    let input_id = id(400);
    let round_id = id(700);
    let message_id = id(300);
    let input = Input {
        id: input_id.clone(),
        seq: session.counters.next_input,
        binding_id: id(3),
        kind: InputKind::Note,
        target: InputTarget {
            topic_id: target.topic_id.clone(),
            item_id: Some(item_id.clone()),
        },
        message_id: message_id.clone(),
        answer_id: None,
        created_at: at(),
        expected_question_revision: None,
        payload: InputPayload {
            text: "Exact queued owner text.\nKeep this snapshot.".into(),
            intent: InputKind::Note,
            target_snapshot: InputTargetSnapshot {
                topic_name: session.topics.0[&target.topic_id].name.clone(),
                item_question: Some(target.question.clone()),
                question_revision: Some(target.question_revision),
                ask: target.ask.clone(),
                options: target.options.clone(),
            },
            selected_option_id: None,
            context: InputContext {
                message_ids: vec![],
                item_ids: vec![item_id.clone()],
                round_id: Some(round_id.clone()),
                continuation_operation_id: None,
            },
        },
        state: InputState::Queued,
        attempts: vec![],
        active_attempt_id: None,
        resolution_history: vec![],
    };
    let message = Message {
        id: message_id,
        number: session.counters.next_message,
        author: MessageAuthor::Owner,
        kind: MessageKind::OwnerInput,
        body: input.payload.text.clone(),
        created_at: at(),
        item_id: Some(item_id),
        topic_id: Some(target.topic_id.clone()),
        items_touched: vec![],
        binding_id: Some(id(3)),
        input_id: Some(input_id.clone()),
        attempt_id: None,
        host_turn_id: None,
        round_id: Some(round_id.clone()),
        origin: None,
    };
    session.counters.next_input = PositiveSafeInteger::new(input.seq.value() + 1).unwrap();
    session.inputs.0.insert(input_id, input);
    ariadne_domain::history::record_owner_history(&session, message, None, Some(round_id)).unwrap()
}
fn prepared_attempt(sealed: bool) -> Attempt {
    use sha2::{Digest, Sha256 as Hasher};
    let marker = format!("[ARIADNE_INPUT:{}:{}]", id(400).as_str(), id(600).as_str());
    let payload = format!("{marker}\nExact original prepared payload.");
    Attempt {
        id: id(600),
        purpose: AttemptPurpose::Work,
        repair_for_attempt_id: None,
        claim_request_id: id(800),
        binding_generation: id(4),
        prepared_at: at(),
        payload_sha256: Sha256::new(format!("{:x}", Hasher::digest(payload.as_bytes()))).unwrap(),
        formatted_payload: payload,
        wire_marker: marker,
        acceptance: if sealed {
            AcceptanceState::Rejected
        } else {
            AcceptanceState::Prepared
        },
        acceptance_receipt: None,
        acceptance_observed_at: sealed.then(at),
        host_turn_id: None,
        turn_state: TurnState::Unknown,
        turn_observed_at: None,
        domain_result: None,
        result_state: ResultState::Pending,
        sealed_at: sealed.then(at),
        error: None,
        reconciliation_checkpoint: None,
    }
}

#[test]
fn queued_only_reconnect_keeps_fifo_and_sealed_history_usable_while_prepared_work_requires_recovery(
) {
    for case in [
        "unsent",
        "sealed",
        "prepared",
        "in_flight",
        "needs_attention",
    ] {
        let s = Setup::new(1);
        let mut original = queued_input(seed());
        let input = original.inputs.0.get_mut(&id(400)).unwrap();
        match case {
            "sealed" => {
                input.attempts.push(prepared_attempt(true));
            }
            "prepared" => {
                input.attempts.push(prepared_attempt(false));
            }
            "in_flight" => {
                input.attempts.push(prepared_attempt(false));
                input.state = InputState::InFlight;
                input.active_attempt_id = Some(id(600));
            }
            "needs_attention" => {
                input.attempts.push(prepared_attempt(false));
                input.state = InputState::NeedsAttention;
            }
            _ => {}
        }
        if case == "in_flight" {
            original.bindings.0.get_mut(&id(3)).unwrap().active_input_id = Some(id(400));
        }
        s.store(1).create(&original).unwrap();
        let result = s.connect(&command(1, "existing-thread", 10, None));
        let (_, generation) = handle(&result);
        let after = s.store(1).read(&id(2)).unwrap();
        let b = &after.bindings.0[&id(3)];
        assert_ne!(generation, id(4));
        assert_eq!(after.inputs, original.inputs);
        assert_eq!(after.messages, original.messages);
        assert_eq!(after.rounds, original.rounds);
        assert_eq!(after.answers, original.answers);
        if matches!(case, "unsent" | "sealed") {
            assert_eq!(b.dispatch_state, DispatchState::Enabled);
            assert_eq!(b.pause_reason, None);
        } else {
            assert_eq!(b.dispatch_state, DispatchState::RecoveryRequired);
            assert_eq!(b.pause_reason, Some(PauseReason::Uncertain));
            assert_eq!(
                core_code(
                    s.service()
                        .state(
                            &route(1, &id(2)),
                            &state("resume", id(3), generation, 20),
                            at()
                        )
                        .unwrap_err()
                ),
                CoreErrorCode::InvalidTransition
            );
        }
        if let Some(a) = after.inputs.0[&id(400)].attempts.first() {
            assert_eq!(a.binding_generation, id(4));
        }
    }
}

#[test]
fn owner_pause_and_resume_preserve_healthy_queued_and_inflight_work() {
    for in_flight in [false, true] {
        let s = Setup::new(1);
        let mut original = queued_input(seed());
        if in_flight {
            let input = original.inputs.0.get_mut(&id(400)).unwrap();
            input.attempts.push(prepared_attempt(false));
            input.state = InputState::InFlight;
            input.active_attempt_id = Some(id(600));
            original.bindings.0.get_mut(&id(3)).unwrap().active_input_id = Some(id(400));
        }
        s.store(1).create(&original).unwrap();
        let context = route(1, &id(2));
        s.service()
            .state(&context, &state("pause", id(3), id(4), 10), at())
            .unwrap();
        assert_eq!(
            s.store(1).read(&id(2)).unwrap().bindings.0[&id(3)].dispatch_state,
            DispatchState::Paused
        );
        s.service()
            .state(&context, &state("resume", id(3), id(4), 11), at())
            .unwrap();
        let after = s.store(1).read(&id(2)).unwrap();
        assert_eq!(after.inputs, original.inputs);
        assert_eq!(after.messages, original.messages);
        assert_eq!(
            after.bindings.0[&id(3)].dispatch_state,
            DispatchState::Enabled
        );
        assert_eq!(
            after.bindings.0[&id(3)].active_input_id,
            original.bindings.0[&id(3)].active_input_id
        );
    }
}

#[test]
fn rebind_blocks_every_outstanding_state_then_preserves_history_and_frees_only_historical_route() {
    for input_state in [
        InputState::Queued,
        InputState::InFlight,
        InputState::NeedsAttention,
    ] {
        let s = Setup::new(1);
        let mut v = queued_input(seed());
        v.inputs.0.get_mut(&id(400)).unwrap().state = input_state;
        let b = v.bindings.0.get_mut(&id(3)).unwrap();
        b.owner_paused = true;
        b.dispatch_state = DispatchState::Paused;
        s.store(1).create(&v).unwrap();
        let before = fs::read(s.live(1, &id(2))).unwrap();
        assert_eq!(
            core_code(
                s.service()
                    .connect(
                        &owner(),
                        &command(1, "new-host", 10, Some(id(2))),
                        |p| Ok(facts(p)),
                        || panic!("guard before UUIDs"),
                        at()
                    )
                    .unwrap_err()
            ),
            CoreErrorCode::BindingConflict
        );
        assert_eq!(fs::read(s.live(1, &id(2))).unwrap(), before);
    }
    let s = Setup::new(1);
    s.seed();
    let cmd = command(1, "new-host", 10, Some(id(2)));
    assert_eq!(
        core_code(
            s.service()
                .connect(
                    &owner(),
                    &cmd,
                    |p| Ok(facts(p)),
                    || panic!("enabled old binding"),
                    at()
                )
                .unwrap_err()
        ),
        CoreErrorCode::BindingConflict
    );
    s.service()
        .state(&route(1, &id(2)), &state("pause", id(3), id(4), 20), at())
        .unwrap();
    let before = s.store(1).read(&id(2)).unwrap();
    let new = s.connect(&cmd);
    let (new_binding, _) = handle(&new);
    assert_ne!(new_binding, id(3));
    let after = s.store(1).read(&id(2)).unwrap();
    assert_eq!(
        after.bindings.0[&new_binding]
            .issued_through_message_number
            .value(),
        0
    );
    assert_eq!(after.messages, before.messages);
    assert_eq!(after.items, before.items);
    assert_eq!(after.bindings.0[&id(3)], before.bindings.0[&id(3)]);
    assert!(matches!(
        s.registry.resolve_binding(&id(3)),
        Err(RegistryError::NotFound)
    ));
    let fresh = s.connect(&command(1, "existing-thread", 11, None));
    assert_ne!(fresh.session_id, id(2));
    assert_ne!(handle(&fresh).0, id(3));
    assert_eq!(
        s.store(1).read(&id(2)).unwrap().active_binding_id,
        Some(new_binding)
    );
    assert_eq!(
        core_code(
            s.service()
                .state(&route(1, &id(2)), &state("resume", id(3), id(4), 21), at())
                .unwrap_err()
        ),
        CoreErrorCode::BindingMismatch
    );
}

// Frozen populated domain fixture after explicit resolution of its pending work.
// This only supplies persisted history to the real binding/query services; it
// does not implement claim, delivery, reconciliation or a queue transition.
fn resolved_history() -> Session {
    let mut session: Session =
        serde_json::from_str(include_str!("../../../fixtures/domain/demo/session.json")).unwrap();
    for input in session.inputs.0.values_mut() {
        if matches!(
            input.state,
            InputState::Queued | InputState::InFlight | InputState::NeedsAttention
        ) {
            input.state = InputState::Skipped;
        }
        input.active_attempt_id = None;
        for attempt in &mut input.attempts {
            attempt.sealed_at.get_or_insert_with(at);
        }
    }
    for binding in session.bindings.0.values_mut() {
        binding.active_input_id = None;
        binding.owner_paused = true;
        binding.dispatch_state = DispatchState::Paused;
    }
    // Add source-owned copied context to the existing canonical continuation.
    // A following agent message proves issuance uses max OWNER number, not the
    // next-message counter or last message in the conversation.
    let copied = session
        .messages
        .iter()
        .find(|m| m.origin.is_some())
        .unwrap()
        .clone();
    for (offset, author) in [(0, MessageAuthor::Owner), (1, MessageAuthor::Agent)] {
        let mut message = copied.clone();
        message.id = id(900 + offset);
        message.number = PositiveSafeInteger::new(session.counters.next_message.value()).unwrap();
        message.author = author.clone();
        message.kind = if author == MessageAuthor::Owner {
            MessageKind::OwnerInput
        } else {
            MessageKind::Activity
        };
        message.body = if author == MessageAuthor::Owner {
            "Copied owner context.\nPreserve the source snapshot."
        } else {
            "Later copied agent context."
        }
        .into();
        message.item_id = None;
        message.items_touched.clear();
        message.round_id = None;
        message.input_id = None;
        message.attempt_id = None;
        message.host_turn_id = None;
        let origin = message.origin.as_mut().unwrap();
        // These new copied topic-level messages have no direct source item or
        // round; do not retain the cloned Reply's mapped direct targets.
        origin.source_target.item_id = None;
        origin.source_target.round_id = None;
        origin.author = author;
        origin.entity_id = id(910 + offset);
        session
            .continuations
            .0
            .values_mut()
            .next()
            .unwrap()
            .message_id_map
            .0
            .insert(origin.entity_id.clone(), message.id.clone());
        session.counters.next_message =
            PositiveSafeInteger::new(message.number.value() + 1).unwrap();
        session.messages.push(message);
    }
    session
}

fn history_context(binding: &UuidV4, generation: &UuidV4, grant: u64) -> AgentContext {
    AgentContext::from_trusted_entrypoint(
        RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
        binding.clone(),
        generation.clone(),
        AgentReadScope::Terminal {
            issued_through_message_number: NonnegativeSafeInteger::new(grant).unwrap(),
        },
    )
}
fn read_messages(s: &Setup, context: &AgentContext) -> Result<Vec<Message>, QueryError> {
    let QueryResult::SessionRead(SessionReadResult::Messages(page)) =
        QueryService::new(&s.registry).query(
            &QueryContext::agent(context.clone()),
            &QueryRequest::SessionRead(SessionReadRequest {
                selection: ReadView::Messages {
                    topic_id: None,
                    item_id: None,
                },
                cursor: None,
                limit: PageLimit::new(100).unwrap(),
                item_pages: vec![],
            }),
        )?
    else {
        panic!("messages")
    };
    assert!(page.next_cursor.is_none());
    Ok(page.items)
}

#[test]
fn explicit_rebind_issues_only_the_locked_history_snapshot_and_replay_never_widens_it() {
    let s = Setup::new(1);
    let original = resolved_history();
    s.store(1).create(&original).unwrap();
    let cmd = command(1, "fresh-conversation", 10, Some(id(2)));
    let saved = s.connect(&cmd);
    let (binding, generation) = handle(&saved);
    let bound = s.store(1).read(&id(2)).unwrap();
    let ceiling = original
        .messages
        .iter()
        .filter(|m| m.author == MessageAuthor::Owner)
        .map(|m| m.number.value())
        .max()
        .unwrap();
    assert!(ceiling < original.messages.last().unwrap().number.value());
    assert_eq!(
        bound.bindings.0[&binding]
            .issued_through_message_number
            .value(),
        ceiling
    );
    assert_eq!(bound.messages, original.messages);
    assert_eq!(bound.items, original.items);
    assert_eq!(bound.topics, original.topics);
    assert_eq!(bound.rounds, original.rounds);
    assert_eq!(bound.answers, original.answers);
    assert_eq!(bound.inputs, original.inputs);
    assert_eq!(bound.continuations, original.continuations);
    for (id, old) in &original.bindings.0 {
        assert_eq!(&bound.bindings.0[id], old);
    }
    let context = history_context(&binding, &generation, ceiling);
    assert_eq!(read_messages(&s, &context).unwrap(), original.messages);
    for item in original
        .items
        .0
        .values()
        .filter(|i| original.rounds.0.values().any(|r| r.item_id == i.id))
    {
        let QueryResult::ItemRounds(result) = QueryService::new(&s.registry)
            .query(
                &QueryContext::agent(context.clone()),
                &QueryRequest::ItemRounds(ItemRoundsRequest {
                    item_id: item.id.clone(),
                    cursor: None,
                    limit: PageLimit::new(100).unwrap(),
                    round_pages: vec![],
                }),
            )
            .unwrap()
        else {
            panic!("round history")
        };
        assert!(result.rounds.next_cursor.is_none());
        assert_eq!(
            result.rounds.items.len(),
            original
                .rounds
                .0
                .values()
                .filter(|r| r.item_id == item.id)
                .count()
        );
        for answer in original.answers.iter().filter(|a| a.item_id == item.id) {
            assert!(result
                .rounds
                .items
                .iter()
                .any(|r| r.answers.items.contains(answer)));
        }
    }
    let future = OwnerCommand::InputSubmit {
        api_version: one(),
        op_id: id(20),
        params: InputSubmitParams {
            binding_id: binding.clone(),
            target: InputTarget {
                topic_id: original.items.0[&ItemRef::new("1").unwrap()]
                    .topic_id
                    .clone(),
                item_id: Some(ItemRef::new("1").unwrap()),
            },
            kind: InputKind::Note,
            text: "Future owner context must remain hidden.".into(),
            selected_option_id: None,
            expected_question_revision: None,
            supersedes_answer_id: None,
        },
    };
    ariadne_core::inputs::InputService::new(&s.registry)
        .execute(&route(1, &id(2)), &future, || s.allocate(), at())
        .unwrap();
    let after_future = s.store(1).read(&id(2)).unwrap();
    assert!(after_future
        .messages
        .iter()
        .any(|m| m.body == "Future owner context must remain hidden."));
    assert!(!read_messages(&s, &context)
        .unwrap()
        .iter()
        .any(|m| m.body == "Future owner context must remain hidden."));
    assert!(read_messages(&s, &history_context(&binding, &generation, ceiling + 1)).is_err());
    let bytes = fs::read(s.live(1, &id(2))).unwrap();
    let replay = receipt(
        s.service()
            .connect(
                &owner(),
                &cmd,
                |_| panic!("replay before qualification"),
                || panic!("replay before allocation"),
                at(),
            )
            .unwrap(),
    );
    assert_eq!(replay, saved);
    assert_eq!(fs::read(s.live(1, &id(2))).unwrap(), bytes);
    assert_eq!(
        s.store(1).read(&id(2)).unwrap().bindings.0[&binding]
            .issued_through_message_number
            .value(),
        ceiling
    );
    // Reconnecting the SAME host does not issue newly appended owner context.
    let reconnect = s.connect(&command(1, "fresh-conversation", 21, Some(id(2))));
    let (same_binding, new_generation) = handle(&reconnect);
    assert_eq!(same_binding, binding);
    assert_eq!(
        s.store(1).read(&id(2)).unwrap().bindings.0[&binding]
            .issued_through_message_number
            .value(),
        ceiling
    );
    assert!(
        !read_messages(&s, &history_context(&binding, &new_generation, ceiling))
            .unwrap()
            .iter()
            .any(|m| m.body == "Future owner context must remain hidden.")
    );
    assert_eq!(
        core_code(
            s.service()
                .state(
                    &route(1, &id(2)),
                    &state("resume", id(0x20), id(0x22), 22),
                    at()
                )
                .unwrap_err()
        ),
        CoreErrorCode::BindingMismatch
    );
    let request = ApplyRequest {
        op_id: id(23),
        source_input_id: None,
        attempt_id: None,
        expected_item_revisions: UniqueMap(Default::default()),
        expected_topic_revisions: UniqueMap(Default::default()),
        summary: "Old binding cannot obtain new authority.".into(),
        operations: vec![],
        input_result: None,
    };
    let mut terminal_change = request.clone();
    terminal_change.op_id = id(25);
    let item_id = ItemRef::new("1").unwrap();
    terminal_change
        .expected_item_revisions
        .0
        .insert(item_id.clone(), after_future.items.0[&item_id].revision);
    terminal_change.operations = vec![Operation::ItemStatus {
        item: EntityRef::Existing(ExistingRef { id: item_id }),
        status: ItemStatus::Done,
        outcome: Some("Read history alone cannot consume future input.".into()),
        why: Some("Structured-context snapshot".into()),
        reason: None,
    }];
    let before_rejected_change = fs::read(s.live(1, &id(2))).unwrap();
    let error = ariadne_core::apply::ApplyService::new(&s.registry)
        .execute(
            &history_context(&binding, &new_generation, ceiling),
            &terminal_change,
            || s.allocate(),
            at(),
        )
        .unwrap_err();
    assert!(matches!(
        error,
        ariadne_core::apply::ApplyError::Core(CoreError {
            code: CoreErrorCode::UnhandledOwnerMessage,
            ..
        })
    ));
    assert_eq!(fs::read(s.live(1, &id(2))).unwrap(), before_rejected_change);
    let old = history_context(&id(0x20), &id(0x22), 5);
    let error = ariadne_core::apply::ApplyService::new(&s.registry)
        .execute(&old, &request, || panic!("old binding before IDs"), at())
        .unwrap_err();
    assert!(matches!(
        error,
        ariadne_core::apply::ApplyError::Core(CoreError {
            code: CoreErrorCode::BindingMismatch,
            ..
        })
    ));
    let forged = AgentContext::from_trusted_entrypoint(
        RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
        binding,
        new_generation,
        AgentReadScope::Dispatched {
            source_input_id: id(0x72),
            attempt_id: id(0x62),
            issued_through_message_number: NonnegativeSafeInteger::new(ceiling).unwrap(),
        },
    );
    let mut old_attempt = request;
    old_attempt.op_id = id(24);
    old_attempt.source_input_id = Some(id(0x72));
    old_attempt.attempt_id = Some(id(0x62));
    assert!(ariadne_core::apply::ApplyService::new(&s.registry)
        .execute(
            &forged,
            &old_attempt,
            || panic!("old attempt before IDs"),
            at()
        )
        .is_err());
}

#[test]
fn multiple_exact_bootstrap_receipts_are_ambiguous_without_global_operation_map() {
    let s = Setup::new(1);
    let cmd = command(1, "one", 10, None);
    let first = s.connect(&cmd);
    let mut historical = s.store(1).read(&first.session_id).unwrap();
    let (binding, generation) = handle(&first);
    s.service()
        .state(
            &route(1, &first.session_id),
            &state("pause", binding, generation, 20),
            at(),
        )
        .unwrap();
    s.connect(&command(1, "two", 21, Some(first.session_id.clone())));
    // Test-owned restored session with a second exact session-scoped receipt.
    // The store hashes its different route; the old session receipt stays intact.
    historical.id = id(5000);
    historical.operation_receipts.0.clear();
    let mut b = historical.bindings.0.values().next().unwrap().clone();
    b.id = id(5001);
    b.generation = id(5002);
    historical.active_binding_id = Some(b.id.clone());
    historical.bindings.0.clear();
    historical.bindings.0.insert(b.id.clone(), b.clone());
    let OwnerCommand::BindingConnect { params, .. } = &cmd else {
        unreachable!()
    };
    s.store(1)
        .create_with_receipt(
            &historical,
            &ReceiptActorScope::Owner {},
            &id(10),
            &serde_json::json!({"command":"binding_connect","params":params}),
            SavedReceiptData::BindingConnect {
                binding_id: b.id,
                generation: b.generation,
                capabilities: b.capabilities,
                setup_instruction: "Restored exact receipt.".into(),
            },
        )
        .unwrap();
    assert_eq!(
        core_code(
            s.service()
                .connect(
                    &owner(),
                    &cmd,
                    |_| panic!("ambiguous before verifier"),
                    || panic!(),
                    at()
                )
                .unwrap_err()
        ),
        CoreErrorCode::BindingAmbiguous
    );
}

#[test]
fn invalid_or_future_session_stays_read_only_and_cannot_be_overwritten_by_connect() {
    for bytes in [b"{invalid".as_slice(), b"{\"schema_version\":2}".as_slice()] {
        let s = Setup::new(1);
        s.seed();
        let path = s.live(1, &id(2));
        fs::write(&path, bytes).unwrap();
        let error = s
            .service()
            .connect(
                &owner(),
                &command(1, "existing-thread", 10, None),
                |_| panic!("invalid before verifier"),
                || panic!(),
                at(),
            )
            .unwrap_err();
        let BindingError::Registry(RegistryError::Store(StoreError::SessionFile {
            path: failed_path,
            source,
        })) = error
        else {
            panic!("scanned session cause: {error:?}")
        };
        assert_eq!(failed_path, path.canonicalize().unwrap());
        if bytes == b"{invalid" {
            assert!(matches!(*source, StoreError::InvalidSnapshot));
        } else {
            assert!(matches!(*source, StoreError::FutureSchema));
        }
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}

fn wait_for(path: &std::path::Path) {
    let start = std::time::Instant::now();
    while !path.exists() {
        assert!(
            start.elapsed() < std::time::Duration::from_secs(8),
            "test-owned barrier timed out"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}
struct WriterChild(std::process::Child);
impl WriterChild {
    fn finish(&mut self) {
        let start = std::time::Instant::now();
        loop {
            if let Some(status) = self.0.try_wait().unwrap() {
                assert!(status.success());
                return;
            }
            assert!(
                start.elapsed() < std::time::Duration::from_secs(8),
                "test-owned writer timed out"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
}
impl Drop for WriterChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[test]
fn binding_writer_subprocess() {
    let Ok(home) = std::env::var("ARIADNE_P14_TEST_HOME") else {
        return;
    };
    let registry = Registry::open(std::path::Path::new(&home)).unwrap();
    let cmd: OwnerCommand =
        serde_json::from_str(&std::env::var("ARIADNE_P14_TEST_COMMAND").unwrap()).unwrap();
    let barrier = std::path::PathBuf::from(std::env::var("ARIADNE_P14_TEST_BARRIER").unwrap());
    let ready = std::env::var("ARIADNE_P14_TEST_READY").unwrap();
    let mut next = std::env::var("ARIADNE_P14_TEST_IDS")
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let result = BindingService::new(&registry)
        .connect(
            &owner(),
            &cmd,
            |p| {
                fs::write(&ready, b"read-only verifier reached").unwrap();
                wait_for(&barrier);
                Ok(facts(p))
            },
            || {
                next += 1;
                id(next)
            },
            at(),
        )
        .unwrap();
    fs::write(
        std::env::var("ARIADNE_P14_TEST_RESULT").unwrap(),
        serde_json::to_vec(&result).unwrap(),
    )
    .unwrap();
}
#[test]
fn separate_writers_converge_on_one_host_route_and_keep_exact_or_distinct_operation_receipts() {
    for same_operation in [true, false] {
        let s = Setup::new(1);
        let barrier = s.home.path().join("go");
        let mut children = vec![];
        let mut results = vec![];
        for n in 0..2 {
            let ready = s.home.path().join(format!("ready-{n}"));
            let output = s.home.path().join(format!("receipt-{n}.json"));
            let cmd = command(1, "one", if same_operation { 10 } else { 10 + n }, None);
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "binding_writer_subprocess", "--nocapture"])
                .env("ARIADNE_P14_TEST_HOME", s.home.path())
                .env(
                    "ARIADNE_P14_TEST_COMMAND",
                    serde_json::to_string(&cmd).unwrap(),
                )
                .env("ARIADNE_P14_TEST_BARRIER", &barrier)
                .env("ARIADNE_P14_TEST_READY", &ready)
                .env("ARIADNE_P14_TEST_IDS", format!("{}", 10000 * (n + 1)))
                .env("ARIADNE_P14_TEST_RESULT", &output)
                .spawn()
                .unwrap();
            children.push(WriterChild(child));
            results.push((ready, output));
        }
        for (ready, _) in &results {
            wait_for(ready);
        }
        fs::write(&barrier, b"publish now").unwrap();
        for child in &mut children {
            child.finish();
        }
        let receipts: Vec<_> = results
            .iter()
            .map(|(_, p)| receipt(serde_json::from_slice(&fs::read(p).unwrap()).unwrap()))
            .collect();
        assert_eq!(receipts[0].session_id, receipts[1].session_id);
        assert_eq!(handle(&receipts[0]).0, handle(&receipts[1]).0);
        let sessions = s.store(1).sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        let live = &sessions[0];
        assert_eq!(live.revision.value(), if same_operation { 1 } else { 2 });
        assert_eq!(
            live.operation_receipts.0.len(),
            if same_operation { 1 } else { 2 }
        );
        if same_operation {
            assert_eq!(receipts[0], receipts[1]);
        } else {
            assert_ne!(handle(&receipts[0]).1, handle(&receipts[1]).1);
        }
        assert_eq!(s.registry.rebuild().unwrap().len(), 1);
    }
}
