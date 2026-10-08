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
///
/// An item stops waiting on the owner once the owner sent anything to its current
/// question (answer, reply, note, drop...) that is still on its way (queued or in
/// flight), or a standing answer. A failed delivery (needs attention), a cancelled
/// or skipped input does not count, because those need the owner again. Mirrors
/// the TypeScript `ownerReplied` selector.
pub fn waiting_unanswered(session: &Session, item: &Item) -> bool {
    item.status == ItemStatus::WaitingOnMe
        && !session.inputs.0.values().any(|input| {
            input.target.item_id.as_ref() == Some(&item.id)
                && input.payload.target_snapshot.question_revision.as_ref()
                    == Some(&item.question_revision)
                && matches!(input.state, InputState::Queued | InputState::InFlight)
                && !input.answer_id.as_ref().is_some_and(|answer_id| {
                    session
                        .answers
                        .iter()
                        .any(|newer| newer.supersedes_answer_id.as_ref() == Some(answer_id))
                })
        })
        && !session.answers.iter().any(|answer| {
            answer.item_id == item.id
                && answer.question_revision == item.question_revision
                && !session
                    .answers
                    .iter()
                    .any(|newer| newer.supersedes_answer_id.as_ref() == Some(&answer.id))
                && session.inputs.0.get(&answer.input_id).is_none_or(|input| {
                    !matches!(
                        input.state,
                        InputState::Cancelled | InputState::Skipped | InputState::NeedsAttention
                    )
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
/// Every topic in the session, archived included (`SessionSummary.topic_count`).
pub(super) fn topics(session: &Session) -> Result<NonnegativeSafeInteger, CoreError> {
    let count = u64::try_from(session.topics.0.len()).map_err(|_| capacity())?;
    NonnegativeSafeInteger::new(count).map_err(|_| capacity())
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

#[cfg(test)]
mod tests {
    use super::*;

    const ITEM: &str = "2";
    const DEMO: &str = include_str!("../../../../fixtures/domain/demo/session.json");

    fn seed() -> Session {
        serde_json::from_str(DEMO).expect("demo session")
    }
    fn id(suffix: &str) -> UuidV4 {
        UuidV4::new(format!("00000000-0000-4000-8000-0000000000{suffix}")).expect("id")
    }
    /// Input 76 of the demo session, retargeted to the waiting item 2.
    fn send(session: &mut Session, kind: InputKind, state: InputState, revision: u64) {
        let input = session.inputs.0.get_mut(&id("76")).expect("input 76");
        input.target.item_id = Some(ItemRef::new(ITEM).expect("ref"));
        input.kind = kind.clone();
        input.payload.intent = kind;
        input.state = state;
        input.payload.target_snapshot.question_revision =
            Some(PositiveSafeInteger::new(revision).expect("revision"));
    }
    fn waiting(session: &Session) -> bool {
        let item = &session.items.0[&ItemRef::new(ITEM).expect("ref")];
        assert_eq!(item.status, ItemStatus::WaitingOnMe);
        waiting_unanswered(session, item)
    }
    /// A standing answer `answer` to item 2's question revision 1, sent by `input`.
    fn answer(session: &mut Session, answer: &str, input: &str, supersedes: Option<&str>) {
        let mut standing = session.answers[0].clone();
        standing.id = id(answer);
        standing.item_id = ItemRef::new(ITEM).expect("ref");
        standing.input_id = id(input);
        standing.question_revision = PositiveSafeInteger::new(1).expect("revision");
        standing.supersedes_answer_id = supersedes.map(id);
        session.answers.push(standing);
    }

    #[test]
    fn waits_on_the_owner_until_something_is_sent() {
        assert!(waiting(&seed()));
    }

    #[test]
    fn any_owner_input_kind_on_its_way_moves_the_turn_to_the_agent() {
        use InputKind::{Answer, Drop, Note, Reply};
        for kind in [Answer, Reply, Note, Drop] {
            for state in [InputState::Queued, InputState::InFlight] {
                let mut session = seed();
                send(&mut session, kind.clone(), state.clone(), 1);
                assert!(!waiting(&session), "{kind:?} {state:?}");
            }
        }
    }

    #[test]
    fn a_failed_cancelled_or_skipped_input_still_waits_on_the_owner() {
        for state in [
            InputState::NeedsAttention,
            InputState::Cancelled,
            InputState::Skipped,
        ] {
            let mut session = seed();
            send(&mut session, InputKind::Reply, state.clone(), 1);
            assert!(waiting(&session), "{state:?}");
        }
    }

    /// An answer that archive or close cancelled never reached the agent: the item
    /// waits on the owner again, whatever the cause. The TypeScript `counted` selector
    /// (ui/detail rounds, "You chose …") reads a cancelled message the same way.
    #[test]
    fn an_answer_cancelled_by_archive_or_close_waits_on_the_owner() {
        for cause in [
            None,
            Some(CancelCause::Owner),
            Some(CancelCause::OwnerEdit),
            Some(CancelCause::TopicArchived),
            Some(CancelCause::SessionClosed),
        ] {
            let mut session = seed();
            send(&mut session, InputKind::Answer, InputState::Queued, 1);
            answer(&mut session, "89", "76", None);
            assert!(!waiting(&session), "on its way, {cause:?}");
            let input = session.inputs.0.get_mut(&id("76")).expect("input 76");
            input.state = InputState::Cancelled;
            input.attempts.clear();
            input.cancel_cause = cause;
            assert!(waiting(&session), "cancelled, {cause:?}");
        }
    }

    #[test]
    fn an_input_written_for_an_older_question_does_not_count() {
        let mut session = seed();
        send(&mut session, InputKind::Reply, InputState::Queued, 1);
        let item = session
            .items
            .0
            .get_mut(&ItemRef::new(ITEM).expect("ref"))
            .expect("item");
        item.question_revision = PositiveSafeInteger::new(2).expect("revision");
        assert!(waiting(&session));
    }

    #[test]
    fn a_standing_answer_whose_delivery_failed_waits_on_the_owner() {
        let mut session = seed();
        send(&mut session, InputKind::Answer, InputState::Handled, 1);
        answer(&mut session, "89", "76", None);
        assert!(!waiting(&session));
        let failed = InputState::NeedsAttention;
        send(&mut session, InputKind::Answer, failed, 1);
        assert!(waiting(&session));
    }

    #[test]
    fn a_superseded_answer_does_not_count_but_the_one_replacing_it_does() {
        let mut session = seed();
        send(&mut session, InputKind::Answer, InputState::Queued, 1);
        answer(&mut session, "89", "76", None);
        let input = session.inputs.0.get_mut(&id("76")).expect("input 76");
        input.answer_id = Some(id("89"));
        // Answer 90 replaces 89; its input is unknown to the session, so 90 stands.
        answer(&mut session, "90", "92", Some("89"));
        assert!(!waiting(&session));
        // Once the replacing answer's input is cancelled, nothing of the owner's stands.
        let mut cancelled = session.inputs.0[&id("76")].clone();
        cancelled.id = id("92");
        cancelled.state = InputState::Cancelled;
        cancelled.answer_id = Some(id("90"));
        session.inputs.0.insert(id("92"), cancelled);
        assert!(waiting(&session));
    }

    #[test]
    fn items_in_an_archived_topic_leave_waiting_on_me_and_come_back_on_restore() {
        let mut session = seed();
        let before = super::session(&session).expect("counts");
        assert!(before.waiting_unanswered.value() > 0);
        let topic = session.items.0[&ItemRef::new(ITEM).expect("ref")]
            .topic_id
            .clone();
        let in_topic = session
            .items
            .0
            .values()
            .filter(|item| item.topic_id == topic && waiting_unanswered(&session, item))
            .count() as u64;
        assert!(in_topic > 0);
        session.topics.0.get_mut(&topic).expect("topic").archived_at =
            Some(UtcMillis::new("2026-10-08T12:00:00.000Z").expect("time"));
        let archived = super::session(&session).expect("counts");
        assert_eq!(
            archived.waiting_unanswered.value(),
            before.waiting_unanswered.value() - in_topic
        );
        assert_eq!(
            archived.archived_topics.value(),
            before.archived_topics.value() + 1
        );
        session.topics.0.get_mut(&topic).expect("topic").archived_at = None;
        assert_eq!(super::session(&session).expect("counts"), before);
    }
}
