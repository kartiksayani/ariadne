use super::*;
use std::fs;

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
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
fn continuation_remaps_copied_related_targets_and_drops_external_number_collisions() {
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
    assert_eq!(copied.items.0[&ItemRef::new("101").unwrap()].related, None);
    assert_eq!(
        copied.items.0[&source_item].related,
        source.items.0[&source_item].related
    );
    assert!(copied.items.0.contains_key(&external));
    assert_eq!(store.read(&id(2)).unwrap(), source);
}
