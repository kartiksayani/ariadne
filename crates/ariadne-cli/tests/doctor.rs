use ariadne_cli::{
    doctor::inspect::{self, Options},
    setup::owned,
};
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::StoreError, OwnedDirectory};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{symlink, PermissionsExt},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012}")).unwrap()
}
fn checks(report: &Value, code: &str) -> Vec<Value> {
    report["checks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["code"] == code)
        .cloned()
        .collect()
}
fn snapshot(root: &Path) -> BTreeMap<PathBuf, (u32, Vec<u8>)> {
    fn visit(root: &Path, out: &mut BTreeMap<PathBuf, (u32, Vec<u8>)>) {
        for entry in fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            let meta = fs::symlink_metadata(&path).unwrap();
            if meta.is_dir() {
                out.insert(path.clone(), (meta.permissions().mode(), vec![]));
                visit(&path, out);
            } else if meta.is_file() {
                out.insert(
                    path.clone(),
                    (meta.permissions().mode(), fs::read(&path).unwrap()),
                );
            } else {
                out.insert(path.clone(), (meta.permissions().mode(), vec![]));
            }
        }
    }
    let mut result = BTreeMap::new();
    visit(root, &mut result);
    result
}
struct Profile {
    home: tempfile::TempDir,
    project: tempfile::TempDir,
    data: PathBuf,
    version: PathBuf,
}
impl Profile {
    fn new() -> Self {
        let home = tempfile::Builder::new()
            .prefix("ariadne-doctor-")
            .tempdir_in("/tmp")
            .unwrap();
        let project = tempfile::tempdir().unwrap();
        let data = home.path().join(".ariadne");
        let registry = Registry::create_data_directory(&data).unwrap();
        ariadne_cli::demo::prepare(project.path())
            .unwrap()
            .publish(&registry, &id(900))
            .unwrap();
        let version = home.path().join("0.1.0");
        fs::create_dir(&version).unwrap();
        fs::set_permissions(&version, fs::Permissions::from_mode(0o700)).unwrap();
        owned::apply(&version, "both", false).unwrap();
        Self {
            home,
            project,
            data,
            version,
        }
    }
    fn report(&self) -> Value {
        inspect::collect(&self.data, Some(&self.version), &Options::default())
    }
    fn live(&self) -> PathBuf {
        self.project
            .path()
            .join(".ariadne/sessions/00000000-0000-4000-8000-000000000002.json")
    }
}

#[test]
fn canonical_doctor_is_strictly_read_only_and_omits_session_bodies() {
    let profile = Profile::new();
    let before = snapshot(profile.home.path());
    let project_before = snapshot(profile.project.path());
    let report = profile.report();
    assert_eq!(
        checks(&report, "installation.resource_parity")[0]["status"],
        "ok"
    );
    assert_eq!(checks(&report, "registry.valid")[0]["status"], "ok");
    assert_eq!(checks(&report, "session.valid")[0]["status"], "ok");
    assert_eq!(
        checks(&report, "backup.health")[0]["facts"]["previous_snapshot_present"],
        false
    );
    assert!(!checks(&report, "binding.recovery").is_empty());
    let recovery = checks(&report, "binding.recovery");
    let hint = recovery[0]["hint"].as_str().unwrap();
    assert!(hint.contains("Review recovery") && !hint.contains("ariadne recovery"));
    assert_eq!(recovery[0]["facts"]["queued"], 2);
    assert_eq!(recovery[0]["facts"]["claimed"], 1);
    assert_eq!(recovery[0]["facts"]["missing_result"], 1);
    assert_eq!(recovery[0]["facts"]["unresolved"], 2);
    assert_eq!(recovery[1]["facts"]["uncertain"], 1);
    assert!(recovery[1]["hint"]
        .as_str()
        .unwrap()
        .contains("Review recovery"));
    for check in report["checks"].as_array().unwrap() {
        assert!(["ok", "warning", "error"].contains(&check["status"].as_str().unwrap()));
        assert!(!check["code"].as_str().unwrap().is_empty());
        assert!(!check["hint"].as_str().unwrap().is_empty());
        UtcMillis::new(check["checked_at"].as_str().unwrap()).unwrap();
    }
    let text = serde_json::to_string(&report).unwrap();
    let session: Session = serde_json::from_slice(&fs::read(profile.live()).unwrap()).unwrap();
    for message in &session.messages {
        if message.body.len() > 20 {
            assert!(!text.contains(&message.body));
        }
    }
    assert!(!text.contains("formatted_payload"));
    assert!(!text.contains("adapter_config"));
    assert_eq!(snapshot(profile.home.path()), before);
    assert_eq!(snapshot(profile.project.path()), project_before);
}

