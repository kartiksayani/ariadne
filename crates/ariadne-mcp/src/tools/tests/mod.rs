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
        [
            "session_read",
            "item_messages",
            "item_changes",
            "item_rounds",
            "apply"
        ]
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
    assert_eq!(
        labelled,
        [json!("topic.add"), json!("topic.edit"), json!("item.add")]
    );
    let patch = &defs["ItemPatch"];
    assert_eq!(patch["properties"]["short"]["maxLength"], 40);
    assert!(!patch["required"]
        .as_array()
        .unwrap()
        .contains(&json!("short")));
}

#[tokio::test]
async fn strict_apply_refuses_cross_kind_overlap_instead_of_cli_repair() {
    use ariadne_store::{registry::Registry, session::Store};
    let data = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(data.path()).unwrap();
    registry.register(root.path(), &id(99), || id(1)).unwrap();
    let store = Store::open_registered(&registry.project_dir(&id(1)), id(1)).unwrap();
    let seed: Session = serde_json::from_str(include_str!(
        "../../../../../fixtures/domain/history/seed.json"
    ))
    .unwrap();
    store.create(&seed).unwrap();
    let service = crate::native::service_at(&data.path().join(".ariadne")).unwrap();
    for (index, kinds) in [
        ["related", "affects"],
        ["related", "depends_on"],
        ["affects", "depends_on"],
    ]
    .into_iter()
    .enumerate()
    {
        let result = service.call("apply", json!({"binding_id":id(3), "generation":id(4), "request":{
            "op_id":id(400 + index as u64), "source_input_id":null, "attempt_id":null,
            "expected_item_revisions":{"1":1}, "expected_topic_revisions":{}, "summary":"",
            "operations":[{"op":"item.edit", "item":{"id":"1"}, "reason":"A typed link is intended",
                "patch":{(kinds[0]):[{"id":"2"}], (kinds[1]):[{"id":"2"}]}}], "input_result":null
        }}).as_object().cloned()).await.unwrap();
        assert_eq!(result.is_error, Some(true), "{kinds:?}: {result:?}");
        assert_eq!(
            result.structured_content.unwrap()["error"]["code"],
            "invalid_ref"
        );
        assert_eq!(store.read(&id(2)).unwrap(), seed);
    }
}

#[test]
fn apply_schema_exposes_topic_briefs_reasons_and_every_link_kind() {
    let tools = manifest().unwrap();
    let apply = tools.iter().find(|tool| tool.name == "apply").unwrap();
    let schema = apply.schema_as_json_value();
    let defs = &schema["$defs"];
    let operation = |tag: &str| {
        defs["Operation"]["oneOf"]
            .as_array()
            .unwrap()
            .iter()
            .find(|operation| operation["properties"]["op"]["const"] == tag)
            .unwrap()
    };
    for tag in ["topic.add", "topic.edit"] {
        assert_eq!(operation(tag)["properties"]["brief"]["maxLength"], 1200);
    }
    assert_eq!(
        operation("item.edit")["properties"]["reason"]["maxLength"],
        280
    );
    assert!(operation("item.status")["properties"]["reason"]
        .get("maxLength")
        .is_none());
    assert_eq!(
        operation("item.edit")["properties"]["wording_only"]["type"],
        "boolean"
    );
    assert!(!operation("item.edit")["required"]
        .as_array()
        .unwrap()
        .contains(&json!("wording_only")));
    for kind in ["related", "affects", "depends_on"] {
        assert!(operation("item.add")["properties"].get(kind).is_some());
        assert!(defs["ItemPatch"]["properties"].get(kind).is_some());
    }
}

