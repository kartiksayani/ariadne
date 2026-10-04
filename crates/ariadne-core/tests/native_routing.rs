use ariadne_core::{
    native::{AgentResolver, NativeCoreService},
    *,
};
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
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
    Store::open_registered(root.path(), id(1))
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
