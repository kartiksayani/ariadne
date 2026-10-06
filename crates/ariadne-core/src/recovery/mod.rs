//! Explicit owner recovery decisions; no host IO, send or inferred liveness.
mod error;
pub use error::RecoveryError;

use crate::*;
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};

/// Trusted native scope for a provider-qualified observation. Never wire data.
#[derive(Debug, Clone)]
pub struct RecoveryObservation {
    pub binding_id: UuidV4,
    pub instance_id: UuidV4,
    pub observation: PresenceObservation,
}

pub struct RecoveryService<'a> {
    registry: &'a Registry,
}
impl<'a> RecoveryService<'a> {
    pub fn new(registry: &'a Registry) -> Self {
        Self { registry }
    }

    /// `presence` is an optional qualified observation from trusted native wiring,
    /// never a serialized owner assertion. None means unknown. Replay precedes
    /// liveness/revision checks; a prior attestation is never reused as current.
    pub fn execute(
        &self,
        context: &OwnerContext,
        command: &OwnerCommand,
        presence: Option<&RecoveryObservation>,
        at: UtcMillis,
    ) -> Result<MutationReceipt, RecoveryError> {
        let OwnerScope::Session(route) = context.scope() else {
            return Err(core(
                CoreErrorCode::PermissionDenied,
                "Recovery requires a registered owner session",
            )
            .into());
        };
        OwnerMutationRequest {
            session: Some(SessionRef {
                project_id: route.project_id().clone(),
                session_id: route.session_id().clone(),
            }),
            command: command.clone(),
        }
        .validate_wire()?;
        let OwnerCommand::InputResolve { params, .. } = command else {
            return Err(core(CoreErrorCode::InvalidArgument, "Expected input_resolve").into());
        };
        let normalized = crate::receipts::normalized("input_resolve", params)?;
        let project = self.registry.resolve_project(route.project_id())?;
        let store = Store::open_registered(
            &self.registry.project_dir(&project.project_id),
            project.project_id,
        )?;
        let receipt = store.transact(
            route.session_id(),
            &ReceiptActorScope::Owner {},
            command.operation_id(),
            &normalized,
            |session| resolve(session, params, command.operation_id(), presence, &at),
        )?;
        Ok(MutationReceipt::Session(Box::new(receipt)))
    }
}

