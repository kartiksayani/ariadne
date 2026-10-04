use ariadne_domain::models::*;
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

const ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TIME: &str = "2026-10-03T12:34:56.789Z";

fn published_schema<T: JsonSchema>() -> Value {
    let schema = schemars::generate::SchemaSettings::default()
        .for_serialize()
        .into_generator()
        .into_root_schema_for::<T>();
    let derived = serde_json::to_value(schema).unwrap();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../../contracts/generated/domain/models/{}.schema.json",
        T::schema_name()
    ));
    let published: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(
        published,
        derived,
        "Generated {} schema is stale",
        T::schema_name()
    );
    published
}

fn assert_wire<T: JsonSchema + DeserializeOwned + Serialize>(value: Value) -> Value {
    let record: T = serde_json::from_value(value.clone()).unwrap();
    let emitted = serde_json::to_value(record).unwrap();
    let schema = published_schema::<T>();
    let validator = jsonschema::draft202012::options()
        .should_validate_formats(true)
        .build(&schema)
        .unwrap();
    assert!(
        validator.is_valid(&emitted),
        "{emitted}: {:?}",
        validator.iter_errors(&emitted).collect::<Vec<_>>()
    );
    emitted
}

fn reject_wire<T: JsonSchema + DeserializeOwned>(value: Value) {
    assert!(
        serde_json::from_value::<T>(value.clone()).is_err(),
        "Rust accepted {value}"
    );
    let schema = published_schema::<T>();
    let validator = jsonschema::draft202012::options()
        .should_validate_formats(true)
        .build(&schema)
        .unwrap();
    assert!(!validator.is_valid(&value), "Schema accepted {value}");
}

