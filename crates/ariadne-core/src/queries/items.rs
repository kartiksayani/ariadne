use super::{page::*, visibility};
use crate::*;
use ariadne_domain::models::*;
use serde_json::json;

pub(super) fn position(session: &Session, item: &Item) -> Result<CursorPosition, CoreError> {
    let mut ordinals = vec![item.ordinal];
    let mut parent = item.parent.as_ref();
    while let Some(id) = parent {
        let item = session
            .items
            .0
            .get(id)
            .ok_or_else(|| invalid("Item parent is missing"))?;
        ordinals.push(item.ordinal);
        parent = item.parent.as_ref();
    }
    ordinals.reverse();
    Ok(CursorPosition::Item {
        ordinals,
        id: item.id.clone(),
    })
}
pub(super) fn message_position(message: &Message) -> CursorPosition {
    CursorPosition::Sequence {
        number: message.number,
        id: message.id.clone(),
    }
}
fn scope(
    session: &Session,
    context: &QueryContext,
    view: QueryView,
    parent: &str,
) -> Result<Scope, CoreError> {
    Ok(Scope {
        digest: visibility::scope(context, json!([view, parent]))?,
        view,
        revision: session.revision,
        aggregate: false,
    })
}
fn empty<T>(revision: PositiveSafeInteger) -> Page<T> {
    Page {
        items: vec![],
        next_cursor: None,
        snapshot_revision: revision,
    }
}
pub(super) fn link(session: &Session, item: &Item) -> ItemLink {
    ItemLink {
        project_id: session.project_id.clone(),
        session_id: session.id.clone(),
        item_id: item.id.clone(),
        question: item.question.clone(),
        status: item.status.clone(),
    }
}

pub(super) fn item(
    session: &Session,
    context: &QueryContext,
    item: &Item,
    selectors: &[ItemPageRequest],
) -> Result<ItemReadProjection, CoreError> {
    let mut result = ItemReadProjection {
        item: snapshot(item),
        updated_messages: empty(session.revision),
        status_history: empty(session.revision),
    };
    let updated: Vec<_> = session
        .messages
        .iter()
        .filter(|message| {
            item.updated_message_ids.contains(&message.id) && visibility::message(context, message)
        })
        .map(|message| (message_position(message), message.clone()))
        .collect();
    let history: Vec<_> = item
        .status_history
        .iter()
        .enumerate()
        .filter(|(_, value)| visibility::message_id(session, context, &value.cause_message_id))
        .map(|(index, value)| {
            (
                CursorPosition::History {
                    index: NonnegativeSafeInteger::new(index as u64).expect("stored index"),
                },
                value.clone(),
            )
        })
        .collect();
    let mut selected = [None, None];
    for selector in selectors {
        let (id, index, cursor, limit) = match selector {
            ItemPageRequest::ItemUpdatedMessages {
                item_id,
                cursor,
                limit,
            } => (item_id, 0, cursor, limit),
            ItemPageRequest::ItemStatusHistory {
                item_id,
                cursor,
                limit,
            } => (item_id, 1, cursor, limit),
        };
        if id == &item.id && selected[index].replace((cursor, limit.value())).is_some() {
            return Err(invalid("Duplicate nested item selector"));
        }
    }
    let updated_scope = scope(
        session,
        context,
        QueryView::ItemUpdatedMessages,
        item.id.as_str(),
    )?;
    let history_scope = scope(
        session,
        context,
        QueryView::ItemStatusHistory,
        item.id.as_str(),
    )?;
    let absent = None;
    let (cursor, limit) = selected[0].unwrap_or((&absent, 100));
    result.updated_messages = page(updated.clone(), &updated_scope, cursor, limit, 0, true)?;
    let (cursor, limit) = selected[1].unwrap_or((&absent, 100));
    result.status_history = page(history.clone(), &history_scope, cursor, limit, 0, true)?;
    // Reserve truthful continuations first; explicitly requested families consume
    // the fixed projection's remaining byte budget before default families.
    for explicit in [true, false] {
        for (index, selection) in selected.iter().enumerate() {
            if selection.is_some() != explicit {
                continue;
            }
            let (cursor, limit) = selection.unwrap_or((&absent, 100));
            if index == 0 {
                let budget = ENTITY_BYTES.saturating_sub(
                    bytes(&result)?.saturating_sub(bytes(&result.updated_messages)?),
                );
                result.updated_messages = page(
                    updated.clone(),
                    &updated_scope,
                    cursor,
                    limit,
                    budget,
                    !explicit,
                )?;
            } else {
                let budget = ENTITY_BYTES
                    .saturating_sub(bytes(&result)?.saturating_sub(bytes(&result.status_history)?));
                result.status_history = page(
                    history.clone(),
                    &history_scope,
                    cursor,
                    limit,
                    budget,
                    !explicit,
                )?;
            }
        }
    }
    if bytes(&result)? > ENTITY_BYTES {
        return Err(capacity());
    }
    Ok(result)
}

