use ariadne_cli::setup::owned;
use ariadne_cli::setup::resources;
use std::path::Path;
use std::{
    fs,
    os::unix::fs::{symlink, PermissionsExt},
};

fn private(path: &Path) {
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
fn put(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut parent = path.parent().unwrap();
    while parent.file_name().is_some_and(|name| name != "0.1.0") {
        private(parent);
        parent = parent.parent().unwrap();
    }
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
fn version(root: &Path) -> std::path::PathBuf {
    let path = root.join("0.1.0");
    fs::create_dir(&path).unwrap();
    private(&path);
    path
}

#[test]
fn setup_is_idempotent_and_agent_selection_merges_only_owned_resources() {
    let profile = tempfile::tempdir().unwrap();
    let version = version(profile.path());
    let first = owned::apply(&version, "claude", false).unwrap();
    assert_eq!(first["changes"].as_array().unwrap().len(), 11);
    assert!(!version.join("integrations/rules/codex.md").exists());
    let receipt = version.join("integrations/setup.json");
    let bytes = fs::read(&receipt).unwrap();
    let modified = fs::metadata(&receipt).unwrap().modified().unwrap();
    let second = owned::apply(&version, "claude", false).unwrap();
    assert_eq!(second["changes"], serde_json::json!([]));
    assert_eq!(second["already_present"].as_array().unwrap().len(), 11);
    assert_eq!(fs::read(&receipt).unwrap(), bytes);
    assert_eq!(
        fs::metadata(&receipt).unwrap().modified().unwrap(),
        modified
    );
    assert_eq!(
        owned::apply(&version, "both", false).unwrap()["changes"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        owned::apply(&version, "codex", true).unwrap()["changes"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(version
        .join("integrations/claude-mod/plugin/hooks/register.js")
        .exists());
    assert!(!version.join("integrations/rules/codex.md").exists());
    assert_eq!(
        owned::apply(&version, "both", true).unwrap()["changes"]
            .as_array()
            .unwrap()
            .len(),
        11
    );
    assert!(!receipt.exists());
    assert_eq!(
        owned::apply(&version, "both", true).unwrap()["changes"],
        serde_json::json!([])
    );
}

#[test]
fn matching_foreign_files_remain_unowned_and_edited_owned_files_survive() {
    let profile = tempfile::tempdir().unwrap();
    let version = version(profile.path());
    let bundle = resources::bundle(&version.join("bin/ariadne"));
    let foreign = version.join("integrations/rules/codex.md");
    put(&foreign, &bundle["rules/codex.md"]);
    let host = profile.path().join("claude-settings.json");
    fs::write(&host, b"foreign host config").unwrap();
    let session = profile.path().join("session.json");
    fs::write(&session, b"history").unwrap();
    let backup = profile.path().join("previous.json");
    fs::write(&backup, b"backup").unwrap();
    let installed = owned::apply(&version, "both", false).unwrap();
    assert_eq!(installed["changes"].as_array().unwrap().len(), 12);
    assert_eq!(installed["already_present"][0]["owned"], false);
    let edited = version.join("integrations/claude-mod/plugin/hooks/register.js");
    put(&edited, b"owner edited bytes");
    let removed = owned::apply(&version, "both", true).unwrap();
    assert_eq!(removed["changes"].as_array().unwrap().len(), 11);
    assert_eq!(removed["retained"].as_array().unwrap().len(), 1);
    assert_eq!(fs::read(edited).unwrap(), b"owner edited bytes");
    assert_eq!(fs::read(foreign).unwrap(), bundle["rules/codex.md"]);
    assert_eq!(fs::read(host).unwrap(), b"foreign host config");
    assert_eq!(fs::read(session).unwrap(), b"history");
    assert_eq!(fs::read(backup).unwrap(), b"backup");
}

#[test]
fn same_version_mismatch_or_symlink_never_replaces_existing_content() {
    let profile = tempfile::tempdir().unwrap();
    let version = version(profile.path());
    let path = version.join("integrations/rules/codex.md");
    put(&path, b"edited same version");
    assert!(owned::apply(&version, "both", false).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"edited same version");
    assert!(!version.join("integrations/claude-mod").exists());
    fs::remove_file(&path).unwrap();
    let foreign = profile.path().join("foreign");
    fs::write(&foreign, b"foreign").unwrap();
    symlink(&foreign, &path).unwrap();
    assert!(owned::apply(&version, "codex", false).is_err());
    assert_eq!(fs::read(foreign).unwrap(), b"foreign");
}

#[test]
fn malformed_receipt_and_replaced_owned_symlink_survive_uninstall() {
    let profile = tempfile::tempdir().unwrap();
    let version = version(profile.path());
    owned::apply(&version, "codex", false).unwrap();
    let receipt = version.join("integrations/setup.json");
    let before = fs::read(&receipt).unwrap();
    put(&receipt, b"edited receipt");
    assert!(owned::apply(&version, "both", true).is_err());
    assert_eq!(fs::read(&receipt).unwrap(), b"edited receipt");
    put(&receipt, &before);
    let path = version.join("integrations/rules/codex.md");
    fs::remove_file(&path).unwrap();
    let foreign = profile.path().join("foreign");
    fs::write(&foreign, b"keep").unwrap();
    symlink(&foreign, &path).unwrap();
    let result = owned::apply(&version, "both", true).unwrap();
    assert_eq!(result["retained"].as_array().unwrap().len(), 1);
    assert!(fs::symlink_metadata(path).unwrap().file_type().is_symlink());
    assert_eq!(fs::read(foreign).unwrap(), b"keep");
    assert!(owned::apply(&version, "unknown", false).is_err());
}

#[test]
fn packaged_inventory_renders_only_static_immutable_helper_identity() {
    let helper = Path::new("/private/profile with spaces/versions/0.1.0/bin/ariadne");
    let files = resources::bundle(helper);
    let descriptor = std::str::from_utf8(&files["claude-mod/plugin/hooks/installed.js"]).unwrap();
    assert_eq!(descriptor, "export default Object.freeze({helperPath:\"/private/profile with spaces/versions/0.1.0/bin/ariadne\",appVersion:\"0.1.0\",apiVersion:1});\n");
    let manifest: serde_json::Value =
        serde_json::from_slice(&files["claude-mod/plugin/.claude-plugin/plugin.json"]).unwrap();
    assert_eq!(manifest["version"], resources::VERSION);
    assert_eq!(files.len(), 13);
    assert!(files["codex-skills/ariadne/SKILL.md"].starts_with(b"---\nname: ariadne\n"));
    assert!(files.contains_key("claude-mod/plugin/hooks/discovery.js"));
    assert_eq!(files.values().filter(|bytes| bytes.is_empty()).count(), 0);
    assert_eq!(
        files
            .keys()
            .filter(|name| resources::selected(name, "claude"))
            .count(),
        11
    );
    assert_eq!(
        files
            .keys()
            .filter(|name| resources::selected(name, "codex"))
            .count(),
        2
    );
    assert_eq!(
        files
            .keys()
            .filter(|name| resources::selected(name, "both"))
            .count(),
        13
    );
}

#[test]
fn host_commands_preserve_spaces_and_keep_trust_explicit() {
    let commands = resources::host_commands(
        Path::new("/home/private profile/current/integrations"),
        "both",
    );
    assert_eq!(
        commands[0],
        "/plugin marketplace add \"/home/private profile/current/integrations/claude-mod\""
    );
    assert_eq!(
        &commands[1..4],
        [
            "/plugin install ariadne@ariadne-local",
            "/reload-plugins",
            "/ariadne-connect"
        ]
    );
    assert!(commands[4].contains("/status"));
    assert!(commands[4].contains("paste the setup instruction"));
    assert!(commands[4].contains("once per binding"));
    assert!(commands[4].contains("/home/private profile/current/integrations/rules/codex.md"));
    assert_eq!(
        resources::host_commands(Path::new("/home/private/current/integrations"), "codex").len(),
        1
    );
    assert_eq!(
        resources::host_commands(Path::new("/home/private/current/integrations"), "claude")[0],
        "/plugin marketplace add /home/private/current/integrations/claude-mod"
    );
}

#[test]
fn global_setup_does_not_infer_or_register_a_project_and_explicit_registration_repeats_without_writes(
) {
    let profile = tempfile::tempdir().unwrap();
    let version = version(profile.path());
    let data = profile.path().join(".ariadne");
    let stable = profile.path().join("current/integrations");
    let args = ["--agent", "codex"];
    let result =
        ariadne_cli::setup::execute_in_installation(&args, false, &data, &version, &stable)
            .unwrap();
    assert_eq!(result["changes"].as_array().unwrap().len(), 2);
    assert!(!data.exists());
    assert_eq!(
        ariadne_cli::setup::execute_in_installation(&args, false, &data, &version, &stable)
            .unwrap()["changes"],
        serde_json::json!([])
    );
    assert!(!data.exists());
    let project = tempfile::tempdir().unwrap();
    let args = [
        "--agent",
        "codex",
        "--project",
        project.path().to_str().unwrap(),
    ];
    let first = ariadne_cli::setup::execute_in_installation(&args, false, &data, &version, &stable)
        .unwrap();
    assert_eq!(first["project"]["state"], "registered");
    let registry = fs::read(data.join("projects.json")).unwrap();
    let metadata = fs::read(project.path().join(".ariadne/project.json")).unwrap();
    let repeated =
        ariadne_cli::setup::execute_in_installation(&args, false, &data, &version, &stable)
            .unwrap();
    assert_eq!(repeated["project"]["state"], "already_registered");
    assert_eq!(fs::read(data.join("projects.json")).unwrap(), registry);
    assert_eq!(
        fs::read(project.path().join(".ariadne/project.json")).unwrap(),
        metadata
    );
    ariadne_cli::setup::execute_in_installation(&[], true, &data, &version, &stable).unwrap();
    assert_eq!(fs::read(data.join("projects.json")).unwrap(), registry);
    assert_eq!(
        fs::read(project.path().join(".ariadne/project.json")).unwrap(),
        metadata
    );
}

#[test]
fn invalid_arguments_and_unavailable_explicit_project_fail_before_resource_creation() {
    let profile = tempfile::tempdir().unwrap();
    let version = version(profile.path());
    let data = profile.path().join(".ariadne");
    for args in [
        vec![],
        vec!["--agent", "invalid"],
        vec!["--agent", "both", "--json", "--json"],
        vec!["--agent", "both", "--project", "relative"],
        vec!["--agent", "both", "--unexpected"],
    ] {
        assert!(ariadne_cli::setup::execute_in_installation(
            &args, false, &data, &version, &version
        )
        .is_err());
        assert!(!version.join("integrations").exists());
        assert!(!data.exists());
    }
    assert!(ariadne_cli::setup::execute_in_installation(
        &["--project", "/"],
        true,
        &data,
        &version,
        &version
    )
    .is_err());
    let absent = profile.path().join("unavailable");
    assert!(ariadne_cli::setup::execute_in_installation(
        &["--agent", "both", "--project", absent.to_str().unwrap()],
        false,
        &data,
        &version,
        &version
    )
    .is_err());
    assert!(!version.join("integrations").exists());
}

#[test]
fn setup_text_prints_literal_host_commands_and_json_uses_canonical_envelope() {
    let profile = tempfile::tempdir().unwrap();
    let version = version(profile.path());
    let data = profile.path().join(".ariadne");
    let stable = profile.path().join("current/integrations");
    let mut output = Vec::new();
    let mut errors = Vec::new();
    assert_eq!(
        ariadne_cli::setup::run_in_installation(
            &["--agent", "claude"],
            false,
            &data,
            &version,
            &stable,
            &mut output,
            &mut errors
        ),
        0
    );
    let text = String::from_utf8(output).unwrap();
    assert!(text
        .lines()
        .any(|line| line == "/plugin install ariadne@ariadne-local"));
    assert!(text.lines().any(|line| line == "/reload-plugins"));
    assert!(errors.is_empty());
    let mut output = Vec::new();
    assert_eq!(
        ariadne_cli::setup::run_in_installation(
            &["--agent", "claude", "--json"],
            false,
            &data,
            &version,
            &stable,
            &mut output,
            &mut errors
        ),
        0
    );
    let envelope: serde_json::Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(envelope["api_version"], 1);
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["data"]["changes"], serde_json::json!([]));
    let mut output = Vec::new();
    assert_eq!(
        ariadne_cli::setup::run_in_installation(
            &["--help"],
            false,
            &data,
            &version,
            &stable,
            &mut output,
            &mut errors
        ),
        0
    );
    assert!(String::from_utf8(output).unwrap().contains("--project"));
}

mod providers_file {
    use super::*;
    use ariadne_cli::setup::providers::Environment;
    use serde_json::{json, Value};
    use std::path::PathBuf;

    struct Fixture {
        profile: tempfile::TempDir,
        version: PathBuf,
        data: PathBuf,
        stable: PathBuf,
        bin: PathBuf,
    }
    fn fixture() -> Fixture {
        let profile = tempfile::tempdir().unwrap();
        let version = super::version(profile.path());
        let bin = profile.path().join("bin");
        fs::create_dir(&bin).unwrap();
        Fixture {
            data: profile.path().join(".ariadne"),
            stable: profile.path().join("current/integrations"),
            version,
            bin,
            profile,
        }
    }
    fn tool(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }
    impl Fixture {
        fn environment(&self) -> Environment {
            Environment {
                path: Some(self.bin.clone().into_os_string()),
                codex_home: Some(self.profile.path().join(".codex")),
            }
        }
        fn run(&self, args: &[&str]) -> Result<Value, ariadne_core::CoreError> {
            ariadne_cli::setup::execute_with_environment(
                args,
                false,
                &self.data,
                &self.version,
                &self.stable,
                &self.environment(),
            )
        }
        fn file(&self) -> Value {
            serde_json::from_slice(&fs::read(self.data.join("providers.json")).unwrap()).unwrap()
        }
    }

    #[test]
    fn setup_resolves_hosts_on_path_and_writes_a_private_atomic_file() {
        let f = fixture();
        let claude = tool(&f.bin, "claude");
        let result = f.run(&["--agent", "claude"]).unwrap();
        let path = f.data.join("providers.json");
        assert_eq!(result["providers"]["file"], json!(path));
        assert_eq!(
            result["providers"]["recorded"][0]["executable"],
            json!(claude)
        );
        assert_eq!(
            f.file(),
            json!({"schema_version":1,"claude":{
                "executable":claude,
                "installed_plugin":f.profile.path().join("current/integrations/claude-mod/plugin"),
                "helper":f.profile.path().join("current/bin/ariadne")}})
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&f.data).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let leftovers: Vec<_> = fs::read_dir(&f.data)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, ["providers.json"]);
    }

    #[test]
    fn a_partial_update_preserves_the_other_agent() {
        let f = fixture();
        let claude = tool(&f.bin, "claude");
        let codex = tool(&f.bin, "codex");
        f.run(&["--agent", "both"]).unwrap();
        let both = f.file();
        assert_eq!(both["codex"]["executable"], json!(codex));
        assert_eq!(
            both["codex"]["home"],
            json!(f.profile.path().join(".codex"))
        );
        let newer = f.profile.path().join("elsewhere");
        fs::create_dir(&newer).unwrap();
        let newer = tool(&newer, "codex");
        f.run(&["--agent", "codex", "--codex-bin", newer.to_str().unwrap()])
            .unwrap();
        let after = f.file();
        assert_eq!(after["codex"]["executable"], json!(newer));
        assert_eq!(after["claude"], both["claude"]);
        assert_eq!(after["claude"]["executable"], json!(claude));
    }

    #[test]
    fn explicit_bin_flag_wins_over_path_and_is_validated() {
        let f = fixture();
        tool(&f.bin, "claude");
        let other = f.profile.path().join("other");
        fs::create_dir(&other).unwrap();
        let explicit = tool(&other, "claude");
        f.run(&[
            "--agent",
            "claude",
            "--claude-bin",
            explicit.to_str().unwrap(),
        ])
        .unwrap();
        assert_eq!(f.file()["claude"]["executable"], json!(explicit));
        for args in [
            vec!["--agent", "claude", "--claude-bin", "relative/claude"],
            vec!["--agent", "claude", "--claude-bin", "/absent/claude"],
            vec![
                "--agent",
                "codex",
                "--claude-bin",
                explicit.to_str().unwrap(),
            ],
            vec!["--agent", "claude", "--claude-bin"],
        ] {
            assert!(f.run(&args).is_err(), "{args:?}");
        }
    }

    #[test]
    fn a_path_symlink_is_recorded_as_found_not_canonicalized() {
        let f = fixture();
        let real = f.profile.path().join("real");
        fs::create_dir(&real).unwrap();
        let target = tool(&real, "claude-real");
        symlink(&target, f.bin.join("claude")).unwrap();
        f.run(&["--agent", "claude"]).unwrap();
        assert_eq!(
            f.file()["claude"]["executable"],
            json!(f.bin.join("claude"))
        );
    }

    #[test]
    fn a_missing_host_is_reported_without_writing_and_setup_still_succeeds() {
        let f = fixture();
        let result = f.run(&["--agent", "claude"]).unwrap();
        assert_eq!(result["providers"]["written"], false);
        assert_eq!(
            result["providers"]["not_recorded"][0]["reason"],
            "No `claude` on PATH; run setup again with --claude-bin /absolute/path"
        );
        assert!(!f.data.exists());
        assert!(result["host_commands"].as_array().unwrap().len() > 1);
        let mut output = Vec::new();
        let mut errors = Vec::new();
        assert_eq!(
            ariadne_cli::setup::run_with_environment(
                &["--agent", "codex"],
                false,
                &f.data,
                &f.version,
                &f.stable,
                &f.environment(),
                &mut output,
                &mut errors
            ),
            0
        );
        let text = String::from_utf8(output).unwrap();
        assert!(
            text.contains("No `codex` on PATH; run setup again with --codex-bin /absolute/path\n")
        );
        assert!(text
            .lines()
            .last()
            .unwrap()
            .starts_with("Quit and reopen Ariadne"));
    }

    #[test]
    fn text_output_names_recorded_paths_and_the_file() {
        let f = fixture();
        let claude = tool(&f.bin, "claude");
        let mut output = Vec::new();
        let mut errors = Vec::new();
        assert_eq!(
            ariadne_cli::setup::run_with_environment(
                &["--agent", "claude"],
                false,
                &f.data,
                &f.version,
                &f.stable,
                &f.environment(),
                &mut output,
                &mut errors
            ),
            0
        );
        let text = String::from_utf8(output).unwrap();
        assert!(text.contains(&format!("Recorded Claude at {}\n", claude.display())));
        assert!(text.contains(&format!(
            "Provider paths file: {}\n",
            f.data.join("providers.json").display()
        )));
        assert!(text.lines().last().unwrap().contains("reopen Ariadne"));
    }

    #[test]
    fn a_symlinked_unsafe_or_malformed_existing_file_is_refused_and_preserved() {
        let f = fixture();
        tool(&f.bin, "claude");
        f.run(&["--agent", "claude"]).unwrap();
        let file = f.data.join("providers.json");
        let original = fs::read(&file).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(f.run(&["--agent", "claude"]).is_err());
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(&file, b"{broken").unwrap();
        assert!(f.run(&["--agent", "claude"]).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"{broken");
        fs::remove_file(&file).unwrap();
        let elsewhere = f.profile.path().join("elsewhere.json");
        fs::write(&elsewhere, &original).unwrap();
        symlink(&elsewhere, &file).unwrap();
        assert!(f.run(&["--agent", "claude"]).is_err());
        assert_eq!(fs::read(&elsewhere).unwrap(), original);
    }
}
