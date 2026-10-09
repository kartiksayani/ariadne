use super::*;

/// Record caller-prepared owner history. The matching Input must already exist
/// in the candidate; this function never constructs or changes it. Counters must
/// name the supplied Message/Answer sequence, and advance only on success.
/// A fresh round ID is required exactly when the item has no open round.
pub fn record_owner_history(
    session: &Session,
    mut message: Message,
    answer: Option<Answer>,
    new_round_id: Option<UuidV4>,
) -> Result<Session, HistoryError> {
    require(
        session.state == SessionState::Active && session.archived_at.is_none(),
        HistoryError::ClosedSession,
    )?;
    fresh_message(session, &message.id)?;
    require(
        message.author == MessageAuthor::Owner
            && message.kind == MessageKind::OwnerInput
            && message.origin.is_none()
            && message.attempt_id.is_none()
            && message.host_turn_id.is_none(),
        HistoryError::InvalidProvenance,
    )?;
    let input = message
        .input_id
        .as_ref()
        .and_then(|id| session.inputs.0.get(id))
        .ok_or(HistoryError::MissingReference)?;
    let item = message
        .item_id
        .as_ref()
        .and_then(|id| session.items.0.get(id))
        .ok_or(HistoryError::MissingReference)?;
    let topic = session
        .topics
        .0
        .get(&item.topic_id)
        .ok_or(HistoryError::MissingReference)?;
    require(topic.archived_at.is_none(), HistoryError::ArchivedTopic)?;
    require(
        session.bindings.0.contains_key(&input.binding_id)
            && session.active_binding_id.as_ref() == Some(&input.binding_id),
        HistoryError::BindingMismatch,
    )?;
    require(
        input.message_id == message.id
            && input.target.item_id.as_ref() == Some(&item.id)
            && input.target.topic_id == item.topic_id
            && message.topic_id.as_ref() == Some(&item.topic_id)
            && message.binding_id.as_ref() == Some(&input.binding_id)
            && message.created_at == input.created_at
            && message.body == input.payload.text
            && input.kind == input.payload.intent,
        HistoryError::InvalidProvenance,
    )?;
    let snapshot = &input.payload.target_snapshot;
    require(
        snapshot.topic_name == topic.name
            && snapshot.item_question.as_ref() == Some(&item.question)
            && snapshot.question_revision == Some(item.question_revision)
            && snapshot.ask == item.ask
            && snapshot.options == item.options,
        HistoryError::InvalidSnapshot,
    )?;
    require(
        input.answer_id == answer.as_ref().map(|a| a.id.clone())
            && (input.kind == InputKind::Answer) == answer.is_some(),
        HistoryError::InvalidAnswer,
    )?;
    if input.kind == InputKind::Reopen && item.status == ItemStatus::Replaced {
        return Err(HistoryError::InvalidAnswer);
    }
    if let Some(answer) = &answer {
        validate_answer(session, item, input, &message, answer)?;
    } else {
        require(
            input.payload.selected_option_id.is_none(),
            HistoryError::InvalidAnswer,
        )?;
        text(&message.body, true, 16 * 1024)?;
    }
    let mut candidate = session.clone();
    let current = item
        .current_round_id
        .as_ref()
        .and_then(|id| session.rounds.0.get(id));
    if item.current_round_id.is_some() {
        require(
            current.is_some_and(|r| r.item_id == item.id),
            HistoryError::InvalidRound,
        )?;
    }
    let round_id = match current.filter(|round| round.closed_at.is_none()) {
        Some(round) => {
            require(new_round_id.is_none(), HistoryError::InvalidRound)?;
            round.id.clone()
        }
        None => {
            let id = new_round_id.ok_or(HistoryError::InvalidRound)?;
            require(
                !session.rounds.0.contains_key(&id),
                HistoryError::DuplicateId,
            )?;
            let round = rounds::make_round(session, item, id.clone(), message.id.clone())?;
            candidate.rounds.0.insert(id.clone(), round);
            candidate
                .items
                .0
                .get_mut(&item.id)
                .unwrap()
                .current_round_id = Some(id.clone());
            id
        }
    };
    require(
        message.round_id.as_ref() == Some(&round_id)
            && input.payload.context.round_id.as_ref() == Some(&round_id),
        HistoryError::InvalidProvenance,
    )?;
    // Relations are derived, never caller-selected shared-summary copies.
    message.items_touched = vec![item.id.clone()];
    if let Some(answer) = answer {
        require(
            answer.seq == candidate.counters.next_answer,
            HistoryError::InvalidSequence,
        )?;
        candidate.counters.next_answer = increment(candidate.counters.next_answer)?;
        candidate.answers.push(answer);
    }
    append_message(&mut candidate, message)?;
    Ok(candidate)
}

fn validate_answer(
    session: &Session,
    item: &Item,
    input: &Input,
    message: &Message,
    answer: &Answer,
) -> Result<(), HistoryError> {
    require(
        !session.answers.iter().any(|a| a.id == answer.id),
        HistoryError::DuplicateId,
    )?;
    require(
        item.status == ItemStatus::WaitingOnMe
            && input.expected_question_revision == Some(item.question_revision)
            && answer.question_revision == item.question_revision,
        HistoryError::QuestionChanged,
    )?;
    require(
        answer.item_id == item.id
            && answer.message_id == message.id
            && answer.input_id == input.id
            && answer.created_at == message.created_at
            && answer.text == message.body
            && answer.selected_option_id == input.payload.selected_option_id,
        HistoryError::InvalidAnswer,
    )?;
    require(
        answer.question_snapshot == item.question
            && answer.ask_snapshot == item.ask
            && answer.options_snapshot == item.options,
        HistoryError::InvalidSnapshot,
    )?;
    require(
        item.current_round_id
            .as_ref()
            .and_then(|id| session.rounds.0.get(id))
            .is_some_and(|r| {
                r.closed_at.is_none() && r.question_revision == item.question_revision
            }),
        HistoryError::QuestionChanged,
    )?;
    require(
        item.recipient_binding_id.as_ref() == Some(&input.binding_id),
        HistoryError::BindingMismatch,
    )?;
    if let Some(id) = &answer.selected_option_id {
        require(
            item.options.iter().any(|o| &o.id == id),
            HistoryError::InvalidAnswer,
        )?;
    }
    text(&answer.text, answer.selected_option_id.is_none(), 16 * 1024)?;
    let previous = session
        .answers
        .iter()
        .filter(|a| a.item_id == item.id && a.question_revision == item.question_revision)
        .max_by_key(|a| a.seq);
    require(
        answer.supersedes_answer_id.as_ref() == previous.map(|a| &a.id),
        HistoryError::InvalidCorrection,
    )?;
    Ok(())
}
