use super::*;
use std::fs;

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn removal_source(session: &mut Session, item_id: Option<ItemRef>) -> AgentRemovalSource {
    let mut message = session.messages[0].clone();
    let message_id = id(80000 + session.counters.next_message.value());
    message.id = message_id.clone();
    message.number = session.counters.next_message;
    session.counters.next_message = PositiveSafeInteger::new(message.number.value() + 1).unwrap();
    message.author = MessageAuthor::System;
    message.kind = MessageKind::Lifecycle;
    message.body = "Agent removed saved entries".into();
    message.topic_id = Some(id(5));
    message.item_id = item_id;
    message.created_at = session.updated_at.clone();
    message.items_touched.clear();
    session.messages.push(message);
    AgentRemovalSource {
        binding_id: id(3),
        message_id,
    }
}

#[test]
fn locked_replay_wins_over_stale_owned_source_after_initial_replay_miss() {
    let root = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let registry = ariadne_store::registry::Registry::open(home.path()).unwrap();
    registry.register(root.path(), &id(99), || id(1)).unwrap();
    let store = Store::open_registered(&registry.project_dir(&id(1)), id(1)).unwrap();
    let source: Session = serde_json::from_str(include_str!(
        "../../../../../fixtures/domain/history/seed.json"
    ))
    .unwrap();
    store.create(&source).unwrap();
    let mut target = source.clone();
    target.id = id(20);
    store.create(&target).unwrap();
    let params = TopicContinueParams {
        source: SessionRef {
            project_id: id(1),
            session_id: id(2),
        },
        source_topic_id: id(5),
        source_revision: source.revision,
        source_sha256: preview::hash(&source, &id(5)).unwrap(),
        target: SessionRef {
            project_id: id(1),
            session_id: id(20),
        },
        target_binding_id: id(3),
        summary: "Copy this complete source snapshot.".into(),
    };
    let normalized = crate::receipts::normalized("topic_continue", &params).unwrap();
    let command = OwnerCommand::TopicContinue {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(200),
        params,
    };
    // A retry observes a miss before another identical request commits.
    assert!(store
        .replay(&id(20), &ReceiptActorScope::Owner {}, &id(200), &normalized)
        .unwrap()
        .is_none());
    let at = UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap();
    let mut next = 10000;
    let saved = commit_snapshot(
        &store,
        &source,
        &command,
        &normalized,
        &mut || {
            next += 1;
            id(next)
        },
        &at,
    )
    .unwrap();
    let source_path = registry
        .project_dir(&id(1))
        .join(format!("sessions/{}.json", id(2).as_str()));
    let target_path = registry
        .project_dir(&id(1))
        .join(format!("sessions/{}.json", id(20).as_str()));
    let source_bytes = fs::read(&source_path).unwrap();
    let target_bytes = fs::read(&target_path).unwrap();
    // The retry then captures stale source state. Its transaction must replay
    // the competing saved operation without running freshness or allocation.
    let mut stale = source.clone();
    stale.revision = PositiveSafeInteger::new(source.revision.value() + 1).unwrap();
    let replay = commit_snapshot(
        &store,
        &stale,
        &command,
        &normalized,
        &mut || panic!("replay cannot allocate"),
        &at,
    )
    .unwrap();
    assert_eq!(replay, saved);
    assert_eq!(fs::read(&target_path).unwrap(), target_bytes);
    assert_eq!(fs::read(&source_path).unwrap(), source_bytes);
    assert_eq!(store.read(&id(20)).unwrap().continuations.0.len(), 1);
    // A genuinely unsaved stale action fails inside the same transaction and
    // publishes no receipt/copy/handoff or changes to either session.
    let mut fresh = command.clone();
    let OwnerCommand::TopicContinue { op_id, .. } = &mut fresh else {
        unreachable!()
    };
    *op_id = id(201);
    let failure = commit_snapshot(
        &store,
        &stale,
        &fresh,
        &normalized,
        &mut || panic!("stale cannot allocate"),
        &at,
    )
    .unwrap_err();
    assert!(matches!(
        failure,
        HistoryActionError::Core(CoreError {
            code: CoreErrorCode::PreviewStale,
            ..
        })
    ));
    assert_eq!(fs::read(&target_path).unwrap(), target_bytes);
    assert_eq!(fs::read(&source_path).unwrap(), source_bytes);
}