pub(super) fn round(
    session: &Session,
    context: &QueryContext,
    round: &Round,
    selectors: &[RoundPageRequest],
) -> Result<RoundProjection, CoreError> {
    let mut result = RoundProjection {
        round: round_snapshot(round),
        answers: empty(session.revision),
        owner_messages: empty(session.revision),
        agent_messages: empty(session.revision),
        results: empty(session.revision),
        forks: empty(session.revision),
    };
    let answers: Vec<_> = session
        .answers
        .iter()
        .filter(|answer| {
            round.owner_message_ids.contains(&answer.message_id)
                && visibility::message_id(session, context, &answer.message_id)
        })
        .map(|answer| {
            (
                CursorPosition::Sequence {
                    number: answer.seq,
                    id: answer.id.clone(),
                },
                answer.clone(),
            )
        })
        .collect();
    let owner: Vec<_> = session
        .messages
        .iter()
        .filter(|message| {
            round.owner_message_ids.contains(&message.id) && visibility::message(context, message)
        })
        .map(|message| (message_position(message), message.clone()))
        .collect();
    let agent: Vec<_> = session
        .messages
        .iter()
        .filter(|message| {
            round.agent_message_ids.contains(&message.id) && visibility::message(context, message)
        })
        .map(|message| (message_position(message), message.clone()))
        .collect();
    let mut results = Vec::new();
    for input in session
        .inputs
        .0
        .values()
        .filter(|input| round.result_input_ids.contains(&input.id))
    {
        for (index, attempt) in input.attempts.iter().enumerate() {
            if let Some(value) = &attempt.domain_result {
                // Results are agent-authored; only direct links visible within
                // this grant are returned, never a hidden owner-body backlink.
                let mut value = value.clone();
                value
                    .reply_message_ids
                    .retain(|id| visibility::message_id(session, context, id));
                results.push((
                    CursorPosition::Result {
                        input_seq: input.seq,
                        attempt_ordinal: PositiveSafeInteger::new(index as u64 + 1)
                            .expect("stored ordinal"),
                        input_id: input.id.clone(),
                        attempt_id: attempt.id.clone(),
                    },
                    ResultProjection {
                        input_id: input.id.clone(),
                        attempt_id: attempt.id.clone(),
                        result: value,
                    },
                ));
            }
        }
    }
    let forks: Vec<_> = round
        .fork_item_ids
        .iter()
        .filter_map(|id| session.items.0.get(id))
        .map(|item| Ok((position(session, item)?, link(session, item))))
        .collect::<Result<_, CoreError>>()?;
    let mut selected = [None; 5];
    for selector in selectors {
        let (id, index, cursor, limit) = match selector {
            RoundPageRequest::RoundAnswers {
                round_id,
                cursor,
                limit,
            } => (round_id, 0, cursor, limit),
            RoundPageRequest::RoundOwnerMessages {
                round_id,
                cursor,
                limit,
            } => (round_id, 1, cursor, limit),
            RoundPageRequest::RoundAgentMessages {
                round_id,
                cursor,
                limit,
            } => (round_id, 2, cursor, limit),
            RoundPageRequest::RoundResults {
                round_id,
                cursor,
                limit,
            } => (round_id, 3, cursor, limit),
            RoundPageRequest::RoundForks {
                round_id,
                cursor,
                limit,
            } => (round_id, 4, cursor, limit),
        };
        if id == &round.id && selected[index].replace((cursor, limit.value())).is_some() {
            return Err(invalid("Duplicate nested round selector"));
        }
    }
    let absent = None;
    let views = [
        QueryView::RoundAnswers,
        QueryView::RoundOwnerMessages,
        QueryView::RoundAgentMessages,
        QueryView::RoundResults,
        QueryView::RoundForks,
    ];
    let scopes: Vec<_> = views
        .into_iter()
        .map(|view| scope(session, context, view, round.id.as_str()))
        .collect::<Result<_, _>>()?;
    macro_rules! fill {
        ($index:expr, $field:ident, $entries:ident, $budget:expr, $empty:expr) => {{
            let (cursor, limit) = selected[$index].unwrap_or((&absent, 100));
            result.$field = page(
                $entries.clone(),
                &scopes[$index],
                cursor,
                limit,
                $budget,
                $empty,
            )?;
        }};
    }
    fill!(0, answers, answers, 0, true);
    fill!(1, owner_messages, owner, 0, true);
    fill!(2, agent_messages, agent, 0, true);
    fill!(3, results, results, 0, true);
    fill!(4, forks, forks, 0, true);
    for explicit in [true, false] {
        for (index, selection) in selected.iter().enumerate() {
            if selection.is_some() != explicit {
                continue;
            }
            macro_rules! bounded {
                ($index:expr, $field:ident, $entries:ident) => {{
                    let budget = ENTITY_BYTES
                        .saturating_sub(bytes(&result)?.saturating_sub(bytes(&result.$field)?));
                    fill!($index, $field, $entries, budget, !explicit);
                }};
            }
            match index {
                0 => bounded!(0, answers, answers),
                1 => bounded!(1, owner_messages, owner),
                2 => bounded!(2, agent_messages, agent),
                3 => bounded!(3, results, results),
                _ => bounded!(4, forks, forks),
            }
        }
    }
    if bytes(&result)? > ENTITY_BYTES {
        return Err(capacity());
    }
    Ok(result)
}

