use super::core;
use crate::*;
use ariadne_domain::models::*;

fn terminal(item: &Item) -> bool {
    matches!(
        item.status,
        ItemStatus::Decided | ItemStatus::Done | ItemStatus::Dropped | ItemStatus::Replaced
    )
}
fn pending(input: &Input) -> bool {
    matches!(
        input.state,
        InputState::Queued | InputState::InFlight | InputState::NeedsAttention
    )
}
fn revision(expected: PositiveSafeInteger, current: PositiveSafeInteger) -> Result<(), CoreError> {
    if expected == current {
        return Ok(());
    }
    let mut error = core(
        CoreErrorCode::RevisionConflict,
        "The lifecycle revision changed",
    );
    error.current_revision = Some(current);
    Err(error)
}
fn blockers(
    session: &Session,
    topic: Option<&UuidV4>,
    must_pause: bool,
    code: CoreErrorCode,
) -> Result<(), CoreError> {
    let blocking_item_ids: Vec<_> = session
        .items
        .0
        .values()
        .filter(|item| topic.is_none_or(|topic| &item.topic_id == topic) && !terminal(item))
        .map(|item| item.id.clone())
        .collect();
    let blocking_input_ids: Vec<_> = session
        .inputs
        .0
        .values()
        .filter(|input| topic.is_none_or(|topic| &input.target.topic_id == topic) && pending(input))
        .map(|input| input.id.clone())
        .collect();
    if blocking_item_ids.is_empty() && blocking_input_ids.is_empty() && !must_pause {
        return Ok(());
    }
    let mut error = core(
        code,
        "Active items, pending inputs or dispatch prevent this lifecycle action",
    );
    error.details = Some(Box::new(ErrorDetails {
        reason: None,
        binding_id: session.active_binding_id.clone(),
        input_id: None,
        attempt_id: None,
        blocking_item_ids,
        blocking_input_ids,
        dispatch_must_pause: must_pause,
    }));
    Err(error)
}

pub(super) fn apply(
    session: &mut Session,
    command: &OwnerCommand,
    at: &UtcMillis,
) -> Result<SavedReceiptData, CoreError> {
    match command {
        OwnerCommand::TopicArchive { params, .. } | OwnerCommand::TopicRestore { params, .. } => {
            let topic = session
                .topics
                .0
                .get(&params.topic_id)
                .ok_or_else(|| core(CoreErrorCode::NotFound, "The topic does not exist"))?;
            revision(params.expected_revision, topic.revision)?;
            let archive = matches!(command, OwnerCommand::TopicArchive { .. });
            if archive == topic.archived_at.is_some() {
                return Err(core(
                    CoreErrorCode::InvalidTransition,
                    "The topic already has the requested lifecycle state",
                ));
            }
            if archive {
                blockers(
                    session,
                    Some(&params.topic_id),
                    false,
                    CoreErrorCode::TopicNotArchivable,
                )?;
            }
            let topic = session.topics.0.get_mut(&params.topic_id).unwrap();
            topic.revision = PositiveSafeInteger::new(
                topic.revision.value().checked_add(1).ok_or_else(|| {
                    core(
                        CoreErrorCode::CapacityExceeded,
                        "The topic revision reached its limit",
                    )
                })?,
            )
            .map_err(|_| {
                core(
                    CoreErrorCode::CapacityExceeded,
                    "The topic revision reached its limit",
                )
            })?;
            topic.archived_at = archive.then(|| at.clone());
            Ok(SavedReceiptData::TopicLifecycle {
                topic_id: topic.id.clone(),
                topic_revision: topic.revision,
                archived_at: topic.archived_at.clone(),
            })
        }
        OwnerCommand::SessionClose { params, .. } | OwnerCommand::SessionReopen { params, .. } => {
            revision(params.expected_revision, session.revision)?;
            let close = matches!(command, OwnerCommand::SessionClose { .. });
            if close == (session.state == SessionState::Closed) {
                return Err(core(
                    CoreErrorCode::InvalidTransition,
                    "The session already has the requested lifecycle state",
                ));
            }
            if close {
                let quiesced = session
                    .active_binding_id
                    .as_ref()
                    .and_then(|id| session.bindings.0.get(id))
                    .is_none_or(|binding| binding.dispatch_quiesced());
                blockers(session, None, !quiesced, CoreErrorCode::SessionNotClosable)?;
            }
            session.state = if close {
                SessionState::Closed
            } else {
                SessionState::Active
            };
            session.closed_at = close.then(|| at.clone());
            Ok(SavedReceiptData::SessionLifecycle {
                state: session.state.clone(),
                closed_at: session.closed_at.clone(),
            })
        }
        _ => unreachable!("validated lifecycle command"),
    }
}