#[test]
fn continuation_keeps_ack_proposals_and_remaps_related_without_external_collisions() {
    let root = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let registry = ariadne_store::registry::Registry::open(home.path()).unwrap();
    registry.register(root.path(), &id(99), || id(1)).unwrap();
    let store = Store::open_registered(&registry.project_dir(&id(1)), id(1)).unwrap();
    let mut source: Session = serde_json::from_str(include_str!(
        "../../../../../fixtures/domain/history/seed.json"
    ))
    .unwrap();
    let source_item = ItemRef::new("1").unwrap();
    let internal = ItemRef::new("2").unwrap();
    let external = ItemRef::new("99").unwrap();
    source.items.0.get_mut(&source_item).unwrap().related = Some(vec![
        internal.clone(),
        external.clone(),
        ItemRef::new("98").unwrap(),
    ]);
    let proposal = source.items.0.get_mut(&source_item).unwrap();
    proposal.ack_to = Some(AckTarget::Done);
    proposal.outcome = Some("Exact completion proposal.".into());
    proposal.why = Some("Exact supporting evidence.".into());
    source.items.0.get_mut(&internal).unwrap().related = Some(vec![source_item.clone()]);
    let mut outside_topic = source.topics.0[&id(5)].clone();
    outside_topic.id = id(7);
    outside_topic.order = PositiveSafeInteger::new(2).unwrap();
    source.topics.0.insert(id(7), outside_topic);
    source.counters.next_topic_order = PositiveSafeInteger::new(3).unwrap();
    let mut outside_item = source.items.0[&internal].clone();
    outside_item.id = external.clone();
    outside_item.ordinal = PositiveSafeInteger::new(99).unwrap();
    outside_item.topic_id = id(7);
    source
        .messages
        .iter_mut()
        .find(|message| message.id == outside_item.created_message_id)
        .unwrap()
        .items_touched
        .push(external.clone());
    source.items.0.insert(external.clone(), outside_item);
    source.counters.next_root = PositiveSafeInteger::new(100).unwrap();
    store.create(&source).unwrap();
    let mut target = source.clone();
    target.id = id(20);
    let mut collision = target.items.0[&internal].clone();
    collision.id = external.clone();
    collision.ordinal = PositiveSafeInteger::new(99).unwrap();
    target.items.0.insert(external.clone(), collision);
    target.counters.next_root = PositiveSafeInteger::new(100).unwrap();
    store.create(&target).unwrap();
    let params = TopicContinueParams {
        source: SessionRef {
            project_id: id(1),
            session_id: id(2),
        },
        source_topic_id: id(5),
        source_revision: source.revision,
        source_sha256: preview::hash(&source, &id(5)).unwrap(),
        target: SessionRef {
            project_id: id(1),
            session_id: id(20),
        },
        target_binding_id: id(3),
        summary: "Copy the topic with its related declarations.".into(),
    };
    let normalized = crate::receipts::normalized("topic_continue", &params).unwrap();
    let command = OwnerCommand::TopicContinue {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(200),
        params,
    };
    let at = UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap();
    let mut next = 10000;
    commit_snapshot(
        &store,
        &source,
        &command,
        &normalized,
        &mut || {
            next += 1;
            id(next)
        },
        &at,
    )
    .unwrap();
    let copied = store.read(&id(20)).unwrap();
    assert_eq!(
        copied.items.0[&ItemRef::new("100").unwrap()].related,
        Some(vec![ItemRef::new("101").unwrap()])
    );
    assert_eq!(
        copied.items.0[&ItemRef::new("101").unwrap()].related,
        Some(vec![ItemRef::new("100").unwrap()])
    );
    let proposal = &copied.items.0[&ItemRef::new("100").unwrap()];
    assert_eq!(proposal.status, ItemStatus::Open);
    assert_eq!(proposal.ack_to, Some(AckTarget::Done));
    assert_eq!(proposal.outcome, source.items.0[&source_item].outcome);
    assert_eq!(proposal.why, source.items.0[&source_item].why);
    assert_eq!(
        copied.items.0[&source_item].related,
        source.items.0[&source_item].related
    );
    assert!(copied.items.0.contains_key(&external));
    assert_eq!(store.read(&id(2)).unwrap(), source);
}

