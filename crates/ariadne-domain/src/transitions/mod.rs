//! Pure agent-authored item transitions. No owner-input, transport or host event
//! can call a status mutation without a validated agent cause/context.
use crate::models::*;
use crate::validation::{self, ValidationError, ValidationErrorKind};
use std::fmt;

/// Native callable changes, not a second serialized command contract.
#[derive(Debug, Clone, PartialEq)]
pub enum ItemChange {
    Edit {
        question: Option<String>,
        item_type: Option<ItemType>,
        note: Option<Option<String>>,
        links: Option<Vec<ItemLinkTarget>>,
        /// `None` keeps the label, `Some(None)` clears it, `Some(Some(_))` sets
        /// the trimmed value.
        short: Option<Option<String>>,
    },
    Ask {
        ask: String,
        options: Vec<ItemOption>,
        recipient_binding_id: UuidV4,
        round_id: UuidV4,
    },
    Status {
        status: ItemStatus,
        ack_to: Option<AckTarget>,
        outcome: Option<String>,
        why: Option<String>,
        reason: Option<String>,
    },
    Replace {
        replacement: ItemRef,
        outcome: String,
        why: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct TransitionContext {
    pub binding_id: UuidV4,
    pub generation: UuidV4,
    pub cause_message_id: UuidV4,
    pub at: UtcMillis,
    pub handled_through_message_number: NonnegativeSafeInteger,
    pub expected_revision: PositiveSafeInteger,
    pub expected_question_revision: Option<PositiveSafeInteger>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TransitionError {
    Validation(ValidationError),
    MissingItem,
    StaleRevision,
    StaleQuestionRevision,
    MissingBinding,
    DisconnectedBinding,
    StaleGeneration,
    InvalidCauseMessage,
    InvalidTransition,
    MissingReason,
    UnhandledOwnerMessages { message_ids: Vec<UuidV4> },
    InvalidHandledWatermark,
    CounterOverflow,
}
impl From<ValidationError> for TransitionError {
    fn from(error: ValidationError) -> Self {
        Self::Validation(error)
    }
}
impl fmt::Display for TransitionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for TransitionError {}

/// Return an owned candidate; rejection leaves all caller state unchanged.
/// Core assembles cause messages first. For Ask it subsequently closes/creates
/// canonical rounds and inserts this item, then validates the assembled session.
/// Source attempt scope, operation replay and session lifecycle are core checks.
pub fn transition_item(
    session: &Session,
    id: &ItemRef,
    change: &ItemChange,
    context: &TransitionContext,
) -> Result<Item, TransitionError> {
    let old = session
        .items
        .0
        .get(id)
        .ok_or(TransitionError::MissingItem)?;
    validation::validate_item(session, old)?;
    validate_context(session, old, context)?;
    let mut item = old.clone();
    let mut fresh_round = false;
    match change {
        ItemChange::Edit {
            question,
            item_type,
            note,
            links,
            short,
        } => {
            if let Some(short) = short {
                item.short = short
                    .as_deref()
                    .map(|value| validation::normalize_short_label(value, "edit.short"))
                    .transpose()?;
            }
            if let Some(question) = question {
                if question != &item.question {
                    item.question_revision = increment(item.question_revision)?;
                    item.question = question.clone();
                }
            }
            if let Some(item_type) = item_type {
                item.item_type = item_type.clone();
            }
            if let Some(note) = note {
                item.note = note.clone();
            }
            if let Some(links) = links {
                item.links = links.clone();
            }
        }
        ItemChange::Ask {
            ask,
            options,
            recipient_binding_id,
            round_id,
        } => {
            if validation::terminal(&old.status) {
                return Err(TransitionError::InvalidTransition);
            }
            validation::require(
                !session.rounds.0.contains_key(round_id),
                "ask.round_id",
                ValidationErrorKind::Duplicate,
            )?;
            item.status = ItemStatus::WaitingOnMe;
            item.ask = Some(ask.clone());
            item.options = options.clone();
            item.recipient_binding_id = Some(recipient_binding_id.clone());
            item.owner = ItemOwner::Me {};
            item.waiting_since = Some(context.at.clone());
            item.current_round_id = Some(round_id.clone());
            item.question_revision = increment(item.question_revision)?;
            fresh_round = true;
            history(&mut item, old, context, None);
        }
        ItemChange::Status {
            status,
            ack_to,
            outcome,
            why,
            reason,
        } => {
            if matches!(status, ItemStatus::WaitingOnMe | ItemStatus::Replaced)
                || old.status == ItemStatus::Replaced
            {
                return Err(TransitionError::InvalidTransition);
            }
            if !validation::terminal(status) {
                let reason = reason.as_ref().ok_or(TransitionError::MissingReason)?;
                validation::text(reason, "status.reason", true, None)?;
                if ack_to.or(old.ack_to).is_none() && (outcome.is_some() || why.is_some()) {
                    return Err(TransitionError::InvalidTransition);
                }
            } else {
                let answers_owner_input = session
                    .messages
                    .iter()
                    .find(|message| message.id == context.cause_message_id)
                    .and_then(|message| message.input_id.as_ref())
                    .is_some_and(|input_id| session.inputs.0.contains_key(input_id));
                if (old.ack_to.is_some() && !answers_owner_input) || ack_to.is_some() {
                    return Err(TransitionError::InvalidTransition);
                }
                terminal_guard(session, old, context)?;
            }
            validation::optional_text(reason, "status.reason", true, None)?;
            item.status = status.clone();
            item.ack_to = ack_to.or(old.ack_to);
            item.outcome = outcome
                .clone()
                .or_else(|| item.ack_to.and(old.outcome.clone()));
            item.why = why.clone().or_else(|| item.ack_to.and(old.why.clone()));
            item.replaced_by = None;
            leave_waiting(&mut item, old)?;
            history(&mut item, old, context, reason.clone());
        }
        ItemChange::Replace {
            replacement,
            outcome,
            why,
        } => {
            if old.status == ItemStatus::Replaced {
                return Err(TransitionError::InvalidTransition);
            }
            terminal_guard(session, old, context)?;
            item.status = ItemStatus::Replaced;
            item.outcome = Some(outcome.clone());
            item.why = Some(why.clone());
            item.replaced_by = Some(replacement.clone());
            leave_waiting(&mut item, old)?;
            history(&mut item, old, context, None);
        }
    }
    if validation::terminal(&item.status) {
        item.ack_to = None;
    }
    item.revision = increment(item.revision)?;
    item.updated_at = context.at.clone();
    if !item.updated_message_ids.contains(&context.cause_message_id) {
        item.updated_message_ids
            .push(context.cause_message_id.clone());
    }
    validation::items::validate_candidate(session, &item, !fresh_round)?;
    Ok(item)
}

fn validate_context(
    session: &Session,
    item: &Item,
    context: &TransitionContext,
) -> Result<(), TransitionError> {
    if item.revision != context.expected_revision {
        return Err(TransitionError::StaleRevision);
    }
    if context
        .expected_question_revision
        .is_some_and(|revision| revision != item.question_revision)
    {
        return Err(TransitionError::StaleQuestionRevision);
    }
    let binding = session
        .bindings
        .0
        .get(&context.binding_id)
        .ok_or(TransitionError::MissingBinding)?;
    if binding.connection_state == ConnectionState::Disconnected
        || binding.dispatch_state == DispatchState::Disconnected
    {
        return Err(TransitionError::DisconnectedBinding);
    }
    if binding.generation != context.generation {
        return Err(TransitionError::StaleGeneration);
    }
    if !session.messages.iter().any(|message| {
        message.id == context.cause_message_id
            && message.author == MessageAuthor::Agent
            && message.binding_id.as_ref() == Some(&context.binding_id)
            && message.origin.is_none()
    }) {
        return Err(TransitionError::InvalidCauseMessage);
    }
    if context.handled_through_message_number > binding.issued_through_message_number {
        return Err(TransitionError::InvalidHandledWatermark);
    }
    Ok(())
}

fn terminal_guard(
    session: &Session,
    item: &Item,
    context: &TransitionContext,
) -> Result<(), TransitionError> {
    let mut message_ids = Vec::new();
    for message in &session.messages {
        if message.author != MessageAuthor::Owner
            || message.kind != MessageKind::OwnerInput
            || message.item_id.as_ref() != Some(&item.id)
            || message.origin.is_some()
        {
            continue;
        }
        let input = validation::session::owner_input(session, message)?;
        if matches!(
            input.state,
            InputState::Queued | InputState::InFlight | InputState::NeedsAttention
        ) && message.number.value() > context.handled_through_message_number.value()
        {
            message_ids.push(message.id.clone());
        }
    }
    if message_ids.is_empty() {
        Ok(())
    } else {
        Err(TransitionError::UnhandledOwnerMessages { message_ids })
    }
}

fn leave_waiting(item: &mut Item, old: &Item) -> Result<(), TransitionError> {
    item.waiting_since = None;
    if old.status == ItemStatus::WaitingOnMe {
        item.question_revision = increment(item.question_revision)?;
    }
    Ok(())
}

fn history(item: &mut Item, old: &Item, context: &TransitionContext, reason: Option<String>) {
    item.status_history.push(StatusHistoryEntry {
        old_status: old.status.clone(),
        new_status: item.status.clone(),
        previous_outcome: old.outcome.clone(),
        previous_why: old.why.clone(),
        previous_replaced_by: old.replaced_by.clone(),
        cause_message_id: context.cause_message_id.clone(),
        at: context.at.clone(),
        binding_id: Some(context.binding_id.clone()),
        handled_through_message_number: context.handled_through_message_number,
        reason,
    });
}
fn increment(value: PositiveSafeInteger) -> Result<PositiveSafeInteger, TransitionError> {
    value
        .value()
        .checked_add(1)
        .and_then(|next| PositiveSafeInteger::new(next).ok())
        .ok_or(TransitionError::CounterOverflow)
}