fn resolve(
    session: &mut Session,
    params: &InputResolveParams,
    operation_id: &UuidV4,
    presence: Option<&RecoveryObservation>,
    at: &UtcMillis,
) -> Result<SavedReceiptData, CoreError> {
    if session.revision != params.expected_revision {
        let mut e = core(
            CoreErrorCode::RevisionConflict,
            "The recovery snapshot changed",
        );
        e.current_revision = Some(session.revision);
        return Err(e);
    }
    let input = session
        .inputs
        .0
        .get(&params.input_id)
        .ok_or_else(|| core(CoreErrorCode::NotFound, "Recovery input is missing"))?;
    let binding = session.bindings.0.get(&input.binding_id).ok_or_else(|| {
        core(
            CoreErrorCode::BindingMismatch,
            "Recovery binding is missing",
        )
    })?;
    if session.active_binding_id.as_ref() != Some(&input.binding_id) {
        return Err(core(
            CoreErrorCode::BindingMismatch,
            "Recovery input does not belong to the selected binding",
        ));
    }
    let index = input
        .attempts
        .iter()
        .position(|a| a.id == params.attempt_id)
        .ok_or_else(|| {
            core(
                CoreErrorCode::InvalidRef,
                "Recovery attempt does not belong to this input",
            )
        })?;
    let attempt = &input.attempts[index];
    let idle = current_idle(binding, presence)?;
    if !idle
        && !params
            .evidence
            .as_ref()
            .is_some_and(|e| e.owner_attested_idle)
    {
        return Err(core(CoreErrorCode::DeliveryUncertain, "Current host liveness is unknown; explicitly attest that the terminal is stopped or idle"));
    }
    if params.decision == ResolutionKind::ConfirmEvidence {
        if params.evidence.is_none() {
            return Err(core(
                CoreErrorCode::InvalidArgument,
                "Confirm evidence requires explicitly attributed owner evidence",
            ));
        }
    } else {
        if session.state != SessionState::Active
            || input.active_attempt_id.as_ref() != Some(&params.attempt_id)
            || binding.active_input_id.as_ref() != Some(&input.id)
            || attempt.sealed_at.is_some()
            || !matches!(
                input.state,
                InputState::InFlight | InputState::NeedsAttention
            )
        {
            return Err(core(
                CoreErrorCode::InvalidTransition,
                "Resolve the current unsealed input/attempt of an active session",
            ));
        }
        match params.decision {
            ResolutionKind::RetryUnexecuted => {
                if attempt.acceptance != AcceptanceState::Rejected
                    || attempt.acceptance_receipt.is_some()
                    || attempt.host_turn_id.is_some()
                    || attempt.turn_state != TurnState::Unknown
                    || attempt.domain_result.is_some()
                    || contradictory(session, &input.binding_id, &input.id, &attempt.id)
                {
                    return Err(core(CoreErrorCode::DeliveryUncertain, "Prepare retry requires proven rejection before any execution or result; review Resend explicitly for uncertainty"));
                }
            }
            ResolutionKind::RequestResultRepair => {
                if attempt.turn_state != TurnState::Completed
                    || attempt.domain_result.is_some()
                    || attempt.result_state == ResultState::Committed
                {
                    return Err(core(
                        CoreErrorCode::InvalidTransition,
                        "Result repair requires actually completed work without a committed result",
                    ));
                }
                original_work(input, &params.attempt_id)?;
            }
            ResolutionKind::Resend | ResolutionKind::Skip => {}
            ResolutionKind::ConfirmEvidence => unreachable!("attribution handled above"),
        }
    }
    let binding_id = input.binding_id.clone();
    let clear = params.decision != ResolutionKind::ConfirmEvidence
        && resolved_reason(session, input, attempt, binding)
        && conflicts_acknowledged(session, &binding_id, params);
    let input = session
        .inputs
        .0
        .get_mut(&params.input_id)
        .expect("validated input");
    input.resolution_history.push(ResolutionHistoryEntry {
        op_id: operation_id.clone(),
        kind: params.decision.clone(),
        reason: params.reason.clone(),
        at: at.clone(),
        attempt_id: params.attempt_id.clone(),
        evidence: params.evidence.clone(),
    });
    if params.decision != ResolutionKind::ConfirmEvidence {
        input.attempts[index].sealed_at = Some(at.clone());
        input.active_attempt_id = None;
        input.state = if params.decision == ResolutionKind::Skip {
            InputState::Skipped
        } else {
            InputState::Queued
        };
        let binding = session
            .bindings
            .0
            .get_mut(&binding_id)
            .expect("validated binding");
        binding.active_input_id = None;
        binding.owner_paused = true;
        if clear {
            binding.pause_reason = None;
        }
        binding.dispatch_state = DispatchState::Paused;
    }
    if params.decision == ResolutionKind::ConfirmEvidence {
        let binding = &session.bindings.0[&binding_id];
        let safe = binding.pause_reason == Some(PauseReason::Uncertain)
            && !unresolved(session, &binding_id)
            && conflicts_acknowledged(session, &binding_id, params)
            && session.operation_receipts.0.values().flatten().any(|r| {
                matches!(&r.actor_scope,ReceiptActorScope::Adapter{binding_id:b} if b==&binding_id)
                    && matches!(&r.result.data,SavedReceiptData::EventConflict{input_id:Some(i),attempt_id:Some(a),..} if i==&params.input_id && a==&params.attempt_id)
            });
        if safe {
            let binding = session.bindings.0.get_mut(&binding_id).expect("validated");
            binding.pause_reason = None;
            binding.owner_paused = true;
            binding.dispatch_state = DispatchState::Paused;
        }
    }
    session.updated_at = at.clone();
    Ok(SavedReceiptData::InputResolve {
        input_id: params.input_id.clone(),
        attempt_id: params.attempt_id.clone(),
        resolution_kind: params.decision.clone(),
        state: session.inputs.0[&params.input_id].state.clone(),
    })
}

fn current_idle(
    binding: &Binding,
    presence: Option<&RecoveryObservation>,
) -> Result<bool, CoreError> {
    let Some(trusted) = presence else {
        return Ok(false);
    };
    let p = &trusted.observation;
    if trusted.binding_id != binding.id
        || trusted.instance_id != p.instance_id
        || p.generation != binding.generation
        || p.freshness != Freshness::Fresh
        || p.last_seen_at.is_none()
        || !matches!(
            p.source,
            Some(
                PresenceSource::BridgeHeartbeat
                    | PresenceSource::HostPoll
                    | PresenceSource::HostEvent
            )
        )
    {
        return Ok(false);
    }
    if matches!(
        p.execution_state,
        ExecutionState::Running | ExecutionState::WaitingForApproval
    ) {
        return Err(core(CoreErrorCode::InvalidTransition, "The host is currently observed running or waiting for approval; interrupt it in the terminal before recovery"));
    }
    Ok(p.execution_state == ExecutionState::Idle
        && p.connection_state == ConnectionState::Connected)
}

