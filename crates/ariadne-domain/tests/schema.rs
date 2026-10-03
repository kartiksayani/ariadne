use ariadne_domain::models::*;
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::BTreeMap;

mod fixture_support;

fn check<T: JsonSchema + DeserializeOwned>(good: &[Value], bad: &[Value]) {
    let schema = schemars::generate::SchemaSettings::default()
        .for_serialize()
        .into_generator()
        .into_root_schema_for::<T>();
    let schema = serde_json::to_value(schema).unwrap();
    let validator = jsonschema::draft202012::options()
        .should_validate_formats(true)
        .build(&schema)
        .unwrap();
    for (values, expected) in [(good, true), (bad, false)] {
        for value in values {
            assert_eq!(validator.is_valid(value), expected, "schema {value}");
            assert_eq!(
                serde_json::from_value::<T>(value.clone()).is_ok(),
                expected,
                "Rust {value}"
            );
        }
    }
}

#[test]
fn primitive_schemas_enforce_actual_wire_constraints() {
    let max = 9_007_199_254_740_991_u64;
    check::<PositiveSafeInteger>(
        &[json!(1), json!(max)],
        &[json!(0), json!(max + 1), json!(1.5), json!("1")],
    );
    check::<NonnegativeSafeInteger>(
        &[json!(0), json!(max)],
        &[json!(-1), json!(max + 1), json!(1.5)],
    );
    check::<SchemaVersion>(&[json!(1)], &[json!(0), json!(2), json!("1")]);
    check::<Sha256>(
        &[json!("a".repeat(64))],
        &[
            json!("A".repeat(64)),
            json!("a".repeat(63)),
            json!(format!("{}\n", "a".repeat(64))),
        ],
    );
    check::<RequestRef>(
        &[json!("A"), json!("a".repeat(32))],
        &[
            json!("1a"),
            json!("a".repeat(33)),
            json!("a-b"),
            json!("A\n"),
        ],
    );
    check::<UuidV4>(
        &[json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")],
        &[
            json!("aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa"),
            json!("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"),
            json!("aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa"),
            json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n"),
        ],
    );
    check::<ItemRef>(
        &[json!("1.2"), json!("9007199254740991.999999999999999")],
        &[
            json!("01"),
            json!("0"),
            json!("1.0"),
            json!("1..2"),
            json!("9007199254740992"),
            json!("9999999999999999"),
            json!("1.2\n"),
            json!("１"),
        ],
    );
}

#[test]
fn integer_schemas_and_rust_agree_on_integral_float_json_values() {
    let one: Value = serde_json::from_str("1e0").unwrap();
    let max: Value = serde_json::from_str("9007199254740991.0").unwrap();
    let bad = [
        json!(-1),
        json!(-1.0),
        json!(1.5),
        json!(9_007_199_254_740_992_u64),
        json!(9_007_199_254_740_992_f64),
        json!(1e300),
        json!("1"),
        json!(null),
    ];
    check::<PositiveSafeInteger>(
        &[json!(1.0), one.clone(), max.clone()],
        &[bad.to_vec(), vec![json!(0.0)]].concat(),
    );
    check::<NonnegativeSafeInteger>(
        &[json!(0.0), json!(-0.0), json!(1.0), one.clone(), max],
        &bad,
    );
    check::<SchemaVersion>(
        &[json!(1.0), one],
        &[bad.to_vec(), vec![json!(0.0), json!(2.0)]].concat(),
    );
}

#[test]
fn generated_map_schema_rejects_invalid_typed_keys() {
    check::<BTreeMap<UuidV4, String>>(
        &[
            json!({"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa":"value"}),
            json!({}),
        ],
        &[
            json!({"invalid":"value"}),
            json!({"aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa":"value"}),
            json!({"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA":"value"}),
        ],
    );
    check::<BTreeMap<ItemRef, String>>(
        &[json!({"9007199254740991.2":"value"})],
        &[
            json!({"9007199254740992":"value"}),
            json!({"01":"value"}),
            json!({"1.0":"value"}),
            json!({"1\n":"value"}),
        ],
    );
}

#[test]
fn item_reference_schema_matches_safe_integer_decimal_boundaries() {
    let max = 9_007_199_254_740_991_u64;
    let mut good = Vec::new();
    for value in [
        1,
        9,
        10,
        999_999_999_999_999,
        1_000_000_000_000_000,
        max - 1,
        max,
    ] {
        good.push(json!(value.to_string()));
        good.push(json!(format!("1.{value}.2")));
    }
    check::<ItemRef>(
        &good,
        &[
            json!((max + 1).to_string()),
            json!(format!("1.{}.2", max + 1)),
            json!("9999999999999999"),
            json!("10000000000000000"),
            json!("01.2"),
            json!("1.02"),
        ],
    );
}

#[test]
fn datetime_format_assertion_and_canonical_round_trip_agree() {
    check::<UtcMillis>(
        &[
            json!("0000-02-29T23:59:60.123Z"),
            json!("1900-02-28T23:59:60.123Z"),
            json!("2000-02-29T23:59:60.123Z"),
            json!("2023-02-28T23:59:60.123Z"),
            json!("2024-02-29T23:59:60.123Z"),
            json!("2024-01-31T23:59:60.999Z"),
            json!("2024-04-30T23:59:60.001Z"),
            json!("9999-12-31T23:59:60.123Z"),
            json!("2024-02-28T23:59:59.123Z"),
            json!("0000-02-28T23:59:60.123Z"),
            json!("2000-02-28T23:59:60.123Z"),
            json!("2024-02-28T23:59:60.123Z"),
            json!("2024-04-29T23:59:60.123Z"),
        ],
        &[
            json!("1900-02-29T23:59:60.123Z"),
            json!("2024-04-31T23:59:60.123Z"),
            json!("2024-02-29T12:34:60.123Z"),
            json!("2024-02-29T23:58:60.123Z"),
            json!("2024-02-29T23:59:60.123Z\n"),
            json!("2024-02-29T12:34:56.123+00:00"),
            json!("2024-02-29t12:34:56.123z"),
            json!("2024-02-29T12:34:56.12Z"),
            json!("+10000-01-01T00:00:00.000Z"),
            json!("2023-02-29T12:34:56.123Z"),
            json!("2024-02-29T24:00:00.123Z"),
            json!("2024-02-29T23:60:00.123Z"),
            json!("2024-02-29T12:34:61.123Z"),
        ],
    );
}

#[test]
fn checked_in_canonical_records_conform_to_rust_schema_and_typescript() {
    let mut source = String::new();
    macro_rules! record {
        ($type:ty, $path:literal, $name:literal, $ts:literal) => {
            fixture_support::literal(
                &mut source,
                $name,
                $ts,
                &fixture_support::canonical::<$type>($path),
            );
        };
    }
    record!(Project, "demo/project.json", "project", "D.Project");
    record!(Session, "demo/session.json", "session", "D.Session");
    record!(
        Project,
        "demo/source-project.json",
        "sourceProject",
        "D.Project"
    );
    record!(
        Session,
        "demo/source-session.json",
        "sourceSession",
        "D.Session"
    );
    record!(
        PresenceObservation,
        "demo/presence.json",
        "presence",
        "D.PresenceObservation"
    );
    record!(
        Page<ProjectSummary>,
        "projections/projects.json",
        "projects",
        "D.Page<D.ProjectSummary>"
    );
    record!(
        Page<SessionSummary>,
        "projections/sessions.json",
        "sessions",
        "D.Page<D.SessionSummary>"
    );
    record!(
        Page<Topic>,
        "projections/topics.json",
        "topics",
        "D.Page<D.Topic>"
    );
    record!(
        Page<ItemReadProjection>,
        "projections/items.json",
        "items",
        "D.Page<D.ItemReadProjection>"
    );
    record!(
        Page<ItemSnapshot>,
        "projections/item-snapshots.json",
        "snapshots",
        "D.Page<D.ItemSnapshot>"
    );
    record!(
        Page<Input>,
        "projections/inputs.json",
        "inputs",
        "D.Page<D.Input>"
    );
    record!(
        ItemMessagesProjection,
        "projections/item-messages.json",
        "messages",
        "D.ItemMessagesProjection"
    );
    record!(
        ItemRoundsProjection,
        "projections/item-rounds.json",
        "rounds",
        "D.ItemRoundsProjection"
    );
    for position in [
        "sequence", "topic", "item", "round", "project", "session", "history", "result",
    ] {
        let path = format!("cursors/{position}.json");
        fixture_support::literal(
            &mut source,
            &format!("cursor_{position}"),
            "D.QueryCursor",
            &fixture_support::canonical::<QueryCursor>(&path),
        );
    }
    // Every assignment uses the exact serialized Rust value as a static literal.
    // No casts, JSON.parse or inferred JSON imports can bypass the generated DTOs.
    fixture_support::check_typescript(&source);
}

#[test]
fn checked_in_invalid_and_future_records_fail_declared_wire_constraints() {
    fixture_support::invalid::<InputTarget>("invalid/invalid-item-ref.json");
    fixture_support::invalid::<ContinuationReceipt>("invalid/invalid-uuid-key.json");
    fixture_support::invalid::<ContinuationReceipt>("invalid/invalid-item-key.json");
    fixture_support::invalid::<ProjectSummary>("invalid/unsafe-revision.json");
    fixture_support::invalid::<HostReceipt>("invalid/invalid-timestamp.json");
    fixture_support::invalid::<OperationReceipt>("invalid/invalid-digest.json");
    let mut source = String::new();
    macro_rules! rejected {
        ($type:ty, $path:literal, $name:literal, $ts:literal) => {
            fixture_support::invalid::<$type>($path);
            source
                .push_str("// @ts-expect-error fixture violates an expressible wire constraint\n");
            fixture_support::literal(&mut source, $name, $ts, &fixture_support::value($path));
        };
    }
    rejected!(
        ItemOwner,
        "invalid/unknown-owner-kind.json",
        "unknownOwner",
        "D.ItemOwner"
    );
    rejected!(
        ItemOwner,
        "invalid/missing-agent-binding.json",
        "missingBinding",
        "D.ItemOwner"
    );
    rejected!(
        ItemOwner,
        "invalid/unexpected-owner-field.json",
        "unexpectedOwnerField",
        "D.ItemOwner"
    );
    rejected!(
        Page<Message>,
        "invalid/missing-collection.json",
        "missingCollection",
        "D.Page<D.Message>"
    );
    rejected!(
        SavedReceipt,
        "invalid/unknown-receipt-field.json",
        "unknownReceiptField",
        "D.SavedReceipt"
    );
    rejected!(
        SavedReceipt,
        "invalid/wrong-receipt-payload.json",
        "wrongReceiptPayload",
        "D.SavedReceipt"
    );
    rejected!(
        Project,
        "invalid/wrong-schema-wire-kind.json",
        "wrongSchemaKind",
        "D.Project"
    );
    rejected!(Project, "future/project.json", "futureProject", "D.Project");
    rejected!(Session, "future/session.json", "futureSession", "D.Session");
    rejected!(
        QueryCursor,
        "future/cursor.json",
        "futureCursor",
        "D.QueryCursor"
    );
    fixture_support::check_typescript(&source);
    // JSON Schema and TS see parsed objects, so duplicate keys are Rust-only.
    for error in [
        serde_json::from_str::<UniqueMap<UuidV4, Vec<OperationReceipt>>>(&fixture_support::text(
            "invalid/duplicate-map-key.json",
        ))
        .unwrap_err()
        .to_string(),
        serde_json::from_str::<AdapterConfig>(&fixture_support::text(
            "invalid/duplicate-config-key.json",
        ))
        .unwrap_err()
        .to_string(),
    ] {
        assert!(error.contains("duplicate map key"), "{error}");
    }
}

#[test]
fn canonical_demo_links_preserve_records_and_projection_snapshots() {
    let s = fixture_support::value("demo/session.json");
    let project = fixture_support::value("demo/project.json");
    assert_eq!(s["project_id"], project["id"]);
    fixture_support::check_digests();
    let messages: BTreeMap<_, _> = s["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| (m["id"].as_str().unwrap(), m))
        .collect();
    assert_eq!(messages.len(), s["messages"].as_array().unwrap().len());
    for (key, item) in s["items"].as_object().unwrap() {
        assert_eq!(key, item["id"].as_str().unwrap());
        assert!(s["topics"]
            .get(item["topic_id"].as_str().unwrap())
            .is_some());
        assert!(messages.contains_key(item["created_message_id"].as_str().unwrap()));
        for id in item["updated_message_ids"].as_array().unwrap() {
            assert!(messages.contains_key(id.as_str().unwrap()));
        }
        for field in ["parent", "replaced_by"] {
            if let Some(id) = item[field].as_str() {
                assert_eq!(s["items"][id]["topic_id"], item["topic_id"]);
            }
        }
        if let Some(id) = item["source_round_id"].as_str() {
            let round = &s["rounds"][id];
            assert_eq!(round["item_id"], item["parent"]);
            assert!(round["fork_item_ids"]
                .as_array()
                .unwrap()
                .contains(&item["id"]));
        }
    }
    for (key, input) in s["inputs"].as_object().unwrap() {
        assert_eq!(key, input["id"].as_str().unwrap());
        let message = messages[input["message_id"].as_str().unwrap()];
        assert_eq!(input["payload"]["text"], message["body"]);
        assert_eq!(message["input_id"], input["id"]);
        assert_eq!(message["binding_id"], input["binding_id"]);
        for attempt in input["attempts"].as_array().unwrap() {
            assert_eq!(
                attempt["binding_generation"],
                s["bindings"][input["binding_id"].as_str().unwrap()]["generation"]
            );
            if let Some(id) = attempt["repair_for_attempt_id"].as_str() {
                assert!(input["attempts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|a| a["id"] == id && a["purpose"] == "work"));
            }
            if !attempt["domain_result"].is_null() {
                for id in attempt["domain_result"]["reply_message_ids"]
                    .as_array()
                    .unwrap()
                {
                    assert_eq!(messages[id.as_str().unwrap()]["input_id"], input["id"]);
                }
            }
        }
    }
    for binding in s["bindings"].as_object().unwrap().values() {
        let active = &s["inputs"][binding["active_input_id"].as_str().unwrap()];
        assert_eq!(active["binding_id"], binding["id"]);
        for input in s["inputs"].as_object().unwrap().values() {
            if input["binding_id"] == binding["id"] && input["state"] == "queued" {
                assert!(input["seq"].as_u64().unwrap() > active["seq"].as_u64().unwrap());
            }
        }
    }
    for answer in s["answers"].as_array().unwrap() {
        let input = &s["inputs"][answer["input_id"].as_str().unwrap()];
        assert_eq!(input["answer_id"], answer["id"]);
        assert_eq!(input["payload"]["text"], answer["text"]);
        assert_eq!(
            input["payload"]["selected_option_id"],
            answer["selected_option_id"]
        );
        if let Some(id) = answer["supersedes_answer_id"].as_str() {
            assert!(s["answers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a["id"] == id));
        }
    }
    for receipt_list in s["operation_receipts"].as_object().unwrap().values() {
        for receipt in receipt_list.as_array().unwrap() {
            assert_eq!(receipt["operation_id"], receipt["result"]["operation_id"]);
            assert_eq!(s["id"], receipt["result"]["session_id"]);
        }
    }
    let source_session = fixture_support::value("demo/source-session.json");
    for continuation in s["continuations"].as_object().unwrap().values() {
        assert_eq!(continuation["source_session_id"], source_session["id"]);
        assert_eq!(continuation["source_revision"], source_session["revision"]);
        assert_eq!(
            s["inputs"][continuation["target_input_id"].as_str().unwrap()]["target"]["topic_id"],
            continuation["target_topic_id"]
        );
        for (source, target) in continuation["item_id_map"].as_object().unwrap() {
            assert_eq!(
                s["items"][target.as_str().unwrap()]["origin"]["entity_id"],
                source.as_str()
            );
        }
        for (source, target) in continuation["message_id_map"].as_object().unwrap() {
            let copied = messages[target.as_str().unwrap()];
            let original = source_session["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|message| message["id"] == source.as_str())
                .unwrap();
            assert_eq!(copied["body"], original["body"]);
            assert_eq!(copied["author"], original["author"]);
            assert_eq!(copied["origin"]["author"], original["author"]);
            assert_eq!(copied["origin"]["binding_id"], original["binding_id"]);
            assert!(
                copied["binding_id"].is_null(),
                "copy must not claim target authorship"
            );
            assert_eq!(
                messages[target.as_str().unwrap()]["origin"]["entity_id"],
                source.as_str()
            );
        }
        for (source, target) in continuation["round_id_map"].as_object().unwrap() {
            assert_eq!(
                s["rounds"][target.as_str().unwrap()]["origin"]["entity_id"],
                source.as_str()
            );
        }
    }
    let projected = fixture_support::value("projections/items.json");
    for read in projected["items"].as_array().unwrap() {
        let stored = &s["items"][read["item"]["id"].as_str().unwrap()];
        for (key, value) in read["item"].as_object().unwrap() {
            assert_eq!(value, &stored[key], "item snapshot field {key}");
        }
        assert_eq!(
            read["status_history"]["items"], stored["status_history"],
            "complete projected status history must equal the stored entries"
        );
        for message in read["updated_messages"]["items"].as_array().unwrap() {
            assert_eq!(message, messages[message["id"].as_str().unwrap()]);
        }
    }
    let projected = fixture_support::value("projections/item-rounds.json");
    let round = &projected["rounds"]["items"][0];
    let stored = &s["rounds"][round["round"]["id"].as_str().unwrap()];
    for (key, value) in round["round"].as_object().unwrap() {
        assert_eq!(value, &stored[key], "round snapshot field {key}");
    }
    assert_ne!(
        round["answers"]["next_cursor"],
        round["owner_messages"]["next_cursor"]
    );
    assert_eq!(
        round["results"]["items"][0]["result"],
        s["inputs"][round["results"]["items"][0]["input_id"].as_str().unwrap()]["attempts"][1]
            ["domain_result"]
    );
}
