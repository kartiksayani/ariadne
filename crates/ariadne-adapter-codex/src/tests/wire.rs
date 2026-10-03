use super::generated::v0_160_0::*;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../contracts/providers/codex/0.160.0/fixtures/"
);

fn fixture(name: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{FIXTURES}{name}.json")).unwrap()).unwrap()
}

fn decode<T: DeserializeOwned + Serialize>(name: &str) -> Value {
    serde_json::to_value(serde_json::from_value::<T>(fixture(name)).unwrap()).unwrap()
}

#[test]
fn every_consumed_request_and_response_decodes() {
    let initialization = decode::<initialize_params::InitializeParams>("initialize-params");
    assert_eq!(initialization["capabilities"]["experimentalApi"], true);
    let hello = decode::<initialize_response::InitializeResponse>("initialize-response");
    assert!(hello["userAgent"].as_str().unwrap().contains("0.160.0"));
    decode::<thread_loaded_list_params::ThreadLoadedListParams>("loaded-params");
    let loaded = decode::<thread_loaded_list_response::ThreadLoadedListResponse>("loaded-response");
    let read_params = decode::<thread_read_params::ThreadReadParams>("read-params");
    assert_eq!(read_params["includeTurns"], false);
    let metadata = decode::<thread_read_response::ThreadReadResponse>("read-response");
    assert_eq!(loaded["data"][0], metadata["thread"]["id"]);
    assert_eq!(metadata["thread"]["status"]["type"], "idle");
    decode::<thread_queue_list_params::ThreadQueueListParams>("queue-params");
    let queue = decode::<thread_queue_list_response::ThreadQueueListResponse>("queue-response");
    assert_eq!(queue["data"][0]["input"][0]["type"], "text");
    assert_eq!(
        queue["data"][0]["clientUserMessageId"],
        "fixture-cli-client-id"
    );
    let params = decode::<thread_turns_list_params::ThreadTurnsListParams>("turns-params");
    assert_eq!(params["itemsView"], "full");
    assert_eq!(params["sortDirection"], "desc");
    decode::<thread_turns_list_response::ThreadTurnsListResponse>("turns-response");
}

#[test]
fn full_history_preserves_poc_correlation_and_visible_reply_fields() {
    let page = decode::<thread_turns_list_response::ThreadTurnsListResponse>("turns-response");
    let original = fixture("poc-live-exercise");
    assert_eq!(page["data"].as_array().unwrap().len(), 3);
    for input in original["inputs"].as_array().unwrap() {
        let turn = page["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|turn| turn["id"] == input["turn_id"])
            .unwrap();
        assert_eq!(turn["status"], "completed");
        assert_eq!(turn["itemsView"], "full");
        assert_eq!(turn["startedAt"], input["started_at"]);
        assert_eq!(turn["completedAt"], input["completed_at"]);
        assert_eq!(turn["durationMs"], input["duration_ms"]);
        let user = &turn["items"][0];
        assert_eq!(user["type"], "userMessage");
        assert_eq!(user["clientId"], input["user_message_ids"][0]["clientId"]);
        assert_eq!(user["content"][0]["text"], input["text"]);
        let reply = &turn["items"][1];
        assert_eq!(reply["type"], "agentMessage");
        assert_eq!(reply["id"], input["reply_items"][0]["id"]);
        assert_eq!(reply["phase"], "final_answer");
        assert_eq!(reply["text"], input["answer"]);
    }
}

#[test]
fn explicit_nulls_defaults_and_optional_extensions_decode() {
    let mut page = fixture("turns-response");
    page["futureOptionalField"] = json!({"hint":true});
    page["data"][0]["items"][1]["phase"] = Value::Null;
    page["data"][0]["items"][1]["delivery"] = Value::Null;
    page["data"][0]["startedAt"] = Value::Null;
    page["data"][0].as_object_mut().unwrap().remove("itemsView");
    page["data"][0]["items"][0]["content"][0]
        .as_object_mut()
        .unwrap()
        .remove("text_elements");
    let decoded: thread_turns_list_response::ThreadTurnsListResponse =
        serde_json::from_value(page).unwrap();
    let value = serde_json::to_value(decoded).unwrap();
    assert_eq!(value["data"][0]["itemsView"], "full");
    assert!(value["nextCursor"].is_null());
    assert!(value["data"][0]["startedAt"].is_null());
    assert!(value["data"][0]["items"][1]["phase"].is_null());
}

#[test]
fn unknown_variants_cannot_decode_as_completed_history() {
    for (pointer, invalid) in [
        ("/data/0/status", "futureTurnStatus"),
        ("/data/0/items/0/type", "futureItem"),
        ("/data/0/items/0/content/0/type", "futureInput"),
    ] {
        let mut page = fixture("turns-response");
        *page.pointer_mut(pointer).unwrap() = json!(invalid);
        assert!(
            serde_json::from_value::<thread_turns_list_response::ThreadTurnsListResponse>(page)
                .is_err(),
            "{pointer}"
        );
    }
}

#[test]
fn missing_required_fields_and_incorrect_types_are_rejected() {
    for pointer in ["/data/0", "/data/0/items/0", "/data/0/items/1"] {
        let mut page = fixture("turns-response");
        page.pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("id");
        assert!(
            serde_json::from_value::<thread_turns_list_response::ThreadTurnsListResponse>(page)
                .is_err(),
            "{pointer}"
        );
    }
    let mut initialization = fixture("initialize-response");
    initialization.as_object_mut().unwrap().remove("codexHome");
    assert!(
        serde_json::from_value::<initialize_response::InitializeResponse>(initialization).is_err()
    );
    let mut queue = fixture("queue-response");
    queue["data"][0]["input"] = json!("invalid array");
    assert!(
        serde_json::from_value::<thread_queue_list_response::ThreadQueueListResponse>(queue)
            .is_err()
    );
    let mut loaded = fixture("loaded-response");
    loaded.as_object_mut().unwrap().remove("data");
    assert!(
        serde_json::from_value::<thread_loaded_list_response::ThreadLoadedListResponse>(loaded)
            .is_err()
    );
}

#[test]
fn unused_nullable_project_metadata_tolerates_omission_without_losing_identity() {
    let mut metadata = fixture("read-response");
    let expected_id = metadata["thread"]["id"].clone();
    metadata["thread"]
        .as_object_mut()
        .unwrap()
        .remove("projectId");
    let decoded: thread_read_response::ThreadReadResponse =
        serde_json::from_value(metadata).unwrap();
    assert!(decoded.thread.project_id.is_none());
    assert_eq!(decoded.thread.id, expected_id.as_str().unwrap());
    let encoded = serde_json::to_value(decoded).unwrap();
    assert!(encoded["thread"]
        .as_object()
        .unwrap()
        .contains_key("projectId"));
    assert!(encoded["thread"]["projectId"].is_null());
}
