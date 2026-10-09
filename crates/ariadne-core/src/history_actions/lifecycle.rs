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
        OwnerCommand::SessionClose { .. }
        | OwnerCommand::SessionReopen { .. }
        | OwnerCommand::SessionArchive { .. }
        | OwnerCommand::SessionRestore { .. } => {
            let expected = match command {
                OwnerCommand::SessionClose { params, .. }
                | OwnerCommand::SessionReopen { params, .. }
                | OwnerCommand::SessionArchive { params, .. } => params.expected_revision,
                OwnerCommand::SessionRestore { params, .. } => params.expected_revision,
                _ => unreachable!("session lifecycle command"),
            };
            revision(expected, session.revision)?;
            let archive = matches!(command, OwnerCommand::SessionArchive { .. });
            let restore = matches!(command, OwnerCommand::SessionRestore { .. });
            let reopen = matches!(command, OwnerCommand::SessionReopen { .. })
                || matches!(command, OwnerCommand::SessionRestore { params, .. } if params.reopen);
            if archive && session.archived_at.is_some() {
                return Err(core(
                    CoreErrorCode::InvalidTransition,
                    "The session is already archived",
                ));
            }
            if restore && session.archived_at.is_none() {
                return Err(core(
                    CoreErrorCode::InvalidTransition,
                    "The session is not archived",
                ));
            }
            if reopen && !restore && session.archived_at.is_some() {
                return Err(core(
                    CoreErrorCode::InvalidTransition,
                    "Restore the archived session before reopening it",
                ));
            }
            if !archive && !restore && (reopen == (session.state == SessionState::Active)) {
                return Err(core(
                    CoreErrorCode::InvalidTransition,
                    "The session already has the requested lifecycle state",
                ));
            }
            // Undo of an active archive reuses Reopen under this same transaction.
            // Ordinary Restore and archiving Closed leave dispatch and inputs alone.
            let cancelled_input_ids = if restore && !reopen {
                vec![]
            } else if archive && session.state == SessionState::Closed {
                // Old Closed sessions may still hold pending messages. Cancel
                // them as promised, keeping the original close time.
                if session.inputs.0.values().any(pending) {
                    let closed_at = session.closed_at.clone();
                    let cancelled = set_closed(session, true, at);
                    session.closed_at = closed_at;
                    cancelled
                } else {
                    vec![]
                }
            } else {
                set_closed(session, !reopen, at)
            };
            if archive {
                session.archived_at = Some(at.clone());
            } else if restore {
                session.archived_at = None;
            }
            if archive || restore {
                record_archive_history(session, command, archive, at)?;
            }
            Ok(SavedReceiptData::SessionLifecycle {
                state: session.state.clone(),
                closed_at: session.closed_at.clone(),
                archived_at: session.archived_at.clone(),
                cancelled_input_ids,
            })
        }
        _ => unreachable!("validated lifecycle command"),
    }
}

/// Close pauses dispatch and abandons pending inputs exactly once. Reopen lifts
/// the owner pause; Undo can restore and reopen atomically through this path.
fn set_closed(session: &mut Session, close: bool, at: &UtcMillis) -> Vec<UuidV4> {
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
    cancelled_input_ids
}

fn record_archive_history(
    session: &mut Session,
    command: &OwnerCommand,
    archive: bool,
    at: &UtcMillis,
) -> Result<(), CoreError> {
    let id = command.operation_id().clone();
    if session.messages.iter().any(|message| message.id == id) {
        return Err(core(
            CoreErrorCode::InvalidArgument,
            "The archive operation ID is already a history message ID",
        ));
    }
    let number = session.counters.next_message;
    session.counters.next_message =
        PositiveSafeInteger::new(number.value().checked_add(1).ok_or_else(|| {
            core(
                CoreErrorCode::CapacityExceeded,
                "The message counter reached its limit",
            )
        })?)
        .map_err(|_| {
            core(
                CoreErrorCode::CapacityExceeded,
                "The message counter reached its limit",
            )
        })?;
    session.messages.push(Message {
        id,
        number,
        author: MessageAuthor::System,
        kind: MessageKind::Lifecycle,
        body: if archive {
            "Session archived."
        } else if session.state == SessionState::Active {
            "Session restored and reopened."
        } else {
            "Session restored; it remains closed."
        }
        .into(),
        created_at: at.clone(),
        item_id: None,
        topic_id: None,
        items_touched: vec![],
        binding_id: None,
        input_id: None,
        attempt_id: None,
        host_turn_id: None,
        round_id: None,
        origin: None,
    });
    Ok(())
}
