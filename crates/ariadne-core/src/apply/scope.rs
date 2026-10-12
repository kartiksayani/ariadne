use super::error::core;
use crate::*;
use ariadne_domain::models::*;

pub(super) fn authorize(
    session: &Session,
    context: &AgentContext,
    request: &ApplyRequest,
) -> Result<(), CoreError> {
    if session.state != SessionState::Active || session.archived_at.is_some() {
        let mut error = core(
            CoreErrorCode::InvalidTransition,
            if session.archived_at.is_some() {
                "The owner archived this session; it takes no changes until the owner restores and reopens it"
            } else {
                "The owner closed this session; it takes no changes until reopened"
            },
        );
        if session.archived_at.is_some() {
            error.hint =
                "Ask the owner to restore and reopen this session before sending changes.".into();
        }
        error.details = Some(reason(context, BarrierReason::SessionClosed));
        return Err(error);
    }
    let binding = session
        .bindings
        .0
        .get(context.binding_id())
        .ok_or_else(|| {
            core(
                CoreErrorCode::BindingMismatch,
                "The acting binding is not in this session",
            )
        })?;
    if session.active_binding_id.as_ref() != Some(context.binding_id())
        || binding.connection_state == ConnectionState::Disconnected
        || binding.dispatch_state == DispatchState::Disconnected
    {
        return Err(core(
            CoreErrorCode::BindingMismatch,
            "This binding is not the selected connected route",
        ));
    }
    if &binding.generation != context.generation() {
        return Err(core(
            CoreErrorCode::StaleGeneration,
            "Reload the current binding generation",
        ));
    }
    let grant = context.read_scope().issued_through_message_number();
    if grant > binding.issued_through_message_number {
        return Err(core(
            CoreErrorCode::InvalidArgument,
            "The trusted issued grant exceeds persisted issuance",
        ));
    }
    match (
        context.read_scope(),
        &request.source_input_id,
        &request.attempt_id,
    ) {
        (AgentReadScope::Terminal { .. }, None, None) => {}
        (
            AgentReadScope::Dispatched {
                source_input_id,
                attempt_id,
                ..
            },
            Some(input_id),
            Some(id),
        ) if source_input_id == input_id && attempt_id == id => {
            let input = session.inputs.0.get(input_id).ok_or_else(|| {
                core(
                    CoreErrorCode::InvalidRef,
                    "Source input does not exist in this session",
                )
            })?;
            let attempt = input.attempts.iter().find(|a| &a.id == id).ok_or_else(|| {
                core(
                    CoreErrorCode::InvalidRef,
                    "Source attempt does not belong to this input",
                )
            })?;
            if attempt.domain_result.is_some() || attempt.result_state == ResultState::Committed {
                return Err(core(CoreErrorCode::ResultAlreadyCommitted, "This attempt already committed a result; only exact saved-operation replay remains valid"));
            }
            if input.state == InputState::Cancelled {
                let mut error = core(
                    CoreErrorCode::AttemptSealed,
                    "The owner cancelled this input; drop it and carry on",
                );
                error.details = Some(reason(context, BarrierReason::InputCancelled));
                return Err(error);
            }
            let late_result = request.input_result.is_some()
                && ariadne_domain::history::stopped_waiting_for_result(input, attempt)
                && result_source_is_live(session, input);
            if !late_result
                && (attempt.sealed_at.is_some()
                    || matches!(input.state, InputState::Handled | InputState::Skipped))
            {
                return Err(core(
                    CoreErrorCode::AttemptSealed,
                    "This input/attempt is sealed",
                ));
            }
            if &attempt.binding_generation != context.generation() {
                return Err(core(CoreErrorCode::StaleGeneration, "Historical read permission does not authorize new writes from an old originating attempt generation"));
            }
            if &input.binding_id != context.binding_id()
                || (!late_result
                    && (input.active_attempt_id.as_ref() != Some(id)
                        || binding.active_input_id.as_ref() != Some(input_id)))
            {
                return Err(core(
                    CoreErrorCode::BindingMismatch,
                    "Source input/attempt must belong to the current active binding generation",
                ));
            }
            let message = session
                .messages
                .iter()
                .find(|m| {
                    m.id == input.message_id
                        && m.author == MessageAuthor::Owner
                        && m.input_id.as_ref() == Some(input_id)
                })
                .ok_or_else(|| {
                    core(CoreErrorCode::InvalidRef, "Source owner message is missing")
                })?;
            if grant.value() > message.number.value() {
                return Err(core(
                    CoreErrorCode::InvalidArgument,
                    "Dispatched grant exceeds this input's issuance ceiling",
                ));
            }
            if let Some(result) = &request.input_result {
                if result.handled_through_message_number < message.number
                    || result.handled_through_message_number.value() > grant.value()
                {
                    return Err(core(CoreErrorCode::InvalidArgument, "Result must acknowledge its source owner message without widening the trusted issued grant"));
                }
            }
        }
        _ => {
            return Err(core(
                CoreErrorCode::BindingMismatch,
                "Apply source fields must match the trusted terminal or dispatched actor context",
            ))
        }
    }
    for (id, expected) in &request.expected_item_revisions.0 {
        let item =
            session.items.0.get(id).ok_or_else(|| {
                core(CoreErrorCode::InvalidRef, "An expected item does not exist")
            })?;
        if &item.revision != expected {
            return Err(conflict(session, "An expected item revision changed"));
        }
    }
    for (id, expected) in &request.expected_topic_revisions.0 {
        let topic = session.topics.0.get(id).ok_or_else(|| {
            core(
                CoreErrorCode::InvalidRef,
                "An expected topic does not exist",
            )
        })?;
        if &topic.revision != expected {
            return Err(conflict(session, "An expected topic revision changed"));
        }
    }
    Ok(())
}

fn result_source_is_live(session: &Session, input: &Input) -> bool {
    session
        .topics
        .0
        .get(&input.target.topic_id)
        .is_some_and(|topic| !ariadne_domain::visibility::topic_is_removed(session, topic))
        && input.target.item_id.as_ref().is_none_or(|id| {
            session
                .items
                .0
                .get(id)
                .is_some_and(|item| !ariadne_domain::visibility::item_is_removed(session, item))
        })
}

pub(super) fn reason(context: &AgentContext, reason: BarrierReason) -> Box<ErrorDetails> {
    let (input_id, attempt_id) = match context.read_scope() {
        AgentReadScope::Dispatched {
            source_input_id,
            attempt_id,
            ..
        } => (Some(source_input_id.clone()), Some(attempt_id.clone())),
        AgentReadScope::Terminal { .. } => (None, None),
    };
    Box::new(ErrorDetails {
        reason: Some(reason),
        binding_id: Some(context.binding_id().clone()),
        input_id,
        attempt_id,
        blocking_item_ids: vec![],
        blocking_input_ids: vec![],
        dispatch_must_pause: false,
        partial_removal: None,
        connected_session_name: None,
    })
}

pub(super) fn conflict(session: &Session, message: &str) -> CoreError {
    let mut error = core(CoreErrorCode::RevisionConflict, message);
    error.current_revision = Some(session.revision);
    error
}
