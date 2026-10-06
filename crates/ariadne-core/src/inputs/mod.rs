//! Durable native owner submissions. Provider calls, formatting and preparation
//! remain downstream; saving an intent never changes an item status.
mod error;
pub use error::InputError;

use crate::*;
use ariadne_domain::history::{record_owner_history, HistoryError};
use ariadne_domain::models::*;
use ariadne_store::registry::Registry;
use ariadne_store::session::Store;
use std::collections::BTreeSet;

pub struct InputService<'a> {
    registry: &'a Registry,
}
impl<'a> InputService<'a> {
    pub fn new(registry: &'a Registry) -> Self {
        Self { registry }
    }

    /// Native composition supplies the registered owner route, IDs and time.
    /// Exact replay happens inside Store before allocation or mutable guards.
    pub fn execute(
        &self,
        context: &OwnerContext,
        command: &OwnerCommand,
        mut allocate: impl FnMut() -> UuidV4,
        at: UtcMillis,
    ) -> Result<MutationReceipt, InputError> {
        let OwnerScope::Session(route) = context.scope() else {
            return Err(core(
                CoreErrorCode::PermissionDenied,
                "Owner input commands require a trusted registered session route",
            )
            .into());
        };
        command.validate_wire()?;
        let normalized = match command {
            OwnerCommand::InputSubmit { params, .. } => {
                crate::receipts::normalized("input_submit", params)?
            }
            OwnerCommand::InputCancel { params, .. } => {
                crate::receipts::normalized("input_cancel", params)?
            }
            _ => {
                return Err(core(
                    CoreErrorCode::InvalidArgument,
                    "Expected input_submit or input_cancel",
                )
                .into())
            }
        };
        let project = self.registry.resolve_project(route.project_id())?;
        let store = Store::open_registered(&project.root, project.project_id)?;
        let saved = store.transact(
            route.session_id(),
            &ReceiptActorScope::Owner {},
            command.operation_id(),
            &normalized,
            |session| {
                let data = match command {
                    OwnerCommand::InputSubmit { params, .. } => {
                        submit(session, params, &mut allocate, &at)?
                    }
                    OwnerCommand::InputCancel { params, .. } => cancel(session, params)?,
                    _ => unreachable!("validated input command"),
                };
                session.updated_at = at;
                Ok::<_, CoreError>(data)
            },
        )?;
        Ok(MutationReceipt::Session(Box::new(saved)))
    }
}