fn option() -> Value {
    json!({"id":"yes","label":"Use the proposed approach","consequence":"Preserves history","recommended":true})
}
fn origin() -> Value {
    json!({"project_id":ID,"session_id":ID,"topic_id":ID,"entity_id":ID,"source_revision":2})
}
fn message() -> Value {
    let mut provenance = origin();
    provenance["author"] = json!("agent");
    provenance["binding_id"] = json!(ID);
    provenance["adapter_id"] = json!("original.adapter");
    provenance["external_session_id"] = json!("original-host-thread");
    json!({"id":ID,"number":1,"author":"agent","kind":"reply","body":"Complete reply\nwith all lines.",
        "created_at":TIME,"item_id":"1","topic_id":ID,"items_touched":["1"],"binding_id":ID,
        "input_id":ID,"attempt_id":ID,"host_turn_id":"turn-1","round_id":ID,"origin":provenance})
}
fn item() -> Value {
    let mut provenance = origin();
    provenance["entity_id"] = json!("2.1");
    json!({"id":"1","ordinal":1,"topic_id":ID,"parent":null,"question":"Which approach?",
        "type":"decision","status":"waiting_on_me","owner":{"kind":"me"},"revision":2,
        "question_revision":1,"next_child":1,"ask":"Choose an option.","note":null,"options":[option()],
        "links":[{"kind":"doc","label":"Design","target":"docs/design.md"}],"outcome":null,"why":null,
        "replaced_by":null,"created_at":TIME,"updated_at":TIME,"created_message_id":ID,
        "updated_message_ids":[ID],"status_history":[{"old_status":"done","new_status":"open",
            "previous_outcome":"Completed","previous_why":"Original work finished","previous_replaced_by":null,
            "cause_message_id":ID,"at":TIME,"binding_id":ID,"handled_through_message_number":0,"reason":"Revisit"}],
        "waiting_since":TIME,"recipient_binding_id":ID,"current_round_id":ID,"source_round_id":null,"origin":provenance})
}
fn round() -> Value {
    json!({"id":ID,"item_id":"1","ordinal":1,"opened_message_id":ID,"question_snapshot":"Which approach?",
        "ask_snapshot":"Choose an option.","options_snapshot":[option()],"question_revision":1,
        "owner_message_ids":[ID],"agent_message_ids":[ID],"result_input_ids":[ID],"fork_item_ids":["1.1"],
        "closed_at":null,"origin":origin()})
}
fn result() -> Value {
    json!({"operation_id":ID,"outcome":"answered","explanation":"Published the reply.",
        "reply_message_ids":[ID],"followup_item_ids":["1.1"],"handled_through_message_number":1,
        "committed_revision":2,"committed_at":TIME})
}
fn attempt() -> Value {
    json!({"id":ID,"purpose":"work","repair_for_attempt_id":null,"claim_request_id":ID,
        "binding_generation":ID,"prepared_at":TIME,"formatted_payload":"Exact owner text\nwith context",
        "payload_sha256":"a".repeat(64),"wire_marker":"[ARIADNE_INPUT:input:attempt]","acceptance":"accepted",
        "acceptance_receipt":{"provider_reference":"provider-acceptance","observed_at":TIME},
        "acceptance_observed_at":TIME,"host_turn_id":"turn-1","turn_state":"completed","turn_observed_at":TIME,
        "domain_result":result(),"result_state":"committed","sealed_at":TIME,"error":null,
        "reconciliation_checkpoint":"private adapter page anchor"})
}
fn input() -> Value {
    let mut repair = attempt();
    repair["purpose"] = json!("result_repair");
    repair["repair_for_attempt_id"] = json!(ID);
    repair["formatted_payload"] = json!("Publish a result for prior work only.");
    json!({"id":ID,"seq":1,"binding_id":ID,"kind":"answer","target":{"topic_id":ID,"item_id":"1"},
        "message_id":ID,"answer_id":ID,"created_at":TIME,"expected_question_revision":1,
        "payload":{"text":"Yes.\nKeep history.","intent":"answer","target_snapshot":{"topic_name":"Reliability",
            "item_question":"Which approach?","question_revision":1,"ask":"Choose an option.","options":[option()]},
            "selected_option_id":"yes","context":{"message_ids":[ID],"item_ids":["1"],"round_id":ID,
                "continuation_operation_id":null}},"state":"handled","attempts":[attempt(),repair],"active_attempt_id":null,
        "resolution_history":[{"op_id":ID,"kind":"confirm_evidence","reason":"Checked the terminal.","at":TIME,
            "attempt_id":ID,"evidence":{"source":"owner_attestation","turn_state":"completed","host_turn_id":"turn-1",
                "owner_attested_idle":true,"at":TIME}}]})
}
fn continuation() -> Value {
    json!({"operation_id":ID,"source_project_id":ID,"source_session_id":ID,"source_topic_id":ID,
        "source_revision":2,"source_sha256":"b".repeat(64),"target_topic_id":ID,"target_input_id":ID,
        "item_id_map":{"2.1":"1"},"message_id_map":{ID:ID},"round_id_map":{ID:ID},"answer_id_map":{ID:ID},
        "summary":"Confirmed complete summary\nwith source context.","confirmed_at":TIME})
}
fn capabilities() -> Value {
    let capability = json!({"supported":true,"conditions":["verified selected host"]});
    json!({"existing_session":capability,"deferred_delivery":capability,"turn_correlation":capability,
        "turn_completion":capability,"domain_cli":capability,"domain_mcp":capability,"history_reconcile":capability,
        "streaming_output":capability,"final_text_read":capability,"discover_sessions":capability,"delivery_mode":"pull"})
}
fn binding() -> Value {
    json!({"id":ID,"adapter_id":"example.local","adapter_version":"1.0","protocol_major":1,"config_version":1,
        "external_session_id":"host-thread","endpoint":{"kind":"local_bridge","name":"claude-mod"},
        "endpoint_fingerprint":"opaque endpoint identity","generation":ID,"created_at":TIME,"dispatch_state":"paused",
        "owner_paused":true,"pause_reason":"result_missing","connection_state":"connected","capabilities":capabilities(),
        "active_input_id":null,"issued_through_message_number":1,"adapter_config":{"namespace":"example.local",
            "values":{"null":null,"array":[true,2.5,"unchanged"],"object":{"nested":false}}}})
}
fn apply_data() -> Value {
    json!({"kind":"apply","allocated_refs":{"child":{"kind":"item","id":"1.1"},
        "reply":{"kind":"message","id":ID},"topic":{"kind":"topic","id":ID},"round":{"kind":"round","id":ID}},
        "messages":[{"id":ID,"number":1}],"item_revisions":{"1":2},"topic_revisions":{ID:2},
        "input_result_state":"committed","queue_join_state":"handled"})
}
fn saved_receipt(data: Value) -> Value {
    json!({"operation_id":ID,"session_id":ID,"revision":2,"data":data})
}
fn session() -> Value {
    json!({"schema_version":1,"id":ID,"project_id":ID,"title":"Shape example","state":"active","created_at":TIME,
        "updated_at":TIME,"revision":2,"closed_at":null,"counters":{"next_root":2,"next_topic_order":2,
            "next_message":2,"next_input":2,"next_answer":2},"active_binding_id":ID,
        "topics":{ID:{"id":ID,"name":"Reliability","order":1,"revision":1,"created_at":TIME,"archived_at":null,
            "origin":{"project_id":ID,"session_id":ID,"topic_id":ID,"source_revision":1,"continued_at":TIME}}},
        "items":{"1":item()},"messages":[message()],"rounds":{ID:round()},"answers":[{"id":ID,"seq":1,
            "item_id":"1","question_revision":1,"question_snapshot":"Which approach?","ask_snapshot":"Choose an option.",
            "options_snapshot":[option()],"selected_option_id":"yes","text":"Keep history.","message_id":ID,"input_id":ID,
            "supersedes_answer_id":null,"created_at":TIME}],"bindings":{ID:binding()},"inputs":{ID:input()},
        "operation_receipts":{ID:[{"operation_id":ID,"actor_scope":{"kind":"owner"},"command_digest":"c".repeat(64),
            "result":saved_receipt(apply_data())}]},"continuations":{ID:continuation()}})
}

