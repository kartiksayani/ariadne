//! Lenient `ariadne apply` input: fills defaults, allocates refs and flattens
//! `children`, producing the strict wire `ApplyRequest`. Core validates the result
//! exactly as it validates a fully explicit request; nothing here relaxes a rule.
use super::{bad_request, bad_stdin, invalid};
use ariadne_core::*;
use ariadne_domain::models::*;
use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::fmt;

pub struct Expanded {
    pub request: ApplyRequest,
    /// Set when the CLI chose the `op_id`; it is echoed in the receipt and in
    /// uncertain-commit errors, because a retry must reuse it.
    pub generated_op_id: Option<UuidV4>,
}

/// Expands lenient stdin bytes into the strict request for `binding`.
pub fn expand(
    bytes: &[u8],
    binding: &UuidV4,
    new_uuid: &mut dyn FnMut() -> String,
) -> Result<Expanded, CoreError> {
    let Strict(value) = serde_json::from_slice(bytes).map_err(|e| bad_stdin("ApplyRequest", &e))?;
    let Value::Object(mut top) = value else {
        return Err(bad_request("the request must be a JSON object".into()));
    };
    let generated_op_id = if top.contains_key("op_id") {
        None
    } else {
        let id = new_uuid();
        top.insert("op_id".into(), json!(id));
        Some(UuidV4::new(id).map_err(|_| invalid("Cannot generate an op_id."))?)
    };
    for (key, default) in [
        ("source_input_id", Value::Null),
        ("attempt_id", Value::Null),
        ("expected_item_revisions", json!({})),
        ("expected_topic_revisions", json!({})),
        ("summary", json!("")),
        ("input_result", Value::Null),
    ] {
        top.entry(key).or_insert(default);
    }
    if let Some(Value::Object(result)) = top.get_mut("input_result") {
        for key in ["reply_refs", "followup_item_refs"] {
            result.entry(key).or_insert(json!([]));
        }
    }
    let operations = match top.get_mut("operations") {
        Some(Value::Array(list)) => std::mem::take(list),
        _ => Vec::new(),
    };
    let flattened = Expander::new(binding, &operations).run(operations)?;
    // Operations are decoded one at a time so an error names its position.
    let mut parsed = Vec::with_capacity(flattened.len());
    for (path, operation) in flattened {
        let tag = operation
            .get("op")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string();
        let operation = serde_json::from_value::<Operation>(operation)
            .map_err(|e| bad_request(format!("{path} ({tag}): {e}")))?;
        parsed.push(operation);
    }
    // `operations` was emptied above, so a missing or mistyped field still fails here.
    let mut request = serde_json::from_value::<ApplyRequest>(Value::Object(top))
        .map_err(|e| bad_request(e.to_string()))?;
    request.operations = parsed;
    Ok(Expanded {
        request,
        generated_op_id,
    })
}

struct Expander {
    binding: String,
    used: BTreeSet<String>,
    next: u64,
    topic_adds: usize,
    default_topic: Option<Value>,
}

impl Expander {
    fn new(binding: &UuidV4, operations: &[Value]) -> Self {
        let mut used = BTreeSet::new();
        for operation in operations {
            collect_refs(operation, &mut used);
        }
        let topic_adds = operations
            .iter()
            .filter(|op| op.get("op").and_then(Value::as_str) == Some("topic.add"))
            .count();
        Self {
            binding: binding.as_str().to_string(),
            used,
            next: 0,
            topic_adds,
            default_topic: None,
        }
    }

    fn run(mut self, operations: Vec<Value>) -> Result<Vec<(String, Value)>, CoreError> {
        let mut out = Vec::new();
        for (index, operation) in operations.into_iter().enumerate() {
            self.operation(operation, format!("operations[{index}]"), &mut out)?;
        }
        Ok(out)
    }

