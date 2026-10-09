use super::*;
use ariadne_core::fake::{RecordedRequest, ScriptStep, ScriptedCoreService, ScriptedResponse};
use ariadne_domain::models::*;
use serde_json::json;
fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn context() -> AgentContext {
    AgentContext::from_trusted_entrypoint(
        RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
        id(3),
        id(4),
        AgentReadScope::Terminal {
            issued_through_message_number: NonnegativeSafeInteger::new(0).unwrap(),
        },
    )
}
fn args() -> Value {
    json!({"binding_id":id(3),"generation":id(4),"source_input_id":null,"attempt_id":null,"params":{"selection":{"view":"topics","filters":{"archived":null}},"cursor":null,"limit":20,"item_pages":[]}})
}
#[tokio::test]
async fn valid_domain_error_is_identical_structured_and_text_and_core_runs_off_executor() {
    let arguments = args();
    let call = decode("session_read", arguments.clone()).unwrap();
    let Operation::Query(request) = call.operation else {
        panic!("query")
    };
    let error = CoreError::new(
        CoreErrorCode::RevisionConflict,
        "Snapshot changed.",
        "Refresh the original query.",
    );
    let core = Arc::new(ScriptedCoreService::new([ScriptStep {
        request: RecordedRequest::Query(QueryContext::agent(context()), Box::new(request)),
        response: ScriptedResponse::Query(Box::new(Err(error.clone()))),
    }]));
    let executor = std::thread::current().id();
    let service =
        AgentMcpService::from_trusted_startup(core.clone(), move |b, g, source, attempt| {
            assert_ne!(std::thread::current().id(), executor);
            assert_eq!((b, g, source, attempt), (id(3), id(4), None, None));
            Ok(context())
        })
        .unwrap()
        .with_read_notices(|_, _, _| panic!("failed query must not inspect a snapshot"));
    let result = service
        .call("session_read", arguments.as_object().cloned())
        .await
        .unwrap();
    assert_eq!(result.is_error, Some(true));
    assert_eq!(
        result.structured_content.as_ref().unwrap()["error"],
        serde_json::to_value(error).unwrap()
    );
    let serialized = serde_json::to_value(&result).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(serialized["content"][0]["text"].as_str().unwrap()).unwrap(),
        result.structured_content.unwrap()
    );
    assert_eq!(core.remaining().unwrap(), 0);
}
#[tokio::test]
async fn malformed_arguments_unknown_tools_and_wrong_resolved_scope_never_call_core() {
    let core = Arc::new(ScriptedCoreService::new([]));
    let service =
        AgentMcpService::from_trusted_startup(core.clone(), |_, _, _, _| Ok(context())).unwrap();
    let mut invalid = args();
    invalid["actor"] = json!("owner");
    assert_eq!(
        service
            .call("session_read", invalid.as_object().cloned())
            .await
            .unwrap()
            .is_error,
        Some(true)
    );
    assert!(service
        .call("session_get", args().as_object().cloned())
        .await
        .is_err());
    let mut wrong = args();
    wrong["generation"] = json!(id(44));
    let result = service
        .call("session_read", wrong.as_object().cloned())
        .await
        .unwrap();
    assert_eq!(
        result.structured_content.unwrap()["error"]["code"],
        "binding_mismatch"
    );
    assert!(core.history().unwrap().is_empty());
    let mut huge = args();
    huge["extra"] = json!("x".repeat(512 * 1024));
    assert_eq!(
        service
            .call("session_read", huge.as_object().cloned())
            .await
            .unwrap()
            .is_error,
        Some(true)
    );
    assert!(core.history().unwrap().is_empty());
}
#[tokio::test]
async fn apply_preserves_canonical_request_and_checked_saved_receipt() {
    let request:ApplyRequest=serde_json::from_value(json!({"op_id":id(9),"source_input_id":null,"attempt_id":null,"expected_item_revisions":{},"expected_topic_revisions":{},"summary":"","operations":[],"input_result":null})).unwrap();
    let receipt = SavedReceipt {
        operation_id: id(9),
        session_id: id(2),
        revision: PositiveSafeInteger::new(2).unwrap(),
        data: SavedReceiptData::Apply {
            agent_removals: vec![],
            allocated_refs: UniqueMap(Default::default()),
            messages: vec![],
            item_revisions: UniqueMap(Default::default()),
            topic_revisions: UniqueMap(Default::default()),
            input_result_state: None,
            queue_join_state: None,
            pruned_related: None,
        },
    };
    let core = Arc::new(ScriptedCoreService::new([ScriptStep {
        request: RecordedRequest::Apply(context(), Box::new(request.clone())),
        response: ScriptedResponse::Apply(Box::new(Ok(receipt.clone()))),
    }]));
    let service =
        AgentMcpService::from_trusted_startup(core.clone(), |_, _, _, _| Ok(context())).unwrap();
    let result = service
        .call(
            "apply",
            json!({"binding_id":id(3),"generation":id(4),"request":request})
                .as_object()
                .cloned(),
        )
        .await
        .unwrap();
    assert_eq!(result.is_error, Some(false));
    assert_eq!(
        result.structured_content.unwrap()["data"],
        serde_json::to_value(receipt).unwrap()
    );
    assert_eq!(core.remaining().unwrap(), 0);
}
#[test]
fn canonical_manifest_and_error_budget_are_enforced_without_raw_error_leaks() {
    let tools = manifest().unwrap();
    assert_eq!(
        tools
            .iter()
            .map(|tool| tool.name.as_ref())
            .collect::<Vec<_>>(),
        ["session_read", "item_messages", "item_rounds", "apply"]
    );
    let original: Value = serde_json::from_str(include_str!(
        "../../../../../contracts/generated/core/mcp-tools.json"
    ))
    .unwrap();
    for (tool, original) in tools.iter().zip(original["tools"].as_array().unwrap()) {
        assert_eq!(tool.schema_as_json_value(), original["inputSchema"]);
        assert!(tool.output_schema.is_some());
    }
    assert!(tools.iter().all(|tool| tool
        .description
        .as_deref()
        .is_some_and(|text| text.len() > 20)));
    for name in ariadne_core::delivery::AGENT_QUERY_TOOLS {
        assert!(
            tools.iter().any(|tool| tool.name == name),
            "envelope names MCP tool {name} that is not exposed"
        );
    }
    let mut invalid = CoreError::new(CoreErrorCode::IoError, "x".repeat(8192), "private raw path");
    invalid.retryable = true;
    let value = tool_result(Err(invalid)).structured_content.unwrap();
    assert_eq!(value["error"]["code"], "protocol_conflict");
    assert_eq!(value["error"]["retryable"], false);
    assert!(!value.to_string().contains("private raw path"));
    let value = tool_result(Ok(json!({"body":"x".repeat(1024*1024)})))
        .structured_content
        .unwrap();
    assert_eq!(value["error"]["code"], "capacity_exceeded");
    assert!(value.to_string().len() < 1024 * 1024);
}

