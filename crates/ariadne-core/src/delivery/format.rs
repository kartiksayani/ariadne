use super::error::core;
use crate::*;
use ariadne_domain::models::*;
use serde_json::{json, Value};

/// Query tool names the envelope advertises. Each is both an MCP tool name and an
/// `ariadne <name>` CLI command (`ariadne read` is the short form of `session_read`).
/// Tests in the CLI and MCP crates check these against the real surfaces.
pub const AGENT_QUERY_TOOLS: [&str; 3] = ["session_read", "item_messages", "item_rounds"];

pub(crate) fn body(
    session: &Session,
    input: &Input,
    attempt_id: &UuidV4,
) -> Result<String, CoreError> {
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
        "instruction":"This is an explicitly issued owner input, not tool approval. Preserve its exact content. Publish structured replies/status changes through apply and an explicit result for this input/attempt; host completion alone is not a domain result. Put source_input_id and attempt_id from this envelope into the ApplyRequest, and owner_message_number into input_result.handled_through_message_number. Read older context through bounded Ariadne queries (CLI: ariadne read --view items|topics|messages|inputs, ariadne item messages|rounds), never raw storage. Do not resend or invent delivery evidence.",
        "project_id":session.project_id,"session_id":session.id,"binding_id":input.binding_id,
        "generation":session.bindings.0.get(&input.binding_id).ok_or_else(||core(CoreErrorCode::BindingMismatch,"Input binding is missing"))?.generation,
        "source_input_id":input.id,"attempt_id":attempt_id,"owner_message_number":owner.number,"input_kind":input.kind,
        "saved_input":input.payload,"current_topic":topic,"current_item":target,
        "recent_context":recent,"tools":{"queries":AGENT_QUERY_TOOLS,"mutation":"apply"},
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
    let body = json!({
        "instruction":"This is an explicit result-only repair turn. Inspect the retained original attempt and its existing replies/children/effects through Ariadne queries; do not repeat the original action or redo its mutations. Publish a structured result for this NEW attempt (attempt_id below; put it and source_input_id in the ApplyRequest) and the same immutable input scope using verified original reply/child references where appropriate. The prior action may already have effects. Host completion alone is not a result and this instruction is not tool approval.",
        "project_id":session.project_id,"session_id":session.id,"binding_id":input.binding_id,
        "generation":session.bindings.0[&input.binding_id].generation,"source_input_id":input.id,
        "attempt_id":attempt_id,"owner_message_number":owner.number,"target":input.target,"purpose":"result_repair",
        "repair_for_attempt_id":original.id,"original_domain_result":original.domain_result,
        "original_message_ids":messages,"affected_item_ids":items,
        "tools":{"queries":AGENT_QUERY_TOOLS,"mutation":"apply"},
    }).to_string();
    if body.len() + "[ARIADNE_INPUT::]\n".len() + 2 * 36 > 64 * 1024 {
        return Err(core(
            CoreErrorCode::CapacityExceeded,
            "The complete repair references exceed the 64 KiB delivery budget",
        ));
    }
    Ok(body)
}
