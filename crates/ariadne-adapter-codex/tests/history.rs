//! Fixture transport tests: only a local Unix socket server and a --version stub run.
use ariadne_adapter_codex::{CodexDaemonReader, CodexHistoryClient, CodexOptions};
use ariadne_agent_protocol::{
    AdapterErrorCode as Code, AttemptEvidenceRequest, ConnectRequest, EventPayload,
    ReconcileRequest, Sha256, UtcMillis, UuidV4,
};
use ariadne_domain::models::{ExecutionState, Freshness, PresenceSource};
use serde_json::{json, Value};
use sha2::{Digest, Sha256 as Hasher};
use std::{
    collections::HashMap,
    fs,
    os::unix::{
        fs::{symlink, PermissionsExt},
        net::UnixListener,
    },
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tungstenite::{
    protocol::frame::{
        coding::{Data, OpCode},
        Frame,
    },
    Message,
};

const THREAD: &str = "01a0fba3-6ed9-76c2-a84e-a462929cef91";
const BINDING: &str = "11111111-1111-4111-8111-111111111111";
const GENERATION: &str = "22222222-2222-4222-8222-222222222222";
const OLD_GENERATION: &str = "33333333-3333-4333-8333-333333333333";
fn id(value: &str) -> UuidV4 {
    UuidV4::new(value).unwrap()
}
fn at() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
}
fn fixture(name: &str) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../contracts/providers/codex/0.160.0/fixtures");
    serde_json::from_slice(&fs::read(root.join(name)).unwrap()).unwrap()
}
fn default_result(request: &Value) -> Value {
    match request["method"].as_str().unwrap() {
        "initialize" => fixture("initialize-response.json"),
        "thread/read" => {
            let mut value = fixture("read-response.json");
            value["thread"]["id"] = request["params"]["threadId"].clone();
            value
        }
        "thread/queue/list" => fixture("queue-response.json"),
        "thread/turns/list" => fixture("turns-response.json"),
        "thread/loaded/list" => fixture("loaded-response.json"),
        method => panic!("unexpected mutating/read API: {method}"),
    }
}
enum Action {
    Result(Value),
    Raw(Value),
    Text(String),
    Binary,
    Close,
    Fragmented(Value),
    Ping(Value),
}
struct Harness {
    _directory: tempfile::TempDir,
    executable: PathBuf,
    socket: PathBuf,
    stop: Arc<AtomicBool>,
    calls: Arc<Mutex<Vec<Value>>>,
    recorded: Arc<Condvar>,
    worker: Option<JoinHandle<()>>,
}
impl Harness {
    fn new(mut hook: impl FnMut(&Value, usize) -> Option<Action> + Send + 'static) -> Self {
        let directory = tempfile::Builder::new()
            .prefix("ariadne-codex-")
            .tempdir_in("/tmp")
            .unwrap();
        let executable = directory.path().join("codex");
        fs::write(&executable, "#!/bin/sh\nprintf 'codex-cli 0.160.0\\n'\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let socket = directory.path().join("daemon.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let observed = calls.clone();
        let recorded = Arc::new(Condvar::new());
        let notification = recorded.clone();
        let worker = thread::spawn(move || {
            let stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        if stopped.load(Ordering::SeqCst) {
                            return;
                        }
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(e) => panic!("fixture accept: {e}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let Ok(mut ws) = tungstenite::accept(stream) else {
                return;
            };
            let mut counts = HashMap::<String, usize>::new();
            while let Ok(message) = ws.read() {
                let Message::Text(text) = message else {
                    continue;
                };
                let request: Value = serde_json::from_str(text.as_str()).unwrap();
                observed.lock().unwrap().push(request.clone());
                notification.notify_all();
                let method = request["method"].as_str().unwrap().to_owned();
                if method == "initialized" {
                    continue;
                }
                let count = counts.entry(method).or_default();
                *count += 1;
                let action = hook(&request, *count)
                    .unwrap_or_else(|| Action::Result(default_result(&request)));
                let envelope = |result: Value| json!({"id":request["id"],"result":result});
                let response = match action {
                    Action::Result(result) => Message::Text(envelope(result).to_string().into()),
                    Action::Raw(value) => Message::Text(value.to_string().into()),
                    Action::Text(text) => Message::Text(text.into()),
                    Action::Binary => Message::Binary(vec![1, 2, 3].into()),
                    Action::Close => Message::Close(None),
                    Action::Ping(result) => {
                        if ws.send(Message::Ping(vec![7].into())).is_err() {
                            break;
                        }
                        Message::Text(envelope(result).to_string().into())
                    }
                    Action::Fragmented(result) => {
                        let bytes = envelope(result).to_string().into_bytes();
                        let middle = bytes.len() / 2;
                        if ws
                            .send(Message::Frame(Frame::message(
                                bytes[..middle].to_vec(),
                                OpCode::Data(Data::Text),
                                false,
                            )))
                            .is_err()
                        {
                            break;
                        }
                        Message::Frame(Frame::message(
                            bytes[middle..].to_vec(),
                            OpCode::Data(Data::Continue),
                            true,
                        ))
                    }
                };
                if ws.send(response).is_err() {
                    break;
                }
            }
        });
        Self {
            _directory: directory,
            executable,
            socket,
            stop,
            calls,
            recorded,
            worker: Some(worker),
        }
    }
    fn standard() -> Self {
        Self::new(|_, _| None)
    }
    fn request(&self) -> ConnectRequest {
        serde_json::from_value(json!({"binding_id":BINDING,"generation":GENERATION,"external_session_id":THREAD,"endpoint":{"kind":"unix_socket","path":self.socket},"configuration":{"namespace":"codex","values":{}}})).unwrap()
    }
    fn options(&self) -> CodexOptions {
        CodexOptions::new(self.executable.clone(), self._directory.path().to_owned()).unwrap()
    }
    fn connect(&self) -> (CodexHistoryClient, ariadne_agent_protocol::ConnectResult) {
        CodexHistoryClient::connect(self.options(), self.request(), id(BINDING), at()).unwrap()
    }
    fn methods(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|call| call["method"].as_str().unwrap().to_owned())
            .collect()
    }
    fn wait_for_method(&self, method: &str) {
        let calls = self.calls.lock().unwrap();
        let (calls, _) = self
            .recorded
            .wait_timeout_while(calls, Duration::from_secs(2), |calls| {
                !calls.iter().any(|call| call["method"] == method)
            })
            .unwrap();
        assert!(
            calls.iter().any(|call| call["method"] == method),
            "Fixture daemon did not record {method} within the bounded wait"
        );
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.worker.take().unwrap().join().unwrap();
    }
}
fn project_harness(root: &Path) -> Harness {
    let root = root.to_owned();
    Harness::new(move |request, _| {
        if request["method"] != "thread/read" {
            return None;
        }
        let mut value = default_result(request);
        value["thread"]["cwd"] = json!(root);
        Some(Action::Result(value))
    })
}

