use super::super::tests::Fixture;
use super::super::NativeRuntime;
use super::*;
use ariadne_store::{registry::Registry, session::Store};
use std::sync::atomic::AtomicU64;

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

#[test]
fn sweep_keeps_current_entries_but_fresh_session_reads_reject_disconnect_and_rebind() {
    let fixture = Fixture::new();
    let config = fixture.configuration();
    let root = &config.claude.as_ref().unwrap().project_root;
    let id = |n: u64| UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap();
    std::fs::create_dir(&config.home).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&config.home, std::fs::Permissions::from_mode(0o700)).unwrap();
    let registry = Registry::open_data_directory(&config.home).unwrap();
    registry.register(root, &id(99), || id(1)).unwrap();
    let seed: Session = serde_json::from_str(include_str!(
        "../../../../../../fixtures/domain/history/seed.json"
    ))
    .unwrap();
    let store = Store::open_registered(&registry.project_dir(&id(1)), id(1)).unwrap();
    store.create(&seed).unwrap();
    let ids = AtomicU64::new(100);
    let capabilities = seed.bindings.0[&id(3)].capabilities.clone();
    let core = Arc::new(NativeCoreService::new(
        registry,
        move || {
            UuidV4::new(format!(
                "00000000-0000-4000-8000-{:012x}",
                ids.fetch_add(1, Ordering::Relaxed)
            ))
            .unwrap()
        },
        super::super::runtime::now,
        move |params| {
            Ok(ariadne_core::bindings::VerifiedHost {
                adapter_id: params.adapter_id.clone(),
                adapter_version: "fixture".into(),
                protocol_major: PositiveSafeInteger::new(1).unwrap(),
                config_version: PositiveSafeInteger::new(1).unwrap(),
                external_session_id: params.external_session_id.clone(),
                endpoint: params.endpoint.clone(),
                endpoint_fingerprint: EndpointFingerprint("fake.local/rebound".into()),
                configuration: params.configuration.clone(),
                capabilities: capabilities.clone(),
                compatibility: ariadne_agent_protocol::Compatibility::Compatible,
                availability: ariadne_agent_protocol::Availability::Available,
                connection_state: ConnectionState::Connected,
                cli_invocation: "ariadne".into(),
                setup_instruction: "Read the retained history before continuing.".into(),
            })
        },
    ));
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let cache = PresenceCache::new(
        core.clone(),
        Arc::new(move |hint| {
            sink.lock().unwrap().push(hint);
            true
        }),
    );
    let endpoint = seed.bindings.0[&id(3)].endpoint_fingerprint.clone();
    let hint = PresenceChangedHint {
        binding_id: id(3),
        generation: id(4),
        observation: PresenceObservation {
            instance_id: id(70),
            generation: id(4),
            connection_state: ConnectionState::Connected,
            execution_state: ExecutionState::Running,
            last_seen_at: Some(super::super::runtime::now()),
            source: Some(PresenceSource::HostEvent),
            process_identity: None,
            freshness: Freshness::Fresh,
        },
    };
    cache.accept(PresenceUpdate::Connected {
        hint: hint.clone(),
        endpoint: endpoint.clone(),
    });
    cache.sweep();
    assert_eq!(cache.entries.lock().unwrap()[&id(3)].hint, hint);
    assert_eq!(
        events.lock().unwrap().len(),
        1,
        "Unchanged current presence is not republished"
    );
    let captured = core.registry().catalogue().unwrap();
    assert!(!cache.selected_with(
        &hint,
        &EndpointFingerprint("different/endpoint".into()),
        || { AgentResolver::resolve_from_catalogue(&captured, id(3), id(4), None, None) }
    ));
    let mut different_generation = hint.clone();
    different_generation.generation = id(404);
    different_generation.observation.generation = id(404);
    assert!(!cache.selected_with(&different_generation, &endpoint, || {
        AgentResolver::resolve_from_catalogue(&captured, id(3), id(404), None, None)
    }));
    let context = OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
    ));
    // Capture first, then actually disconnect. Fresh SessionGet must reject the
    // formerly selected binding even though the borrowed route still resolves.
    core.execute_owner(
        context.clone(),
        OwnerCommand::BindingDisconnect {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(90),
            params: BindingStateParams {
                binding_id: id(3),
                expected_generation: id(4),
            },
        },
    )
    .unwrap();
    assert!(
        !cache.selected_with(&hint, &endpoint, || AgentResolver::resolve_from_catalogue(
            &captured,
            id(3),
            id(4),
            None,
            None
        ))
    );
    cache.sweep();
    assert!(cache.entries.lock().unwrap().is_empty());
    let removed = events.lock().unwrap().last().unwrap().clone();
    assert_eq!(removed.observation.freshness, Freshness::Unknown);
    assert_eq!(
        removed.observation.last_seen_at,
        hint.observation.last_seen_at
    );
    // Real Core rebind retains the old binding in history but selects a new
    // identity/generation. Old connected observations must not recreate it.
    core.execute_owner(
        OwnerContext::from_trusted_entrypoint(OwnerScope::Registry),
        OwnerCommand::BindingConnect {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(91),
            params: BindingConnectParams {
                project_id: id(1),
                adapter_id: "fake.local".into(),
                external_session_id: "rebound-thread".into(),
                endpoint: EndpointRef::LocalBridge {
                    name: "rebound".into(),
                },
                configuration: AdapterConfig {
                    namespace: "fake.local".into(),
                    values: UniqueMap(Default::default()),
                },
                existing_session_id: Some(id(2)),
            },
        },
    )
    .unwrap();
    let live = store.read(&id(2)).unwrap();
    assert!(live.bindings.0.contains_key(&id(3)));
    let selected = live.active_binding_id.clone().unwrap();
    assert_ne!(selected, id(3));
    assert!(
        !cache.selected_with(&hint, &endpoint, || AgentResolver::resolve_from_catalogue(
            &captured,
            id(3),
            id(4),
            None,
            None
        ))
    );
    cache.accept(PresenceUpdate::Connected {
        hint: hint.clone(),
        endpoint,
    });
    assert!(cache.entries.lock().unwrap().is_empty());
    let binding = &live.bindings.0[&selected];
    let mut current = hint;
    current.binding_id = selected.clone();
    current.generation = binding.generation.clone();
    current.observation.generation = binding.generation.clone();
    current.observation.instance_id = id(71);
    cache.accept(PresenceUpdate::Connected {
        hint: current.clone(),
        endpoint: binding.endpoint_fingerprint.clone(),
    });
    cache.sweep();
    assert_eq!(cache.entries.lock().unwrap()[&selected].hint, current);
    // A failed shared capture still demotes each matching entry instead of
    // preserving misleading fresh evidence. A new independent observation can
    // install it again only after the real registry becomes readable.
    let projects_path = config.home.join("projects.json");
    let projects = std::fs::read(&projects_path).unwrap();
    std::fs::write(&projects_path, b"broken").unwrap();
    assert!(core.registry().catalogue().is_err());
    cache.sweep();
    assert!(cache.entries.lock().unwrap().is_empty());
    assert_eq!(
        events.lock().unwrap().last().unwrap().observation.freshness,
        Freshness::Unknown
    );
    std::fs::write(&projects_path, projects).unwrap();
    cache.accept(PresenceUpdate::Connected {
        hint: current,
        endpoint: binding.endpoint_fingerprint.clone(),
    });
    assert!(cache.entries.lock().unwrap().contains_key(&selected));
    cache.stop();
    cache.sweep();
    assert!(cache.entries.lock().unwrap().is_empty());
}
