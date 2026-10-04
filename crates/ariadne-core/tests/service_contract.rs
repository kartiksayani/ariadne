use ariadne_core::*;
use ariadne_domain::models::*;
use serde_json::json;
use std::path::Path;
#[path = "../../../tests/support/core_service/mod.rs"]
mod cases;
// Integration tests exercise the same source without enabling production fallback.
#[path = "../src/service/fake.rs"]
mod fake;
use fake::*;

fn root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
}
fn steps(routing: &cases::Routing, case: &cases::Case) -> Vec<ScriptStep> {
    case.steps
        .iter()
        .filter_map(|step| {
            let (request, response) = match step {
                cases::CaseStep::Query {
                    audience,
                    request,
                    response,
                } => (
                    RecordedRequest::Query(routing.query(*audience), request.clone()),
                    ScriptedResponse::Query(Box::new(cases::result(response))),
                ),
                cases::CaseStep::Owner { request, response } => (
                    RecordedRequest::Owner(routing.owner(), request.clone()),
                    ScriptedResponse::Owner(Box::new(cases::result(response))),
                ),
                cases::CaseStep::Apply { request, response } => (
                    RecordedRequest::Apply(routing.agent(), request.clone()),
                    ScriptedResponse::Apply(Box::new(cases::result(response))),
                ),
                cases::CaseStep::Claim {
                    current_generation,
                    request,
                    response,
                } => (
                    RecordedRequest::Claim(
                        routing.dispatch(current_generation.clone()),
                        request.clone(),
                    ),
                    ScriptedResponse::Claim(cases::result(response)),
                ),
                cases::CaseStep::Report {
                    historical,
                    event,
                    response,
                } => (
                    RecordedRequest::Report(routing.adapter(*historical, event), event.clone()),
                    ScriptedResponse::Report(cases::result(response)),
                ),
                cases::CaseStep::Checkpoint { .. } => return None,
            };
            Some(ScriptStep { request, response })
        })
        .collect()
}

#[test]
fn canonical_producer_and_caller_cases_use_the_object_safe_owned_seam() {
    let corpus = cases::load(root());
    for case in &corpus.cases {
        let script = steps(&corpus.routing, case);
        let requests: Vec<_> = script.iter().map(|step| step.request.clone()).collect();
        let service = ScriptedCoreService::new(script);
        let checkpoint = cases::run(&service, &corpus.routing, case);
        assert_eq!(service.remaining().unwrap(), 0, "{}", case.name);
        assert_eq!(service.history().unwrap(), requests, "{}", case.name);
        assert_eq!(
            checkpoint.is_some(),
            case.name == "checkpoint_after_persist"
        );
    }
}

#[test]
fn patch_omission_null_and_exact_text_remain_distinct() {
    for (wire, expected) in [
        (json!({}), None),
        (json!({"note":null}), Some(None)),
        (json!({"note":""}), Some(Some(String::new()))),
        (
            json!({"note":"café\nline"}),
            Some(Some("café\nline".into())),
        ),
    ] {
        let patch: ItemPatch = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(patch.note, expected);
        let emitted = serde_json::to_value(patch).unwrap();
        assert_eq!(emitted.get("note"), wire.get("note"));
    }
    assert!(serde_json::from_value::<ItemPatch>(json!({"note":42})).is_err());
}

#[test]
fn navigation_preferences_are_required_typed_and_preserve_closed_view_data() {
    let inventory: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root().join("fixtures/contracts/core/inventory.json")).unwrap(),
    )
    .unwrap();
    let entries = &inventory["owner_commands"]
        .as_array()
        .unwrap()
        .iter()
        .find(|value| value["command"] == "preferences_patch")
        .unwrap()["params"]["entries"];
    let global = entries[0]["preferences"].clone();
    let mut view = entries[1]["preferences"].clone();
    for selection in [
        json!({"kind":"projects"}),
        json!({"kind":"all_sessions"}),
        json!({"kind":"project","project_id":"00000000-0000-4000-8000-000000000001"}),
        json!({"kind":"session","session":view["session"]}),
    ] {
        let mut wire = global.clone();
        wire["selected_navigation"] = selection;
        let decoded: GlobalPreferences = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), wire);
        wire["selected_navigation"]["unexpected"] = json!(true);
        assert!(serde_json::from_value::<GlobalPreferences>(wire).is_err());
    }
    let mut missing = global;
    missing
        .as_object_mut()
        .unwrap()
        .remove("selected_navigation");
    assert!(serde_json::from_value::<GlobalPreferences>(missing).is_err());
    let before = view.clone();
    view["tab_open"] = json!(false);
    let decoded: SessionPreferences = serde_json::from_value(view.clone()).unwrap();
    assert!(!decoded.tab_open);
    assert_eq!(serde_json::to_value(decoded).unwrap(), view);
    view["tab_open"] = before["tab_open"].clone();
    assert_eq!(view, before);
    view.as_object_mut().unwrap().remove("tab_open");
    assert!(serde_json::from_value::<SessionPreferences>(view).is_err());
    assert!(serde_json::from_value::<NavigationSelection>(json!({"kind":"candidate"})).is_err());
}

