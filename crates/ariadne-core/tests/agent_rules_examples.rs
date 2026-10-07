//! The worked examples in the shared agent rules are the only model-facing
//! ApplyRequest samples. They are extracted from the rule source so they cannot
//! drift from the real request type.
use ariadne_core::*;
use std::collections::BTreeSet;

const RULES: &str = include_str!("../../../integrations/rules/source.md");

fn examples() -> Vec<String> {
    let mut blocks = Vec::new();
    let mut current: Option<String> = None;
    for line in RULES.lines() {
        match (&mut current, line) {
            (None, "```json") => current = Some(String::new()),
            (Some(_), "```") => blocks.push(current.take().unwrap()),
            (Some(text), _) => text.push_str(line),
            _ => {}
        }
    }
    assert!(current.is_none(), "unterminated json fence");
    blocks
}

#[test]
fn every_rule_example_is_a_valid_apply_request_and_together_they_cover_the_surface() {
    let blocks = examples();
    assert!(blocks.len() >= 7, "expected the worked examples");
    let mut ops = BTreeSet::new();
    let mut outcomes = BTreeSet::new();
    let mut owners = BTreeSet::new();
    let (mut local_ref, mut child, mut local_topic) = (false, false, false);
    for block in &blocks {
        let request: ApplyRequest = serde_json::from_str(block)
            .unwrap_or_else(|error| panic!("example does not deserialize: {error}\n{block}"));
        request.validate_wire().unwrap();
        // Strict round trip: no field the type would silently add or drop.
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            serde_json::from_str::<serde_json::Value>(block).unwrap(),
            "example is not canonical"
        );
        for operation in &request.operations {
            let value = serde_json::to_value(operation).unwrap();
            ops.insert(value["op"].as_str().unwrap().to_owned());
            if value["op"] == "topic.add" || value["op"] == "item.add" {
                // The rules tell agents to label everything they create.
                let short = value["short"].as_str().unwrap_or_else(|| {
                    panic!("{} example has no short label\n{block}", value["op"])
                });
                let words = short.split_whitespace().count();
                assert!((1..=4).contains(&words) && short.chars().count() <= 40);
            }
            if value["op"] == "item.add" {
                owners.insert(value["owner"]["kind"].as_str().unwrap().to_owned());
                child |= !value["parent"].is_null();
                local_topic |= value["topic"].get("ref").is_some();
            }
        }
        if let Some(result) = &request.input_result {
            outcomes.insert(
                serde_json::to_value(&result.outcome)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned(),
            );
            for reference in &result.reply_refs {
                // A result cites replies the agent wrote in this request; an
                // existing message id would be someone else's text.
                assert!(
                    matches!(reference, UuidRef::Local(_)),
                    "reply_refs must cite this request's replies"
                );
                local_ref = true;
            }
        }
    }
    for op in [
        "topic.add",
        "item.add",
        "item.edit",
        "item.ask",
        "item.status",
        "reply",
        "round.close",
    ] {
        assert!(ops.contains(op), "no example for {op}");
    }
    for outcome in ["answered", "deferred", "unable"] {
        assert!(outcomes.contains(outcome), "{outcome}");
    }
    assert!(owners.contains("agent") && owners.contains("other"));
    assert!(child && local_ref && local_topic);
}

#[test]
fn rules_explain_the_envelope_fields_and_every_error_code_they_name_exists() {
    for needle in [
        "`attempt_id`",
        "`owner_message_number`",
        "`handled_through_message_number`",
        "[ARIADNE_INPUT:",
        "SAME `op_id`",
        "`short` label",
        "at most 40 characters",
    ] {
        assert!(RULES.contains(needle), "{needle}");
    }
    for code in [
        "stale_generation",
        "attempt_sealed",
        "result_already_committed",
        "commit_uncertain",
        "store_busy",
        "io_error",
        "revision_conflict",
        "invalid_transition",
        "binding_mismatch",
        "operation_reused",
        "invalid_argument",
        "invalid_ref",
        "unsupported",
        "future_schema",
    ] {
        serde_json::from_value::<CoreErrorCode>(serde_json::json!(code))
            .unwrap_or_else(|_| panic!("rules name unknown error code {code}"));
        assert!(RULES.contains(&format!("`{code}`")), "{code}");
    }
}

#[test]
fn error_table_exit_codes_match_the_real_cli_exit_mapping() {
    let mut rows = 0;
    for line in RULES.lines().filter(|line| line.starts_with("| `")) {
        let cells: Vec<&str> = line.split('|').map(str::trim).collect();
        let exit: i32 = cells[2].parse().unwrap();
        for code in cells[1].split('`').skip(1).step_by(2) {
            if let Ok(code) = serde_json::from_value::<CoreErrorCode>(serde_json::json!(code)) {
                assert_eq!(code.cli_exit(), exit, "{line}");
                rows += 1;
            }
        }
    }
    assert!(rows >= 8, "table rows not found");
    // The catch-all exit 4 row names examples of codes outside the named rows.
    for code in [
        CoreErrorCode::CapacityExceeded,
        CoreErrorCode::HostUnreachable,
    ] {
        assert_eq!(code.cli_exit(), 4);
    }
}
