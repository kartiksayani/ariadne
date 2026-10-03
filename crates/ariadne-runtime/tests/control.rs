use ariadne_core::{fake::*, *};
use ariadne_domain::models::*;
use ariadne_runtime::{control::*, leases::DesktopOwner};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::unix::{
        fs::{symlink, MetadataExt, PermissionsExt},
        net::UnixStream,
    },
    path::Path,
    process::{Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{runtime::Runtime, sync::oneshot};
#[allow(dead_code)]
#[path = "../../../tests/support/core_service/mod.rs"]
mod cases;
fn root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
}
fn home() -> tempfile::TempDir {
    let home = tempfile::Builder::new()
        .prefix("ariadne-control-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
    home
}
fn runtime() -> Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
}
fn corpus() -> cases::Corpus {
    cases::load(root())
}
fn scope(r: &cases::Routing) -> BindingScope {
    BindingScope {
        binding_id: r.binding_id.clone(),
        generation: r.generation.clone(),
    }
}
fn ping(r: &cases::Routing) -> ControlRequest {
    ControlRequest::new(r.source_input_id.clone(), ControlMethod::Ping(scope(r))).unwrap()
}
struct Running {
    stop: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<Result<(), CoreError>>,
}
impl Running {
    fn start(rt: &Runtime, home: &Path, core: Arc<dyn CoreService>, r: &cases::Routing) -> Self {
        let owner = DesktopOwner::acquire(home).unwrap();
        let lease = owner
            .binding_lease(r.session(), r.binding_id.clone(), r.generation.clone())
            .unwrap();
        let server = ControlServer::bind(owner, core, vec![lease]).unwrap();
        let (stop, stopped) = oneshot::channel();
        Self {
            stop,
            task: rt.spawn(server.serve(stopped)),
        }
    }
    fn stop(self, rt: &Runtime) {
        self.stop.send(()).unwrap();
        rt.block_on(async { tokio::time::timeout(Duration::from_secs(2), self.task).await })
            .unwrap()
            .unwrap()
            .unwrap();
    }
}
fn raw(home: &Path, bytes: &[u8], declared: usize) -> Option<serde_json::Value> {
    let mut stream = UnixStream::connect(home.join("run/control.sock")).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    stream.write_all(&(declared as u32).to_be_bytes()).unwrap();
    if !bytes.is_empty() {
        stream.write_all(bytes).unwrap();
    }
    let mut length = [0; 4];
    if stream.read_exact(&mut length).is_err() {
        return None;
    }
    let mut response = vec![0; u32::from_be_bytes(length) as usize];
    stream.read_exact(&mut response).unwrap();
    Some(serde_json::from_slice(&response).unwrap())
}

