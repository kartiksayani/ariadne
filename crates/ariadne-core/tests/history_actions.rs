use ariadne_agent_protocol::{EventPayload, NormalizedEvent};
use ariadne_core::{
    delivery::DeliveryService,
    history_actions::{HistoryActionError, HistoryActionService},
    *,
};
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
use std::fs;
use tempfile::TempDir;

/// Project store directory under a data-root home, as `Registry::project_dir` derives it.
fn store_dir(home: &std::path::Path, project: u64) -> std::path::PathBuf {
    home.join(".ariadne/projects").join(id(project).as_str())
}
fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn p(n: u64) -> PositiveSafeInteger {
    PositiveSafeInteger::new(n).unwrap()
}
fn at() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
}
fn close_with(edit: impl FnOnce(&mut Session)) -> Result<MutationReceipt, HistoryActionError> {
    let mut session = terminal_seed();
    edit(&mut session);
    let setup = Setup::new(&session);
    let service = HistoryActionService::new(&setup.registry);
    service.execute(&context(), &command("close", 1, 100), at())
}

#[test]
fn disconnected_binding_closes_without_a_pause() {
    for (dispatch, connection) in [
        (DispatchState::Disconnected, ConnectionState::Disconnected),
        (DispatchState::RecoveryRequired, ConnectionState::Unknown),
        (DispatchState::Enabled, ConnectionState::Reconnecting),
    ] {
        close_with(|session| {
            let binding = session.bindings.0.get_mut(&id(3)).unwrap();
            binding.dispatch_state = dispatch;
            binding.connection_state = connection;
            binding.owner_paused = true;
        })
        .unwrap();
    }
}

#[test]
fn closing_a_disconnected_enabled_binding_records_an_owner_pause() {
    let mut session = terminal_seed();
    let binding = session.bindings.0.get_mut(&id(3)).unwrap();
    binding.dispatch_state = DispatchState::Disconnected;
    binding.connection_state = ConnectionState::Disconnected;
    binding.owner_paused = false;
    let setup = Setup::new(&session);
    let service = HistoryActionService::new(&setup.registry);
    service
        .execute(&context(), &command("close", 1, 100), at())
        .unwrap();
    let closed = setup.store().read(&id(2)).unwrap();
    assert_eq!(closed.state, SessionState::Closed);
    let binding = &closed.bindings.0[&id(3)];
    assert!(binding.owner_paused);
    assert_eq!(binding.dispatch_state, DispatchState::Disconnected);
}

#[test]
fn reconnect_then_reopen_never_resumes_dispatch() {
    let mut session = terminal_seed();
    let binding = session.bindings.0.get_mut(&id(3)).unwrap();
    binding.dispatch_state = DispatchState::Disconnected;
    binding.connection_state = ConnectionState::Disconnected;
    binding.owner_paused = false;
    let setup = Setup::new(&session);
    let service = HistoryActionService::new(&setup.registry);
    service
        .execute(&context(), &command("close", 1, 100), at())
        .unwrap();
    let binding = setup.store().read(&id(2)).unwrap().bindings.0[&id(3)].clone();
    let event = NormalizedEvent {
        event_id: "reconnected".into(),
        binding_id: binding.id.clone(),
        generation: binding.generation.clone(),
        input_id: None,
        attempt_id: None,
        host_turn_id: None,
        observed_at: at(),
        event: EventPayload::Connected {
            external_session_id: binding.external_session_id.clone(),
            endpoint_fingerprint: binding.endpoint_fingerprint.clone(),
            capabilities: Box::new(binding.capabilities.clone()),
        },
    };
    let adapter = AdapterContext::from_trusted_entrypoint(
        RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
        id(3),
        binding.generation.clone(),
        None,
    );
    DeliveryService::new(&setup.registry)
        .report(&adapter, &event, || id(500))
        .unwrap();
    let revision = setup.store().read(&id(2)).unwrap().revision.value();
    service
        .execute(&context(), &command("reopen", revision, 101), at())
        .unwrap();
    let live = setup.store().read(&id(2)).unwrap();
    assert_eq!(live.state, SessionState::Active);
    let binding = &live.bindings.0[&id(3)];
    assert_eq!(binding.connection_state, ConnectionState::Connected);
    assert!(binding.owner_paused);
    assert_eq!(binding.dispatch_state, DispatchState::Paused);
}

#[test]
fn connected_enabled_binding_is_still_not_closable_and_no_binding_closes() {
    let blocked = error(close_with(|session| {
        let binding = session.bindings.0.get_mut(&id(3)).unwrap();
        binding.dispatch_state = DispatchState::Enabled;
        binding.connection_state = ConnectionState::Connected;
        binding.owner_paused = false;
    }));
    assert_eq!(blocked.code, CoreErrorCode::SessionNotClosable);
    assert!(blocked.details.unwrap().dispatch_must_pause);
    close_with(|session| session.active_binding_id = None).unwrap();
}

fn seed() -> Session {
    serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json")).unwrap()
}
fn context() -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
    ))
}
fn terminal_seed() -> Session {
    let mut session = seed();
    for item in session.items.0.values_mut() {
        item.status = ItemStatus::Done;
        item.outcome = Some("Retained complete outcome".into());
        item.why = Some("Explicitly completed".into());
        item.waiting_since = None;
        item.replaced_by = None;
    }
    let binding = session.bindings.0.get_mut(&id(3)).unwrap();
    binding.dispatch_state = DispatchState::Paused;
    binding.owner_paused = true;
    session
}
fn command(kind: &str, revision: u64, op: u64) -> OwnerCommand {
    let version = SchemaVersion::new(1).unwrap();
    match kind {
        "archive" => OwnerCommand::TopicArchive {
            api_version: version,
            op_id: id(op),
            params: TopicLifecycleParams {
                topic_id: id(5),
                expected_revision: p(revision),
            },
        },
        "restore" => OwnerCommand::TopicRestore {
            api_version: version,
            op_id: id(op),
            params: TopicLifecycleParams {
                topic_id: id(5),
                expected_revision: p(revision),
            },
        },
        "close" => OwnerCommand::SessionClose {
            api_version: version,
            op_id: id(op),
            params: SessionLifecycleParams {
                expected_revision: p(revision),
            },
        },
        "reopen" => OwnerCommand::SessionReopen {
            api_version: version,
            op_id: id(op),
            params: SessionLifecycleParams {
                expected_revision: p(revision),
            },
        },
        _ => panic!("test command"),
    }
}
fn saved(result: MutationReceipt) -> SavedReceipt {
    let MutationReceipt::Session(saved) = result else {
        panic!("session receipt")
    };
    *saved
}
fn error(result: Result<MutationReceipt, HistoryActionError>) -> CoreError {
    let HistoryActionError::Core(error) = result.unwrap_err() else {
        panic!("core error")
    };
    error
}
struct Setup {
    _home: TempDir,
    _root: TempDir,
    registry: Registry,
}
impl Setup {
    fn new(session: &Session) -> Self {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        registry.register(root.path(), &id(99), || id(1)).unwrap();
        Store::open_registered(&store_dir(home.path(), 1), id(1))
            .unwrap()
            .create(session)
            .unwrap();
        Self {
            _home: home,
            _root: root,
            registry,
        }
    }
    fn store(&self) -> Store {
        Store::open_registered(&store_dir(self._home.path(), 1), id(1)).unwrap()
    }
    fn bytes(&self) -> Vec<u8> {
        fs::read(store_dir(self._home.path(), 1).join(format!("sessions/{}.json", id(2).as_str())))
            .unwrap()
    }
}

