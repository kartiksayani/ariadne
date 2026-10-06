#[path = "../../../apps/desktop/src-tauri/src/native/routes/launch.rs"]
mod launch;
#[path = "../../../apps/desktop/src-tauri/src/native/window/lifecycle.rs"]
mod lifecycle;
use ariadne_cli::open;
#[path = "../../../apps/desktop/src-tauri/src/native/window/preferences.rs"]
mod preferences;

use ariadne_core::CoreErrorCode;
use serde_json::{json, Value};
use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

const PROJECT: &str = "00000000-0000-4000-8000-000000000001";
const SESSION: &str = "00000000-0000-4000-8000-000000000002";
const VERSION: &str = "0.1.0";

struct Package {
    _root: tempfile::TempDir,
    path: PathBuf,
    version: PathBuf,
    app: PathBuf,
}
impl Package {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("package with spaces");
        let version = path.join("versions").join(VERSION);
        let app = version.join("Ariadne with spaces.app");
        fs::create_dir_all(&app).unwrap();
        symlink(Path::new("versions").join(VERSION), path.join("current")).unwrap();
        let package = Self {
            _root: root,
            path,
            version,
            app,
        };
        package.write(package.manifest());
        package
    }
    fn manifest(&self) -> Value {
        json!({"schema_version":1,"version":VERSION,"app_path":self.app})
    }
    fn write(&self, manifest: Value) {
        fs::write(
            self.version.join("install.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn explicit_canonical_route_and_argv_preserve_path_with_spaces() {
    let package = Package::new();
    let route = open::parse(&[
        "open",
        "--session",
        SESSION,
        "--item",
        "2.1",
        "--project",
        PROJECT,
    ])
    .unwrap();
    let app = open::installed_application(&package.path, VERSION).unwrap();
    assert_eq!(app, fs::canonicalize(&package.app).unwrap());
    let args = open::launch_args(&app, &route).unwrap();
    assert_eq!(args.len(), 6);
    assert_eq!(args[0], "-n");
    assert_eq!(args[1], "-a");
    assert_eq!(args[2], app.as_os_str());
    assert_eq!(args[3], "--args");
    assert_eq!(args[4], "--ariadne-route");
    assert_eq!(
        serde_json::from_str::<Value>(args[5].to_str().unwrap()).unwrap(),
        json!({"project_id":PROJECT,"session_id":SESSION,"item_id":"2.1"})
    );
    let session_route = open::parse(&["open", "--project", PROJECT, "--session", SESSION]).unwrap();
    assert_eq!(session_route.item_id, None);
    assert!(open::launch_args(Path::new("relative.app"), &session_route).is_err());
}

#[test]
fn absent_duplicate_unknown_and_noncanonical_arguments_are_rejected() {
    for args in [
        vec![],
        vec!["open"],
        vec!["other"],
        vec!["open", "--project", PROJECT],
        vec!["open", "--project", PROJECT, "--session"],
        vec![
            "open",
            "--project",
            PROJECT,
            "--session",
            SESSION,
            "--project",
            PROJECT,
        ],
        vec![
            "open",
            "--project",
            PROJECT,
            "--session",
            SESSION,
            "--cwd",
            "/tmp",
        ],
        vec!["open", "--project", "bad", "--session", SESSION],
        vec![
            "open",
            "--project",
            PROJECT,
            "--session",
            SESSION,
            "--item",
            "01",
        ],
    ] {
        let error = open::parse(&args).unwrap_err();
        assert_eq!(error.code, CoreErrorCode::InvalidArgument);
        assert!(!error.retryable);
    }
}

#[test]
fn required_manifest_fields_versions_and_routes_are_strict() {
    let package = Package::new();
    for field in ["schema_version", "version", "app_path"] {
        let mut manifest = package.manifest();
        manifest.as_object_mut().unwrap().remove(field);
        package.write(manifest);
        assert!(open::installed_application(&package.path, VERSION).is_err());
    }
    for (field, value) in [
        ("schema_version", json!(2)),
        ("schema_version", json!(null)),
        ("version", json!("../../elsewhere")),
        ("version", json!("0.2.0")),
        ("app_path", json!("relative.app")),
        ("app_path", json!(package.path.join("missing.app"))),
    ] {
        let mut manifest = package.manifest();
        manifest[field] = value;
        package.write(manifest);
        assert!(open::installed_application(&package.path, VERSION).is_err());
    }
    for version in ["..", ".", "../0.1.0", "0.1.0/other", "0.1.0\\other", ""] {
        assert_eq!(
            open::installed_application(&package.path, version)
                .unwrap_err()
                .code,
            CoreErrorCode::InvalidArgument
        );
    }
    fs::write(package.version.join("install.json"), format!(
        "{{\"schema_version\":1,\"version\":\"{VERSION}\",\"version\":\"{VERSION}\",\"app_path\":{}}}",
        serde_json::to_string(&package.app).unwrap()
    )).unwrap();
    assert!(open::installed_application(&package.path, VERSION).is_err());
}

#[test]
fn package_inventory_additions_and_exact_manifest_boundary_are_supported() {
    let package = Package::new();
    let mut manifest = package.manifest();
    manifest["owned_files"] = json!(["Ariadne with spaces.app"]);
    manifest["padding"] = json!("");
    let empty = serde_json::to_vec(&manifest).unwrap().len();
    manifest["padding"] = json!("x".repeat(512 * 1024 - empty));
    package.write(manifest.clone());
    assert_eq!(
        fs::metadata(package.version.join("install.json"))
            .unwrap()
            .len(),
        512 * 1024
    );
    assert!(open::installed_application(&package.path, VERSION).is_ok());
    manifest["padding"] = json!("x".repeat(512 * 1024 - empty + 1));
    package.write(manifest);
    assert!(open::installed_application(&package.path, VERSION).is_err());
}

#[test]
fn escaping_current_and_descriptor_links_are_rejected() {
    let package = Package::new();
    let other = tempfile::tempdir().unwrap();
    fs::remove_file(package.path.join("current")).unwrap();
    symlink(other.path(), package.path.join("current")).unwrap();
    assert!(open::installed_application(&package.path, VERSION).is_err());
    fs::remove_file(package.path.join("current")).unwrap();
    symlink(&package.version, package.path.join("current")).unwrap();
    let foreign = other.path().join("foreign.app");
    fs::create_dir(&foreign).unwrap();
    let mut manifest = package.manifest();
    manifest["app_path"] = json!(foreign);
    package.write(manifest);
    assert_eq!(
        open::installed_application(&package.path, VERSION).unwrap(),
        fs::canonicalize(&foreign).unwrap()
    );
    fs::remove_file(package.version.join("install.json")).unwrap();
    let descriptor = other.path().join("install.json");
    fs::write(
        &descriptor,
        serde_json::to_vec(&package.manifest()).unwrap(),
    )
    .unwrap();
    symlink(descriptor, package.version.join("install.json")).unwrap();
    assert!(open::installed_application(&package.path, VERSION).is_err());
}

#[test]
fn missing_and_nonregular_manifest_fail_without_a_launch() {
    let package = Package::new();
    fs::remove_file(package.version.join("install.json")).unwrap();
    assert_eq!(
        open::installed_application(&package.path, VERSION)
            .unwrap_err()
            .code,
        CoreErrorCode::IoError
    );
    fs::create_dir(package.version.join("install.json")).unwrap();
    assert!(open::installed_application(&package.path, VERSION).is_err());
    fs::remove_dir(package.version.join("install.json")).unwrap();
    use std::os::unix::ffi::OsStrExt;
    let fifo = std::ffi::CString::new(package.version.join("install.json").as_os_str().as_bytes())
        .unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert!(open::installed_application(&package.path, VERSION).is_err());
}

#[test]
fn redirected_versions_directory_is_rejected() {
    let package = Package::new();
    let redirected = package.path.join("elsewhere");
    fs::rename(package.path.join("versions"), &redirected).unwrap();
    symlink(&redirected, package.path.join("versions")).unwrap();
    assert!(open::installed_application(&package.path, VERSION).is_err());
}

fn registered_core() -> (
    tempfile::TempDir,
    tempfile::TempDir,
    ariadne_core::native::NativeCoreService,
) {
    use ariadne_domain::models::{Session, UtcMillis, UuidV4};
    use ariadne_store::{registry::Registry, session::Store};
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    let session: Session =
        serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json")).unwrap();
    registry
        .register(
            root.path(),
            &UuidV4::new("00000000-0000-4000-8000-000000000099").unwrap(),
            || session.project_id.clone(),
        )
        .unwrap();
    Store::open_registered(
        &registry.project_dir(&session.project_id),
        session.project_id.clone(),
    )
    .unwrap()
    .create(&session)
    .unwrap();
    let core = ariadne_core::native::NativeCoreService::new(
        registry,
        || UuidV4::new("00000000-0000-4000-8000-000000000098").unwrap(),
        || UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap(),
        |_| {
            Err(ariadne_core::CoreError::new(
                CoreErrorCode::Unsupported,
                "No test provider is composed.",
                "This fixture resolves registered navigation only.",
            ))
        },
    );
    (home, root, core)
}

#[test]
fn actual_registered_membership_precedes_launch_and_missing_item_uses_same_session() {
    let (home, _root, core) = registered_core();
    let live = home.path().join(format!(
        ".ariadne/projects/{PROJECT}/sessions/{SESSION}.json"
    ));
    let package = Package::new();
    let route = open::parse(&[
        "open",
        "--project",
        PROJECT,
        "--session",
        SESSION,
        "--item",
        "999",
    ])
    .unwrap();
    let before = fs::read(&live).unwrap();
    let opened = open::open_with(
        route.clone(),
        &package.path,
        VERSION,
        |route| core.resolve_session(route),
        |program, args| {
            assert_eq!(program, Path::new("/usr/bin/open"));
            assert_eq!(
                args,
                open::launch_args(&fs::canonicalize(&package.app).unwrap(), &route).unwrap()
            );
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(opened, route);
    assert_eq!(fs::read(&live).unwrap(), before);
    let mut wrong = route;
    wrong.project_id =
        ariadne_domain::models::UuidV4::new("00000000-0000-4000-8000-000000000088").unwrap();
    assert!(open::open_with(
        wrong,
        Path::new("/not-a-package"),
        VERSION,
        |route| core.resolve_session(route),
        |_, _| panic!("must not launch unregistered route")
    )
    .is_err());
}

#[test]
fn contradictory_resolver_and_launch_failure_do_not_publish_success() {
    let (_home, _root, core) = registered_core();
    let package = Package::new();
    let route = open::parse(&["open", "--project", PROJECT, "--session", SESSION]).unwrap();
    let error = open::open_with(
        route.clone(),
        &package.path,
        VERSION,
        |_| {
            Ok(ariadne_core::RegisteredSession::from_trusted_entrypoint(
                route.project_id.clone(),
                ariadne_domain::models::UuidV4::new("00000000-0000-4000-8000-000000000088")
                    .unwrap(),
            ))
        },
        |_, _| panic!("contradictory route cannot launch"),
    )
    .unwrap_err();
    assert_eq!(error.code, CoreErrorCode::PermissionDenied);
    let failure = ariadne_core::CoreError::new(
        CoreErrorCode::IoError,
        "macOS launch failed.",
        "Check the installed app.",
    );
    assert_eq!(
        open::open_with(
            route,
            &package.path,
            VERSION,
            |route| core.resolve_session(route),
            |_, _| Err(failure.clone())
        )
        .unwrap_err(),
        failure
    );
}

#[test]
fn installed_cli_open_help_and_invalid_routes_keep_output_and_exit_contracts() {
    let home = tempfile::tempdir().unwrap();
    let invoke = |args: &[&str]| {
        std::process::Command::new(env!("CARGO_BIN_EXE_ariadne"))
            .args(args)
            .env("HOME", home.path())
            .env("ARIADNE_HOME", home.path().join("missing-data"))
            .output()
            .unwrap()
    };
    let help = invoke(&["open", "--help"]);
    assert!(help.status.success());
    assert!(String::from_utf8(help.stdout)
        .unwrap()
        .contains("--project UUID --session UUID"));
    assert!(help.stderr.is_empty());
    let invalid = invoke(&["open", "--project", "not-a-uuid", "--session", SESSION]);
    assert_eq!(invalid.status.code(), Some(2));
    assert!(invalid.stdout.is_empty());
    assert!(!invalid.stderr.is_empty());
    let inaccessible = invoke(&["open", "--project", PROJECT, "--session", SESSION]);
    assert!(!inaccessible.status.success());
    assert!(inaccessible.stdout.is_empty());
    assert!(!inaccessible.stderr.is_empty());
}
