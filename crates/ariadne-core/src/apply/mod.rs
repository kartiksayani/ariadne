//! Atomic ordered agent commands; Store owns replay, session revision and publication.
mod batch;
mod error;
mod result;
mod scope;
use crate::*;
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
pub use error::ApplyError;

pub struct ApplyService<'a> {
    registry: &'a Registry,
}
impl<'a> ApplyService<'a> {
    pub fn new(registry: &'a Registry) -> Self {
        Self { registry }
    }
    /// Native composition resolves routing and supplies fresh IDs/time. No host IO.
    pub fn execute(
        &self,
        context: &AgentContext,
        request: &ApplyRequest,
        mut allocate: impl FnMut() -> UuidV4,
        at: UtcMillis,
    ) -> Result<ApplyReceipt, ApplyError> {
        request.validate_wire()?;
        let mut params = serde_json::to_value(request).map_err(|_| {
            error::core(
                CoreErrorCode::InvalidArgument,
                "Cannot normalize typed apply request",
            )
        })?;
        params
            .as_object_mut()
            .expect("typed request object")
            .remove("op_id");
        let intent = crate::receipts::normalized("apply", &params)?;
        let route = context.session();
        let project = self.registry.resolve_project(route.project_id())?;
        let store = Store::open_registered(&project.root, project.project_id)?;
        let receipt = store.transact(
            route.session_id(),
            &ReceiptActorScope::Agent {
                binding_id: context.binding_id().clone(),
            },
            &request.op_id,
            &intent,
            |session| batch::execute(session, context, request, &mut allocate, &at),
        )?;
        validate_apply_receipt(&receipt, context, request)?;
        Ok(receipt)
    }
}
