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
