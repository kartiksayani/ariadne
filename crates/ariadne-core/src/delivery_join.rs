//! One pure delivery join, shared by apply and the durable reporter.
use ariadne_domain::models::*;

pub(crate) fn join(session: &mut Session, input_id: &UuidV4, attempt_id: &UuidV4, at: &UtcMillis) {
    // Callers have already validated the exact input/attempt/binding scope.
    let binding_id = &session.inputs.0[input_id].binding_id;
    let contradictory_receipt = session.operation_receipts.0.values().flatten().any(|entry| {
        matches!(&entry.actor_scope, ReceiptActorScope::Adapter { binding_id: actor_binding }
            if actor_binding == binding_id)
            && matches!(&entry.result.data,
                SavedReceiptData::EventConflict { input_id: Some(prior_input), attempt_id: Some(prior_attempt), .. }
                if prior_input == input_id && prior_attempt == attempt_id)
    });
    let input = session.inputs.0.get_mut(input_id).expect("validated input");
    let attempt = input
        .attempts
        .iter_mut()
        .find(|a| &a.id == attempt_id)
        .expect("validated attempt");
    let binding = session
        .bindings
        .0
        .get_mut(&input.binding_id)
        .expect("validated binding");
    if attempt.sealed_at.is_some() {
        return;
    }
    // A committed result wins over every host turn signal: the agent did the
    // work, so the input is handled once the turn is over (or reported failed,
    // interrupted or uncertain). It never becomes a recovery barrier.
    if attempt.result_state == ResultState::Committed && attempt.domain_result.is_some() {
        let ended = !matches!(attempt.turn_state, TurnState::Unknown | TurnState::Running);
        let troubled = matches!(
            attempt.acceptance,
            AcceptanceState::Uncertain | AcceptanceState::Rejected
        ) || attempt.error.is_some()
            || contradictory_receipt;
        if ended || troubled {
            handle_committed(session, input_id, attempt_id, at);
        }
        return;
    }
    let failed = matches!(
        attempt.turn_state,
        TurnState::Failed | TurnState::Interrupted
    );
    let uncertain = matches!(
        attempt.acceptance,
        AcceptanceState::Uncertain | AcceptanceState::Rejected
    );
    let blocking_error = attempt
        .error
        .as_ref()
        .is_some_and(|e| e.code != "result_missing");
    if failed || uncertain || blocking_error || contradictory_receipt {
        input.state = InputState::NeedsAttention;
        binding.dispatch_state = DispatchState::RecoveryRequired;
        if binding.pause_reason.is_none()
            || (contradictory_receipt && binding.pause_reason == Some(PauseReason::ResultMissing))
        {
            binding.pause_reason = Some(if failed {
                PauseReason::HostFailure
            } else {
                PauseReason::Uncertain
            });
        }
    }
}

/// Handle an input whose unsealed attempt committed its result: seal the
/// attempt, free the binding and lift any barrier the input caused.
pub(crate) fn handle_committed(
    session: &mut Session,
    input_id: &UuidV4,
    attempt_id: &UuidV4,
    at: &UtcMillis,
) {
    let input = session.inputs.0.get_mut(input_id).expect("validated input");
    let attempt = input
        .attempts
        .iter_mut()
        .find(|a| &a.id == attempt_id)
        .expect("validated attempt");
    attempt.sealed_at = Some(at.clone());
    input.state = InputState::Handled;
    input.active_attempt_id = None;
    let binding_id = input.binding_id.clone();
    let binding = session
        .bindings
        .0
        .get_mut(&binding_id)
        .expect("validated binding");
    if binding.active_input_id.as_ref() == Some(input_id) {
        binding.active_input_id = None;
    }
    release_barrier(session, &binding_id);
}