#[tokio::test]
async fn strict_wording_only_apply_records_and_reads_the_flag_without_false_values() {
    use ariadne_store::{registry::Registry, session::Store};
    let data = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(data.path()).unwrap();
    registry.register(root.path(), &id(99), || id(1)).unwrap();
    let store = Store::open_registered(&registry.project_dir(&id(1)), id(1)).unwrap();
    let seed: Session = serde_json::from_str(include_str!(
        "../../../../../fixtures/domain/history/seed.json"
    ))
    .unwrap();
    store.create(&seed).unwrap();
    let service = crate::native::service_at(&data.path().join(".ariadne")).unwrap();
    for (revision, wording_only, note) in [
        (1, true, "Clearer wording"),
        (2, false, "A substantive update"),
    ] {
        let result = service.call("apply", json!({"binding_id":id(3), "generation":id(4), "request":{
            "op_id":id(900 + revision), "source_input_id":null, "attempt_id":null,
            "expected_item_revisions":{"1":revision}, "expected_topic_revisions":{}, "summary":"",
            "operations":[{"op":"item.edit", "item":{"id":"1"}, "wording_only":wording_only,
                "reason":"Explain this edit", "patch":{"note":note, "type":"decision", "links":[]}}], "input_result":null
        }}).as_object().cloned()).await.unwrap();
        assert_eq!(result.is_error, Some(false), "{result:?}");
    }
    let saved = store.read(&id(2)).unwrap();
    let result = service.call("item_changes", json!({"binding_id":id(3), "generation":id(4),
        "source_input_id":null, "attempt_id":null, "params":{"item_id":"1", "cursor":null, "limit":20}})
        .as_object().cloned()).await.unwrap();
    assert_eq!(result.is_error, Some(false), "{result:?}");
    let result = result.structured_content.unwrap();
    let changes = result["data"]["data"]["changes"]["items"]
        .as_array()
        .unwrap();
    assert_eq!(changes.len(), 2);
    assert_eq!(changes[0]["wording_only"], true);
    assert_eq!(changes[0]["before"], json!({"note":null}));
    assert_eq!(changes[0]["reason"], "Explain this edit");
    assert!(changes[1].get("wording_only").is_none());
    assert_eq!(changes[1]["before"], json!({"note":"Clearer wording"}));
    assert_eq!(store.read(&id(2)).unwrap(), saved);
}

#[tokio::test]
async fn strict_wording_only_forbidden_fields_refuse_the_entire_batch() {
    use ariadne_store::{registry::Registry, session::Store};
    let data = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(data.path()).unwrap();
    registry.register(root.path(), &id(99), || id(1)).unwrap();
    let store = Store::open_registered(&registry.project_dir(&id(1)), id(1)).unwrap();
    let seed: Session = serde_json::from_str(include_str!(
        "../../../../../fixtures/domain/history/seed.json"
    ))
    .unwrap();
    store.create(&seed).unwrap();
    let session_path = registry
        .project_dir(&id(1))
        .join(format!("sessions/{}.json", id(2).as_str()));
    let before = std::fs::read(&session_path).unwrap();
    let service = crate::native::service_at(&data.path().join(".ariadne")).unwrap();
    for (index, (field, value)) in [
        ("type", json!("task")),
        ("ack_to", json!("done")),
        (
            "links",
            json!([{"kind":"doc", "label":"Evidence", "target":"https://example.test/evidence"}]),
        ),
        ("related", json!([{"id":"2"}])),
        ("affects", json!([{"id":"2"}])),
        ("depends_on", json!([{"id":"2"}])),
    ]
    .into_iter()
    .enumerate()
    {
        let result = service.call("apply", json!({"binding_id":id(3), "generation":id(4), "request":{
            "op_id":id(950 + index as u64), "source_input_id":null, "attempt_id":null,
            "expected_item_revisions":{"1":1}, "expected_topic_revisions":{}, "summary":"",
            "operations":[{"op":"topic.add", "ref":"rollback", "name":"Must roll back"},
                {"op":"item.edit", "item":{"id":"1"}, "wording_only":true,
                 "patch":{"note":"Allowed wording cannot conceal a forbidden change", (field):value}}], "input_result":null
        }}).as_object().cloned()).await.unwrap();
        assert_eq!(result.is_error, Some(true), "{field}: {result:?}");
        let result = result.structured_content.unwrap();
        let message = result["error"]["message"].as_str().unwrap();
        assert!(
            message.contains("wording-only") && message.contains(field),
            "{result}"
        );
        assert_eq!(std::fs::read(&session_path).unwrap(), before);
    }
}