#[test]
fn pre_id_qualification_uses_exact_reader_thread_and_root_before_final_binding_ids() {
    let project = tempfile::tempdir().unwrap();
    let alias = project.path().join("alias");
    symlink(project.path(), &alias).unwrap();
    let h = project_harness(&alias);
    let deadline = Instant::now() + Duration::from_secs(10);
    let reader = CodexDaemonReader::open(h.options(), h.request().endpoint).unwrap();
    let selected = reader
        .qualify_selected_thread(THREAD, project.path(), deadline)
        .unwrap();
    let facts = selected.facts();
    assert_eq!(facts.external_session_id, THREAD);
    assert_eq!(
        facts.canonical_root,
        fs::canonicalize(project.path()).unwrap()
    );
    assert_eq!(facts.endpoint, h.request().endpoint);
    assert_eq!(facts.host_version, "0.160.0");
    assert_eq!(
        facts.availability,
        ariadne_agent_protocol::Availability::Available
    );
    assert_eq!(
        facts.compatibility,
        ariadne_agent_protocol::Compatibility::Compatible
    );
    assert!(facts.capabilities.existing_session.supported);
    assert!(facts.capabilities.deferred_delivery.supported);
    assert!(facts.capabilities.deferred_delivery.conditions[0]
        .contains("runtime owns durable claim and lease"));
    let fingerprint = facts.endpoint_fingerprint.clone();
    let calls = h.calls.lock().unwrap().clone();
    assert_eq!(
        h.methods(),
        [
            "initialize",
            "initialized",
            "thread/read",
            "thread/queue/list",
            "thread/turns/list"
        ]
    );
    assert!(calls
        .iter()
        .all(|request| !request.to_string().contains(BINDING)
            && !request.to_string().contains(GENERATION)));
    for request in &calls[2..] {
        assert_eq!(request["params"]["threadId"], THREAD);
    }
    assert_eq!(calls[3]["params"]["limit"], 20);
    assert_eq!(calls[4]["params"]["limit"], 20);
    assert_eq!(calls[4]["params"]["itemsView"], "full");
    let (client, result) = selected.bind(h.request(), id(BINDING), at()).unwrap();
    assert_eq!(result.endpoint_fingerprint, fingerprint);
    assert_eq!(result.observation.generation, id(GENERATION));
    assert!(client.latest_anchor().is_some());
    // No second initialization or host mutation; final bind rechecks all reads.
    assert_eq!(
        h.methods(),
        [
            "initialize",
            "initialized",
            "thread/read",
            "thread/queue/list",
            "thread/turns/list",
            "thread/read",
            "thread/queue/list",
            "thread/turns/list"
        ]
    );
}

#[test]
fn project_qualification_rejects_other_or_missing_root_before_queue_and_history_reads() {
    let project = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    for (root, expected) in [
        (other.path().to_owned(), Code::BindingMismatch),
        (project.path().join("missing"), Code::HostUnreachable),
    ] {
        let h = project_harness(project.path());
        let reader = CodexDaemonReader::open(h.options(), h.request().endpoint).unwrap();
        let error = reader
            .qualify_selected_thread(THREAD, &root, Instant::now() + Duration::from_secs(10))
            .err()
            .unwrap();
        assert_eq!(error.code, expected);
        assert_eq!(h.methods(), ["initialize", "initialized", "thread/read"]);
    }
}

