use super::{error::core, DeliveryError, DeliveryService};
use crate::*;
use ariadne_domain::models::*;
use ariadne_store::session::TransactionError;
use sha2::{Digest, Sha256 as Hasher};

enum ClaimFailure {
    Empty,
    Core(CoreError),
}
impl From<CoreError> for ClaimFailure {
    fn from(e: CoreError) -> Self {
        Self::Core(e)
    }
}
impl DeliveryService<'_> {
    /// The context asserts an actual native lease; Core rereads persisted guards.
    /// Exact request replay is recovered before generation/dispatch/queue checks.
    pub fn claim(
        &self,
        context: &ValidatedDispatchContext,
        request: &ClaimRequest,
        mut allocate: impl FnMut() -> UuidV4,
        at: UtcMillis,
    ) -> Result<Option<PreparedAttempt>, DeliveryError> {
        if context.binding_id() != &request.binding_id {
            return Err(core(
                CoreErrorCode::BindingMismatch,
                "Claim request differs from its trusted binding route",
            )
            .into());
        }
        let store = self.store(context.session())?;
        let normalized = crate::receipts::normalized(
            "claim",
            &serde_json::json!({"binding_id":request.binding_id,"generation":request.generation}),
        )?;
        let saved = store.transact(
            context.session().session_id(),
            &ReceiptActorScope::Adapter {
                binding_id: request.binding_id.clone(),
            },
            &request.request_id,
            &normalized,
            |session| {
                let binding = session.bindings.0.get(&request.binding_id).ok_or_else(|| {
                    core(CoreErrorCode::BindingMismatch, "Claim binding is missing")
                })?;
                if session.active_binding_id.as_ref() != Some(&request.binding_id) {
                    return Err(core(
                        CoreErrorCode::BindingMismatch,
                        "Claim binding is not selected",
                    )
                    .into());
                }
                if &binding.generation != context.generation()
                    || binding.generation != request.generation
                {
                    return Err(
                        core(CoreErrorCode::StaleGeneration, "Claim generation changed").into(),
                    );
                }
                if session.state != SessionState::Active || session.archived_at.is_some() {
                    return Err(barrier(
                        session,
                        &request.binding_id,
                        CoreErrorCode::InvalidTransition,
                        if session.archived_at.is_some() {
                            "The owner archived this session; restore it, then reopen it to resume sending"
                        } else {
                            "The owner closed this session; reopening it resumes dispatch"
                        },
                        BarrierReason::SessionClosed,
                    )
                    .into());
                }
                if binding.connection_state != ConnectionState::Connected {
                    return Err(barrier(
                        session,
                        &request.binding_id,
                        CoreErrorCode::HostUnreachable,
                        "Claim requires a verified connected binding",
                        BarrierReason::Disconnected,
                    )
                    .into());
                }
                if binding.dispatch_state != DispatchState::Enabled
                    || binding.owner_paused
                    || binding.pause_reason.is_some()
                {
                    return Err(barrier(
                        session,
                        &request.binding_id,
                        CoreErrorCode::InvalidTransition,
                        "Claim is blocked by owner pause or recovery",
                        if binding.owner_paused {
                            BarrierReason::OwnerPaused
                        } else {
                            BarrierReason::RecoveryRequired
                        },
                    )
                    .into());
                }
                if session.inputs.0.values().any(|i| {
                    i.binding_id == request.binding_id && i.state == InputState::NeedsAttention
                }) {
                    return Err(barrier(
                        session,
                        &request.binding_id,
                        CoreErrorCode::InvalidTransition,
                        "An earlier input requires recovery",
                        BarrierReason::RecoveryRequired,
                    )
                    .into());
                }
                if binding.active_input_id.is_some()
                    || session.inputs.0.values().any(|i| {
                        i.binding_id == request.binding_id && i.state == InputState::InFlight
                    })
                {
                    return Err(ClaimFailure::Empty);
                }
                let Some(input) = session
                    .inputs
                    .0
                    .values()
                    .filter(|i| {
                        i.binding_id == request.binding_id
                            && i.state == InputState::Queued
                            && !super::held_for_review(session, i)
                            // Archive cancels its topic's inputs; never deliver
                            // one for an archived topic regardless.
                            && session
                                .topics
                                .0
                                .get(&i.target.topic_id)
                                .is_none_or(|topic| topic.archived_at.is_none())
                    })
                    .min_by_key(|i| i.seq)
                    .cloned()
                else {
                    return Err(ClaimFailure::Empty);
                };
                if input.active_attempt_id.is_some()
                    || input.attempts.iter().any(|a| a.sealed_at.is_none())
                {
                    return Err(core(
                        CoreErrorCode::InvalidTransition,
                        "Queued input retains an unresolved prepared attempt",
                    )
                    .into());
                }
                let repair = input
                    .resolution_history
                    .iter()
                    .rev()
                    .find(|entry| {
                        input
                            .attempts
                            .last()
                            .is_some_and(|a| entry.attempt_id == a.id)
                            && matches!(
                                entry.kind,
                                ResolutionKind::RetryUnexecuted
                                    | ResolutionKind::Resend
                                    | ResolutionKind::RequestResultRepair
                            )
                    })
                    .map(|entry| {
                        let selected = input.attempts.last().expect("matched retained attempt");
                        if entry.kind == ResolutionKind::RequestResultRepair {
                            crate::recovery::original_work(&input, &entry.attempt_id).map(Some)
                        } else if selected.purpose == AttemptPurpose::ResultRepair {
                            let original =
                                selected.repair_for_attempt_id.as_ref().ok_or_else(|| {
                                    core(
                                        CoreErrorCode::InvalidRef,
                                        "Repair preparation lost original work",
                                    )
                                })?;
                            crate::recovery::original_work(&input, original).map(Some)
                        } else {
                            Ok(None)
                        }
                    })
                    .transpose()?
                    .flatten();
                // Capacity and reference failures must precede id allocation. A
                // UUID-length stand-in sizes the attempt id the real body will carry.
                if let Some(original) = repair {
                    super::format::repair_body(session, &input, original, &input.id)?;
                } else {
                    super::format::body(session, &input, &input.id)?;
                }
                let attempt_id = allocate();
                if occupied(session, &attempt_id) {
                    return Err(core(
                        CoreErrorCode::InvalidArgument,
                        "Native attempt UUID allocation reused a saved identity",
                    )
                    .into());
                }
                let body = if let Some(original) = repair {
                    super::format::repair_body(session, &input, original, &attempt_id)?
                } else {
                    super::format::body(session, &input, &attempt_id)?
                };
                let wire_marker = format!(
                    "[ARIADNE_INPUT:{}:{}]",
                    input.id.as_str(),
                    attempt_id.as_str()
                );
                let formatted_payload = format!("{wire_marker}\n{body}");
                let payload_sha256 = Sha256::new(format!(
                    "{:x}",
                    Hasher::digest(formatted_payload.as_bytes())
                ))
                .expect("digest");
                let number = session
                    .messages
                    .iter()
                    .find(|m| m.id == input.message_id)
                    .expect("formatted owner")
                    .number;
                let attempt = Attempt {
                    id: attempt_id.clone(),
                    purpose: if repair.is_some() {
                        AttemptPurpose::ResultRepair
                    } else {
                        AttemptPurpose::Work
                    },
                    repair_for_attempt_id: repair.map(|a| a.id.clone()),
                    claim_request_id: request.request_id.clone(),
                    binding_generation: request.generation.clone(),
                    prepared_at: at.clone(),
                    formatted_payload,
                    payload_sha256,
                    wire_marker,
                    acceptance: AcceptanceState::Prepared,
                    acceptance_receipt: None,
                    acceptance_observed_at: None,
                    host_turn_id: None,
                    turn_state: TurnState::Unknown,
                    turn_observed_at: None,
                    domain_result: None,
                    result_state: ResultState::Pending,
                    sealed_at: None,
                    error: None,
                    reconciliation_checkpoint: None,
                };
                let stored = session.inputs.0.get_mut(&input.id).expect("selected input");
                stored.attempts.push(attempt);
                stored.active_attempt_id = Some(attempt_id.clone());
                stored.state = InputState::InFlight;
                let binding = session
                    .bindings
                    .0
                    .get_mut(&request.binding_id)
                    .expect("validated binding");
                binding.active_input_id = Some(input.id.clone());
                binding.issued_through_message_number = binding.issued_through_message_number.max(
                    NonnegativeSafeInteger::new(number.value()).expect("positive safe number"),
                );
                session.updated_at = at.clone();
                Ok(SavedReceiptData::Claim {
                    input_id: input.id,
                    attempt_id,
                })
            },
        );
        let receipt = match saved {
            Ok(saved) => saved,
            Err(TransactionError::Command(ClaimFailure::Empty)) => return Ok(None),
            Err(TransactionError::Command(ClaimFailure::Core(e))) => return Err(e.into()),
            Err(TransactionError::Store(e)) => return Err(e.into()),
        };
        let SavedReceiptData::Claim {
            input_id,
            attempt_id,
        } = receipt.data
        else {
            return Err(core(
                CoreErrorCode::OperationReused,
                "Claim operation does not contain a claim receipt",
            )
            .into());
        };
        let live = store.read(context.session().session_id())?;
        let attempt = live
            .inputs
            .0
            .get(&input_id)
            .and_then(|i| i.attempts.iter().find(|a| a.id == attempt_id))
            .ok_or_else(|| {
                core(
                    CoreErrorCode::InvalidRef,
                    "Saved claim no longer identifies its retained attempt",
                )
            })?;
        let prepared = PreparedAttempt {
            input_id,
            attempt_id,
            binding_generation: attempt.binding_generation.clone(),
            formatted_payload: attempt.formatted_payload.clone(),
            payload_sha256: attempt.payload_sha256.clone(),
            wire_marker: attempt.wire_marker.clone(),
        };
        prepared.validate_for(request)?;
        Ok(Some(prepared))
    }
}

