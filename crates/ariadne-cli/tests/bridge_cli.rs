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