#[test]
fn stored_inventory_round_trips_complete_nested_records() {
    let value = session();
    assert_eq!(assert_wire::<Session>(value.clone()), value);
    assert_wire::<Project>(json!({"schema_version":1,"id":ID,"display_name":"Example project"}));
    assert_eq!(assert_wire::<Input>(input()), input());
    assert_wire::<PresenceObservation>(
        json!({"instance_id":ID,"generation":ID,"connection_state":"unknown",
        "execution_state":"unknown","last_seen_at":null,"source":null,"process_identity":null,"freshness":"historical"}),
    );
    assert_wire::<PresenceObservation>(
        json!({"instance_id":ID,"generation":ID,"connection_state":"connected",
        "execution_state":"running","last_seen_at":TIME,"source":"host_event",
        "process_identity":{"pid":123,"started_at":TIME},"freshness":"fresh"}),
    );
}

#[test]
fn optional_reads_emit_explicit_null_and_collections_remain_required() {
    let mut value = message();
    for key in [
        "item_id",
        "topic_id",
        "binding_id",
        "input_id",
        "attempt_id",
        "host_turn_id",
        "round_id",
        "origin",
    ] {
        value.as_object_mut().unwrap().remove(key);
    }
    let emitted = assert_wire::<Message>(value.clone());
    for key in [
        "item_id",
        "topic_id",
        "binding_id",
        "input_id",
        "attempt_id",
        "host_turn_id",
        "round_id",
        "origin",
    ] {
        assert_eq!(emitted.get(key), Some(&Value::Null));
    }
    value.as_object_mut().unwrap().remove("items_touched");
    reject_wire::<Message>(value);
    let mut missing = session();
    missing
        .as_object_mut()
        .unwrap()
        .remove("operation_receipts");
    reject_wire::<Session>(missing);
    let mut future = session();
    future["schema_version"] = json!(2);
    reject_wire::<Session>(future);
}