fn occupied(session: &Session, id: &UuidV4) -> bool {
    &session.id == id
        || &session.project_id == id
        || session.bindings.0.contains_key(id)
        || session.inputs.0.contains_key(id)
        || session.topics.0.contains_key(id)
        || session.rounds.0.contains_key(id)
        || session.messages.iter().any(|m| &m.id == id)
        || session.answers.iter().any(|a| &a.id == id)
        || session
            .inputs
            .0
            .values()
            .any(|i| i.attempts.iter().any(|a| &a.id == id))
}
fn barrier(
    session: &Session,
    binding_id: &UuidV4,
    code: CoreErrorCode,
    message: &str,
    reason: BarrierReason,
) -> CoreError {
    let mut e = core(code, message);
    e.current_revision = Some(session.revision);
    e.details = Some(Box::new(ErrorDetails {
        reason: Some(reason),
        binding_id: Some(binding_id.clone()),
        input_id: session.bindings.0[binding_id].active_input_id.clone(),
        attempt_id: None,
        blocking_item_ids: vec![],
        blocking_input_ids: session
            .inputs
            .0
            .values()
            .filter(|i| &i.binding_id == binding_id && i.state == InputState::NeedsAttention)
            .map(|i| i.id.clone())
            .collect(),
        dispatch_must_pause: true,
        partial_removal: None,
        connected_session_name: None,
    }));
    e
}
