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
        return;
    }
    if attempt.turn_state != TurnState::Completed
        || attempt.result_state != ResultState::Committed
        || attempt.domain_result.is_none()
    {
        return;
    }
    attempt.sealed_at = Some(at.clone());
    input.state = InputState::Handled;
    input.active_attempt_id = None;
    if binding.active_input_id.as_ref() == Some(input_id) {
        binding.active_input_id = None;
    }
    if binding.pause_reason == Some(PauseReason::ResultMissing) {
        binding.pause_reason = None;
        // Clearing only the automatic missing-result barrier grants no connection
        // or recovery authority and never clears the owner's deliberate pause.
        if binding.connection_state != ConnectionState::Connected {
            binding.dispatch_state = DispatchState::Disconnected;
        } else if binding.owner_paused {
            binding.dispatch_state = DispatchState::Paused;
        } else if matches!(
            binding.dispatch_state,
            DispatchState::Paused | DispatchState::RecoveryRequired
        ) {
            binding.dispatch_state = DispatchState::Enabled;
        }
    }
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
