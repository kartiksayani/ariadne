//! Pure, append-only item conversation history over canonical stored records.
//!
//! Core prepares inputs, actor scope and agent item transitions; these helpers
//! assemble owned candidates without changing queue/attempt/result state. Store
//! owns atomic persistence, final validation, session revision and replay.
mod owner;
mod rounds;
mod validation;

pub use owner::record_owner_history;
pub use rounds::{close_round, link_result_history, link_round_fork, open_ask_round};
pub(crate) use validation::copied_message;
pub use validation::validate_session_history;

use crate::models::*;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HistoryError {
    MissingReference,
    DuplicateId,
    InvalidProvenance,
    InvalidSnapshot,
    InvalidRound,
    InvalidAnswer,
    QuestionChanged,
    InvalidCorrection,
    InvalidText,
    InvalidSequence,
    CounterOverflow,
    ClosedSession,
    ArchivedTopic,
    RemovedWork,
    BindingMismatch,
    StaleGeneration,
    AttemptSealed,
    ResultAlreadyCommitted,
}
impl fmt::Display for HistoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for HistoryError {}

/// Native helper context, not a second serialized API contract.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentHistoryContext {
    pub binding_id: UuidV4,
    pub generation: UuidV4,
    pub source_input_id: Option<UuidV4>,
    pub attempt_id: Option<UuidV4>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReplyDraft {
    pub message_id: UuidV4,
    pub item_id: ItemRef,
    pub text: String,
    pub round_id: Option<UuidV4>,
    pub at: UtcMillis,
}

/// Skip after missing-result expiry stops waiting, but does not discard the
/// completed attempt's answer. Core must also require an input_result in the
/// atomic apply and validate source work, binding, generation and issued grant
/// before applying operations. This predicate stays valid while those operations
/// change the work, so reply order does not change the attempt's provenance.
pub fn stopped_waiting_for_result(input: &Input, attempt: &Attempt) -> bool {
    input.state == InputState::Skipped
        && input.active_attempt_id.is_none()
        && input.attempts.last().is_some_and(|a| a.id == attempt.id)
        && attempt.sealed_at.is_some()
        && !matches!(
            attempt.acceptance,
            AcceptanceState::Rejected | AcceptanceState::Uncertain
        )
        && (attempt.acceptance == AcceptanceState::Accepted || attempt.host_turn_id.is_some())
        && attempt.turn_state == TurnState::Completed
        && attempt.result_state == ResultState::Missing
        && attempt.domain_result.is_none()
        && attempt
            .error
            .as_ref()
            .is_some_and(|e| e.code == "result_missing")
        && input.resolution_history.last().is_some_and(|entry| {
            entry.kind == ResolutionKind::Skip && entry.attempt_id == attempt.id
        })
}

