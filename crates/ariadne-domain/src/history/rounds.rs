use super::*;

/// Assemble the already transitioned Ask item with its immutable new round.
/// The original Session still contains the previous item/round. No extra item
/// revision is assigned beyond the caller's agent transition.
pub fn open_ask_round(
    session: &Session,
    asked_item: Item,
    opened_message_id: &UuidV4,
    at: UtcMillis,
) -> Result<Session, HistoryError> {
    let old = session
        .items
        .0
        .get(&asked_item.id)
        .ok_or(HistoryError::MissingReference)?;
    let id = asked_item
        .current_round_id
        .as_ref()
        .ok_or(HistoryError::InvalidRound)?;
    require(
        !session.rounds.0.contains_key(id),
        HistoryError::DuplicateId,
    )?;
    require(
        old.topic_id == asked_item.topic_id
            && old.parent == asked_item.parent
            && old.ordinal == asked_item.ordinal
            && asked_item.status == ItemStatus::WaitingOnMe
            && asked_item.ask.is_some()
            && asked_item.waiting_since.as_ref() == Some(&at)
            && asked_item.question_revision == increment(old.question_revision)?
            && asked_item.revision == increment(old.revision)?,
        HistoryError::InvalidSnapshot,
    )?;
    require(
        !matches!(
            old.status,
            ItemStatus::Decided | ItemStatus::Done | ItemStatus::Dropped | ItemStatus::Replaced
        ) && asked_item.question == old.question
            && asked_item.item_type == old.item_type
            && asked_item.created_message_id == old.created_message_id
            && asked_item.created_at == old.created_at
            && asked_item.status_history.starts_with(&old.status_history)
            && asked_item
                .updated_message_ids
                .starts_with(&old.updated_message_ids)
            && asked_item.outcome == old.outcome
            && asked_item.why == old.why
            && asked_item.replaced_by == old.replaced_by
            && asked_item.source_round_id == old.source_round_id
            && asked_item.origin == old.origin
            && asked_item.owner == ItemOwner::Me {}
            && asked_item
                .recipient_binding_id
                .as_ref()
                .is_some_and(|id| session.bindings.0.contains_key(id)),
        HistoryError::InvalidSnapshot,
    )?;
    let opening = session
        .messages
        .iter()
        .find(|m| &m.id == opened_message_id)
        .ok_or(HistoryError::MissingReference)?;
    require(
        opening.author == MessageAuthor::Agent
            && opening.origin.is_none()
            && opening.items_touched.contains(&asked_item.id)
            && asked_item.updated_message_ids.contains(opened_message_id),
        HistoryError::InvalidProvenance,
    )?;
    let mut candidate = session.clone();
    if let Some(previous) = &old.current_round_id {
        let round = candidate
            .rounds
            .0
            .get_mut(previous)
            .ok_or(HistoryError::MissingReference)?;
        require(round.item_id == old.id, HistoryError::InvalidRound)?;
        if round.closed_at.is_none() {
            round.closed_at = Some(at);
        }
    }
    let round = make_round(session, &asked_item, id.clone(), opened_message_id.clone())?;
    candidate.rounds.0.insert(id.clone(), round);
    candidate.items.0.insert(asked_item.id.clone(), asked_item);
    Ok(candidate)
}

pub(super) fn make_round(
    session: &Session,
    item: &Item,
    id: UuidV4,
    opened_message_id: UuidV4,
) -> Result<Round, HistoryError> {
    let previous = session
        .rounds
        .0
        .values()
        .filter(|r| r.item_id == item.id)
        .map(|r| r.ordinal)
        .max();
    let ordinal = match previous {
        Some(value) => increment(value)?,
        None => PositiveSafeInteger::new(1).unwrap(),
    };
    Ok(Round {
        id,
        item_id: item.id.clone(),
        ordinal,
        opened_message_id,
        question_snapshot: item.question.clone(),
        ask_snapshot: item.ask.clone(),
        options_snapshot: item.options.clone(),
        question_revision: item.question_revision,
        owner_message_ids: vec![],
        agent_message_ids: vec![],
        result_input_ids: vec![],
        fork_item_ids: vec![],
        closed_at: None,
        origin: None,
    })
}