#[test]
fn exact_envelope_and_request_nullability_reject_invalid_shapes() {
    let schema = SchemaVersion::new(1).unwrap();
    let good = ClaimEnvelope(ApplicationEnvelope::Success(SuccessEnvelope {
        api_version: schema,
        ok: SuccessFlag,
        data: None,
    }));
    assert_eq!(
        serde_json::to_value(&good).unwrap(),
        json!({"api_version":1,"ok":true,"data":null})
    );
    for value in [
        json!({"api_version":1,"ok":false,"data":null}),
        json!({"api_version":1,"ok":"true","data":null}),
        json!({"api_version":2,"ok":true,"data":null}),
        json!({"api_version":1,"ok":true,"data":null,"actor":"owner"}),
    ] {
        assert!(serde_json::from_value::<ClaimEnvelope>(value).is_err());
    }
    assert!(serde_json::from_str::<ApplyRequest>(r#"{"op_id":"00000000-0000-4000-8000-000000000201","expected_item_revisions":{"1":1,"1":2},"expected_topic_revisions":{},"summary":"","operations":[]}"#).is_err());
    let patch: ItemPatch = serde_json::from_value(json!({})).unwrap();
    assert!(patch.links.is_none());
    assert!(serde_json::from_value::<ItemMessagesRequest>(
        json!({"item_id":"1","cursor":"opaque","limit":1})
    )
    .is_err());
    assert!(serde_json::from_value::<SessionReadRequest>(
        json!({"selection":{"view":"messages","filters":{"statuses":[]}},"limit":1,"item_pages":[]})
    )
    .is_err());
    assert!(serde_json::from_value::<MutationReceipt>(json!({"operation_id":"00000000-0000-4000-8000-000000000201","project_id":"00000000-0000-4000-8000-000000000001","registry_revision":1,"preferences_revision":1})).is_err());
}

#[test]
fn complete_history_pages_preserve_bodies_provenance_and_independent_nested_cursors() {
    let corpus = cases::load(root());
    let case = corpus
        .cases
        .iter()
        .find(|case| case.name == "complete_history_and_cursor")
        .unwrap();
    let mut history = Vec::new();
    for step in &case.steps {
        if let cases::CaseStep::Query { response, .. } = step {
            match cases::result(response).unwrap() {
                QueryResult::ItemMessages(value) => history.extend(value.messages.items),
                QueryResult::ItemRounds(value) => {
                    let round = &value.rounds.items[0];
                    assert!(value.rounds.next_cursor.is_none());
                    assert_eq!(
                        round.owner_messages.next_cursor.as_ref().unwrap().view,
                        QueryView::RoundOwnerMessages
                    );
                    assert_eq!(
                        round.answers.next_cursor.as_ref().unwrap().view,
                        QueryView::RoundAnswers
                    );
                    assert!(round.agent_messages.next_cursor.is_none());
                    assert!(!round.results.items.is_empty());
                    assert!(!round.forks.items.is_empty());
                }
                _ => unreachable!(),
            }
        }
    }
    let session: Session = serde_json::from_slice(
        &std::fs::read(root().join("fixtures/domain/demo/session.json")).unwrap(),
    )
    .unwrap();
    let expected: Vec<_> = session
        .messages
        .into_iter()
        .filter(|message| {
            message
                .item_id
                .as_ref()
                .is_some_and(|item| item.as_str() == "1")
        })
        .collect();
    assert_eq!(history, expected);
    assert!(history.iter().any(|message| message.body.contains('\n')));
    let copied = corpus
        .cases
        .iter()
        .find(|case| case.name == "copied_history_preserves_source_author")
        .unwrap();
    let cases::CaseStep::Query { response, .. } = &copied.steps[0] else {
        unreachable!()
    };
    let QueryResult::ItemMessages(projection) = cases::result(response).unwrap() else {
        unreachable!()
    };
    let message = &projection.messages.items[0];
    assert_eq!(
        message.origin.as_ref().unwrap().author,
        MessageAuthor::Agent
    );
    assert_eq!(
        message.body,
        "Imported complete reply.\nIts source author and binding are preserved."
    );
}

#[test]
fn option_only_answers_preserve_blank_bytes_without_allowing_other_blank_submissions() {
    let inventory: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root().join("fixtures/contracts/core/inventory.json")).unwrap(),
    )
    .unwrap();
    let original = inventory["owner_commands"]
        .as_array()
        .unwrap()
        .iter()
        .find(|command| command["command"] == "input_submit")
        .unwrap();
    for body in ["", " \n \t"] {
        let mut wire = original.clone();
        wire["params"]["text"] = json!(body);
        let command: OwnerCommand = serde_json::from_value(wire.clone()).unwrap();
        command.validate_wire().unwrap();
        assert_eq!(serde_json::to_value(command).unwrap(), wire);
        for (kind, option) in [
            ("note", json!("keep")),
            ("answer", json!(null)),
            ("answer", json!("")),
        ] {
            let mut invalid = wire.clone();
            invalid["params"]["kind"] = json!(kind);
            invalid["params"]["selected_option_id"] = option;
            assert_eq!(
                serde_json::from_value::<OwnerCommand>(invalid)
                    .unwrap()
                    .validate_wire()
                    .unwrap_err()
                    .code,
                CoreErrorCode::InvalidArgument
            );
        }
    }
    for body in ["\0", &"x".repeat(16 * 1024 + 1)] {
        let mut wire = original.clone();
        wire["params"]["text"] = json!(body);
        assert!(serde_json::from_value::<OwnerCommand>(wire)
            .unwrap()
            .validate_wire()
            .is_err());
    }
}