#[test]
fn missing_session_and_registry_coordination_never_get_created() {
    let profile = Profile::new();
    let locks = profile.project.path().join(".ariadne/locks");
    fs::remove_dir_all(&locks).unwrap();
    let before = snapshot(profile.project.path());
    let report = profile.report();
    assert_eq!(
        checks(&report, "session_catalogue.missing_coordination_or_data")[0]["status"],
        "warning"
    );
    assert_eq!(
        checks(&report, "registry.binding_index")[0]["facts"]["state"],
        "unknown"
    );
    assert!(!locks.exists());
    assert_eq!(snapshot(profile.project.path()), before);
    fs::remove_file(profile.data.join("registry.lock")).unwrap();
    let before = snapshot(profile.home.path());
    assert_eq!(
        checks(&profile.report(), "registry.unavailable")[0]["facts"]["cause"],
        "missing_coordination_or_data"
    );
    assert!(!profile.data.join("registry.lock").exists());
    assert_eq!(snapshot(profile.home.path()), before);
    let absent = profile.home.path().join("absent");
    let fresh = inspect::collect(&absent, None, &Options::default());
    assert!(!absent.exists());
    // A brand-new install with no data directory is healthy, not a registry fault.
    let empty = checks(&fresh, "registry.empty");
    assert_eq!(empty[0]["status"], "ok");
    assert_eq!(
        empty[0]["message"],
        "No sessions yet. Connect a session to get started."
    );
    assert!(checks(&fresh, "registry.unavailable").is_empty());
}

#[test]
fn future_malformed_and_symlinked_data_remain_untouched_with_stable_errors() {
    for (bytes, code) in [
        (
            b"{\"schema_version\":2}".as_slice(),
            "session.future_schema",
        ),
        (b"malformed".as_slice(), "session.invalid_snapshot"),
    ] {
        let profile = Profile::new();
        fs::write(profile.live(), bytes).unwrap();
        let before = snapshot(profile.project.path());
        let report = profile.report();
        assert_eq!(checks(&report, code)[0]["status"], "error");
        assert_eq!(snapshot(profile.project.path()), before);
    }
    let profile = Profile::new();
    let live = profile.live();
    let bytes = fs::read(&live).unwrap();
    fs::remove_file(&live).unwrap();
    let foreign = profile.project.path().join("foreign");
    fs::write(&foreign, &bytes).unwrap();
    symlink(&foreign, &live).unwrap();
    assert_eq!(
        checks(&profile.report(), "session.unsafe_path_or_permissions")[0]["status"],
        "error"
    );
    assert!(fs::symlink_metadata(live).unwrap().file_type().is_symlink());
    assert_eq!(fs::read(foreign).unwrap(), bytes);
}

#[test]
fn index_states_compare_only_complete_authoritative_observations_without_rebuild() {
    let profile = Profile::new();
    let registry = Registry::open_data_directory(&profile.data).unwrap();
    assert_eq!(
        checks(&profile.report(), "registry.binding_index")[0]["facts"]["state"],
        "missing"
    );
    registry.rebuild().unwrap();
    let before = fs::read(profile.data.join("bindings.json")).unwrap();
    assert_eq!(
        checks(&profile.report(), "registry.binding_index")[0]["facts"]["state"],
        "matching"
    );
    assert_eq!(
        fs::read(profile.data.join("bindings.json")).unwrap(),
        before
    );
    fs::write(
        profile.data.join("bindings.json"),
        b"{\"schema_version\":1,\"bindings\":[]}",
    )
    .unwrap();
    let stale = fs::read(profile.data.join("bindings.json")).unwrap();
    assert_eq!(
        checks(&profile.report(), "registry.binding_index")[0]["facts"]["state"],
        "stale"
    );
    assert_eq!(fs::read(profile.data.join("bindings.json")).unwrap(), stale);
    fs::write(
        profile.data.join("bindings.json"),
        b"{\"schema_version\":2}",
    )
    .unwrap();
    assert_eq!(
        checks(&profile.report(), "registry.binding_index")[0]["facts"]["state"],
        "unknown"
    );
    assert_eq!(
        fs::read(profile.data.join("bindings.json")).unwrap(),
        b"{\"schema_version\":2}"
    );
}

