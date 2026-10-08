use ariadne_adapter_claude::read_cli_version;
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
        ariadne_cli::demo::prepare(project.path(), &data)
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
    fn store(&self) -> PathBuf {
        self.data.join("projects").join(id(1).as_str())
    }
    fn live(&self) -> PathBuf {
        self.store()
            .join("sessions/00000000-0000-4000-8000-000000000002.json")
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
    let locks = profile.store().join("locks");
    fs::remove_dir_all(&locks).unwrap();
    let before = snapshot(profile.home.path());
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
    assert_eq!(snapshot(profile.home.path()), before);
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
        .store()
        .join("backups/00000000-0000-4000-8000-000000000002.previous.json");
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

fn record(profile: &Profile, codex: &Path) {
    use ariadne_cli::setup::providers::{write, CodexEntry, ProviderUpdate};
    write(
        &profile.data,
        ProviderUpdate {
            codex: Some(CodexEntry {
                executable: codex.into(),
                home: profile.home.path().join(".codex"),
            }),
        },
    )
    .unwrap();
}

#[test]
fn doctor_accepts_a_missing_codex_record_and_stays_read_only() {
    let profile = Profile::new();
    let before = snapshot(profile.home.path());
    let report = profile.report();
    let check = &checks(&report, "providers.config")[0];
    assert_eq!(check["status"], "ok");
    assert_eq!(check["facts"]["state"], "missing");
    assert!(check["hint"]
        .as_str()
        .unwrap()
        .contains("Run `ariadne setup --agent codex` (or both) so the app can find Codex."));
    assert_eq!(snapshot(profile.home.path()), before);
}

#[test]
fn doctor_uses_the_recorded_codex_path_and_flags_override_it() {
    let profile = Profile::new();
    let codex = profile.home.path().join("codex");
    executable(&codex, "codex-cli 0.159.0");
    record(&profile, &codex);
    let before = snapshot(profile.home.path());
    let report = profile.report();
    let check = &checks(&report, "providers.config")[0];
    assert_eq!(check["status"], "ok");
    assert_eq!(check["facts"]["configured"]["codex"], true);
    assert_eq!(check["facts"]["codex"]["exists"], true);
    assert_eq!(
        checks(&report, "codex.version")[0]["facts"]["detected_version"],
        "0.159.0"
    );
    assert_eq!(snapshot(profile.home.path()), before);
    let other = profile.home.path().join("other-codex");
    executable(&other, "codex-cli 0.160.0");
    let report = inspect::collect(
        &profile.data,
        Some(&profile.version),
        &Options {
            codex_bin: Some(other),
            ..Options::default()
        },
    );
    assert_eq!(
        checks(&report, "codex.version")[0]["facts"]["detected_version"],
        "0.160.0"
    );
}

#[test]
fn doctor_reports_a_moved_recorded_codex_and_an_unsafe_providers_file() {
    let profile = Profile::new();
    let codex = profile.home.path().join("moved-codex");
    record(&profile, &codex);
    let report = profile.report();
    let check = &checks(&report, "providers.config")[0];
    assert_eq!(check["status"], "warning");
    assert_eq!(check["facts"]["codex"]["exists"], false);
    let file = profile.data.join("providers.json");
    fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
    let report = profile.report();
    let check = &checks(&report, "providers.config")[0];
    assert_eq!(check["status"], "warning");
    assert_eq!(check["facts"]["state"], "invalid");
    assert!(!checks(&report, "codex.version_unknown").is_empty());
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
    executable(&codex, "codex-cli 0.159.0");
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
        "0.159.0"
    );
    assert_eq!(checks(&report, "claude.version")[0]["status"], "warning");
    assert_eq!(
        checks(&report, "claude.version")[0]["facts"]["host_version_status"],
        "untested"
    );
    assert_eq!(
        checks(&report, "claude.version")[0]["message"],
        "Claude Code 2.1.289 is newer than the tested 2.1.287; it should work, but has not been verified."
    );
    assert_eq!(
        checks(&report, "codex.version")[0]["facts"]["host_version_status"],
        "unsupported"
    );
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
    let codex_options =
        ariadne_adapter_codex::CodexOptions::new(codex.clone(), root.path().into()).unwrap();
    assert_eq!(
        read_cli_version(&claude, Instant::now() + Duration::from_secs(5)).unwrap(),
        "2.1.287"
    );
    assert_eq!(
        codex_options
            .read_host_version(Instant::now() + Duration::from_secs(5))
            .unwrap(),
        "0.160.0"
    );
    let expired = Instant::now() - Duration::from_millis(1);
    assert!(read_cli_version(&claude, expired).is_err());
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
            read_cli_version(&path, Instant::now() + Duration::from_secs(5))
        } else {
            codex.read_host_version(Instant::now() + Duration::from_secs(5))
        };
        assert!(result.is_err());
    }
    fs::write(&path, "#!/bin/sh\nwhile :; do :; done\n").unwrap();
    let start = Instant::now();
    assert!(read_cli_version(&path, Instant::now() + Duration::from_millis(30)).is_err());
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
                host_location: None,
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

