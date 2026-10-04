use super::{error::core, DeliveryError, DeliveryService};
use crate::*;
use ariadne_agent_protocol::{
    is_claude_session_end_event, EventPayload, NormalizedEvent, TurnFinishedStatus,
};
use ariadne_domain::models::*;
use ariadne_store::session::{EventIdentity, EventMutation, EventTransaction};

impl DeliveryService<'_> {
    /// Native adapter facts only. Presence/output remain runtime projections;
    /// durable lifecycle facts are saved before the caller acknowledges them.
    pub fn report(
        &self,
        context: &AdapterContext,
        event: &NormalizedEvent,
        allocate_operation_id: impl FnOnce() -> UuidV4,
    ) -> Result<EventReceipt, DeliveryError> {
        event.validate().map_err(CoreError::from)?;
        if context.binding_id() != &event.binding_id {
            return Err(core(
                CoreErrorCode::BindingMismatch,
                "Event differs from its trusted binding route",
            )
            .into());
        }
        let mut facts = serde_json::to_value(event).expect("typed event");
        facts
            .as_object_mut()
            .expect("event object")
            .remove("observed_at");
        if let EventPayload::Accepted { receipt: Some(_) } = &event.event {
            facts["payload"]["receipt"]
                .as_object_mut()
                .expect("host receipt")
                .remove("observed_at");
        }
        let normalized = crate::receipts::normalized("report", &facts)?;
        let store = self.store(context.session())?;
        let outcome = store.transact_event(
            context.session().session_id(),
            &ReceiptActorScope::Adapter {
                binding_id: event.binding_id.clone(),
            },
            &event.event_id,
            &normalized,
            allocate_operation_id,
            |session, identity| {
                if let EventIdentity::Conflict { prior_receipt } = identity {
                    let (input_id, attempt_id) = match &prior_receipt.data {
                        SavedReceiptData::Event {
                            input_id,
                            attempt_id,
                            ..
                        }
                        | SavedReceiptData::EventConflict {
                            input_id,
                            attempt_id,
                            ..
                        } => (input_id.as_ref(), attempt_id.as_ref()),
                        _ => unreachable!("store event identity"),
                    };
                    // Authority is checked against the immutable original scope.
                    // Changed proposal IDs cannot pause an unrelated attempt.
                    let generation = input_id
                        .zip(attempt_id)
                        .map(|(i, a)| {
                            session.inputs.0[i]
                                .attempts
                                .iter()
                                .find(|v| &v.id == a)
                                .expect("retained receipt attempt")
                                .binding_generation
                                .clone()
                        })
                        .unwrap_or_else(|| event.generation.clone());
                    authorize(session, context, &generation, input_id, attempt_id)?;
                    return Ok(conflict(
                        session,
                        &event.binding_id,
                        input_id,
                        attempt_id,
                        &event.observed_at,
                    ));
                }
                authorize(
                    session,
                    context,
                    &event.generation,
                    event.input_id.as_ref(),
                    event.attempt_id.as_ref(),
                )?;
                if is_claude_session_end_event(event)
                    && session.bindings.0[&event.binding_id].adapter_id != "claude_code_mod"
                {
                    return Err(core(
                        CoreErrorCode::BindingMismatch,
                        "Reserved session-end fact requires a Claude binding",
                    ));
                }
                if event.input_id.is_some() {
                    apply_attempt(session, event)
                } else {
                    apply_binding(session, event)
                }
            },
        )?;
        match outcome {
            EventTransaction::Unchanged => Ok(EventReceipt {
                event_id: event.event_id.clone(),
                session_id: context.session().session_id().clone(),
                revision: None,
                durable_effect: false,
                replayed: false,
            }),
            EventTransaction::Saved { receipt, replayed } => Ok(EventReceipt {
                event_id: event.event_id.clone(),
                session_id: receipt.session_id,
                revision: Some(receipt.revision),
                durable_effect: true,
                replayed,
            }),
            EventTransaction::ProtocolConflict { receipt, .. } => {
                let mut e = core(
                    CoreErrorCode::ProtocolConflict,
                    "Contradictory host facts were retained with an atomic dispatch barrier",
                );
                e.current_revision = Some(receipt.revision);
                let (input_id, attempt_id) = match receipt.data {
                    SavedReceiptData::EventConflict {
                        input_id,
                        attempt_id,
                        ..
                    } => (input_id, attempt_id),
                    _ => unreachable!("conflict receipt"),
                };
                e.details = Some(Box::new(ErrorDetails {
                    reason: Some(BarrierReason::DeliveryUncertain),
                    binding_id: Some(event.binding_id.clone()),
                    input_id,
                    attempt_id,
                    blocking_item_ids: vec![],
                    blocking_input_ids: vec![],
                    dispatch_must_pause: true,
                }));
                Err(e.into())
            }
        }
    }
}

