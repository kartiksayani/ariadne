use super::*;
use std::collections::BTreeSet;

/// Validate original conversation records and their canonical cross-links.
/// Compose with item-tree and delivery validation before store commits. Copied
/// histories retain source identities through their existing origin records.
pub fn validate_session_history(session: &Session) -> Result<(), HistoryError> {
    distinct(session.messages.iter().map(|m| &m.id))?;
    distinct(session.messages.iter().map(|m| m.number))?;
    distinct(session.answers.iter().map(|a| &a.id))?;
    distinct(session.answers.iter().map(|a| a.seq))?;
    require(
        session
            .messages
            .windows(2)
            .all(|w| w[0].number < w[1].number)
            && session
                .messages
                .iter()
                .all(|m| m.number < session.counters.next_message),
        HistoryError::InvalidSequence,
    )?;
    require(
        session.answers.windows(2).all(|w| w[0].seq < w[1].seq)
            && session
                .answers
                .iter()
                .all(|a| a.seq < session.counters.next_answer),
        HistoryError::InvalidSequence,
    )?;
    for message in &session.messages {
        distinct(message.items_touched.iter())?;
        for id in &message.items_touched {
            require(
                session.items.0.contains_key(id),
                HistoryError::MissingReference,
            )?;
        }
        if (message.kind == MessageKind::Reply && message.item_id.is_some())
            || (message.kind == MessageKind::OwnerInput && message.item_id.is_some())
        {
            let item = message
                .item_id
                .as_ref()
                .and_then(|id| session.items.0.get(id))
                .ok_or(HistoryError::MissingReference)?;
            require(
                message.topic_id.as_ref() == Some(&item.topic_id)
                    && message.items_touched.contains(&item.id),
                HistoryError::InvalidProvenance,
            )?;
        }
        if let Some(origin) = &message.origin {
            copied_message(session, message, origin)?;
        } else {
            require(
                message.kind != MessageKind::Reply || message.item_id.is_some(),
                HistoryError::MissingReference,
            )?;
            match (&message.author, &message.kind) {
                (MessageAuthor::Owner, MessageKind::OwnerInput) => owner(session, message)?,
                (MessageAuthor::Agent, MessageKind::Reply | MessageKind::Activity) => {
                    text(
                        &message.body,
                        true,
                        if message.kind == MessageKind::Reply {
                            64 * 1024
                        } else {
                            4096
                        },
                    )?;
                    agent(session, message)?;
                }
                (MessageAuthor::System, MessageKind::Lifecycle) => {
                    text(&message.body, true, usize::MAX)?;
                    if let Some(id) = &message.binding_id {
                        require(
                            session.bindings.0.contains_key(id),
                            HistoryError::MissingReference,
                        )?;
                    }
                    if let Some(id) = &message.input_id {
                        let input = session
                            .inputs
                            .0
                            .get(id)
                            .ok_or(HistoryError::MissingReference)?;
                        if let Some(id) = &message.attempt_id {
                            let attempt = input
                                .attempts
                                .iter()
                                .find(|a| &a.id == id)
                                .ok_or(HistoryError::MissingReference)?;
                            require(
                                message
                                    .host_turn_id
                                    .as_ref()
                                    .is_none_or(|id| attempt.host_turn_id.as_ref() == Some(id)),
                                HistoryError::InvalidProvenance,
                            )?;
                        } else {
                            require(
                                message.host_turn_id.is_none(),
                                HistoryError::InvalidProvenance,
                            )?;
                        }
                    } else {
                        require(
                            message.attempt_id.is_none() && message.host_turn_id.is_none(),
                            HistoryError::InvalidProvenance,
                        )?;
                    }
                }
                _ => return Err(HistoryError::InvalidProvenance),
            }
        }
        if let Some(id) = &message.round_id {
            let round = session
                .rounds
                .0
                .get(id)
                .ok_or(HistoryError::MissingReference)?;
            require(
                message
                    .item_id
                    .as_ref()
                    .is_none_or(|id| id == &round.item_id)
                    && (message.item_id.is_some()
                        || (message.kind == MessageKind::Activity
                            && message.items_touched.contains(&round.item_id))),
                HistoryError::InvalidRound,
            )?;
            // Shared activity is session provenance, not an item conversation.
            if message.kind == MessageKind::Activity {
                continue;
            }
            let list = if message.author == MessageAuthor::Owner {
                &round.owner_message_ids
            } else {
                &round.agent_message_ids
            };
            require(list.contains(&message.id), HistoryError::InvalidRound)?;
        }
    }
    for item in session.items.0.values() {
        let created = session
            .messages
            .iter()
            .find(|m| m.id == item.created_message_id)
            .ok_or(HistoryError::MissingReference)?;
        require(
            created.items_touched.contains(&item.id) || created.item_id.as_ref() == Some(&item.id),
            HistoryError::InvalidProvenance,
        )?;
        if let Some(origin) = &item.origin {
            let receipt = session
                .continuations
                .0
                .values()
                .find(|r| r.item_id_map.0.get(&origin.entity_id) == Some(&item.id))
                .ok_or(HistoryError::InvalidProvenance)?;
            require(
                source_matches(
                    receipt,
                    &origin.project_id,
                    &origin.session_id,
                    &origin.topic_id,
                    origin.source_revision,
                ) && item.topic_id == receipt.target_topic_id,
                HistoryError::InvalidProvenance,
            )?;
        }
        distinct(item.updated_message_ids.iter())?;
        for id in &item.updated_message_ids {
            let message = session
                .messages
                .iter()
                .find(|m| &m.id == id)
                .ok_or(HistoryError::MissingReference)?;
            require(
                message.items_touched.contains(&item.id),
                HistoryError::InvalidProvenance,
            )?;
        }
        if let Some(id) = &item.current_round_id {
            require(
                session
                    .rounds
                    .0
                    .get(id)
                    .is_some_and(|r| r.item_id == item.id),
                HistoryError::InvalidRound,
            )?;
        }
        if let Some(id) = &item.source_round_id {
            require(
                session.rounds.0.get(id).is_some_and(|r| {
                    item.parent.as_ref() == Some(&r.item_id) && r.fork_item_ids.contains(&item.id)
                }),
                HistoryError::InvalidRound,
            )?;
        }
    }
    for (id, round) in &session.rounds.0 {
        require(
            id == &round.id && session.items.0.contains_key(&round.item_id),
            HistoryError::InvalidRound,
        )?;
        let opening = session
            .messages
            .iter()
            .find(|m| m.id == round.opened_message_id)
            .ok_or(HistoryError::MissingReference)?;
        require(
            opening.item_id.as_ref() == Some(&round.item_id)
                || (opening.author == MessageAuthor::Agent
                    && opening.kind == MessageKind::Activity
                    && opening.items_touched.contains(&round.item_id)),
            HistoryError::InvalidRound,
        )?;
        distinct(round.owner_message_ids.iter())?;
        distinct(round.agent_message_ids.iter())?;
        distinct(round.result_input_ids.iter())?;
        distinct(round.fork_item_ids.iter())?;
        for (list, author) in [
            (&round.owner_message_ids, MessageAuthor::Owner),
            (&round.agent_message_ids, MessageAuthor::Agent),
        ] {
            let mut previous = None;
            for id in list {
                let m = session
                    .messages
                    .iter()
                    .find(|m| &m.id == id)
                    .ok_or(HistoryError::MissingReference)?;
                require(
                    m.author == author
                        && m.round_id.as_ref() == Some(&round.id)
                        && m.item_id.as_ref() == Some(&round.item_id),
                    HistoryError::InvalidRound,
                )?;
                require(
                    previous.is_none_or(|number| number < m.number),
                    HistoryError::InvalidSequence,
                )?;
                previous = Some(m.number);
            }
        }
        for id in &round.fork_item_ids {
            require(
                session.items.0.get(id).is_some_and(|i| {
                    i.parent.as_ref() == Some(&round.item_id)
                        && i.source_round_id.as_ref() == Some(&round.id)
                }),
                HistoryError::InvalidRound,
            )?;
        }
        if let Some(origin) = &round.origin {
            let receipt = copied_round(session, round, origin)?;
            // Source-scoped result IDs are retained history, not target inputs.
            require(
                receipt.round_id_map.0.get(&origin.entity_id) == Some(&round.id),
                HistoryError::InvalidProvenance,
            )?;
        } else {
            for id in &round.result_input_ids {
                let input = session
                    .inputs
                    .0
                    .get(id)
                    .ok_or(HistoryError::MissingReference)?;
                let mut related = false;
                for attempt in &input.attempts {
                    if let Some(result) = &attempt.domain_result {
                        related |=
                            result_rounds(session, input, attempt, result)?.contains(&round.id);
                    }
                }
                require(related, HistoryError::InvalidProvenance)?;
            }
        }
    }
    for input in session.inputs.0.values() {
        for attempt in &input.attempts {
            if let Some(result) = &attempt.domain_result {
                result_rounds(session, input, attempt, result)?;
            }
        }
    }
    for item in session.items.0.values() {
        distinct(
            session
                .rounds
                .0
                .values()
                .filter(|r| r.item_id == item.id)
                .map(|r| r.ordinal),
        )?;
    }
    for answer in &session.answers {
        let previous = session
            .answers
            .iter()
            .filter(|a| {
                a.item_id == answer.item_id
                    && a.question_revision == answer.question_revision
                    && a.seq < answer.seq
            })
            .max_by_key(|a| a.seq);
        require(
            answer.supersedes_answer_id.as_ref() == previous.map(|a| &a.id),
            HistoryError::InvalidCorrection,
        )?;
        let message = session
            .messages
            .iter()
            .find(|m| m.id == answer.message_id)
            .ok_or(HistoryError::MissingReference)?;
        if let Some(receipt) = session
            .continuations
            .0
            .values()
            .find(|r| r.answer_id_map.0.values().any(|id| id == &answer.id))
        {
            let origin = message
                .origin
                .as_ref()
                .ok_or(HistoryError::InvalidProvenance)?;
            copied_message(session, message, origin)?;
            require(
                source_matches(
                    receipt,
                    &origin.project_id,
                    &origin.session_id,
                    &origin.topic_id,
                    origin.source_revision,
                ) && message.item_id.as_ref() == Some(&answer.item_id)
                    && message.body == answer.text
                    && message.created_at == answer.created_at
                    && message.author == MessageAuthor::Owner
                    && (message.input_id.is_none()
                        || message.input_id.as_ref() == Some(&answer.input_id)),
                HistoryError::InvalidProvenance,
            )?;
            text(&answer.text, answer.selected_option_id.is_none(), 16 * 1024)?;
            if let Some(id) = &answer.selected_option_id {
                require(
                    answer.options_snapshot.iter().any(|o| &o.id == id),
                    HistoryError::InvalidAnswer,
                )?;
            }
            let round = message
                .round_id
                .as_ref()
                .and_then(|id| session.rounds.0.get(id))
                .ok_or(HistoryError::InvalidRound)?;
            require(
                round.question_revision == answer.question_revision
                    && round.question_snapshot == answer.question_snapshot
                    && round.ask_snapshot == answer.ask_snapshot
                    && round.options_snapshot == answer.options_snapshot,
                HistoryError::InvalidSnapshot,
            )?;
            continue;
        }
        let input = session
            .inputs
            .0
            .get(&answer.input_id)
            .ok_or(HistoryError::MissingReference)?;
        require(
            input.answer_id.as_ref() == Some(&answer.id)
                && message.input_id.as_ref() == Some(&input.id)
                && answer.item_id
                    == input
                        .target
                        .item_id
                        .clone()
                        .ok_or(HistoryError::InvalidAnswer)?
                && answer.text == message.body
                && answer.selected_option_id == input.payload.selected_option_id
                && answer.created_at == message.created_at,
            HistoryError::InvalidAnswer,
        )?;
        require(
            input.kind == InputKind::Answer
                && input.payload.intent == InputKind::Answer
                && input.expected_question_revision == Some(answer.question_revision)
                && message.author == MessageAuthor::Owner
                && message.kind == MessageKind::OwnerInput,
            HistoryError::InvalidAnswer,
        )?;
        let round = message
            .round_id
            .as_ref()
            .and_then(|id| session.rounds.0.get(id))
            .ok_or(HistoryError::InvalidRound)?;
        require(
            round.question_revision == answer.question_revision
                && round.question_snapshot == answer.question_snapshot
                && round.ask_snapshot == answer.ask_snapshot
                && round.options_snapshot == answer.options_snapshot,
            HistoryError::InvalidSnapshot,
        )?;
        let snapshot = &input.payload.target_snapshot;
        require(
            snapshot.item_question.as_ref() == Some(&answer.question_snapshot)
                && snapshot.question_revision == Some(answer.question_revision)
                && snapshot.ask == answer.ask_snapshot
                && snapshot.options == answer.options_snapshot,
            HistoryError::InvalidSnapshot,
        )?;
        text(&answer.text, answer.selected_option_id.is_none(), 16 * 1024)?;
        if let Some(id) = &answer.selected_option_id {
            require(
                answer.options_snapshot.iter().any(|o| &o.id == id),
                HistoryError::InvalidAnswer,
            )?;
        }
    }
    Ok(())
}

