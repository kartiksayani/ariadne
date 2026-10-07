use ariadne_core::{
    native::{AgentResolver, NativeCoreService},
    *,
};
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
use std::os::unix::fs::PermissionsExt;
/// Project store directory under a data-root home, as `Registry::project_dir` derives it.
fn store_dir(home: &std::path::Path, project: u64) -> std::path::PathBuf {
    home.join(".ariadne/projects").join(id(project).as_str())
}
fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn seed() -> Session {
    serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json")).unwrap()
}
#[test]
fn routing_checks_membership_and_keeps_historical_scope_for_locked_replay() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    registry.register(root.path(), &id(99), || id(1)).unwrap();
    let mut session = seed();
    session.state = SessionState::Closed;
    session.closed_at = Some(UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap());
    Store::open_registered(&store_dir(home.path(), 1), id(1))
        .unwrap()
        .create(&session)
        .unwrap();
    let core = NativeCoreService::new(
        registry,
        || id(100),
        || UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap(),
        |_| unreachable!(),
    );
    let route = SessionRef {
        project_id: id(1),
        session_id: id(2),
    };
    let resolved = core.resolve_session(&route).unwrap();
    assert_eq!(resolved.project_id(), &route.project_id);
    assert_eq!(resolved.session_id(), &route.session_id);
    assert_eq!(
        core.resolve_session(&SessionRef {
            project_id: id(404),
            ..route.clone()
        })
        .unwrap_err()
        .code,
        CoreErrorCode::NotFound
    );
    assert_eq!(
        core.resolve_session(&SessionRef {
            session_id: id(404),
            ..route
        })
        .unwrap_err()
        .code,
        CoreErrorCode::IoError
    );
    let old_generation = id(404);
    let context =
        AgentResolver::resolve(core.registry(), id(3), old_generation.clone(), None, None).unwrap();
    let catalogue = core.registry().catalogue().unwrap();
    assert_eq!(
        AgentResolver::resolve_from_catalogue(
            &catalogue,
            id(3),
            old_generation.clone(),
            None,
            None
        )
        .unwrap(),
        context
    );
    assert_eq!(context.generation(), &old_generation);
    assert!(
        matches!(context.read_scope(), AgentReadScope::Terminal { issued_through_message_number } if issued_through_message_number == &session.bindings.0[&id(3)].issued_through_message_number)
    );
    assert_eq!(
        AgentResolver::resolve(core.registry(), id(3), id(4), Some(id(404)), None)
            .unwrap_err()
            .code,
        CoreErrorCode::InvalidArgument
    );
    assert_eq!(
        AgentResolver::resolve(core.registry(), id(404), id(4), None, None)
            .unwrap_err()
            .code,
        CoreErrorCode::NotFound
    );
}

#[test]
fn captured_catalogue_preserves_dispatched_scope_and_does_not_reread_storage() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    registry.register(root.path(), &id(99), || id(1)).unwrap();
    let store = Store::open_registered(&store_dir(home.path(), 1), id(1)).unwrap();
    store.create(&seed()).unwrap();
    let next = std::sync::atomic::AtomicU64::new(100);
    let core = NativeCoreService::new(
        registry,
        move || id(next.fetch_add(1, std::sync::atomic::Ordering::Relaxed)),
        || UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap(),
        |_| unreachable!(),
    );
    let route = RegisteredSession::from_trusted_entrypoint(id(1), id(2));
    core.execute_owner(
        OwnerContext::from_trusted_entrypoint(OwnerScope::Session(route.clone())),
        OwnerCommand::InputSubmit {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(90),
            params: InputSubmitParams {
                binding_id: id(3),
                target: InputTarget {
                    topic_id: id(5),
                    item_id: Some(ItemRef::new("1").unwrap()),
                },
                kind: InputKind::Reply,
                text: "Retained owner input".into(),
                selected_option_id: None,
                expected_question_revision: None,
                supersedes_answer_id: None,
            },
        },
    )
    .unwrap();
    let attempt = core
        .claim(
            ValidatedDispatchContext::from_trusted_current_lease(route, id(3), id(4)),
            ClaimRequest {
                binding_id: id(3),
                generation: id(4),
                request_id: id(91),
            },
        )
        .unwrap()
        .unwrap();
    let catalogue = core.registry().catalogue().unwrap();
    let resolve = || {
        AgentResolver::resolve_from_catalogue(
            &catalogue,
            id(3),
            id(404),
            Some(attempt.input_id.clone()),
            Some(attempt.attempt_id.clone()),
        )
    };
    let expected = AgentResolver::resolve(
        core.registry(),
        id(3),
        id(404),
        Some(attempt.input_id.clone()),
        Some(attempt.attempt_id.clone()),
    )
    .unwrap();
    assert_eq!(resolve().unwrap(), expected);
    assert!(
        matches!(expected.read_scope(), AgentReadScope::Dispatched { issued_through_message_number, .. } if issued_through_message_number.value() == 2)
    );
    // Borrowed resolution is a route observation, not current eligibility.
    // A fresh independent resolver still observes this real storage failure.
    std::fs::write(
        store_dir(home.path(), 1).join(format!("sessions/{}.json", id(2).as_str())),
        b"broken",
    )
    .unwrap();
    assert_eq!(resolve().unwrap(), expected);
    assert_eq!(
        AgentResolver::resolve(core.registry(), id(3), id(4), None, None)
            .unwrap_err()
            .code,
        CoreErrorCode::CorruptSession
    );
    assert_eq!(
        AgentResolver::resolve(core.registry(), id(3), id(4), Some(id(404)), None)
            .unwrap_err()
            .code,
        CoreErrorCode::InvalidArgument
    );
}