#[test]
fn tagged_variants_and_typed_receipts_have_exact_payloads() {
    for owner in [
        json!({"kind":"me"}),
        json!({"kind":"agent","binding_id":ID}),
        json!({"kind":"other","name":"Reviewer"}),
    ] {
        assert_eq!(assert_wire::<ItemOwner>(owner.clone()), owner);
    }
    reject_wire::<ItemOwner>(json!({"kind":"agent"}));
    reject_wire::<ItemOwner>(json!({"kind":"me","binding_id":ID}));
    assert_wire::<EndpointRef>(json!({"kind":"unix_socket","path":"/tmp/provider.sock"}));
    reject_wire::<EndpointRef>(json!({"kind":"tcp","path":"localhost"}));
    for data in [
        json!({"kind":"input_submit","input_id":ID,"message_id":ID,"message_number":1,"answer_id":null,"input_seq":1}),
        json!({"kind":"input_cancel","input_id":ID,"state":"cancelled"}),
        json!({"kind":"input_resolve","input_id":ID,"attempt_id":ID,"resolution_kind":"skip","state":"skipped"}),
        json!({"kind":"topic_lifecycle","topic_id":ID,"topic_revision":2,"archived_at":TIME}),
        json!({"kind":"session_lifecycle","state":"closed","closed_at":TIME}),
        json!({"kind":"binding_connect","binding_id":ID,"generation":ID,"capabilities":capabilities(),"setup_instruction":"Use explicit routing."}),
        json!({"kind":"binding_state","binding_id":ID,"generation":ID,"dispatch_state":"paused","owner_paused":true,
            "pause_reason":null,"connection_state":"connected"}),
        apply_data(),
        json!({"kind":"claim","input_id":ID,"attempt_id":ID}),
        json!({"kind":"delivery_expiry","input_id":ID,"attempt_id":ID}),
        json!({"kind":"event_conflict","event_id":"opaque/事实/✓","input_id":ID,"attempt_id":ID}),
        json!({"kind":"event_conflict","event_id":"binding-fact","input_id":null,"attempt_id":null}),
        json!({"kind":"event","event_id":"source-event","input_id":null,"attempt_id":null,"durable_effect":true}),
        json!({"kind":"continuation","continuation":continuation()}),
    ] {
        let receipt = saved_receipt(data);
        assert_eq!(assert_wire::<SavedReceipt>(receipt.clone()), receipt);
    }
    let mut wrong = apply_data();
    wrong["allocated_refs"] = json!({"1bad":{"kind":"item","id":"1"}});
    reject_wire::<SavedReceipt>(saved_receipt(wrong));
    reject_wire::<OwnerEvidenceSource>(json!("adapter_observation"));
}

#[test]
fn lexical_keys_and_duplicate_keys_are_rejected_in_real_nested_maps() {
    for invalid in [
        "INVALID",
        "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa",
    ] {
        let mut value = session();
        value["topics"] = json!({invalid:value["topics"][ID].clone()});
        reject_wire::<Session>(value);
    }
    for invalid in ["01", "1.0", "9007199254740992", "1\n"] {
        let mut value = continuation();
        value["item_id_map"] = json!({invalid:"1"});
        reject_wire::<ContinuationReceipt>(value);
    }
    let text = format!("{{\"{ID}\":[],\"{ID}\":[]}}");
    let error =
        serde_json::from_str::<UniqueMap<UuidV4, Vec<OperationReceipt>>>(&text).unwrap_err();
    assert!(error.to_string().contains("duplicate map key"));
    for values in [
        "{\"x\":1,\"x\":2}",
        "{\"outer\":{\"x\":1,\"x\":2}}",
        "{\"outer\":[{\"x\":1,\"x\":2}]}",
    ] {
        let config = format!("{{\"namespace\":\"example\",\"values\":{values}}}");
        assert!(serde_json::from_str::<AdapterConfig>(&config)
            .unwrap_err()
            .to_string()
            .contains("duplicate map key"));
    }
    assert!(serde_json::from_str::<UniqueMap<UuidV4, String>>("[]").is_err());
}

