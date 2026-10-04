use ariadne_adapter_claude::*;
use ariadne_agent_protocol::*;
use ariadne_domain::models::{ConnectionState, ExecutionState, Freshness};
use serde_json::json;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    sync::Arc,
    task::{Context, Poll, Wake, Waker},
    time::{Duration, Instant},
};

fn id(value: &str) -> UuidV4 {
    UuidV4::new(value).unwrap()
}
fn binding() -> UuidV4 {
    id("33333333-3333-4333-8333-333333333333")
}
fn generation() -> UuidV4 {
    id("44444444-4444-4444-8444-444444444444")
}
fn instance() -> UuidV4 {
    id("77777777-7777-4777-8777-777777777777")
}
fn endpoint() -> EndpointRef {
    EndpointRef::LocalBridge {
        name: "claude-mod".into(),
    }
}
fn config() -> AdapterConfig {
    serde_json::from_value(json!({"namespace":"claude_code_mod","values":{}})).unwrap()
}
fn connect() -> ConnectRequest {
    ConnectRequest {
        binding_id: binding(),
        generation: generation(),
        external_session_id: "original-host-session".into(),
        endpoint: endpoint(),
        configuration: config(),
    }
}
fn observe() -> ObserveRequest {
    ObserveRequest {
        binding_id: binding(),
        generation: generation(),
        checkpoint: None,
        limit: ObserveLimit::new(1).unwrap(),
    }
}
struct ThreadWake(std::thread::Thread);
impl Wake for ThreadWake {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}
fn wait<T>(mut future: AdapterFuture<'_, T>) -> Result<T, AdapterError> {
    let waker = Waker::from(Arc::new(ThreadWake(std::thread::current())));
    let mut context = Context::from_waker(&waker);
    let deadline = Instant::now() + Duration::from_secs(7);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => {
                assert!(
                    Instant::now() < deadline,
                    "bounded adapter future did not wake"
                );
                std::thread::park_timeout(Duration::from_millis(20));
            }
        }
    }
}
struct Fixture {
    _root: tempfile::TempDir,
    options: ClaudeOptions,
    loaded: std::path::PathBuf,
    slot: ModEvidenceSlot,
}
impl Fixture {
    fn new(version: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let installed = root.path().join("versions/0.1.0/plugin");
        let loaded = root.path().join("sdk-loaded/plugin");
        let project = root.path().join("project");
        fs::create_dir_all(&project).unwrap();
        for dir in [&installed, &loaded] {
            for (name,bytes) in [
                (".claude-plugin/plugin.json",r#"{"name":"ariadne","version":"0.1.0"}"#),
                ("hooks/hooks.json","{}"),("hooks/register.js","// register"),("hooks/contracts.js","// contracts"),
                ("hooks/setup.js","// setup"),("hooks/claims.js","// claims"),("hooks/discovery.js","// discovery"),
                ("hooks/installed.js","export default Object.freeze({helperPath:'/installed/helper',appVersion:'0.1.0',apiVersion:1});"),
                ("skills/ariadne/SKILL.md","# Structured Ariadne context"),
            ] { let path = dir.join(name); fs::create_dir_all(path.parent().unwrap()).unwrap(); fs::write(path,bytes).unwrap(); }
        }
        let executable = root.path().join("claude");
        executable_file(&executable,&format!("#!/bin/sh\n[ \"$#\" = 1 ] && [ \"$1\" = --version ] || exit 3\nprintf '%s\\n' '{version} (Claude Code)'\n"));
        let helper = root.path().join("ariadne");
        executable_file(&helper, "#!/bin/sh\nprintf 'ariadne 0.1.0\\n'\n");
        let descriptor = json!({"helperPath":helper,"appVersion":"0.1.0","apiVersion":1});
        for dir in [&installed, &loaded] {
            fs::write(
                dir.join("hooks/installed.js"),
                format!("export default Object.freeze({descriptor});\n"),
            )
            .unwrap();
        }
        Self {
            options: ClaudeOptions {
                executable,
                installed_plugin: installed,
                helper,
                project_root: project,
                app_version: "0.1.0".into(),
            },
            _root: root,
            loaded,
            slot: ModEvidenceSlot::default(),
        }
    }
    fn identity(&self) -> LoadedModIdentity {
        LoadedModIdentity {
            plugin_name: "ariadne".into(),
            plugin_root: self.loaded.clone(),
            helper_path: self.options.helper.clone(),
            app_version: "0.1.0".into(),
            api_version: 1,
            engine_version: SUPPORTED_HOST_VERSION.into(),
            external_session_id: "original-host-session".into(),
            project_root: self.options.project_root.clone(),
            binding_scope: Some((binding(), generation())),
        }
    }
    fn publish(&self) {
        self.slot
            .publish(
                ModEvidence::received(
                    self.identity(),
                    UtcMillis::new("2026-10-04T00:00:00.123Z").unwrap(),
                )
                .unwrap(),
            )
            .unwrap();
    }
    fn adapter(&self) -> ClaudeAdapter {
        ClaudeAdapter::new(self.options.clone(), self.slot.clone(), instance()).unwrap()
    }
}
fn executable_file(path: &Path, bytes: &str) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn native_qualifier_preserves_original_receipt_time_and_rejects_expired_evidence() {
    let fixture = Fixture::new(SUPPORTED_HOST_VERSION);
    let observed = UtcMillis::new("2026-10-04T00:00:00.456Z").unwrap();
    let evidence = fixture
        .options
        .qualify_identity(
            fixture.identity(),
            observed.clone(),
            Instant::now() - Duration::from_secs(1),
            Instant::now() + Duration::from_secs(20),
        )
        .unwrap();
    fixture.slot.publish(evidence).unwrap();
    let result = wait(fixture.adapter().connect(connect())).unwrap();
    assert_eq!(result.observation.last_seen_at, Some(observed.clone()));
    assert_eq!(result.observation.freshness, Freshness::Fresh);
    let error = fixture
        .options
        .qualify_identity(
            fixture.identity(),
            observed,
            Instant::now() - Duration::from_secs(90),
            Instant::now() + Duration::from_secs(20),
        )
        .unwrap_err();
    assert_eq!(error.code, AdapterErrorCode::HostUnreachable);
    assert!(error.message.contains("stale"));
    let error = fixture
        .options
        .qualify_identity(
            fixture.identity(),
            UtcMillis::new("2026-10-04T00:00:00.456Z").unwrap(),
            Instant::now(),
            Instant::now(),
        )
        .unwrap_err();
    assert_eq!(error.code, AdapterErrorCode::HostUnreachable);
}

#[test]
fn discovery_resource_is_required_and_compared_at_exact_loaded_root() {
    for missing in [true, false] {
        let fixture = Fixture::new(SUPPORTED_HOST_VERSION);
        let path = fixture.loaded.join("hooks/discovery.js");
        if missing {
            fs::remove_file(path).unwrap();
        } else {
            fs::write(path, "different discovery bytes").unwrap();
        }
        assert!(fixture
            .options
            .qualify_identity(
                fixture.identity(),
                UtcMillis::new("2026-10-04T00:00:00.456Z").unwrap(),
                Instant::now(),
                Instant::now() + Duration::from_secs(5),
            )
            .is_err());
    }
}

#[test]
fn native_qualifier_caps_a_longer_caller_deadline_at_five_seconds() {
    let fixture = Fixture::new(SUPPORTED_HOST_VERSION);
    // exec makes sleep the owned --version child itself, with no orphan subprocess.
    executable_file(
        &fixture.options.executable,
        "#!/bin/sh\nexec /bin/sleep 30\n",
    );
    let started = Instant::now();
    let error = fixture
        .options
        .qualify_identity(
            fixture.identity(),
            UtcMillis::new("2026-10-04T00:00:00.456Z").unwrap(),
            started,
            started + Duration::from_secs(20),
        )
        .unwrap_err();
    assert_eq!(error.code, AdapterErrorCode::HostUnreachable);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "longer caller deadline must not extend the native qualifier maximum"
    );
}

