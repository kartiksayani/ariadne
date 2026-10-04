use ariadne_cli::bridge;
use ariadne_core::{fake::*, *};
use ariadne_runtime::{control::*, leases::DesktopOwner};
use std::{
    fs,
    io::{Read, Write},
    os::unix::{fs::PermissionsExt, net::UnixListener},
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};
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
        .prefix("ariadne-cli-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
    home
}
fn command() -> Command {
    Command::new(env!("CARGO_BIN_EXE_ariadne"))
}
fn output(args: &[&str], stdin: Option<&[u8]>) -> std::process::Output {
    let mut command = command();
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    if let Some(bytes) = stdin {
        child.stdin.take().unwrap().write_all(bytes).unwrap();
    }
    child.wait_with_output().unwrap()
}
#[test]
fn executable_claim_uses_fixed_private_socket_and_preserves_saved_shared_receipt() {
    let corpus = cases::load(root());
    let case = corpus
        .cases
        .iter()
        .find(|case| case.name == "claim_replay_precedes_new_generation")
        .unwrap();
    let cases::CaseStep::Claim {
        request, response, ..
    } = &case.steps[0]
    else {
        unreachable!()
    };
    let expected = request.clone();
    let response = cases::result(response).unwrap();
    let expected_response = response.clone();
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let path = owner.control_path();
    let listener = UnixListener::bind(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let server = std::thread::spawn(move || {
        let _owner = owner;
        // Both invocations use the same persisted ID, not an implicit new claim.
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut length = [0; 4];
            stream.read_exact(&mut length).unwrap();
            let mut bytes = vec![0; u32::from_be_bytes(length) as usize];
            stream.read_exact(&mut bytes).unwrap();
            let wire: ControlRequest = serde_json::from_slice(&bytes).unwrap();
            wire.validate().unwrap();
            assert_eq!(wire.id, expected.request_id);
            assert_eq!(wire.method, ControlMethod::Claim(expected.clone()));
            let bytes = serde_json::to_vec(
                &serde_json::json!({"v":1,"kind":"response","id":wire.id,"result":response}),
            )
            .unwrap();
            stream
                .write_all(&(bytes.len() as u32).to_be_bytes())
                .unwrap();
            stream.write_all(&bytes).unwrap();
        }
    });
    for _ in 0..2 {
        let child = command()
            .args([
                "bridge",
                "claim",
                "--binding",
                request.binding_id.as_str(),
                "--generation",
                request.generation.as_str(),
                "--request-id",
                request.request_id.as_str(),
            ])
            .env("ARIADNE_HOME", home.path())
            .output()
            .unwrap();
        assert!(child.status.success(), "{:?}", child);
        assert!(child.stderr.is_empty());
        let envelope: ClaimEnvelope = serde_json::from_slice(&child.stdout).unwrap();
        assert_eq!(cases::result(&envelope.0).unwrap(), expected_response);
    }
    server.join().unwrap();
}
#[test]
fn executable_announcement_is_unbound_and_checks_exact_native_identity_ack() {
    use ariadne_runtime::discovery::{LoadedPlugin, ModDescriptor, SessionAnnouncement};
    let r = cases::load(root()).routing;
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let listener = UnixListener::bind(owner.control_path()).unwrap();
    fs::set_permissions(owner.control_path(), fs::Permissions::from_mode(0o600)).unwrap();
    let announcement = SessionAnnouncement {
        adapter_id: "claude_code_mod".into(),
        external_session_id: "original-session".into(),
        cwd: "/project/original".into(),
        host_version: "2.1.287".into(),
        plugin: LoadedPlugin {
            name: "ariadne".into(),
            root: "/installed/0.1.0".into(),
        },
        descriptor: ModDescriptor {
            helper_path: "/Applications/Ariadne/helper".into(),
            app_version: "0.1.0".into(),
            api_version: 1,
        },
        binding_scope: None,
    };
    let expected = announcement.clone();
    let request_id = r.generation.clone();
    let server = std::thread::spawn(move || {
        let _owner = owner;
        for mismatched in [false, true] {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut length = [0; 4];
            stream.read_exact(&mut length).unwrap();
            let mut bytes = vec![0; u32::from_be_bytes(length) as usize];
            stream.read_exact(&mut bytes).unwrap();
            let wire: ControlRequest = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(wire.id, request_id);
            assert_eq!(
                wire.method,
                ControlMethod::SessionAnnouncement(expected.clone())
            );
            assert!(wire.scope().is_none());
            let mut ack = expected.acknowledgement();
            if mismatched {
                ack.external_session_id = "different-session".into();
            }
            let bytes = serde_json::to_vec(
                &serde_json::json!({"v":1,"kind":"response","id":wire.id,"result":ack}),
            )
            .unwrap();
            stream
                .write_all(&(bytes.len() as u32).to_be_bytes())
                .unwrap();
            stream.write_all(&bytes).unwrap();
        }
    });
    for mismatched in [false, true] {
        let mut child = command()
            .args([
                "bridge",
                "announce",
                "--request-id",
                r.generation.as_str(),
                "--json-stdin",
            ])
            .env("ARIADNE_HOME", home.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&announcement).unwrap())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(output.stderr.is_empty());
        if mismatched {
            assert!(!output.status.success());
            assert_eq!(value["error"]["code"], "protocol_conflict");
            assert_eq!(value["error"]["retryable"], false);
        } else {
            assert!(output.status.success());
            assert_eq!(
                value["data"],
                serde_json::to_value(announcement.acknowledgement()).unwrap()
            );
        }
    }
    server.join().unwrap();
}

