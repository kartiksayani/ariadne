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
fn reconnect_then_reopen_resumes_dispatch() {
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
    // Owner rule: reopen carries on; the pause close made is lifted.
    assert_eq!(binding.connection_state, ConnectionState::Connected);
    assert!(!binding.owner_paused);
    assert_eq!(binding.dispatch_state, DispatchState::Enabled);
}

#[test]
fn connected_enabled_binding_closes_in_one_step_and_no_binding_closes() {
    let session = terminal_seed();
    let mut enabled = session.clone();
    let binding = enabled.bindings.0.get_mut(&id(3)).unwrap();
    binding.dispatch_state = DispatchState::Enabled;
    binding.connection_state = ConnectionState::Connected;
    binding.owner_paused = false;
    let setup = Setup::new(&enabled);
    HistoryActionService::new(&setup.registry)
        .execute(&context(), &command("close", 1, 100), at())
        .unwrap();
    let closed = setup.store().read(&id(2)).unwrap();
    assert_eq!(closed.state, SessionState::Closed);
    let binding = &closed.bindings.0[&id(3)];
    assert!(binding.owner_paused);
    assert_eq!(binding.dispatch_state, DispatchState::Paused);
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
        "session_archive" => OwnerCommand::SessionArchive {
            api_version: version,
            op_id: id(op),
            params: SessionLifecycleParams {
                expected_revision: p(revision),
            },
        },
        "session_restore" => OwnerCommand::SessionRestore {
            api_version: version,
            op_id: id(op),
            params: SessionRestoreParams {
                reopen: false,
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
fn archive_restore_close_reopen_preserve_entities_and_reopen_lifts_the_owner_pause() {
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
    // Owner rule: reopen clears the owner pause, even an earlier explicit one.
    let binding = &live.bindings.0[&id(3)];
    assert!(original.bindings.0[&id(3)].owner_paused);
    assert!(!binding.owner_paused);
    assert_ne!(binding.dispatch_state, DispatchState::Paused);
    let mut expected = original.bindings.clone();
    let lifted = expected.0.get_mut(&id(3)).unwrap();
    lifted.owner_paused = false;
    lifted.dispatch_state = binding.dispatch_state.clone();
    assert_eq!(live.bindings, expected);
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
fn archive_and_close_leave_open_items_as_they_are_and_restore_brings_the_topic_back() {
    let original = seed();
    assert_eq!(
        original.items.0[&ItemRef::new("1").unwrap()].status,
        ItemStatus::Open
    );
    let setup = Setup::new(&original);
    let service = HistoryActionService::new(&setup.registry);
    // Owner rule: archive always succeeds; open items keep their status.
    let archived = saved(
        service
            .execute(&context(), &command("archive", 1, 100), at())
            .unwrap(),
    );
    let SavedReceiptData::TopicLifecycle {
        archived_at,
        cancelled_input_ids,
        ..
    } = archived.data
    else {
        panic!("lifecycle receipt")
    };
    assert!(archived_at.is_some());
    assert!(cancelled_input_ids.is_empty());
    let live = setup.store().read(&id(2)).unwrap();
    assert_eq!(live.items, original.items);
    service
        .execute(&context(), &command("restore", 2, 102), at())
        .unwrap();
    let restored = setup.store().read(&id(2)).unwrap();
    assert_eq!(restored.items, original.items);
    assert_eq!(restored.messages, original.messages);
    assert!(restored.topics.0[&id(5)].archived_at.is_none());
    // Owner rule: close is one step and never refused for open items.
    service
        .execute(
            &context(),
            &command("close", restored.revision.value(), 101),
            at(),
        )
        .unwrap();
    let closed = setup.store().read(&id(2)).unwrap();
    assert_eq!(closed.state, SessionState::Closed);
    assert_eq!(closed.items, original.items);
    assert!(closed.bindings.0[&id(3)].owner_paused);
}

#[test]
fn lifecycle_needs_owner_scope_and_close_needs_no_earlier_pause() {
    let mut session = terminal_seed();
    let binding = session.bindings.0.get_mut(&id(3)).unwrap();
    binding.dispatch_state = DispatchState::Enabled;
    binding.owner_paused = false;
    let setup = Setup::new(&session);
    let service = HistoryActionService::new(&setup.registry);
    let bytes = setup.bytes();
    let wrong = OwnerContext::from_trusted_entrypoint(OwnerScope::Registry);
    assert_eq!(
        error(service.execute(&wrong, &command("archive", 1, 101), at())).code,
        CoreErrorCode::PermissionDenied
    );
    assert_eq!(setup.bytes(), bytes);
    service
        .execute(&context(), &command("close", 1, 100), at())
        .unwrap();
    let binding = &setup.store().read(&id(2)).unwrap().bindings.0[&id(3)];
    assert!(binding.owner_paused);
    assert_ne!(binding.dispatch_state, DispatchState::Enabled);
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
        assert_eq!(copied.ack_to, old.ack_to);
        assert_eq!(copied.outcome, old.outcome);
        assert_eq!(copied.why, old.why);
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
                    archived_at: None,
                    cancelled_input_ids: vec![],
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
    assert_eq!(dropped.ack_to, None);
    assert!(dropped.replaced_by.is_none());
    assert_eq!(
        dropped.outcome.as_deref(),
        Some("Imported replacement outside the continued topic: 8")
    );
    assert_eq!(
        dropped.why.as_deref(),
        Some("The original source replacement remains provenance; it is not a live target edge.")
    );
    let prior = dropped.status_history.last().unwrap();
    assert_eq!(prior.previous_replaced_by.as_ref().unwrap().as_str(), "8");
    assert_eq!(
        prior.previous_outcome,
        original.items.0[&ItemRef::new("7").unwrap()].outcome
    );
    assert_eq!(
        prior.previous_why,
        original.items.0[&ItemRef::new("7").unwrap()].why
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
                    archived_at: None,
                    cancelled_input_ids: vec![],
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
fn archive_cancels_the_topics_unsent_inputs_and_restore_keeps_them_cancelled() {
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
    let items = setup.store().read(&id(2)).unwrap().items;
    let service = HistoryActionService::new(&setup.registry);
    // Owner rule: archive cancels the topic's unsent input and lists it,
    // as close does for the session.
    let archived = saved(
        service
            .execute(&context(), &command("archive", 1, 201), at())
            .unwrap(),
    );
    let SavedReceiptData::TopicLifecycle {
        cancelled_input_ids,
        ..
    } = archived.data
    else {
        panic!("lifecycle receipt")
    };
    assert_eq!(cancelled_input_ids, vec![input_id.clone()]);
    let live = setup.store().read(&id(2)).unwrap();
    assert_eq!(live.inputs.0[&input_id].state, InputState::Cancelled);
    // The owner's words stay recoverable: the input says archive cancelled it, not the owner.
    assert_eq!(
        live.inputs.0[&input_id].cancel_cause,
        Some(CancelCause::TopicArchived)
    );
    assert_eq!(live.items, items);
    // Restore brings the topic back; the cancelled input stays cancelled.
    let restored = saved(
        service
            .execute(&context(), &command("restore", 2, 202), at())
            .unwrap(),
    );
    assert!(matches!(
        restored.data,
        SavedReceiptData::TopicLifecycle { archived_at: None, ref cancelled_input_ids, .. }
            if cancelled_input_ids.is_empty()
    ));
    let live = setup.store().read(&id(2)).unwrap();
    assert_eq!(live.inputs.0[&input_id].state, InputState::Cancelled);
    assert!(live.topics.0[&id(5)].archived_at.is_none());
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
                                        archived_at: None,
                                        cancelled_input_ids: vec![],
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

#[test]
fn session_archive_closes_active_preserves_history_and_restore_stays_closed() {
    let original = seed();
    let setup = Setup::new(&original);
    let service = HistoryActionService::new(&setup.registry);
    let archive = command("session_archive", 1, 300);
    let receipt = service.execute(&context(), &archive, at()).unwrap();
    assert!(matches!(
        saved(receipt.clone()).data,
        SavedReceiptData::SessionLifecycle {
            state: SessionState::Closed,
            archived_at: Some(_),
            closed_at: Some(_),
            ..
        }
    ));
    let archived = setup.store().read(&id(2)).unwrap();
    assert_eq!(archived.items, original.items);
    assert_eq!(archived.topics, original.topics);
    assert_eq!(archived.rounds, original.rounds);
    assert_eq!(archived.answers, original.answers);
    assert_eq!(
        &archived.messages[..original.messages.len()],
        &original.messages
    );
    assert_eq!(archived.messages.last().unwrap().body, "Session archived.");
    assert!(archived.bindings.0[&id(3)].owner_paused);
    let bytes = setup.bytes();
    assert_eq!(
        service.execute(&context(), &archive, at()).unwrap(),
        receipt
    );
    assert_eq!(setup.bytes(), bytes);
    for (kind, revision, code) in [
        ("session_archive", 2, CoreErrorCode::InvalidTransition),
        ("reopen", 2, CoreErrorCode::InvalidTransition),
        ("session_restore", 1, CoreErrorCode::RevisionConflict),
    ] {
        assert_eq!(
            error(service.execute(&context(), &command(kind, revision, 301), at())).code,
            code
        );
        assert_eq!(setup.bytes(), bytes);
    }
    service
        .execute(&context(), &command("session_restore", 2, 302), at())
        .unwrap();
    let restored = setup.store().read(&id(2)).unwrap();
    assert!(restored.archived_at.is_none());
    assert_eq!(restored.state, SessionState::Closed);
    assert_eq!(restored.closed_at, archived.closed_at);
    assert_eq!(restored.bindings, archived.bindings);
    assert_eq!(
        restored.messages.last().unwrap().body,
        "Session restored; it remains closed."
    );
    assert_eq!(
        error(service.execute(&context(), &command("session_restore", 3, 303), at())).code,
        CoreErrorCode::InvalidTransition
    );
    service
        .execute(&context(), &command("reopen", 3, 304), at())
        .unwrap();
    assert_eq!(
        setup.store().read(&id(2)).unwrap().state,
        SessionState::Active
    );
}

#[test]
fn session_archive_of_closed_session_only_changes_archive_and_lifecycle_history() {
    let setup = Setup::new(&seed());
    let service = HistoryActionService::new(&setup.registry);
    service
        .execute(&context(), &command("close", 1, 300), at())
        .unwrap();
    let closed = setup.store().read(&id(2)).unwrap();
    service
        .execute(&context(), &command("session_archive", 2, 301), at())
        .unwrap();
    let archived = setup.store().read(&id(2)).unwrap();
    assert_eq!(archived.closed_at, closed.closed_at);
    assert_eq!(archived.bindings, closed.bindings);
    assert_eq!(archived.inputs, closed.inputs);
    assert_eq!(archived.items, closed.items);
    assert!(archived.archived_at.is_some());
}

#[test]
fn archived_source_blocks_continuation_and_old_preview_becomes_stale_without_writes() {
    let setup = Setup::new(&seed());
    setup.store().create(&target_seed()).unwrap();
    let service = HistoryActionService::new(&setup.registry);
    let initial = service.preview(&target_context(), &request(id(5))).unwrap();
    assert!(matches!(initial.readiness, ContinueReadiness::Ready { .. }));
    service
        .execute(&context(), &command("session_archive", 1, 300), at())
        .unwrap();
    let source_bytes = setup.bytes();
    let target_bytes = fs::read(session_path(&setup, 20)).unwrap();
    assert_eq!(
        error(service.continue_topic(
            &target_context(),
            &continuing(&initial, 200),
            || panic!("archiving invalidates the old preview before allocation"),
            at(),
        ))
        .code,
        CoreErrorCode::PreviewStale
    );
    let archived = service.preview(&target_context(), &request(id(5))).unwrap();
    assert!(matches!(
        &archived.readiness,
        ContinueReadiness::Blocked { reasons }
            if reasons == &vec![ContinueBlockReason::SourceArchived]
    ));
    assert_eq!(
        error(service.continue_topic(
            &target_context(),
            &continuing(&archived, 201),
            || panic!("archived source cannot allocate"),
            at(),
        ))
        .code,
        CoreErrorCode::InvalidTransition
    );
    assert_eq!(setup.bytes(), source_bytes);
    assert_eq!(fs::read(session_path(&setup, 20)).unwrap(), target_bytes);
    assert!(setup.store().read(&id(20)).unwrap().inputs.0.is_empty());
    // Restore leaves the source closed; history can still be continued from it.
    service
        .execute(&context(), &command("session_restore", 2, 301), at())
        .unwrap();
    let restored_bytes = setup.bytes();
    let restored = service.preview(&target_context(), &request(id(5))).unwrap();
    assert!(matches!(
        restored.readiness,
        ContinueReadiness::Ready { .. }
    ));
    service
        .continue_topic(
            &target_context(),
            &continuing(&restored, 202),
            allocator(10000),
            at(),
        )
        .unwrap();
    assert_eq!(setup.bytes(), restored_bytes);
    assert_eq!(
        setup.store().read(&id(2)).unwrap().state,
        SessionState::Closed
    );
}

#[test]
fn legacy_session_read_and_refused_archive_leave_original_store_bytes_untouched() {
    let setup = Setup::new(&seed());
    fs::write(
        session_path(&setup, 2),
        include_bytes!("../../../fixtures/domain/history/seed.json"),
    )
    .unwrap();
    let bytes = setup.bytes();
    assert!(serde_json::from_slice::<serde_json::Value>(&bytes)
        .unwrap()
        .get("archived_at")
        .is_none());
    assert!(setup.store().read(&id(2)).unwrap().archived_at.is_none());
    assert_eq!(setup.bytes(), bytes);
    assert_eq!(
        error(HistoryActionService::new(&setup.registry).execute(
            &context(),
            &command("session_archive", 9, 300),
            at()
        ))
        .code,
        CoreErrorCode::RevisionConflict
    );
    assert_eq!(setup.bytes(), bytes);
    let encoded = serde_json::to_value(setup.store().read(&id(2)).unwrap()).unwrap();
    assert!(encoded.get("archived_at").is_none());
}

#[test]
fn archive_history_id_and_counter_conflicts_roll_back_the_entire_close() {
    for collision in [true, false] {
        let mut original = seed();
        if !collision {
            original.counters.next_message = p(9_007_199_254_740_991);
        }
        let op = if collision {
            original.messages[0].id.clone()
        } else {
            id(300)
        };
        let setup = Setup::new(&original);
        let bytes = setup.bytes();
        let cmd = OwnerCommand::SessionArchive {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: op,
            params: SessionLifecycleParams {
                expected_revision: p(1),
            },
        };
        let code =
            error(HistoryActionService::new(&setup.registry).execute(&context(), &cmd, at())).code;
        assert_eq!(
            code,
            if collision {
                CoreErrorCode::InvalidArgument
            } else {
                CoreErrorCode::CapacityExceeded
            }
        );
        assert_eq!(setup.bytes(), bytes);
    }
}

#[test]
fn session_archive_cancels_queued_input_restore_keeps_it_cancelled_and_refuses_new_inputs() {
    let setup = Setup::new(&seed());
    let submit = OwnerCommand::InputSubmit {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(300),
        params: InputSubmitParams {
            binding_id: id(3),
            target: InputTarget {
                topic_id: id(5),
                item_id: Some(ItemRef::new("1").unwrap()),
            },
            kind: InputKind::Note,
            text: "Keep this owner request in saved history".into(),
            selected_option_id: None,
            expected_question_revision: None,
            supersedes_answer_id: None,
        },
    };
    let inputs = ariadne_core::inputs::InputService::new(&setup.registry);
    let SavedReceiptData::InputSubmit { input_id, .. } = saved(
        inputs
            .execute(&context(), &submit, allocator(10000), at())
            .unwrap(),
    )
    .data
    else {
        unreachable!()
    };
    let service = HistoryActionService::new(&setup.registry);
    let receipt = saved(
        service
            .execute(&context(), &command("session_archive", 2, 301), at())
            .unwrap(),
    );
    assert!(
        matches!(receipt.data, SavedReceiptData::SessionLifecycle { cancelled_input_ids, .. } if cancelled_input_ids == vec![input_id.clone()])
    );
    let archived = setup.store().read(&id(2)).unwrap();
    assert_eq!(
        archived.inputs.0[&input_id].cancel_cause,
        Some(CancelCause::SessionClosed)
    );
    let mut new_submit = submit.clone();
    if let OwnerCommand::InputSubmit { op_id, .. } = &mut new_submit {
        *op_id = id(302);
    }
    let bytes = setup.bytes();
    assert!(
        matches!(inputs.execute(&context(), &new_submit, || panic!("archived input allocates no IDs"), at()), Err(ariadne_core::inputs::InputError::Core(error)) if error.code == CoreErrorCode::InvalidTransition)
    );
    assert_eq!(setup.bytes(), bytes);
    service
        .execute(&context(), &command("session_restore", 3, 303), at())
        .unwrap();
    assert_eq!(
        setup.store().read(&id(2)).unwrap().inputs.0[&input_id].state,
        InputState::Cancelled
    );
}

#[test]
fn active_archive_undo_is_atomic_revision_guarded_replayable_and_resumes_sending() {
    let setup = Setup::new(&seed());
    let service = HistoryActionService::new(&setup.registry);
    service
        .execute(&context(), &command("session_archive", 1, 300), at())
        .unwrap();
    let undo = OwnerCommand::SessionRestore {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(301),
        params: SessionRestoreParams {
            expected_revision: p(2),
            reopen: true,
        },
    };
    let mut stale = undo.clone();
    if let OwnerCommand::SessionRestore { params, .. } = &mut stale {
        params.expected_revision = p(1);
    }
    let archived_bytes = setup.bytes();
    assert_eq!(
        error(service.execute(&context(), &stale, at())).code,
        CoreErrorCode::RevisionConflict
    );
    assert_eq!(setup.bytes(), archived_bytes);
    let mut collision = undo.clone();
    if let OwnerCommand::SessionRestore { op_id, .. } = &mut collision {
        *op_id = seed().messages[0].id.clone();
    }
    assert_eq!(
        error(service.execute(&context(), &collision, at())).code,
        CoreErrorCode::InvalidArgument
    );
    assert_eq!(setup.bytes(), archived_bytes);
    let receipt = service.execute(&context(), &undo, at()).unwrap();
    let restored = setup.store().read(&id(2)).unwrap();
    assert_eq!(restored.state, SessionState::Active);
    assert!(restored.archived_at.is_none());
    assert!(restored.closed_at.is_none());
    assert!(!restored.bindings.0[&id(3)].owner_paused);
    assert_eq!(
        restored.bindings.0[&id(3)].dispatch_state,
        DispatchState::Enabled
    );
    assert_eq!(
        restored.messages.last().unwrap().body,
        "Session restored and reopened."
    );
    let bytes = setup.bytes();
    assert_eq!(service.execute(&context(), &undo, at()).unwrap(), receipt);
    assert_eq!(setup.bytes(), bytes);
    let submit = OwnerCommand::InputSubmit {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(302),
        params: InputSubmitParams {
            binding_id: id(3),
            target: InputTarget {
                topic_id: id(5),
                item_id: Some(ItemRef::new("1").unwrap()),
            },
            kind: InputKind::Note,
            text: "Carry on after Undo".into(),
            selected_option_id: None,
            expected_question_revision: None,
            supersedes_answer_id: None,
        },
    };
    let input = saved(
        ariadne_core::inputs::InputService::new(&setup.registry)
            .execute(&context(), &submit, allocator(10000), at())
            .unwrap(),
    );
    let SavedReceiptData::InputSubmit { input_id, .. } = input.data else {
        unreachable!()
    };
    let dispatch = ValidatedDispatchContext::from_trusted_current_lease(
        RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
        id(3),
        id(4),
    );
    let claim = DeliveryService::new(&setup.registry)
        .claim(
            &dispatch,
            &ClaimRequest {
                binding_id: id(3),
                generation: id(4),
                request_id: id(303),
            },
            allocator(11000),
            at(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(claim.input_id, input_id);
}

#[test]
fn closed_archive_undo_preserves_closed_time_and_sending_pause() {
    let setup = Setup::new(&seed());
    let service = HistoryActionService::new(&setup.registry);
    service
        .execute(&context(), &command("close", 1, 300), at())
        .unwrap();
    let closed = setup.store().read(&id(2)).unwrap();
    service
        .execute(&context(), &command("session_archive", 2, 301), at())
        .unwrap();
    service
        .execute(&context(), &command("session_restore", 3, 302), at())
        .unwrap();
    let restored = setup.store().read(&id(2)).unwrap();
    assert_eq!(restored.state, SessionState::Closed);
    assert_eq!(restored.closed_at, closed.closed_at);
    assert_eq!(restored.bindings, closed.bindings);
}

#[test]
fn closed_archive_cancels_legacy_pending_inputs_without_changing_close_time() {
    let setup = Setup::new(&seed());
    let submit = OwnerCommand::InputSubmit {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(300),
        params: InputSubmitParams {
            binding_id: id(3),
            target: InputTarget {
                topic_id: id(5),
                item_id: Some(ItemRef::new("1").unwrap()),
            },
            kind: InputKind::Note,
            text: "Retained pending owner words".into(),
            selected_option_id: None,
            expected_question_revision: None,
            supersedes_answer_id: None,
        },
    };
    let queued = saved(
        ariadne_core::inputs::InputService::new(&setup.registry)
            .execute(&context(), &submit, allocator(10000), at())
            .unwrap(),
    );
    let SavedReceiptData::InputSubmit { input_id, .. } = queued.data else {
        unreachable!()
    };
    setup
        .store()
        .transact(
            &id(2),
            &ReceiptActorScope::Owner {},
            &id(301),
            &serde_json::json!({"kind":"legacy_closed"}),
            |session| {
                session.state = SessionState::Closed;
                session.closed_at = Some(at());
                let binding = session.bindings.0.get_mut(&id(3)).unwrap();
                binding.owner_paused = true;
                binding.dispatch_state = DispatchState::Paused;
                Ok::<_, CoreError>(SavedReceiptData::SessionLifecycle {
                    state: SessionState::Closed,
                    closed_at: session.closed_at.clone(),
                    archived_at: None,
                    cancelled_input_ids: vec![],
                })
            },
        )
        .unwrap();
    let archive_at = UtcMillis::new("2026-10-09T12:00:00.000Z").unwrap();
    let receipt = saved(
        HistoryActionService::new(&setup.registry)
            .execute(&context(), &command("session_archive", 3, 302), archive_at)
            .unwrap(),
    );
    assert!(
        matches!(receipt.data, SavedReceiptData::SessionLifecycle { cancelled_input_ids, .. } if cancelled_input_ids == vec![input_id.clone()])
    );
    let archived = setup.store().read(&id(2)).unwrap();
    assert_eq!(archived.closed_at, Some(at()));
    assert_eq!(archived.inputs.0[&input_id].state, InputState::Cancelled);
    assert!(archived
        .messages
        .iter()
        .any(|message| message.body == "Retained pending owner words"));
}

#[test]
fn answered_question_keeps_finished_or_ack_state_when_continued_without_reanswering() {
    for status in [ItemStatus::Done, ItemStatus::Open, ItemStatus::InProgress] {
        let mut source = seed();
        let key = ItemRef::new("1").unwrap();
        let item = source.items.0.get_mut(&key).unwrap();
        item.status = ItemStatus::WaitingOnMe;
        item.owner = ItemOwner::Me {};
        item.ask = Some("Confirm this completion?".into());
        item.waiting_since = Some(at());
        item.recipient_binding_id = Some(id(3));
        item.current_round_id = Some(id(30));
        source.rounds.0.insert(
            id(30),
            Round {
                id: id(30),
                item_id: key.clone(),
                ordinal: p(1),
                opened_message_id: id(6),
                question_snapshot: item.question.clone(),
                ask_snapshot: item.ask.clone(),
                options_snapshot: vec![],
                question_revision: p(1),
                owner_message_ids: vec![],
                agent_message_ids: vec![],
                result_input_ids: vec![],
                fork_item_ids: vec![],
                closed_at: None,
                origin: None,
            },
        );
        let initial = Setup::new(&source);
        let answer = OwnerCommand::InputSubmit {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(300),
            params: InputSubmitParams {
                binding_id: id(3),
                target: InputTarget {
                    topic_id: id(5),
                    item_id: Some(key.clone()),
                },
                kind: InputKind::Answer,
                text: "Confirmed.".into(),
                selected_option_id: None,
                expected_question_revision: Some(p(1)),
                supersedes_answer_id: None,
            },
        };
        crate_input_submit(&initial.registry, &answer);
        let mut answered = initial.store().read(&id(2)).unwrap();
        let watermark = answered.messages.last().unwrap().number;
        answered
            .bindings
            .0
            .get_mut(&id(3))
            .unwrap()
            .issued_through_message_number =
            NonnegativeSafeInteger::new(watermark.value()).unwrap();
        let setup = Setup::new(&answered);
        let agent = AgentContext::from_trusted_entrypoint(
            RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
            id(3),
            id(4),
            AgentReadScope::Terminal {
                issued_through_message_number: NonnegativeSafeInteger::new(watermark.value())
                    .unwrap(),
            },
        );
        let mut apply = ApplyRequest {
            op_id: id(310),
            source_input_id: None,
            attempt_id: None,
            expected_item_revisions: UniqueMap(Default::default()),
            expected_topic_revisions: UniqueMap(Default::default()),
            summary: "Completed the confirmed item.".into(),
            operations: vec![Operation::ItemStatus {
                item: EntityRef::Existing(ExistingRef { id: key.clone() }),
                status: status.clone(),
                ack_to: (status != ItemStatus::Done).then_some(AckTarget::Done),
                outcome: Some("Recorded complete result.".into()),
                why: Some("Owner confirmed.".into()),
                reason: Some("Owner confirmed the question.".into()),
            }],
            input_result: None,
        };
        apply
            .operations
            .push(Operation::RoundClose { round_id: id(30) });
        apply
            .expected_item_revisions
            .0
            .insert(key.clone(), answered.items.0[&key].revision);
        ariadne_core::apply::ApplyService::new(&setup.registry)
            .execute(&agent, &apply, || id(311), at())
            .unwrap();
        setup.store().create(&target_seed()).unwrap();
        let service = HistoryActionService::new(&setup.registry);
        let preview = service.preview(&target_context(), &request(id(5))).unwrap();
        let receipt = continuation(
            service
                .continue_topic(
                    &target_context(),
                    &continuing(&preview, 320),
                    allocator(10000),
                    at(),
                )
                .unwrap(),
        );
        let copied = setup.store().read(&id(20)).unwrap();
        let copied_id = receipt.item_id_map.0[&key].clone();
        let item = &copied.items.0[&copied_id];
        assert_eq!(item.status, status);
        assert_eq!(
            item.ack_to,
            (status != ItemStatus::Done).then_some(AckTarget::Done)
        );
        assert_eq!(item.current_round_id, None);
        assert!(copied
            .rounds
            .0
            .values()
            .any(|round| round.item_id == copied_id && round.closed_at.is_some()));
        assert_eq!(item.question_revision, p(2));
        assert_eq!(item.ask.as_deref(), Some("Confirm this completion?"));
        assert!(!ariadne_core::queries::waiting_unanswered(&copied, item));
        if status == ItemStatus::Done {
            assert_eq!(item.outcome.as_deref(), Some("Recorded complete result."));
            continue;
        }
        let ack = OwnerCommand::Ack {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(330),
            params: ItemAckParams {
                item_id: copied_id.clone(),
                expected_revision: item.revision,
            },
        };
        service
            .acknowledge(&target_context(), &ack, at(), || id(331))
            .unwrap();
        let acknowledged = setup.store().read(&id(20)).unwrap();
        assert_eq!(acknowledged.items.0[&copied_id].status, ItemStatus::Done);
        assert_eq!(
            acknowledged.items.0[&copied_id].outcome.as_deref(),
            Some("Recorded complete result.")
        );
        assert_eq!(acknowledged.inputs, copied.inputs);
    }
}

#[test]
fn continuation_preserves_each_finished_status_and_pending_ack_proposal() {
    for status in [ItemStatus::Decided, ItemStatus::Done, ItemStatus::Dropped] {
        let mut source = terminal_seed();
        let finished_key = ItemRef::new("1").unwrap();
        source.items.0.get_mut(&finished_key).unwrap().status = status.clone();
        let proposed_key = ItemRef::new("2").unwrap();
        let proposed = source.items.0.get_mut(&proposed_key).unwrap();
        proposed.status = ItemStatus::Open;
        proposed.ack_to = Some(AckTarget::Done);
        let setup = Setup::new(&source);
        setup.store().create(&target_seed()).unwrap();
        let source_bytes = setup.bytes();
        let service = HistoryActionService::new(&setup.registry);
        let preview = service.preview(&target_context(), &request(id(5))).unwrap();
        assert!(preview.summary.contains("Finished states"));
        assert!(preview
            .mapping
            .iter()
            .all(|mapping| matches!(mapping.action, ContinueCopyAction::Copy {})));
        let receipt = continuation(
            service
                .continue_topic(
                    &target_context(),
                    &continuing(&preview, 400),
                    allocator(10000),
                    at(),
                )
                .unwrap(),
        );
        let target = setup.store().read(&id(20)).unwrap();
        let finished = &target.items.0[&receipt.item_id_map.0[&finished_key]];
        assert_eq!(finished.status, status);
        assert_eq!(finished.ack_to, None);
        assert_eq!(finished.outcome, source.items.0[&finished_key].outcome);
        assert_eq!(finished.why, source.items.0[&finished_key].why);
        let proposal = &target.items.0[&receipt.item_id_map.0[&proposed_key]];
        assert_eq!(proposal.status, ItemStatus::Open);
        assert_eq!(proposal.ack_to, Some(AckTarget::Done));
        assert_eq!(proposal.outcome, source.items.0[&proposed_key].outcome);
        assert_eq!(proposal.why, source.items.0[&proposed_key].why);
        assert_eq!(setup.bytes(), source_bytes);
    }
}

#[test]
fn continuation_restores_unanswered_legacy_ask_to_waiting_and_allows_owner_answer() {
    for (status, episode) in [
        (ItemStatus::Open, "none"),
        (ItemStatus::InProgress, "none"),
        (ItemStatus::Open, "open"),
        (ItemStatus::Open, "closed"),
        (ItemStatus::Open, "handled_reply"),
        (ItemStatus::Open, "cancelled_answer"),
        (ItemStatus::WaitingOnMe, "cancelled_answer"),
    ] {
        let mut source = seed();
        let key = ItemRef::new("1").unwrap();
        let item = source.items.0.get_mut(&key).unwrap();
        item.status = status.clone();
        item.ask = Some("May I finish this change?".into());
        item.ack_to = Some(AckTarget::Done);
        item.outcome = Some("Prepared the change.".into());
        item.why = Some("The owner needs to confirm first.".into());
        item.options = vec![ItemOption {
            id: "go".into(),
            label: "Got it, go ahead".into(),
            consequence: "Finish the prepared change.".into(),
            recommended: true,
        }];
        if episode != "none" {
            let item = source.items.0.get_mut(&key).unwrap();
            item.status = ItemStatus::WaitingOnMe;
            item.waiting_since = Some(at());
            item.owner = ItemOwner::Me {};
            item.recipient_binding_id = Some(id(3));
            item.current_round_id = Some(id(30));
            source.rounds.0.insert(
                id(30),
                Round {
                    id: id(30),
                    item_id: key.clone(),
                    ordinal: p(1),
                    opened_message_id: id(6),
                    question_snapshot: item.question.clone(),
                    ask_snapshot: item.ask.clone(),
                    options_snapshot: item.options.clone(),
                    question_revision: item.question_revision,
                    owner_message_ids: vec![],
                    agent_message_ids: vec![],
                    result_input_ids: vec![],
                    fork_item_ids: vec![],
                    closed_at: None,
                    origin: None,
                },
            );
            let initial = Setup::new(&source);
            let is_answer = episode == "cancelled_answer";
            crate_input_submit(
                &initial.registry,
                &OwnerCommand::InputSubmit {
                    api_version: SchemaVersion::new(1).unwrap(),
                    op_id: id(300),
                    params: InputSubmitParams {
                        binding_id: id(3),
                        target: InputTarget {
                            topic_id: id(5),
                            item_id: Some(key.clone()),
                        },
                        kind: if is_answer {
                            InputKind::Answer
                        } else {
                            InputKind::Reply
                        },
                        text: "Please finish.".into(),
                        selected_option_id: is_answer.then(|| "go".into()),
                        expected_question_revision: is_answer.then_some(p(1)),
                        supersedes_answer_id: None,
                    },
                },
            );
            source = initial.store().read(&id(2)).unwrap();
            let item = source.items.0.get_mut(&key).unwrap();
            item.status = status;
            item.waiting_since = (item.status == ItemStatus::WaitingOnMe).then(at);
            item.question_revision = p(if item.status == ItemStatus::WaitingOnMe {
                1
            } else {
                2
            });
            let round_id = item.current_round_id.clone().unwrap();
            if episode == "closed" {
                source.rounds.0.get_mut(&round_id).unwrap().closed_at = Some(at());
            }
            let input = source.inputs.0.values_mut().next().unwrap();
            if episode == "handled_reply" {
                input.state = InputState::Handled;
            }
            if is_answer {
                input.state = InputState::Cancelled;
                input.cancel_cause = Some(CancelCause::Owner);
            }
        }
        let setup = Setup::new(&source);
        setup.store().create(&target_seed()).unwrap();
        let source_bytes = setup.bytes();
        let service = HistoryActionService::new(&setup.registry);
        let preview = service.preview(&target_context(), &request(id(5))).unwrap();
        let receipt = continuation(
            service
                .continue_topic(
                    &target_context(),
                    &continuing(&preview, 400),
                    allocator(10000),
                    at(),
                )
                .unwrap(),
        );
        let target = setup.store().read(&id(20)).unwrap();
        let copied_key = receipt.item_id_map.0[&key].clone();
        let copied = &target.items.0[&copied_key];
        assert_eq!(copied.status, ItemStatus::WaitingOnMe);
        assert_eq!(copied.owner, ItemOwner::Me {});
        assert_eq!(copied.recipient_binding_id, Some(id(3)));
        assert_eq!(copied.waiting_since, Some(at()));
        assert_eq!(copied.ack_to, Some(AckTarget::Done));
        assert_eq!(copied.outcome, source.items.0[&key].outcome);
        assert_eq!(copied.why, source.items.0[&key].why);
        assert!(ariadne_core::queries::waiting_unanswered(&target, copied));
        let round = &target.rounds.0[copied.current_round_id.as_ref().unwrap()];
        assert_eq!(
            copied.question_revision.value(),
            source.items.0[&key].question_revision.value() + 1
        );
        for old_round in target
            .rounds
            .0
            .values()
            .filter(|r| r.item_id == copied_key && r.id != round.id)
        {
            assert!(old_round.closed_at.is_some());
        }
        assert_eq!(round.question_revision, copied.question_revision);
        assert_eq!(round.ask_snapshot, copied.ask);
        assert_eq!(round.options_snapshot, copied.options);
        let ack = OwnerCommand::Ack {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(410),
            params: ItemAckParams {
                item_id: copied_key.clone(),
                expected_revision: copied.revision,
            },
        };
        assert_eq!(
            error(service.acknowledge(&target_context(), &ack, at(), || id(411))).code,
            CoreErrorCode::InvalidTransition
        );
        let answer = OwnerCommand::InputSubmit {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(420),
            params: InputSubmitParams {
                binding_id: id(3),
                target: InputTarget {
                    topic_id: receipt.target_topic_id,
                    item_id: Some(copied_key.clone()),
                },
                kind: InputKind::Answer,
                text: "Go ahead.".into(),
                selected_option_id: Some("go".into()),
                expected_question_revision: Some(copied.question_revision),
                supersedes_answer_id: None,
            },
        };
        ariadne_core::inputs::InputService::new(&setup.registry)
            .execute(&target_context(), &answer, allocator(20000), at())
            .unwrap();
        let answered = setup.store().read(&id(20)).unwrap();
        assert!(!ariadne_core::queries::waiting_unanswered(
            &answered,
            &answered.items.0[&copied_key]
        ));
        assert_eq!(answered.answers.last().unwrap().item_id, copied_key);
        assert_eq!(
            answered
                .answers
                .last()
                .unwrap()
                .selected_option_id
                .as_deref(),
            Some("go")
        );
        assert_eq!(setup.bytes(), source_bytes);
    }
}

fn crate_input_submit(registry: &Registry, command: &OwnerCommand) {
    ariadne_core::inputs::InputService::new(registry)
        .execute(&context(), command, allocator(301), at())
        .unwrap();
}