#[test]
fn apply_tool_schema_offers_an_optional_bounded_short_label() {
    let tools = manifest().unwrap();
    let apply = tools.iter().find(|tool| tool.name == "apply").unwrap();
    let schema = apply.schema_as_json_value();
    let defs = &schema["$defs"];
    let mut labelled = Vec::new();
    for operation in defs["Operation"]["oneOf"].as_array().unwrap() {
        let Some(short) = operation["properties"].get("short") else {
            continue;
        };
        assert_eq!(short["maxLength"], 40);
        assert_eq!(short["type"], json!(["string", "null"]));
        assert!(!operation["required"]
            .as_array()
            .unwrap()
            .contains(&json!("short")));
        labelled.push(operation["properties"]["op"]["const"].clone());
    }
    assert_eq!(labelled, [json!("topic.add"), json!("item.add")]);
    let patch = &defs["ItemPatch"];
    assert_eq!(patch["properties"]["short"]["maxLength"], 40);
    assert!(!patch["required"]
        .as_array()
        .unwrap()
        .contains(&json!("short")));
}

#[tokio::test]
async fn native_session_reads_report_only_authorized_removed_counts_as_text() {
    use ariadne_store::{registry::Registry, session::Store};
    let data = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(data.path()).unwrap();
    registry.register(root.path(), &id(99), || id(1)).unwrap();
    let store = Store::open_registered(&registry.project_dir(&id(1)), id(1)).unwrap();
    let seed = include_str!("../../../../../fixtures/domain/history/seed.json");
    store
        .create(&serde_json::from_str::<Session>(seed).unwrap())
        .unwrap();
    let foreign: Session = serde_json::from_str(
        &seed
            .replace(id(2).as_str(), id(12).as_str())
            .replace(id(3).as_str(), id(13).as_str())
            .replace(id(4).as_str(), id(14).as_str()),
    )
    .unwrap();
    store.create(&foreign).unwrap();
    let service = crate::native::service_at(&data.path().join(".ariadne")).unwrap();
    let apply =
        |binding: UuidV4, generation: UuidV4, op: u64, revisions: Value, operation: Value| {
            json!({"binding_id":binding,"generation":generation,"request":{
                "op_id":id(op),"source_input_id":null,"attempt_id":null,
                "expected_item_revisions":revisions["items"],
                "expected_topic_revisions":revisions["topics"],
                "summary":"","operations":[operation],"input_result":null
            }})
        };
    let result = service
        .call(
            "apply",
            apply(
                id(13),
                id(14),
                100,
                json!({"items":{},"topics":{id(5).as_str():1}}),
                json!({"op":"topic.delete","topic":{"id":id(5)}}),
            )
            .as_object()
            .cloned(),
        )
        .await
        .unwrap();
    assert_eq!(result.is_error, Some(false), "{result:?}");

    let mut read = args();
    read["params"]["selection"] = json!({"view":"items","filters":{
        "topic_id":null,"item_id":null,"parent_item_id":null,"statuses":[],"archived":null
    }});
    let live = service
        .call("session_read", read.as_object().cloned())
        .await
        .unwrap();
    assert_eq!(live.is_error, Some(false), "{live:?}");
    assert_eq!(
        live.content.len(),
        1,
        "foreign removals must not produce notices"
    );
    assert_eq!(
        live.structured_content.unwrap()["data"]["data"]["page"]["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    let result = service
        .call(
            "apply",
            apply(
                id(3),
                id(4),
                101,
                json!({"items":{"1":1},"topics":{}}),
                json!({"op":"item.delete","item":{"id":"1"}}),
            )
            .as_object()
            .cloned(),
        )
        .await
        .unwrap();
    assert_eq!(result.is_error, Some(false), "{result:?}");
    let partial = service
        .call("session_read", read.as_object().cloned())
        .await
        .unwrap();
    let encoded = serde_json::to_value(&partial).unwrap();
    assert_eq!(encoded["content"][1]["text"], "1 removed items not shown");
    assert_eq!(partial.content.len(), 2);
    assert!(encoded["structuredContent"]["data"]
        .get("notices")
        .is_none());
    assert_eq!(
        serde_json::from_str::<Value>(encoded["content"][0]["text"].as_str().unwrap()).unwrap(),
        encoded["structuredContent"]
    );
    assert!(!encoded.to_string().contains("Which release approach?"));

    let result = service
        .call(
            "apply",
            apply(
                id(3),
                id(4),
                102,
                json!({"items":{},"topics":{id(5).as_str():1}}),
                json!({"op":"topic.delete","topic":{"id":id(5)}}),
            )
            .as_object()
            .cloned(),
        )
        .await
        .unwrap();
    assert_eq!(result.is_error, Some(false), "{result:?}");
    let empty = service
        .call("session_read", read.as_object().cloned())
        .await
        .unwrap();
    let encoded = serde_json::to_value(empty).unwrap();
    assert_eq!(encoded["content"][1]["text"], "2 removed items not shown");
    assert_eq!(encoded["content"][2]["text"], "1 removed topics not shown");
    assert_eq!(
        encoded["structuredContent"]["data"]["data"]["page"]["items"],
        json!([])
    );

    let topics = service
        .call("session_read", args().as_object().cloned())
        .await
        .unwrap();
    let encoded = serde_json::to_value(topics).unwrap();
    assert_eq!(encoded["content"][1]["text"], "1 removed topics not shown");
    assert_eq!(encoded["content"].as_array().unwrap().len(), 2);
}