#[test]
fn archive_restore_close_reopen_preserve_entities_and_binding_without_resuming() {
    let original = terminal_seed();
    let setup = Setup::new(&original);
    let service = HistoryActionService::new(&setup.registry);
    let archived = saved(
        service
            .execute(&context(), &command("archive", 1, 100), at())
            .unwrap(),
    );
    assert!(
        matches!(archived.data,SavedReceiptData::TopicLifecycle{archived_at:Some(_),topic_revision,..} if topic_revision==p(2))
    );
    service
        .execute(&context(), &command("close", 2, 101), at())
        .unwrap();
    let closed = setup.store().read(&id(2)).unwrap();
    assert_eq!(closed.state, SessionState::Closed);
    // Restoration is metadata-only, even while the containing session is closed.
    service
        .execute(&context(), &command("restore", 2, 102), at())
        .unwrap();
    service
        .execute(&context(), &command("reopen", 4, 103), at())
        .unwrap();
    let live = setup.store().read(&id(2)).unwrap();
    assert_eq!(live.state, SessionState::Active);
    assert!(live.closed_at.is_none());
    assert_eq!(live.items, original.items);
    assert_eq!(live.messages, original.messages);
    assert_eq!(live.rounds, original.rounds);
    assert_eq!(live.answers, original.answers);
    assert_eq!(live.inputs, original.inputs);
    assert_eq!(live.bindings, original.bindings);
    assert_eq!(live.active_binding_id, original.active_binding_id);
    assert!(live.topics.0[&id(5)].archived_at.is_none());
    assert_eq!(live.revision, p(5));
}

#[test]
fn lifecycle_replay_precedes_stale_revision_and_restored_state_without_rewriting_bytes() {
    let setup = Setup::new(&terminal_seed());
    let service = HistoryActionService::new(&setup.registry);
    let archive = command("archive", 1, 100);
    let receipt = service.execute(&context(), &archive, at()).unwrap();
    service
        .execute(&context(), &command("restore", 2, 101), at())
        .unwrap();
    let bytes = setup.bytes();
    assert_eq!(
        service.execute(&context(), &archive, at()).unwrap(),
        receipt
    );
    assert_eq!(setup.bytes(), bytes);
    assert!(matches!(
        service.execute(&context(), &command("restore", 3, 100), at()),
        Err(HistoryActionError::Store(
            ariadne_store::session::StoreError::OperationReused
        ))
    ));
    let stale = error(service.execute(&context(), &command("archive", 1, 102), at()));
    assert_eq!(stale.code, CoreErrorCode::RevisionConflict);
    assert_eq!(stale.current_revision, Some(p(3)));
    assert_eq!(setup.bytes(), bytes);
}

#[test]
fn archive_and_close_return_real_blocker_ids_and_never_mutate_rejected_snapshot() {
    let setup = Setup::new(&seed());
    let service = HistoryActionService::new(&setup.registry);
    let bytes = setup.bytes();
    let archive = error(service.execute(&context(), &command("archive", 1, 100), at()));
    assert_eq!(archive.code, CoreErrorCode::TopicNotArchivable);
    assert_eq!(
        archive.details.unwrap().blocking_item_ids,
        vec![ItemRef::new("1").unwrap()]
    );
    let close = error(service.execute(&context(), &command("close", 1, 101), at()));
    assert_eq!(close.code, CoreErrorCode::SessionNotClosable);
    let details = close.details.unwrap();
    assert_eq!(details.blocking_item_ids, vec![ItemRef::new("1").unwrap()]);
    assert!(details.dispatch_must_pause);
    assert_eq!(setup.bytes(), bytes);
}

#[test]
fn even_terminal_empty_queue_requires_persisted_paused_dispatch_and_owner_scope() {
    let mut session = terminal_seed();
    let binding = session.bindings.0.get_mut(&id(3)).unwrap();
    binding.dispatch_state = DispatchState::Enabled;
    binding.owner_paused = false;
    let setup = Setup::new(&session);
    let service = HistoryActionService::new(&setup.registry);
    let bytes = setup.bytes();
    let close_error = error(service.execute(&context(), &command("close", 1, 100), at()));
    assert!(close_error.details.unwrap().dispatch_must_pause);
    let wrong = OwnerContext::from_trusted_entrypoint(OwnerScope::Registry);
    assert_eq!(
        error(service.execute(&wrong, &command("archive", 1, 101), at())).code,
        CoreErrorCode::PermissionDenied
    );
    assert_eq!(setup.bytes(), bytes);
}

fn rich_seed() -> Session {
    serde_json::from_str(include_str!("../../../fixtures/domain/demo/session.json")).unwrap()
}
fn target_context() -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        RegisteredSession::from_trusted_entrypoint(id(1), id(20)),
    ))
}
fn target_seed() -> Session {
    let mut target = seed();
    target.id = id(20);
    target
}

