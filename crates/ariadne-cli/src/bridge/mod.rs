use ariadne_agent_protocol::NormalizedEvent;
use ariadne_core::{
    AdapterContext, ClaimRequest, CoreError, CoreErrorCode, CoreService, EventReceipt,
    MutationReceipt, OwnerMutationRequest, PreparedAttempt,
};
use ariadne_domain::models::{BindingSummary, UuidV4};
use ariadne_runtime::control::{self, ControlMethod, ControlRequest, ControlResult};
use std::path::PathBuf;

/// New binding verification contacts the desktop only AFTER the owner entrypoint
/// has checked exact offline saved-connect replay. No automatic retry or new op ID.
pub fn binding_connect(
    home: PathBuf,
    request: OwnerMutationRequest,
) -> Result<MutationReceipt, CoreError> {
    let control = ControlRequest::new(
        request.command.operation_id().clone(),
        ControlMethod::BindingConnect(Box::new(request)),
    )?;
    let ControlResult::BindingConnect(receipt) = control::call_blocking(home, control)? else {
        return Err(CoreError::new(CoreErrorCode::ProtocolConflict,
            "Desktop returned another result to binding connect.",
            "Retain the original operation ID; effects may already exist. Check matching app/helper versions and its exact saved receipt."));
    };
    Ok(receipt)
}

/// Claim always contacts the desktop; there is no direct disk/core claim fallback.
pub fn claim(home: PathBuf, request: ClaimRequest) -> Result<Option<PreparedAttempt>, CoreError> {
    let request = ControlRequest::new(request.request_id.clone(), ControlMethod::Claim(request))?;
    let result = control::call_blocking(home, request)?;
    let ControlResult::Claim(prepared) = result else {
        return Err(CoreError::new(
            CoreErrorCode::ProtocolConflict,
            "Desktop returned a different result to bridge claim.",
            "Retain the claim request ID and check matching app/helper versions.",
        ));
    };
    Ok(prepared)
}
/// Read-only desktop projection; reachability alone never establishes host readiness.
pub fn connection_status(
    home: PathBuf,
    binding_id: UuidV4,
    generation: UuidV4,
    request_id: UuidV4,
) -> Result<BindingSummary, CoreError> {
    let request = ControlRequest::new(
        request_id,
        ControlMethod::ConnectionStatus(control::BindingScope {
            binding_id,
            generation,
        }),
    )?;
    let ControlResult::Status(status) = control::call_blocking(home, request)? else {
        return Err(CoreError::new(
            CoreErrorCode::ProtocolConflict,
            "Desktop returned a different result to bridge connection-status.",
            "Check matching app/helper versions; a status response does not authorize submission.",
        ));
    };
    Ok(status)
}
/// Trusted registered routing is supplied by native composition, never deserialized
/// from model JSON. No socket/lease dependency: completion survives desktop exit.
pub fn report(
    core: &dyn CoreService,
    context: AdapterContext,
    event: NormalizedEvent,
) -> Result<EventReceipt, CoreError> {
    event.validate().map_err(CoreError::from)?;
    if &event.binding_id != context.binding_id() {
        return Err(CoreError::new(
            CoreErrorCode::BindingMismatch,
            "Bridge event differs from its trusted current registered route.",
            "Resolve the registered binding and generation before reporting.",
        ));
    }
    let receipt = core
        .report(context.clone(), event.clone())
        .map_err(control::validated_error)?;
    receipt.validate_for(&context, &event)?;
    Ok(receipt)
}
pub mod command;