#[test]
fn prepared_payload_requires_exact_marker_prefix_before_its_full_byte_digest() {
    use sha2::{Digest, Sha256};
    let corpus = cases::load(root());
    let step = corpus.cases.iter().flat_map(|case| &case.steps).find(|step| matches!(step, cases::CaseStep::Claim { response, .. } if cases::result(response).is_ok_and(|value| value.is_some()))).unwrap();
    let cases::CaseStep::Claim {
        request, response, ..
    } = step
    else {
        unreachable!()
    };
    let prepared = cases::result(response).unwrap().unwrap();
    assert_eq!(
        prepared.formatted_payload.split_once('\n').unwrap().0,
        prepared.wire_marker
    );
    let encoded: serde_json::Value =
        serde_json::from_str(prepared.formatted_payload.split_once('\n').unwrap().1).unwrap();
    assert_eq!(
        encoded["owner_text"],
        "Keep it.\nRetain the full history, including earlier outcomes."
    );
    assert_eq!(
        prepared.payload_sha256.as_str(),
        format!(
            "{:x}",
            Sha256::digest(prepared.formatted_payload.as_bytes())
        )
    );
    for payload in [
        "{}".to_owned(),
        format!("x{}\n{{}}", prepared.wire_marker),
        format!("{}\r\n{{}}", prepared.wire_marker),
        prepared.wire_marker.clone(),
    ] {
        let mut invalid = prepared.clone();
        invalid.formatted_payload = payload;
        invalid.payload_sha256 = serde_json::from_value(json!(format!(
            "{:x}",
            Sha256::digest(invalid.formatted_payload.as_bytes())
        )))
        .unwrap();
        assert_eq!(
            invalid.validate_for(request).unwrap_err().code,
            CoreErrorCode::InvalidArgument
        );
        let cases::CaseStep::Claim {
            current_generation, ..
        } = step
        else {
            unreachable!()
        };
        let context = corpus.routing.dispatch(current_generation.clone());
        let fake = ScriptedCoreService::new([ScriptStep {
            request: RecordedRequest::Claim(context.clone(), request.clone()),
            response: ScriptedResponse::Claim(Ok(Some(invalid))),
        }]);
        assert_eq!(
            fake.claim(context, request.clone()).unwrap_err().code,
            CoreErrorCode::InvalidArgument
        );
    }
    let mut invalid = prepared.clone();
    invalid.formatted_payload.push(' ');
    assert_eq!(
        invalid.validate_for(request).unwrap_err().code,
        CoreErrorCode::InvalidArgument
    );
}

fn check_query_response(
    request: serde_json::Value,
    response: serde_json::Value,
    expected: Option<CoreErrorCode>,
) {
    let corpus = cases::load(root());
    let context = corpus.routing.query(cases::Audience::Owner);
    let request: QueryRequest = serde_json::from_value(request).unwrap();
    let response: QueryResult = serde_json::from_value(response).unwrap();
    let service = ScriptedCoreService::new([ScriptStep {
        request: RecordedRequest::Query(context.clone(), Box::new(request.clone())),
        response: ScriptedResponse::Query(Box::new(Ok(response))),
    }]);
    let result = service.query(context, request);
    match expected {
        Some(code) => assert_eq!(result.unwrap_err().code, code),
        None => {
            result.unwrap();
        }
    }
}

