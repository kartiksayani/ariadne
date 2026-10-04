use ariadne_agent_protocol::*;
use schemars::JsonSchema;
use serde::Serialize;
use serde_json::{json, Value};
#[path = "support/common.rs"]
mod common;
use common::*;

#[test]
fn reserved_claude_session_end_identity_is_exact_and_non_attempt() {
    let mut event = events()[0].clone();
    event.input_id = None;
    event.attempt_id = None;
    event.host_turn_id = None;
    event.event = EventPayload::Disconnected { reason: None };
    event.event_id = claude_session_end_event_id(&event.binding_id, &event.generation);
    assert_eq!(
        event.event_id,
        format!(
            "claude:session-ended:{}:{}",
            event.binding_id.as_str(),
            event.generation.as_str()
        )
    );
    assert!(is_claude_session_end_event(&event));
    event.validate().unwrap();
    for mutation in 0..5 {
        let mut invalid = event.clone();
        match mutation {
            0 => invalid.binding_id = id('f'),
            1 => invalid.generation = id('f'),
            2 => invalid.input_id = Some(id('c')),
            3 => invalid.event = events()[0].event.clone(),
            _ => invalid.event_id.push_str(":extra"),
        }
        assert!(!is_claude_session_end_event(&invalid));
        assert!(invalid.validate().is_err());
    }
}

fn emitted<T: Serialize + JsonSchema>(value: &T) -> Value {
    let schema = schemars::generate::SchemaSettings::default()
        .for_serialize()
        .into_generator()
        .into_root_schema_for::<T>();
    let schema = serde_json::to_value(schema).unwrap();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../../contracts/generated/adapter/{}.schema.json",
        T::schema_name()
    ));
    let published: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(schema, published);
    let value = serde_json::to_value(value).unwrap();
    assert!(
        jsonschema::draft202012::options()
            .should_validate_formats(true)
            .build(&published)
            .unwrap()
            .is_valid(&value),
        "{value}"
    );
    value
}

#[test]
fn fixtures_cover_every_tag_explicit_null_and_canonical_support_shape() {
    let records = events();
    assert_eq!(records.len(), 10);
    for record in records {
        record.validate().unwrap();
        let value = emitted(&record);
        assert!(value.get("event").is_none());
        for field in ["input_id", "attempt_id", "host_turn_id"] {
            assert!(value.get(field).is_some());
        }
        assert_eq!(
            serde_json::from_value::<NormalizedEvent>(value).unwrap(),
            record
        );
    }
    let mut unknown = serde_json::to_value(events()[1].clone()).unwrap();
    unknown["kind"] = json!("provider_wire");
    assert!(serde_json::from_value::<NormalizedEvent>(unknown).is_err());
    for field in [
        "event_id",
        "binding_id",
        "generation",
        "observed_at",
        "kind",
        "payload",
    ] {
        let mut value = serde_json::to_value(events()[1].clone()).unwrap();
        value.as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<NormalizedEvent>(value).is_err(),
            "{field}"
        );
    }
}

#[test]
fn method_nulls_and_empty_disconnect_have_exact_owned_shapes() {
    let probe: ProbeResult = serde_json::from_value(
        json!({"compatibility":"unknown","availability":"unknown","setup_steps":[]}),
    )
    .unwrap();
    assert_eq!(
        emitted(&probe),
        json!({"host_version":null,"compatibility":"unknown","availability":"unknown","setup_steps":[]})
    );
    let accepted: SubmitOutcome = serde_json::from_value(json!({"kind":"accepted"})).unwrap();
    assert_eq!(
        emitted(&accepted),
        json!({"kind":"accepted","receipt":null})
    );
    assert_eq!(emitted(&DisconnectResult {}), json!({}));
    let observation = observe();
    assert!(emitted(&observation)["checkpoint"].is_null());
    assert_eq!(
        emitted(&ObserveResult {
            events: vec![],
            next_checkpoint: None
        }),
        json!({"events":[],"next_checkpoint":null})
    );
    assert!(emitted(&reconcile())["attempts"][0]["host_turn_id"].is_null());
    assert!(serde_json::from_value::<ObserveResult>(json!({"next_checkpoint":null})).is_err());
    assert!(serde_json::from_value::<DisconnectResult>(json!({"stopped_host":true})).is_err());
}

