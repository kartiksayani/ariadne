use ariadne_cli::{open, setup::resources::VERSION};
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::{symlink, PermissionsExt},
    path::PathBuf,
    process::{Command, Output},
};

struct Installation {
    home: tempfile::TempDir,
    root: PathBuf,
    version: PathBuf,
    app: PathBuf,
}
impl Installation {
    fn new() -> Self {
        let home = tempfile::Builder::new()
            .prefix("ariadne-installed-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = home.path().join(".local/share/ariadne");
        let version = root.join("versions").join(VERSION);
        let app = home.path().join("Applications/Ariadne with spaces.app");
        fs::create_dir_all(version.join("bin")).unwrap();
        fs::set_permissions(&version, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(version.join("bin"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir_all(&app).unwrap();
        fs::write(
            version.join("bin/ariadne"),
            b"private packaged-helper identity fixture",
        )
        .unwrap();
        symlink(
            PathBuf::from("versions").join(VERSION),
            root.join("current"),
        )
        .unwrap();
        let result = Self {
            home,
            root,
            version,
            app,
        };
        result.manifest(json!({"schema_version":1,"version":VERSION,"app_path":result.app,"owned_files":["inventory additions stay supported"]}));
        result
    }
    fn manifest(&self, value: Value) {
        fs::write(
            self.version.join("install.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    }
    fn invoke(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_ariadne"))
            .args(args)
            .env_clear()
            .env("HOME", self.home.path())
            .env("ARIADNE_HOME", self.home.path().join("data"))
            .output()
            .unwrap()
    }
}
fn envelope(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn package_reuse_preserves_application_only_contract_and_external_app_inventory() {
    let installed = Installation::new();
    let package = open::installed_package(&installed.root, VERSION).unwrap();
    assert_eq!(
        package.version_root,
        installed.version.canonicalize().unwrap()
    );
    assert_eq!(package.application, installed.app.canonicalize().unwrap());
    assert_eq!(
        open::installed_application(&installed.root, VERSION).unwrap(),
        package.application
    );
}

#[test]
fn installed_setup_repeat_and_uninstall_preserve_foreign_settings_and_data() {
    let installed = Installation::new();
    let foreign = installed.home.path().join("claude-settings.json");
    let history = installed.home.path().join("session-and-backup-fixture");
    fs::write(&foreign, b"foreign settings").unwrap();
    fs::write(&history, b"preserved session and backup").unwrap();
    let first = installed.invoke(&["setup", "--agent", "both", "--json"]);
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let result = envelope(&first);
    assert_eq!(result["data"]["changes"].as_array().unwrap().len(), 25);
    assert_eq!(
        result["data"]["host_commands"][1],
        "/plugin install ariadne@ariadne-local"
    );
    assert!(!installed.home.path().join("data").exists());
    let receipt = installed.version.join("integrations/setup.json");
    let before = fs::read(&receipt).unwrap();
    let modified = fs::metadata(&receipt).unwrap().modified().unwrap();
    let repeated = installed.invoke(&["setup", "--agent", "both", "--json"]);
    assert!(repeated.status.success());
    assert_eq!(envelope(&repeated)["data"]["changes"], json!([]));
    assert_eq!(fs::read(&receipt).unwrap(), before);
    assert_eq!(
        fs::metadata(&receipt).unwrap().modified().unwrap(),
        modified
    );
    let edited = installed
        .version
        .join("integrations/claude-mod/plugin/skills/ariadne/SKILL.md");
    fs::write(&edited, b"owner changed rules").unwrap();
    let removed = installed.invoke(&["uninstall", "--json"]);
    assert!(removed.status.success());
    assert_eq!(
        envelope(&removed)["data"]["changes"]
            .as_array()
            .unwrap()
            .len(),
        24
    );
    assert_eq!(
        envelope(&removed)["data"]["retained"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(fs::read(edited).unwrap(), b"owner changed rules");
    assert_eq!(fs::read(foreign).unwrap(), b"foreign settings");
    assert_eq!(fs::read(history).unwrap(), b"preserved session and backup");
    assert!(!installed.home.path().join("data").exists());
}

#[test]
fn installed_doctor_validates_layout_without_creating_resource_or_data_state() {
    let installed = Installation::new();
    let descriptor = fs::read(installed.version.join("install.json")).unwrap();
    let result = installed.invoke(&["doctor", "--json"]);
    assert!(result.status.success());
    assert_eq!(envelope(&result)["data"]["status"], "warning");
    assert!(envelope(&result)["data"]["checks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["code"] == "installation.resources_unknown"));
    assert!(!installed.version.join("integrations").exists());
    assert!(!installed.home.path().join("data").exists());
    assert_eq!(
        fs::read(installed.version.join("install.json")).unwrap(),
        descriptor
    );
    assert!(installed
        .invoke(&["setup", "--agent", "both", "--json"])
        .status
        .success());
    let receipt = fs::read(installed.version.join("integrations/setup.json")).unwrap();
    let result = installed.invoke(&["doctor", "--json"]);
    assert!(result.status.success());
    assert!(envelope(&result)["data"]["checks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["code"] == "installation.resource_parity" && c["status"] == "ok"));
    assert_eq!(
        fs::read(installed.version.join("integrations/setup.json")).unwrap(),
        receipt
    );
    assert!(!installed.home.path().join("data").exists());
}

#[test]
fn invalid_installed_layouts_never_write_resources_or_suppress_doctor_errors() {
    for kind in [
        "future",
        "mismatch",
        "redirected_current",
        "redirected_versions",
        "descriptor_link",
    ] {
        let installed = Installation::new();
        match kind {
            "future" => installed
                .manifest(json!({"schema_version":2,"version":VERSION,"app_path":installed.app})),
            "mismatch" => installed
                .manifest(json!({"schema_version":1,"version":"0.2.0","app_path":installed.app})),
            "redirected_current" => {
                fs::remove_file(installed.root.join("current")).unwrap();
                symlink(&installed.app, installed.root.join("current")).unwrap();
            }
            "redirected_versions" => {
                let other = installed.root.join("other");
                fs::rename(installed.root.join("versions"), &other).unwrap();
                symlink(other, installed.root.join("versions")).unwrap();
            }
            "descriptor_link" => {
                let foreign = installed.home.path().join("foreign-descriptor");
                fs::rename(installed.version.join("install.json"), &foreign).unwrap();
                symlink(foreign, installed.version.join("install.json")).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(open::installed_package(&installed.root, VERSION).is_err());
        let setup = installed.invoke(&["setup", "--agent", "both", "--json"]);
        assert!(!setup.status.success(), "{kind}");
        assert_eq!(envelope(&setup)["ok"], false);
        let doctor = installed.invoke(&["doctor", "--json"]);
        assert_eq!(doctor.status.code(), Some(4), "{kind}");
        assert!(envelope(&doctor)["data"]["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["code"] == "installation.invalid" && c["status"] == "error"));
        assert!(!installed.version.join("integrations").exists());
        assert!(!installed.home.path().join("data").exists());
    }
}

#[test]
fn command_help_and_missing_installation_do_not_require_or_create_an_install() {
    let installed = Installation::new();
    fs::remove_file(installed.root.join("current")).unwrap();
    fs::remove_dir_all(&installed.root).unwrap();
    for args in [
        vec!["--help"],
        vec!["setup", "--help"],
        vec!["uninstall", "--help"],
        vec!["doctor", "--help"],
    ] {
        let result = installed.invoke(&args);
        assert!(result.status.success());
        let text = String::from_utf8(result.stdout).unwrap();
        assert!(text.contains("--agent") || text.contains("--claude-bin"));
    }
    let result = installed.invoke(&["doctor", "--json"]);
    assert!(result.status.success());
    assert!(envelope(&result)["data"]["checks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["code"] == "installation.unknown"));
    assert!(!installed.root.exists());
    assert!(!installed.home.path().join("data").exists());
    let invalid = installed.invoke(&["doctor", "--codex-bin", "relative", "--json"]);
    assert_eq!(invalid.status.code(), Some(2));
    assert_eq!(envelope(&invalid)["ok"], false);
    assert!(!installed.root.exists());
}
