use super::*;
use ariadne_domain::models::{ItemRef, UuidV4};
fn route(item: Option<&str>) -> OpenRoute {
    OpenRoute {
        project_id: UuidV4::new("10000000-0000-4000-8000-000000000001").unwrap(),
        session_id: UuidV4::new("10000000-0000-4000-8000-000000000002").unwrap(),
        item_id: item.map(|id| ItemRef::new(id).unwrap()),
    }
}

#[test]
fn cold_route_survives_invalid_request_and_waits_for_receiver() {
    let mut pending = PendingRoute::default();
    let valid = pending.begin().unwrap();
    pending.validated(valid, route(Some("2.1")));
    let _invalid = pending.begin().unwrap(); // Resolver failure never calls validated.
    assert!(pending.current().is_none());
    pending.set_ready(true);
    assert_eq!(pending.current(), Some((valid, route(Some("2.1")))));
}

#[test]
fn later_valid_intent_wins_even_when_earlier_lookup_completes_last() {
    let mut pending = PendingRoute::default();
    let first = pending.begin().unwrap();
    let second = pending.begin().unwrap();
    pending.validated(second, route(None));
    pending.validated(first, route(Some("2.1")));
    pending.set_ready(true);
    assert_eq!(pending.current(), Some((second, route(None))));
    pending.delivered(first);
    assert!(pending.current().is_some());
    pending.delivered(second);
    assert!(pending.current().is_none());
    pending.validated(first, route(Some("2.1")));
    assert!(pending.current().is_none());
}

#[test]
fn failed_publication_keeps_route_and_readiness_reset_prevents_delivery() {
    let mut pending = PendingRoute::default();
    let ticket = pending.begin().unwrap();
    pending.validated(ticket, route(None));
    pending.set_ready(true);
    assert!(pending.current().is_some()); // Publication error does not call delivered.
    pending.set_ready(false);
    assert!(pending.current().is_none());
    pending.set_ready(true);
    assert_eq!(pending.current(), Some((ticket, route(None))));
}
