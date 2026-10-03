use ariadne_agent_protocol::NormalizedEvent;
use ariadne_core::{
    AdapterContext, ClaimRequest, CoreError, CoreErrorCode, CoreService, EventReceipt,
    PreparedAttempt,
};
use ariadne_runtime::control::{self, ControlMethod, ControlRequest, ControlResult};
use std::path::PathBuf;

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
    let receipt = core.report(context.clone(), event.clone())?;
    receipt.validate_for(&context, &event)?;
    Ok(receipt)
}
pub mod command;
