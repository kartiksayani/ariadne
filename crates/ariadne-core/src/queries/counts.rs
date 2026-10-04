use super::page::capacity;
use crate::CoreError;
use ariadne_domain::models::*;

pub(super) fn empty() -> SummaryCounts {
    let zero = NonnegativeSafeInteger::new(0).expect("zero");
    SummaryCounts {
        items_by_status: ItemsByStatus {
            open: zero,
            waiting_on_me: zero,
            in_progress: zero,
            decided: zero,
            done: zero,
            dropped: zero,
            replaced: zero,
        },
        waiting_unanswered: zero,
        sent_inputs: SentInputCounts {
            queued: zero,
            in_flight: zero,
            needs_attention: zero,
        },
        archived_topics: zero,
        completeness: Completeness::Complete,
        unavailable_session_ids: vec![],
    }
}
fn add(target: &mut NonnegativeSafeInteger, value: u64) -> Result<(), CoreError> {
    *target = NonnegativeSafeInteger::new(target.value().checked_add(value).ok_or_else(capacity)?)
        .map_err(|_| capacity())?;
    Ok(())
}
/// Canonical unanswered predicate shared by global counts and native queue rows.
/// Topic archive eligibility remains the caller's scope filter.
pub fn waiting_unanswered(session: &Session, item: &Item) -> bool {
    item.status == ItemStatus::WaitingOnMe
        && !session.answers.iter().any(|answer| {
            answer.item_id == item.id
                && answer.question_revision == item.question_revision
                && !session
                    .answers
                    .iter()
                    .any(|newer| newer.supersedes_answer_id.as_ref() == Some(&answer.id))
                && session.inputs.0.get(&answer.input_id).is_none_or(|input| {
                    !matches!(input.state, InputState::Cancelled | InputState::Skipped)
                })
        })
}
pub(super) fn session(session: &Session) -> Result<SummaryCounts, CoreError> {
    let mut result = empty();
    for topic in session.topics.0.values() {
        if topic.archived_at.is_some() {
            add(&mut result.archived_topics, 1)?;
        }
    }
    for item in session.items.0.values().filter(|item| {
        session
            .topics
            .0
            .get(&item.topic_id)
            .is_some_and(|topic| topic.archived_at.is_none())
    }) {
        let count = match item.status {
            ItemStatus::Open => &mut result.items_by_status.open,
            ItemStatus::WaitingOnMe => &mut result.items_by_status.waiting_on_me,
            ItemStatus::InProgress => &mut result.items_by_status.in_progress,
            ItemStatus::Decided => &mut result.items_by_status.decided,
            ItemStatus::Done => &mut result.items_by_status.done,
            ItemStatus::Dropped => &mut result.items_by_status.dropped,
            ItemStatus::Replaced => &mut result.items_by_status.replaced,
        };
        add(count, 1)?;
        if waiting_unanswered(session, item) {
            add(&mut result.waiting_unanswered, 1)?;
        }
    }
    for input in session.inputs.0.values() {
        match input.state {
            InputState::Queued => add(&mut result.sent_inputs.queued, 1)?,
            InputState::InFlight => add(&mut result.sent_inputs.in_flight, 1)?,
            InputState::NeedsAttention => add(&mut result.sent_inputs.needs_attention, 1)?,
            _ => {}
        }
    }
    Ok(result)
}
pub(super) fn merge(target: &mut SummaryCounts, value: &SummaryCounts) -> Result<(), CoreError> {
    macro_rules! fields { ($($field:ident).+) => { add(&mut target.$($field).+, value.$($field).+.value())? }; }
    fields!(items_by_status.open);
    fields!(items_by_status.waiting_on_me);
    fields!(items_by_status.in_progress);
    fields!(items_by_status.decided);
    fields!(items_by_status.done);
    fields!(items_by_status.dropped);
    fields!(items_by_status.replaced);
    fields!(waiting_unanswered);
    fields!(sent_inputs.queued);
    fields!(sent_inputs.in_flight);
    fields!(sent_inputs.needs_attention);
    fields!(archived_topics);
    if value.completeness == Completeness::Partial {
        target.completeness = Completeness::Partial;
    }
    target
        .unavailable_session_ids
        .extend(value.unavailable_session_ids.iter().cloned());
    target.unavailable_session_ids.sort();
    target.unavailable_session_ids.dedup();
    Ok(())
}