fn distinct<T: Ord>(values: impl IntoIterator<Item = T>) -> Result<(), HistoryError> {
    let mut seen = BTreeSet::new();
    require(
        values.into_iter().all(|value| seen.insert(value)),
        HistoryError::DuplicateId,
    )
}
fn owner(session: &Session, message: &Message) -> Result<(), HistoryError> {
    let input = message
        .input_id
        .as_ref()
        .and_then(|id| session.inputs.0.get(id))
        .ok_or(HistoryError::MissingReference)?;
    require(
        input.message_id == message.id
            && input.target.item_id == message.item_id
            && message.topic_id.as_ref() == Some(&input.target.topic_id)
            && message.binding_id.as_ref() == Some(&input.binding_id)
            && message.body == input.payload.text
            && message.created_at == input.created_at
            && message.attempt_id.is_none()
            && message.host_turn_id.is_none()
            && message.round_id == input.payload.context.round_id
            && session.bindings.0.contains_key(&input.binding_id),
        HistoryError::InvalidProvenance,
    )?;
    if message.item_id.is_none() {
        require(
            input.kind == InputKind::Continue
                && input.answer_id.is_none()
                && input.payload.selected_option_id.is_none()
                && message.round_id.is_none()
                && message.items_touched.is_empty(),
            HistoryError::InvalidProvenance,
        )?;
    }
    require(
        input.kind == input.payload.intent,
        HistoryError::InvalidProvenance,
    )?;
    let selected = match (&input.kind, &input.answer_id) {
        (InputKind::Answer, Some(id)) => {
            let answer = session
                .answers
                .iter()
                .find(|a| &a.id == id)
                .ok_or(HistoryError::MissingReference)?;
            require(
                answer.input_id == input.id
                    && answer.message_id == message.id
                    && message.item_id.as_ref() == Some(&answer.item_id),
                HistoryError::InvalidAnswer,
            )?;
            answer
                .selected_option_id
                .as_ref()
                .is_some_and(|id| answer.options_snapshot.iter().any(|o| &o.id == id))
        }
        (InputKind::Answer, None) | (_, Some(_)) => return Err(HistoryError::InvalidAnswer),
        (_, None) => {
            require(
                input.payload.selected_option_id.is_none(),
                HistoryError::InvalidAnswer,
            )?;
            false
        }
    };
    text(&message.body, !selected, 16 * 1024)
}
fn agent(session: &Session, message: &Message) -> Result<(), HistoryError> {
    let binding_id = message
        .binding_id
        .as_ref()
        .ok_or(HistoryError::InvalidProvenance)?;
    require(
        session.bindings.0.contains_key(binding_id),
        HistoryError::MissingReference,
    )?;
    match (&message.input_id, &message.attempt_id) {
        (None, None) => require(
            message.host_turn_id.is_none(),
            HistoryError::InvalidProvenance,
        ),
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
            require(
                &input.binding_id == binding_id
                    && message
                        .host_turn_id
                        .as_ref()
                        .is_none_or(|id| attempt.host_turn_id.as_ref() == Some(id)),
                HistoryError::InvalidProvenance,
            )
        }
        _ => Err(HistoryError::InvalidProvenance),
    }
}

