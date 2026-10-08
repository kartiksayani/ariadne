use super::{bounded_identifier, HistoryScan, UserMessageIdentity};
use crate::{
    generated::v0_160_0::thread_turns_list_response::{
        MessagePhase, ThreadItem, Turn, TurnStatus, UserInput,
    },
    transport::error,
};
use ariadne_agent_protocol::{
    terminal_event_id, AdapterError, AdapterErrorCode as Code, AttemptEvidence, EventPayload,
    NormalizedEvent, OutputOperation, OutputPhase, ReconcileRequest, ReconcileResult,
    TerminalEventKind, TurnFinishedStatus, UtcMillis,
};
use sha2::{Digest, Sha256};
pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(super) fn bounded_text(text: &str) -> (String, bool) {
    let mut end = text.len().min(64 * 1024);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), end < text.len())
}
pub(super) fn match_turn(
    turn: &Turn,
    request: &ReconcileRequest,
    scan: &mut HistoryScan,
    result: &mut ReconcileResult,
    observed_at: UtcMillis,
    newer_turn_exists: bool,
) -> Result<(), AdapterError> {
    for attempt in &request.attempts {
        let mut matches = Vec::new();
        for item in &turn.items {
            if let ThreadItem::UserMessage {
                content,
                id,
                client_id,
            } = item
            {
                // Only the exact original text input is eligible. Rich/non-text content is unresolved.
                if let [UserInput::TextUserInput { text, .. }] = content.as_slice() {
                    if text.split('\n').next() == Some(attempt.wire_marker.as_str())
                        && digest(text.as_bytes()) == attempt.payload_sha256.as_str()
                    {
                        bounded_identifier(id)?;
                        // An optional unusable provider receipt cannot defeat exact content proof.
                        // Never normalize/truncate it into another identity.
                        let client_id = client_id
                            .as_ref()
                            .filter(|id| !id.is_empty() && id.len() <= 4096);
                        matches.push((id, client_id));
                    }
                }
            }
        }
        if matches.is_empty() {
            continue;
        }
        if matches.len() == 1
            && scan
                .message_identities
                .iter()
                .any(|(attempt_id, original)| {
                    attempt_id != &attempt.attempt_id
                        && original.host_turn_id == turn.id
                        && original.host_message_id == *matches[0].0
                })
        {
            return Err(error(
                Code::ProtocolConflict,
                "Codex original user message was claimed by multiple attempts.",
            ));
        }
        if matches.len() != 1
            || scan
                .matched_turns
                .get(&attempt.attempt_id)
                .is_some_and(|prior| prior != &turn.id)
            || attempt
                .host_turn_id
                .as_ref()
                .is_some_and(|expected| expected != &turn.id)
        {
            return Err(error(Code::ProtocolConflict, "Codex input matches multiple or conflicting original turns; reconciliation is paused."));
        }
        scan.matched_turns
            .insert(attempt.attempt_id.clone(), turn.id.clone());
        scan.message_identities.insert(
            attempt.attempt_id.clone(),
            UserMessageIdentity {
                host_turn_id: turn.id.clone(),
                host_message_id: matches[0].0.clone(),
                client_id: matches[0].1.cloned(),
            },
        );
        let event = |event_id: String, event: EventPayload| NormalizedEvent {
            event_id,
            binding_id: request.binding_id.clone(),
            generation: attempt.binding_generation.clone(),
            input_id: Some(attempt.input_id.clone()),
            attempt_id: Some(attempt.attempt_id.clone()),
            host_turn_id: Some(turn.id.clone()),
            observed_at: observed_at.clone(),
            event,
        };
        // Provider has no durable event ID for a history snapshot. Stable snapshot identity
        // scopes distinct messages/updates without pretending the hash is a host message ID.
        let stable_id = |kind: &str, identity: &str, text: &str| {
            digest(
                &serde_json::to_vec(&(
                    request.binding_id.as_str(),
                    attempt.binding_generation.as_str(),
                    attempt.attempt_id.as_str(),
                    &turn.id,
                    kind,
                    identity,
                    text,
                ))
                .expect("string tuple serialization"),
            )
        };
        let mut events = vec![event(
            stable_id("turn_started", &turn.id, ""),
            EventPayload::TurnStarted {},
        )];
        // Split the shared diagnostic budget across requested attempts, preserving
        // lifecycle even when a turn contains many visible messages. Keep newest
        // snapshots and flag any omitted earlier output before the first retained one.
        let maximum_outputs = 256 / request.attempts.len().max(1);
        let mut remaining_bytes = (2 * 1024 * 1024) / request.attempts.len().max(1);
        let mut outputs: Vec<NormalizedEvent> = Vec::new();
        let mut gap = false;
        for item in turn.items.iter().rev() {
            if let ThreadItem::AgentMessage {
                id, phase, text, ..
            } = item
            {
                bounded_identifier(id)?;
                if outputs.len() >= maximum_outputs || remaining_bytes == 0 {
                    gap = true;
                    continue;
                }
                let (mut bounded, mut truncated) = bounded_text(text);
                if bounded.len() > remaining_bytes {
                    let mut end = remaining_bytes;
                    while !bounded.is_char_boundary(end) {
                        end -= 1;
                    }
                    bounded.truncate(end);
                    truncated = true;
                }
                remaining_bytes -= bounded.len();
                let payload = EventPayload::VisibleOutput {
                    host_message_id: Some(id.clone()),
                    phase: match phase {
                        Some(MessagePhase::Commentary) => OutputPhase::Commentary,
                        Some(MessagePhase::FinalAnswer) => OutputPhase::Final,
                        None => OutputPhase::Unknown,
                    },
                    operation: OutputOperation::Replace,
                    text: bounded,
                    truncated,
                    gap_before: false,
                };
                outputs.push(event(String::new(), payload));
            }
        }
        outputs.reverse();
        if gap {
            if let Some(first) = outputs.first_mut() {
                if let EventPayload::VisibleOutput { gap_before, .. } = &mut first.event {
                    *gap_before = true;
                }
            }
        }
        for mut output in outputs {
            // Identity includes all exposed snapshot fields, including phase and gaps.
            output.event_id = stable_id(
                "visible_output",
                "snapshot",
                &serde_json::to_string(&output.event).map_err(|_| {
                    error(
                        Code::IncompatibleAdapter,
                        "Cannot encode Codex diagnostic snapshot.",
                    )
                })?,
            );
            events.push(output);
        }
        let status = match turn.status {
            TurnStatus::Completed => Some(TurnFinishedStatus::Completed),
            TurnStatus::Failed => Some(TurnFinishedStatus::Failed),
            // The app-server also reports `interrupted` for a turn it is not
            // running itself (a local TUI still running it, or one read back
            // mid-write) with no end time. Only a recorded end, an error or a
            // later turn proves it ended; otherwise it is still in progress.
            TurnStatus::Interrupted
                if turn.completed_at.is_some() || turn.error.is_some() || newer_turn_exists =>
            {
                Some(TurnFinishedStatus::Interrupted)
            }
            TurnStatus::Interrupted | TurnStatus::InProgress => None,
        };
        if let Some(status) = status {
            events.push(event(
                terminal_event_id(
                    &request.binding_id,
                    &attempt.binding_generation,
                    &attempt.attempt_id,
                    Some(&turn.id),
                    TerminalEventKind::TurnFinished,
                    None,
                )?,
                EventPayload::TurnFinished {
                    status,
                    reason: None,
                    diagnostic_text: None,
                    truncated: gap,
                },
            ));
            // Failed/interrupted turns are conclusive lifecycle evidence, not successful domain results.
            result
                .unresolved_attempt_ids
                .retain(|id| id != &attempt.attempt_id);
        }
        if result
            .attempt_evidence
            .iter()
            .any(|e| e.attempt_id == attempt.attempt_id)
        {
            return Err(error(
                Code::ProtocolConflict,
                "Codex repeated matched attempt evidence in this read.",
            ));
        }
        result.attempt_evidence.push(AttemptEvidence {
            input_id: attempt.input_id.clone(),
            attempt_id: attempt.attempt_id.clone(),
            events,
        });
    }
    Ok(())
}