fn snapshot(item: &Item) -> ItemSnapshot {
    ItemSnapshot {
        id: item.id.clone(),
        ordinal: item.ordinal,
        topic_id: item.topic_id.clone(),
        parent: item.parent.clone(),
        question: item.question.clone(),
        item_type: item.item_type.clone(),
        status: item.status.clone(),
        owner: item.owner.clone(),
        revision: item.revision,
        question_revision: item.question_revision,
        next_child: item.next_child,
        ask: item.ask.clone(),
        note: item.note.clone(),
        options: item.options.clone(),
        links: item.links.clone(),
        outcome: item.outcome.clone(),
        why: item.why.clone(),
        replaced_by: item.replaced_by.clone(),
        created_at: item.created_at.clone(),
        updated_at: item.updated_at.clone(),
        created_message_id: item.created_message_id.clone(),
        waiting_since: item.waiting_since.clone(),
        recipient_binding_id: item.recipient_binding_id.clone(),
        current_round_id: item.current_round_id.clone(),
        source_round_id: item.source_round_id.clone(),
        origin: item.origin.clone(),
    }
}
fn round_snapshot(round: &Round) -> RoundSnapshot {
    RoundSnapshot {
        id: round.id.clone(),
        item_id: round.item_id.clone(),
        ordinal: round.ordinal,
        opened_message_id: round.opened_message_id.clone(),
        question_snapshot: round.question_snapshot.clone(),
        ask_snapshot: round.ask_snapshot.clone(),
        options_snapshot: round.options_snapshot.clone(),
        question_revision: round.question_revision,
        closed_at: round.closed_at.clone(),
        origin: round.origin.clone(),
    }
}