fn submit(
    session: &mut Session,
    params: &InputSubmitParams,
    allocate: &mut impl FnMut() -> UuidV4,
    at: &UtcMillis,
) -> Result<SavedReceiptData, CoreError> {
    if params.kind == InputKind::Continue || params.target.item_id.is_none() {
        return Err(core(
            CoreErrorCode::InvalidArgument,
            "Continue and topic-only submissions require topic_continue with its preview and mapping",
        ));
    }
    if session.state != SessionState::Active {
        return Err(core(
            CoreErrorCode::InvalidTransition,
            "Explicitly reopen the session before submitting an owner input",
        ));
    }
    if session.active_binding_id.as_ref() != Some(&params.binding_id)
        || !session.bindings.0.contains_key(&params.binding_id)
    {
        return Err(core(
            CoreErrorCode::BindingMismatch,
            "Submit to this session's selected binding",
        ));
    }
    let item_id = params.target.item_id.as_ref().unwrap();
    let item = session
        .items
        .0
        .get(item_id)
        .ok_or_else(|| core(CoreErrorCode::NotFound, "The target item does not exist"))?;
    if item.topic_id != params.target.topic_id {
        return Err(core(
            CoreErrorCode::InvalidArgument,
            "The target item does not belong to the requested topic",
        ));
    }
    if params.kind == InputKind::Answer && item.status != ItemStatus::WaitingOnMe {
        // Distinct from a revision mismatch: the agent never asked this item.
        return Err(core(
            CoreErrorCode::InvalidArgument,
            "The question is not waiting on you; the agent has not asked it yet.",
        ));
    }
    if params.kind != InputKind::Answer {
        if params.supersedes_answer_id.is_some() {
            return Err(core(
                CoreErrorCode::InvalidArgument,
                "Only an Answer can supersede an earlier Answer",
            ));
        }
        if params
            .expected_question_revision
            .is_some_and(|revision| revision != item.question_revision)
        {
            return Err(core(
                CoreErrorCode::QuestionChanged,
                "The target question changed before this owner input",
            ));
        }
    }
    let topic = session
        .topics
        .0
        .get(&item.topic_id)
        .ok_or_else(|| core(CoreErrorCode::NotFound, "The target topic does not exist"))?;
    if topic.archived_at.is_some() {
        return Err(core(
            CoreErrorCode::InvalidTransition,
            "Restore the archived topic before submitting an owner input",
        ));
    }
    if session
        .inputs
        .0
        .values()
        .filter(|input| {
            matches!(
                input.state,
                InputState::Queued | InputState::InFlight | InputState::NeedsAttention
            )
        })
        .count()
        >= 100
    {
        return Err(core(
            CoreErrorCode::QueueFull,
            "This session already has 100 pending inputs",
        ));
    }
    let next_input = increment(session.counters.next_input)?;
    let mut occupied = occupied_ids(session);
    let input_id = fresh(&mut occupied, allocate)?;
    let message_id = fresh(&mut occupied, allocate)?;
    let answer_id = if params.kind == InputKind::Answer {
        Some(fresh(&mut occupied, allocate)?)
    } else {
        None
    };
    let current_round = item
        .current_round_id
        .as_ref()
        .and_then(|id| session.rounds.0.get(id));
    let new_round = if current_round.is_some_and(|round| round.closed_at.is_none()) {
        None
    } else {
        Some(fresh(&mut occupied, allocate)?)
    };
    let round_id = new_round.clone().or_else(|| item.current_round_id.clone());
    let input = Input {
        id: input_id.clone(),
        seq: session.counters.next_input,
        binding_id: params.binding_id.clone(),
        kind: params.kind.clone(),
        target: params.target.clone(),
        message_id: message_id.clone(),
        answer_id: answer_id.clone(),
        created_at: at.clone(),
        expected_question_revision: params.expected_question_revision,
        payload: InputPayload {
            text: params.text.clone(),
            intent: params.kind.clone(),
            target_snapshot: InputTargetSnapshot {
                topic_name: topic.name.clone(),
                item_question: Some(item.question.clone()),
                question_revision: Some(item.question_revision),
                ask: item.ask.clone(),
                options: item.options.clone(),
            },
            selected_option_id: params.selected_option_id.clone(),
            context: InputContext {
                message_ids: vec![],
                item_ids: vec![item_id.clone()],
                round_id: round_id.clone(),
                continuation_operation_id: None,
            },
        },
        state: InputState::Queued,
        attempts: vec![],
        active_attempt_id: None,
        resolution_history: vec![],
    };
    let message = Message {
        id: message_id.clone(),
        number: session.counters.next_message,
        author: MessageAuthor::Owner,
        kind: MessageKind::OwnerInput,
        body: params.text.clone(),
        created_at: at.clone(),
        item_id: Some(item_id.clone()),
        topic_id: Some(item.topic_id.clone()),
        items_touched: vec![],
        binding_id: Some(params.binding_id.clone()),
        input_id: Some(input_id.clone()),
        attempt_id: None,
        host_turn_id: None,
        round_id,
        origin: None,
    };
    let answer = answer_id.as_ref().map(|id| Answer {
        id: id.clone(),
        seq: session.counters.next_answer,
        item_id: item_id.clone(),
        question_revision: item.question_revision,
        question_snapshot: item.question.clone(),
        ask_snapshot: item.ask.clone(),
        options_snapshot: item.options.clone(),
        selected_option_id: params.selected_option_id.clone(),
        text: params.text.clone(),
        message_id: message_id.clone(),
        input_id: input_id.clone(),
        supersedes_answer_id: params.supersedes_answer_id.clone(),
        created_at: at.clone(),
    });
    let data = SavedReceiptData::InputSubmit {
        input_id,
        message_id,
        message_number: message.number,
        answer_id,
        input_seq: input.seq,
    };
    // Work on a complete candidate. The history helper owns snapshot/answer/
    // correction/round validation and its counters; Store owns final validation.
    let mut candidate = session.clone();
    candidate.counters.next_input = next_input;
    candidate.inputs.0.insert(input.id.clone(), input);
    *session = record_owner_history(&candidate, message, answer, new_round).map_err(|error| {
        let correction = error == HistoryError::InvalidCorrection;
        let mut error = history_error(error);
        if correction {
            error.current_revision = Some(session.revision);
            error.hint = "Reload the current eligible Answer for this item and question episode before correcting it.".into();
        }
        error
    })?;
    Ok(data)
}

