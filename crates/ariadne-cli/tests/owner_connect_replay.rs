use ariadne_agent_protocol::{Availability, Compatibility};
use ariadne_cli::owner;
use ariadne_core::{
    bindings::{BindingService, VerifiedHost},
    fake::ScriptedCoreService,
    *,
};
use ariadne_domain::models::*;
use ariadne_store::registry::Registry;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}

fn request() -> OwnerMutationRequest {
    let seed: Session =
        serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json")).unwrap();
    let binding = &seed.bindings.0[&id(3)];
    OwnerMutationRequest {
        session: None,
        command: OwnerCommand::BindingConnect {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(91),
            params: BindingConnectParams {
                project_id: id(1),
                adapter_id: binding.adapter_id.clone(),
                external_session_id: "saved-lookup-test-thread".into(),
                endpoint: binding.endpoint.clone(),
                configuration: binding.adapter_config.clone(),
                existing_session_id: None,
            },
        },
    }
}

fn call(data: &Path, request: &OwnerMutationRequest) -> (i32, Value) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_ariadne"))
        .args(["binding", "connect", "--replay-only", "--json-stdin"])
        .env("ARIADNE_HOME", data)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(request).unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.stderr.is_empty(), "{output:?}");
    (
        output.status.code().unwrap(),
        serde_json::from_slice(&output.stdout).unwrap(),
    )
}

fn json_files(data: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut result = BTreeMap::new();
    for entry in fs::read_dir(data).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            result.extend(json_files(&path));
        } else if path
            .extension()
            .is_some_and(|extension| extension == "json")
        {
            result.insert(path.clone(), fs::read(path).unwrap());
        }
    }
    result
}

#[test]
fn missing_saved_connect_without_desktop_returns_null_and_preserves_durable_state() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    registry.register(root.path(), &id(90), || id(1)).unwrap();
    let data = home.path().join(".ariadne");
    let before = json_files(&data);
    assert_eq!(
        call(&data, &request()),
        (0, json!({"api_version": 1, "ok": true, "data": null}))
    );
    assert_eq!(json_files(&data), before);
}

#[test]
fn missing_saved_connect_returns_null_without_contacting_desktop_or_mutating_state() {
    use std::os::unix::{fs::PermissionsExt, net::UnixListener};

    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    registry.register(root.path(), &id(90), || id(1)).unwrap();
    let data = home.path().join(".ariadne");
    // A reachable private control socket would receive any accidental fresh
    // connect relay. Replay-only must finish without sending it a request.
    let desktop = ariadne_runtime::leases::DesktopOwner::acquire(&data).unwrap();
    let listener = UnixListener::bind(desktop.control_path()).unwrap();
    fs::set_permissions(desktop.control_path(), fs::Permissions::from_mode(0o600)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let before = json_files(&data);
    assert_eq!(
        call(&data, &request()),
        (0, json!({"api_version": 1, "ok": true, "data": null}))
    );
    assert_eq!(json_files(&data), before);
    assert!(
        matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
    );
}

#[test]
fn saved_connect_lookup_returns_exact_receipt_and_rejects_changed_selected_route() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    registry.register(root.path(), &id(90), || id(1)).unwrap();
    let request = request();
    let seed: Session =
        serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json")).unwrap();
    let binding = &seed.bindings.0[&id(3)];
    let mut next = 100;
    let receipt = BindingService::new(&registry)
        .connect(
            &OwnerContext::from_trusted_entrypoint(OwnerScope::Registry),
            &request.command,
            |params| {
                Ok(VerifiedHost {
                    adapter_id: params.adapter_id.clone(),
                    adapter_version: binding.adapter_version.clone(),
                    protocol_major: binding.protocol_major,
                    config_version: binding.config_version,
                    external_session_id: params.external_session_id.clone(),
                    endpoint: params.endpoint.clone(),
                    endpoint_fingerprint: binding.endpoint_fingerprint.clone(),
                    configuration: params.configuration.clone(),
                    capabilities: binding.capabilities.clone(),
                    compatibility: Compatibility::Compatible,
                    availability: Availability::Available,
                    connection_state: ConnectionState::Connected,
                    cli_invocation: "ariadne".into(),
                    host_location: None,
                    setup_instruction: "Saved lookup fixture; no live provider.".into(),
                })
            },
            || {
                next += 1;
                id(next)
            },
            UtcMillis::new("2026-10-04T00:00:00.000Z").unwrap(),
        )
        .unwrap();
    let MutationReceipt::Session(saved) = &receipt else {
        panic!("connect receipt")
    };
    let data = home.path().join(".ariadne");
    let session = registry
        .project_dir(&id(1))
        .join(format!("sessions/{}.json", saved.session_id.as_str()));
    let before = fs::read(&session).unwrap();
    assert_eq!(
        call(&data, &request),
        (0, json!({"api_version": 1, "ok": true, "data": receipt}))
    );
    assert_eq!(fs::read(&session).unwrap(), before);
    let mut conflicting = request.clone();
    let OwnerCommand::BindingConnect { params, .. } = &mut conflicting.command else {
        unreachable!()
    };
    params.existing_session_id = Some(saved.session_id.clone());
    let (exit, error) = call(&data, &conflicting);
    assert_eq!(exit, 3, "{error}");
    assert_eq!(error["error"]["code"], "operation_reused");
    assert_eq!(fs::read(session).unwrap(), before);
}