#[test]
fn nested_round_pages_reject_excess_entities_changed_snapshots_and_wrong_scope() {
    let wire: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root().join("fixtures/contracts/core/cases.json")).unwrap(),
    )
    .unwrap();
    let step = &wire["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "complete_history_and_cursor")
        .unwrap()["steps"][2];
    let mut request = step["request"].clone();
    let response = step["response"]["data"].clone();
    let round = &response["data"]["rounds"]["items"][0];
    request["params"]["round_pages"] = json!([{"view":"round_owner_messages","round_id":round["round"]["id"],"cursor":round["owner_messages"]["next_cursor"],"limit":1}]);
    check_query_response(request.clone(), response.clone(), None);
    for (path, replacement, code) in [
        (
            "/data/rounds/items/0/owner_messages/items",
            json!([
                round["owner_messages"]["items"][0],
                round["owner_messages"]["items"][0]
            ]),
            CoreErrorCode::InvalidArgument,
        ),
        (
            "/data/rounds/items/0/owner_messages/snapshot_revision",
            json!(20),
            CoreErrorCode::InvalidArgument,
        ),
        (
            "/data/rounds/items/0/owner_messages/next_cursor/view",
            json!("messages"),
            CoreErrorCode::InvalidArgument,
        ),
        (
            "/data/rounds/items/0/owner_messages/next_cursor/filter_digest",
            json!("0".repeat(64)),
            CoreErrorCode::InvalidArgument,
        ),
        (
            "/data/rounds/items/0/round/item_id",
            json!("2"),
            CoreErrorCode::BindingMismatch,
        ),
    ] {
        let mut invalid = response.clone();
        *invalid.pointer_mut(path).unwrap() = replacement;
        check_query_response(request.clone(), invalid, Some(code));
    }
    let mut stale = request.clone();
    stale["params"]["round_pages"][0]["cursor"]["revision"] = json!(20);
    check_query_response(
        stale,
        response.clone(),
        Some(CoreErrorCode::SnapshotChanged),
    );
    let mut absent = request.clone();
    absent["params"]["round_pages"][0]["round_id"] = json!("00000000-0000-4000-8000-000000000099");
    check_query_response(
        absent,
        response.clone(),
        Some(CoreErrorCode::InvalidArgument),
    );
    let mut duplicate = request.clone();
    let selector = duplicate["params"]["round_pages"][0].clone();
    duplicate["params"]["round_pages"]
        .as_array_mut()
        .unwrap()
        .push(selector);
    check_query_response(
        duplicate,
        response.clone(),
        Some(CoreErrorCode::InvalidArgument),
    );
    let mut mixed = response;
    mixed["data"]["rounds"]["items"][0]["agent_messages"]["snapshot_revision"] = json!(20);
    check_query_response(request, mixed, Some(CoreErrorCode::SnapshotChanged));
}

#[test]
fn nested_item_pages_use_explicit_limits_and_parent_cursor_snapshot_scope() {
    let page: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root().join("fixtures/domain/projections/items.json")).unwrap(),
    )
    .unwrap();
    let item = &page["items"][0];
    let mut response = json!({"kind":"session_read","data":{"view":"items","page":{"items":[item],"next_cursor":null,"snapshot_revision":page["snapshot_revision"]}}});
    let mut request = json!({"command":"session_read","params":{"selection":{"view":"items","filters":{"topic_id":null,"item_id":"1","parent_item_id":null,"statuses":[],"archived":null}},"cursor":null,"limit":1,"item_pages":[{"view":"item_updated_messages","item_id":"1","cursor":null,"limit":1},{"view":"item_status_history","item_id":"1","cursor":null,"limit":1}]}});
    // Choose bounded first pages and retain their existing scoped cursors.
    for field in ["updated_messages", "status_history"] {
        response["data"]["page"]["items"][0][field]["items"]
            .as_array_mut()
            .unwrap()
            .truncate(1);
    }
    check_query_response(request.clone(), response.clone(), None);
    let mut excess = response.clone();
    let body = excess["data"]["page"]["items"][0]["updated_messages"]["items"][0].clone();
    excess["data"]["page"]["items"][0]["updated_messages"]["items"]
        .as_array_mut()
        .unwrap()
        .push(body);
    check_query_response(
        request.clone(),
        excess,
        Some(CoreErrorCode::InvalidArgument),
    );
    let mut absent = request.clone();
    absent["params"]["item_pages"][0]["item_id"] = json!("2");
    check_query_response(
        absent,
        response.clone(),
        Some(CoreErrorCode::InvalidArgument),
    );
    let revision = response["data"]["page"]["snapshot_revision"].clone();
    let continuation = json!({"schema":1,"view":"item_status_history","filter_digest":"a".repeat(64),"after":{"kind":"history","index":0},"revision":revision});
    request["params"]["item_pages"][1]["cursor"] = continuation.clone();
    response["data"]["page"]["items"][0]["status_history"]["next_cursor"] = continuation;
    check_query_response(request.clone(), response.clone(), None);
    for (field, replacement) in [
        ("view", json!("messages")),
        ("filter_digest", json!("b".repeat(64))),
    ] {
        let mut invalid = response.clone();
        invalid["data"]["page"]["items"][0]["status_history"]["next_cursor"][field] = replacement;
        check_query_response(
            request.clone(),
            invalid,
            Some(CoreErrorCode::InvalidArgument),
        );
    }
    let mut stale = request.clone();
    stale["params"]["item_pages"][1]["cursor"]["revision"] = json!(1);
    check_query_response(
        stale,
        response.clone(),
        Some(CoreErrorCode::SnapshotChanged),
    );
    let mut mixed = response;
    mixed["data"]["page"]["items"][0]["status_history"]["next_cursor"] = json!(null);
    mixed["data"]["page"]["items"][0]["status_history"]["snapshot_revision"] = json!(1);
    check_query_response(request, mixed, Some(CoreErrorCode::SnapshotChanged));
}

