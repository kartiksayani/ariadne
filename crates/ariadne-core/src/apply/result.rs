use super::{
    batch::{increment, Batch},
    error::{core, history},
};
use crate::*;
use ariadne_domain::{history::link_result_history, models::*};

pub(super) fn commit<F: FnMut() -> UuidV4>(
    session: &mut Session,
    batch: &Batch<'_, F>,
) -> Result<(), CoreError> {
    let input_id = batch
        .request
        .source_input_id
        .as_ref()
        .expect("validated result source");
    let attempt_id = batch.request.attempt_id.as_ref().unwrap();
    let draft = batch.request.input_result.as_ref().unwrap();
    let replies = draft
        .reply_refs
        .iter()
        .map(|r| batch.uuid_ref(r, false))
        .collect::<Result<Vec<_>, _>>()?;
    let followups = draft
        .followup_item_refs
        .iter()
        .map(|r| batch.item_ref(r))
        .collect::<Result<Vec<_>, _>>()?;
    for id in &replies {
        if session
            .messages
            .iter()
            .find(|m| &m.id == id)
            .is_none_or(|m| m.origin.is_some())
        {
            return Err(core(
                CoreErrorCode::InvalidRef,
                "Result reply must be an original message in this session",
            ));
        }
    }
    for id in &followups {
        let child = session.items.0.get(id).ok_or_else(|| {
            core(
                CoreErrorCode::InvalidRef,
                "Result follow-up item does not exist",
            )
        })?;
        if child.origin.is_some() {
            return Err(core(
                CoreErrorCode::InvalidRef,
                "Result cannot claim an imported follow-up",
            ));
        }
    }
    let revision = increment(session.revision)?;
    let late_result = {
        let input = &session.inputs.0[input_id];
        let attempt = input.attempts.iter().find(|a| &a.id == attempt_id).unwrap();
        ariadne_domain::history::stopped_waiting_for_result(input, attempt)
    };
    let input = session.inputs.0.get_mut(input_id).unwrap();
    let attempt = input
        .attempts
        .iter_mut()
        .find(|a| &a.id == attempt_id)
        .unwrap();
    attempt.domain_result = Some(DomainResult {
        operation_id: batch.request.op_id.clone(),
        outcome: draft.outcome.clone(),
        explanation: draft.explanation.clone(),
        reply_message_ids: replies,
        followup_item_ids: followups,
        handled_through_message_number: NonnegativeSafeInteger::new(
            draft.handled_through_message_number.value(),
        )
        .unwrap(),
        committed_revision: revision,
        committed_at: batch.at.clone(),
    });
    attempt.result_state = ResultState::Committed;
    *session = link_result_history(session, input_id, attempt_id, &[], batch.at.clone())
        .map_err(history)?;
    if late_result {
        crate::delivery_join::handle_committed(session, input_id, attempt_id, batch.at);
    } else {
        crate::delivery_join::join(session, input_id, attempt_id, batch.at);
    }
    Ok(())
}