/// Lift the recovery barrier a settled queue no longer needs. Once no input on
/// the binding is in flight or needs attention, the input-caused pause reasons
/// clear and dispatch returns to what connection and owner pause allow. A
/// binding-level contradiction or another pause reason stays.
pub(crate) fn release_barrier(session: &mut Session, binding_id: &UuidV4) {
    let unsettled = session.inputs.0.values().any(|input| {
        &input.binding_id == binding_id
            && matches!(
                input.state,
                InputState::InFlight | InputState::NeedsAttention
            )
    });
    let binding_conflict = session
        .operation_receipts
        .0
        .values()
        .flatten()
        .any(|entry| {
            matches!(&entry.actor_scope, ReceiptActorScope::Adapter { binding_id: actor }
            if actor == binding_id)
                && matches!(
                    &entry.result.data,
                    SavedReceiptData::EventConflict { input_id: None, .. }
                )
        });
    let Some(binding) = session.bindings.0.get_mut(binding_id) else {
        return;
    };
    if unsettled || binding_conflict {
        return;
    }
    if matches!(
        binding.pause_reason,
        Some(PauseReason::HostFailure | PauseReason::Uncertain | PauseReason::ResultMissing)
    ) {
        binding.pause_reason = None;
    }
    binding.dispatch_state = crate::bindings::dispatch(binding, false);
}

/// Owner cancellation of a pending input, also used by session close. An
/// in-flight attempt is sealed and abandoned: later host facts about it are
/// ignored. A committed result still wins: that input is handled instead.
/// Returns the input's new state, or None when it was already settled. `cause`
/// is recorded on the input only when it ends cancelled.
pub(crate) fn abandon(
    session: &mut Session,
    input_id: &UuidV4,
    cause: CancelCause,
    at: &UtcMillis,
) -> Option<InputState> {
    let input = session.inputs.0.get_mut(input_id)?;
    if !matches!(
        input.state,
        InputState::Queued | InputState::InFlight | InputState::NeedsAttention
    ) {
        return None;
    }
    if let Some(attempt) = input.attempts.iter().find(|attempt| {
        attempt.sealed_at.is_none()
            && attempt.result_state == ResultState::Committed
            && attempt.domain_result.is_some()
    }) {
        let attempt_id = attempt.id.clone();
        handle_committed(session, input_id, &attempt_id, at);
        return Some(InputState::Handled);
    }
    input.state = InputState::Cancelled;
    input.cancel_cause = Some(cause);
    for attempt in &mut input.attempts {
        if attempt.sealed_at.is_none() {
            attempt.sealed_at = Some(at.clone());
        }
    }
    input.active_attempt_id = None;
    let binding_id = input.binding_id.clone();
    if let Some(binding) = session.bindings.0.get_mut(&binding_id) {
        if binding.active_input_id.as_ref() == Some(input_id) {
            binding.active_input_id = None;
        }
    }
    Some(InputState::Cancelled)
}