#[test]
fn script_mismatch_keeps_pending_step_and_malformed_response_is_rejected() {
    let corpus = cases::load(root());
    let case = &corpus.cases[0];
    let script = steps(&corpus.routing, case);
    let service = ScriptedCoreService::new(script);
    let wrong = ClaimRequest {
        binding_id: corpus.routing.binding_id.clone(),
        generation: corpus.routing.generation.clone(),
        request_id: corpus.routing.attempt_id.clone(),
    };
    assert_eq!(
        service
            .claim(
                corpus.routing.dispatch(corpus.routing.generation.clone()),
                wrong
            )
            .unwrap_err()
            .code,
        CoreErrorCode::ProtocolConflict
    );
    assert_eq!(service.remaining().unwrap(), 2);
    cases::run(&service, &corpus.routing, case);
    assert_eq!(service.history().unwrap().len(), 3);

    let cases::CaseStep::Query {
        request, response, ..
    } = corpus
        .cases
        .iter()
        .find(|case| case.name == "agent_visibility_issued_watermark")
        .unwrap()
        .steps[0]
        .clone()
    else {
        unreachable!()
    };
    let mut value = cases::result(&response).unwrap();
    let QueryResult::ItemMessages(projection) = &mut value else {
        unreachable!()
    };
    projection.messages.items[0].author = MessageAuthor::Owner;
    projection.messages.items[0].number = PositiveSafeInteger::new(99).unwrap();
    let service = ScriptedCoreService::new([ScriptStep {
        request: RecordedRequest::Query(
            corpus.routing.query(cases::Audience::Agent),
            request.clone(),
        ),
        response: ScriptedResponse::Query(Box::new(Ok(value))),
    }]);
    assert_eq!(
        service
            .query(corpus.routing.query(cases::Audience::Agent), *request)
            .unwrap_err()
            .code,
        CoreErrorCode::UnhandledOwnerMessage
    );
}

#[test]
fn original_limits_and_scoped_owner_visibility_are_enforced() {
    for invalid in [0, 101, u64::MAX] {
        assert!(PageLimit::new(invalid).is_err());
    }
    for wire in ["0", "101", "1.5", "\"1\"", "null"] {
        assert!(serde_json::from_str::<PageLimit>(wire).is_err());
    }
    assert_eq!(
        serde_json::from_str::<PageLimit>("100").unwrap().value(),
        100
    );
    let corpus = cases::load(root());
    let request = QueryRequest::SessionGet {};
    assert_eq!(
        request
            .validate_wire(&corpus.routing.query(cases::Audience::Agent))
            .unwrap_err()
            .code,
        CoreErrorCode::PermissionDenied
    );
    let cases::CaseStep::Apply { request, .. } = corpus
        .cases
        .iter()
        .find(|case| case.name == "result_before_completion")
        .unwrap()
        .steps[0]
        .clone()
    else {
        unreachable!()
    };
    let mut request = *request;
    request.attempt_id = None;
    assert!(request.validate_wire().is_err());
    request.source_input_id = None;
    assert!(request.validate_wire().is_err());
    request.input_result = None;
    request.operations.clear();
    request.summary = "a".repeat(4096);
    request.validate_wire().unwrap();
    request.summary = "é".repeat(2049);
    assert!(request.validate_wire().is_err());
    request.summary = "\0".into();
    assert!(request.validate_wire().is_err());
}

#[test]
fn all_inventory_commands_preserve_typed_params_and_original_bounds() {
    let inventory: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root().join("fixtures/contracts/core/inventory.json")).unwrap(),
    )
    .unwrap();
    let routing = cases::load(root()).routing;
    for wire in inventory["owner_commands"].as_array().unwrap() {
        let command: OwnerCommand = serde_json::from_value(wire.clone()).unwrap();
        command.validate_wire().unwrap();
        assert_eq!(
            command.operation_id().as_str(),
            wire["op_id"].as_str().unwrap()
        );
        assert_eq!(serde_json::to_value(command).unwrap(), *wire);
    }
    for wire in inventory["query_requests"].as_array().unwrap() {
        let request: QueryRequest = serde_json::from_value(wire.clone()).unwrap();
        request
            .validate_wire(&routing.query(cases::Audience::Owner))
            .unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), *wire);
    }
    let wire = inventory["apply_requests"][0].clone();
    let mut request: ApplyRequest = serde_json::from_value(wire.clone()).unwrap();
    request.validate_wire().unwrap();
    assert_eq!(serde_json::to_value(&request).unwrap(), wire);
    request.operations = vec![request.operations[0].clone(); 101];
    assert!(request.validate_wire().is_err());
    let mut request: ApplyRequest = serde_json::from_value(wire).unwrap();
    if let Operation::ItemAsk { options, .. } = &mut request.operations[3] {
        let option = ItemOption {
            id: "choice".into(),
            label: "Choose".into(),
            consequence: "Keeps full data.".into(),
            recommended: false,
        };
        *options = vec![option; 13];
    }
    assert!(request.validate_wire().is_err());
    let mut command: OwnerCommand = serde_json::from_value(
        inventory["owner_commands"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()
            .clone(),
    )
    .unwrap();
    let OwnerCommand::PreferencesPatch { params, .. } = &mut command else {
        unreachable!()
    };
    let PreferencesPatchEntry::SetGlobal { preferences } = &mut params.entries[0] else {
        unreachable!()
    };
    preferences.window.as_mut().unwrap().width = f64::NAN;
    assert!(command.validate_wire().is_err());
}