#[test]
fn previous_snapshot_health_reuses_canonical_validation_without_restore() {
    let profile = Profile::new();
    let backup = profile
        .project
        .path()
        .join(".ariadne/backups/00000000-0000-4000-8000-000000000002.previous.json");
    fs::copy(profile.live(), &backup).unwrap();
    fs::set_permissions(&backup, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        checks(&profile.report(), "backup.health")[0]["facts"]["previous_snapshot_present"],
        true
    );
    let live = fs::read(profile.live()).unwrap();
    fs::write(&backup, b"{\"schema_version\":2}").unwrap();
    assert_eq!(
        checks(&profile.report(), "backup.future_schema")[0]["status"],
        "error"
    );
    assert_eq!(fs::read(profile.live()).unwrap(), live);
}

fn executable(path: &Path, output: &str) {
    fs::write(path,format!("#!/bin/sh\n[ \"$#\" = 1 ] && [ \"$1\" = --version ] || exit 7\nprintf '%s\\n' '{output}'\n")).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

fn accept_fixture(listener: &std::os::unix::net::UnixListener) -> std::os::unix::net::UnixStream {
    listener.set_nonblocking(true).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false).unwrap();
                return stream;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline, "fixture accept timed out");
                std::thread::sleep(Duration::from_millis(2));
            }
            Err(error) => panic!("fixture accept: {error}"),
        }
    }
}

#[test]
fn explicit_versions_are_sanitized_and_unsupported_never_qualifies_a_host() {
    let profile = Profile::new();
    let claude = profile.home.path().join("claude");
    let codex = profile.home.path().join("codex");
    executable(&claude, "2.1.289 (Claude Code)");
    executable(&codex, "codex-cli 0.161.0");
    let options = Options {
        claude_bin: Some(claude.clone()),
        codex_bin: Some(codex.clone()),
        ..Options::default()
    };
    let report = inspect::collect(&profile.data, Some(&profile.version), &options);
    assert_eq!(
        checks(&report, "claude.version")[0]["facts"]["detected_version"],
        "2.1.289"
    );
    assert_eq!(
        checks(&report, "codex.version")[0]["facts"]["detected_version"],
        "0.161.0"
    );
    assert_eq!(checks(&report, "claude.version")[0]["status"], "warning");
    assert!(checks(&report, "codex.daemon").is_empty());
    executable(&claude, "secret-body malformed");
    executable(&codex, "secret-body malformed");
    let report = inspect::collect(&profile.data, None, &options);
    let text = serde_json::to_string(&report).unwrap();
    assert!(!text.contains("secret-body"));
    assert!(!checks(&report, "claude.version_unknown").is_empty());
    assert!(!checks(&report, "codex.version_unknown").is_empty());
}

#[test]
fn bounded_filesystem_surface_rejects_descendant_escape_and_keeps_changed_files() {
    let profile = tempfile::tempdir().unwrap();
    let dir = OwnedDirectory::root(profile.path()).unwrap();
    for name in ["", ".", "..", "a/b", "a\\b", "a\0b"] {
        assert!(dir.child(name, true).is_err());
        assert!(dir.read_bounded(name, 4).is_err());
        assert!(dir.temp(name, b"x").is_err());
    }
    dir.temp("owned", b"expected")
        .unwrap()
        .create("owned")
        .unwrap();
    assert!(dir.read_bounded("owned", 4).is_err());
    assert_eq!(dir.read_bounded("owned", 8).unwrap(), b"expected");
    assert!(!dir.remove_if_unchanged("owned", b"different").unwrap());
    assert!(dir.remove_if_unchanged("owned", b"expected").unwrap());
    assert!(dir
        .with_lock::<_, StoreError>("missing.lock", false, || Ok(()))
        .is_err());
    assert!(!profile.path().join("missing.lock").exists());
    let before = snapshot(profile.path());
    assert!(dir.temp("safe", b"x").unwrap().create("../escape").is_err());
    assert_eq!(snapshot(profile.path()), before);
}