#[test]
fn correlation_and_utf8_bounds_reject_malformed_facts_without_normalizing_ids() {
    for mut record in events() {
        let matched = record.input_id.is_some();
        if matched {
            let original = record.clone();
            record.input_id = None;
            assert!(record.validate().is_err());
            record = original.clone();
            record.attempt_id = None;
            assert!(record.validate().is_err());
            if original.host_turn_id.is_some() {
                record = original;
                record.host_turn_id = None;
                assert!(record.validate().is_err());
            }
        } else {
            record.input_id = Some(id('c'));
            assert!(record.validate().is_err());
        }
    }
    let mut record = events()[3].clone();
    record.event_id = "é".repeat(2048);
    record.validate().unwrap();
    assert_eq!(
        serde_json::from_value::<NormalizedEvent>(emitted(&record))
            .unwrap()
            .event_id,
        record.event_id
    );
    record.event_id.push('é');
    assert!(record.validate().is_err());
    record.event_id.clear();
    assert!(record.validate().is_err());
    record.event_id = "chunk".into();
    record.host_turn_id = Some(String::new());
    assert!(record.validate().is_err());
    record.host_turn_id = Some("host".into());
    if let EventPayload::VisibleOutput {
        text,
        host_message_id,
        ..
    } = &mut record.event
    {
        *text = "é".repeat(32768);
        *host_message_id = Some("message/α".into());
    }
    record.validate().unwrap();
    if let EventPayload::VisibleOutput { text, .. } = &mut record.event {
        text.push('é');
    }
    assert!(record.validate().is_err());
    for index in [0, 1, 3, 5, 6, 7, 8, 9] {
        let mut record = events()[index].clone();
        match &mut record.event {
            EventPayload::Connected {
                endpoint_fingerprint,
                ..
            } => endpoint_fingerprint.0 = "x".repeat(4097),
            EventPayload::Accepted { receipt } => {
                *receipt = Some(HostReceipt {
                    provider_reference: String::new(),
                    observed_at: record.observed_at.clone(),
                })
            }
            EventPayload::VisibleOutput {
                host_message_id, ..
            } => *host_message_id = Some("x".repeat(4097)),
            EventPayload::TurnFinished {
                diagnostic_text, ..
            } => *diagnostic_text = Some("x".repeat(65537)),
            EventPayload::Rejected { reason } | EventPayload::Uncertain { reason } => {
                *reason = "x".repeat(4097)
            }
            EventPayload::Presence { observation } => observation.generation = id('f'),
            EventPayload::Disconnected { reason } => *reason = Some("x".repeat(4097)),
            _ => unreachable!(),
        }
        assert!(record.validate().is_err());
    }
}

#[test]
fn limit_errors_and_submit_certainty_are_typed_and_bounded() {
    for value in [1, 100] {
        assert_eq!(ObserveLimit::new(value).unwrap().value(), value as u8);
    }
    for value in [0, 101, u16::MAX] {
        assert!(ObserveLimit::new(value).is_err());
    }
    for value in [json!(0), json!(101), json!(-1), json!(1.5), json!("1")] {
        assert!(serde_json::from_value::<ObserveLimit>(value).is_err());
    }
    let limit: ObserveLimit = serde_json::from_value(json!(1)).unwrap();
    assert_eq!(emitted(&limit), json!(1));
    for code in [
        AdapterErrorCode::InvalidArgument,
        AdapterErrorCode::BindingMismatch,
        AdapterErrorCode::StaleGeneration,
        AdapterErrorCode::IncompatibleAdapter,
        AdapterErrorCode::HostUnreachable,
        AdapterErrorCode::DeliveryUncertain,
        AdapterErrorCode::PermissionDenied,
        AdapterErrorCode::Unsupported,
        AdapterErrorCode::ProtocolConflict,
        AdapterErrorCode::UnsupportedHostVersion,
    ] {
        let error = AdapterError {
            code,
            message: "Actionable recovery".into(),
            retryable: false,
        };
        error.validate().unwrap();
        assert_eq!(emitted(&error)["message"], "Actionable recovery");
        assert_eq!(error.to_string(), error.message);
    }
    let mut error = AdapterError {
        code: AdapterErrorCode::DeliveryUncertain,
        message: String::new(),
        retryable: true,
    };
    assert!(error.validate().is_err());
    error.retryable = false;
    error.message = "é".repeat(2049);
    assert!(error.validate().is_err());
    for outcome in [
        SubmitOutcome::Accepted { receipt: None },
        SubmitOutcome::Accepted {
            receipt: Some(HostReceipt {
                provider_reference: "queue-id".into(),
                observed_at: events()[0].observed_at.clone(),
            }),
        },
        SubmitOutcome::RejectedBeforeDelivery {
            reason: "Proven unsent".into(),
        },
        SubmitOutcome::Uncertain {
            reason: "Possibly sent".into(),
        },
    ] {
        outcome.validate().unwrap();
        emitted(&outcome);
    }
    assert!(SubmitOutcome::Uncertain {
        reason: "x".repeat(4097)
    }
    .validate()
    .is_err());
}