#[test]
fn trusted_contexts_retain_registered_scope_and_verified_historical_origin() {
    let routing = cases::load(root()).routing;
    let registered = routing.session();
    assert_eq!(registered.project_id(), &routing.project_id);
    assert_eq!(registered.session_id(), &routing.session_id);
    let agent = routing.agent();
    assert_eq!(agent.session(), &registered);
    assert_eq!(agent.binding_id(), &routing.binding_id);
    assert_eq!(agent.generation(), &routing.generation);
    assert_eq!(
        agent.read_scope().issued_through_message_number(),
        routing.issued_through_message_number
    );
    let terminal = AgentReadScope::Terminal {
        issued_through_message_number: NonnegativeSafeInteger::new(0).unwrap(),
    };
    assert_eq!(terminal.issued_through_message_number().value(), 0);
    let dispatch = routing.dispatch(routing.generation.clone());
    assert_eq!(dispatch.session(), &registered);
    assert_eq!(dispatch.binding_id(), &routing.binding_id);
    assert_eq!(dispatch.generation(), &routing.generation);
    let historical = VerifiedHistoricalScope::from_trusted_reconciliation(
        routing.attempt_id.clone(),
        routing.source_input_id.clone(),
        routing.attempt_id.clone(),
        EndpointFingerprint("verified endpoint".into()),
    );
    assert_eq!(historical.originating_generation(), &routing.attempt_id);
    assert_eq!(historical.input_id(), &routing.source_input_id);
    assert_eq!(historical.attempt_id(), &routing.attempt_id);
    assert_eq!(historical.endpoint_fingerprint().0, "verified endpoint");
    let adapter = AdapterContext::from_trusted_entrypoint(
        registered.clone(),
        routing.binding_id.clone(),
        routing.generation.clone(),
        Some(historical.clone()),
    );
    assert_eq!(adapter.session(), &registered);
    assert_eq!(adapter.binding_id(), &routing.binding_id);
    assert_eq!(adapter.current_generation(), &routing.generation);
    assert_eq!(adapter.historical_scope(), Some(&historical));
    for scope in [
        OwnerScope::Registry,
        OwnerScope::Project(routing.project_id.clone()),
        OwnerScope::Preferences,
    ] {
        assert_eq!(
            OwnerContext::from_trusted_entrypoint(scope.clone()).scope(),
            &scope
        );
    }
}

#[test]
fn adapter_errors_map_exhaustively_without_authorizing_uncertain_resend() {
    use ariadne_agent_protocol::{AdapterError, AdapterErrorCode};
    for (adapter, core, exit) in [
        (
            AdapterErrorCode::InvalidArgument,
            CoreErrorCode::InvalidArgument,
            2,
        ),
        (
            AdapterErrorCode::BindingMismatch,
            CoreErrorCode::BindingMismatch,
            3,
        ),
        (
            AdapterErrorCode::StaleGeneration,
            CoreErrorCode::StaleGeneration,
            3,
        ),
        (
            AdapterErrorCode::IncompatibleAdapter,
            CoreErrorCode::IncompatibleAdapter,
            5,
        ),
        (
            AdapterErrorCode::HostUnreachable,
            CoreErrorCode::HostUnreachable,
            4,
        ),
        (
            AdapterErrorCode::DeliveryUncertain,
            CoreErrorCode::DeliveryUncertain,
            3,
        ),
        (
            AdapterErrorCode::PermissionDenied,
            CoreErrorCode::PermissionDenied,
            4,
        ),
        (AdapterErrorCode::Unsupported, CoreErrorCode::Unsupported, 5),
        (
            AdapterErrorCode::ProtocolConflict,
            CoreErrorCode::ProtocolConflict,
            3,
        ),
        (
            AdapterErrorCode::UnsupportedHostVersion,
            CoreErrorCode::UnsupportedHostVersion,
            5,
        ),
    ] {
        let mapped = CoreError::from(AdapterError {
            code: adapter,
            message: "Concrete host error".into(),
            retryable: true,
        });
        assert_eq!(mapped.code, core);
        assert_eq!(mapped.code.cli_exit(), exit);
        assert_eq!(mapped.retryable, core != CoreErrorCode::DeliveryUncertain);
        mapped.validate().unwrap();
    }
    let mut error = CoreError::new(
        CoreErrorCode::DeliveryUncertain,
        "Delivery may have happened.",
        "Reconcile first.",
    );
    error.retryable = true;
    assert!(error.validate().is_err());
    error.retryable = false;
    error.field_errors.push(FieldError {
        field: "request.text".into(),
        message: "Too long.".into(),
    });
    error.validate().unwrap();
    error.message = "é".repeat(2049);
    assert!(error.validate().is_err());
    assert_eq!(CoreErrorCode::ControlPathTooLong.cli_exit(), 4);
    assert_eq!(CoreErrorCode::FutureSchema.cli_exit(), 5);
}