#[test]
fn shared_claim_receipts_replay_before_generation_and_preserve_barrier_errors_over_real_ipc() {
    let corpus = corpus();
    let rt = runtime();
    for case in &corpus.cases {
        let steps: Vec<_> = case
            .steps
            .iter()
            .filter_map(|step| {
                if let cases::CaseStep::Claim {
                    current_generation,
                    request,
                    response,
                } = step
                {
                    Some((current_generation, request, response))
                } else {
                    None
                }
            })
            .collect();
        if steps.is_empty() {
            continue;
        }
        let script = steps
            .iter()
            .map(|(generation, request, response)| ScriptStep {
                request: RecordedRequest::Claim(
                    corpus.routing.dispatch((*generation).clone()),
                    (*request).clone(),
                ),
                response: ScriptedResponse::Claim(cases::result(response)),
            });
        let core = Arc::new(ScriptedCoreService::new(script));
        let home = home();
        for (generation, request, response) in steps {
            let mut current = corpus.routing.clone();
            current.generation = generation.clone();
            let server = Running::start(&rt, home.path(), core.clone(), &current);
            let request = ControlRequest::new(
                request.request_id.clone(),
                ControlMethod::Claim(request.clone()),
            )
            .unwrap();
            let actual = rt.block_on(call(home.path().to_owned(), request));
            let expected = cases::result(response).map(ControlResult::Claim);
            assert_eq!(actual, expected, "{}", case.name);
            server.stop(&rt);
        }
        assert_eq!(core.remaining().unwrap(), 0, "{}", case.name);
        assert_eq!(
            core.history().unwrap().len(),
            case.steps
                .iter()
                .filter(|step| matches!(step, cases::CaseStep::Claim { .. }))
                .count()
        );
    }
}
#[test]
fn ping_is_scoped_reachability_and_connection_status_uses_actual_core_binding() {
    let corpus = corpus();
    let r = corpus.routing;
    let session: Session = serde_json::from_slice(
        &fs::read(root().join("fixtures/domain/demo/session.json")).unwrap(),
    )
    .unwrap();
    let query = QueryResult::SessionGet(SessionSnapshot {
        session: session.clone(),
        freshness: Freshness::Fresh,
    });
    let core = Arc::new(ScriptedCoreService::new([ScriptStep {
        request: RecordedRequest::Query(
            QueryContext::owner(r.owner()),
            Box::new(QueryRequest::SessionGet {}),
        ),
        response: ScriptedResponse::Query(Box::new(Ok(query))),
    }]));
    let home = home();
    let rt = runtime();
    let server = Running::start(&rt, home.path(), core.clone(), &r);
    assert_eq!(
        rt.block_on(call(home.path().into(), ping(&r))).unwrap(),
        ControlResult::Ping(scope(&r))
    );
    assert!(core.history().unwrap().is_empty());
    let mut stale = scope(&r);
    stale.generation = r.attempt_id.clone();
    let stale = ControlRequest::new(r.source_input_id.clone(), ControlMethod::Ping(stale)).unwrap();
    assert_eq!(
        rt.block_on(call(home.path().into(), stale))
            .unwrap_err()
            .code,
        CoreErrorCode::StaleGeneration
    );
    let mut unknown = scope(&r);
    unknown.binding_id = r.attempt_id.clone();
    let unknown =
        ControlRequest::new(r.source_input_id.clone(), ControlMethod::Ping(unknown)).unwrap();
    assert_eq!(
        rt.block_on(call(home.path().into(), unknown))
            .unwrap_err()
            .code,
        CoreErrorCode::NotFound
    );
    let status = ControlRequest::new(
        r.source_input_id.clone(),
        ControlMethod::ConnectionStatus(scope(&r)),
    )
    .unwrap();
    let ControlResult::Status(actual) = rt.block_on(call(home.path().into(), status)).unwrap()
    else {
        panic!("wrong status response")
    };
    let binding = &session.bindings.0[&r.binding_id];
    assert_eq!(actual.id, binding.id);
    assert_eq!(actual.generation, binding.generation);
    assert_eq!(actual.dispatch_state, binding.dispatch_state);
    assert_eq!(actual.connection_state, binding.connection_state);
    assert!(actual.presence.is_none());
    assert_eq!(core.remaining().unwrap(), 0);
    server.stop(&rt);
}
#[test]
fn private_modes_no_follow_and_nonblocking_stable_leases_protect_owned_paths() {
    let h = home();
    let r = corpus().routing;
    let owner = DesktopOwner::acquire(h.path()).unwrap();
    let lease = owner
        .binding_lease(r.session(), r.binding_id.clone(), r.generation.clone())
        .unwrap();
    let retained = lease.clone();
    assert_eq!(
        fs::metadata(h.path().join("run")).unwrap().mode() & 0o777,
        0o700
    );
    let path = h
        .path()
        .join(format!("run/leases/{}.lock", r.binding_id.as_str()));
    let inode = fs::metadata(&path).unwrap().ino();
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
    assert!(DesktopOwner::acquire(h.path()).is_err());
    drop(owner);
    drop(lease);
    let owner = DesktopOwner::acquire(h.path()).unwrap();
    assert!(owner
        .binding_lease(r.session(), r.binding_id.clone(), r.generation.clone())
        .is_err());
    drop(retained);
    let _lease = owner
        .binding_lease(r.session(), r.binding_id.clone(), r.generation.clone())
        .unwrap();
    assert_eq!(fs::metadata(path).unwrap().ino(), inode);
    let _independent = owner
        .binding_lease(r.session(), r.attempt_id.clone(), r.generation.clone())
        .unwrap();

    let bad = home();
    fs::set_permissions(bad.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(DesktopOwner::acquire(bad.path()).is_err());
    fs::set_permissions(bad.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let outside = home();
    symlink(outside.path(), bad.path().join("run")).unwrap();
    assert!(DesktopOwner::acquire(bad.path()).is_err());
    assert!(!outside.path().join("runtime.lock").exists());
    let bad = home();
    let owner = DesktopOwner::acquire(bad.path()).unwrap();
    symlink(
        outside.path().join("target"),
        bad.path()
            .join(format!("run/leases/{}.lock", r.binding_id.as_str())),
    )
    .unwrap();
    assert!(owner
        .binding_lease(r.session(), r.binding_id.clone(), r.generation.clone())
        .is_err());
    assert!(!outside.path().join("target").exists());
}
#[test]
fn stale_endpoint_removal_requires_instance_lease_owned_socket_and_native_path_limit() {
    let h = home();
    let owner = DesktopOwner::acquire(h.path()).unwrap();
    let endpoint = owner.control_path();
    fs::write(&endpoint, b"ordinary restored file").unwrap();
    fs::set_permissions(&endpoint, fs::Permissions::from_mode(0o600)).unwrap();
    let core = Arc::new(ScriptedCoreService::new([]));
    assert!(ControlServer::bind(owner, core.clone(), vec![]).is_err());
    assert_eq!(fs::read(&endpoint).unwrap(), b"ordinary restored file");
    let short = home();
    let long = short.path().join("x".repeat(100));
    let owner = DesktopOwner::acquire(&long).unwrap();
    let error = ControlServer::bind(owner, core, vec![]).err().unwrap();
    assert_eq!(error.code, CoreErrorCode::ControlPathTooLong);
    assert!(error.hint.contains("ARIADNE_HOME"));
}
#[test]
fn bounded_frames_reject_unknown_duplicate_fields_and_never_fabricate_ids() {
    let h = home();
    let rt = runtime();
    let r = corpus().routing;
    let core = Arc::new(ScriptedCoreService::new([]));
    let server = Running::start(&rt, h.path(), core.clone(), &r);
    let valid = serde_json::to_value(ping(&r)).unwrap();
    for changed in ["unknown", "params", "version"] {
        let mut request = valid.clone();
        match changed {
            "unknown" => request["unexpected"] = true.into(),
            "params" => request["params"]["actor"] = "owner".into(),
            _ => request["v"] = 2.into(),
        }
        let bytes = serde_json::to_vec(&request).unwrap();
        let response = raw(h.path(), &bytes, bytes.len()).unwrap();
        assert!(response.get("result").is_none());
        assert!(response.get("error").is_some());
        assert_eq!(response["id"], valid["id"]);
    }
    let duplicated = format!(
        "{{\"id\":\"{}\",{}",
        r.attempt_id.as_str(),
        serde_json::to_string(&valid)
            .unwrap()
            .trim_start_matches('{')
    );
    assert!(raw(h.path(), duplicated.as_bytes(), duplicated.len())
        .unwrap()
        .get("error")
        .is_some());
    let duplicated_params = serde_json::to_string(&valid).unwrap().replace(
        "\"params\":{",
        &format!("\"params\":{{\"binding_id\":\"{}\",", r.binding_id.as_str()),
    );
    assert!(raw(
        h.path(),
        duplicated_params.as_bytes(),
        duplicated_params.len()
    )
    .unwrap()
    .get("error")
    .is_some());
    for value in [
        serde_json::json!({"v":1}),
        serde_json::json!({"id":"not-a-uuid"}),
    ] {
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(raw(h.path(), &bytes, bytes.len()).is_none());
    }
    assert!(raw(h.path(), &[0xff], 1).is_none());
    assert!(raw(h.path(), &[], 0).is_none());
    assert!(raw(h.path(), &[], MAX_FRAME_BYTES + 1).is_none());
    let mut bytes = serde_json::to_vec(&valid).unwrap();
    bytes.resize(MAX_FRAME_BYTES, b' ');
    assert_eq!(
        raw(h.path(), &bytes, bytes.len()).unwrap()["result"],
        serde_json::to_value(scope(&r)).unwrap()
    );
    assert!(core.history().unwrap().is_empty());
    server.stop(&rt);
}
#[test]
fn partial_frame_has_one_absolute_five_second_bound_and_does_not_stop_listener() {
    let h = home();
    let rt = runtime();
    let r = corpus().routing;
    let server = Running::start(&rt, h.path(), Arc::new(ScriptedCoreService::new([])), &r);
    let mut stream = UnixStream::connect(h.path().join("run/control.sock")).unwrap();
    stream
        .set_read_timeout(Some(CONTROL_TIMEOUT + Duration::from_secs(2)))
        .unwrap();
    stream.write_all(&[0, 0]).unwrap();
    let start = Instant::now();
    let mut byte = [0];
    assert!(matches!(stream.read(&mut byte), Ok(0) | Err(_)));
    assert!(start.elapsed() < CONTROL_TIMEOUT + Duration::from_secs(2));
    assert_eq!(
        rt.block_on(call(h.path().into(), ping(&r))).unwrap(),
        ControlResult::Ping(scope(&r))
    );
    server.stop(&rt);
}

// Child is also instrumented under cargo-llvm-cov: environment is inherited.
#[test]
fn lease_child_process() {
    let Some(home) = std::env::var_os("ARIADNE_TEST_LEASE_CHILD") else {
        return;
    };
    let r = corpus().routing;
    let owner = DesktopOwner::acquire(Path::new(&home)).unwrap();
    let lease = owner
        .binding_lease(r.session(), r.binding_id.clone(), r.generation.clone())
        .unwrap();
    let _server =
        ControlServer::bind(owner, Arc::new(ScriptedCoreService::new([])), vec![lease]).unwrap();
    println!("LEASE_READY");
    std::io::stdout().flush().unwrap();
    std::io::stdin().read_exact(&mut [0]).unwrap();
}
#[test]
fn separate_desktop_processes_converge_without_deleting_another_owner_socket() {
    let h = home();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "lease_child_process", "--nocapture"])
        .env("ARIADNE_TEST_LEASE_CHILD", h.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (ready, observed) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if line.unwrap() == "LEASE_READY" {
                ready.send(()).unwrap();
            }
        }
    });
    if observed.recv_timeout(Duration::from_secs(3)).is_err() {
        child.kill().unwrap();
        panic!("lease child did not initialize")
    }
    let endpoint = h.path().join("run/control.sock");
    let metadata = fs::metadata(&endpoint).unwrap();
    assert_eq!(metadata.mode() & 0o777, 0o600);
    assert!(DesktopOwner::acquire(h.path()).is_err());
    assert_eq!(fs::metadata(&endpoint).unwrap().ino(), metadata.ino());
    child.stdin.take().unwrap().write_all(b"x").unwrap();
    assert!(child.wait().unwrap().success());
    let owner = DesktopOwner::acquire(h.path()).unwrap();
    let _server =
        ControlServer::bind(owner, Arc::new(ScriptedCoreService::new([])), vec![]).unwrap();
    assert_eq!(fs::metadata(&endpoint).unwrap().mode() & 0o777, 0o600);
}

