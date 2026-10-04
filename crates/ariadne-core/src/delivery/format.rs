use super::error::core;
use crate::*;
use ariadne_domain::models::*;
use serde_json::{json, Value};

pub(crate) fn body(session: &Session, input: &Input) -> Result<String, CoreError> {
    let owner = session
        .messages
        .iter()
        .find(|m| m.id == input.message_id)
        .ok_or_else(|| core(CoreErrorCode::InvalidRef, "Input owner message is missing"))?;
    let topic = session
        .topics
        .0
        .get(&input.target.topic_id)
        .ok_or_else(|| core(CoreErrorCode::InvalidRef, "Input target topic is missing"))?;
    let target = input
        .target
        .item_id
        .as_ref()
        .map(|id| {
            session
                .items
                .0
                .get(id)
                .ok_or_else(|| core(CoreErrorCode::InvalidRef, "Input target item is missing"))
        })
        .transpose()?
        .map(|item| {
            json!({"id":item.id,"revision":item.revision,"status":item.status,
            "question":item.question,"question_revision":item.question_revision,
            "ask":item.ask,"options":item.options,"outcome":item.outcome,"note":item.note})
        });
    // Recent complete visible records only. Omitted older records remain available
    // through bounded queries; neither saved owner text nor history is truncated.
    let mut recent = Vec::<Value>::new();
    let mut used = 2;
    for message in session.messages.iter().rev().filter(|m| {
        m.id != owner.id
            && (m.author != MessageAuthor::Owner || m.number <= owner.number)
            && m.topic_id.as_ref() == Some(&input.target.topic_id)
    }) {
        let value = json!({"id":message.id,"number":message.number,"author":message.author,"kind":message.kind,"body":message.body});
        let bytes = serde_json::to_vec(&value).map_err(|_| {
            core(
                CoreErrorCode::InvalidArgument,
                "Cannot format saved history",
            )
        })?;
        if used + bytes.len() + 1 > 16 * 1024 {
            continue;
        }
        used += bytes.len() + 1;
        recent.push(value);
    }
    recent.reverse();
    let body=json!({
        "instruction":"This is an explicitly issued owner input, not tool approval. Preserve its exact content. Publish structured replies/status changes through apply and an explicit result for this input/attempt; host completion alone is not a domain result. Read older context through bounded Ariadne queries, never raw storage. Do not resend or invent delivery evidence.",
        "project_id":session.project_id,"session_id":session.id,"binding_id":input.binding_id,
        "generation":session.bindings.0.get(&input.binding_id).ok_or_else(||core(CoreErrorCode::BindingMismatch,"Input binding is missing"))?.generation,
        "source_input_id":input.id,"owner_message_number":owner.number,"input_kind":input.kind,
        "saved_input":input.payload,"current_topic":topic,"current_item":target,
        "recent_context":recent,"tools":{"queries":["items_list","item_get","topic_get","inputs_list"],"mutation":"apply"},
    }).to_string();
    // Prefix UUID spellings have fixed length; no IDs are allocated to discover
    // an ordinary capacity failure, and exact payloads cannot be truncated.
    if body.len() + "[ARIADNE_INPUT::]\n".len() + 2 * 36 > 64 * 1024 {
        return Err(core(
            CoreErrorCode::CapacityExceeded,
            "The complete prepared input/current target exceeds the 64 KiB payload budget",
        ));
    }
    Ok(body)
}