#[test]
fn announcement_cli_rejects_route_flags_and_untrusted_payload_without_a_socket_call() {
    let r = cases::load(root()).routing;
    for args in [
        vec!["bridge", "announce", "--request-id", r.generation.as_str()],
        vec![
            "bridge",
            "announce",
            "--binding",
            r.binding_id.as_str(),
            "--request-id",
            r.generation.as_str(),
            "--json-stdin",
        ],
        vec![
            "bridge",
            "announce",
            "--generation",
            r.generation.as_str(),
            "--request-id",
            r.generation.as_str(),
            "--json-stdin",
        ],
        vec![
            "bridge",
            "announce",
            "--request-id",
            r.generation.as_str(),
            "--json-stdin",
        ],
    ] {
        let output = output(&args, Some(b"{\"compatibility\":\"compatible\"}"));
        assert!(!output.status.success());
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["error"]["code"], "invalid_argument");
        assert_eq!(value["error"]["retryable"], false);
    }
}
#[test]
fn executable_status_preserves_unknown_host_state_and_explicit_correlation() {
    let r = cases::load(root()).routing;
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let path = owner.control_path();
    let listener = UnixListener::bind(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let status = serde_json::json!({
        "id":r.binding_id,"generation":r.generation,"adapter_id":"claude_code_mod",
        "external_session_id":"original-session","dispatch_state":"recovery_required",
        "owner_paused":false,"pause_reason":null,"connection_state":"unknown","presence":null
    });
    let expected = status.clone();
    let request_id = r.generation.clone();
    let scope = BindingScope {
        binding_id: r.binding_id.clone(),
        generation: r.generation.clone(),
    };
    let server = std::thread::spawn(move || {
        let _owner = owner;
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut length = [0; 4];
        stream.read_exact(&mut length).unwrap();
        let mut bytes = vec![0; u32::from_be_bytes(length) as usize];
        stream.read_exact(&mut bytes).unwrap();
        let request: ControlRequest = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(request.id, request_id);
        assert_eq!(request.method, ControlMethod::ConnectionStatus(scope));
        let bytes = serde_json::to_vec(
            &serde_json::json!({"v":1,"kind":"response","id":request.id,"result":status}),
        )
        .unwrap();
        stream
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .unwrap();
        stream.write_all(&bytes).unwrap();
    });
    let child = command()
        .args([
            "bridge",
            "connection-status",
            "--binding",
            r.binding_id.as_str(),
            "--generation",
            r.generation.as_str(),
            "--request-id",
            r.generation.as_str(),
        ])
        .env("ARIADNE_HOME", home.path())
        .output()
        .unwrap();
    assert!(child.status.success(), "{:?}", child);
    assert!(child.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&child.stdout).unwrap(),
        serde_json::json!({"api_version":1,"ok":true,"data":expected})
    );
    server.join().unwrap();
    for extra in [vec![], vec!["--json-stdin"]] {
        let mut args = vec![
            "bridge",
            "connection-status",
            "--binding",
            r.binding_id.as_str(),
            "--generation",
            r.generation.as_str(),
        ];
        args.extend(extra);
        let result = output(&args, None);
        assert_eq!(result.status.code(), Some(2));
    }
}
#[test]
fn shared_reports_call_injected_core_after_desktop_exit_without_claim_or_socket() {
    let corpus = cases::load(root());
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let listener = UnixListener::bind(owner.control_path()).unwrap();
    drop(listener);
    drop(owner);
    for case in &corpus.cases {
        let steps: Vec<_> = case
            .steps
            .iter()
            .filter_map(|step| {
                if let cases::CaseStep::Report {
                    historical,
                    event,
                    response,
                } = step
                {
                    Some((*historical, event, response))
                } else {
                    None
                }
            })
            .collect();
        let script = steps
            .iter()
            .map(|(historical, event, response)| ScriptStep {
                request: RecordedRequest::Report(
                    corpus.routing.adapter(*historical, event),
                    (*event).clone(),
                ),
                response: ScriptedResponse::Report(cases::result(response)),
            });
        let core = ScriptedCoreService::new(script);
        for (historical, event, response) in steps {
            assert_eq!(
                bridge::report(
                    &core,
                    corpus.routing.adapter(historical, event),
                    *event.clone()
                ),
                cases::result(response),
                "{}",
                case.name
            );
        }
        assert_eq!(core.remaining().unwrap(), 0);
    }
}
#[test]
fn executable_report_is_truthfully_unsupported_and_never_reports_fake_persistence() {
    let corpus = cases::load(root());
    let event = corpus
        .cases
        .iter()
        .flat_map(|case| &case.steps)
        .find_map(|step| {
            if let cases::CaseStep::Report { event, .. } = step {
                Some(event)
            } else {
                None
            }
        })
        .unwrap();
    let bytes = serde_json::to_vec(&event).unwrap();
    let result = output(
        &[
            "bridge",
            "report",
            "--binding",
            event.binding_id.as_str(),
            "--generation",
            event.generation.as_str(),
            "--json-stdin",
        ],
        Some(&bytes),
    );
    assert_eq!(result.status.code(), Some(5));
    assert!(result.stderr.is_empty());
    let envelope: ReportEnvelope = serde_json::from_slice(&result.stdout).unwrap();
    let error = cases::result(&envelope.0).unwrap_err();
    assert_eq!(error.code, CoreErrorCode::Unsupported);
    assert!(!error.retryable);
    assert!(error.message.contains("no lifecycle event was persisted"));
    assert!(error.hint.contains("P2.2"));
}
#[test]
fn executable_bridge_invalid_input_uses_canonical_structured_errors() {
    let r = cases::load(root()).routing;
    for args in [
        vec!["bridge"],
        vec!["bridge", "unknown"],
        vec!["bridge", "claim"],
        vec!["bridge", "claim", "--binding", "bad"],
        vec![
            "bridge",
            "claim",
            "--binding",
            r.binding_id.as_str(),
            "--binding",
            r.binding_id.as_str(),
        ],
        vec![
            "bridge",
            "claim",
            "--binding",
            r.binding_id.as_str(),
            "--generation",
            r.generation.as_str(),
        ],
        vec!["bridge", "claim", "--unexpected", "1"],
        vec![
            "bridge",
            "report",
            "--binding",
            r.binding_id.as_str(),
            "--generation",
            r.generation.as_str(),
            "--json-stdin",
            "--json-stdin",
        ],
    ] {
        let result = output(&args, None);
        assert_eq!(result.status.code(), Some(2));
        assert!(result.stderr.is_empty());
        let envelope: ClaimEnvelope = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(
            cases::result(&envelope.0).unwrap_err().code,
            CoreErrorCode::InvalidArgument
        );
    }
    let mut output = Vec::new();
    let oversized = vec![b' '; MAX_FRAME_BYTES + 1];
    assert_eq!(
        bridge::command::run(
            &[
                "report",
                "--binding",
                r.binding_id.as_str(),
                "--generation",
                r.generation.as_str(),
                "--json-stdin"
            ],
            &mut oversized.as_slice(),
            &mut output
        ),
        2
    );
    let envelope: ReportEnvelope = serde_json::from_slice(&output).unwrap();
    assert!(cases::result(&envelope.0)
        .unwrap_err()
        .message
        .contains("1MiB"));
}
#[test]
fn absent_desktop_and_untrusted_endpoint_never_fall_back_to_direct_claim() {
    let corpus = cases::load(root());
    let r = corpus.routing;
    let request = ClaimRequest {
        binding_id: r.binding_id,
        generation: r.generation,
        request_id: r.source_input_id,
    };
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    fs::write(owner.control_path(), "ordinary file").unwrap();
    assert!(bridge::claim(home.path().to_owned(), request).is_err());
    assert_eq!(fs::read(owner.control_path()).unwrap(), b"ordinary file");
}