#[test]
fn installed_files_and_version_alone_never_prove_loaded_mod_or_availability() {
    let fixture = Fixture::new(SUPPORTED_HOST_VERSION);
    let adapter = fixture.adapter();
    let result = wait(adapter.probe(ProbeRequest {
        endpoint: endpoint(),
        configuration: config(),
    }))
    .unwrap();
    assert_eq!(result.host_version.as_deref(), Some(SUPPORTED_HOST_VERSION));
    assert_eq!(result.compatibility, Compatibility::Unknown);
    assert_eq!(result.availability, Availability::Unavailable);
    assert!(!result.setup_steps.is_empty());
    assert_eq!(
        wait(adapter.connect(connect())).unwrap_err().code,
        AdapterErrorCode::HostUnreachable
    );
}
#[test]
fn fresh_actual_sdk_identity_and_exact_resources_qualify_pull_presence_without_execution_inference()
{
    let fixture = Fixture::new(SUPPORTED_HOST_VERSION);
    fixture.publish();
    let adapter = fixture.adapter();
    let probe = wait(adapter.probe(ProbeRequest {
        endpoint: endpoint(),
        configuration: config(),
    }))
    .unwrap();
    assert_eq!(probe.compatibility, Compatibility::Compatible);
    assert_eq!(probe.availability, Availability::Available);
    let connection = wait(adapter.connect(connect())).unwrap();
    connection.validate_for(&connect()).unwrap();
    assert_eq!(connection.capabilities.delivery_mode, DeliveryMode::Pull);
    assert!(!connection.capabilities.history_reconcile.supported);
    assert!(!connection.capabilities.discover_sessions.supported);
    assert_eq!(
        connection.observation.execution_state,
        ExecutionState::Unknown
    );
    let first = wait(adapter.observe(observe())).unwrap();
    let second = wait(adapter.observe(observe())).unwrap();
    assert_eq!(first, second);
    assert!(first.next_checkpoint.is_none());
    let EventPayload::Presence { observation } = &first.events[0].event else {
        panic!("presence expected")
    };
    assert_eq!(observation.connection_state, ConnectionState::Connected);
    assert_eq!(observation.freshness, Freshness::Fresh);
    assert_eq!(observation.execution_state, ExecutionState::Unknown);
    assert!(observation.process_identity.is_none());
    wait(adapter.disconnect(DisconnectRequest {
        binding_id: binding(),
        generation: generation(),
    }))
    .unwrap();
    wait(adapter.connect(connect())).unwrap();
    fixture.slot.clear().unwrap();
    let cleared = wait(adapter.observe(observe())).unwrap();
    let EventPayload::Presence { observation } = &cleared.events[0].event else {
        panic!("presence expected")
    };
    assert_eq!(observation.connection_state, ConnectionState::Unknown);
    assert_eq!(observation.execution_state, ExecutionState::Unknown);
    assert_eq!(observation.freshness, Freshness::Unknown);
    assert!(observation.last_seen_at.is_none());
    assert!(observation.source.is_none());
    assert_ne!(cleared.events[0].event_id, first.events[0].event_id);
}
#[test]
fn observed_newer_cli_is_incompatible_and_never_inherits_the_old_sdk_baseline() {
    let fixture = Fixture::new("2.1.289");
    fixture.publish();
    let adapter = fixture.adapter();
    let result = wait(adapter.probe(ProbeRequest {
        endpoint: endpoint(),
        configuration: config(),
    }))
    .unwrap();
    assert_eq!(result.compatibility, Compatibility::Incompatible);
    assert_eq!(result.host_version.as_deref(), Some("2.1.289"));
    assert_eq!(
        wait(adapter.connect(connect())).unwrap_err().code,
        AdapterErrorCode::UnsupportedHostVersion
    );
}
#[test]
fn manifest_descriptor_resource_or_sdk_version_mismatch_requires_reload_not_connected() {
    for case in 0..5 {
        let fixture = Fixture::new(SUPPORTED_HOST_VERSION);
        let mut identity = fixture.identity();
        match case {
            0 => identity.app_version = "0.2.0".into(),
            1 => identity.api_version = 2,
            2 => identity.engine_version = "2.1.289".into(),
            3 => fs::write(fixture.loaded.join("hooks/claims.js"), "changed bytes").unwrap(),
            _ => fs::write(
                fixture.loaded.join(".claude-plugin/plugin.json"),
                r#"{"name":"ariadne","version":"0.2.0"}"#,
            )
            .unwrap(),
        }
        fixture
            .slot
            .publish(
                ModEvidence::received(
                    identity,
                    UtcMillis::new("2026-10-04T00:00:00.123Z").unwrap(),
                )
                .unwrap(),
            )
            .unwrap();
        let adapter = fixture.adapter();
        assert!(wait(adapter.connect(connect())).is_err());
        assert_ne!(
            wait(adapter.probe(ProbeRequest {
                endpoint: endpoint(),
                configuration: config()
            }))
            .unwrap()
            .compatibility,
            Compatibility::Compatible
        );
    }
}
#[test]
fn explicit_external_project_binding_and_generation_cannot_be_retargeted() {
    for case in 0..4 {
        let fixture = Fixture::new(SUPPORTED_HOST_VERSION);
        let mut identity = fixture.identity();
        match case {
            0 => identity.external_session_id = "different-session".into(),
            1 => identity.project_root = fixture.options.installed_plugin.clone(),
            2 => identity.binding_scope = Some((instance(), generation())),
            _ => identity.binding_scope = Some((binding(), instance())),
        }
        fixture
            .slot
            .publish(
                ModEvidence::received(
                    identity,
                    UtcMillis::new("2026-10-04T00:00:00.123Z").unwrap(),
                )
                .unwrap(),
            )
            .unwrap();
        let adapter = fixture.adapter();
        assert!(wait(adapter.connect(connect())).is_err());
    }
}
#[test]
fn exact_sdk_root_read_refuses_symlink_resources_and_other_user_writable_files() {
    let fixture = Fixture::new(SUPPORTED_HOST_VERSION);
    fixture.publish();
    let adapter = fixture.adapter();
    let path = fixture.loaded.join("hooks/claims.js");
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(
        fixture.options.installed_plugin.join("hooks/claims.js"),
        &path,
    )
    .unwrap();
    assert!(wait(adapter.connect(connect())).is_err());
    fs::remove_file(&path).unwrap();
    fs::write(&path, "// claims").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();
    assert_eq!(
        wait(adapter.connect(connect())).unwrap_err().code,
        AdapterErrorCode::PermissionDenied
    );
}
#[test]
fn changed_same_version_resource_identity_cannot_refresh_existing_connection() {
    let fixture = Fixture::new(SUPPORTED_HOST_VERSION);
    fixture.publish();
    let adapter = fixture.adapter();
    wait(adapter.connect(connect())).unwrap();
    for root in [&fixture.loaded, &fixture.options.installed_plugin] {
        fs::write(root.join("hooks/claims.js"), "new same-version bytes").unwrap();
    }
    assert_eq!(
        wait(adapter.observe(observe())).unwrap_err().code,
        AdapterErrorCode::BindingMismatch
    );
    assert_eq!(
        wait(adapter.connect(connect())).unwrap_err().code,
        AdapterErrorCode::BindingMismatch
    );
}
#[test]
fn unresolved_reconciliation_ignores_old_tokens_and_never_claims_non_delivery_or_history() {
    let fixture = Fixture::new(SUPPORTED_HOST_VERSION);
    fixture.publish();
    let adapter = fixture.adapter();
    wait(adapter.connect(connect())).unwrap();
    let attempts = vec![AttemptEvidenceRequest {
        input_id: id("55555555-5555-4555-8555-555555555555"),
        attempt_id: id("66666666-6666-4666-8666-666666666666"),
        binding_generation: instance(),
        payload_sha256: Sha256::new("0".repeat(64)).unwrap(),
        wire_marker: "[ARIADNE_INPUT:captured-marker]".into(),
        host_turn_id: Some("actual-turn".into()),
    }];
    let request = ReconcileRequest {
        binding_id: binding(),
        generation: generation(),
        attempts,
        checkpoint: Some(serde_json::from_value(json!("old-instance-token")).unwrap()),
    };
    let result = wait(adapter.reconcile(request.clone())).unwrap();
    result.validate_for(&request).unwrap();
    assert_eq!(
        result.unresolved_attempt_ids,
        vec![request.attempts[0].attempt_id.clone()]
    );
    assert!(result.attempt_evidence.is_empty());
    assert!(result.next_checkpoint.is_none());
    let mut invalid = observe();
    invalid.checkpoint = request.checkpoint.clone();
    assert_eq!(
        wait(adapter.observe(invalid)).unwrap_err().code,
        AdapterErrorCode::InvalidArgument
    );
    let mut request = request;
    request.attempts[0].wire_marker.clear();
    assert_eq!(
        wait(adapter.reconcile(request)).unwrap_err().code,
        AdapterErrorCode::InvalidArgument
    );
}
#[test]
fn unsupported_submit_cannot_launch_provider_or_change_external_hosts() {
    let fixture = Fixture::new(SUPPORTED_HOST_VERSION);
    let adapter = fixture.adapter();
    let request = SubmitRequest {
        binding_id: binding(),
        generation: generation(),
        input_id: instance(),
        attempt_id: instance(),
        formatted_payload: "exact owner payload".into(),
        payload_sha256: Sha256::new("0".repeat(64)).unwrap(),
        wire_marker: "marker".into(),
    };
    assert_eq!(
        wait(adapter.submit(request)).unwrap_err().code,
        AdapterErrorCode::Unsupported
    );
}
#[test]
fn source_backed_mod_facts_parse_canonical_iso_nested_receipts_and_original_scopes() {
    let events: Vec<NormalizedEvent> = serde_json::from_str(include_str!(
        "../../../fixtures/providers/claude/mod-events.json"
    ))
    .unwrap();
    assert_eq!(events.len(), 9);
    for event in events {
        let scope = CapturedScope {
            binding_id: event.binding_id.clone(),
            generation: event.generation.clone(),
            input_id: event.input_id.clone(),
            attempt_id: event.attempt_id.clone(),
            host_turn_id: event.host_turn_id.clone(),
        };
        let frame = serde_json::to_vec(&event).unwrap();
        assert_eq!(normalize_mod_event(&frame, &scope).unwrap(), event);
        let mut wrong = scope.clone();
        wrong.generation = instance();
        assert_eq!(
            normalize_mod_event(&frame, &wrong).unwrap_err().code,
            AdapterErrorCode::StaleGeneration
        );
        let mut wrong = scope.clone();
        wrong.binding_id = instance();
        assert_eq!(
            normalize_mod_event(&frame, &wrong).unwrap_err().code,
            AdapterErrorCode::BindingMismatch
        );
        let mut wire = serde_json::to_value(&event).unwrap();
        wire["observed_at"] = json!(1791072000123u64);
        assert_eq!(
            normalize_mod_event(&serde_json::to_vec(&wire).unwrap(), &scope)
                .unwrap_err()
                .code,
            AdapterErrorCode::InvalidArgument
        );
    }
}
#[test]
fn malformed_oversized_uncorrelated_facts_fail_without_raw_text_in_errors() {
    let event:NormalizedEvent=serde_json::from_value(json!({"event_id":"fact","binding_id":binding(),"generation":generation(),"input_id":null,"attempt_id":null,"host_turn_id":null,"observed_at":"2026-10-04T00:00:00.123Z","kind":"disconnected","payload":{"reason":null}})).unwrap();
    let scope = CapturedScope {
        binding_id: binding(),
        generation: generation(),
        input_id: None,
        attempt_id: None,
        host_turn_id: None,
    };
    assert!(normalize_mod_event(&vec![b'x'; 8 * 1024 * 1024 + 1], &scope).is_err());
    let error = normalize_mod_event(b"private raw provider text", &scope).unwrap_err();
    assert!(!error.message.contains("private raw"));
    let mut wire = serde_json::to_value(&event).unwrap();
    wire["payload"]["reason"] = json!("x".repeat(4097));
    assert!(normalize_mod_event(&serde_json::to_vec(&wire).unwrap(), &scope).is_err());
    wire["payload"] =
        json!({"receipt":{"provider_reference":"","observed_at":"2026-10-04T00:00:00.123Z"}});
    wire["kind"] = json!("accepted");
    wire["input_id"] = json!(instance());
    wire["attempt_id"] = json!(instance());
    assert!(normalize_mod_event(&serde_json::to_vec(&wire).unwrap(), &scope).is_err());
}