/// Append an explicit full reply to exactly one item. An omitted round uses the
/// current open round, if any; an explicit closed round keeps its close time.
/// Item revision increments once; status/question revision remain unchanged.
pub fn append_reply(
    session: &Session,
    context: &AgentHistoryContext,
    draft: ReplyDraft,
) -> Result<Session, HistoryError> {
    text(&draft.text, true, 64 * 1024)?;
    fresh_message(session, &draft.message_id)?;
    let binding = session
        .bindings
        .0
        .get(&context.binding_id)
        .ok_or(HistoryError::MissingReference)?;
    if binding.connection_state == ConnectionState::Disconnected
        || binding.dispatch_state == DispatchState::Disconnected
    {
        return Err(HistoryError::BindingMismatch);
    }
    if binding.generation != context.generation {
        return Err(HistoryError::StaleGeneration);
    }
    let host_turn_id = match (&context.source_input_id, &context.attempt_id) {
        (None, None) => None,
        (Some(input_id), Some(attempt_id)) => {
            let input = session
                .inputs
                .0
                .get(input_id)
                .ok_or(HistoryError::MissingReference)?;
            let attempt = input
                .attempts
                .iter()
                .find(|a| &a.id == attempt_id)
                .ok_or(HistoryError::MissingReference)?;
            let late_result = stopped_waiting_for_result(input, attempt);
            if input.binding_id != context.binding_id
                || attempt.binding_generation != context.generation
                || (!late_result && input.active_attempt_id.as_ref() != Some(attempt_id))
            {
                return Err(HistoryError::BindingMismatch);
            }
            if attempt.sealed_at.is_some() && !late_result {
                return Err(HistoryError::AttemptSealed);
            }
            if attempt.domain_result.is_some() {
                return Err(HistoryError::ResultAlreadyCommitted);
            }
            attempt.host_turn_id.clone()
        }
        _ => return Err(HistoryError::InvalidProvenance),
    };
    let item = session
        .items
        .0
        .get(&draft.item_id)
        .ok_or(HistoryError::MissingReference)?;
    require(
        !crate::visibility::item_is_removed(session, item),
        HistoryError::RemovedWork,
    )?;
    let round_id = draft.round_id.or_else(|| item.current_round_id.clone());
    if let Some(id) = &round_id {
        require(
            session
                .rounds
                .0
                .get(id)
                .is_some_and(|r| r.item_id == item.id),
            HistoryError::InvalidRound,
        )?;
    }
    let message = Message {
        id: draft.message_id,
        number: session.counters.next_message,
        author: MessageAuthor::Agent,
        kind: MessageKind::Reply,
        body: draft.text,
        created_at: draft.at,
        item_id: Some(item.id.clone()),
        topic_id: Some(item.topic_id.clone()),
        items_touched: vec![item.id.clone()],
        binding_id: Some(context.binding_id.clone()),
        input_id: context.source_input_id.clone(),
        attempt_id: context.attempt_id.clone(),
        host_turn_id,
        round_id,
        origin: None,
    };
    let mut candidate = session.clone();
    append_message(&mut candidate, message)?;
    Ok(candidate)
}

fn append_message(session: &mut Session, message: Message) -> Result<(), HistoryError> {
    fresh_message(session, &message.id)?;
    require(
        message.number == session.counters.next_message,
        HistoryError::InvalidSequence,
    )?;
    session.counters.next_message = increment(session.counters.next_message)?;
    let item_id = message
        .item_id
        .as_ref()
        .ok_or(HistoryError::InvalidProvenance)?;
    let item = session
        .items
        .0
        .get_mut(item_id)
        .ok_or(HistoryError::MissingReference)?;
    touch(item, &message.created_at)?;
    push_unique(&mut item.updated_message_ids, message.id.clone());
    if let Some(id) = &message.round_id {
        let round = session
            .rounds
            .0
            .get_mut(id)
            .ok_or(HistoryError::MissingReference)?;
        let list = if message.author == MessageAuthor::Owner {
            &mut round.owner_message_ids
        } else {
            &mut round.agent_message_ids
        };
        push_unique(list, message.id.clone());
    }
    session.messages.push(message);
    Ok(())
}
fn touch(item: &mut Item, at: &UtcMillis) -> Result<(), HistoryError> {
    item.revision = increment(item.revision)?;
    item.updated_at = at.clone();
    Ok(())
}
fn increment(value: PositiveSafeInteger) -> Result<PositiveSafeInteger, HistoryError> {
    value
        .value()
        .checked_add(1)
        .and_then(|v| PositiveSafeInteger::new(v).ok())
        .ok_or(HistoryError::CounterOverflow)
}
fn text(value: &str, required: bool, maximum: usize) -> Result<(), HistoryError> {
    require(
        !value.contains('\0') && (!required || !value.trim().is_empty()) && value.len() <= maximum,
        HistoryError::InvalidText,
    )
}
fn require(ok: bool, error: HistoryError) -> Result<(), HistoryError> {
    if ok {
        Ok(())
    } else {
        Err(error)
    }
}
fn fresh_message(session: &Session, id: &UuidV4) -> Result<(), HistoryError> {
    require(
        !session.messages.iter().any(|m| &m.id == id),
        HistoryError::DuplicateId,
    )
}
fn push_unique<T: PartialEq>(values: &mut Vec<T>, value: T) {
    if !values.contains(&value) {
        values.push(value);
    }
}