pub(super) fn authorize(
    session: &Session,
    context: &AdapterContext,
    generation: &UuidV4,
    input_id: Option<&UuidV4>,
    attempt_id: Option<&UuidV4>,
) -> Result<(), CoreError> {
    let binding = session
        .bindings
        .0
        .get(context.binding_id())
        .ok_or_else(|| {
            core(
                CoreErrorCode::BindingMismatch,
                "Reported binding is missing",
            )
        })?;
    if session.active_binding_id.as_ref() != Some(context.binding_id()) {
        return Err(core(
            CoreErrorCode::BindingMismatch,
            "Reported binding is not selected",
        ));
    }
    if &binding.generation != context.current_generation() {
        return Err(core(
            CoreErrorCode::StaleGeneration,
            "Trusted adapter generation is stale",
        ));
    }
    if let (Some(input_id), Some(attempt_id)) = (input_id, attempt_id) {
        let input = session
            .inputs
            .0
            .get(input_id)
            .ok_or_else(|| core(CoreErrorCode::InvalidRef, "Reported input is missing"))?;
        let attempt = input
            .attempts
            .iter()
            .find(|a| &a.id == attempt_id)
            .ok_or_else(|| {
                core(
                    CoreErrorCode::InvalidRef,
                    "Reported attempt does not belong to this input",
                )
            })?;
        if &input.binding_id != context.binding_id() || &attempt.binding_generation != generation {
            return Err(core(
                CoreErrorCode::BindingMismatch,
                "Reported attempt route differs from saved preparation",
            ));
        }
        if generation != context.current_generation() {
            let Some(scope) = context.historical_scope() else {
                return Err(core(
                    CoreErrorCode::StaleGeneration,
                    "Historical facts require trusted exact-host reconciliation",
                ));
            };
            if scope.originating_generation() != generation
                || scope.input_id() != input_id
                || scope.attempt_id() != attempt_id
                || scope.endpoint_fingerprint() != &binding.endpoint_fingerprint
            {
                return Err(core(
                    CoreErrorCode::BindingMismatch,
                    "Historical reconciliation does not match this saved attempt and host",
                ));
            }
        }
    } else if input_id.is_some()
        || attempt_id.is_some()
        || generation != context.current_generation()
    {
        return Err(core(
            CoreErrorCode::StaleGeneration,
            "Binding facts require the current generation",
        ));
    }
    Ok(())
}

fn conflict(
    session: &mut Session,
    binding_id: &UuidV4,
    input_id: Option<&UuidV4>,
    attempt_id: Option<&UuidV4>,
    at: &UtcMillis,
) -> EventMutation {
    if let (Some(input_id), Some(attempt_id)) = (input_id, attempt_id) {
        let input = session
            .inputs
            .0
            .get_mut(input_id)
            .expect("authorized input");
        let attempt = input
            .attempts
            .iter_mut()
            .find(|a| &a.id == attempt_id)
            .expect("authorized attempt");
        if attempt.sealed_at.is_none()
            && !matches!(
                input.state,
                InputState::Handled | InputState::Skipped | InputState::Cancelled
            )
        {
            input.state = InputState::NeedsAttention;
            if attempt.error.is_none() {
                attempt.error = Some(AttemptError {
                    code: "protocol_conflict".into(),
                    reason: "Contradictory verified host facts; reconcile before owner recovery."
                        .into(),
                    retryable: false,
                    observed_at: at.clone(),
                });
            }
        }
    }
    let binding = session
        .bindings
        .0
        .get_mut(binding_id)
        .expect("authorized binding");
    binding.dispatch_state = DispatchState::RecoveryRequired;
    if binding.pause_reason.is_none() || binding.pause_reason == Some(PauseReason::ResultMissing) {
        binding.pause_reason = Some(PauseReason::Uncertain);
    }
    session.updated_at = at.clone();
    EventMutation::ProtocolConflict {
        input_id: input_id.cloned(),
        attempt_id: attempt_id.cloned(),
    }
}