#[test]
fn native_preview_resolves_only_registry_owner_target_and_never_retargets_session_or_agent() {
    let setup = Setup::new(&seed());
    setup.store().create(&target_seed()).unwrap();
    let native = ariadne_core::native::NativeCoreService::new(
        Registry::open(setup._home.path()).unwrap(),
        || panic!("preview allocates no IDs"),
        at,
        |_| panic!("preview performs no provider IO"),
    );
    let query = QueryRequest::TopicContinuePreview(request(id(5)));
    let before_source = setup.bytes();
    let before_target = fs::read(session_path(&setup, 20)).unwrap();
    // The canonical wrapper has no outer session. Desktop and installed CLI
    // both supply this trusted Registry owner context.
    OwnerQueryRequest {
        session: None,
        request: query.clone(),
    }
    .validate_wire()
    .unwrap();
    let registry = QueryContext::owner(OwnerContext::from_trusted_entrypoint(OwnerScope::Registry));
    let actual = native.query(registry.clone(), query.clone()).unwrap();
    let explicit = native
        .query(QueryContext::owner(target_context()), query.clone())
        .unwrap();
    assert_eq!(actual, explicit);
    assert_eq!(
        native
            .query(QueryContext::owner(context()), query.clone())
            .unwrap_err()
            .code,
        CoreErrorCode::PermissionDenied
    );
    let mut missing = request(id(5));
    missing.target.session_id = id(404);
    assert_eq!(
        native
            .query(registry, QueryRequest::TopicContinuePreview(missing))
            .unwrap_err()
            .code,
        CoreErrorCode::IoError
    );
    let agent = AgentContext::from_trusted_entrypoint(
        RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
        id(3),
        id(4),
        AgentReadScope::Terminal {
            issued_through_message_number: NonnegativeSafeInteger::new(0).unwrap(),
        },
    );
    assert_eq!(
        native
            .query(QueryContext::agent(agent), query)
            .unwrap_err()
            .code,
        CoreErrorCode::PermissionDenied
    );
    assert_eq!(setup.bytes(), before_source);
    assert_eq!(fs::read(session_path(&setup, 20)).unwrap(), before_target);
}
fn request(topic: UuidV4) -> ContinuePreviewRequest {
    ContinuePreviewRequest {
        source: SessionRef {
            project_id: id(1),
            session_id: id(2),
        },
        source_topic_id: topic,
        target: SessionRef {
            project_id: id(1),
            session_id: id(20),
        },
    }
}
fn continuing(preview: &ContinuePreview, op: u64) -> OwnerCommand {
    OwnerCommand::TopicContinue {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(op),
        params: TopicContinueParams {
            source: preview.source.clone(),
            source_topic_id: preview.source_topic_id.clone(),
            source_revision: preview.source_revision,
            source_sha256: preview.source_sha256.clone(),
            target: preview.target.clone(),
            target_binding_id: id(3),
            summary: preview.summary.clone(),
        },
    }
}
fn allocator(start: u64) -> impl FnMut() -> UuidV4 {
    let mut next = start;
    move || {
        let allocated = id(next);
        next += 1;
        allocated
    }
}
fn continuation(receipt: MutationReceipt) -> ContinuationReceipt {
    let SavedReceiptData::Continuation { continuation } = saved(receipt).data else {
        panic!("continuation receipt")
    };
    continuation
}
fn session_path(setup: &Setup, session: u64) -> std::path::PathBuf {
    store_dir(setup._home.path(), 1).join(format!("sessions/{}.json", id(session).as_str()))
}

