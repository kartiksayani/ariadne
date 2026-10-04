//! Native request-local provider handoff; the public CoreService stays unchanged.
use super::*;
use std::time::Instant;

impl NativeCoreService {
    /// Preserves canonical bootstrap validation and exact replay before provider
    /// verification or deadline checks. The callback may retain an owned reader
    /// in its caller's stack; it runs outside Registry/Store locks.
    pub fn connect_before(
        &self,
        context: OwnerContext,
        command: OwnerCommand,
        deadline: Instant,
        verify: impl FnOnce(&BindingConnectParams, Instant) -> Result<VerifiedHost, CoreError>,
    ) -> Result<MutationReceipt, CoreError> {
        command.validate_wire()?;
        BindingService::new(&self.registry)
            .connect_guarded(
                &context,
                &command,
                |params| {
                    within(deadline)?;
                    let host = verify(params, deadline)?;
                    within(deadline)?;
                    Ok(host)
                },
                || (self.allocate)(),
                (self.now)(),
                || within(deadline),
            )
            .map_err(errors::binding)
    }
}
fn within(deadline: Instant) -> Result<(), CoreError> {
    if Instant::now() >= deadline {
        return Err(CoreError::new(CoreErrorCode::HostUnreachable,
            "Native binding setup exceeded its original admission deadline.",
            "Retain the original operation ID and parameters; check its exact saved receipt before repeating setup."));
    }
    Ok(())
}
