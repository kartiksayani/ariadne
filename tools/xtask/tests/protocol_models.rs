use ariadne_xtask::protocol_models;
use serde_json::Value;
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
fn protocol_generation_is_deterministic_and_event_roots_reuse_the_domain_contract() {
    let files = protocol_models::artifacts().unwrap();
    assert_eq!(files, protocol_models::artifacts().unwrap());
    assert_eq!(files.len(), 26);
    for (path, text) in &files {
        if path.extension().is_some_and(|value| value == "json") {
            let schema: Value = serde_json::from_str(text).unwrap();
            jsonschema::draft202012::options()
                .should_validate_formats(true)
                .build(&schema)
                .unwrap();
        }
    }
    let schema: Value = serde_json::from_str(
        &files[Path::new("contracts/generated/adapter/NormalizedEvent.schema.json")],
    )
    .unwrap();
    let validator = jsonschema::draft202012::options()
        .should_validate_formats(true)
        .build(&schema)
        .unwrap();
    let events: Vec<Value> = serde_json::from_str(
        &fs::read_to_string(root().join("fixtures/contracts/adapter/events.json")).unwrap(),
    )
    .unwrap();
    for event in events {
        assert!(validator.is_valid(&event), "{event}");
    }
    let types = &files[Path::new("apps/desktop/src/generated/adapter/index.ts")];
    assert!(types.contains("from '../domain/models'"));
    for domain_type in [
        "Capabilities",
        "Checkpoint",
        "EndpointRef",
        "HostReceipt",
        "PresenceObservation",
    ] {
        assert!(
            !types.contains(&format!("export type {domain_type} =")),
            "{domain_type}"
        );
    }
}

#[test]
fn generated_adapter_types_enforce_tags_owned_fields_and_emitted_nullability() {
    let temp = tempfile::tempdir().unwrap();
    for (path, text) in ariadne_xtask::artifacts().unwrap() {
        let target = temp.path().join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, text).unwrap();
    }
    let fixture = temp.path().join("wire.ts");
    fs::write(&fixture,r#"
import type { NormalizedEvent, ProbeRequest, ProbeResult, ConnectRequest, SubmitRequest, SubmitOutcome,
    ObserveRequest, ObserveResult, ReconcileRequest, ReconcileResult, DisconnectRequest, DisconnectResult, AdapterError } from './apps/desktop/src/generated/adapter';
const probe:ProbeRequest={endpoint:{kind:'local_bridge',name:'registered'},configuration:{namespace:'test',values:{}}};
const probeResult:ProbeResult={host_version:null,compatibility:'unknown',availability:'unknown',setup_steps:[]};
const connect:ConnectRequest={...probe,binding_id:'b',generation:'g',external_session_id:'session'};
const submit:SubmitRequest={binding_id:'b',generation:'g',input_id:'i',attempt_id:'a',formatted_payload:'persisted',payload_sha256:'digest',wire_marker:'marker'};
const submitted:SubmitOutcome={kind:'accepted',receipt:null};
const observe:ObserveRequest={binding_id:'b',generation:'g',checkpoint:null,limit:100};
const observed:ObserveResult={events:[],next_checkpoint:null};
const reconcile:ReconcileRequest={binding_id:'b',generation:'current',checkpoint:null,attempts:[{input_id:'i',attempt_id:'a',binding_generation:'old',payload_sha256:'digest',wire_marker:'marker',host_turn_id:null}]};
const reconciled:ReconcileResult={attempt_evidence:[],unresolved_attempt_ids:['a'],next_checkpoint:null};
const disconnect:DisconnectRequest={binding_id:'b',generation:'g'};const disconnected:DisconnectResult={};
const base={event_id:'native',binding_id:'b',generation:'g',input_id:'i',attempt_id:'a',host_turn_id:'turn',observed_at:'time'};
const finished:NormalizedEvent={...base,kind:'turn_finished',payload:{status:'completed',reason:null,diagnostic_text:null,truncated:false}};
const output:NormalizedEvent={...base,kind:'visible_output',payload:{host_message_id:null,phase:'final',operation:'append',text:'Visible',truncated:false,gap_before:false}};
const error:AdapterError={code:'unsupported_host_version',message:'Use the tested version',retryable:false};
// @ts-expect-error accepted receipt is required even when null
const omittedReceipt:SubmitOutcome={kind:'accepted'};
// @ts-expect-error checkpoint is emitted explicitly
const omittedCheckpoint:ObserveRequest={binding_id:'b',generation:'g',limit:1};
// @ts-expect-error reconcile entries require originating generation
const incompleteEvidence:ReconcileRequest={binding_id:'b',generation:'current',checkpoint:null,attempts:[{input_id:'i',attempt_id:'a',payload_sha256:'digest',wire_marker:'marker',host_turn_id:null}]};
// @ts-expect-error enum has no provider wire tag
const providerEvent:NormalizedEvent={...base,kind:'codex_queue_response',payload:{}};
// @ts-expect-error turn status cannot be running
const wrongFinished:NormalizedEvent={...base,kind:'turn_finished',payload:{status:'running',reason:null,diagnostic_text:null,truncated:false}};
// @ts-expect-error visible-output gap/truncation fields are required
const hiddenGap:NormalizedEvent={...base,kind:'visible_output',payload:{host_message_id:null,phase:'final',operation:'append',text:'Visible'}};
// @ts-expect-error error vocabulary is typed
const rawError:AdapterError={code:'raw_stderr',message:'bad',retryable:true};
"#).unwrap();
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
