use super::error::core;
use crate::*;
use ariadne_domain::models::*;
use serde_json::{json, Map, Value};

/// Query tool names the skills tell the agent to pull context with. Each is both
/// an MCP tool name and an `ariadne <name>` CLI command (`ariadne read` is the
/// short form of `session_read`). Tests in the CLI and MCP crates check these
/// against the real surfaces.
pub const AGENT_QUERY_TOOLS: [&str; 3] = ["session_read", "item_messages", "item_rounds"];

/// The whole marker line plus two UUID spellings must fit the delivery budget.
const BUDGET: usize = 64 * 1024;

/// IDs the agent must echo back, shared by every envelope. The fixed rules live
/// in the Ariadne skill once; the envelope repeats no instruction or context.
fn routing(
    session: &Session,
    input: &Input,
    owner: &Message,
    attempt_id: &UuidV4,
) -> Result<Map<String, Value>, CoreError> {
    let generation = &session
        .bindings
        .0
        .get(&input.binding_id)
        .ok_or_else(|| core(CoreErrorCode::BindingMismatch, "Input binding is missing"))?
        .generation;
    let mut map = Map::new();
    map.insert("source_input_id".into(), json!(input.id));
    map.insert("attempt_id".into(), json!(attempt_id));
    map.insert("binding_id".into(), json!(input.binding_id));
    map.insert("generation".into(), json!(generation));
    map.insert("owner_message_number".into(), json!(owner.number));
    map.insert("input_kind".into(), json!(input.kind));
    Ok(map)
}

fn owner_message<'a>(session: &'a Session, input: &Input) -> Result<&'a Message, CoreError> {
    session
        .messages
        .iter()
        .find(|m| m.id == input.message_id)
        .ok_or_else(|| core(CoreErrorCode::InvalidRef, "Input owner message is missing"))
}

fn bounded(map: Map<String, Value>, error: &str) -> Result<String, CoreError> {
    let body = Value::Object(map).to_string();
    // Prefix UUID spellings have fixed length; no IDs are allocated to discover
    // an ordinary capacity failure, and exact payloads cannot be truncated.
    if body.len() + "[ARIADNE_INPUT::]\n".len() + 2 * 36 > BUDGET {
        return Err(core(CoreErrorCode::CapacityExceeded, error));
    }
    Ok(body)
}

/// The slim per-input envelope: routing IDs, the target item (or topic) with
/// its current revisions, the selected option and the owner's exact text.
/// Context is pulled by the agent (`ariadne read`, `ariadne item messages`).
pub(crate) fn body(
    session: &Session,
    input: &Input,
    attempt_id: &UuidV4,
) -> Result<String, CoreError> {
    let owner = owner_message(session, input)?;
    if input.kind == InputKind::Removed {
        return removed_body(session, input, owner, attempt_id);
    }
    if !session.topics.0.contains_key(&input.target.topic_id) {
        return Err(core(
            CoreErrorCode::InvalidRef,
            "Input target topic is missing",
        ));
    }
    let mut map = routing(session, input, owner, attempt_id)?;
    match &input.target.item_id {
        Some(id) => {
            let item =
                session.items.0.get(id).ok_or_else(|| {
                    core(CoreErrorCode::InvalidRef, "Input target item is missing")
                })?;
            map.insert("item_id".into(), json!(item.id));
            map.insert("item_revision".into(), json!(item.revision));
            map.insert("question_revision".into(), json!(item.question_revision));
        }
        None => {
            map.insert("topic_id".into(), json!(input.target.topic_id));
        }
    }
    if let Some(option) = &input.payload.selected_option_id {
        map.insert("selected_option_id".into(), json!(option));
        if let Some(label) = input
            .payload
            .target_snapshot
            .options
            .iter()
            .find(|o| &o.id == option)
            .map(|o| &o.label)
        {
            map.insert("selected_option_label".into(), json!(label));
        }
    }
    map.insert("text".into(), json!(input.payload.text));
    bounded(
        map,
        "The complete prepared input exceeds the 64 KiB payload budget",
    )
}