#[test]
fn continuation_skips_removed_subtrees_and_drops_destination_references_to_them() {
    let root = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let registry = ariadne_store::registry::Registry::open(home.path()).unwrap();
    registry.register(root.path(), &id(99), || id(1)).unwrap();
    let store = Store::open_registered(&registry.project_dir(&id(1)), id(1)).unwrap();
    let mut source: Session = serde_json::from_str(include_str!(
        "../../../../../fixtures/domain/history/seed.json"
    ))
    .unwrap();
    let first = ItemRef::new("1").unwrap();
    let removed = ItemRef::new("2").unwrap();
    let child_id = ItemRef::new("2.1").unwrap();
    let mut child = source.items.0[&removed].clone();
    child.id = child_id.clone();
    child.ordinal = PositiveSafeInteger::new(1).unwrap();
    child.parent = Some(removed.clone());
    source.items.0.insert(child_id.clone(), child);
    source.items.0.get_mut(&removed).unwrap().next_child = PositiveSafeInteger::new(2).unwrap();
    let provenance = removal_source(&mut source, Some(removed.clone()));
    source.items.0.get_mut(&removed).unwrap().removed_at = Some(source.updated_at.clone());
    source.items.0.get_mut(&removed).unwrap().removed_by = Some(provenance);
    source.messages[0].items_touched.push(child_id);
    let mut removed_message = source.messages[0].clone();
    removed_message.id = id(80);
    removed_message.number = source.counters.next_message;
    removed_message.item_id = Some(removed.clone());
    removed_message.items_touched = vec![removed.clone()];
    removed_message.body = "Only the removed item was updated".into();
    source.messages.push(removed_message);
    source.counters.next_message =
        PositiveSafeInteger::new(source.counters.next_message.value() + 1).unwrap();
    let item = source.items.0.get_mut(&first).unwrap();
    item.related = Some(vec![removed.clone()]);
    item.status = ItemStatus::Replaced;
    item.replaced_by = Some(removed.clone());
    item.outcome = Some("Replaced by the retained source item".into());
    item.why = Some("The source replacement remains the original evidence".into());
    item.status_history.push(StatusHistoryEntry {
        old_status: ItemStatus::Replaced,
        new_status: ItemStatus::Replaced,
        previous_outcome: Some("Original source outcome".into()),
        previous_why: None,
        previous_replaced_by: Some(removed.clone()),
        cause_message_id: id(6),
        at: source.updated_at.clone(),
        binding_id: None,
        handled_through_message_number: NonnegativeSafeInteger::new(0).unwrap(),
        reason: None,
    });
    item.next_child = PositiveSafeInteger::new(2).unwrap();
    let fork_id = ItemRef::new("1.1").unwrap();
    let mut fork = source.items.0[&removed].clone();
    fork.id = fork_id.clone();
    fork.ordinal = PositiveSafeInteger::new(1).unwrap();
    fork.parent = Some(first.clone());
    fork.source_round_id = Some(id(90));
    fork.removed_by = Some(removal_source(&mut source, Some(fork_id.clone())));
    source.items.0.insert(fork_id.clone(), fork);
    source.messages[0].items_touched.push(fork_id.clone());
    source.rounds.0.insert(
        id(90),
        Round {
            id: id(90),
            item_id: first.clone(),
            ordinal: PositiveSafeInteger::new(1).unwrap(),
            opened_message_id: id(6),
            question_snapshot: source.items.0[&first].question.clone(),
            ask_snapshot: None,
            options_snapshot: vec![],
            question_revision: PositiveSafeInteger::new(1).unwrap(),
            owner_message_ids: vec![],
            agent_message_ids: vec![],
            result_input_ids: vec![],
            fork_item_ids: vec![fork_id],
            closed_at: Some(source.updated_at.clone()),
            origin: None,
        },
    );
    store.create(&source).unwrap();
    let mut target: Session = serde_json::from_str(include_str!(
        "../../../../../fixtures/domain/history/seed.json"
    ))
    .unwrap();
    target.id = id(20);
    store.create(&target).unwrap();
    let params = TopicContinueParams {
        source: SessionRef {
            project_id: id(1),
            session_id: id(2),
        },
        source_topic_id: id(5),
        source_revision: source.revision,
        source_sha256: preview::hash(&source, &id(5)).unwrap(),
        target: SessionRef {
            project_id: id(1),
            session_id: id(20),
        },
        target_binding_id: id(3),
        summary: "Copy only visible items".into(),
    };
    let normalized = crate::receipts::normalized("topic_continue", &params).unwrap();
    let command = OwnerCommand::TopicContinue {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(200),
        params,
    };
    let at = UtcMillis::new("2026-10-09T12:00:00.000Z").unwrap();
    let mut next = 10000;
    let saved = commit_snapshot(
        &store,
        &source,
        &command,
        &normalized,
        &mut || {
            next += 1;
            id(next)
        },
        &at,
    )
    .unwrap();
    let SavedReceiptData::Continuation { continuation } = saved.data else {
        panic!("continuation")
    };
    assert_eq!(continuation.item_id_map.0.len(), 1);
    assert!(!continuation.message_id_map.0.contains_key(&id(80)));
    let copied = store.read(&id(20)).unwrap();
    assert!(copied.rounds.0[&continuation.round_id_map.0[&id(90)]]
        .fork_item_ids
        .is_empty());
    let item = &copied.items.0[&continuation.item_id_map.0[&first]];
    assert_eq!(item.related, Some(vec![]));
    assert_eq!(item.status, ItemStatus::Dropped);
    assert!(item.replaced_by.is_none());
    assert!(item
        .status_history
        .iter()
        .all(|entry| entry.previous_replaced_by.is_none()));
    assert_eq!(store.read(&id(2)).unwrap(), source);
    let mapping = preview::actions(&source, &id(5));
    assert_eq!(mapping.len(), 1);
    assert!(matches!(
        mapping[0].action,
        ContinueCopyAction::ImportedDrop { .. }
    ));
}