/// An input the owner's item/topic removal deleted, named by its saved receipt.
pub(crate) fn removed_input(session: &Session, input_id: &UuidV4) -> bool {
    !session.inputs.0.contains_key(input_id)
        && session
            .operation_receipts
            .0
            .values()
            .flatten()
            .any(|entry| {
                matches!(&entry.result.data,
                SavedReceiptData::Removal { input_ids, .. } if input_ids.contains(input_id))
            })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result_fixture() -> (Session, UuidV4, UuidV4) {
        let mut session: Session =
            serde_json::from_str(include_str!("../../../fixtures/domain/demo/session.json"))
                .unwrap();
        let input = session
            .inputs
            .0
            .values_mut()
            .find(|input| input.attempts.iter().any(|a| a.domain_result.is_some()))
            .unwrap();
        let attempt = input
            .attempts
            .iter_mut()
            .find(|a| a.domain_result.is_some())
            .unwrap();
        attempt.turn_state = TurnState::Running;
        attempt.acceptance = AcceptanceState::Accepted;
        attempt.error = None;
        attempt.sealed_at = None;
        input.state = InputState::InFlight;
        input.active_attempt_id = Some(attempt.id.clone());
        let ids = (input.id.clone(), attempt.id.clone());
        session
            .bindings
            .0
            .get_mut(&input.binding_id)
            .unwrap()
            .active_input_id = Some(input.id.clone());
        (session, ids.0, ids.1)
    }

    #[test]
    fn result_first_completion_joins_once_and_keeps_the_committed_result() {
        let (mut session, input_id, attempt_id) = result_fixture();
        let at = session.updated_at.clone();
        let index = session.inputs.0[&input_id]
            .attempts
            .iter()
            .position(|a| a.id == attempt_id)
            .unwrap();
        let result = session.inputs.0[&input_id].attempts[index]
            .domain_result
            .clone();
        join(&mut session, &input_id, &attempt_id, &at);
        assert_eq!(session.inputs.0[&input_id].state, InputState::InFlight);
        session.inputs.0.get_mut(&input_id).unwrap().attempts[index].turn_state =
            TurnState::Completed;
        join(&mut session, &input_id, &attempt_id, &at);
        assert_eq!(session.inputs.0[&input_id].state, InputState::Handled);
        assert_eq!(
            session.inputs.0[&input_id].attempts[index].domain_result,
            result
        );
        let sealed = session.clone();
        join(&mut session, &input_id, &attempt_id, &at);
        assert_eq!(session, sealed);
    }

    #[test]
    fn resolved_prior_attempt_conflict_does_not_poison_a_distinct_attempt() {
        let (mut session, input_id, attempt_id) = result_fixture();
        let at = session.updated_at.clone();
        let binding_id = session.inputs.0[&input_id].binding_id.clone();
        let mut receipt = session
            .operation_receipts
            .0
            .values()
            .flatten()
            .next()
            .unwrap()
            .clone();
        receipt.actor_scope = ReceiptActorScope::Adapter { binding_id };
        receipt.result.data = SavedReceiptData::EventConflict {
            event_id: "retained prior contradiction".into(),
            input_id: Some(input_id.clone()),
            attempt_id: Some(attempt_id.clone()),
        };
        session
            .operation_receipts
            .0
            .insert(receipt.operation_id.clone(), vec![receipt]);
        let input = session.inputs.0.get_mut(&input_id).unwrap();
        let prior = input
            .attempts
            .iter_mut()
            .find(|a| a.id == attempt_id)
            .unwrap();
        prior.sealed_at = Some(at.clone());
        let mut next = prior.clone();
        next.id = UuidV4::new("00000000-0000-4000-8000-ffffffffffff").unwrap();
        next.sealed_at = None;
        next.turn_state = TurnState::Completed;
        let next_id = next.id.clone();
        input.active_attempt_id = Some(next_id.clone());
        input.attempts.push(next);
        join(&mut session, &input_id, &next_id, &at);
        assert_eq!(session.inputs.0[&input_id].state, InputState::Handled);
        assert!(session.inputs.0[&input_id]
            .attempts
            .last()
            .unwrap()
            .sealed_at
            .is_some());
    }

    #[test]
    fn completed_result_preserves_disconnected_and_unknown_dispatch_barriers() {
        for connection in [ConnectionState::Disconnected, ConnectionState::Unknown] {
            let (mut session, input_id, attempt_id) = result_fixture();
            let at = session.updated_at.clone();
            let input = session.inputs.0.get_mut(&input_id).unwrap();
            input
                .attempts
                .iter_mut()
                .find(|a| a.id == attempt_id)
                .unwrap()
                .turn_state = TurnState::Completed;
            let binding = session.bindings.0.get_mut(&input.binding_id).unwrap();
            binding.connection_state = connection.clone();
            binding.dispatch_state = DispatchState::Disconnected;
            binding.pause_reason = Some(PauseReason::ResultMissing);
            join(&mut session, &input_id, &attempt_id, &at);
            assert_eq!(session.inputs.0[&input_id].state, InputState::Handled);
            let binding = &session.bindings.0[&session.inputs.0[&input_id].binding_id];
            assert_eq!(binding.connection_state, connection);
            assert_eq!(binding.dispatch_state, DispatchState::Disconnected);
        }
    }
}
