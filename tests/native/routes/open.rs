#[path = "../../../apps/desktop/src-tauri/src/native/routes/launch.rs"]
mod launch;
#[path = "../../../crates/ariadne-cli/src/open.rs"]
mod open;
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