#[test]
fn batch_scope_separates_current_observation_from_historical_evidence() {
    let request = observe();
    let mut result = ObserveResult {
        events: events(),
        next_checkpoint: Some(Checkpoint::new("after-events").unwrap()),
    };
    result.validate_for(&request).unwrap();
    let mut small = request.clone();
    small.limit = ObserveLimit::new(1).unwrap();
    assert!(result.validate_for(&small).is_err());
    result.events[0].binding_id = id('f');
    assert!(result.validate_for(&request).is_err());
    result.events = events();
    result.events[0].generation = id('f');
    assert!(result.validate_for(&request).is_err());
    let request = reconcile();
    let mut result = ReconcileResult {
        attempt_evidence: vec![AttemptEvidence {
            input_id: id('c'),
            attempt_id: id('d'),
            events: vec![events()[1].clone(), events()[5].clone()],
        }],
        unresolved_attempt_ids: vec![id('d')],
        next_checkpoint: None,
    };
    result.validate_for(&request).unwrap();
    emitted(&result);
    result.attempt_evidence[0].events[0].generation = request.generation.clone();
    assert!(result.validate_for(&request).is_err());
    result.attempt_evidence[0].events[0] = events()[1].clone();
    let original = result.clone();
    let missing = ReconcileResult {
        attempt_evidence: vec![],
        unresolved_attempt_ids: vec![],
        next_checkpoint: None,
    };
    assert!(missing.validate_for(&request).is_err());
    let mut empty = request.clone();
    empty.attempts.clear();
    missing.validate_for(&empty).unwrap();
    let only_unresolved = ReconcileResult {
        attempt_evidence: vec![],
        unresolved_attempt_ids: vec![id('d')],
        next_checkpoint: None,
    };
    only_unresolved.validate_for(&request).unwrap();
    let only_evidence = ReconcileResult {
        attempt_evidence: original.attempt_evidence.clone(),
        unresolved_attempt_ids: vec![],
        next_checkpoint: None,
    };
    only_evidence.validate_for(&request).unwrap();
    result.attempt_evidence[0].input_id = id('a');
    assert!(result.validate_for(&request).is_err());
    result = original.clone();
    result.attempt_evidence[0].attempt_id = id('a');
    assert!(result.validate_for(&request).is_err());
    result = original.clone();
    result
        .attempt_evidence
        .push(result.attempt_evidence[0].clone());
    assert!(result.validate_for(&request).is_err());
    result = original.clone();
    result.attempt_evidence[0].events[0] = events()[0].clone();
    assert!(result.validate_for(&request).is_err());
    result = original.clone();
    result.unresolved_attempt_ids = vec![id('a')];
    assert!(result.validate_for(&request).is_err());
    result = original;
    result.unresolved_attempt_ids.push(id('d'));
    assert!(result.validate_for(&request).is_err());
    let mut duplicate = request.clone();
    duplicate.attempts.push(duplicate.attempts[0].clone());
    assert!(duplicate.validate().is_err());
    duplicate = request;
    duplicate.attempts[0].host_turn_id = Some(String::new());
    assert!(duplicate.validate().is_err());
}