struct BlockedCore {
    inner: ScriptedCoreService,
    began: Mutex<Option<mpsc::Sender<()>>>,
    release: Mutex<mpsc::Receiver<()>>,
}
impl CoreService for BlockedCore {
    fn query(&self, c: QueryContext, q: QueryRequest) -> Result<QueryResult, CoreError> {
        self.inner.query(c, q)
    }
    fn execute_owner(
        &self,
        c: OwnerContext,
        q: OwnerCommand,
    ) -> Result<MutationReceipt, CoreError> {
        self.inner.execute_owner(c, q)
    }
    fn apply(&self, c: AgentContext, q: ApplyRequest) -> Result<ApplyReceipt, CoreError> {
        self.inner.apply(c, q)
    }
    fn report(
        &self,
        c: AdapterContext,
        q: ariadne_agent_protocol::NormalizedEvent,
    ) -> Result<EventReceipt, CoreError> {
        self.inner.report(c, q)
    }
    fn claim(
        &self,
        c: ValidatedDispatchContext,
        q: ClaimRequest,
    ) -> Result<Option<PreparedAttempt>, CoreError> {
        self.began.lock().unwrap().take().unwrap().send(()).unwrap();
        self.release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(3))
            .unwrap();
        self.inner.claim(c, q)
    }
}
#[test]
fn dropped_connection_and_shutdown_retain_actual_lease_until_blocking_claim_finishes() {
    let h = home();
    let rt = runtime();
    let r = corpus().routing;
    let request = ClaimRequest {
        binding_id: r.binding_id.clone(),
        generation: r.generation.clone(),
        request_id: r.source_input_id.clone(),
    };
    let (began, started) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let core = Arc::new(BlockedCore {
        inner: ScriptedCoreService::new([ScriptStep {
            request: RecordedRequest::Claim(r.dispatch(r.generation.clone()), request.clone()),
            response: ScriptedResponse::Claim(Ok(None)),
        }]),
        began: Mutex::new(Some(began)),
        release: Mutex::new(released),
    });
    let server = Running::start(&rt, h.path(), core.clone(), &r);
    let wire = serde_json::to_vec(
        &ControlRequest::new(request.request_id.clone(), ControlMethod::Claim(request)).unwrap(),
    )
    .unwrap();
    let mut stream = UnixStream::connect(h.path().join("run/control.sock")).unwrap();
    stream
        .write_all(&(wire.len() as u32).to_be_bytes())
        .unwrap();
    stream.write_all(&wire).unwrap();
    started.recv_timeout(Duration::from_secs(2)).unwrap();
    drop(stream);
    server.stop(&rt);
    let owner = DesktopOwner::acquire(h.path()).unwrap();
    assert!(owner
        .binding_lease(r.session(), r.binding_id.clone(), r.generation.clone())
        .is_err());
    release.send(()).unwrap();
    rt.shutdown_timeout(Duration::from_secs(2));
    let _lease = owner
        .binding_lease(r.session(), r.binding_id.clone(), r.generation.clone())
        .unwrap();
    assert_eq!(core.inner.remaining().unwrap(), 0);
}