fn contradictory(session: &Session, binding: &UuidV4, input: &UuidV4, attempt: &UuidV4) -> bool {
    session.operation_receipts.0.values().flatten().any(|r| {
        matches!(&r.actor_scope, ReceiptActorScope::Adapter {binding_id} if binding_id == binding)
            && matches!(&r.result.data, SavedReceiptData::EventConflict {input_id:Some(i),attempt_id:Some(a),..} if i==input && a==attempt)
    })
}
fn unresolved(session: &Session, binding: &UuidV4) -> bool {
    session.bindings.0[binding].active_input_id.is_some()
        || session.inputs.0.values().any(|i| {
            &i.binding_id == binding
                && (matches!(i.state, InputState::InFlight | InputState::NeedsAttention)
                    || i.attempts.iter().any(|a| a.sealed_at.is_none()))
        })
}
// Read retained typed receipts and attribution instead of adding another index.
fn conflicts_acknowledged(
    session: &Session,
    binding: &UuidV4,
    pending: &InputResolveParams,
) -> bool {
    session.operation_receipts.0.values().flatten().filter(|r| matches!(&r.actor_scope,ReceiptActorScope::Adapter{binding_id:b} if b==binding))
        .all(|conflict| {
            let SavedReceiptData::EventConflict{input_id,attempt_id,..} = &conflict.result.data else { return true; };
            let (Some(i),Some(a)) = (input_id,attempt_id) else { return false; };
            if i==&pending.input_id && a==&pending.attempt_id && conflict.result.revision<=pending.expected_revision { return true; }
            let Some(input) = session.inputs.0.get(i) else { return false; };
            input.resolution_history.iter().any(|entry| &entry.attempt_id==a && session.operation_receipts.0.get(&entry.op_id).is_some_and(|bucket| {
                bucket.iter().any(|receipt| receipt.actor_scope==ReceiptActorScope::Owner{} && receipt.result.revision>conflict.result.revision
                    && matches!(&receipt.result.data,SavedReceiptData::InputResolve{input_id,attempt_id,resolution_kind,..} if input_id==i && attempt_id==a && resolution_kind==&entry.kind))
            }))
        })
}

fn resolved_reason(session: &Session, input: &Input, attempt: &Attempt, binding: &Binding) -> bool {
    if session.inputs.0.values().any(|other| {
        other.id != input.id
            && other.binding_id == binding.id
            && matches!(
                other.state,
                InputState::InFlight | InputState::NeedsAttention
            )
    }) {
        return false;
    }
    // Binding-only contradictions cannot be discharged by another input's resolution.
    if session.operation_receipts.0.values().flatten().any(|r| {
        matches!(&r.actor_scope,ReceiptActorScope::Adapter{binding_id} if binding_id==&binding.id)
            && matches!(
                &r.result.data,
                SavedReceiptData::EventConflict { input_id: None, .. }
            )
    }) {
        return false;
    }
    match binding.pause_reason {
        Some(PauseReason::ResultMissing) => attempt.result_state == ResultState::Missing,
        Some(PauseReason::HostFailure) => matches!(
            attempt.turn_state,
            TurnState::Failed | TurnState::Interrupted
        ),
        Some(PauseReason::Uncertain) => {
            matches!(
                attempt.acceptance,
                AcceptanceState::Rejected | AcceptanceState::Uncertain
            ) || attempt
                .error
                .as_ref()
                .is_some_and(|e| e.code != "result_missing")
                || contradictory(session, &binding.id, &input.id, &attempt.id)
        }
        _ => false,
    }
}

/// Repair lineage is bounded by retained attempts and flattened to original Work.
pub(crate) fn original_work<'a>(
    input: &'a Input,
    selected: &UuidV4,
) -> Result<&'a Attempt, CoreError> {
    let mut id = selected;
    for _ in 0..input.attempts.len() {
        let a = input
            .attempts
            .iter()
            .find(|a| &a.id == id)
            .ok_or_else(|| core(CoreErrorCode::InvalidRef, "Repair lineage is missing"))?;
        if a.turn_state != TurnState::Completed {
            return Err(core(
                CoreErrorCode::InvalidTransition,
                "Repair lineage must retain actually completed attempts",
            ));
        }
        if a.purpose == AttemptPurpose::Work {
            if a.repair_for_attempt_id.is_some() {
                break;
            }
            return Ok(a);
        }
        let Some(prior) = a.repair_for_attempt_id.as_ref() else {
            break;
        };
        let here = input
            .attempts
            .iter()
            .position(|b| b.id == a.id)
            .expect("retained");
        if !input.attempts[..here].iter().any(|b| &b.id == prior) {
            break;
        }
        id = prior;
    }
    Err(core(
        CoreErrorCode::InvalidRef,
        "Repair lineage is cyclic or inconsistent",
    ))
}
fn core(code: CoreErrorCode, message: &str) -> CoreError {
    CoreError::new(code,message,"Inspect the exact input/attempt and prior effects. Keep the same operation ID on retry; recovery never sends or resumes automatically.")
}