    /// A fresh `r1`, `r2`, ... that no request ref uses.
    fn fresh_ref(&mut self) -> String {
        loop {
            self.next += 1;
            let candidate = format!("r{}", self.next);
            if self.used.insert(candidate.clone()) {
                return candidate;
            }
        }
    }

    fn ensure_ref(&mut self, object: &mut Map<String, Value>) -> Option<String> {
        if !object.contains_key("ref") {
            let fresh = self.fresh_ref();
            object.insert("ref".into(), json!(fresh));
        }
        object
            .get("ref")
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    fn operation(
        &mut self,
        operation: Value,
        path: String,
        out: &mut Vec<(String, Value)>,
    ) -> Result<(), CoreError> {
        let Value::Object(mut object) = operation else {
            out.push((path, operation));
            return Ok(());
        };
        match object.get("op").and_then(Value::as_str) {
            Some("topic.add") => {
                if let Some(reference) = self.ensure_ref(&mut object) {
                    if self.topic_adds == 1 {
                        self.default_topic = Some(json!({ "ref": reference }));
                    }
                }
            }
            Some("item.add") => return self.item_add(object, path, None, out),
            Some("item.ask") => {
                object
                    .entry("recipient_binding_id")
                    .or_insert_with(|| json!(self.binding));
                object.entry("options").or_insert(json!([]));
                options(&mut object);
            }
            Some("reply") => {
                self.ensure_ref(&mut object);
            }
            _ => {}
        }
        out.push((path, Value::Object(object)));
        Ok(())
    }

    /// `parent` is the enclosing item's ref and topic when this is a child.
    fn item_add(
        &mut self,
        mut object: Map<String, Value>,
        path: String,
        parent: Option<(&str, Option<&Value>)>,
        out: &mut Vec<(String, Value)>,
    ) -> Result<(), CoreError> {
        let children = match object.remove("children") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(list)) => list,
            Some(_) => {
                return Err(bad_request(format!(
                    "{path}: children must be an array of item.add objects"
                )))
            }
        };
        match object.get("op") {
            None => {}
            Some(Value::String(tag)) if tag == "item.add" => {}
            Some(_) => {
                return Err(bad_request(format!(
                    "{path}: a child of an item.add must be an item.add object"
                )))
            }
        }
        object.insert("op".into(), json!("item.add"));
        if let Some((parent_ref, parent_topic)) = parent {
            if object.contains_key("parent") {
                return Err(bad_request(format!(
                    "{path}: a child's parent is its enclosing item; remove `parent`"
                )));
            }
            object.insert("parent".into(), json!({ "ref": parent_ref }));
            if !object.contains_key("topic") {
                if let Some(topic) = parent_topic {
                    object.insert("topic".into(), topic.clone());
                }
            }
        } else if !object.contains_key("topic") {
            if let Some(topic) = &self.default_topic {
                object.insert("topic".into(), topic.clone());
            }
        }
        let reference = self
            .ensure_ref(&mut object)
            .ok_or_else(|| bad_request(format!("{path}: `ref` must be a string")))?;
        let asking = object.get("ask").is_some_and(|ask| !ask.is_null());
        object
            .entry("status")
            .or_insert_with(|| json!(if asking { "waiting_on_me" } else { "open" }));
        let waiting = object.get("status").and_then(Value::as_str) == Some("waiting_on_me");
        match object.get_mut("owner") {
            None => {
                let owner = if waiting {
                    json!({"kind": "me"})
                } else {
                    json!({"kind": "agent", "binding_id": self.binding})
                };
                object.insert("owner".into(), owner);
            }
            Some(Value::Object(owner)) => {
                if owner.get("kind").and_then(Value::as_str) == Some("agent") {
                    owner
                        .entry("binding_id")
                        .or_insert_with(|| json!(self.binding));
                }
            }
            Some(_) => {}
        }
        options(&mut object);
        let topic = object.get("topic").cloned();
        out.push((path.clone(), Value::Object(object)));
        for (index, child) in children.into_iter().enumerate() {
            let child_path = format!("{path}.children[{index}]");
            let Value::Object(child) = child else {
                return Err(bad_request(format!(
                    "{child_path}: a child must be an item.add object"
                )));
            };
            self.item_add(
                child,
                child_path,
                Some((reference.as_str(), topic.as_ref())),
                out,
            )?;
        }
        Ok(())
    }
}