#[test]
fn client_rejects_ambiguous_or_mismatched_responses_and_claim_identity() {
    let r = corpus().routing;
    let request = ping(&r);
    let valid = serde_json::json!({"v":1,"kind":"response","id":request.id,"result":scope(&r)});
    for changed in ["id", "version", "scope", "method"] {
        let mut response = valid.clone();
        match changed {
            "id" => response["id"] = serde_json::to_value(&r.attempt_id).unwrap(),
            "version" => response["v"] = 2.into(),
            "scope" => {
                response["result"]["generation"] = serde_json::to_value(&r.attempt_id).unwrap()
            }
            _ => response["result"] = serde_json::Value::Null,
        }
        let response: ControlResponse = serde_json::from_value(response).unwrap();
        assert_eq!(
            response.into_result(&request).unwrap_err().code,
            CoreErrorCode::ProtocolConflict
        );
    }
    let mut ambiguous = valid;
    ambiguous["error"] = serde_json::to_value(CoreError::new(
        CoreErrorCode::Unsupported,
        "unsupported",
        "check version",
    ))
    .unwrap();
    assert!(serde_json::from_value::<ControlResponse>(ambiguous).is_err());
    assert!(ControlRequest::new(
        r.source_input_id.clone(),
        ControlMethod::Claim(ClaimRequest {
            binding_id: r.binding_id,
            generation: r.generation,
            request_id: r.attempt_id,
        })
    )
    .is_err());
}

