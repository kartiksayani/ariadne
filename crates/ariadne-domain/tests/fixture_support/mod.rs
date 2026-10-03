use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

pub fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

pub fn text(relative: &str) -> String {
    fs::read_to_string(root().join("fixtures/domain").join(relative)).unwrap()
}

pub fn value(relative: &str) -> Value {
    serde_json::from_str(&text(relative)).unwrap()
}

fn validator<T: JsonSchema>() -> jsonschema::Validator {
    let path = root().join(format!(
        "contracts/generated/domain/models/{}.schema.json",
        T::schema_name()
    ));
    let schema: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    jsonschema::draft202012::options()
        .should_validate_formats(true)
        .build(&schema)
        .unwrap()
}

pub fn canonical<T: JsonSchema + DeserializeOwned + Serialize>(relative: &str) -> Value {
    // Read raw JSON first: a Value-only read would discard duplicate map keys.
    let record: T = serde_json::from_str(&text(relative)).unwrap();
    let emitted = serde_json::to_value(record).unwrap();
    assert_eq!(emitted, value(relative), "noncanonical fixture {relative}");
    let schema = validator::<T>();
    assert!(
        schema.is_valid(&emitted),
        "{relative}: {:?}",
        schema.iter_errors(&emitted).collect::<Vec<_>>()
    );
    emitted
}

pub fn invalid<T: JsonSchema + DeserializeOwned>(relative: &str) {
    assert!(
        serde_json::from_str::<T>(&text(relative)).is_err(),
        "Rust accepted {relative}"
    );
    assert!(
        !validator::<T>().is_valid(&value(relative)),
        "published schema accepted {relative}"
    );
}

struct TemporarySource(PathBuf);

impl Drop for TemporarySource {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

pub fn check_typescript(source: &str) {
    // This is a disposable compilation input, never a generated source artifact.
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let directory = TemporarySource(std::env::temp_dir().join(format!(
        "ariadne-domain-fixtures-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )));
    fs::create_dir(&directory.0).unwrap();
    let types = root().join("apps/desktop/src/generated/domain/models/index");
    let source = format!(
        "import type * as D from {};\n{source}",
        serde_json::to_string(&types.to_str().unwrap()).unwrap()
    );
    let file = directory.0.join("canonical.ts");
    fs::write(&file, source).unwrap();
    let output = Command::new("node")
        .arg(root().join("node_modules/typescript/lib/tsc.js"))
        .args([
            "--strict",
            "--noEmit",
            "--skipLibCheck",
            "--target",
            "ES2022",
        ])
        .arg(file)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

pub fn literal(source: &mut String, name: &str, wire_type: &str, value: &Value) {
    source.push_str(&format!(
        "const {name} = {} satisfies {wire_type};\n",
        serde_json::to_string(value).unwrap()
    ));
}

pub fn check_digests() {
    // Node is already needed for TS conformance; reuse its standard crypto API
    // instead of adding a hashing dependency to the production domain crate.
    let output = Command::new("node")
        .args([
            "-e",
            r#"
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const base = process.argv[1];
const hash = body => crypto.createHash('sha256').update(body).digest('hex');
const session = JSON.parse(fs.readFileSync(base + '/demo/session.json', 'utf8'));
for (const input of Object.values(session.inputs)) {
    for (const attempt of input.attempts) {
        assert.equal(attempt.payload_sha256, hash(attempt.formatted_payload));
    }
}
const source = fs.readFileSync(base + '/demo/source-session.json');
for (const continuation of Object.values(session.continuations)) {
    assert.equal(continuation.source_sha256, hash(source));
}
"#,
        ])
        .arg(root().join("fixtures/domain"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