/// Option entries may omit `id` (their 1-based position) and `recommended` (false).
fn options(object: &mut Map<String, Value>) {
    let Some(Value::Array(list)) = object.get_mut("options") else {
        return;
    };
    for (index, option) in list.iter_mut().enumerate() {
        if let Value::Object(option) = option {
            option
                .entry("id")
                .or_insert_with(|| json!((index + 1).to_string()));
            option.entry("recommended").or_insert(json!(false));
        }
    }
}

fn collect_refs(operation: &Value, used: &mut BTreeSet<String>) {
    if let Some(reference) = operation.get("ref").and_then(Value::as_str) {
        used.insert(reference.to_string());
    }
    if let Some(Value::Array(children)) = operation.get("children") {
        for child in children {
            collect_refs(child, used);
        }
    }
}

/// JSON that rejects a repeated object key anywhere, as the strict wire does.
struct Strict(Value);
impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(StrictVisitor)
    }
}
struct StrictVisitor;
impl<'de> Visitor<'de> for StrictVisitor {
    type Value = Strict;
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("any JSON value")
    }
    fn visit_bool<E>(self, value: bool) -> Result<Strict, E> {
        Ok(Strict(Value::Bool(value)))
    }
    fn visit_i64<E>(self, value: i64) -> Result<Strict, E> {
        Ok(Strict(Value::from(value)))
    }
    fn visit_u64<E>(self, value: u64) -> Result<Strict, E> {
        Ok(Strict(Value::from(value)))
    }
    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Strict, E> {
        serde_json::Number::from_f64(value)
            .map(|number| Strict(Value::Number(number)))
            .ok_or_else(|| E::custom("number is not finite"))
    }
    fn visit_str<E>(self, value: &str) -> Result<Strict, E> {
        Ok(Strict(Value::String(value.to_string())))
    }
    fn visit_string<E>(self, value: String) -> Result<Strict, E> {
        Ok(Strict(Value::String(value)))
    }
    fn visit_unit<E>(self) -> Result<Strict, E> {
        Ok(Strict(Value::Null))
    }
    fn visit_none<E>(self) -> Result<Strict, E> {
        Ok(Strict(Value::Null))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Strict, A::Error> {
        let mut list = Vec::new();
        while let Some(Strict(value)) = seq.next_element()? {
            list.push(value);
        }
        Ok(Strict(Value::Array(list)))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Strict, A::Error> {
        let mut object = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if key == "$serde_json::private::Number" {
                // serde_json's arbitrary-precision number token, if enabled.
                let text: String = map.next_value()?;
                return text
                    .parse::<serde_json::Number>()
                    .map(|number| Strict(Value::Number(number)))
                    .map_err(de::Error::custom);
            }
            let Strict(value) = map.next_value()?;
            if object.insert(key.clone(), value).is_some() {
                return Err(de::Error::custom(format!("duplicate field `{key}`")));
            }
        }
        Ok(Strict(Value::Object(object)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BINDING: &str = "00000000-0000-4000-8000-000000000003";
    const TOPIC: &str = "00000000-0000-4000-8000-000000000005";
    const GENERATED: &str = "00000000-0000-4000-8000-0000000000aa";

    fn run(request: &Value) -> Result<Expanded, CoreError> {
        expand(
            &serde_json::to_vec(request).unwrap(),
            &UuidV4::new(BINDING).unwrap(),
            &mut || GENERATED.to_string(),
        )
    }
    fn ok(request: Value) -> ApplyRequest {
        run(&request).unwrap().request
    }
    fn message(request: Value) -> String {
        run(&request).err().expect("rejected").message
    }
    fn wire(request: &ApplyRequest) -> Value {
        serde_json::to_value(request).unwrap()
    }

    #[test]
    fn an_empty_request_gets_every_top_level_default_and_a_generated_op_id() {
        let expanded = run(&json!({"operations": []})).unwrap();
        assert_eq!(expanded.generated_op_id.unwrap().as_str(), GENERATED);
        let request = wire(&expanded.request);
        assert_eq!(
            request,
            json!({"op_id": GENERATED, "source_input_id": null, "attempt_id": null,
                "expected_item_revisions": {}, "expected_topic_revisions": {},
                "summary": "", "operations": [], "input_result": null})
        );
    }

    #[test]
    fn a_supplied_op_id_is_kept_and_not_reported_as_generated() {
        let expanded = run(&json!({"op_id": TOPIC, "operations": []})).unwrap();
        assert!(expanded.generated_op_id.is_none());
        assert_eq!(expanded.request.op_id.as_str(), TOPIC);
    }

    #[test]
    fn a_fully_explicit_request_expands_to_itself() {
        let explicit = json!({"op_id": TOPIC, "source_input_id": null, "attempt_id": null,
        "expected_item_revisions": {"1": 2}, "expected_topic_revisions": {},
        "summary": "s", "input_result": null,
        "operations": [
            {"op": "topic.add", "ref": "t", "name": "N", "short": "N"},
            {"op": "item.add", "ref": "a", "topic": {"ref": "t"}, "parent": null,
             "question": "Q", "type": "task", "status": "open",
             "owner": {"kind": "other", "name": "Sam"}, "ask": null, "options": null,
             "note": null, "links": null, "outcome": null, "why": null,
             "replaced_by": null, "source_round_id": null},
            {"op": "reply", "ref": "m", "item": {"id": "1"}, "text": "T", "round_id": null}
        ]});
        let strict: ApplyRequest = serde_json::from_value(explicit.clone()).unwrap();
        assert_eq!(ok(explicit), strict);
    }

    #[test]
    fn item_add_defaults_status_and_owner_from_the_ask() {
        let request = ok(json!({"operations": [
            {"op": "topic.add", "name": "T"},
            {"op": "item.add", "question": "Plain", "type": "finding"},
            {"op": "item.add", "question": "Asked", "type": "decision", "ask": "Which?",
             "options": [{"label": "A", "consequence": "a"},
                         {"id": "z", "label": "B", "consequence": "b", "recommended": true}]}
        ]}));
        let plain = &wire(&request)["operations"][1];
        assert_eq!(plain["status"], "open");
        assert_eq!(
            plain["owner"],
            json!({"kind": "agent", "binding_id": BINDING})
        );
        assert_eq!(plain["topic"], json!({"ref": "r1"}));
        assert_eq!(plain["parent"], Value::Null);
        let asked = &wire(&request)["operations"][2];
        assert_eq!(asked["status"], "waiting_on_me");
        assert_eq!(asked["owner"], json!({"kind": "me"}));
        assert_eq!(asked["options"][0]["id"], "1");
        assert_eq!(asked["options"][0]["recommended"], false);
        assert_eq!(asked["options"][1]["id"], "z");
        assert_eq!(asked["options"][1]["recommended"], true);
    }

    #[test]
    fn explicit_status_owner_and_agent_owner_without_binding_are_respected() {
        let request = ok(json!({"operations": [
            {"op": "item.add", "topic": {"id": TOPIC}, "question": "Q", "type": "task",
             "status": "in_progress", "ask": "kept as given"},
            {"op": "item.add", "topic": {"id": TOPIC}, "question": "Q", "type": "task",
             "owner": {"kind": "agent"}}
        ]}));
        let operations = &wire(&request)["operations"];
        assert_eq!(operations[0]["status"], "in_progress");
        assert_eq!(operations[0]["owner"]["kind"], "agent");
        assert_eq!(operations[1]["owner"]["binding_id"], BINDING);
    }

    #[test]
    fn children_follow_their_parent_with_its_ref_topic_and_a_fresh_ref() {
        let request = ok(json!({"operations": [
            {"op": "topic.add", "ref": "r1", "name": "T"},
            {"op": "item.add", "ref": "root", "question": "Root", "type": "finding",
             "children": [
                {"question": "A", "type": "finding",
                 "children": [{"question": "A1", "type": "finding"}]},
                {"question": "B", "type": "finding"}
             ]},
            {"op": "item.add", "question": "Next root", "type": "finding"}
        ]}));
        let operations = wire(&request)["operations"].clone();
        let questions: Vec<_> = operations
            .as_array()
            .unwrap()
            .iter()
            .map(|op| op["question"].as_str().unwrap_or("-").to_string())
            .collect();
        assert_eq!(questions, ["-", "Root", "A", "A1", "B", "Next root"]);
        // `r1` is taken by the request, so auto refs start at `r2`.
        let refs: Vec<_> = operations
            .as_array()
            .unwrap()
            .iter()
            .map(|op| op["ref"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(refs, ["r1", "root", "r2", "r3", "r4", "r5"]);
        assert_eq!(operations[1]["parent"], Value::Null);
        assert_eq!(operations[2]["parent"], json!({"ref": "root"}));
        assert_eq!(operations[3]["parent"], json!({"ref": "r2"}));
        assert_eq!(operations[4]["parent"], json!({"ref": "root"}));
        for index in 1..=5 {
            assert_eq!(operations[index]["topic"], json!({"ref": "r1"}), "{index}");
        }
        for index in 2..=5 {
            assert_eq!(operations[index]["op"], "item.add");
            assert!(operations[index].get("children").is_none());
        }
    }

    #[test]
    fn the_topic_default_needs_exactly_one_topic_add() {
        let two = message(json!({"operations": [
            {"op": "topic.add", "name": "One"}, {"op": "topic.add", "name": "Two"},
            {"op": "item.add", "question": "Q", "type": "finding"}]}));
        assert!(two.contains("operations[2] (item.add)"), "{two}");
        assert!(two.contains("topic"), "{two}");
        let none = message(json!({"operations": [
            {"op": "item.add", "question": "Q", "type": "finding"}]}));
        assert!(none.contains("missing field `topic`"), "{none}");
        let existing = ok(json!({"operations": [
            {"op": "topic.add", "name": "One"}, {"op": "topic.add", "name": "Two"},
            {"op": "item.add", "topic": {"id": TOPIC}, "question": "Q", "type": "finding",
             "children": [{"question": "C", "type": "finding"}]}]}));
        assert_eq!(
            wire(&existing)["operations"][3]["topic"],
            json!({"id": TOPIC})
        );
    }

    #[test]
    fn a_child_may_not_name_its_own_parent_and_children_must_be_items() {
        let parent = message(json!({"operations": [
            {"op": "item.add", "topic": {"id": TOPIC}, "question": "Q", "type": "finding",
             "children": [{"question": "C", "type": "finding", "parent": {"id": "1"}}]}]}));
        assert!(parent.contains("operations[0].children[0]"), "{parent}");
        assert!(parent.contains("parent"), "{parent}");
        let shape = message(json!({"operations": [
            {"op": "item.add", "topic": {"id": TOPIC}, "question": "Q", "type": "finding",
             "children": "nope"}]}));
        assert!(shape.contains("children must be an array"), "{shape}");
        let scalar = message(json!({"operations": [
            {"op": "item.add", "topic": {"id": TOPIC}, "question": "Q", "type": "finding",
             "children": [7]}]}));
        assert!(scalar.contains("operations[0].children[0]"), "{scalar}");
        let other = message(json!({"operations": [
            {"op": "item.add", "topic": {"id": TOPIC}, "question": "Q", "type": "finding",
             "children": [{"op": "reply", "question": "C", "type": "finding"}]}]}));
        assert!(other.contains("must be an item.add"), "{other}");
    }

    #[test]
    fn item_ask_and_reply_and_result_take_their_obvious_defaults() {
        let request = ok(json!({
            "source_input_id": TOPIC, "attempt_id": GENERATED,
            "input_result": {"outcome": "answered", "explanation": "e",
                "handled_through_message_number": 1},
            "operations": [
                {"op": "item.ask", "item": {"id": "1"}, "ask": "Which?",
                 "options": [{"label": "A", "consequence": "a"}]},
                {"op": "item.ask", "item": {"id": "1"}, "ask": "Free text"},
                {"op": "reply", "item": {"id": "1"}, "text": "T"}]}));
        let value = wire(&request);
        assert_eq!(value["operations"][0]["recipient_binding_id"], BINDING);
        assert_eq!(value["operations"][0]["options"][0]["id"], "1");
        assert_eq!(value["operations"][1]["options"], json!([]));
        assert_eq!(value["operations"][2]["ref"], "r1");
        assert_eq!(value["operations"][2]["round_id"], Value::Null);
        assert_eq!(value["input_result"]["reply_refs"], json!([]));
        assert_eq!(value["input_result"]["followup_item_refs"], json!([]));
    }

    #[test]
    fn optional_operation_fields_may_be_left_out() {
        let request = ok(json!({"operations": [
            {"op": "item.status", "item": {"id": "1"}, "status": "done",
             "outcome": "o", "why": "w"},
            {"op": "item.edit", "item": {"id": "1"}, "patch": {"question": "Q2"}}]}));
        let value = wire(&request);
        assert_eq!(value["operations"][0]["reason"], Value::Null);
        assert_eq!(value["operations"][1]["patch"]["type"], Value::Null);
    }

    #[test]
    fn errors_name_the_operation_and_stay_strict() {
        let unknown_op = message(json!({"operations": [{"op": "item.nope"}]}));
        assert!(
            unknown_op.contains("operations[0] (item.nope)"),
            "{unknown_op}"
        );
        let unknown_field = message(json!({"operations": [
            {"op": "topic.add", "name": "T", "color": "red"}]}));
        assert!(unknown_field.contains("color"), "{unknown_field}");
        let top = message(json!({"operations": [], "caller_actor": "owner"}));
        assert!(top.contains("caller_actor"), "{top}");
        let missing = message(json!({}));
        assert!(missing.contains("operations"), "{missing}");
        let not_object = expand(b"[]", &UuidV4::new(BINDING).unwrap(), &mut || {
            GENERATED.to_string()
        })
        .err()
        .unwrap();
        assert!(not_object.message.contains("JSON object"));
    }

    #[test]
    fn duplicate_keys_and_bad_syntax_are_rejected_with_a_position() {
        let binding = UuidV4::new(BINDING).unwrap();
        let mut uuid = || GENERATED.to_string();
        let duplicate = expand(
            br#"{"operations":[],"expected_item_revisions":{"1":1,"1":2}}"#,
            &binding,
            &mut uuid,
        )
        .err()
        .unwrap();
        assert!(
            duplicate.message.contains("duplicate field `1`"),
            "{duplicate:?}"
        );
        let syntax = expand(b"{\"operations\": [\n  oops]}", &binding, &mut uuid)
            .err()
            .unwrap();
        assert!(syntax.message.contains("line 2"), "{syntax:?}");
        let number = expand(
            br#"{"operations":[],"expected_item_revisions":{"1":1.5e0}}"#,
            &binding,
            &mut uuid,
        )
        .err()
        .unwrap();
        assert_eq!(number.code, CoreErrorCode::InvalidArgument);
    }
}
