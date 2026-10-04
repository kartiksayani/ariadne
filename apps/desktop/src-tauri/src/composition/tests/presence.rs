use super::super::tests::Fixture;
use super::super::NativeRuntime;
use super::*;

fn at(seconds: u32) -> UtcMillis {
    UtcMillis::new(format!(
        "2026-10-04T00:{:02}:{:02}.000Z",
        seconds / 60,
        seconds % 60
    ))
    .unwrap()
}

#[test]
fn real_selected_scope_duplicate_age_replacement_and_old_stop_are_fenced() {
    let fixture = Fixture::new();
    let runtime = NativeRuntime::start(
        fixture.configuration(),
        Arc::new(|_| {}),
        Arc::new(|_| true),
    )
    .unwrap();
    let (route, scope, _, _) = fixture.connected(&runtime);
    let core = runtime.bridge().core().clone();
    let resolved = core.resolve_session(&route).unwrap();
    let context = QueryContext::owner(OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        resolved,
    )));
    let QueryResult::SessionGet(snapshot) =
        core.query(context, QueryRequest::SessionGet {}).unwrap()
    else {
        panic!("real session");
    };
    let endpoint = snapshot.session.bindings.0[&scope.binding_id]
        .endpoint_fingerprint
        .clone();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let cache = PresenceCache::new(
        core.clone(),
        Arc::new(move |hint| {
            sink.lock().unwrap().push(hint);
            true
        }),
    );
    let original = PresenceChangedHint {
        binding_id: scope.binding_id.clone(),
        generation: scope.generation.clone(),
        observation: PresenceObservation {
            instance_id: UuidV4::new("00000000-0000-4000-8000-000000000071").unwrap(),
            generation: scope.generation.clone(),
            connection_state: ConnectionState::Connected,
            execution_state: ExecutionState::Running,
            last_seen_at: Some(super::super::runtime::now()),
            source: Some(PresenceSource::HostEvent),
            process_identity: None,
            freshness: Freshness::Fresh,
        },
    };
    cache.accept(PresenceUpdate::Connected {
        hint: original.clone(),
        endpoint: endpoint.clone(),
    });
    cache.accept(PresenceUpdate::Connected {
        hint: original.clone(),
        endpoint: endpoint.clone(),
    });
    let mut older = original.clone();
    older.observation.last_seen_at = Some(at(0));
    cache.accept(PresenceUpdate::Observed {
        hint: older,
        endpoint: endpoint.clone(),
    });
    assert_eq!(events.lock().unwrap().len(), 1);
    let mut current = original.clone();
    current.observation.instance_id = UuidV4::new("00000000-0000-4000-8000-000000000072").unwrap();
    cache.accept(PresenceUpdate::Connected {
        hint: current.clone(),
        endpoint: endpoint.clone(),
    });
    cache.accept(PresenceUpdate::Observed {
        hint: original.clone(),
        endpoint: endpoint.clone(),
    });
    cache.accept(PresenceUpdate::Stopped {
        hint: original,
        endpoint: endpoint.clone(),
    });
    assert_eq!(
        cache.entries.lock().unwrap()[&scope.binding_id].hint,
        current
    );
    let query_context =
        QueryContext::owner(OwnerContext::from_trusted_entrypoint(OwnerScope::Registry));
    let mut list = core
        .query(
            query_context,
            QueryRequest::SessionList(SessionListRequest {
                project_id: Some(route.project_id),
                state: None,
                cursor: None,
                limit: PageLimit::new(100).unwrap(),
            }),
        )
        .unwrap();
    cache.overlay(&mut list);
    let QueryResult::SessionList(list) = list else {
        panic!("real list");
    };
    assert_eq!(
        list.sessions.items[0]
            .active_binding
            .as_ref()
            .unwrap()
            .presence
            .as_ref(),
        Some(&current.observation)
    );
    cache.fence();
    cache.accept(PresenceUpdate::Observed {
        hint: current.clone(),
        endpoint: endpoint.clone(),
    });
    assert!(cache.entries.lock().unwrap().is_empty());
    assert_eq!(
        events
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .observation
            .last_seen_at,
        current.observation.last_seen_at
    );
    cache.reopen();
    cache.accept(PresenceUpdate::Observed {
        hint: current.clone(),
        endpoint: endpoint.clone(),
    });
    assert!(cache.entries.lock().unwrap().is_empty());
    cache.accept(PresenceUpdate::Connected {
        hint: current.clone(),
        endpoint: endpoint.clone(),
    });
    cache.accept(PresenceUpdate::Stopped {
        hint: current,
        endpoint,
    });
    assert!(cache.entries.lock().unwrap().is_empty());
    runtime.shutdown().unwrap();
}
#[test]
fn expiry_preserves_original_evidence_and_never_infers_idle() {
    let mut observation = PresenceObservation {
        instance_id: UuidV4::new("00000000-0000-4000-8000-000000000001").unwrap(),
        generation: UuidV4::new("00000000-0000-4000-8000-000000000002").unwrap(),
        connection_state: ConnectionState::Connected,
        execution_state: ExecutionState::Running,
        last_seen_at: Some(at(0)),
        source: Some(PresenceSource::HostPoll),
        process_identity: None,
        freshness: Freshness::Fresh,
    };
    let original = observation.clone();
    expire(&mut observation, &at(89));
    assert_eq!(observation, original);
    expire(&mut observation, &at(90));
    assert_eq!(observation.freshness, Freshness::Stale);
    assert_eq!(observation.execution_state, ExecutionState::Unknown);
    assert_eq!(observation.last_seen_at, original.last_seen_at);
    assert_eq!(observation.instance_id, original.instance_id);
    assert_eq!(observation.source, original.source);
}