#[test]
fn bounded_native_version_timeout_is_async_and_reaps_only_the_owned_version_child() {
    let fixture = Fixture::new(SUPPORTED_HOST_VERSION);
    let pidfile = fixture._root.path().join("version.pid");
    executable_file(
        &fixture.options.executable,
        &format!(
            "#!/bin/sh\necho $$ > '{}'\nwhile :; do :; done\n",
            pidfile.display()
        ),
    );
    let adapter = fixture.adapter();
    let mut future = adapter.probe(ProbeRequest {
        endpoint: endpoint(),
        configuration: config(),
    });
    let waker = Waker::from(Arc::new(ThreadWake(std::thread::current())));
    let mut context = Context::from_waker(&waker);
    assert!(future.as_mut().poll(&mut context).is_pending());
    assert_eq!(
        wait(future).unwrap_err().code,
        AdapterErrorCode::HostUnreachable
    );
    let pid: i32 = fs::read_to_string(pidfile).unwrap().trim().parse().unwrap();
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}
#[test]
fn native_helper_version_and_resource_size_are_checked_without_truncation() {
    let fixture = Fixture::new(SUPPORTED_HOST_VERSION);
    fixture.publish();
    let adapter = fixture.adapter();
    executable_file(
        &fixture.options.helper,
        "#!/bin/sh\nprintf 'ariadne 0.2.0\\n'\n",
    );
    assert_eq!(
        wait(adapter.connect(connect())).unwrap_err().code,
        AdapterErrorCode::IncompatibleAdapter
    );
    executable_file(
        &fixture.options.helper,
        "#!/bin/sh\nprintf 'ariadne 0.1.0\\n'\n",
    );
    fs::write(
        fixture.loaded.join("hooks/claims.js"),
        vec![b'x'; 1024 * 1024 + 1],
    )
    .unwrap();
    assert!(wait(adapter.connect(connect())).is_err());
}
#[test]
fn callback_normalizer_refuses_native_presence_authority() {
    let scope = CapturedScope {
        binding_id: binding(),
        generation: generation(),
        input_id: None,
        attempt_id: None,
        host_turn_id: None,
    };
    let frame = json!({"event_id":"presence","binding_id":binding(),"generation":generation(),"input_id":null,"attempt_id":null,"host_turn_id":null,"observed_at":"2026-10-04T00:00:00.123Z","kind":"presence","payload":{"observation":{"instance_id":instance(),"generation":generation(),"connection_state":"connected","execution_state":"unknown","last_seen_at":null,"source":null,"process_identity":null,"freshness":"unknown"}}});
    assert_eq!(
        normalize_mod_event(&serde_json::to_vec(&frame).unwrap(), &scope)
            .unwrap_err()
            .code,
        AdapterErrorCode::InvalidArgument
    );
}

