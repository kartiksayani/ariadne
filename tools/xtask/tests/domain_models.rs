use ariadne_xtask::domain_models;
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
fn complete_model_artifacts_are_deterministic_and_schema_roots_are_valid() {
    let files = domain_models::artifacts().unwrap();
    assert_eq!(domain_models::artifacts().unwrap(), files);
    for (path, text) in &files {
        if path
            .extension()
            .is_some_and(|extension| extension == "json")
        {
            let schema: Value = serde_json::from_str(text).unwrap();
            jsonschema::draft202012::options()
                .should_validate_formats(true)
                .build(&schema)
                .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        }
    }
    for name in [
        "Project",
        "Session",
        "Topic",
        "Item",
        "Message",
        "Answer",
        "Round",
        "Binding",
        "Input",
        "Attempt",
        "DomainResult",
        "OperationReceipt",
        "SavedReceipt",
        "ContinuationReceipt",
        "SummaryCounts",
        "QueryCursor",
        "ItemMessagesProjection",
        "ItemRoundsProjection",
        "ItemReadProjection",
        "ProjectSummary",
        "SessionSummary",
    ] {
        assert!(
            files.contains_key(Path::new(&format!(
                "{}/{name}.schema.json",
                domain_models::SCHEMAS
            ))),
            "{name}"
        );
    }
    for name in [
        "Message",
        "Answer",
        "RoundProjection",
        "ItemLink",
        "StatusHistoryEntry",
    ] {
        assert!(files.contains_key(Path::new(&format!(
            "{}/Page_{name}.schema.json",
            domain_models::SCHEMAS
        ))));
    }
    let schema: Value = serde_json::from_str(
        &files[Path::new(&format!("{}/ItemOwner.schema.json", domain_models::SCHEMAS))],
    )
    .unwrap();
    let validator = jsonschema::draft202012::options().build(&schema).unwrap();
    assert!(validator.is_valid(&json!({"kind":"me"})));
    assert!(!validator.is_valid(&json!({"kind":"agent"})));
    assert!(!validator
        .is_valid(&json!({"kind":"me","binding_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"})));
}

#[test]
fn generated_model_types_check_tagged_nullable_generic_and_map_assignments() {
    let temp = tempfile::tempdir().unwrap();
    let mut files = ariadne_xtask::artifacts().unwrap();
    files.extend(domain_models::artifacts().unwrap());
    for (path, text) in files {
        let target = temp.path().join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, text).unwrap();
    }
    let fixture = temp.path().join("wire.ts");
    fs::write(&fixture, r#"
import type { ItemOwner, EndpointRef, EndpointFingerprint, AdapterConfig, Page, Message, QueryCursor, SummaryCounts,
    SavedReceiptData, OwnerResolutionEvidence, ItemSnapshot, RoundSnapshot } from './apps/desktop/src/generated/domain/models';
const me: ItemOwner = {kind:'me'};
const agent: ItemOwner = {kind:'agent',binding_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
const other: ItemOwner = {kind:'other',name:'Reviewer'};
const endpoint: EndpointRef = {kind:'unix_socket',path:'/tmp/provider.sock'};
const fingerprint: EndpointFingerprint = 'opaque identity, not a hash';
const config: AdapterConfig = {namespace:'example',values:{nested:[null,true,12.5,{key:'value'}]}};
const cursor: QueryCursor = {schema:1,view:'round_owner_messages',filter_digest:'a'.repeat(64),after:{kind:'sequence',number:1,id:'id'},revision:1};
const page: Page<Message> = {items:[],next_cursor:null,snapshot_revision:1};
const counts: SummaryCounts = {items_by_status:{open:0,waiting_on_me:1,in_progress:0,decided:0,done:0,dropped:0,replaced:0},
    waiting_unanswered:1,sent_inputs:{queued:0,in_flight:0,needs_attention:0},archived_topics:0,completeness:'partial',unavailable_session_ids:['id']};
const receipt: SavedReceiptData = {kind:'apply',allocated_refs:{child:{kind:'item',id:'1.1'}},messages:[{id:'id',number:1}],
    item_revisions:{'1':1},topic_revisions:{id:1},input_result_state:null,queue_join_state:null};
const evidence: OwnerResolutionEvidence = {source:'owner_attestation',turn_state:'completed',host_turn_id:null,owner_attested_idle:true,at:'time'};
// @ts-expect-error agent owner requires binding identity
const missingBinding: ItemOwner = {kind:'agent'};
// @ts-expect-error endpoint union has no remote transport
const tcp: EndpointRef = {kind:'tcp',path:'localhost'};
// @ts-expect-error canonical config value is JSON, never a callback
const callback: AdapterConfig = {namespace:'example',values:{run:()=>true}};
// @ts-expect-error collections are required
const incompletePage: Page<Message> = {next_cursor:null,snapshot_revision:1};
// @ts-expect-error canonical emitted cursor is required even when null
const omittedCursor: Page<Message> = {items:[],snapshot_revision:1};
// @ts-expect-error counter is numeric
const badReceipt: SavedReceiptData = {kind:'input_cancel',input_id:'id',state:12};
// @ts-expect-error owner evidence cannot claim adapter observation
const wrongSource: OwnerResolutionEvidence = {source:'adapter_observation',turn_state:'completed',host_turn_id:null,owner_attested_idle:true,at:'time'};
// @ts-expect-error bounded item projection has no unbounded backlinks array
const itemKeys: keyof ItemSnapshot = 'updated_message_ids';
// @ts-expect-error round historical messages must be independent pages
const roundKeys: keyof RoundSnapshot = 'owner_message_ids';
const messageOrigin: Message['origin'] = {project_id:'id',session_id:'id',topic_id:'id',entity_id:'id',source_revision:1,
    source_target:{project_id:'source-project',session_id:'source-session',topic_id:null,item_id:null,round_id:null},
    author:'agent',binding_id:null,adapter_id:'source.adapter',external_session_id:'source-thread'};
// @ts-expect-error direct source provenance is required
const missingSourceTarget: Message['origin'] = {project_id:'id',session_id:'id',topic_id:'id',entity_id:'id',source_revision:1,author:'agent',binding_id:null,adapter_id:null,external_session_id:null};
// @ts-expect-error provenance keeps its author
const badOrigin: Message['origin'] = {project_id:'id',session_id:'id',topic_id:'id',entity_id:'id',source_revision:1};
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