/// Close exactly this round. An existing close timestamp is immutable. Clearing
/// its current-item pointer increments that item's revision/update time once.
pub fn close_round(
    session: &Session,
    round_id: &UuidV4,
    at: UtcMillis,
) -> Result<Session, HistoryError> {
    let mut candidate = session.clone();
    close(&mut candidate, round_id, &at)?;
    Ok(candidate)
}
fn close(session: &mut Session, round_id: &UuidV4, at: &UtcMillis) -> Result<(), HistoryError> {
    let round = session
        .rounds
        .0
        .get_mut(round_id)
        .ok_or(HistoryError::MissingReference)?;
    if round.closed_at.is_none() {
        round.closed_at = Some(at.clone());
    }
    let item = session
        .items
        .0
        .get_mut(&round.item_id)
        .ok_or(HistoryError::MissingReference)?;
    if item.current_round_id.as_ref() == Some(round_id) {
        item.current_round_id = None;
        touch(item, at)?;
    }
    Ok(())
}

/// Link an existing child to its parent's source round in both directions.
/// A newly assigned reverse link increments the child's revision/time once;
/// repeat linkage is harmless and never reassigns a different source round.
pub fn link_round_fork(
    session: &Session,
    round_id: &UuidV4,
    child_item_id: &ItemRef,
    at: UtcMillis,
) -> Result<Session, HistoryError> {
    let round = session
        .rounds
        .0
        .get(round_id)
        .ok_or(HistoryError::MissingReference)?;
    let child = session
        .items
        .0
        .get(child_item_id)
        .ok_or(HistoryError::MissingReference)?;
    require(
        child.parent.as_ref() == Some(&round.item_id),
        HistoryError::InvalidRound,
    )?;
    let parent = session
        .items
        .0
        .get(&round.item_id)
        .ok_or(HistoryError::MissingReference)?;
    require(
        child.topic_id == parent.topic_id
            && child
                .source_round_id
                .as_ref()
                .is_none_or(|id| id == round_id),
        HistoryError::InvalidRound,
    )?;
    let mut candidate = session.clone();
    let child = candidate.items.0.get_mut(child_item_id).unwrap();
    if child.source_round_id.is_none() {
        child.source_round_id = Some(round_id.clone());
        touch(child, &at)?;
    }
    push_unique(
        &mut candidate.rounds.0.get_mut(round_id).unwrap().fork_item_ids,
        child_item_id.clone(),
    );
    Ok(candidate)
}

/// Read an already committed result and attach its input to its target, explicit
/// reply and fork-source rounds. Close only explicitly named related rounds.
/// Neither host completion nor result/attempt/input state is authored here.
pub fn link_result_history(
    session: &Session,
    input_id: &UuidV4,
    attempt_id: &UuidV4,
    close_round_ids: &[UuidV4],
    at: UtcMillis,
) -> Result<Session, HistoryError> {
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
    let result = attempt
        .domain_result
        .as_ref()
        .ok_or(HistoryError::MissingReference)?;
    require(
        attempt.result_state == ResultState::Committed,
        HistoryError::InvalidProvenance,
    )?;
    let related = validation::result_rounds(session, input, attempt, result)?;
    require(
        close_round_ids.iter().all(|id| related.contains(id)),
        HistoryError::InvalidRound,
    )?;
    let mut candidate = session.clone();
    for id in related {
        push_unique(
            &mut candidate
                .rounds
                .0
                .get_mut(&id)
                .ok_or(HistoryError::MissingReference)?
                .result_input_ids,
            input_id.clone(),
        );
    }
    for id in close_round_ids {
        close(&mut candidate, id, &at)?;
    }
    Ok(candidate)
}