#[tokio::test]
async fn strict_wording_only_wrong_shapes_never_reach_core() {
    let core = Arc::new(ScriptedCoreService::new([]));
    let service =
        AgentMcpService::from_trusted_startup(core.clone(), |_, _, _, _| Ok(context())).unwrap();
    for flag in [Value::Null, json!("true"), json!(1), json!([]), json!({})] {
        let result = service.call("apply", json!({"binding_id":id(3), "generation":id(4), "request":{
            "op_id":id(999), "source_input_id":null, "attempt_id":null,
            "expected_item_revisions":{"1":1}, "expected_topic_revisions":{}, "summary":"",
            "operations":[{"op":"item.edit", "item":{"id":"1"}, "wording_only":flag, "patch":{"note":"Clearer wording"}}],
            "input_result":null
        }}).as_object().cloned()).await.unwrap();
        assert_eq!(result.is_error, Some(true), "{result:?}");
        assert_eq!(
            result.structured_content.unwrap()["error"]["code"],
            "invalid_argument"
        );
    }
    assert!(core.history().unwrap().is_empty());
}

#[tokio::test]
async fn standalone_changes_tool_exposes_schema_and_reads_large_records_without_snapshot() {
    use ariadne_store::{registry::Registry, session::Store};
    let data = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(data.path()).unwrap();
    registry.register(root.path(), &id(99), || id(1)).unwrap();
    let store = Store::open_registered(&registry.project_dir(&id(1)), id(1)).unwrap();
    let mut seed: Session = serde_json::from_str(include_str!(
        "../../../../../fixtures/domain/history/seed.json"
    ))
    .unwrap();
    let item = seed.items.0.get_mut(&ItemRef::new("1").unwrap()).unwrap();
    item.links = serde_json::from_value(json!([{"kind":"doc", "label":"p".repeat(400 * 1024), "target":"https://example.test/evidence"}])).unwrap();
    store.create(&seed).unwrap();
    let tools = manifest().unwrap();
    let tool = tools
        .iter()
        .find(|tool| tool.name == "item_changes")
        .unwrap();
    let schema = tool.schema_as_json_value();
    assert!(schema["properties"]["params"].is_object());
    assert!(tool.output_schema.is_some());
    let service = crate::native::service_at(&data.path().join(".ariadne")).unwrap();
    for (revision, patch) in [
        (
            1,
            json!({"links":[{"kind":"doc", "label":"c".repeat(400 * 1024), "target":"https://example.test/evidence"}]}),
        ),
        (2, json!({"short":"Clarified"})),
    ] {
        let result = service.call("apply", json!({"binding_id":id(3), "generation":id(4), "request":{
            "op_id":id(800 + revision), "source_input_id":null, "attempt_id":null,
            "expected_item_revisions":{"1":revision}, "expected_topic_revisions":{}, "summary":"",
            "operations":[{"op":"item.edit", "item":{"id":"1"}, "patch":patch}], "input_result":null
        }}).as_object().cloned()).await.unwrap();
        assert_eq!(result.is_error, Some(false), "{result:?}");
    }
    let saved = store.read(&id(2)).unwrap();
    let mut arguments = json!({"binding_id":id(3), "generation":id(4), "source_input_id":null, "attempt_id":null,
        "params":{"item_id":"1", "cursor":null, "limit":1}});
    let first = service
        .call("item_changes", arguments.as_object().cloned())
        .await
        .unwrap();
    assert_eq!(first.is_error, Some(false));
    let first = first.structured_content.unwrap();
    let projection = &first["data"]["data"];
    assert_eq!(first["data"]["kind"], "item_changes");
    assert!(projection.get("item").is_none());
    assert_eq!(
        projection["changes"]["items"][0]["before"]["links"][0]["label"]
            .as_str()
            .unwrap()
            .len(),
        400 * 1024
    );
    assert!(!projection["changes"]["next_cursor"].is_null());
    arguments["params"]["cursor"] = projection["changes"]["next_cursor"].clone();
    let second = service
        .call("item_changes", arguments.as_object().cloned())
        .await
        .unwrap();
    assert_eq!(second.is_error, Some(false));
    let second = second.structured_content.unwrap();
    assert_eq!(
        second["data"]["data"]["changes"]["items"][0]["before"],
        json!({"short":null})
    );
    assert!(second["data"]["data"]["changes"]["next_cursor"].is_null());
    assert_eq!(store.read(&id(2)).unwrap(), saved);
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