#[test]
fn checkpoint_checks_utf8_bytes_without_claiming_schema_byte_parity() {
    for good in [
        String::new(),
        "x".repeat(4096),
        "é".repeat(2048),
        "😀".repeat(1024),
    ] {
        let record = Checkpoint::new(good.clone()).unwrap();
        assert_eq!(record.as_str(), good);
        assert_eq!(assert_wire::<Checkpoint>(json!(good)), json!(good));
    }
    for bad in ["x".repeat(4097), "é".repeat(2049), "😀".repeat(1025)] {
        assert!(Checkpoint::new(bad.clone()).is_err());
        assert!(serde_json::from_value::<Checkpoint>(json!(bad)).is_err());
    }
    reject_wire::<Checkpoint>(json!(17));
}

#[test]
fn arbitrary_config_json_preserves_every_value_kind_and_number() {
    let text = r#"{"namespace":"example","values":{"null":null,"bool":true,"negative":-12,"large":18446744073709551615,"decimal":1.25,"string":"text\nwith lines","array":[null,{},[]],"object":{"nested":false}}}"#;
    let record: AdapterConfig = serde_json::from_str(text).unwrap();
    let value: Value = serde_json::from_str(text).unwrap();
    assert_eq!(serde_json::to_value(&record).unwrap(), value);
    assert_eq!(assert_wire::<AdapterConfig>(value.clone()), value);
    assert!(serde_json::from_str::<AdapterConfig>(
        r#"{"namespace":"example","values":{"n":1e400}}"#
    )
    .is_err());
}

fn page(items: Vec<Value>, view: &str, position: Value) -> Value {
    json!({"items":items,"next_cursor":{"schema":1,"view":view,"filter_digest":"d".repeat(64),
        "after":position,"revision":2},"snapshot_revision":2})
}

#[test]
fn bounded_projections_keep_independent_pages_and_complete_provenance() {
    let mut snapshot = item();
    for field in ["updated_message_ids", "status_history"] {
        snapshot.as_object_mut().unwrap().remove(field);
    }
    assert_eq!(assert_wire::<ItemSnapshot>(snapshot.clone()), snapshot);
    let projection = json!({"item":snapshot,
        "updated_messages":page(vec![message()],"item_updated_messages",json!({"kind":"sequence","number":1,"id":ID})),
        "status_history":page(vec![item()["status_history"][0].clone()],"item_status_history",json!({"kind":"history","index":0}))});
    assert_eq!(
        assert_wire::<ItemReadProjection>(projection.clone()),
        projection
    );
    let mut snapshot = round();
    for field in [
        "owner_message_ids",
        "agent_message_ids",
        "result_input_ids",
        "fork_item_ids",
    ] {
        snapshot.as_object_mut().unwrap().remove(field);
    }
    assert_wire::<RoundSnapshot>(snapshot.clone());
    let answer = session()["answers"][0].clone();
    let projection = json!({"round":snapshot,
        "answers":page(vec![answer],"round_answers",json!({"kind":"sequence","number":1,"id":ID})),
        "owner_messages":page(vec![message()],"round_owner_messages",json!({"kind":"sequence","number":1,"id":ID})),
        "agent_messages":page(vec![message()],"round_agent_messages",json!({"kind":"sequence","number":2,"id":ID})),
        "results":page(vec![json!({"input_id":ID,"attempt_id":ID,"result":result()})],"round_results",
            json!({"kind":"result","input_seq":1,"attempt_ordinal":1,"input_id":ID,"attempt_id":ID})),
        "forks":page(vec![json!({"project_id":ID,"session_id":ID,"item_id":"1.1","question":"Follow-up?","status":"open"})],
            "round_forks",json!({"kind":"item","ordinals":[1,1],"id":"1.1"}))});
    let emitted = assert_wire::<RoundProjection>(projection.clone());
    assert_eq!(emitted, projection);
    assert_ne!(
        emitted["owner_messages"]["next_cursor"],
        emitted["agent_messages"]["next_cursor"]
    );
    let rounds = json!({"item_id":"1","rounds":page(vec![emitted],"item_rounds",json!({"kind":"round","ordinal":1,"id":ID}))});
    assert_eq!(assert_wire::<ItemRoundsProjection>(rounds.clone()), rounds);
    assert_wire::<ItemMessagesProjection>(json!({"item_id":"1",
        "messages":page(vec![message()],"item_messages",json!({"kind":"sequence","number":1,"id":ID})),
        "timeline_context":{"parent_item_id":null,"created_message":message(),"source_round_id":null}}));
    reject_wire::<ItemSnapshot>(item());
    reject_wire::<RoundSnapshot>(round());
    reject_wire::<Page<Message>>(json!({"items":null,"next_cursor":null,"snapshot_revision":2}));
}

