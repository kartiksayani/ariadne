use ariadne_xtask::{arguments, artifacts, generate};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::process::Command;

fn root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
}

#[test]
fn real_cli_and_checked_in_artifacts_are_current() {
    generate(root(), true).unwrap();
    let binary = env!("CARGO_BIN_EXE_ariadne-xtask");
    assert!(Command::new(binary)
        .args(["gen-contracts", "--check"])
        .status()
        .unwrap()
        .success());
    assert!(!Command::new(binary)
        .arg("unknown")
        .status()
        .unwrap()
        .success());
    assert!(arguments(&["gen-contracts".into()]).is_ok_and(|check| !check));
    assert!(arguments(&["gen-contracts".into(), "--check".into(), "extra".into()]).is_err());
}

#[test]
fn generation_is_deterministic_and_check_is_read_only() {
    let temp = tempfile::tempdir().unwrap();
    assert!(generate(temp.path(), true).is_err());
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
    generate(temp.path(), false).unwrap();
    let expected = artifacts().unwrap();
    assert_eq!(
        expected.len(),
        16 + ariadne_xtask::domain_models::artifacts().unwrap().len()
    );
    assert_eq!(artifacts().unwrap(), expected);
    generate(temp.path(), true).unwrap();
    let mut modified = Vec::new();
    for (path, text) in &expected {
        let file = temp.path().join(path);
        modified.push((file.clone(), file.metadata().unwrap().modified().unwrap()));
        assert_eq!(fs::read_to_string(file).unwrap(), *text);
    }
    generate(temp.path(), true).unwrap();
    for (file, before) in modified {
        assert_eq!(file.metadata().unwrap().modified().unwrap(), before);
    }
    generate(temp.path(), false).unwrap();
    for (path, text) in expected {
        assert_eq!(fs::read_to_string(temp.path().join(path)).unwrap(), text);
    }
}

#[test]
fn drift_missing_extra_and_symlink_artifacts_fail_without_mutation() {
    let temp = tempfile::tempdir().unwrap();
    generate(temp.path(), false).unwrap();
    let files = artifacts().unwrap();
    let first = temp.path().join(files.keys().next().unwrap());
    fs::write(&first, "stale").unwrap();
    assert!(generate(temp.path(), true).unwrap_err().contains("Stale"));
    assert_eq!(fs::read_to_string(&first).unwrap(), "stale");
    generate(temp.path(), false).unwrap();
    fs::remove_file(&first).unwrap();
    assert!(generate(temp.path(), true).is_err());
    generate(temp.path(), false).unwrap();
    let extra = first.parent().unwrap().join("unexpected.json");
    fs::write(&extra, "retained").unwrap();
    assert!(generate(temp.path(), true)
        .unwrap_err()
        .contains("Unexpected"));
    assert!(generate(temp.path(), false).is_err());
    assert_eq!(fs::read_to_string(&extra).unwrap(), "retained");
    fs::remove_file(&extra).unwrap();
    let folder = first.parent().unwrap().join("unexpected-directory");
    fs::create_dir(&folder).unwrap();
    assert!(generate(temp.path(), true).is_err());
    fs::remove_dir(folder).unwrap();
    #[cfg(unix)]
    {
        fs::remove_file(&first).unwrap();
        let outside = temp.path().join("outside");
        fs::write(&outside, "retained").unwrap();
        std::os::unix::fs::symlink(&outside, &first).unwrap();
        assert!(generate(temp.path(), true).is_err());
        assert!(generate(temp.path(), false).is_err());
        assert_eq!(fs::read_to_string(outside).unwrap(), "retained");
        let other = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(temp.path(), other.path().join("contracts")).unwrap();
        assert!(generate(other.path(), false)
            .unwrap_err()
            .contains("symlinked"));
    }
}

#[test]
fn generated_json_schema_validates_primitive_boundaries() {
    let files = artifacts().unwrap();
    for (name, good, bad) in [
        (
            "UuidV4",
            json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            json!("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"),
        ),
        (
            "ItemRef",
            json!("9007199254740991.1"),
            json!("9007199254740992"),
        ),
        (
            "UtcMillis",
            json!("2024-02-29T23:59:60.123Z"),
            json!("2024-02-29T12:34:60.123Z"),
        ),
        ("SchemaVersion", json!(1), json!(2)),
        ("PositiveSafeInteger", json!(9007199254740991_u64), json!(0)),
        (
            "NonnegativeSafeInteger",
            json!(0),
            json!(9007199254740992_u64),
        ),
        ("Sha256", json!("a".repeat(64)), json!("A".repeat(64))),
        ("RequestRef", json!("Query_1"), json!("1Query")),
    ] {
        let path = format!("contracts/generated/domain/primitives/{name}.schema.json");
        let schema: Value = serde_json::from_str(&files[Path::new(&path)]).unwrap();
        let validator = jsonschema::draft202012::options()
            .should_validate_formats(true)
            .build(&schema)
            .unwrap();
        assert!(validator.is_valid(&good), "{name} {good}");
        assert!(!validator.is_valid(&bad), "{name} {bad}");
    }
}

#[test]
fn generated_typescript_checks_wire_assignments() {
    let temp = tempfile::tempdir().unwrap();
    let files = artifacts().unwrap();
    let mut source = String::new();
    for (path, text) in files {
        if path.starts_with("apps/desktop/src/generated/domain/primitives") {
            source.push_str(&text);
        }
    }
    source.push_str("\nconst id: UuidV4 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';\n");
    source.push_str(
        "const item: ItemRef = '1.2'; const time: UtcMillis = '2024-02-29T12:34:56.123Z';\n",
    );
    source.push_str("const schema: SchemaVersion = 1; const count: PositiveSafeInteger = 1;\n");
    source.push_str("const zero: NonnegativeSafeInteger = 0; const digest: Sha256 = 'a'.repeat(64); const ref: RequestRef = 'Query';\n");
    source.push_str("// @ts-expect-error wrong scalar wire type\nconst wrongId: UuidV4 = 1;\n");
    source.push_str(
        "// @ts-expect-error schema version is literal 1\nconst wrongSchema: SchemaVersion = 2;\n",
    );
    source.push_str("// @ts-expect-error counters are number, never bigint\nconst wrongCount: PositiveSafeInteger = 1n;\n");
    source.push_str(
        "// @ts-expect-error required scalar cannot be null\nconst wrongRef: RequestRef = null;\n",
    );
    source.push_str(
        "// @ts-expect-error item references are strings\nconst wrongItem: ItemRef = 2;\n",
    );
    source.push_str(
        "// @ts-expect-error timestamps are strings\nconst wrongTime: UtcMillis = new Date();\n",
    );
    source.push_str("// @ts-expect-error nonnegative counters are numbers\nconst wrongZero: NonnegativeSafeInteger = '0';\n");
    source.push_str(
        "// @ts-expect-error digests are strings\nconst wrongDigest: Sha256 = new Uint8Array();\n",
    );
    let fixture = temp.path().join("wire.ts");
    fs::write(&fixture, source).unwrap();
    let output = Command::new("node")
        .arg(root().join("node_modules/typescript/lib/tsc.js"))
        .args([
            "--strict",
            "--noEmit",
            "--skipLibCheck",
            "--target",
            "ES2022",
        ])
        .arg(fixture)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