#[test]
fn replay_only_does_not_initialize_missing_data_directory() {
    let home = tempfile::tempdir().unwrap();
    let data = home.path().join("missing-data");
    assert_eq!(call(&data, &request()).0, 4);
    assert!(!data.exists());
}

#[test]
fn replay_flag_usage_and_canonical_validation_reject_before_core_calls() {
    let core = ScriptedCoreService::new([]);
    let request = serde_json::to_value(request()).unwrap();
    let mut routed = request.clone();
    routed["session"] = json!({"project_id": id(1), "session_id": id(2)});
    let mut unknown = request.clone();
    unknown["command"]["params"]["unrecognized"] = json!(true);
    let mut mismatch = request.clone();
    mismatch["command"] = json!({"command":"project_register","api_version":1,
        "op_id":id(91),"params":{"canonical_root":"/absolute/test-root"}});
    for (args, request) in [
        (
            vec!["binding", "connect", "--replay-only", "--json"],
            &request,
        ),
        (
            vec!["binding", "pause", "--replay-only", "--json-stdin"],
            &request,
        ),
        (
            vec!["project", "list", "--replay-only", "--json-stdin"],
            &request,
        ),
        (
            vec![
                "binding",
                "connect",
                "--replay-only",
                "--replay-only",
                "--json-stdin",
            ],
            &request,
        ),
        (
            vec!["binding", "connect", "--replay-only", "--json-stdin"],
            &routed,
        ),
        (
            vec!["binding", "connect", "--replay-only", "--json-stdin"],
            &unknown,
        ),
        (
            vec!["binding", "connect", "--replay-only", "--json-stdin"],
            &mismatch,
        ),
    ] {
        let bytes = serde_json::to_vec(request).unwrap();
        let mut output = vec![];
        let mut errors = vec![];
        let exit = owner::run_with(
            &core,
            &|_| panic!("replay-only must not resolve a session"),
            &args,
            &mut bytes.as_slice(),
            &mut output,
            &mut errors,
        );
        assert_eq!(exit, 2, "{args:?}: {output:?}");
        let error: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(error["error"]["code"], "invalid_argument");
        assert!(errors.is_empty());
    }
    assert!(core.history().unwrap().is_empty());
}

#[test]
fn replay_only_fake_core_seam_reports_unsupported_without_mutating() {
    let core = ScriptedCoreService::new([]);
    let bytes = serde_json::to_vec(&request()).unwrap();
    let mut output = vec![];
    let mut errors = vec![];
    let exit = owner::run_with(
        &core,
        &|_| panic!("replay-only must not resolve a session"),
        &["binding", "connect", "--json-stdin", "--replay-only"],
        &mut bytes.as_slice(),
        &mut output,
        &mut errors,
    );
    assert_eq!(exit, 5);
    let error: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(error["error"]["code"], "unsupported");
    assert!(errors.is_empty());
    assert!(core.history().unwrap().is_empty());
}