#[test]
fn continuation_copies_full_structured_history_and_queues_one_handoff_without_touching_source() {
    let original = rich_seed();
    let setup = Setup::new(&original);
    let target_before = target_seed();
    setup.store().create(&target_before).unwrap();
    let source_bytes = setup.bytes();
    let service = HistoryActionService::new(&setup.registry);
    let preview = service
        .preview(&target_context(), &request(id(16)))
        .unwrap();
    assert!(preview.summary.contains("Agent ownership"));
    assert!(
        matches!(&preview.readiness, ContinueReadiness::Ready { binding_id, .. } if binding_id == &id(3))
    );
    let receipt = continuation(
        service
            .continue_topic(
                &target_context(),
                &continuing(&preview, 200),
                allocator(10000),
                at(),
            )
            .unwrap(),
    );
    let target = setup.store().read(&id(20)).unwrap();
    assert_eq!(setup.bytes(), source_bytes);
    assert_eq!(target.continuations.0[&id(200)], receipt);
    assert_eq!(target.inputs.0.len(), 1);
    let input = &target.inputs.0[&receipt.target_input_id];
    assert_eq!(input.kind, InputKind::Continue);
    assert_eq!(input.state, InputState::Queued);
    assert!(input.attempts.is_empty());
    assert_eq!(input.payload.text, preview.summary);
    assert_eq!(
        input.payload.context.continuation_operation_id,
        Some(id(200))
    );
    assert_eq!(
        target
            .messages
            .iter()
            .filter(|m| m.input_id.as_ref() == Some(&input.id) && m.origin.is_none())
            .count(),
        1
    );
    for (old_id, new_id) in &receipt.item_id_map.0 {
        let old = &original.items.0[old_id];
        let copied = &target.items.0[new_id];
        assert_eq!(copied.question, old.question);
        assert_eq!(copied.ask, old.ask);
        assert_eq!(copied.options, old.options);
        assert_eq!(copied.status, old.status);
        assert_eq!(copied.status_history.len(), old.status_history.len());
        for (history, prior) in copied.status_history.iter().zip(&old.status_history) {
            assert_eq!(history.binding_id, prior.binding_id);
            assert_eq!(
                history.handled_through_message_number,
                prior.handled_through_message_number
            );
            assert_eq!(history.previous_outcome, prior.previous_outcome);
            assert_eq!(history.previous_why, prior.previous_why);
            assert_eq!(
                history.cause_message_id,
                receipt.message_id_map.0[&prior.cause_message_id]
            );
        }
        assert_eq!(
            copied.parent,
            old.parent
                .as_ref()
                .map(|p| receipt.item_id_map.0[p].clone())
        );
        assert_eq!(copied.origin.as_ref().unwrap().entity_id, *old_id);
        match &old.owner {
            ItemOwner::Agent { .. } => {
                assert_eq!(copied.owner, ItemOwner::Agent { binding_id: id(3) })
            }
            other => assert_eq!(&copied.owner, other),
        }
        if old.recipient_binding_id.is_some() {
            assert_eq!(copied.recipient_binding_id, Some(id(3)));
        }
        if let Some(old_replacement) = &old.replaced_by {
            assert_eq!(
                copied.replaced_by,
                Some(receipt.item_id_map.0[old_replacement].clone())
            );
        }
    }
    for (old_id, new_id) in &receipt.message_id_map.0 {
        let old = original.messages.iter().find(|m| &m.id == old_id).unwrap();
        let copied = target.messages.iter().find(|m| &m.id == new_id).unwrap();
        assert_eq!(copied.body, old.body);
        assert_eq!(copied.author, old.author);
        assert_eq!(copied.binding_id, old.binding_id);
        assert_eq!(copied.input_id, old.input_id);
        assert_eq!(copied.attempt_id, old.attempt_id);
        assert_eq!(copied.origin.as_ref().unwrap().entity_id, *old_id);
    }
    for (old_id, new_id) in &receipt.round_id_map.0 {
        let old = &original.rounds.0[old_id];
        let copied = &target.rounds.0[new_id];
        assert_eq!(copied.question_snapshot, old.question_snapshot);
        assert_eq!(copied.ask_snapshot, old.ask_snapshot);
        assert_eq!(copied.options_snapshot, old.options_snapshot);
        assert_eq!(
            copied.owner_message_ids,
            old.owner_message_ids
                .iter()
                .map(|id| receipt.message_id_map.0[id].clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            copied.agent_message_ids,
            old.agent_message_ids
                .iter()
                .map(|id| receipt.message_id_map.0[id].clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            copied.fork_item_ids,
            old.fork_item_ids
                .iter()
                .map(|id| receipt.item_id_map.0[id].clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(copied.result_input_ids, old.result_input_ids);
        assert_eq!(copied.closed_at, old.closed_at);
        assert_eq!(copied.origin.as_ref().unwrap().entity_id, *old_id);
    }
    for (old_id, new_id) in &receipt.answer_id_map.0 {
        let old = original.answers.iter().find(|a| &a.id == old_id).unwrap();
        let copied = target.answers.iter().find(|a| &a.id == new_id).unwrap();
        assert_eq!(copied.text, old.text);
        assert_eq!(copied.question_snapshot, old.question_snapshot);
        assert_eq!(copied.input_id, old.input_id);
        assert_eq!(copied.ask_snapshot, old.ask_snapshot);
        assert_eq!(copied.options_snapshot, old.options_snapshot);
        assert_eq!(copied.selected_option_id, old.selected_option_id);
        assert_eq!(
            copied.supersedes_answer_id,
            old.supersedes_answer_id
                .as_ref()
                .map(|id| receipt.answer_id_map.0[id].clone())
        );
        assert_eq!(copied.message_id, receipt.message_id_map.0[&old.message_id]);
    }
    assert_eq!(
        target.items.0.len(),
        target_before.items.0.len() + receipt.item_id_map.0.len()
    );
}

#[test]
fn exact_continuation_replays_after_source_becomes_unavailable_and_allocates_nothing() {
    let setup = Setup::new(&rich_seed());
    setup.store().create(&target_seed()).unwrap();
    let service = HistoryActionService::new(&setup.registry);
    let preview = service
        .preview(&target_context(), &request(id(16)))
        .unwrap();
    let command = continuing(&preview, 200);
    let receipt = service
        .continue_topic(&target_context(), &command, allocator(10000), at())
        .unwrap();
    let target_bytes = fs::read(session_path(&setup, 20)).unwrap();
    fs::remove_file(session_path(&setup, 2)).unwrap();
    assert_eq!(
        service
            .continue_topic(
                &target_context(),
                &command,
                || panic!("replay must not allocate"),
                at()
            )
            .unwrap(),
        receipt
    );
    assert_eq!(fs::read(session_path(&setup, 20)).unwrap(), target_bytes);
    let mut changed = command.clone();
    let OwnerCommand::TopicContinue { params, .. } = &mut changed else {
        unreachable!()
    };
    params.summary.push_str(" changed");
    assert!(matches!(
        service.continue_topic(
            &target_context(),
            &changed,
            || panic!("conflict must not allocate"),
            at()
        ),
        Err(HistoryActionError::Store(
            ariadne_store::session::StoreError::OperationReused
        ))
    ));
}

#[test]
fn source_revision_or_hash_change_rejects_stale_preview_without_target_effects() {
    let setup = Setup::new(&rich_seed());
    setup.store().create(&target_seed()).unwrap();
    let service = HistoryActionService::new(&setup.registry);
    let preview = service
        .preview(&target_context(), &request(id(16)))
        .unwrap();
    let target_bytes = fs::read(session_path(&setup, 20)).unwrap();
    setup
        .store()
        .transact(
            &id(2),
            &ReceiptActorScope::Owner {},
            &id(500),
            &serde_json::json!({"kind":"source_edit"}),
            |s| {
                s.title.push_str(" changed");
                Ok::<_, CoreError>(SavedReceiptData::SessionLifecycle {
                    state: s.state.clone(),
                    closed_at: s.closed_at.clone(),
                })
            },
        )
        .unwrap();
    assert_eq!(
        error(service.continue_topic(
            &target_context(),
            &continuing(&preview, 200),
            || panic!("stale preview must not allocate"),
            at()
        ))
        .code,
        CoreErrorCode::PreviewStale
    );
    assert_eq!(fs::read(session_path(&setup, 20)).unwrap(), target_bytes);
    let mut altered = preview.clone();
    altered.source_sha256 = Sha256::new("0".repeat(64)).unwrap();
    altered.source_revision = setup.store().read(&id(2)).unwrap().revision;
    assert_eq!(
        error(service.continue_topic(
            &target_context(),
            &continuing(&altered, 201),
            || panic!("bad hash must not allocate"),
            at()
        ))
        .code,
        CoreErrorCode::PreviewStale
    );
}

#[test]
fn target_publication_failure_preserves_both_sessions_and_saves_no_continuation() {
    let setup = Setup::new(&rich_seed());
    setup.store().create(&target_seed()).unwrap();
    let service = HistoryActionService::new(&setup.registry);
    let preview = service
        .preview(&target_context(), &request(id(16)))
        .unwrap();
    let source_bytes = setup.bytes();
    let target_bytes = fs::read(session_path(&setup, 20)).unwrap();
    fs::create_dir(
        store_dir(setup._home.path(), 1).join(format!("backups/{}.previous.json", id(20).as_str())),
    )
    .unwrap();
    assert!(matches!(
        service.continue_topic(
            &target_context(),
            &continuing(&preview, 200),
            allocator(10000),
            at()
        ),
        Err(HistoryActionError::Store(_))
    ));
    assert_eq!(setup.bytes(), source_bytes);
    assert_eq!(fs::read(session_path(&setup, 20)).unwrap(), target_bytes);
    let target = setup.store().read(&id(20)).unwrap();
    assert!(target.continuations.0.is_empty());
    assert!(target.inputs.0.is_empty());
    assert!(target.operation_receipts.0.is_empty());
}

#[test]
fn summary_and_final_formatted_payload_bounds_reject_without_publication() {
    let setup = Setup::new(&rich_seed());
    setup.store().create(&target_seed()).unwrap();
    let service = HistoryActionService::new(&setup.registry);
    let preview = service
        .preview(&target_context(), &request(id(16)))
        .unwrap();
    let source_bytes = setup.bytes();
    let target_bytes = fs::read(session_path(&setup, 20)).unwrap();
    let mut command = continuing(&preview, 200);
    let OwnerCommand::TopicContinue { params, .. } = &mut command else {
        unreachable!()
    };
    params.summary = "x".repeat(16 * 1024 + 1);
    assert_eq!(
        error(service.continue_topic(
            &target_context(),
            &command,
            || panic!("oversize summary must not allocate"),
            at()
        ))
        .code,
        CoreErrorCode::CapacityExceeded
    );
    let OwnerCommand::TopicContinue { params, .. } = &mut command else {
        unreachable!()
    };
    params.summary = "\u{0001}".repeat(16 * 1024);
    command.validate_wire().unwrap();
    assert_eq!(
        error(service.continue_topic(&target_context(), &command, allocator(10000), at())).code,
        CoreErrorCode::CapacityExceeded
    );
    assert_eq!(setup.bytes(), source_bytes);
    assert_eq!(fs::read(session_path(&setup, 20)).unwrap(), target_bytes);
}

#[test]
fn archived_closed_source_is_readable_and_external_replacement_becomes_explicit_imported_drop() {
    let mut original = rich_seed();
    original
        .items
        .0
        .get_mut(&ItemRef::new("7").unwrap())
        .unwrap()
        .replaced_by = Some(ItemRef::new("8").unwrap());
    let setup = Setup::new(&original);
    setup.store().create(&target_seed()).unwrap();
    let source_bytes = setup.bytes();
    let service = HistoryActionService::new(&setup.registry);
    let preview = service
        .preview(&target_context(), &request(id(16)))
        .unwrap();
    assert!(
        matches!(&preview.mapping.iter().find(|m| m.source_item_id.as_str() == "7").unwrap().action, ContinueCopyAction::ImportedDrop { external_replacement_id, .. } if external_replacement_id.as_str() == "8")
    );
    let receipt = continuation(
        service
            .continue_topic(
                &target_context(),
                &continuing(&preview, 200),
                allocator(10000),
                at(),
            )
            .unwrap(),
    );
    let target = setup.store().read(&id(20)).unwrap();
    let dropped = &target.items.0[&receipt.item_id_map.0[&ItemRef::new("7").unwrap()]];
    assert_eq!(dropped.status, ItemStatus::Dropped);
    assert!(dropped.replaced_by.is_none());
    let prior = dropped.status_history.last().unwrap();
    assert_eq!(prior.previous_replaced_by.as_ref().unwrap().as_str(), "8");
    assert_eq!(
        prior.previous_outcome,
        original.items.0[&ItemRef::new("7").unwrap()].outcome
    );
    assert_eq!(setup.bytes(), source_bytes);
    // The containing source can also be deliberately closed and archived.
    let mut closed = terminal_seed();
    closed.state = SessionState::Closed;
    closed.closed_at = Some(at());
    closed.topics.0.get_mut(&id(5)).unwrap().archived_at = Some(at());
    let second = Setup::new(&closed);
    second.store().create(&target_seed()).unwrap();
    let before = second.bytes();
    let service = HistoryActionService::new(&second.registry);
    let preview = service.preview(&target_context(), &request(id(5))).unwrap();
    let receipt = continuation(
        service
            .continue_topic(
                &target_context(),
                &continuing(&preview, 200),
                allocator(10000),
                at(),
            )
            .unwrap(),
    );
    let copied = second.store().read(&id(20)).unwrap();
    assert!(copied.topics.0[&receipt.target_topic_id]
        .archived_at
        .is_none());
    assert_eq!(second.bytes(), before);
}

#[test]
fn preview_and_commit_require_distinct_active_explicitly_bound_target() {
    let setup = Setup::new(&rich_seed());
    setup.store().create(&target_seed()).unwrap();
    let service = HistoryActionService::new(&setup.registry);
    let mut same = request(id(16));
    same.target = same.source.clone();
    let preview = service.preview(&context(), &same).unwrap();
    assert!(
        matches!(preview.readiness, ContinueReadiness::Blocked { reasons } if reasons == vec![ContinueBlockReason::SameSession])
    );
    let mut command = continuing(
        &service
            .preview(&target_context(), &request(id(16)))
            .unwrap(),
        200,
    );
    let OwnerCommand::TopicContinue { params, .. } = &mut command else {
        unreachable!()
    };
    params.target_binding_id = id(999);
    let before = fs::read(session_path(&setup, 20)).unwrap();
    assert_eq!(
        error(service.continue_topic(
            &target_context(),
            &command,
            || panic!("wrong binding must not allocate"),
            at()
        ))
        .code,
        CoreErrorCode::BindingMismatch
    );
    assert_eq!(fs::read(session_path(&setup, 20)).unwrap(), before);
    setup
        .store()
        .transact(
            &id(20),
            &ReceiptActorScope::Owner {},
            &id(500),
            &serde_json::json!({"kind":"close_target"}),
            |s| {
                s.state = SessionState::Closed;
                s.closed_at = Some(at());
                Ok::<_, CoreError>(SavedReceiptData::SessionLifecycle {
                    state: s.state.clone(),
                    closed_at: s.closed_at.clone(),
                })
            },
        )
        .unwrap();
    let preview = service
        .preview(&target_context(), &request(id(16)))
        .unwrap();
    assert!(
        matches!(&preview.readiness, ContinueReadiness::Blocked { reasons } if reasons == &vec![ContinueBlockReason::TargetClosed])
    );
    let before = fs::read(session_path(&setup, 20)).unwrap();
    assert_eq!(
        error(service.continue_topic(
            &target_context(),
            &continuing(&preview, 201),
            || panic!("closed target must not allocate"),
            at()
        ))
        .code,
        CoreErrorCode::InvalidTransition
    );
    assert_eq!(fs::read(session_path(&setup, 20)).unwrap(), before);
}

#[test]
fn pending_topic_inputs_block_archive_even_when_all_items_are_terminal() {
    let setup = Setup::new(&terminal_seed());
    let submit = OwnerCommand::InputSubmit {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(200),
        params: InputSubmitParams {
            binding_id: id(3),
            target: InputTarget {
                topic_id: id(5),
                item_id: Some(ItemRef::new("1").unwrap()),
            },
            kind: InputKind::Note,
            text: "Retained pending owner request".into(),
            selected_option_id: None,
            expected_question_revision: None,
            supersedes_answer_id: None,
        },
    };
    let input = ariadne_core::inputs::InputService::new(&setup.registry)
        .execute(&context(), &submit, allocator(10000), at())
        .unwrap();
    let SavedReceiptData::InputSubmit { input_id, .. } = saved(input).data else {
        unreachable!()
    };
    let before = setup.bytes();
    let service = HistoryActionService::new(&setup.registry);
    let rejected = error(service.execute(&context(), &command("archive", 1, 201), at()));
    let details = rejected.details.unwrap();
    assert!(details.blocking_item_ids.is_empty());
    assert_eq!(details.blocking_input_ids, vec![input_id.clone()]);
    let close = error(service.execute(&context(), &command("close", 2, 202), at()));
    assert_eq!(close.details.unwrap().blocking_input_ids, vec![input_id]);
    assert_eq!(setup.bytes(), before);
}

#[test]
fn missing_selection_and_queue_capacity_are_not_silent_retargeting() {
    let setup = Setup::new(&rich_seed());
    let mut target = target_seed();
    target.active_binding_id = None;
    setup.store().create(&target).unwrap();
    let service = HistoryActionService::new(&setup.registry);
    let preview = service
        .preview(&target_context(), &request(id(16)))
        .unwrap();
    assert!(
        matches!(&preview.readiness, ContinueReadiness::Blocked { reasons } if reasons == &vec![ContinueBlockReason::BindingUnknown])
    );
    let before = fs::read(session_path(&setup, 20)).unwrap();
    assert_eq!(
        error(service.continue_topic(
            &target_context(),
            &continuing(&preview, 200),
            || panic!("no selected binding"),
            at()
        ))
        .code,
        CoreErrorCode::BindingMismatch
    );
    assert_eq!(fs::read(session_path(&setup, 20)).unwrap(), before);

    let full = Setup::new(&rich_seed());
    full.store().create(&target_seed()).unwrap();
    let inputs = ariadne_core::inputs::InputService::new(&full.registry);
    for n in 0..100 {
        let command = OwnerCommand::InputSubmit {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(1000 + n),
            params: InputSubmitParams {
                binding_id: id(3),
                target: InputTarget {
                    topic_id: id(5),
                    item_id: Some(ItemRef::new("1").unwrap()),
                },
                kind: InputKind::Note,
                text: format!("Queued request {n}"),
                selected_option_id: None,
                expected_question_revision: None,
                supersedes_answer_id: None,
            },
        };
        inputs
            .execute(&target_context(), &command, allocator(20000 + n * 10), at())
            .unwrap();
    }
    let service = HistoryActionService::new(&full.registry);
    let preview = service
        .preview(&target_context(), &request(id(16)))
        .unwrap();
    let before = fs::read(session_path(&full, 20)).unwrap();
    assert_eq!(
        error(service.continue_topic(
            &target_context(),
            &continuing(&preview, 200),
            || panic!("queue full before allocations"),
            at()
        ))
        .code,
        CoreErrorCode::QueueFull
    );
    assert_eq!(fs::read(session_path(&full, 20)).unwrap(), before);
}

#[test]
fn continuation_uses_validated_source_snapshot_when_source_changes_after_its_lock_is_released() {
    let setup = Setup::new(&rich_seed());
    setup.store().create(&target_seed()).unwrap();
    let service = HistoryActionService::new(&setup.registry);
    let preview = service
        .preview(&target_context(), &request(id(16)))
        .unwrap();
    let original = setup.store().read(&id(2)).unwrap();
    let mut next = allocator(10000);
    let mut changed = false;
    let receipt = continuation(
        service
            .continue_topic(
                &target_context(),
                &continuing(&preview, 200),
                || {
                    if !changed {
                        // Allocation occurs under only the target lock. A separate source write
                        // must be possible here; its newer revision does not retarget the copy.
                        setup
                            .store()
                            .transact(
                                &id(2),
                                &ReceiptActorScope::Owner {},
                                &id(500),
                                &serde_json::json!({"kind":"source_after_check"}),
                                |s| {
                                    s.title.push_str(" changed after validation");
                                    Ok::<_, CoreError>(SavedReceiptData::SessionLifecycle {
                                        state: s.state.clone(),
                                        closed_at: s.closed_at.clone(),
                                    })
                                },
                            )
                            .unwrap();
                        changed = true;
                    }
                    next()
                },
                at(),
            )
            .unwrap(),
    );
    assert_eq!(receipt.source_revision, original.revision);
    assert_eq!(receipt.source_sha256, preview.source_sha256);
    assert_eq!(
        setup.store().read(&id(2)).unwrap().revision,
        p(original.revision.value() + 1)
    );
    let target = setup.store().read(&id(20)).unwrap();
    for (old, new) in &receipt.item_id_map.0 {
        assert_eq!(target.items.0[new].question, original.items.0[old].question);
    }
}

#[test]
fn continuation_writer_subprocess() {
    let Some(home) = std::env::var_os("ARIADNE_CONTINUATION_TEST_HOME") else {
        return;
    };
    let directory =
        std::path::PathBuf::from(std::env::var_os("ARIADNE_CONTINUATION_TEST_WRITER").unwrap());
    let registry = Registry::open(std::path::Path::new(&home)).unwrap();
    fs::write(directory.join("ready"), b"ready").unwrap();
    let start = directory.parent().unwrap().join("start");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while !start.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "writer start timed out"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let command: OwnerCommand =
        serde_json::from_slice(&fs::read(directory.join("command.json")).unwrap()).unwrap();
    let first: u64 = std::env::var("ARIADNE_CONTINUATION_TEST_FIRST")
        .unwrap()
        .parse()
        .unwrap();
    let receipt = HistoryActionService::new(&registry)
        .continue_topic(&target_context(), &command, allocator(first), at())
        .unwrap();
    fs::write(
        directory.join("receipt.json"),
        serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
}
struct Writer(std::process::Child);
impl Drop for Writer {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}
fn writers(same_operation: bool) {
    let setup = Setup::new(&rich_seed());
    setup.store().create(&target_seed()).unwrap();
    let source_bytes = setup.bytes();
    let service = HistoryActionService::new(&setup.registry);
    let preview = service
        .preview(&target_context(), &request(id(16)))
        .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let mut children = vec![];
    for n in 0..2 {
        let own = directory.path().join(n.to_string());
        fs::create_dir(&own).unwrap();
        let op = if same_operation { 200 } else { 200 + n };
        fs::write(
            own.join("command.json"),
            serde_json::to_vec(&continuing(&preview, op)).unwrap(),
        )
        .unwrap();
        children.push(Writer(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "continuation_writer_subprocess", "--nocapture"])
                .env("ARIADNE_CONTINUATION_TEST_HOME", setup._home.path())
                .env("ARIADNE_CONTINUATION_TEST_WRITER", &own)
                .env(
                    "ARIADNE_CONTINUATION_TEST_FIRST",
                    (10000 + n * 1000).to_string(),
                )
                .spawn()
                .unwrap(),
        ));
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !(0..2).all(|n| directory.path().join(n.to_string()).join("ready").exists()) {
        for child in &mut children {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "writer exited before readiness"
            );
        }
        assert!(
            std::time::Instant::now() < deadline,
            "writer readiness timed out"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    fs::write(directory.path().join("start"), b"start").unwrap();
    for child in &mut children {
        loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                assert!(status.success(), "continuation writer failed");
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "writer completion timed out"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    let receipts: Vec<MutationReceipt> = (0..2)
        .map(|n| {
            serde_json::from_slice(
                &fs::read(directory.path().join(n.to_string()).join("receipt.json")).unwrap(),
            )
            .unwrap()
        })
        .collect();
    let target = setup.store().read(&id(20)).unwrap();
    assert_eq!(setup.bytes(), source_bytes);
    if same_operation {
        assert_eq!(receipts[0], receipts[1]);
        assert_eq!(target.continuations.0.len(), 1);
        assert_eq!(target.inputs.0.len(), 1);
        assert_eq!(target.revision, p(2));
    } else {
        assert_eq!(target.continuations.0.len(), 2);
        assert_eq!(target.inputs.0.len(), 2);
        assert_eq!(target.revision, p(3));
        let mut seqs: Vec<_> = target.inputs.0.values().map(|i| i.seq.value()).collect();
        seqs.sort_unstable();
        assert_eq!(seqs, vec![1, 2]);
        for receipt in receipts {
            let receipt = continuation(receipt);
            assert_eq!(target.continuations.0[&receipt.operation_id], receipt);
        }
    }
}
#[test]
fn separate_writers_preserve_both_continuations_and_fifo_inputs() {
    writers(false);
}
#[test]
fn separate_same_operation_writers_return_one_exact_mapping_and_handoff() {
    writers(true);
}

#[test]
fn duplicate_native_ids_have_no_saved_effects() {
    let setup = Setup::new(&terminal_seed());
    let service = HistoryActionService::new(&setup.registry);
    setup.store().create(&target_seed()).unwrap();
    let preview = service.preview(&target_context(), &request(id(5))).unwrap();
    let before = fs::read(session_path(&setup, 20)).unwrap();
    assert_eq!(
        error(service.continue_topic(
            &target_context(),
            &continuing(&preview, 201),
            || id(3),
            at()
        ))
        .code,
        CoreErrorCode::InvalidArgument
    );
    assert_eq!(fs::read(session_path(&setup, 20)).unwrap(), before);
}

#[test]
fn continuation_crosses_registered_projects_without_copying_source_binding_authority() {
    let source = rich_seed();
    let setup = Setup::new(&source);
    let target_root = tempfile::tempdir().unwrap();
    setup
        .registry
        .register(target_root.path(), &id(90), || id(30))
        .unwrap();
    let mut target = target_seed();
    target.project_id = id(30);
    let target_store = Store::open_registered(&store_dir(setup._home.path(), 30), id(30)).unwrap();
    target_store.create(&target).unwrap();
    let owner = OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        RegisteredSession::from_trusted_entrypoint(id(30), id(20)),
    ));
    let mut request = request(id(16));
    request.target.project_id = id(30);
    let before = setup.bytes();
    let service = HistoryActionService::new(&setup.registry);
    let preview = service.preview(&owner, &request).unwrap();
    let receipt = continuation(
        service
            .continue_topic(&owner, &continuing(&preview, 200), allocator(10000), at())
            .unwrap(),
    );
    let copied = target_store.read(&id(20)).unwrap();
    assert_eq!(receipt.source_project_id, id(1));
    assert_eq!(copied.project_id, id(30));
    assert_eq!(copied.bindings, target.bindings);
    assert_eq!(copied.active_binding_id, target.active_binding_id);
    assert_eq!(setup.bytes(), before);
    for (old, new) in &receipt.message_id_map.0 {
        let original = source.messages.iter().find(|m| &m.id == old).unwrap();
        let imported = copied.messages.iter().find(|m| &m.id == new).unwrap();
        assert_eq!(imported.origin.as_ref().unwrap().project_id, id(1));
        assert_eq!(imported.binding_id, original.binding_id);
    }
}

#[test]
fn cross_topic_reply_retains_full_body_and_qualified_target_without_aliasing_local_items() {
    let mut source = rich_seed();
    let reply = source
        .messages
        .iter_mut()
        .find(|m| m.id == id(0x112))
        .unwrap();
    reply.items_touched.push(ItemRef::new("1").unwrap());
    reply.body = "x".repeat(64 * 1024);
    let original_reply = reply.clone();
    let setup = Setup::new(&source);
    let mut initial_target = target_seed();
    let mut collision = initial_target.items.0[&ItemRef::new("2").unwrap()].clone();
    collision.id = ItemRef::new("8").unwrap();
    collision.ordinal = p(8);
    initial_target
        .items
        .0
        .insert(collision.id.clone(), collision);
    initial_target.counters.next_root = p(9);
    initial_target.messages[0]
        .items_touched
        .push(ItemRef::new("8").unwrap());
    setup.store().create(&initial_target).unwrap();
    let source_bytes = setup.bytes();
    let service = HistoryActionService::new(&setup.registry);
    let preview = service
        .preview(&target_context(), &request(id(16)))
        .unwrap();
    let receipt = continuation(
        service
            .continue_topic(
                &target_context(),
                &continuing(&preview, 200),
                allocator(10000),
                at(),
            )
            .unwrap(),
    );
    let target = setup.store().read(&id(20)).unwrap();
    assert_eq!(setup.bytes(), source_bytes);
    let copied_id = &receipt.message_id_map.0[&original_reply.id];
    let copied = target.messages.iter().find(|m| &m.id == copied_id).unwrap();
    assert_eq!(copied.kind, MessageKind::Reply);
    assert_eq!(copied.body, original_reply.body);
    assert_eq!(copied.author, original_reply.author);
    assert_eq!(copied.binding_id, original_reply.binding_id);
    assert!(copied.item_id.is_none() && copied.topic_id.is_none() && copied.round_id.is_none());
    assert_eq!(
        copied.items_touched,
        vec![receipt.item_id_map.0[&ItemRef::new("1").unwrap()].clone()]
    );
    let route = &copied.origin.as_ref().unwrap().source_target;
    assert_eq!(route.project_id, source.project_id);
    assert_eq!(route.session_id, source.id);
    assert_eq!(route.topic_id, original_reply.topic_id);
    assert_eq!(route.item_id, original_reply.item_id);
    assert_eq!(route.round_id, original_reply.round_id);
    assert!(target.items.0.contains_key(route.item_id.as_ref().unwrap()));
    ariadne_domain::validation::validate_session_items(&target).unwrap();
    ariadne_domain::history::validate_session_history(&target).unwrap();

    // Copy the imported topic again: do not replace its direct historical route
    // with a null route or interpret the colliding ItemRef in the next session.
    let mut third = target_seed();
    third.id = id(30);
    setup.store().create(&third).unwrap();
    let next_context = OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        RegisteredSession::from_trusted_entrypoint(id(1), id(30)),
    ));
    let next_request = ContinuePreviewRequest {
        source: SessionRef {
            project_id: id(1),
            session_id: id(20),
        },
        source_topic_id: receipt.target_topic_id.clone(),
        target: SessionRef {
            project_id: id(1),
            session_id: id(30),
        },
    };
    let next_preview = service.preview(&next_context, &next_request).unwrap();
    let next_receipt = continuation(
        service
            .continue_topic(
                &next_context,
                &continuing(&next_preview, 201),
                allocator(20000),
                at(),
            )
            .unwrap(),
    );
    let next = setup.store().read(&id(30)).unwrap();
    let repeated = next
        .messages
        .iter()
        .find(|m| m.id == next_receipt.message_id_map.0[copied_id])
        .unwrap();
    assert_eq!(repeated.body, original_reply.body);
    assert_eq!(repeated.origin.as_ref().unwrap().source_target, *route);
    assert!(
        repeated.item_id.is_none() && repeated.topic_id.is_none() && repeated.round_id.is_none()
    );
    assert_eq!(setup.store().read(&id(20)).unwrap(), target);

    for variant in 0..4 {
        let mut invalid = target.clone();
        let message = invalid
            .messages
            .iter_mut()
            .find(|m| &m.id == copied_id)
            .unwrap();
        match variant {
            0 => message.origin = None,
            1 => {
                message.item_id = Some(ItemRef::new("8").unwrap());
                message.topic_id = Some(id(5));
            }
            2 => message.origin.as_mut().unwrap().entity_id = id(999999),
            _ => message.origin.as_mut().unwrap().source_target.item_id = None,
        }
        assert!(ariadne_domain::history::validate_session_history(&invalid).is_err());
        if variant != 1 {
            assert!(ariadne_domain::validation::validate_session_items(&invalid).is_err());
        }
    }
}

#[test]
fn same_topic_reply_maps_direct_target_and_retains_source_route() {
    let source = rich_seed();
    let original = source.messages.iter().find(|m| m.id == id(0x112)).unwrap();
    let setup = Setup::new(&source);
    setup.store().create(&target_seed()).unwrap();
    let service = HistoryActionService::new(&setup.registry);
    let preview = service
        .preview(&target_context(), &request(id(17)))
        .unwrap();
    let receipt = continuation(
        service
            .continue_topic(
                &target_context(),
                &continuing(&preview, 200),
                allocator(10000),
                at(),
            )
            .unwrap(),
    );
    let target = setup.store().read(&id(20)).unwrap();
    let reply = target
        .messages
        .iter()
        .find(|m| m.id == receipt.message_id_map.0[&original.id])
        .unwrap();
    assert_eq!(
        reply.item_id,
        Some(receipt.item_id_map.0[original.item_id.as_ref().unwrap()].clone())
    );
    assert_eq!(reply.topic_id, Some(receipt.target_topic_id));
    assert_eq!(
        reply.round_id,
        Some(receipt.round_id_map.0[original.round_id.as_ref().unwrap()].clone())
    );
    assert_eq!(
        reply.origin.as_ref().unwrap().source_target,
        MessageSourceTarget {
            project_id: source.project_id.clone(),
            session_id: source.id.clone(),
            topic_id: original.topic_id.clone(),
            item_id: original.item_id.clone(),
            round_id: original.round_id.clone()
        }
    );
}