#[test]
fn conflicting_terminal_snapshots_keep_identity_and_facts_without_provider_side_deduplication() {
    let events: Vec<NormalizedEvent> = serde_json::from_str(include_str!(
        "../../../fixtures/providers/claude/mod-events.json"
    ))
    .unwrap();
    let terminal: Vec<_> = events
        .iter()
        .filter(|event| matches!(event.event, EventPayload::TurnFinished { .. }))
        .collect();
    assert_eq!(terminal.len(), 3);
    assert!(terminal
        .iter()
        .all(|event| event.event_id == terminal[0].event_id));
    assert_ne!(terminal[0].event, terminal[1].event);
    assert_ne!(terminal[0].event, terminal[2].event);
    for event in terminal {
        let scope = CapturedScope {
            binding_id: event.binding_id.clone(),
            generation: event.generation.clone(),
            input_id: event.input_id.clone(),
            attempt_id: event.attempt_id.clone(),
            host_turn_id: event.host_turn_id.clone(),
        };
        assert_eq!(
            normalize_mod_event(&serde_json::to_vec(event).unwrap(), &scope).unwrap(),
            *event
        );
    }
}
#[test]
fn unicode_diagnostics_are_preserved_or_rejected_whole_and_reconciliation_bounds_are_explicit() {
    let events: Vec<NormalizedEvent> = serde_json::from_str(include_str!(
        "../../../fixtures/providers/claude/mod-events.json"
    ))
    .unwrap();
    let event = &events[3];
    let scope = CapturedScope {
        binding_id: binding(),
        generation: generation(),
        input_id: event.input_id.clone(),
        attempt_id: event.attempt_id.clone(),
        host_turn_id: event.host_turn_id.clone(),
    };
    let mut value = serde_json::to_value(event).unwrap();
    value["payload"]["diagnostic_text"] = json!("😀".repeat(16384));
    assert!(normalize_mod_event(&serde_json::to_vec(&value).unwrap(), &scope).is_ok());
    value["payload"]["diagnostic_text"] = json!("😀".repeat(16385));
    assert!(normalize_mod_event(&serde_json::to_vec(&value).unwrap(), &scope).is_err());
    let fixture = Fixture::new(SUPPORTED_HOST_VERSION);
    fixture.publish();
    let adapter = fixture.adapter();
    wait(adapter.connect(connect())).unwrap();
    let mut request = ReconcileRequest {
        binding_id: binding(),
        generation: generation(),
        attempts: (0..100)
            .map(|n| AttemptEvidenceRequest {
                input_id: instance(),
                attempt_id: id(&format!("{n:08x}-1111-4111-8111-111111111111")),
                binding_generation: generation(),
                payload_sha256: Sha256::new("0".repeat(64)).unwrap(),
                wire_marker: "x".repeat(4096),
                host_turn_id: None,
            })
            .collect(),
        checkpoint: None,
    };
    assert_eq!(
        wait(adapter.reconcile(request.clone()))
            .unwrap()
            .unresolved_attempt_ids
            .len(),
        100
    );
    request.attempts[0].wire_marker.push('x');
    assert_eq!(
        wait(adapter.reconcile(request.clone())).unwrap_err().code,
        AdapterErrorCode::InvalidArgument
    );
    request.attempts[0].wire_marker.pop();
    let mut attempt = request.attempts[0].clone();
    attempt.attempt_id = id("00000064-1111-4111-8111-111111111111");
    request.attempts.push(attempt);
    assert_eq!(
        wait(adapter.reconcile(request)).unwrap_err().code,
        AdapterErrorCode::InvalidArgument
    );
}