fn apply_attempt(
    session: &mut Session,
    event: &NormalizedEvent,
) -> Result<EventMutation, CoreError> {
    let input_id = event.input_id.as_ref().expect("validated matched input");
    let attempt_id = event
        .attempt_id
        .as_ref()
        .expect("validated matched attempt");
    let input = &session.inputs.0[input_id];
    let index = input
        .attempts
        .iter()
        .position(|a| &a.id == attempt_id)
        .expect("authorized attempt");
    let saved = &input.attempts[index];
    let contradictory_turn = event
        .host_turn_id
        .as_ref()
        .is_some_and(|id| saved.host_turn_id.as_ref().is_some_and(|old| old != id));
    let contradictory = contradictory_turn
        || match &event.event {
            EventPayload::Accepted { receipt } => {
                saved.acceptance == AcceptanceState::Rejected
                    || receipt.as_ref().is_some_and(|r| {
                        saved
                            .acceptance_receipt
                            .as_ref()
                            .is_some_and(|old| old.provider_reference != r.provider_reference)
                    })
            }
            EventPayload::TurnStarted {} | EventPayload::VisibleOutput { .. } => {
                saved.acceptance == AcceptanceState::Rejected
            }
            EventPayload::TurnFinished { status, .. } => {
                saved.acceptance == AcceptanceState::Rejected
                    || (matches!(
                        saved.turn_state,
                        TurnState::Completed | TurnState::Failed | TurnState::Interrupted
                    ) && saved.turn_state != turn(*status))
            }
            EventPayload::Rejected { .. } => {
                saved.acceptance == AcceptanceState::Accepted
                    || saved.turn_state != TurnState::Unknown
                    || saved.domain_result.is_some()
            }
            EventPayload::Uncertain { .. } => saved.sealed_at.is_some(),
            _ => false,
        };
    if contradictory {
        return Ok(conflict(
            session,
            &event.binding_id,
            Some(input_id),
            Some(attempt_id),
            &event.observed_at,
        ));
    }
    if saved.sealed_at.is_some()
        || matches!(
            input.state,
            InputState::Handled | InputState::Skipped | InputState::Cancelled
        )
    {
        let redundant = match &event.event {
            EventPayload::Accepted { receipt } => {
                saved.acceptance == AcceptanceState::Accepted
                    && receipt.as_ref().is_none_or(|r| {
                        saved
                            .acceptance_receipt
                            .as_ref()
                            .is_some_and(|old| old.provider_reference == r.provider_reference)
                    })
            }
            EventPayload::TurnStarted {} => {
                saved.turn_state != TurnState::Unknown && saved.host_turn_id == event.host_turn_id
            }
            EventPayload::TurnFinished { status, .. } => {
                saved.turn_state == turn(*status) && saved.host_turn_id == event.host_turn_id
            }
            EventPayload::VisibleOutput { .. } => true,
            _ => false,
        };
        if redundant {
            return Ok(EventMutation::Unchanged);
        }
        return Err(core(
            CoreErrorCode::AttemptSealed,
            "This attempt is sealed; new nonredundant facts cannot rewrite it",
        ));
    }
    if matches!(event.event, EventPayload::VisibleOutput { .. }) {
        return Ok(EventMutation::Unchanged);
    }
    let before = session.clone();
    let attempt = &mut session.inputs.0.get_mut(input_id).expect("input").attempts[index];
    if attempt.host_turn_id.is_none() {
        attempt.host_turn_id = event.host_turn_id.clone();
    }
    match &event.event {
        EventPayload::Accepted { receipt } => {
            if attempt.acceptance == AcceptanceState::Prepared {
                attempt.acceptance = AcceptanceState::Accepted;
                attempt.acceptance_observed_at = Some(event.observed_at.clone());
            }
            if attempt.acceptance_receipt.is_none() {
                attempt.acceptance_receipt = receipt.clone();
            }
        }
        EventPayload::TurnStarted {} => {
            if attempt.turn_state == TurnState::Unknown {
                attempt.turn_state = TurnState::Running;
                attempt.turn_observed_at = Some(event.observed_at.clone());
            }
        }
        EventPayload::TurnFinished { status, reason, .. } => {
            if matches!(attempt.turn_state, TurnState::Unknown | TurnState::Running) {
                attempt.turn_state = turn(*status);
                attempt.turn_observed_at = Some(event.observed_at.clone());
            }
            if *status != TurnFinishedStatus::Completed && attempt.error.is_none() {
                attempt.error = Some(AttemptError {
                    code: "host_failure".into(),
                    reason: reason
                        .clone()
                        .unwrap_or_else(|| "Host turn failed or was interrupted.".into()),
                    retryable: false,
                    observed_at: event.observed_at.clone(),
                });
            }
        }
        EventPayload::Rejected { reason } | EventPayload::Uncertain { reason } => {
            let rejected = matches!(event.event, EventPayload::Rejected { .. });
            if attempt.acceptance == AcceptanceState::Prepared
                || (!rejected && attempt.acceptance == AcceptanceState::Accepted)
            {
                attempt.acceptance = if rejected {
                    AcceptanceState::Rejected
                } else {
                    AcceptanceState::Uncertain
                };
                attempt.acceptance_observed_at = Some(event.observed_at.clone());
            }
            if attempt.error.is_none() {
                attempt.error = Some(AttemptError {
                    code: if rejected {
                        "rejected"
                    } else {
                        "delivery_uncertain"
                    }
                    .into(),
                    reason: reason.clone(),
                    retryable: false,
                    observed_at: event.observed_at.clone(),
                });
            }
        }
        _ => unreachable!("matched lifecycle event"),
    }
    crate::delivery_join::join(session, input_id, attempt_id, &event.observed_at);
    if *session == before {
        return Ok(EventMutation::Unchanged);
    }
    session.updated_at = event.observed_at.clone();
    Ok(EventMutation::Commit {
        input_id: Some(input_id.clone()),
        attempt_id: Some(attempt_id.clone()),
    })
}
fn turn(status: TurnFinishedStatus) -> TurnState {
    match status {
        TurnFinishedStatus::Completed => TurnState::Completed,
        TurnFinishedStatus::Failed => TurnState::Failed,
        TurnFinishedStatus::Interrupted => TurnState::Interrupted,
    }
}

