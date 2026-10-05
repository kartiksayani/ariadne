use ariadne_cli::setup::{package_resources, resources};
use std::process::Command;

#[test]
fn export_uses_canonical_bundle_at_future_path_without_any_filesystem_writes() {
    let home = tempfile::tempdir().unwrap();
    let helper = home.path().join("future version/bin/ariadne");
    let result = package_resources::export(&["--helper-path", helper.to_str().unwrap()]).unwrap();
    assert_eq!(result["schema_version"], 1);
    assert_eq!(result["version"], resources::VERSION);
    for (name, bytes) in resources::bundle(&helper) {
        assert_eq!(result["files"][name].as_str().unwrap().as_bytes(), bytes);
    }
    assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 0);
    let output = Command::new(env!("CARGO_BIN_EXE_ariadne"))
        .args([
            "package-resources",
            "--helper-path",
            helper.to_str().unwrap(),
        ])
        .env_clear()
        .env("HOME", home.path())
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap(),
        result
    );
    assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 0);
}

#[test]
fn exporter_rejects_relative_aliased_missing_and_repeated_arguments() {
    assert!(package_resources::export(&["--helper-path", "/tmp/invalid\0helper"]).is_err());
    for args in [
        vec![],
        vec!["--helper-path"],
        vec!["--helper-path", "relative"],
        vec!["--helper-path", "/tmp/../helper"],
        vec!["--helper-path", "/tmp/./helper"],
        vec!["--helper-path", "/tmp//helper"],
        vec![
            "--helper-path",
            "/tmp/helper",
            "--helper-path",
            "/tmp/other",
        ],
    ] {
        assert!(package_resources::export(&args).is_err(), "{args:?}");
        let output = Command::new(env!("CARGO_BIN_EXE_ariadne"))
            .arg("package-resources")
            .args(args)
            .env_clear()
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
    }
}