#[test]
fn local_io_errors_are_explicit_and_do_not_authorize_provider_resends() {
    let mut error = CoreError::new(
        CoreErrorCode::IoError,
        "Cannot read the registered session directory.",
        "Check local filesystem access before retrying the same operation.",
    );
    assert!(!error.retryable);
    assert_eq!(error.code.cli_exit(), 4);
    let value = serde_json::to_value(&error).unwrap();
    assert_eq!(value["code"], "io_error");
    assert_eq!(serde_json::from_value::<CoreError>(value).unwrap(), error);
    error.validate().unwrap();
    // Only a classified transient local failure may explicitly override this.
    error.retryable = true;
    error.validate().unwrap();
    error.code = CoreErrorCode::DeliveryUncertain;
    assert!(error.validate().is_err());
}

#[test]
fn desktop_hints_preserve_nullable_routes_and_qualify_presence_generation() {
    let routing = cases::load(root()).routing;
    let hint = SessionChangedHint {
        session_id: routing.session_id.clone(),
        revision: PositiveSafeInteger::new(2).unwrap(),
    };
    assert_eq!(serde_json::to_value(hint).unwrap()["revision"], 2);
    let mut route = OpenRoute {
        project_id: routing.project_id,
        session_id: routing.session_id,
        item_id: None,
    };
    assert!(route.item_route().is_none());
    let value = serde_json::to_value(&route).unwrap();
    assert!(value["item_id"].is_null());
    assert_eq!(serde_json::from_value::<OpenRoute>(value).unwrap(), route);
    route.item_id = Some(ItemRef::new("1.1").unwrap());
    assert_eq!(route.item_route().unwrap().item_id, route.item_id.unwrap());
    let mut presence = PresenceChangedHint {
        binding_id: routing.binding_id,
        generation: routing.generation.clone(),
        observation: PresenceObservation {
            instance_id: routing.generation.clone(),
            generation: routing.generation,
            connection_state: ConnectionState::Disconnected,
            execution_state: ExecutionState::Unknown,
            last_seen_at: None,
            source: None,
            process_identity: None,
            freshness: Freshness::Unknown,
        },
    };
    presence.validate_wire().unwrap();
    presence.observation.generation = routing.attempt_id;
    assert_eq!(
        presence.validate_wire().unwrap_err().code,
        CoreErrorCode::BindingMismatch
    );
    let mut extra = serde_json::to_value(presence).unwrap();
    extra["path"] = json!("/unregistered/root");
    assert!(serde_json::from_value::<PresenceChangedHint>(extra).is_err());
}

#[test]
fn owner_transport_routes_are_required_once_and_never_silently_overridden() {
    let routing = cases::load(root()).routing;
    let session = SessionRef {
        project_id: routing.project_id.clone(),
        session_id: routing.session_id.clone(),
    };
    let mut read = OwnerQueryRequest {
        session: None,
        request: QueryRequest::SessionGet {},
    };
    assert!(read.validate_wire().is_err());
    read.session = Some(session.clone());
    read.validate_wire().unwrap();
    read.request = QueryRequest::PreferencesGet {};
    assert!(read.validate_wire().is_err());
    read.session = None;
    read.validate_wire().unwrap();
    let inventory: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root().join("fixtures/contracts/core/inventory.json")).unwrap(),
    )
    .unwrap();
    for wire in inventory["owner_commands"].as_array().unwrap() {
        let command: OwnerCommand = serde_json::from_value(wire.clone()).unwrap();
        let needs_session = !matches!(
            command,
            OwnerCommand::ProjectRegister { .. }
                | OwnerCommand::BindingConnect { .. }
                | OwnerCommand::PreferencesPatch { .. }
        );
        let mut wrapper = OwnerMutationRequest {
            session: needs_session.then(|| session.clone()),
            command,
        };
        wrapper.validate_wire().unwrap();
        wrapper.session = if needs_session {
            None
        } else {
            Some(session.clone())
        };
        assert!(wrapper.validate_wire().is_err());
    }
    let command: OwnerCommand =
        serde_json::from_value(inventory["owner_commands"][12].clone()).unwrap();
    let contradictory = OwnerMutationRequest {
        session: Some(SessionRef {
            project_id: session.project_id.clone(),
            session_id: routing.attempt_id.clone(),
        }),
        command,
    };
    assert_eq!(
        contradictory.validate_wire().unwrap_err().code,
        CoreErrorCode::BindingMismatch
    );
    assert!(serde_json::from_value::<QueryRequest>(json!({"command":"session_get","params":{"project_id":routing.project_id,"session_id":routing.session_id}})).is_err());
    let mut old_submit = inventory["owner_commands"][5].clone();
    old_submit["params"]["session_id"] = json!(session.session_id);
    assert!(serde_json::from_value::<OwnerCommand>(old_submit).is_err());
}