#[test]
fn public_provider_reads_preserve_deadlines_and_strict_parsing() {
    let root = tempfile::tempdir().unwrap();
    let claude = root.path().join("claude");
    let codex = root.path().join("codex");
    executable(&claude, "2.1.287 (Claude Code)");
    executable(&codex, "codex-cli 0.160.0");
    let options = ariadne_adapter_claude::ClaudeOptions {
        executable: claude.clone(),
        installed_plugin: root.path().into(),
        helper: root.path().into(),
        project_root: root.path().into(),
        app_version: "0.1.0".into(),
    };
    let codex_options =
        ariadne_adapter_codex::CodexOptions::new(codex.clone(), root.path().into()).unwrap();
    assert_eq!(
        options
            .read_host_version(Instant::now() + Duration::from_secs(5))
            .unwrap(),
        "2.1.287"
    );
    assert_eq!(
        codex_options
            .read_host_version(Instant::now() + Duration::from_secs(5))
            .unwrap(),
        "0.160.0"
    );
    let expired = Instant::now() - Duration::from_millis(1);
    assert!(options.read_host_version(expired).is_err());
    assert!(codex_options.read_host_version(expired).is_err());
    executable(&codex, "codex-cli 0.160.0 extra");
    assert!(codex_options
        .read_host_version(Instant::now() + Duration::from_secs(5))
        .is_err());
}

#[test]
fn version_readers_reject_changed_executable_identity_and_reap_only_their_bounded_child() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("provider");
    let claude = ariadne_adapter_claude::ClaudeOptions {
        executable: path.clone(),
        installed_plugin: root.path().into(),
        helper: root.path().into(),
        project_root: root.path().into(),
        app_version: "0.1.0".into(),
    };
    let codex = ariadne_adapter_codex::CodexOptions::new(path.clone(), root.path().into()).unwrap();
    for output in ["2.1.287 (Claude Code)", "codex-cli 0.160.0"] {
        let replacement = root.path().join("replacement");
        executable(&replacement, output);
        fs::write(
            &path,
            format!(
                "#!/bin/sh\n/bin/mv '{}' '{}'\nprintf '%s\\n' '{output}'\n",
                replacement.display(),
                path.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let result = if output.contains("Claude") {
            claude.read_host_version(Instant::now() + Duration::from_secs(5))
        } else {
            codex.read_host_version(Instant::now() + Duration::from_secs(5))
        };
        assert!(result.is_err());
    }
    fs::write(&path, "#!/bin/sh\nwhile :; do :; done\n").unwrap();
    let start = Instant::now();
    assert!(claude
        .read_host_version(Instant::now() + Duration::from_millis(30))
        .is_err());
    assert!(start.elapsed() < Duration::from_secs(1));
    let start = Instant::now();
    assert!(codex
        .read_host_version(Instant::now() + Duration::from_millis(30))
        .is_err());
    assert!(start.elapsed() < Duration::from_secs(1));
}

#[test]
fn busy_existing_lock_is_bounded_and_does_not_publish_an_unlocked_catalogue() {
    let profile = Profile::new();
    let path = profile.data.clone();
    let (entered, entry) = std::sync::mpsc::channel();
    let (release, leave) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        OwnedDirectory::root(&path)
            .unwrap()
            .with_lock::<_, StoreError>("registry.lock", false, || {
                entered.send(()).unwrap();
                leave.recv_timeout(Duration::from_secs(6)).unwrap();
                Ok(())
            })
            .unwrap();
    });
    entry.recv_timeout(Duration::from_secs(1)).unwrap();
    let before = snapshot(profile.home.path());
    let start = Instant::now();
    let report = profile.report();
    release.send(()).unwrap();
    holder.join().unwrap();
    assert!(start.elapsed() < Duration::from_secs(4));
    assert_eq!(
        checks(&report, "registry.unavailable")[0]["facts"]["cause"],
        "coordination_busy"
    );
    assert!(checks(&report, "registry.valid").is_empty());
    assert_eq!(snapshot(profile.home.path()), before);
}