fn counts() -> Value {
    json!({"items_by_status":{"open":0,"waiting_on_me":1,"in_progress":0,"decided":0,"done":0,"dropped":0,"replaced":0},
        "waiting_unanswered":1,"sent_inputs":{"queued":1,"in_flight":0,"needs_attention":0},
        "archived_topics":0,"completeness":"partial","unavailable_session_ids":[ID]})
}

#[test]
fn summaries_preserve_incompleteness_and_all_seven_status_counts() {
    assert_eq!(assert_wire::<SummaryCounts>(counts()), counts());
    let project = json!({"schema_version":1,"id":ID,"display_name":"Example"});
    assert_wire::<ProjectSummary>(
        json!({"project_id":ID,"project":project,"canonical_root":"/registered/project",
        "availability":"unavailable","counts":counts()}),
    );
    assert_wire::<ProjectSummary>(
        json!({"project_id":ID,"project":null,"canonical_root":"/unavailable/project",
        "availability":"unavailable","counts":counts()}),
    );
    reject_wire::<ProjectSummary>(
        json!({"project_id":ID,"canonical_root":"/unavailable/project",
        "availability":"unavailable","counts":counts()}),
    );
    assert_wire::<SessionSummary>(
        json!({"project_id":ID,"session_id":ID,"title":"Historical session","state":"closed",
        "revision":2,"created_at":TIME,"updated_at":TIME,"closed_at":TIME,"active_binding":null,"counts":counts()}),
    );
    let mut missing = counts();
    missing["items_by_status"]
        .as_object_mut()
        .unwrap()
        .remove("replaced");
    reject_wire::<SummaryCounts>(missing);
    let mut negative = counts();
    negative["waiting_unanswered"] = json!(-1);
    reject_wire::<SummaryCounts>(negative);
    let mut extra = counts();
    extra["active_sessions"] = json!(1);
    reject_wire::<SummaryCounts>(extra);
}

#[test]
fn every_cursor_sort_key_is_typed_and_none_is_an_opaque_token() {
    for position in [
        json!({"kind":"sequence","number":1,"id":ID}),
        json!({"kind":"topic","order":1,"id":ID}),
        json!({"kind":"item","ordinals":[1,2],"id":"1.2"}),
        json!({"kind":"round","ordinal":1,"id":ID}),
        json!({"kind":"project","canonical_root":"/registered/project","id":ID}),
        json!({"kind":"session","updated_at":TIME,"project_id":ID,"id":ID}),
        json!({"kind":"history","index":0}),
        json!({"kind":"result","input_seq":1,"attempt_ordinal":2,"input_id":ID,"attempt_id":ID}),
        Value::Null,
    ] {
        let cursor = json!({"schema":1,"view":"items","filter_digest":"d".repeat(64),"after":position,"revision":2});
        assert_eq!(assert_wire::<QueryCursor>(cursor.clone()), cursor);
    }
    reject_wire::<QueryCursor>(json!("opaque-token"));
    reject_wire::<CursorPosition>(json!({"kind":"item","ordinals":[0],"id":"1"}));
}