fn cancel(
    session: &mut Session,
    params: &InputCancelParams,
) -> Result<SavedReceiptData, CoreError> {
    if session.revision != params.expected_revision {
        let mut error = core(
            CoreErrorCode::RevisionConflict,
            "The session revision changed before cancellation",
        );
        error.current_revision = Some(session.revision);
        return Err(error);
    }
    let input = session
        .inputs
        .0
        .get_mut(&params.input_id)
        .ok_or_else(|| core(CoreErrorCode::NotFound, "The input does not exist"))?;
    if input.state != InputState::Queued
        || !input.attempts.is_empty()
        || input.active_attempt_id.is_some()
    {
        return Err(core(
            CoreErrorCode::InvalidTransition,
            "Only a queued, never-prepared input can be cancelled",
        ));
    }
    input.state = InputState::Cancelled;
    Ok(SavedReceiptData::InputCancel {
        input_id: input.id.clone(),
        state: input.state.clone(),
    })
}

fn increment(value: PositiveSafeInteger) -> Result<PositiveSafeInteger, CoreError> {
    value
        .value()
        .checked_add(1)
        .and_then(|n| PositiveSafeInteger::new(n).ok())
        .ok_or_else(|| {
            core(
                CoreErrorCode::CapacityExceeded,
                "The input sequence reached its safe integer limit",
            )
        })
}
fn occupied_ids(session: &Session) -> BTreeSet<UuidV4> {
    let mut ids: BTreeSet<_> = session
        .inputs
        .0
        .keys()
        .chain(session.rounds.0.keys())
        .chain(session.bindings.0.keys())
        .chain(session.topics.0.keys())
        .cloned()
        .collect();
    ids.extend(session.messages.iter().map(|m| m.id.clone()));
    ids.extend(session.answers.iter().map(|a| a.id.clone()));
    ids.extend(
        session
            .inputs
            .0
            .values()
            .flat_map(|i| i.attempts.iter().map(|a| a.id.clone())),
    );
    ids.insert(session.id.clone());
    ids.insert(session.project_id.clone());
    ids
}
fn fresh(
    ids: &mut BTreeSet<UuidV4>,
    allocate: &mut impl FnMut() -> UuidV4,
) -> Result<UuidV4, CoreError> {
    let id = allocate();
    if !ids.insert(id.clone()) {
        return Err(core(
            CoreErrorCode::InvalidArgument,
            "The native allocator returned an existing entity ID",
        ));
    }
    Ok(id)
}
fn core(code: CoreErrorCode, message: &str) -> CoreError {
    CoreError::new(
        code,
        message,
        "Reload the registered session and correct the deliberate owner command.",
    )
}
fn history_error(error: HistoryError) -> CoreError {
    let code = match error {
        HistoryError::QuestionChanged => CoreErrorCode::QuestionChanged,
        HistoryError::BindingMismatch => CoreErrorCode::BindingMismatch,
        HistoryError::CounterOverflow => CoreErrorCode::CapacityExceeded,
        HistoryError::ClosedSession | HistoryError::ArchivedTopic => {
            CoreErrorCode::InvalidTransition
        }
        HistoryError::InvalidCorrection => CoreErrorCode::RevisionConflict,
        _ => CoreErrorCode::InvalidArgument,
    };
    core(
        code,
        &format!("Owner history rejected the submission: {error}"),
    )
}