#[test]
fn control_status_is_read_only_generation_scoped_and_reports_fresh_and_stale() {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixListener;
    let profile = Profile::new();
    let mut session: Session = serde_json::from_slice(&fs::read(profile.live()).unwrap()).unwrap();
    session.bindings.0.get_mut(&id(20)).unwrap().adapter_id = "claude_code_mod".into();
    let bytes = serde_json::to_vec(&session).unwrap();
    ariadne_store::session::Store::decode_diagnostic_snapshot(
        &bytes,
        &session.id,
        &session.project_id,
    )
    .unwrap();
    fs::write(profile.live(), bytes).unwrap();
    let run = profile.data.join("run");
    fs::create_dir(&run).unwrap();
    fs::set_permissions(&run, fs::Permissions::from_mode(0o700)).unwrap();
    let socket = run.join("control.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
    let before = snapshot(profile.project.path());
    let server = std::thread::spawn(move || {
        for (n, freshness) in [(20, Freshness::Fresh), (21, Freshness::Stale)] {
            let mut stream = accept_fixture(&listener);
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut length = [0; 4];
            stream.read_exact(&mut length).unwrap();
            let mut request = vec![0; u32::from_be_bytes(length) as usize];
            stream.read_exact(&mut request).unwrap();
            let request: Value = serde_json::from_slice(&request).unwrap();
            assert_eq!(request["method"], "connection_status");
            assert_eq!(request["params"]["binding_id"], id(n).as_str());
            let binding = &session.bindings.0[&id(n)];
            assert_eq!(request["params"]["generation"], binding.generation.as_str());
            let status = BindingSummary {
                id: binding.id.clone(),
                adapter_id: binding.adapter_id.clone(),
                external_session_id: binding.external_session_id.clone(),
                generation: binding.generation.clone(),
                dispatch_state: binding.dispatch_state.clone(),
                owner_paused: binding.owner_paused,
                pause_reason: binding.pause_reason.clone(),
                connection_state: ConnectionState::Connected,
                presence: Some(PresenceObservation {
                    instance_id: id(901),
                    generation: binding.generation.clone(),
                    connection_state: ConnectionState::Connected,
                    execution_state: ExecutionState::Unknown,
                    last_seen_at: Some(UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()),
                    source: Some(PresenceSource::BridgeHeartbeat),
                    process_identity: None,
                    freshness,
                }),
            };
            let response = serde_json::to_vec(
                &serde_json::json!({"v":1,"kind":"response","id":request["id"],"result":status}),
            )
            .unwrap();
            stream
                .write_all(&(response.len() as u32).to_be_bytes())
                .unwrap();
            stream.write_all(&response).unwrap();
        }
    });
    let report = profile.report();
    server.join().unwrap();
    let presence = checks(&report, "binding.presence");
    assert_eq!(presence[0]["status"], "ok");
    assert_eq!(presence[1]["status"], "warning");
    assert_eq!(
        checks(&report, "claude.loaded_gate")[0]["facts"]["adapter_gate"],
        "native_qualified_fresh"
    );
    assert_eq!(snapshot(profile.project.path()), before);
}

#[test]
fn explicit_project_filter_handles_unregistered_and_unavailable_roots() {
    let profile = Profile::new();
    let foreign = tempfile::tempdir().unwrap();
    let mut options = Options {
        project: Some(foreign.path().into()),
        ..Options::default()
    };
    let report = inspect::collect(&profile.data, None, &options);
    assert_eq!(
        checks(&report, "project.unregistered")[0]["status"],
        "error"
    );
    assert!(checks(&report, "session.valid").is_empty());
    options.project = Some(profile.home.path().join("unavailable"));
    let report = inspect::collect(&profile.data, None, &options);
    assert_eq!(checks(&report, "project.unavailable")[0]["status"], "error");
    options.project = Some(profile.project.path().into());
    let report = inspect::collect(&profile.data, None, &options);
    assert_eq!(checks(&report, "project.identity")[0]["status"], "ok");
}

#[test]
fn doctor_flags_output_and_error_exit_are_stable_without_root_creation() {
    let profile = tempfile::tempdir().unwrap();
    let absent = profile.path().join("absent");
    for args in [
        vec!["--project", "relative", "--json"],
        vec!["--claude-bin", "relative", "--json"],
        vec![
            "--codex-bin",
            "/bin/tool",
            "--codex-bin",
            "/bin/tool",
            "--json",
        ],
        vec!["--json", "--json"],
        vec!["--unknown", "--json"],
    ] {
        let mut output = Vec::new();
        let mut errors = Vec::new();
        let code = ariadne_cli::doctor::run_in_installation(
            &args,
            &absent,
            None,
            &mut output,
            &mut errors,
        );
        assert_eq!(code, 2);
        let envelope: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(envelope["error"]["code"], "invalid_argument");
        assert!(!absent.exists());
    }
    let actual = Profile::new();
    fs::write(actual.live(), b"{\"schema_version\":2}").unwrap();
    let mut output = Vec::new();
    let mut errors = Vec::new();
    assert_eq!(
        ariadne_cli::doctor::run_in_installation(
            &["--json"],
            &actual.data,
            Some(&actual.version),
            &mut output,
            &mut errors
        ),
        4
    );
    let envelope: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["data"]["status"], "error");
    assert!(errors.is_empty());
    let mut output = Vec::new();
    assert_eq!(
        ariadne_cli::doctor::run_in_installation(
            &["--help"],
            &absent,
            None,
            &mut output,
            &mut errors
        ),
        0
    );
    assert!(String::from_utf8(output).unwrap().contains("--claude-bin"));
    let mut output = Vec::new();
    assert_eq!(
        ariadne_cli::doctor::run_in_installation(&[], &actual.data, None, &mut output, &mut errors),
        4
    );
    assert!(String::from_utf8(output)
        .unwrap()
        .contains("session.future_schema"));
}

