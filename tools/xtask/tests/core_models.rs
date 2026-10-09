use ariadne_core::*;
use ariadne_xtask::core_models::{artifacts, SCHEMAS, TYPES};
use schemars::JsonSchema;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;
#[path = "../../../tests/support/core_service/mod.rs"]
#[allow(dead_code)]
mod cases;
fn root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
}
fn validate(files: &std::collections::BTreeMap<PathBuf, String>, name: &str, value: &Value) {
    let schema: Value =
        serde_json::from_str(&files[&Path::new(SCHEMAS).join(format!("{name}.schema.json"))])
            .unwrap();
    let validator = jsonschema::draft202012::options()
        .should_validate_formats(true)
        .build(&schema)
        .unwrap();
    assert!(
        validator.is_valid(value),
        "{name}: {value}: {:?}",
        validator.iter_errors(value).collect::<Vec<_>>()
    );
}
#[test]
fn shared_cases_validate_against_exact_generated_transport_schemas() {
    let files = artifacts().unwrap();
    let all = ariadne_xtask::artifacts().unwrap();
    let corpus: Value = serde_json::from_slice(
        &std::fs::read(root().join("fixtures/contracts/core/cases.json")).unwrap(),
    )
    .unwrap();
    cases::load(root());
    for case in corpus["cases"].as_array().unwrap() {
        for step in case["steps"].as_array().unwrap() {
            let (request, response) = match step["method"].as_str().unwrap() {
                "query" => (
                    Some(("QueryRequest".to_owned(), &step["request"])),
                    Some((QueryEnvelope::schema_name().into_owned(), &step["response"])),
                ),
                "owner" => (
                    Some(("OwnerCommand".to_owned(), &step["request"])),
                    Some((
                        MutationEnvelope::schema_name().into_owned(),
                        &step["response"],
                    )),
                ),
                "apply" => (
                    Some(("ApplyRequest".to_owned(), &step["request"])),
                    Some((ApplyEnvelope::schema_name().into_owned(), &step["response"])),
                ),
                "claim" => (
                    Some(("ClaimRequest".to_owned(), &step["request"])),
                    Some((ClaimEnvelope::schema_name().into_owned(), &step["response"])),
                ),
                "report" => {
                    let schema: Value = serde_json::from_str(
                        &all[Path::new("contracts/generated/adapter/NormalizedEvent.schema.json")],
                    )
                    .unwrap();
                    assert!(jsonschema::validator_for(&schema)
                        .unwrap()
                        .is_valid(&step["event"]));
                    (
                        None,
                        Some((
                            ReportEnvelope::schema_name().into_owned(),
                            &step["response"],
                        )),
                    )
                }
                "checkpoint" => (None, None),
                other => panic!("Unknown method {other}"),
            };
            if let Some((name, value)) = request {
                validate(&files, &name, value);
            }
            if let Some((name, value)) = response {
                validate(&files, &name, value);
            }
        }
    }
    // All runtime/CLI/MCP/Tauri output references name real emitted schemas.
    for name in ["mcp-tools.json", "service.json"] {
        let manifest: Value = serde_json::from_str(&files[&Path::new(SCHEMAS).join(name)]).unwrap();
        let refs: Vec<&str> = if name == "mcp-tools.json" {
            manifest["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tool| tool["output_schema"].as_str().unwrap())
                .collect()
        } else {
            manifest["entrypoints"]
                .as_object()
                .unwrap()
                .values()
                .map(|entry| entry["result"].as_str().unwrap())
                .collect()
        };
        for schema in refs {
            assert!(files.contains_key(&Path::new(SCHEMAS).join(format!("{schema}.schema.json"))));
        }
    }
    assert!(!files
        .keys()
        .any(|path| path.to_string_lossy().contains("Context")));
}

#[test]
fn desktop_hints_and_io_errors_use_canonical_generated_wire_records() {
    let files = artifacts().unwrap();
    let routing = cases::load(root()).routing;
    let route = serde_json::json!({"project_id":routing.project_id,"session_id":routing.session_id,"item_id":null});
    validate(&files, "OpenRoute", &route);
    let schema: Value =
        serde_json::from_str(&files[&Path::new(SCHEMAS).join("OpenRoute.schema.json")]).unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();
    let mut invalid = route.clone();
    invalid["path"] = serde_json::json!("/unregistered/root");
    assert!(!validator.is_valid(&invalid));
    invalid = route.clone();
    invalid["item_id"] = serde_json::json!("0.1");
    assert!(!validator.is_valid(&invalid));
    validate(
        &files,
        "SessionChangedHint",
        &serde_json::json!({"session_id":routing.session_id,"revision":2}),
    );
    let error = CoreError::new(
        CoreErrorCode::IoError,
        "Cannot read session.",
        "Check local access.",
    );
    validate(&files, "CoreError", &serde_json::to_value(error).unwrap());
    let declaration = &files[&Path::new(TYPES).join("index.ts")];
    assert!(declaration.contains("item_id: ItemRef | null"));
    assert!(declaration.contains("observation: PresenceObservation"));
    assert!(declaration.contains("\"io_error\""));
}
#[test]
fn independent_typescript_consumer_accepts_all_shared_cases_and_rejects_local_forks() {
    let temp = tempfile::tempdir().unwrap();
    let corpus: Value = serde_json::from_slice(
        &std::fs::read(root().join("fixtures/contracts/core/cases.json")).unwrap(),
    )
    .unwrap();
    let mut source=format!("import type {{ QueryRequest, OwnerCommand, ApplyRequest, ClaimRequest, QueryEnvelope, MutationEnvelope, ApplyEnvelope, ClaimEnvelope, ReportEnvelope, AgentReadToolRequest, ItemPatch }} from '{}';\n",root().join(TYPES).join("index").display());
    for (index, step) in corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|case| case["steps"].as_array().unwrap())
        .enumerate()
    {
        let (request, response) = match step["method"].as_str().unwrap() {
            "query" => (Some("QueryRequest"), Some("QueryEnvelope")),
            "owner" => (Some("OwnerCommand"), Some("MutationEnvelope")),
            "apply" => (Some("ApplyRequest"), Some("ApplyEnvelope")),
            "claim" => (Some("ClaimRequest"), Some("ClaimEnvelope")),
            "report" => (None, Some("ReportEnvelope")),
            "checkpoint" => (None, None),
            _ => unreachable!(),
        };
        if let Some(kind) = request {
            source.push_str(&format!(
                "const request{index}: {kind} = {};\n",
                step["request"]
            ));
        }
        if let Some(kind) = response {
            source.push_str(&format!(
                "const response{index}: {kind} = {};\n",
                step["response"]
            ));
        }
    }
    source.push_str("const clearedNote: ItemPatch = { question:null, type:null, note:null, links:null };\nconst unchangedNote: ItemPatch = { question:null, type:null, links:null };\n");
    source.push_str("// @ts-expect-error required explicit binding routing\nconst noRouting: AgentReadToolRequest = { params: { selection:{view:'topics',filters:{archived:null}},cursor:null,limit:1,item_pages:[] },source_input_id:null,attempt_id:null };\n");
    source.push_str("// @ts-expect-error owner snapshot is no model tool\nconst ownerTool: AgentReadToolRequest = { binding_id:'b',generation:'g',source_input_id:null,attempt_id:null,params:{command:'session_get',params:{project_id:'p',session_id:'s'}} };\n");
    source.push_str("// @ts-expect-error cursor remains structured\nconst opaqueCursor: QueryRequest = { command:'item_messages',params:{item_id:'1',cursor:'opaque',limit:1} };\n");
    source.push_str("// @ts-expect-error agent cannot choose arbitrary actor or paths\nconst actor: ApplyRequest = { actor:'owner' };\n");
    let fixture = temp.path().join("consumer.ts");
    std::fs::write(&fixture, source).unwrap();
    let result = Command::new("node")
        .arg(root().join("node_modules/typescript/lib/tsc.js"))
        .args([
            "--strict",
            "--noEmit",
            "--skipLibCheck",
            "--target",
            "ES2022",
            "--module",
            "ESNext",
            "--moduleResolution",
            "bundler",
        ])
        .arg(fixture)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn delete_operations_and_restore_commands_share_strict_generated_contracts() {
    let files = artifacts().unwrap();
    let topic = "00000000-0000-4000-8000-000000000001";
    for operation in [
        serde_json::json!({"op":"item.delete","item":{"id":"1.2"}}),
        serde_json::json!({"op":"topic.delete","topic":{"id":topic}}),
        serde_json::json!({"op":"item.delete","item":{"ref":"duplicate"}}),
        serde_json::json!({"op":"topic.delete","topic":{"ref":"obsolete"}}),
    ] {
        validate(&files, "Operation", &operation);
        let typed: Operation = serde_json::from_value(operation.clone()).unwrap();
        assert_eq!(serde_json::to_value(typed).unwrap(), operation);
        let mut invalid = operation;
        invalid["permanent"] = serde_json::json!(true);
        assert!(serde_json::from_value::<Operation>(invalid).is_err());
    }
    for (command, params) in [
        (
            "item_restore",
            serde_json::json!({"item_id":"1.2","expected_revision":2}),
        ),
        (
            "topic_removed_restore",
            serde_json::json!({"topic_id":topic,"expected_revision":2}),
        ),
    ] {
        let value =
            serde_json::json!({"command":command,"api_version":1,"op_id":topic,"params":params});
        validate(&files, "OwnerCommand", &value);
        let typed: OwnerCommand = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(typed).unwrap(), value);
    }
}