pub(super) fn result_rounds(
    session: &Session,
    input: &Input,
    attempt: &Attempt,
    result: &DomainResult,
) -> Result<Vec<UuidV4>, HistoryError> {
    let mut related = vec![];
    if let Some(id) = &input.payload.context.round_id {
        require(
            session.rounds.0.contains_key(id),
            HistoryError::MissingReference,
        )?;
        related.push(id.clone());
    }
    if let Some(id) = &input.payload.context.round_id {
        require(
            session
                .rounds
                .0
                .get(id)
                .is_some_and(|r| input.target.item_id.as_ref() == Some(&r.item_id)),
            HistoryError::InvalidRound,
        )?;
    }
    require(
        session.bindings.0.contains_key(&input.binding_id),
        HistoryError::MissingReference,
    )?;
    let allowed = |id: &Option<UuidV4>| {
        id.as_ref() == Some(&attempt.id)
            || (attempt.purpose == AttemptPurpose::ResultRepair
                && id.as_ref() == attempt.repair_for_attempt_id.as_ref())
    };
    if attempt.purpose == AttemptPurpose::ResultRepair {
        require(
            attempt.repair_for_attempt_id.as_ref().is_some_and(|id| {
                input
                    .attempts
                    .iter()
                    .take_while(|a| a.id != attempt.id)
                    .any(|a| &a.id == id && a.turn_state == TurnState::Completed)
            }),
            HistoryError::InvalidProvenance,
        )?;
    }
    distinct(result.reply_message_ids.iter())?;
    distinct(result.followup_item_ids.iter())?;
    require(
        match result.outcome {
            ResultOutcome::Answered => {
                !result.reply_message_ids.is_empty() || !result.followup_item_ids.is_empty()
            }
            _ => !result.reply_message_ids.is_empty(),
        },
        HistoryError::InvalidProvenance,
    )?;
    for id in &result.reply_message_ids {
        let message = session
            .messages
            .iter()
            .find(|m| &m.id == id)
            .ok_or(HistoryError::MissingReference)?;
        require(
            message.author == MessageAuthor::Agent
                && message.kind == MessageKind::Reply
                && message.input_id.as_ref() == Some(&input.id)
                && message.binding_id.as_ref() == Some(&input.binding_id)
                && allowed(&message.attempt_id),
            HistoryError::InvalidProvenance,
        )?;
        if let Some(id) = &message.round_id {
            require(
                session.rounds.0.contains_key(id),
                HistoryError::MissingReference,
            )?;
            push_unique(&mut related, id.clone());
        }
    }
    for id in &result.followup_item_ids {
        let child = session
            .items
            .0
            .get(id)
            .ok_or(HistoryError::MissingReference)?;
        require(
            session.messages.iter().any(|m| {
                m.id == child.created_message_id
                    && m.author == MessageAuthor::Agent
                    && m.input_id.as_ref() == Some(&input.id)
                    && m.binding_id.as_ref() == Some(&input.binding_id)
                    && allowed(&m.attempt_id)
                    && m.items_touched.contains(id)
            }),
            HistoryError::InvalidProvenance,
        )?;
        if let Some(id) = &child.source_round_id {
            let round = session
                .rounds
                .0
                .get(id)
                .ok_or(HistoryError::MissingReference)?;
            let parent = session
                .items
                .0
                .get(&round.item_id)
                .ok_or(HistoryError::MissingReference)?;
            require(
                child.parent.as_ref() == Some(&round.item_id)
                    && child.topic_id == parent.topic_id
                    && round.fork_item_ids.contains(&child.id),
                HistoryError::InvalidRound,
            )?;
            push_unique(&mut related, id.clone());
        }
    }
    Ok(related)
}