fn invalid_errors() -> Vec<(bool, CoreError)> {
    let valid = CoreError::new(
        CoreErrorCode::DeliveryUncertain,
        "The original operation may have effects.",
        "Retain its original identity and reconcile.",
    );
    let mut cases = vec![(true, valid.clone())];
    for change in ["retryable", "message", "hint", "field"] {
        let mut error = valid.clone();
        match change {
            "retryable" => error.retryable = true,
            "message" => error.message.clear(),
            "hint" => error.hint = "private invalid diagnostic".repeat(200),
            _ => error.field_errors.push(FieldError {
                field: " ".into(),
                message: "bad field".into(),
            }),
        }
        assert!(error.validate().is_err());
        cases.push((false, error));
    }
    cases
}
fn assert_checked_error(actual: &CoreError, valid: bool, original: &CoreError) {
    actual.validate().unwrap();
    if valid {
        assert_eq!(actual, original);
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
fn direct_report_validates_core_errors_and_preserves_valid_uncertainty() {
    let corpus = cases::load(root());
    let (historical, event) = corpus
        .cases
        .iter()
        .flat_map(|c| &c.steps)
        .find_map(|step| {
            if let cases::CaseStep::Report {
                historical, event, ..
            } = step
            {
                Some((*historical, event))
            } else {
                None
            }
        })
        .unwrap();
    let context = corpus.routing.adapter(historical, event);
    for (valid, error) in invalid_errors() {
        let core = FaultyErrorCore(error.clone());
        let actual = bridge::report(&core, context.clone(), *event.clone()).unwrap_err();
        assert_checked_error(&actual, valid, &error);
    }
}
#[test]
fn executable_claim_rejects_malformed_peer_errors_with_bounded_canonical_output() {
    let corpus = cases::load(root());
    let r = corpus.routing;
    let home = home();
    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let listener = UnixListener::bind(owner.control_path()).unwrap();
    fs::set_permissions(owner.control_path(), fs::Permissions::from_mode(0o600)).unwrap();
    let errors = invalid_errors();
    let responses = errors.clone();
    let server = std::thread::spawn(move || {
        let _owner = owner;
        for (_, error) in responses {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut prefix = [0; 4];
            stream.read_exact(&mut prefix).unwrap();
            let mut bytes = vec![0; u32::from_be_bytes(prefix) as usize];
            stream.read_exact(&mut bytes).unwrap();
            let request: ControlRequest = serde_json::from_slice(&bytes).unwrap();
            request.validate().unwrap();
            let response = serde_json::to_vec(
                &serde_json::json!({"v":1,"kind":"response","id":request.id,"error":error}),
            )
            .unwrap();
            stream
                .write_all(&(response.len() as u32).to_be_bytes())
                .unwrap();
            stream.write_all(&response).unwrap();
        }
    });
    for (valid, error) in errors {
        let child = command()
            .args([
                "bridge",
                "claim",
                "--binding",
                r.binding_id.as_str(),
                "--generation",
                r.generation.as_str(),
                "--request-id",
                r.source_input_id.as_str(),
            ])
            .env("ARIADNE_HOME", home.path())
            .output()
            .unwrap();
        assert_eq!(child.status.code(), Some(3));
        assert!(child.stderr.is_empty());
        let envelope: ClaimEnvelope = serde_json::from_slice(&child.stdout).unwrap();
        let actual = cases::result(&envelope.0).unwrap_err();
        assert_checked_error(&actual, valid, &error);
        assert!(child.stdout.len() < 4096);
    }
    server.join().unwrap();
}
#[test]
fn cli_output_validates_oversized_local_error_without_exposing_raw_cause() {
    struct BadInput;
    impl Read for BadInput {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other(
                "private invalid diagnostic".repeat(200),
            ))
        }
    }
    let r = cases::load(root()).routing;
    let mut bytes = Vec::new();
    let exit = bridge::command::run(
        &[
            "report",
            "--binding",
            r.binding_id.as_str(),
            "--generation",
            r.generation.as_str(),
            "--json-stdin",
        ],
        &mut BadInput,
        &mut bytes,
    );
    assert_eq!(exit, 3);
    let envelope: ReportEnvelope = serde_json::from_slice(&bytes).unwrap();
    let actual = cases::result(&envelope.0).unwrap_err();
    actual.validate().unwrap();
    assert_eq!(actual.code, CoreErrorCode::ProtocolConflict);
    assert!(!actual.retryable);
    assert!(actual.hint.contains("effects may already exist"));
    assert!(!String::from_utf8(bytes)
        .unwrap()
        .contains("private invalid diagnostic"));
}

struct FaultyErrorCore(CoreError);
impl CoreService for FaultyErrorCore {
    fn query(&self, _: QueryContext, _: QueryRequest) -> Result<QueryResult, CoreError> {
        unreachable!("unexpected query")
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
        unreachable!("unexpected claim")
    }
    fn report(
        &self,
        _: AdapterContext,
        _: ariadne_agent_protocol::NormalizedEvent,
    ) -> Result<EventReceipt, CoreError> {
        Err(self.0.clone())
    }
}