fn apply_binding(
    session: &mut Session,
    event: &NormalizedEvent,
) -> Result<EventMutation, CoreError> {
    if matches!(event.event, EventPayload::Presence { .. }) {
        return Ok(EventMutation::Unchanged);
    }
    if matches!(event.event, EventPayload::Connected { .. })
        && crate::lifecycle::claude_generation_ended(session, &event.binding_id, &event.generation)
    {
        return Err(core(
            CoreErrorCode::HostUnreachable,
            "The original Claude session ended for this binding generation",
        ));
    }
    let before = session.clone();
    let binding = session
        .bindings
        .0
        .get_mut(&event.binding_id)
        .expect("authorized binding");
    match &event.event {
        EventPayload::Connected {
            external_session_id,
            endpoint_fingerprint,
            capabilities,
        } => {
            if external_session_id != &binding.external_session_id
                || endpoint_fingerprint != &binding.endpoint_fingerprint
                || capabilities.as_ref() != &binding.capabilities
            {
                return Err(core(CoreErrorCode::BindingMismatch,"Connected facts differ from the registered verified host identity/capabilities"));
            }
            binding.connection_state = ConnectionState::Connected;
            if binding.pause_reason.is_some()
                || binding.dispatch_state == DispatchState::RecoveryRequired
            {
                binding.dispatch_state = DispatchState::RecoveryRequired;
            } else if binding.owner_paused {
                binding.dispatch_state = DispatchState::Paused;
            } else {
                binding.dispatch_state = DispatchState::Enabled;
            }
        }
        EventPayload::Disconnected { .. } => {
            binding.connection_state = ConnectionState::Disconnected;
            binding.dispatch_state = DispatchState::Disconnected;
        }
        _ => unreachable!("connection event"),
    }
    if *session == before && !is_claude_session_end_event(event) {
        return Ok(EventMutation::Unchanged);
    }
    session.updated_at = event.observed_at.clone();
    Ok(EventMutation::Commit {
        input_id: None,
        attempt_id: None,
    })
}