fn source_matches(
    receipt: &ContinuationReceipt,
    project: &UuidV4,
    session: &UuidV4,
    topic: &UuidV4,
    revision: PositiveSafeInteger,
) -> bool {
    &receipt.source_project_id == project
        && &receipt.source_session_id == session
        && &receipt.source_topic_id == topic
        && receipt.source_revision == revision
}
pub(crate) fn copied_message(
    session: &Session,
    message: &Message,
    origin: &MessageOrigin,
) -> Result<(), HistoryError> {
    let receipt = session
        .continuations
        .0
        .values()
        .find(|r| r.message_id_map.0.get(&origin.entity_id) == Some(&message.id))
        .ok_or(HistoryError::InvalidProvenance)?;
    require(
        source_matches(
            receipt,
            &origin.project_id,
            &origin.session_id,
            &origin.topic_id,
            origin.source_revision,
        ) && message.author == origin.author
            && message
                .binding_id
                .as_ref()
                .is_none_or(|id| origin.binding_id.as_ref() == Some(id)),
        HistoryError::InvalidProvenance,
    )?;
    // Source direct targets are fully qualified provenance, never target-local IDs.
    let source = &origin.source_target;
    let immediate = source.project_id == receipt.source_project_id
        && source.session_id == receipt.source_session_id;
    let mapped_item = if immediate {
        source
            .item_id
            .as_ref()
            .and_then(|id| receipt.item_id_map.0.get(id))
    } else {
        None
    };
    let mapped_round = if immediate {
        source
            .round_id
            .as_ref()
            .and_then(|id| receipt.round_id_map.0.get(id))
    } else {
        None
    };
    require(
        message.item_id.as_ref() == mapped_item && message.round_id.as_ref() == mapped_round,
        HistoryError::InvalidProvenance,
    )?;
    if message.kind == MessageKind::Reply {
        require(
            source.item_id.is_some() && source.topic_id.is_some(),
            HistoryError::InvalidProvenance,
        )?;
        if mapped_item.is_some() {
            require(
                immediate
                    && source.topic_id.as_ref() == Some(&receipt.source_topic_id)
                    && message.topic_id.as_ref() == Some(&receipt.target_topic_id),
                HistoryError::InvalidProvenance,
            )?;
        } else {
            require(
                message.topic_id.is_none() && message.round_id.is_none(),
                HistoryError::InvalidProvenance,
            )?;
        }
    } else {
        // Activities/lifecycle entries retain the continuation's contextual grouping.
        require(
            message.topic_id.as_ref() == Some(&receipt.target_topic_id),
            HistoryError::InvalidProvenance,
        )?;
    }
    require(
        match (&message.author, &message.kind) {
            (MessageAuthor::Owner, MessageKind::OwnerInput) => {
                message.attempt_id.is_none() && message.host_turn_id.is_none()
            }
            (MessageAuthor::Agent, MessageKind::Reply | MessageKind::Activity) => {
                message.input_id.is_some() == message.attempt_id.is_some()
                    && (message.attempt_id.is_some() || message.host_turn_id.is_none())
            }
            (MessageAuthor::System, MessageKind::Lifecycle) => true,
            _ => false,
        },
        HistoryError::InvalidProvenance,
    )?;
    let topic = session
        .topics
        .0
        .get(&receipt.target_topic_id)
        .ok_or(HistoryError::MissingReference)?;
    require(
        topic.origin.as_ref().is_some_and(|o| {
            source_matches(
                receipt,
                &o.project_id,
                &o.session_id,
                &o.topic_id,
                o.source_revision,
            )
        }),
        HistoryError::InvalidProvenance,
    )?;
    let selected = session.answers.iter().any(|a| {
        a.message_id == message.id
            && a.selected_option_id
                .as_ref()
                .is_some_and(|id| a.options_snapshot.iter().any(|o| &o.id == id))
    });
    text(
        &message.body,
        !selected,
        match (&message.author, &message.kind) {
            (MessageAuthor::Owner, _) => 16 * 1024,
            (MessageAuthor::Agent, MessageKind::Reply) => 64 * 1024,
            (_, MessageKind::Activity) => 4096,
            _ => usize::MAX,
        },
    )
}
fn copied_round<'a>(
    session: &'a Session,
    round: &Round,
    origin: &RoundOrigin,
) -> Result<&'a ContinuationReceipt, HistoryError> {
    let receipt = session
        .continuations
        .0
        .values()
        .find(|r| r.round_id_map.0.get(&origin.entity_id) == Some(&round.id))
        .ok_or(HistoryError::InvalidProvenance)?;
    let item = session
        .items
        .0
        .get(&round.item_id)
        .ok_or(HistoryError::MissingReference)?;
    require(
        source_matches(
            receipt,
            &origin.project_id,
            &origin.session_id,
            &origin.topic_id,
            origin.source_revision,
        ) && item.topic_id == receipt.target_topic_id,
        HistoryError::InvalidProvenance,
    )?;
    let opening = session
        .messages
        .iter()
        .find(|m| m.id == round.opened_message_id)
        .ok_or(HistoryError::MissingReference)?;
    require(
        opening.origin.as_ref().is_some_and(|o| {
            source_matches(
                receipt,
                &o.project_id,
                &o.session_id,
                &o.topic_id,
                o.source_revision,
            )
        }),
        HistoryError::InvalidProvenance,
    )?;
    Ok(receipt)
}