#[test]
fn qualified_thread_cannot_be_retargeted_and_final_bind_rechecks_current_project() {
    let project = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let root = project.path().to_owned();
    let changed = other.path().to_owned();
    let h = Harness::new(move |request, count| {
        if request["method"] != "thread/read" {
            return None;
        }
        let mut value = default_result(request);
        value["thread"]["cwd"] = json!(if count == 1 { &root } else { &changed });
        Some(Action::Result(value))
    });
    let selected = CodexDaemonReader::open(h.options(), h.request().endpoint)
        .unwrap()
        .qualify_selected_thread(
            THREAD,
            project.path(),
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();
    assert_eq!(
        selected
            .bind(h.request(), id(BINDING), at())
            .err()
            .unwrap()
            .code,
        Code::BindingMismatch
    );
    assert_eq!(
        h.methods(),
        [
            "initialize",
            "initialized",
            "thread/read",
            "thread/queue/list",
            "thread/turns/list",
            "thread/read"
        ]
    );
    let h = project_harness(project.path());
    let selected = CodexDaemonReader::open(h.options(), h.request().endpoint)
        .unwrap()
        .qualify_selected_thread(
            THREAD,
            project.path(),
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();
    let mut request = h.request();
    request.external_session_id = "another-thread".into();
    assert_eq!(
        selected
            .bind(request, id(BINDING), at())
            .err()
            .unwrap()
            .code,
        Code::BindingMismatch
    );
    assert_eq!(h.methods().len(), 5);
}

#[test]
fn pre_id_verification_preserves_required_wire_checks_and_original_deadline() {
    let project = tempfile::tempdir().unwrap();
    for mode in 0..4 {
        let root = project.path().to_owned();
        let h = Harness::new(move |request, _| {
            let mut value = default_result(request);
            match request["method"].as_str().unwrap() {
                "thread/read" => {
                    value["thread"]["cwd"] = json!(root);
                    if mode == 0 {
                        value["thread"]["id"] = json!("different-thread");
                    }
                    if mode == 1 {
                        value["thread"]["status"] = json!({"type":"notLoaded"});
                    }
                }
                "thread/queue/list" if mode == 2 => {
                    let entry = value["data"][0].clone();
                    value["data"] = json!(vec![entry; 21]);
                }
                "thread/turns/list" if mode == 3 => {
                    value["data"][0]["itemsView"] = json!("summary");
                }
                _ => {}
            }
            Some(Action::Result(value))
        });
        let reader = CodexDaemonReader::open(h.options(), h.request().endpoint).unwrap();
        let error = reader
            .qualify_selected_thread(
                THREAD,
                project.path(),
                Instant::now() + Duration::from_secs(10),
            )
            .err()
            .unwrap();
        assert_eq!(
            error.code,
            [
                Code::BindingMismatch,
                Code::HostUnreachable,
                Code::IncompatibleAdapter,
                Code::UnsupportedHostVersion
            ][mode]
        );
        assert!(!h.methods().iter().any(|method| method.contains("start")
            || method.contains("resume")
            || method.contains("add")));
    }
    let h = project_harness(project.path());
    let reader = CodexDaemonReader::open(h.options(), h.request().endpoint).unwrap();
    h.wait_for_method("initialized");
    let error = reader
        .qualify_selected_thread(
            THREAD,
            project.path(),
            Instant::now() - Duration::from_secs(1),
        )
        .err()
        .unwrap();
    assert_eq!(error.code, Code::HostUnreachable);
    assert_eq!(h.methods(), ["initialize", "initialized"]);
}

fn attempt(index: usize) -> AttemptEvidenceRequest {
    let exercise = fixture("poc-live-exercise.json");
    let input = &exercise["inputs"][index];
    AttemptEvidenceRequest {
        input_id: id(input["input_id"].as_str().unwrap()),
        attempt_id: id(&format!("44444444-4444-4444-8444-{:012}", index + 1)),
        binding_generation: id(OLD_GENERATION),
        payload_sha256: Sha256::new(format!(
            "{:x}",
            Hasher::digest(input["text"].as_str().unwrap().as_bytes())
        ))
        .unwrap(),
        wire_marker: input["marker"].as_str().unwrap().to_owned(),
        host_turn_id: None,
    }
}
fn reconcile(attempts: Vec<AttemptEvidenceRequest>) -> ReconcileRequest {
    ReconcileRequest {
        binding_id: id(BINDING),
        generation: id(GENERATION),
        attempts,
        checkpoint: None,
    }
}
fn observed_turns(hook: impl Fn(&mut Value) + Send + 'static) -> Harness {
    Harness::new(move |request, count| {
        if request["method"] == "thread/turns/list" && count > 1 {
            let mut value = fixture("turns-response.json");
            hook(&mut value);
            Some(Action::Result(value))
        } else {
            None
        }
    })
}

#[test]
fn reads_preserved_poc_history_with_historical_correlation_and_no_host_mutations() {
    let harness = Harness::standard();
    let (mut client, connected) = harness.connect();
    assert_eq!(connected.external_session_id, THREAD);
    assert!(!connected.capabilities.deferred_delivery.supported);
    assert_eq!(connected.observation.execution_state, ExecutionState::Idle);
    assert_eq!(connected.observation.freshness, Freshness::Fresh);
    assert_eq!(connected.observation.source, Some(PresenceSource::HostPoll));
    assert!(client.latest_anchor().is_some());
    let request = reconcile((0..3).map(attempt).collect());
    let mut scan = client.begin_scan(None).unwrap();
    let result = client
        .read_history(request.clone(), &mut scan, at())
        .unwrap();
    result.validate_for(&request).unwrap();
    assert_eq!(result.attempt_evidence.len(), 3);
    let original = scan.user_message_identity(&attempt(2).attempt_id).unwrap();
    assert_eq!(
        original.client_id.as_deref(),
        Some("01a0fc15-b3e2-7cc0-af22-de301dd5f741")
    );
    assert_eq!(
        original.host_turn_id,
        "01a0fc15-ec75-7211-8fa6-313294ec730e"
    );
    assert!(result.unresolved_attempt_ids.is_empty());
    assert!(result.next_checkpoint.is_none());
    assert!(scan.progress().exhausted);
    assert!(!scan.progress().anchor_reached);
    for evidence in &result.attempt_evidence {
        assert_eq!(evidence.events.len(), 3);
        for event in &evidence.events {
            assert_eq!(event.binding_id, id(BINDING));
            assert_eq!(event.generation, id(OLD_GENERATION));
            assert_eq!(event.attempt_id, Some(evidence.attempt_id.clone()));
            assert!(event.host_turn_id.is_some());
        }
        assert!(matches!(
            evidence.events[1].event,
            EventPayload::VisibleOutput {
                phase: ariadne_agent_protocol::OutputPhase::Final,
                operation: ariadne_agent_protocol::OutputOperation::Replace,
                ..
            }
        ));
    }
    let again = client.read_history(request, &mut scan, at()).unwrap();
    assert!(again.attempt_evidence.is_empty());
    let methods = harness.methods();
    assert_eq!(
        &methods[..5],
        [
            "initialize",
            "initialized",
            "thread/read",
            "thread/queue/list",
            "thread/turns/list"
        ]
    );
    assert!(methods.iter().all(|method| [
        "initialize",
        "initialized",
        "thread/read",
        "thread/queue/list",
        "thread/turns/list"
    ]
    .contains(&method.as_str())));
    let calls = harness.calls.lock().unwrap();
    for call in calls.iter() {
        assert!(call.get("jsonrpc").is_none());
        if call["method"] == "thread/read" {
            assert_eq!(call["params"]["includeTurns"], false);
        }
        if call["method"] == "thread/turns/list" {
            assert_eq!(call["params"]["threadId"], THREAD);
            assert_eq!(call["params"]["itemsView"], "full");
            assert_eq!(call["params"]["sortDirection"], "desc");
        }
    }
}

#[test]
fn respects_codex_home_default_and_deliberately_resolves_provider_symlink() {
    let harness = Harness::standard();
    let directory = harness._directory.path().join("app-server-control");
    fs::create_dir(&directory).unwrap();
    let link = directory.join("app-server-control.sock");
    symlink(&harness.socket, &link).unwrap();
    let options = harness.options();
    let mut request = harness.request();
    request.endpoint = options.default_endpoint().unwrap();
    let (client, _) = CodexHistoryClient::connect(options, request, id(BINDING), at()).unwrap();
    assert_eq!(
        client.resolved_socket(),
        fs::canonicalize(&harness.socket).unwrap()
    );
}

#[test]
fn discovery_joins_only_loaded_metadata_and_retains_cursor() {
    let harness = Harness::new(|request, _| {
        if request["method"] == "thread/loaded/list" {
            Some(Action::Result(
                json!({"data":[THREAD,"other-loaded-thread"],"nextCursor":"loaded-next"}),
            ))
        } else {
            None
        }
    });
    let (mut client, _) = harness.connect();
    let page = client.discover(None).unwrap();
    assert_eq!(page.candidates.len(), 2);
    assert_eq!(
        page.candidates[1].external_session_id,
        "other-loaded-thread"
    );
    assert_eq!(page.next_cursor.as_deref(), Some("loaded-next"));
    assert!(!harness.methods().contains(&"thread/list".to_owned()));
}

#[test]
fn unsupported_discovery_keeps_exact_manual_thread_read_available() {
    let harness = Harness::new(|request, _| {
        if request["method"] == "thread/loaded/list" {
            Some(Action::Raw(
                json!({"id":request["id"],"error":{"code":-32601,"message":"unsupported"}}),
            ))
        } else {
            None
        }
    });
    let (mut client, _) = harness.connect();
    assert_eq!(client.discover(None).unwrap_err().code, Code::Unsupported);
    assert_eq!(
        client.presence(at()).unwrap().execution_state,
        ExecutionState::Idle
    );
}

#[test]
fn socket_and_executable_replacements_disable_old_reader() {
    for replace_socket in [true, false] {
        let harness = Harness::standard();
        let (mut client, _) = harness.connect();
        if replace_socket {
            fs::rename(&harness.socket, harness._directory.path().join("old.sock")).unwrap();
            let _replacement = UnixListener::bind(&harness.socket).unwrap();
            assert_eq!(
                client.presence(at()).unwrap_err().code,
                Code::BindingMismatch
            );
        } else {
            fs::write(
                &harness.executable,
                "#!/bin/sh\nprintf 'codex-cli 0.160.0\\n' # modified\n",
            )
            .unwrap();
            assert_eq!(
                client.presence(at()).unwrap_err().code,
                Code::UnsupportedHostVersion
            );
        }
        assert_eq!(
            client.presence(at()).unwrap_err().code,
            Code::HostUnreachable
        );
    }
}

#[test]
fn changed_configured_executable_symlink_is_detected() {
    let harness = Harness::standard();
    let link = harness._directory.path().join("selected-codex");
    symlink(&harness.executable, &link).unwrap();
    let mut options = harness.options();
    options.executable = link.clone();
    let (mut client, _) =
        CodexHistoryClient::connect(options, harness.request(), id(BINDING), at()).unwrap();
    let replacement = harness._directory.path().join("replacement");
    fs::copy(&harness.executable, &replacement).unwrap();
    fs::remove_file(&link).unwrap();
    symlink(replacement, link).unwrap();
    assert_eq!(
        client.presence(at()).unwrap_err().code,
        Code::UnsupportedHostVersion
    );
}

#[test]
fn cli_and_daemon_versions_are_exact_and_never_enable_dispatch_on_mismatch() {
    for version in ["0.160.1", "0.159.0", "not-a-version"] {
        let harness = Harness::standard();
        fs::write(
            &harness.executable,
            format!("#!/bin/sh\nprintf 'codex-cli {version}\\n'\n"),
        )
        .unwrap();
        let error =
            CodexHistoryClient::connect(harness.options(), harness.request(), id(BINDING), at())
                .err()
                .unwrap();
        assert_eq!(error.code, Code::UnsupportedHostVersion);
        assert!(harness.methods().is_empty());
    }
    let harness = Harness::new(|request, _| {
        if request["method"] == "initialize" {
            let mut result = fixture("initialize-response.json");
            result["userAgent"] = json!("codex-tui/0.161.0 (Mac OS)");
            Some(Action::Result(result))
        } else {
            None
        }
    });
    let error =
        CodexHistoryClient::connect(harness.options(), harness.request(), id(BINDING), at())
            .err()
            .unwrap();
    assert_eq!(error.code, Code::UnsupportedHostVersion);
    assert_eq!(harness.methods(), ["initialize"]);
}

#[test]
fn invalid_and_unavailable_local_paths_fail_before_daemon_reads() {
    assert!(CodexOptions::new(PathBuf::from("codex"), PathBuf::from("/tmp")).is_err());
    let harness = Harness::standard();
    let mut request = harness.request();
    request.endpoint = ariadne_agent_protocol::EndpointRef::LocalBridge {
        name: "wrong".to_owned(),
    };
    assert_eq!(
        CodexHistoryClient::connect(harness.options(), request, id(BINDING), at())
            .err()
            .unwrap()
            .code,
        Code::InvalidArgument
    );
    let mut request = harness.request();
    request.endpoint = ariadne_agent_protocol::EndpointRef::UnixSocket {
        path: harness.executable.to_str().unwrap().to_owned(),
    };
    assert_eq!(
        CodexHistoryClient::connect(harness.options(), request, id(BINDING), at())
            .err()
            .unwrap()
            .code,
        Code::PermissionDenied
    );
    let mut request = harness.request();
    request.endpoint = ariadne_agent_protocol::EndpointRef::UnixSocket {
        path: "/tmp/ariadne-no-such-socket".to_owned(),
    };
    assert_eq!(
        CodexHistoryClient::connect(harness.options(), request, id(BINDING), at())
            .err()
            .unwrap()
            .code,
        Code::HostUnreachable
    );
    fs::set_permissions(&harness.executable, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        CodexHistoryClient::connect(harness.options(), harness.request(), id(BINDING), at())
            .err()
            .unwrap()
            .code,
        Code::UnsupportedHostVersion
    );
}

#[test]
fn exact_thread_identity_is_required_on_every_metadata_read() {
    let harness = Harness::new(|request, count| {
        if request["method"] == "thread/read" && count > 1 {
            let mut result = fixture("read-response.json");
            result["thread"]["id"] = json!("different-session");
            Some(Action::Result(result))
        } else {
            None
        }
    });
    let (mut client, _) = harness.connect();
    assert_eq!(
        client.presence(at()).unwrap_err().code,
        Code::BindingMismatch
    );
}

#[test]
fn qualified_presence_uses_explicit_state_and_never_infers_idle_from_loaded() {
    for (status, execution) in [
        (
            json!({"type":"active","activeFlags":[]}),
            ExecutionState::Running,
        ),
        (
            json!({"type":"active","activeFlags":["waitingOnApproval"]}),
            ExecutionState::WaitingForApproval,
        ),
        (
            json!({"type":"active","activeFlags":["waitingOnUserInput"]}),
            ExecutionState::Unknown,
        ),
        (json!({"type":"systemError"}), ExecutionState::Unknown),
        (json!({"type":"notLoaded"}), ExecutionState::Unknown),
    ] {
        let harness = Harness::new(move |request, count| {
            if request["method"] == "thread/read" && count > 1 {
                let mut result = fixture("read-response.json");
                result["thread"]["status"] = status.clone();
                Some(Action::Result(result))
            } else {
                None
            }
        });
        let (mut client, _) = harness.connect();
        let presence = client.presence(at()).unwrap();
        assert_eq!(presence.execution_state, execution);
        assert!(presence.process_identity.is_none());
    }
}

#[test]
fn unknown_or_missing_required_history_and_nonfull_views_stop_reconciliation() {
    for variant in 0..4 {
        let harness = observed_turns(move |page| match variant {
            0 => page["data"][0]["items"][0]["type"] = json!("newRequiredItem"),
            1 => page["data"][0]["status"] = json!("newRequiredState"),
            2 => {
                page["data"][0].as_object_mut().unwrap().remove("id");
            }
            _ => page["data"][0]["itemsView"] = json!("summary"),
        });
        let (mut client, _) = harness.connect();
        let mut scan = client.begin_scan(None).unwrap();
        assert_eq!(
            client
                .read_history(reconcile(vec![attempt(2)]), &mut scan, at())
                .unwrap_err()
                .code,
            Code::UnsupportedHostVersion
        );
        assert_eq!(
            client.presence(at()).unwrap_err().code,
            Code::HostUnreachable
        );
    }
}

#[test]
fn nullable_optional_and_unknown_optional_fields_decode_without_invented_completion() {
    let harness = observed_turns(|page| {
        let turn = &mut page["data"][0];
        turn["status"] = json!("inProgress");
        turn["completedAt"] = Value::Null;
        turn["futureOptional"] = json!({"data":"ignored"});
        turn["items"][1]["phase"] = Value::Null;
        turn["items"][0].as_object_mut().unwrap().remove("clientId");
    });
    let (mut client, _) = harness.connect();
    let mut scan = client.begin_scan(None).unwrap();
    let request = reconcile(vec![attempt(2)]);
    let result = client.read_history(request, &mut scan, at()).unwrap();
    assert_eq!(result.unresolved_attempt_ids, vec![attempt(2).attempt_id]);
    assert_eq!(result.attempt_evidence[0].events.len(), 2);
    assert!(matches!(
        result.attempt_evidence[0].events[1].event,
        EventPayload::VisibleOutput {
            phase: ariadne_agent_protocol::OutputPhase::Unknown,
            ..
        }
    ));
}

#[test]
fn marker_without_exact_payload_original_item_and_defined_position_is_unresolved() {
    for variant in 0..5 {
        let harness = observed_turns(move |page| {
            let content = &mut page["data"][0]["items"][0]["content"];
            match variant {
                0 => {
                    content[0]["text"] =
                        json!(format!("{} extra", content[0]["text"].as_str().unwrap()))
                }
                1 => {
                    content[0]["text"] =
                        json!(format!("prefix\n{}", content[0]["text"].as_str().unwrap()))
                }
                2 => {
                    let copy = content[0].clone();
                    content.as_array_mut().unwrap().push(copy);
                }
                3 => {
                    page["data"][0]["items"].as_array_mut().unwrap().remove(0);
                }
                _ => {
                    content[0]["text"] =
                        json!(content[0]["text"].as_str().unwrap().replace("\n", "\r\n"))
                }
            };
        });
        let (mut client, _) = harness.connect();
        let mut scan = client.begin_scan(None).unwrap();
        let result = client
            .read_history(reconcile(vec![attempt(2)]), &mut scan, at())
            .unwrap();
        assert!(result.attempt_evidence.is_empty());
        assert_eq!(result.unresolved_attempt_ids.len(), 1);
    }
}

#[test]
fn conflicting_duplicate_matches_and_expected_turn_ids_pause() {
    for variant in 0..3 {
        let harness = observed_turns(move |page| match variant {
            0 => {
                let copy = page["data"][0]["items"][0].clone();
                page["data"][0]["items"].as_array_mut().unwrap().push(copy);
            }
            1 => {
                let mut copy = page["data"][0].clone();
                copy["id"] = json!("duplicate-match-other-turn");
                page["data"].as_array_mut().unwrap().push(copy);
            }
            _ => {}
        });
        let (mut client, _) = harness.connect();
        let mut scan = client.begin_scan(None).unwrap();
        let mut a = attempt(2);
        if variant == 2 {
            a.host_turn_id = Some("wrong-known-turn".to_owned());
        }
        assert_eq!(
            client
                .read_history(reconcile(vec![a]), &mut scan, at())
                .unwrap_err()
                .code,
            Code::ProtocolConflict
        );
    }
}

#[test]
fn scoped_binding_generation_and_scan_request_are_fenced() {
    for variant in 0..3 {
        let harness = Harness::standard();
        let (mut client, _) = harness.connect();
        let mut scan = client.begin_scan(None).unwrap();
        let mut request = reconcile(vec![attempt(2)]);
        if variant == 0 {
            request.binding_id = id(OLD_GENERATION);
        } else if variant == 1 {
            request.generation = id(OLD_GENERATION);
        } else {
            client
                .read_history(request.clone(), &mut scan, at())
                .unwrap();
            request.attempts = vec![attempt(1)];
        }
        let error = client.read_history(request, &mut scan, at()).unwrap_err();
        assert_eq!(
            error.code,
            if variant == 1 {
                Code::StaleGeneration
            } else {
                Code::BindingMismatch
            }
        );
    }
}

#[test]
fn proven_anchor_stops_before_old_turn_and_missing_anchor_stays_explicit() {
    let harness = Harness::standard();
    let (mut client, _) = harness.connect();
    let mut scan = client
        .begin_scan(client.latest_anchor().map(str::to_owned))
        .unwrap();
    let result = client
        .read_history(reconcile(vec![attempt(2)]), &mut scan, at())
        .unwrap();
    assert!(result.attempt_evidence.is_empty());
    assert!(scan.progress().anchor_reached);
    assert!(!scan.progress().has_more);
    let mut scan = client
        .begin_scan(Some("missing-proven-anchor".to_owned()))
        .unwrap();
    let result = client
        .read_history(reconcile(vec![attempt(2)]), &mut scan, at())
        .unwrap();
    assert_eq!(result.attempt_evidence.len(), 1);
    assert!(scan.progress().exhausted);
    assert!(!scan.progress().anchor_reached);
}

#[test]
fn fragmented_text_and_ping_are_handled_with_standard_websocket() {
    for fragmented in [true, false] {
        let harness = Harness::new(move |request, _| {
            if request["method"] == "initialize" {
                Some(if fragmented {
                    Action::Fragmented(default_result(request))
                } else {
                    Action::Ping(default_result(request))
                })
            } else {
                None
            }
        });
        let (mut client, _) = harness.connect();
        assert_eq!(
            client.presence(at()).unwrap().execution_state,
            ExecutionState::Idle
        );
    }
}

#[test]
fn malformed_rpc_mismatched_ids_binary_close_and_oversized_frames_fail_honestly() {
    for variant in 0..6 {
        let harness = Harness::new(move |request, count| {
            if request["method"] == "thread/read" && count > 1 {
                Some(match variant {
                    0 => Action::Raw(json!({"id":9999,"result":default_result(request)})),
                    1 => Action::Text("invalid JSON".to_owned()),
                    2 => Action::Binary,
                    3 => Action::Close,
                    4 => Action::Text("x".repeat(8 * 1024 * 1024 + 1)),
                    _ => Action::Raw(json!({"id":request["id"]})),
                })
            } else {
                None
            }
        });
        let (mut client, _) = harness.connect();
        let error = client.presence(at()).unwrap_err();
        assert_eq!(
            error.code,
            match variant {
                0 => Code::ProtocolConflict,
                3 => Code::HostUnreachable,
                _ => Code::IncompatibleAdapter,
            }
        );
        assert!(!error.message.contains("invalid JSON"));
    }
}

#[test]
fn readonly_observer_never_answers_host_approval_requests() {
    let harness = Harness::new(|request, count| {
        if request["method"] == "thread/read" && count > 1 {
            Some(Action::Raw(
                json!({"id":"approval","method":"item/commandExecution/requestApproval","params":{"private":"must not leak"}}),
            ))
        } else {
            None
        }
    });
    let (mut client, _) = harness.connect();
    let error = client.presence(at()).unwrap_err();
    assert_eq!(error.code, Code::Unsupported);
    assert!(!error.message.contains("must not leak"));
    assert!(!harness
        .methods()
        .iter()
        .any(|method| method.contains("approval")));
}

#[test]
fn diagnostic_output_is_unicode_bounded_and_private_tools_never_export() {
    let harness = observed_turns(|page| {
        page["data"][0]["items"][1]["text"] = json!("界".repeat(30_000));
        page["data"][0]["items"].as_array_mut().unwrap().push(json!({"type":"reasoning","id":"private-reasoning","summary":["PRIVATE_REASONING"],"content":["PRIVATE_CONTENT"]}));
    });
    let (mut client, _) = harness.connect();
    let mut scan = client.begin_scan(None).unwrap();
    let result = client
        .read_history(reconcile(vec![attempt(2)]), &mut scan, at())
        .unwrap();
    let EventPayload::VisibleOutput {
        text, truncated, ..
    } = &result.attempt_evidence[0].events[1].event
    else {
        panic!("missing output")
    };
    assert!(*truncated);
    assert!(text.len() <= 64 * 1024);
    assert!(text.ends_with('界'));
    let serialized = serde_json::to_string(&result).unwrap();
    assert!(!serialized.contains("PRIVATE_"));
}

#[test]
fn failed_and_interrupted_turns_remain_separate_lifecycle_facts() {
    for status in ["failed", "interrupted"] {
        let harness = observed_turns(move |page| {
            page["data"][0]["status"] = json!(status);
            page["data"][0]["error"] = json!({"message":"PRIVATE_TOOL_ERROR"});
        });
        let (mut client, _) = harness.connect();
        let mut scan = client.begin_scan(None).unwrap();
        let result = client
            .read_history(reconcile(vec![attempt(2)]), &mut scan, at())
            .unwrap();
        assert!(result.unresolved_attempt_ids.is_empty());
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("PRIVATE_TOOL_ERROR"));
        assert!(matches!(
            result.attempt_evidence[0].events.last().unwrap().event,
            EventPayload::TurnFinished { .. }
        ));
    }
}

#[test]
fn bounded_history_continues_after_1000_turns_without_claiming_non_delivery() {
    let harness = Harness::new(|request, count| {
        if request["method"] == "thread/turns/list" && count > 1 {
            let page = request["params"]["cursor"]
                .as_str()
                .unwrap_or("0")
                .parse::<usize>()
                .unwrap();
            let mut value = fixture("turns-response.json");
            let original = value["data"][0].clone();
            value["data"] = json!((0..20)
                .map(|n| {
                    let mut turn = original.clone();
                    turn["id"] = json!(format!("unrelated-{page}-{n}"));
                    turn["items"] = json!([]);
                    turn
                })
                .collect::<Vec<_>>());
            value["nextCursor"] = if page < 50 {
                json!((page + 1).to_string())
            } else {
                Value::Null
            };
            Some(Action::Result(value))
        } else {
            None
        }
    });
    let (mut client, _) = harness.connect();
    let mut scan = client
        .begin_scan(Some("not-seen-anchor".to_owned()))
        .unwrap();
    let request = reconcile(vec![attempt(2)]);
    let result = client
        .read_history(request.clone(), &mut scan, at())
        .unwrap();
    assert!(result.attempt_evidence.is_empty());
    assert_eq!(result.unresolved_attempt_ids.len(), 1);
    assert!(scan.progress().has_more);
    assert!(!scan.progress().exhausted);
    assert_eq!(
        harness
            .methods()
            .iter()
            .filter(|method| *method == "thread/turns/list")
            .count(),
        51
    );
    client.read_history(request, &mut scan, at()).unwrap();
    assert!(scan.progress().exhausted);
}

#[test]
fn repeated_cursor_and_oversized_pages_stop_bounded_traversal() {
    for oversized in [true, false] {
        let harness = observed_turns(move |page| {
            if oversized {
                let turn = page["data"][0].clone();
                page["data"] = json!(vec![turn; 21]);
            } else {
                page["data"] = json!([]);
                page["nextCursor"] = json!("cycle");
            }
        });
        let (mut client, _) = harness.connect();
        let mut scan = client.begin_scan(None).unwrap();
        let error = client
            .read_history(reconcile(vec![]), &mut scan, at())
            .unwrap_err();
        assert_eq!(
            error.code,
            if oversized {
                Code::IncompatibleAdapter
            } else {
                Code::ProtocolConflict
            }
        );
    }
}

#[test]
fn batch_and_marker_limits_are_explicit_at_their_boundaries() {
    for (count, marker_size, expected_error) in [
        (100, 4096, None),
        (101, 10, Some(Code::InvalidArgument)),
        (1, 4097, Some(Code::InvalidArgument)),
        (1, 0, Some(Code::InvalidArgument)),
    ] {
        let harness = Harness::standard();
        let (mut client, _) = harness.connect();
        let mut scan = client.begin_scan(None).unwrap();
        let attempts = (0..count)
            .map(|number| {
                let mut a = attempt(2);
                a.attempt_id = id(&format!("44444444-4444-4444-8444-{:012}", number + 1));
                a.wire_marker = "x".repeat(marker_size);
                a
            })
            .collect();
        let result = client.read_history(reconcile(attempts), &mut scan, at());
        if let Some(expected) = expected_error {
            let error = result.unwrap_err();
            assert_eq!(error.code, expected);
            assert!(error.message.contains("100 attempts") || error.message.contains("4 KiB"));
        } else {
            assert_eq!(result.unwrap().unresolved_attempt_ids.len(), count);
        }
    }
}

#[test]
fn verbose_visible_history_is_bounded_but_completion_always_survives() {
    let harness = observed_turns(|page| {
        let turn = &mut page["data"][0];
        let user = turn["items"][0].clone();
        let messages=(0..300).map(|number|json!({"type":"agentMessage","id":format!("visible-{number}"),"text":"x".repeat(12_000),"phase":"commentary"}));
        turn["items"] = json!(std::iter::once(user).chain(messages).collect::<Vec<_>>());
    });
    let (mut client, _) = harness.connect();
    let mut scan = client.begin_scan(None).unwrap();
    let result = client
        .read_history(reconcile(vec![attempt(2)]), &mut scan, at())
        .unwrap();
    let events = &result.attempt_evidence[0].events;
    let outputs = events
        .iter()
        .filter_map(|event| {
            if let EventPayload::VisibleOutput { text, .. } = &event.event {
                Some(text.len())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    assert!(outputs.len() <= 256);
    assert!(outputs.iter().sum::<usize>() <= 2 * 1024 * 1024);
    assert!(matches!(
        events[1].event,
        EventPayload::VisibleOutput {
            gap_before: true,
            ..
        }
    ));
    assert!(matches!(
        events.last().unwrap().event,
        EventPayload::TurnFinished {
            truncated: true,
            ..
        }
    ));
    assert!(result.unresolved_attempt_ids.is_empty());
}

#[test]
fn replay_identity_is_stable_and_visible_phase_changes_are_distinct() {
    let harness = Harness::new(|request, count| {
        if request["method"] == "thread/turns/list" && count > 2 {
            let mut page = fixture("turns-response.json");
            page["data"][0]["items"][1]["phase"] = json!("commentary");
            Some(Action::Result(page))
        } else {
            None
        }
    });
    let (mut client, _) = harness.connect();
    let request = reconcile(vec![attempt(2)]);
    let mut first = client.begin_scan(None).unwrap();
    let first = client
        .read_history(request.clone(), &mut first, at())
        .unwrap();
    let mut second = client.begin_scan(None).unwrap();
    let second = client.read_history(request, &mut second, at()).unwrap();
    let first = &first.attempt_evidence[0].events;
    let second = &second.attempt_evidence[0].events;
    assert_eq!(first[0].event_id, second[0].event_id);
    assert_eq!(first[2].event_id, second[2].event_id);
    assert_ne!(first[1].event_id, second[1].event_id);
}

#[test]
fn transient_read_errors_are_not_classified_as_unsupported_discovery() {
    let harness = Harness::new(|request, _| {
        if request["method"] == "thread/loaded/list" {
            Some(Action::Raw(
                json!({"id":request["id"],"error":{"code":-32000,"message":"PRIVATE_SERVER_FAILURE"}}),
            ))
        } else {
            None
        }
    });
    let (mut client, _) = harness.connect();
    let error = client.discover(None).unwrap_err();
    assert_eq!(error.code, Code::HostUnreachable);
    assert!(!error.message.contains("PRIVATE_SERVER_FAILURE"));
    assert!(client.presence(at()).is_err());
}

#[test]
fn unbound_discovery_precedes_explicit_binding_and_reuses_initialization() {
    let harness = Harness::standard();
    let mut reader =
        CodexDaemonReader::open(harness.options(), harness.request().endpoint).unwrap();
    harness.wait_for_method("initialized");
    assert_eq!(harness.methods(), ["initialize", "initialized"]);
    let candidates = reader.discover(None).unwrap();
    assert_eq!(candidates.candidates[0].external_session_id, THREAD);
    assert!(!harness.methods().contains(&"thread/queue/list".to_owned()));
    let (mut client, result) = reader.bind(harness.request(), id(BINDING), at()).unwrap();
    assert_eq!(result.external_session_id, THREAD);
    assert_eq!(
        harness
            .methods()
            .iter()
            .filter(|method| *method == "initialize")
            .count(),
        1
    );
    assert!(client.presence(at()).is_ok());
}
#[test]
fn unbound_reader_rechecks_identity_and_explicit_endpoint_when_binding() {
    for changed_executable in [true, false] {
        let harness = Harness::standard();
        let reader =
            CodexDaemonReader::open(harness.options(), harness.request().endpoint).unwrap();
        let mut request = harness.request();
        if changed_executable {
            fs::write(
                &harness.executable,
                "#!/bin/sh\nprintf 'codex-cli 0.160.0\\n' # changed\n",
            )
            .unwrap();
        } else {
            let other = harness._directory.path().join("other.sock");
            let _other = UnixListener::bind(&other).unwrap();
            request.endpoint = ariadne_agent_protocol::EndpointRef::UnixSocket {
                path: other.to_str().unwrap().to_owned(),
            };
        }
        let error = reader.bind(request, id(BINDING), at()).err().unwrap();
        assert_eq!(
            error.code,
            if changed_executable {
                Code::UnsupportedHostVersion
            } else {
                Code::BindingMismatch
            }
        );
        harness.wait_for_method("initialized");
        assert_eq!(harness.methods(), ["initialize", "initialized"]);
    }
}
#[test]
fn version_probe_output_is_bounded_and_nonzero_is_not_compatible() {
    for oversized in [true, false] {
        let harness = Harness::standard();
        let script = if oversized {
            format!("#!/bin/sh\nprintf '{}\\n'\n", "x".repeat(5000))
        } else {
            "#!/bin/sh\nprintf 'codex-cli 0.160.0\\n'\nexit 1\n".to_owned()
        };
        fs::write(&harness.executable, script).unwrap();
        let error =
            CodexHistoryClient::connect(harness.options(), harness.request(), id(BINDING), at())
                .err()
                .unwrap();
        assert_eq!(error.code, Code::UnsupportedHostVersion);
        assert!(harness.methods().is_empty());
    }
}

#[test]
fn exact_first_line_and_original_message_cannot_alias_multiple_attempts() {
    let harness = observed_turns(|page| {
        let text = page["data"][0]["items"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .replace("\n", "\r\n");
        page["data"][0]["items"][0]["content"][0]["text"] = json!(text);
    });
    let (mut client, _) = harness.connect();
    let mut scan = client.begin_scan(None).unwrap();
    let mut a = attempt(2);
    let text = fixture("poc-live-exercise.json")["inputs"][2]["text"]
        .as_str()
        .unwrap()
        .replace("\n", "\r\n");
    a.payload_sha256 = Sha256::new(format!("{:x}", Hasher::digest(text.as_bytes()))).unwrap();
    let result = client
        .read_history(reconcile(vec![a]), &mut scan, at())
        .unwrap();
    assert!(result.attempt_evidence.is_empty());
    drop(client);
    drop(harness);
    let harness = Harness::standard();
    let (mut client, _) = harness.connect();
    let mut scan = client.begin_scan(None).unwrap();
    let first = attempt(2);
    let mut second = first.clone();
    second.attempt_id = id("55555555-5555-4555-8555-555555555555");
    assert_eq!(
        client
            .read_history(reconcile(vec![first, second]), &mut scan, at())
            .unwrap_err()
            .code,
        Code::ProtocolConflict
    );
}