#[test]
fn removed_source_topic_refuses_preview_and_continuation_without_target_writes() {
    let root = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let registry = ariadne_store::registry::Registry::open(home.path()).unwrap();
    registry.register(root.path(), &id(99), || id(1)).unwrap();
    let store = Store::open_registered(&registry.project_dir(&id(1)), id(1)).unwrap();
    let mut source: Session = serde_json::from_str(include_str!(
        "../../../../../fixtures/domain/history/seed.json"
    ))
    .unwrap();
    let provenance = removal_source(&mut source, None);
    source.topics.0.get_mut(&id(5)).unwrap().removed_at = Some(source.updated_at.clone());
    source.topics.0.get_mut(&id(5)).unwrap().removed_by = Some(provenance);
    store.create(&source).unwrap();
    let mut target = source.clone();
    target.id = id(20);
    store.create(&target).unwrap();
    let request = ContinuePreviewRequest {
        source: SessionRef {
            project_id: id(1),
            session_id: id(2),
        },
        source_topic_id: id(5),
        target: SessionRef {
            project_id: id(1),
            session_id: id(20),
        },
    };
    let context = OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        RegisteredSession::from_trusted_entrypoint(id(1), id(20)),
    ));
    let service = HistoryActionService::new(&registry);
    assert!(matches!(
        service.preview(&context, &request),
        Err(HistoryActionError::Core(CoreError {
            code: CoreErrorCode::InvalidTransition,
            ..
        }))
    ));
    let command = OwnerCommand::TopicContinue {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(200),
        params: TopicContinueParams {
            source: request.source,
            source_topic_id: id(5),
            source_revision: source.revision,
            source_sha256: preview::hash(&source, &id(5)).unwrap(),
            target: request.target,
            target_binding_id: id(3),
            summary: "Cannot copy a removed topic".into(),
        },
    };
    assert!(matches!(
        service.continue_topic(
            &context,
            &command,
            || panic!("removed topic must refuse before allocation"),
            source.updated_at.clone()
        ),
        Err(HistoryActionError::Core(CoreError {
            code: CoreErrorCode::InvalidTransition,
            ..
        }))
    ));
    assert_eq!(store.read(&id(20)).unwrap(), target);
    assert_eq!(store.read(&id(2)).unwrap(), source);
}
