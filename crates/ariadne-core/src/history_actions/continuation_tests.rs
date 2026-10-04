use super::*;
use std::fs;

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}

#[test]
fn locked_replay_wins_over_stale_owned_source_after_initial_replay_miss() {
    let root = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    ariadne_store::registry::Registry::open(home.path())
        .unwrap()
        .register(root.path(), &id(99), || id(1))
        .unwrap();
    let store = Store::open_registered(root.path(), id(1)).unwrap();
    let source: Session = serde_json::from_str(include_str!(
        "../../../../fixtures/domain/history/seed.json"
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
    let source_path = root
        .path()
        .join(format!(".ariadne/sessions/{}.json", id(2).as_str()));
    let target_path = root
        .path()
        .join(format!(".ariadne/sessions/{}.json", id(20).as_str()));
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