#[test]
fn executable_doctor_qualifies_only_the_existing_codex_daemon_and_exact_thread() {
    use std::os::unix::net::UnixListener;
    let profile = Profile::new();
    let executable_path = profile.home.path().join("codex");
    executable(&executable_path, "codex-cli 0.160.0");
    let codex_home = profile.home.path().join("codex-home");
    let endpoint = codex_home.join("app-server-control/app-server-control.sock");
    fs::create_dir_all(endpoint.parent().unwrap()).unwrap();
    let listener = UnixListener::bind(&endpoint).unwrap();
    fs::set_permissions(&endpoint, fs::Permissions::from_mode(0o600)).unwrap();
    let mut session: Session = serde_json::from_slice(&fs::read(profile.live()).unwrap()).unwrap();
    let binding = session.bindings.0.get_mut(&id(20)).unwrap();
    binding.adapter_id = "codex".into();
    binding.adapter_config.namespace = "codex".into();
    binding.endpoint = EndpointRef::UnixSocket {
        path: endpoint.to_str().unwrap().into(),
    };
    let thread = binding.external_session_id.clone();
    let bytes = serde_json::to_vec(&session).unwrap();
    ariadne_store::session::Store::decode_diagnostic_snapshot(
        &bytes,
        &session.id,
        &session.project_id,
    )
    .unwrap();
    fs::write(profile.live(), bytes).unwrap();
    let project = profile.project.path().canonicalize().unwrap();
    let before = snapshot(profile.project.path());
    let home_before = snapshot(profile.home.path());
    let server = std::thread::spawn(move || {
        let fixture = |name: &str| -> Value {
            serde_json::from_slice(
                &fs::read(
                    Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../../contracts/providers/codex/0.160.0/fixtures")
                        .join(name),
                )
                .unwrap(),
            )
            .unwrap()
        };
        let mut calls = Vec::new();
        for _ in 0..2 {
            let stream = accept_fixture(&listener);
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut socket = tungstenite::accept(stream).unwrap();
            while let Ok(tungstenite::Message::Text(text)) = socket.read() {
                let request: Value = serde_json::from_str(text.as_str()).unwrap();
                let method = request["method"].as_str().unwrap();
                calls.push(method.to_owned());
                let result = match method {
                    "initialized" => continue,
                    "initialize" => fixture("initialize-response.json"),
                    "thread/read" => {
                        assert_eq!(request["params"]["threadId"], thread);
                        let mut result = fixture("read-response.json");
                        result["thread"]["id"] = thread.clone().into();
                        result["thread"]["cwd"] = serde_json::json!(project);
                        result
                    }
                    "thread/queue/list" => fixture("queue-response.json"),
                    "thread/turns/list" => fixture("turns-response.json"),
                    forbidden => panic!("doctor called forbidden provider API: {forbidden}"),
                };
                socket
                    .send(tungstenite::Message::Text(
                        serde_json::json!({"id":request["id"],"result":result})
                            .to_string()
                            .into(),
                    ))
                    .unwrap();
            }
        }
        calls
    });
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_ariadne"))
        .args([
            "doctor",
            "--project",
            profile.project.path().to_str().unwrap(),
            "--codex-bin",
            executable_path.to_str().unwrap(),
            "--json",
        ])
        .env("HOME", profile.home.path())
        .env("ARIADNE_HOME", &profile.data)
        .env("CODEX_HOME", &codex_home)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
    let report = &envelope["data"];
    assert_eq!(checks(report, "codex.selected_thread")[0]["status"], "ok");
    assert_eq!(checks(report, "codex.daemon")[0]["status"], "ok");
    assert_eq!(
        checks(report, "codex.selected_thread")[0]["facts"]["dispatch_ready"],
        false
    );
    assert_eq!(
        server.join().unwrap(),
        [
            "initialize",
            "initialized",
            "thread/read",
            "thread/queue/list",
            "thread/turns/list",
            "initialize",
            "initialized"
        ]
    );
    assert_eq!(snapshot(profile.project.path()), before);
    assert_eq!(snapshot(profile.home.path()), home_before);
    assert!(!String::from_utf8(output.stdout)
        .unwrap()
        .contains("Codex queue communication test"));
}
