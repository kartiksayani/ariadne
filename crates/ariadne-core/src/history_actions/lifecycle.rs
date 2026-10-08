use super::core;
use crate::*;
use ariadne_domain::models::*;

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
/// Archive takes the topic's unsent owner inputs with it, as close does for the
/// session: queued ones cancel, in-flight and needs-attention ones are
/// abandoned, and one whose result already committed is handled instead.
/// Items keep their status. Returns the inputs it cancelled.
fn archive_inputs(session: &mut Session, topic: &UuidV4, at: &UtcMillis) -> Vec<UuidV4> {
    let targeted: Vec<_> = session
        .inputs
        .0
        .values()
        .filter(|input| &input.target.topic_id == topic && pending(input))
        .map(|input| (input.id.clone(), input.binding_id.clone()))
        .collect();
    let mut cancelled = vec![];
    let mut bindings = std::collections::BTreeSet::new();
    for (id, binding) in targeted {
        if crate::delivery_join::abandon(session, &id, CancelCause::TopicArchived, at)
            == Some(InputState::Cancelled)
        {
            cancelled.push(id);
        }
        bindings.insert(binding);
    }
    for binding in &bindings {
        crate::delivery_join::release_barrier(session, binding);
    }
    cancelled
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
            // Archive never refuses for open items or pending inputs; restore
            // changes only the lifecycle, so cancelled inputs stay cancelled.
            let cancelled_input_ids = if archive {
                archive_inputs(session, &params.topic_id, at)
            } else {
                vec![]
            };
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
                cancelled_input_ids,
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
            // Close is one step: it pauses dispatch, cancels every pending input
            // (abandoning one in flight, unless its result committed: that one
            // is handled) and leaves items as they are. Reopen carries on: it
            // lifts the owner pause, including one made earlier.
            let mut cancelled_input_ids = vec![];
            if close {
                let pending: Vec<_> = session
                    .inputs
                    .0
                    .values()
                    .filter(|input| pending(input))
                    .map(|input| input.id.clone())
                    .collect();
                for id in pending {
                    if crate::delivery_join::abandon(session, &id, CancelCause::SessionClosed, at)
                        == Some(InputState::Cancelled)
                    {
                        cancelled_input_ids.push(id);
                    }
                }
            }
            let bindings: Vec<_> = session.bindings.0.keys().cloned().collect();
            for id in &bindings {
                crate::delivery_join::release_barrier(session, id);
            }
            if let Some(binding) = session
                .active_binding_id
                .clone()
                .and_then(|id| session.bindings.0.get_mut(&id))
            {
                binding.owner_paused = close;
                binding.dispatch_state = crate::bindings::dispatch(binding, false);
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
                cancelled_input_ids,
            })
        }
        _ => unreachable!("validated lifecycle command"),
    }
}