fn copy_store(from: &Path, to: &Path) {
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name();
        let target = to.join(&name);
        if entry.file_type().unwrap().is_dir() {
            if name == "locks" {
                continue;
            }
            fs::create_dir(&target).unwrap();
            fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).unwrap();
            copy_store(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).unwrap();
            fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
}

fn park_copy(profile: &Profile) -> PathBuf {
    let parked = profile
        .data
        .join("projects")
        .join(format!("{}.legacy-1", id(1).as_str()));
    fs::create_dir(&parked).unwrap();
    fs::set_permissions(&parked, fs::Permissions::from_mode(0o700)).unwrap();
    copy_store(&profile.store(), &parked);
    parked
}

#[test]
fn identical_parked_copy_is_reported_safe_to_delete() {
    let profile = Profile::new();
    let parked = park_copy(&profile);
    let report = profile.report();
    let legacy = checks(&report, "store.legacy");
    assert_eq!(legacy.len(), 1, "{legacy:?}");
    let message = legacy[0]["message"].as_str().unwrap();
    assert!(
        message.contains(&format!("{}", parked.display()))
            && message.contains("identical to the store; safe to delete."),
        "{message}"
    );
}

#[test]
fn differing_parked_copy_is_reported_as_keep() {
    let profile = Profile::new();
    let parked = park_copy(&profile);
    let session = fs::read_dir(parked.join("sessions"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    fs::write(&session, b"changed").unwrap();
    let report = profile.report();
    let legacy = checks(&report, "store.legacy");
    assert_eq!(legacy.len(), 1, "{legacy:?}");
    let message = legacy[0]["message"].as_str().unwrap();
    assert!(
        message
            .contains("differs from the store (1 files differ); keep it until you have checked."),
        "{message}"
    );
    assert!(!message.contains("safe to delete"));
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

struct CodexDoctorRun {
    report: Value,
    calls: Vec<String>,
    stdout: String,
    socket: PathBuf,
}

/// Runs the installed doctor against a scripted Codex app-server whose
/// `thread/read` reports `thread_status` for the bound thread. Asserts the run
/// changed nothing on disk.
fn codex_doctor(thread_status: &str) -> CodexDoctorRun {
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
    let status = thread_status.to_owned();
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
                        result["thread"]["status"] = serde_json::json!({"type": status});
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
    let mut envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
    let calls = server.join().unwrap();
    assert_eq!(snapshot(profile.project.path()), before);
    assert_eq!(snapshot(profile.home.path()), home_before);
    CodexDoctorRun {
        report: envelope["data"].take(),
        calls,
        stdout: String::from_utf8(output.stdout).unwrap(),
        socket: endpoint,
    }
}

#[test]
fn executable_doctor_qualifies_only_the_existing_codex_daemon_and_exact_thread() {
    let run = codex_doctor("idle");
    let report = &run.report;
    assert_eq!(checks(report, "codex.selected_thread")[0]["status"], "ok");
    assert_eq!(checks(report, "codex.daemon")[0]["status"], "ok");
    assert!(checks(report, "codex.thread_not_loaded").is_empty());
    assert_eq!(
        checks(report, "codex.selected_thread")[0]["facts"]["dispatch_ready"],
        false
    );
    assert_eq!(
        run.calls,
        [
            "initialize",
            "initialized",
            "thread/read",
            "thread/read",
            "thread/queue/list",
            "thread/turns/list",
            "initialize",
            "initialized"
        ]
    );
    assert!(!run.stdout.contains("Codex queue communication test"));
}

#[test]
fn doctor_warns_in_plain_words_when_codex_has_not_loaded_the_selected_thread() {
    let run = codex_doctor("notLoaded");
    let report = &run.report;
    let check = &checks(report, "codex.thread_not_loaded")[0];
    assert_eq!(check["status"], "warning");
    assert_eq!(
        check["message"],
        "Codex isn't sharing this conversation with Ariadne, so messages can't reach it."
    );
    // The fix names the exact option and this binding's own socket.
    let hint = check["hint"].as_str().unwrap();
    assert!(
        hint.contains(&format!("--remote unix://{}", run.socket.display())),
        "{hint}"
    );
    assert_eq!(check["facts"]["dispatch_ready"], false);
    // Not loaded is a specific answer, so neither the generic warning nor a pass appears.
    assert!(checks(report, "codex.thread_unknown").is_empty());
    assert!(checks(report, "codex.selected_thread").is_empty());
    assert_eq!(report["status"], "warning");
    // Doctor stops at the status read: no queue or history read of an unloaded thread.
    assert_eq!(
        run.calls,
        [
            "initialize",
            "initialized",
            "thread/read",
            "initialize",
            "initialized"
        ]
    );
}

fn health_entry(n: u64, state: &str, reason: Option<&str>) -> Value {
    serde_json::json!({
        "binding_id": id(n), "generation": id(n + 100), "state": state,
        "reason": reason, "retry_in_seconds": if state == "backing_off" { Some(8) } else { None },
        "updated_at": "2026-10-07T18:41:00.000Z"
    })
}
fn write_health(data: &Path, written_at: &str, bindings: Vec<Value>) {
    let logs = data.join("logs");
    fs::create_dir_all(&logs).unwrap();
    fs::write(
        logs.join("supervisor-health.json"),
        serde_json::to_vec(
            &serde_json::json!({"pid": 1, "written_at": written_at, "bindings": bindings}),
        )
        .unwrap(),
    )
    .unwrap();
}
fn now_utc(offset_seconds: i64) -> String {
    (chrono::Utc::now() + chrono::Duration::seconds(offset_seconds))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[test]
fn supervisor_health_reads_the_app_heartbeat_and_says_what_is_wrong_in_plain_words() {
    let profile = Profile::new();
    // Before the app ever ran with this data folder.
    let report = profile.report();
    let missing = checks(&report, "desktop.supervisor_health");
    assert_eq!(missing.len(), 1);
    assert_eq!(missing[0]["status"], "warning");
    assert_eq!(missing[0]["facts"]["state"], "missing");
    assert!(
        !profile.data.join("logs").exists(),
        "doctor created nothing"
    );

    // The real writer, as the app runs it: everything working.
    let board = ariadne_runtime::health::HealthBoard::new(Some(&profile.data));
    board.publish(ariadne_runtime::health::SupervisorHealth::running(
        id(30),
        id(31),
        UtcMillis::new(now_utc(0)).unwrap(),
    ));
    board.heartbeat();
    let before = snapshot(profile.home.path());
    let report = profile.report();
    let running = checks(&report, "desktop.supervisor_health");
    assert_eq!(running.len(), 1);
    assert_eq!(running[0]["status"], "ok");
    assert_eq!(running[0]["facts"]["codex_connections"], 1);
    assert_eq!(snapshot(profile.home.path()), before);

    // A retrying and a stopped connection each get their own warning with the reason.
    let retry = "Ariadne can't reach Codex right now.";
    let stop = "This connection was replaced. Reconnect to send again.";
    write_health(
        &profile.data,
        &now_utc(-5),
        vec![
            health_entry(1, "running", None),
            health_entry(2, "backing_off", Some(retry)),
            health_entry(3, "stopped", Some(stop)),
        ],
    );
    let report = profile.report();
    let troubled = checks(&report, "desktop.supervisor_health");
    assert_eq!(troubled.len(), 2);
    assert!(troubled.iter().all(|c| c["status"] == "warning"));
    assert_eq!(
        troubled[0]["message"],
        format!("A Codex connection is retrying. {retry}")
    );
    assert_eq!(troubled[0]["facts"]["binding_id"], id(2).as_str());
    assert_eq!(troubled[0]["facts"]["retry_in_seconds"], 8);
    assert!(troubled[0]["hint"]
        .as_str()
        .unwrap()
        .contains("logs/ariadne.log"));
    assert_eq!(
        troubled[1]["message"],
        format!("A Codex connection stopped. {stop}")
    );
    assert!(troubled[1]["hint"]
        .as_str()
        .unwrap()
        .starts_with("Reconnect the conversation in Ariadne"));

    // An old heartbeat means the app is not running, whatever the entries say.
    write_health(
        &profile.data,
        &now_utc(-3600),
        vec![health_entry(2, "backing_off", Some(retry))],
    );
    let stale = checks(&profile.report(), "desktop.supervisor_health");
    assert_eq!(stale.len(), 1);
    assert_eq!(stale[0]["facts"]["state"], "stale");
    assert_eq!(
        stale[0]["message"],
        "The Ariadne app isn't running, or it stopped updating its record."
    );

    // A damaged record is reported, never trusted.
    fs::write(
        profile.data.join("logs/supervisor-health.json"),
        b"{not json",
    )
    .unwrap();
    let unreadable = checks(&profile.report(), "desktop.supervisor_health");
    assert_eq!(unreadable[0]["facts"]["state"], "unreadable");
    assert_eq!(unreadable[0]["status"], "warning");
}
