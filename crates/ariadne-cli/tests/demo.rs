use ariadne_cli::demo;
use ariadne_core::CoreErrorCode;
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
use std::fs;
use std::os::unix::fs::PermissionsExt;

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012}")).unwrap()
}
fn live(root: &std::path::Path) -> std::path::PathBuf {
    root.join(".ariadne/sessions/00000000-0000-4000-8000-000000000002.json")
}
fn restore(root: &std::path::Path, bytes: &[u8]) {
    fs::create_dir_all(live(root).parent().unwrap()).unwrap();
    for directory in [root.join(".ariadne"), root.join(".ariadne/sessions")] {
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
    }
    fs::write(live(root), bytes).unwrap();
    fs::set_permissions(live(root), fs::Permissions::from_mode(0o600)).unwrap();
}

#[test]
fn explicit_demo_is_the_full_canonical_fixture_with_disconnected_dispatch() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_ariadne"))
        .args(["demo", "--root", root.path().to_str().unwrap(), "--json"])
        .env("ARIADNE_HOME", home.path().join(".ariadne"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let envelope: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(envelope["ok"], true);
    let route: ariadne_core::SessionRef = serde_json::from_value(envelope["data"].clone()).unwrap();
    let got = Store::open_registered(root.path(), route.project_id)
        .unwrap()
        .read(&route.session_id)
        .unwrap();
    let mut expected: Session =
        serde_json::from_str(include_str!("../../../fixtures/domain/demo/session.json")).unwrap();
    for binding in expected.bindings.0.values_mut() {
        binding.connection_state = ConnectionState::Disconnected;
        binding.dispatch_state = DispatchState::Disconnected;
    }
    assert_eq!(got, expected);
    let registry_before = fs::read(home.path().join(".ariadne/projects.json")).unwrap();
    let session_before = fs::read(live(root.path())).unwrap();
    assert_eq!(
        demo::prepare(root.path()).err().unwrap().code,
        CoreErrorCode::BindingConflict
    );
    assert_eq!(
        fs::read(home.path().join(".ariadne/projects.json")).unwrap(),
        registry_before
    );
    assert_eq!(fs::read(live(root.path())).unwrap(), session_before);
    assert_eq!(
        demo::prepare(std::path::Path::new("relative"))
            .err()
            .unwrap()
            .code,
        CoreErrorCode::InvalidArgument
    );
}

#[test]
fn demo_process_requires_exact_explicit_flags_before_opening_application_data() {
    let home = tempfile::tempdir().unwrap();
    let data = home.path().join("absent-data");
    for args in [
        vec!["demo", "--json"],
        vec!["demo", "--root", "relative", "--json"],
        vec!["demo", "--root", "/", "--root", "/", "--json"],
        vec!["demo", "--json-stdin", "--json"],
    ] {
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_ariadne"))
            .args(args)
            .env("ARIADNE_HOME", &data)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        let envelope: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(envelope["error"]["code"], "invalid_argument");
        assert!(!data.exists());
    }
}

#[test]
fn late_restore_preserves_existing_bytes_and_reports_successful_registration() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    let prepared = demo::prepare(root.path()).unwrap();
    // A real restored file appears after preflight; Store owns final no-clobber.
    restore(root.path(), b"restored bytes must survive");
    let error = prepared.publish(&registry, &id(101)).unwrap_err();
    assert_eq!(error.code, CoreErrorCode::BindingConflict);
    assert!(error.message.starts_with("Project registered;"));
    assert!(!error.retryable);
    error.validate().unwrap();
    assert_eq!(
        fs::read(live(root.path())).unwrap(),
        b"restored bytes must survive"
    );
    assert_eq!(registry.registered_projects().unwrap().len(), 1);
    assert_eq!(registry.resolve_project(&id(1)).unwrap().project_id, id(1));
    assert!(root.path().join(".ariadne/project.json").exists());
}

#[test]
fn ordinary_collision_and_wrong_project_identity_have_no_registration_effects() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    restore(root.path(), b"existing demo");
    assert_eq!(
        demo::prepare(root.path()).err().unwrap().code,
        CoreErrorCode::BindingConflict
    );
    assert!(!home.path().join(".ariadne/projects.json").exists());
    assert!(!root.path().join(".ariadne/project.json").exists());
    fs::remove_file(live(root.path())).unwrap();
    registry
        .register(root.path(), &id(102), || id(999))
        .unwrap();
    let project_before = fs::read(root.path().join(".ariadne/project.json")).unwrap();
    let registry_before = fs::read(home.path().join(".ariadne/projects.json")).unwrap();
    assert_eq!(
        demo::prepare(root.path())
            .unwrap()
            .publish(&registry, &id(103))
            .unwrap_err()
            .code,
        CoreErrorCode::BindingConflict
    );
    assert_eq!(
        fs::read(root.path().join(".ariadne/project.json")).unwrap(),
        project_before
    );
    assert_eq!(
        fs::read(home.path().join(".ariadne/projects.json")).unwrap(),
        registry_before
    );
    assert!(!live(root.path()).exists());
}

#[test]
fn first_run_demo_initializes_default_home_and_explicit_custom_data_root() {
    for custom in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let data = home
            .path()
            .join(if custom { "custom-data" } else { ".ariadne" });
        let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_ariadne"));
        command
            .args(["demo", "--root", root.path().to_str().unwrap(), "--json"])
            .env("HOME", home.path())
            .env_remove("ARIADNE_HOME");
        if custom {
            command.env("ARIADNE_HOME", &data);
        }
        let output = command.output().unwrap();
        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            Registry::open_data_directory(&data)
                .unwrap()
                .registered_projects()
                .unwrap()
                .len(),
            1
        );
        assert!(!data.join(".ariadne").exists());
    }
}
