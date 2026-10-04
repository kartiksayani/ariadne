//! Durable lifecycle fences shared by report transactions and native activation.
use ariadne_agent_protocol::claude_session_end_event_id;
use ariadne_domain::models::*;

pub fn claude_generation_ended(
    session: &Session,
    binding_id: &UuidV4,
    generation: &UuidV4,
) -> bool {
    if !session
        .bindings
        .0
        .get(binding_id)
        .is_some_and(|binding| binding.adapter_id == "claude_code_mod")
    {
        return false;
    }
    let identity = claude_session_end_event_id(binding_id, generation);
    session.operation_receipts.0.values().flatten().any(|receipt| {
        matches!(&receipt.actor_scope, ReceiptActorScope::Adapter { binding_id: actor } if actor == binding_id)
            && matches!(&receipt.result.data, SavedReceiptData::Event {
                event_id, input_id: None, attempt_id: None, durable_effect: true,
            } if event_id == &identity)
    })
}