#[test]
fn catalogue_resolution_scans_historical_duplicates_and_preserves_first_failure_order() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    registry.register(root.path(), &id(99), || id(1)).unwrap();
    let store = Store::open_registered(&store_dir(home.path(), 1), id(1)).unwrap();
    store.create(&seed()).unwrap();
    let mut historical = seed();
    historical.id = id(20);
    historical.active_binding_id = None;
    historical.state = SessionState::Closed;
    historical.closed_at = Some(UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap());
    store.create(&historical).unwrap();
    let resolve = |catalogue: &ariadne_store::registry::RegistryCatalogue| {
        AgentResolver::resolve_from_catalogue(catalogue, id(3), id(4), None, None)
    };
    let catalogue = registry.catalogue().unwrap();
    assert_eq!(
        resolve(&catalogue).unwrap_err(),
        AgentResolver::resolve(&registry, id(3), id(4), None, None).unwrap_err()
    );
    assert_eq!(
        resolve(&catalogue).unwrap_err().code,
        CoreErrorCode::BindingAmbiguous
    );
    // The later unreadable snapshot cannot replace an earlier duplicate error.
    let broken_path = store_dir(home.path(), 1).join(format!("sessions/{}.json", id(21).as_str()));
    std::fs::write(&broken_path, b"broken").unwrap();
    std::fs::set_permissions(&broken_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let catalogue = registry.catalogue().unwrap();
    assert_eq!(
        resolve(&catalogue).unwrap_err().code,
        CoreErrorCode::BindingAmbiguous
    );
    assert_eq!(
        resolve(&catalogue).unwrap_err(),
        AgentResolver::resolve(&registry, id(3), id(4), None, None).unwrap_err()
    );
    // Move that failure before the duplicate: full ordered checking must now
    // reject it even though the first valid snapshot already contains the ID.
    std::fs::rename(
        broken_path,
        store_dir(home.path(), 1).join(format!("sessions/{}.json", id(19).as_str())),
    )
    .unwrap();
    let catalogue = registry.catalogue().unwrap();
    assert_eq!(
        resolve(&catalogue).unwrap_err().code,
        CoreErrorCode::CorruptSession
    );
    assert_eq!(
        resolve(&catalogue).unwrap_err(),
        AgentResolver::resolve(&registry, id(3), id(4), None, None).unwrap_err()
    );
    assert_eq!(
        AgentResolver::resolve_from_catalogue(&catalogue, id(3), id(4), None, Some(id(404)))
            .unwrap_err()
            .code,
        CoreErrorCode::InvalidArgument
    );
}

#[test]
fn catalogue_resolution_retains_unavailable_project_failure() {
    let home = tempfile::tempdir().unwrap();
    let base = tempfile::tempdir().unwrap();
    let root = base.path().join("registered");
    std::fs::create_dir(&root).unwrap();
    let registry = Registry::open(home.path()).unwrap();
    registry.register(&root, &id(99), || id(1)).unwrap();
    Store::open_registered(&store_dir(home.path(), 1), id(1))
        .unwrap()
        .create(&seed())
        .unwrap();
    // The store lives under the data root, so the project's store is what goes missing.
    std::fs::rename(store_dir(home.path(), 1), base.path().join("moved")).unwrap();
    let catalogue = registry.catalogue().unwrap();
    let error =
        AgentResolver::resolve_from_catalogue(&catalogue, id(3), id(4), None, None).unwrap_err();
    assert_eq!(
        error,
        AgentResolver::resolve(&registry, id(3), id(4), None, None).unwrap_err()
    );
    assert_eq!(error.code, CoreErrorCode::IoError);
}
