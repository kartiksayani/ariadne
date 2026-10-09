//! Owner acceptance of an agent's proposed completion; no input is dispatched.
use super::core;
use crate::*;
use ariadne_domain::models::*;

pub(super) fn apply(
    session: &mut Session,
    command: &OwnerCommand,
    at: &UtcMillis,
    allocate: &mut impl FnMut() -> UuidV4,
) -> Result<SavedReceiptData, CoreError> {
    let OwnerCommand::Ack { params, op_id, .. } = command else {
        unreachable!("validated Ack command")
    };
    let old = session
        .items
        .0
        .get(&params.item_id)
        .ok_or_else(|| core(CoreErrorCode::NotFound, "This item no longer exists"))?;
    if old.revision != params.expected_revision {
        let mut error = core(
            CoreErrorCode::RevisionConflict,
            "This item changed before it was acknowledged",
        );
        error.current_revision = Some(old.revision);
        return Err(error);
    }
    if !matches!(old.status, ItemStatus::Open | ItemStatus::InProgress) {
        return Err(core(
            CoreErrorCode::InvalidTransition,
            "Only open or in-progress items can be acknowledged",
        ));
    }
    let target = old.ack_to.ok_or_else(|| {
        core(
            CoreErrorCode::InvalidTransition,
            "This item has no proposed completion to acknowledge",
        )
    })?;
    if old.ask.as_ref().is_some_and(|ask| !ask.trim().is_empty())
        && crate::queries::question_unanswered(session, old)
    {
        return Err(core(
            CoreErrorCode::InvalidTransition,
            "Answer this item's current question before acknowledging it",
        ));
    }
    let mut item = old.clone();
    let message_id = allocate();
    if message_id == session.id
        || message_id == session.project_id
        || session.continuations.0.contains_key(&message_id)
        || session.inputs.0.values().any(|input| {
            input
                .attempts
                .iter()
                .any(|attempt| attempt.id == message_id)
        })
        || &message_id == op_id
        || session
            .messages
            .iter()
            .any(|message| message.id == message_id)
        || session.inputs.0.contains_key(&message_id)
        || session.rounds.0.contains_key(&message_id)
        || session.bindings.0.contains_key(&message_id)
        || session.topics.0.contains_key(&message_id)
        || session.answers.iter().any(|answer| answer.id == message_id)
        || session.operation_receipts.0.contains_key(&message_id)
    {
        return Err(core(
            CoreErrorCode::InvalidArgument,
            "The message allocator returned an existing identity",
        ));
    }
    let increment = |value: PositiveSafeInteger| {
        value
            .value()
            .checked_add(1)
            .and_then(|value| PositiveSafeInteger::new(value).ok())
            .ok_or_else(|| {
                core(
                    CoreErrorCode::CapacityExceeded,
                    "The item or message counter reached its limit",
                )
            })
    };
    item.status = target.status();
    item.ack_to = None;
    item.outcome = item
        .outcome
        .or_else(|| Some("Acknowledged by the owner.".into()));
    item.why = item
        .why
        .or_else(|| Some("The owner accepted the proposed completion.".into()));
    item.replaced_by = None;
    item.waiting_since = None;
    item.revision = increment(item.revision)?;
    item.updated_at = at.clone();
    item.updated_message_ids.push(message_id.clone());
    item.status_history.push(StatusHistoryEntry {
        old_status: old.status.clone(),
        new_status: item.status.clone(),
        previous_outcome: old.outcome.clone(),
        previous_why: old.why.clone(),
        previous_replaced_by: old.replaced_by.clone(),
        cause_message_id: message_id.clone(),
        at: at.clone(),
        binding_id: None,
        handled_through_message_number: NonnegativeSafeInteger::new(0).expect("zero watermark"),
        reason: Some("Acknowledged by the owner.".into()),
    });
    let number = session.counters.next_message;
    session.counters.next_message = increment(number)?;
    session.messages.push(Message {
        id: message_id.clone(),
        number,
        author: MessageAuthor::Owner,
        kind: MessageKind::Activity,
        body: "Acknowledged the proposed completion.".into(),
        created_at: at.clone(),
        item_id: Some(item.id.clone()),
        topic_id: Some(item.topic_id.clone()),
        items_touched: vec![item.id.clone()],
        binding_id: None,
        input_id: None,
        attempt_id: None,
        host_turn_id: None,
        round_id: None,
        origin: None,
    });
    let receipt = SavedReceiptData::ItemAck {
        item_id: item.id.clone(),
        item_revision: item.revision,
        status: item.status.clone(),
        message_id,
    };
    session.items.0.insert(item.id.clone(), item);
    Ok(receipt)
}