/// A `removed` notice names the removed records from the saved notice; the
/// records no longer exist, so there is nothing else to carry.
fn removed_body(
    session: &Session,
    input: &Input,
    owner: &Message,
    attempt_id: &UuidV4,
) -> Result<String, CoreError> {
    let notice = input
        .payload
        .removed
        .as_ref()
        .ok_or_else(|| core(CoreErrorCode::InvalidRef, "Removal notice is missing"))?;
    let mut map = routing(session, input, owner, attempt_id)?;
    map.insert("removed".into(), json!(notice));
    bounded(map, "The removal notice exceeds the 64 KiB payload budget")
}

/// References retained effects without repeating the original action prompt.
pub(super) fn repair_body(
    session: &Session,
    input: &Input,
    original: &Attempt,
    attempt_id: &UuidV4,
) -> Result<String, CoreError> {
    let owner = session
        .messages
        .iter()
        .find(|m| m.id == input.message_id)
        .ok_or_else(|| core(CoreErrorCode::InvalidRef, "Repair owner message is missing"))?;
    let messages: Vec<_> = session
        .messages
        .iter()
        .filter(|m| {
            m.input_id.as_ref() == Some(&input.id) && m.attempt_id.as_ref() == Some(&original.id)
        })
        .map(|m| &m.id)
        .collect();
    let items: Vec<_> = session
        .items
        .0
        .values()
        .filter(|i| {
            messages.contains(&&i.created_message_id)
                || i.updated_message_ids
                    .iter()
                    .any(|id| messages.contains(&id))
        })
        .map(|i| &i.id)
        .collect();
    let mut map = routing(session, input, owner, attempt_id)?;
    map.insert("target".into(), json!(input.target));
    map.insert("purpose".into(), json!("result_repair"));
    map.insert("repair_for_attempt_id".into(), json!(original.id));
    map.insert(
        "original_domain_result".into(),
        json!(original.domain_result),
    );
    map.insert("original_message_ids".into(), json!(messages));
    map.insert("affected_item_ids".into(), json!(items));
    bounded(
        map,
        "The complete repair references exceed the 64 KiB delivery budget",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uuid(n: u64) -> UuidV4 {
        UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
    }

    /// A topic-level input (continue, topic reply) names its topic, not an item.
    #[test]
    fn topic_input_names_the_topic_and_carries_no_item_revisions() {
        let mut session: Session = serde_json::from_str(include_str!(
            "../../../../fixtures/domain/history/seed.json"
        ))
        .unwrap();
        let topic = uuid(5);
        let mut owner = session.messages[0].clone();
        owner.id = uuid(60);
        owner.number = PositiveSafeInteger::new(2).unwrap();
        owner.author = MessageAuthor::Owner;
        owner.kind = MessageKind::OwnerInput;
        owner.body = "Approve the PR".into();
        session.messages.push(owner);
        let input = Input {
            id: uuid(61),
            seq: PositiveSafeInteger::new(1).unwrap(),
            binding_id: uuid(3),
            kind: InputKind::Continue,
            target: InputTarget {
                topic_id: topic.clone(),
                item_id: None,
            },
            message_id: uuid(60),
            answer_id: None,
            created_at: session.created_at.clone(),
            expected_question_revision: None,
            payload: InputPayload {
                text: "Approve the PR".into(),
                intent: InputKind::Continue,
                target_snapshot: InputTargetSnapshot {
                    topic_name: "Release".into(),
                    item_question: None,
                    question_revision: None,
                    ask: None,
                    options: vec![],
                },
                selected_option_id: None,
                context: InputContext {
                    message_ids: vec![],
                    item_ids: vec![],
                    round_id: None,
                    continuation_operation_id: None,
                },
                removed: None,
            },
            state: InputState::Queued,
            attempts: vec![],
            active_attempt_id: None,
            resolution_history: vec![],
            cancel_cause: None,
        };
        assert!(!super::super::held_for_review(&session, &input));
        let body: Value =
            serde_json::from_str(&body(&session, &input, &uuid(62)).unwrap()).unwrap();
        let keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
        assert_eq!(
            keys,
            [
                "attempt_id",
                "binding_id",
                "generation",
                "input_kind",
                "owner_message_number",
                "source_input_id",
                "text",
                "topic_id"
            ]
        );
        assert_eq!(body["topic_id"], topic.as_str());
        assert_eq!(body["owner_message_number"], 2);
        assert_eq!(body["text"], "Approve the PR");
    }
}