#[test]
fn model_tool_attempt_fields_are_paired_and_scripts_reject_wrong_response_methods() {
    let corpus = cases::load(root());
    let r = &corpus.routing;
    let mut read = AgentReadToolRequest {
        binding_id: r.binding_id.clone(),
        generation: r.generation.clone(),
        source_input_id: None,
        attempt_id: None,
        params: SessionReadRequest {
            selection: ReadView::Topics { archived: None },
            cursor: None,
            limit: PageLimit::new(1).unwrap(),
            item_pages: vec![],
        },
    };
    read.validate_wire().unwrap();
    read.source_input_id = Some(r.source_input_id.clone());
    assert!(read.validate_wire().is_err());
    read.attempt_id = Some(r.attempt_id.clone());
    read.validate_wire().unwrap();
    let mut messages = AgentMessagesToolRequest {
        binding_id: r.binding_id.clone(),
        generation: r.generation.clone(),
        source_input_id: None,
        attempt_id: None,
        params: ItemMessagesRequest {
            item_id: ItemRef::new("1").unwrap(),
            cursor: None,
            limit: PageLimit::new(1).unwrap(),
        },
    };
    messages.validate_wire().unwrap();
    messages.attempt_id = Some(r.attempt_id.clone());
    assert!(messages.validate_wire().is_err());
    let mut rounds = AgentRoundsToolRequest {
        binding_id: r.binding_id.clone(),
        generation: r.generation.clone(),
        source_input_id: None,
        attempt_id: None,
        params: ItemRoundsRequest {
            item_id: ItemRef::new("1").unwrap(),
            cursor: None,
            limit: PageLimit::new(1).unwrap(),
            round_pages: vec![],
        },
    };
    rounds.validate_wire().unwrap();
    rounds.attempt_id = Some(r.attempt_id.clone());
    assert!(rounds.validate_wire().is_err());
    for name in [
        "operation_replay_before_revision_checks",
        "result_before_completion",
        "healthy_no_work_vs_dispatch_barriers",
        "checkpoint_after_persist",
        "agent_visibility_issued_watermark",
    ] {
        let case = corpus.cases.iter().find(|case| case.name == name).unwrap();
        let mut step = steps(r, case).remove(0);
        if let RecordedRequest::Apply(_, request) = &step.request {
            AgentApplyToolRequest {
                binding_id: r.binding_id.clone(),
                generation: r.generation.clone(),
                request: *request.clone(),
            }
            .validate_wire()
            .unwrap();
        }
        step.response = if matches!(step.request, RecordedRequest::Claim(..)) {
            ScriptedResponse::Report(Err(CoreError::new(
                CoreErrorCode::StoreBusy,
                "Locked.",
                "Retry the same report.",
            )))
        } else {
            ScriptedResponse::Claim(Ok(None))
        };
        let request = step.request.clone();
        let service = ScriptedCoreService::new([step]);
        let code = match request {
            RecordedRequest::Query(context, request) => {
                service.query(context, *request).unwrap_err().code
            }
            RecordedRequest::Owner(context, request) => {
                service.execute_owner(context, *request).unwrap_err().code
            }
            RecordedRequest::Apply(context, request) => {
                service.apply(context, *request).unwrap_err().code
            }
            RecordedRequest::Claim(context, request) => {
                service.claim(context, request).unwrap_err().code
            }
            RecordedRequest::Report(context, request) => {
                service.report(context, *request).unwrap_err().code
            }
        };
        assert_eq!(code, CoreErrorCode::ProtocolConflict);
        assert_eq!(service.remaining().unwrap(), 0);
    }
}

#[test]
#[should_panic(expected = "checkpoint cannot advance")]
fn consumer_never_advances_checkpoint_after_failed_report_persistence() {
    let corpus = cases::load(root());
    let mut case = corpus
        .cases
        .iter()
        .find(|case| case.name == "failed_persist_retains_checkpoint")
        .unwrap()
        .clone();
    let service = ScriptedCoreService::new(steps(&corpus.routing, &case));
    case.steps.push(cases::CaseStep::Checkpoint {
        checkpoint: Checkpoint::new("unsafe-new-page").unwrap(),
    });
    cases::run(&service, &corpus.routing, &case);
}