#[test]
fn replay_conflict_uncertainty_and_chunk_identity_survive_normalization() {
    #[derive(serde::Deserialize)]
    struct Vector {
        binding_id: UuidV4,
        generation: UuidV4,
        attempt_id: UuidV4,
        host_turn_id: Option<String>,
        kind: TerminalEventKind,
        source_event_id: Option<String>,
        expected_id: String,
    }
    let vectors: Vec<Vector> = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/contracts/adapter/terminal_ids.json"
    )))
    .unwrap();
    for vector in vectors {
        assert_eq!(
            terminal_event_id(
                &vector.binding_id,
                &vector.generation,
                &vector.attempt_id,
                vector.host_turn_id.as_deref(),
                vector.kind,
                vector.source_event_id.as_deref()
            )
            .unwrap(),
            vector.expected_id
        );
    }
    let cases: std::collections::BTreeMap<String, Vec<NormalizedEvent>> =
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/contracts/adapter/scenarios.json"
        )))
        .unwrap();
    for events in cases.values() {
        ObserveResult {
            events: events.clone(),
            next_checkpoint: None,
        }
        .validate_for(&observe())
        .unwrap();
    }
    assert_eq!(cases["replay"][2], cases["replay"][3]);
    assert_ne!(
        cases["conflicting_turn"][0].host_turn_id,
        cases["conflicting_turn"][1].host_turn_id
    );
    assert_ne!(
        cases["conflicting_outcome"][0].event,
        cases["conflicting_outcome"][1].event
    );
    let identity = |event: &NormalizedEvent| {
        terminal_event_id(
            &event.binding_id,
            &event.generation,
            event.attempt_id.as_ref().unwrap(),
            event.host_turn_id.as_deref(),
            TerminalEventKind::TurnFinished,
            None,
        )
        .unwrap()
    };
    assert_eq!(
        identity(&cases["conflicting_outcome"][0]),
        identity(&cases["conflicting_outcome"][1])
    );
    let mut diagnostic = cases["conflicting_outcome"][0].clone();
    if let EventPayload::TurnFinished {
        diagnostic_text, ..
    } = &mut diagnostic.event
    {
        *diagnostic_text = Some("Different diagnostic reception".into());
    }
    assert_eq!(
        identity(&diagnostic),
        identity(&cases["conflicting_outcome"][0])
    );
    assert!(matches!(
        cases["uncertainty"][0].event,
        EventPayload::Uncertain { .. }
    ));
    assert_ne!(
        cases["same_text_distinct_chunks"][0].event_id,
        cases["same_text_distinct_chunks"][1].event_id
    );
    // Core decides replay/conflict effects; protocol must retain the actual facts.
    let stable = terminal_event_id(
        &id('a'),
        &id('b'),
        &id('d'),
        Some("host-turn/α"),
        TerminalEventKind::TurnFinished,
        None,
    )
    .unwrap();
    assert_eq!(
        stable,
        "6c9129da06c2e469a2606a933831db021a3c5cc61447dfc00862882413e2c45e"
    );
    for (generation, attempt, turn, kind) in [
        (
            id('f'),
            id('d'),
            Some("host-turn/α"),
            TerminalEventKind::TurnFinished,
        ),
        (
            id('b'),
            id('f'),
            Some("host-turn/α"),
            TerminalEventKind::TurnFinished,
        ),
        (
            id('b'),
            id('d'),
            Some("other-turn"),
            TerminalEventKind::TurnFinished,
        ),
        (
            id('b'),
            id('d'),
            Some("host-turn/α"),
            TerminalEventKind::Rejected,
        ),
        (
            id('b'),
            id('d'),
            Some("host-turn/α"),
            TerminalEventKind::Uncertain,
        ),
    ] {
        assert_ne!(
            terminal_event_id(&id('a'), &generation, &attempt, turn, kind, None).unwrap(),
            stable
        );
    }
    let absent = terminal_event_id(
        &id('a'),
        &id('b'),
        &id('d'),
        None,
        TerminalEventKind::Uncertain,
        None,
    )
    .unwrap();
    let literal = terminal_event_id(
        &id('a'),
        &id('b'),
        &id('d'),
        Some("null"),
        TerminalEventKind::Uncertain,
        None,
    )
    .unwrap();
    assert_ne!(absent, literal);
    let source = "é".repeat(2048);
    assert_eq!(
        terminal_event_id(
            &id('a'),
            &id('b'),
            &id('d'),
            None,
            TerminalEventKind::Rejected,
            Some(&source)
        )
        .unwrap(),
        source
    );
    assert!(terminal_event_id(
        &id('a'),
        &id('b'),
        &id('d'),
        None,
        TerminalEventKind::Rejected,
        Some("")
    )
    .is_err());
    assert!(terminal_event_id(
        &id('a'),
        &id('b'),
        &id('d'),
        Some(""),
        TerminalEventKind::Uncertain,
        None
    )
    .is_err());
    assert!(terminal_event_id(
        &id('a'),
        &id('b'),
        &id('d'),
        None,
        TerminalEventKind::TurnFinished,
        None
    )
    .is_err());
}