fn error_cases() -> Vec<(bool, CoreError)> {
    let mut valid = CoreError::new(
        CoreErrorCode::DeliveryUncertain,
        "The original operation may have effects.",
        "Retain its original identity and reconcile.",
    );
    valid.current_revision = Some(PositiveSafeInteger::new(2).unwrap());
    valid.field_errors.push(FieldError {
        field: "operation_id".into(),
        message: "Retain this ID.".into(),
    });
    let mut cases = vec![(true, valid.clone())];
    for change in ["retryable", "message", "hint", "field", "field_message"] {
        let mut error = valid.clone();
        match change {
            "retryable" => error.retryable = true,
            "message" => error.message = " ".into(),
            "hint" => error.hint = "private invalid diagnostic".repeat(200),
            "field" => error.field_errors[0].field.clear(),
            _ => error.field_errors[0].message = "private invalid diagnostic".repeat(200),
        }
        assert!(error.validate().is_err());
        cases.push((false, error));
    }
    cases
}
fn checked_error(actual: CoreError, valid: bool, original: &CoreError) {
    actual.validate().unwrap();
    if valid {
        assert_eq!(&actual, original);
    } else {
        assert_eq!(actual.code, CoreErrorCode::ProtocolConflict);
        assert!(!actual.retryable);
        assert!(actual
            .hint
            .contains("original request, event and operation IDs"));
        assert!(actual.hint.contains("effects may already exist"));
        assert!(!actual.message.contains("private invalid diagnostic"));
        assert!(!actual.hint.contains("private invalid diagnostic"));
    }
}
#[test]
fn native_core_error_producer_and_ipc_consumer_validate_without_losing_identity() {
    let h = home();
    let rt = runtime();
    let r = corpus().routing;
    let claim = ClaimRequest {
        binding_id: r.binding_id.clone(),
        generation: r.generation.clone(),
        request_id: r.source_input_id.clone(),
    };
    for (valid, error) in error_cases() {
        let server = Running::start(&rt, h.path(), Arc::new(FaultyErrorCore(error.clone())), &r);
        for method in [
            ControlMethod::Claim(claim.clone()),
            ControlMethod::ConnectionStatus(scope(&r)),
        ] {
            let request = ControlRequest::new(r.source_input_id.clone(), method).unwrap();
            let bytes = serde_json::to_vec(&request).unwrap();
            let response = raw(h.path(), &bytes, bytes.len()).unwrap();
            assert_eq!(response["id"], serde_json::to_value(&request.id).unwrap());
            let published: CoreError = serde_json::from_value(response["error"].clone()).unwrap();
            checked_error(published, valid, &error);
            // An untrusted desktop can independently inject a malformed error.
            let untrusted =
                serde_json::json!({"v":1,"kind":"response","id":request.id,"error":error});
            let response: ControlResponse = serde_json::from_value(untrusted).unwrap();
            checked_error(response.into_result(&request).unwrap_err(), valid, &error);
        }
        server.stop(&rt);
    }
}

struct FaultyErrorCore(CoreError);
impl CoreService for FaultyErrorCore {
    fn query(&self, _: QueryContext, _: QueryRequest) -> Result<QueryResult, CoreError> {
        Err(self.0.clone())
    }
    fn execute_owner(
        &self,
        _: OwnerContext,
        _: OwnerCommand,
    ) -> Result<MutationReceipt, CoreError> {
        unreachable!("unexpected owner command")
    }
    fn apply(&self, _: AgentContext, _: ApplyRequest) -> Result<ApplyReceipt, CoreError> {
        unreachable!("unexpected apply")
    }
    fn claim(
        &self,
        _: ValidatedDispatchContext,
        _: ClaimRequest,
    ) -> Result<Option<PreparedAttempt>, CoreError> {
        Err(self.0.clone())
    }
    fn report(
        &self,
        _: AdapterContext,
        _: ariadne_agent_protocol::NormalizedEvent,
    ) -> Result<EventReceipt, CoreError> {
        unreachable!("unexpected report")
    }
}
