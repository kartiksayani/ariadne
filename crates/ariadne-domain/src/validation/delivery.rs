//! Persisted identity and immutable prepared bytes, not fresh dispatch authority.
use super::*;
use sha2::{Digest, Sha256 as Hasher};

/// The single canonical prepared payload boundary shared with Core's wire check.
pub fn validate_prepared_payload(
    input_id: &UuidV4,
    attempt_id: &UuidV4,
    payload: &str,
    digest: &Sha256,
    marker: &str,
) -> Result<(), ValidationError> {
    text(payload, "attempts.formatted_payload", true, Some(64 * 1024))?;
    let expected = format!(
        "[ARIADNE_INPUT:{}:{}]",
        input_id.as_str(),
        attempt_id.as_str()
    );
    require(
        marker == expected
            && payload
                .split_once('\n')
                .is_some_and(|(first, _)| first == marker),
        "attempts.wire_marker",
        ValidationErrorKind::IdentityMismatch,
    )?;
    require(
        digest.as_str() == format!("{:x}", Hasher::digest(payload.as_bytes())),
        "attempts.payload_sha256",
        ValidationErrorKind::IdentityMismatch,
    )
}

pub fn validate_session_delivery(session: &Session) -> Result<(), ValidationError> {
    require(
        session.archived_at.is_none()
            || (session.state == SessionState::Closed && session.closed_at.is_some()),
        "session.archived_at/state",
        ValidationErrorKind::InvalidState,
    )?;
    let mut attempts = BTreeSet::new();
    let mut claims = BTreeSet::new();
    distinct(session.inputs.0.values().map(|i| i.seq), "inputs.seq")?;
    ahead(
        session.counters.next_input,
        session.inputs.0.values().map(|i| i.seq),
        "counters.next_input",
    )?;
    for (id, input) in &session.inputs.0 {
        require(
            id == &input.id,
            "inputs.id",
            ValidationErrorKind::IdentityMismatch,
        )?;
        require(
            session.bindings.0.contains_key(&input.binding_id),
            "inputs.binding_id",
            ValidationErrorKind::MissingReference,
        )?;
        for (index, attempt) in input.attempts.iter().enumerate() {
            require(
                attempts.insert(&attempt.id),
                "attempts.id",
                ValidationErrorKind::Duplicate,
            )?;
            require(
                claims.insert((&input.binding_id, &attempt.claim_request_id)),
                "attempts.claim_request_id",
                ValidationErrorKind::Duplicate,
            )?;
            validate_prepared_payload(
                id,
                &attempt.id,
                &attempt.formatted_payload,
                &attempt.payload_sha256,
                &attempt.wire_marker,
            )?;
            require(
                match attempt.purpose {
                    AttemptPurpose::Work => attempt.repair_for_attempt_id.is_none(),
                    AttemptPurpose::ResultRepair => attempt
                        .repair_for_attempt_id
                        .as_ref()
                        .is_some_and(|old| input.attempts[..index].iter().any(|a| &a.id == old)),
                },
                "attempts.repair_for_attempt_id",
                ValidationErrorKind::MissingReference,
            )?;
        }
        if let Some(attempt_id) = &input.active_attempt_id {
            require(
                input.attempts.iter().any(|a| &a.id == attempt_id),
                "inputs.active_attempt_id",
                ValidationErrorKind::MissingReference,
            )?;
        }
    }
    for binding in session.bindings.0.values() {
        if let Some(input_id) = &binding.active_input_id {
            require(
                session.inputs.0.get(input_id).is_some_and(|i| {
                    i.binding_id == binding.id
                        && i.active_attempt_id
                            .as_ref()
                            .is_some_and(|id| i.attempts.iter().any(|a| &a.id == id))
                }),
                "bindings.active_input_id",
                ValidationErrorKind::MissingReference,
            )?;
        }
    }
    for receipt in session.operation_receipts.0.values().flatten() {
        let (input_id, attempt_id, claim) = match &receipt.result.data {
            SavedReceiptData::Claim {
                input_id,
                attempt_id,
            } => (Some(input_id), Some(attempt_id), true),
            SavedReceiptData::DeliveryExpiry {
                input_id,
                attempt_id,
            } => (Some(input_id), Some(attempt_id), false),
            SavedReceiptData::Event {
                input_id,
                attempt_id,
                ..
            }
            | SavedReceiptData::EventConflict {
                input_id,
                attempt_id,
                ..
            } => (input_id.as_ref(), attempt_id.as_ref(), false),
            _ => continue,
        };
        require(
            input_id.is_some() == attempt_id.is_some(),
            "receipts.attempt_scope",
            ValidationErrorKind::IdentityMismatch,
        )?;
        if let (Some(input_id), Some(attempt_id)) = (input_id, attempt_id) {
            let input = session
                .inputs
                .0
                .get(input_id)
                .ok_or_else(|| ValidationError {
                    path: "receipts.input_id".into(),
                    kind: ValidationErrorKind::MissingReference,
                })?;
            let attempt = input
                .attempts
                .iter()
                .find(|a| &a.id == attempt_id)
                .ok_or_else(|| ValidationError {
                    path: "receipts.attempt_id".into(),
                    kind: ValidationErrorKind::MissingReference,
                })?;
            require(
                matches!(&receipt.actor_scope, ReceiptActorScope::Adapter { binding_id }
                    if super::input_route(session, input, binding_id)),
                "receipts.actor_scope",
                ValidationErrorKind::IdentityMismatch,
            )?;
            if claim {
                require(
                    attempt.claim_request_id == receipt.operation_id,
                    "receipts.claim_request_id",
                    ValidationErrorKind::IdentityMismatch,
                )?;
            }
        }
    }
    Ok(())
}
