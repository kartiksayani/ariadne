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
    assert!(blocks.len() >= 5, "expected the worked examples");
    let mut ops = BTreeSet::new();
    let mut outcomes = BTreeSet::new();
    let mut owners = BTreeSet::new();
    let (mut local_ref, mut id_ref, mut child) = (false, false, false);
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
            if value["op"] == "item.add" {
                owners.insert(value["owner"]["kind"].as_str().unwrap().to_owned());
                child |= !value["parent"].is_null();
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
                match reference {
                    UuidRef::Local(_) => local_ref = true,
                    UuidRef::Existing(_) => id_ref = true,
                }
            }
        }
    }
    for op in [
        "item.add",
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
    assert!(child && local_ref && id_ref);
}

#[test]
fn rules_explain_the_envelope_fields_and_every_error_code_they_name_exists() {
    for needle in [
        "`attempt_id`",
        "`owner_message_number`",
        "`handled_through_message_number`",
        "[ARIADNE_INPUT:",
        "SAME `op_id`",
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
