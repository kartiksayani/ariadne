//! Atomic ordered agent commands; Store owns replay, session revision and publication.
mod batch;
mod error;
mod result;
mod scope;
mod summary;
use crate::*;
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
pub use error::ApplyError;
pub use summary::{summarize, ApplySummary, ItemChange, TopicChange};

pub struct ApplyService<'a> {
    registry: &'a Registry,
}

/// What `ApplyService::preview` found, with nothing committed.
#[derive(Debug)]
pub struct ApplyPreview {
    pub receipt: ApplyReceipt,
    /// The candidate session the commit would write.
    pub session: Session,
    /// The operation ID was already committed with these exact bytes.
    pub replayed: bool,
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
        allocate: impl FnMut() -> UuidV4,
        at: UtcMillis,
    ) -> Result<ApplyReceipt, ApplyError> {
        self.execute_noting_replay(context, request, allocate, at)
            .map(|(receipt, _)| receipt)
    }
    /// `execute`, also saying whether the core replayed an earlier commit of the
    /// same operation ID and request instead of applying anything.
    pub fn execute_noting_replay(
        &self,
        context: &AgentContext,
        request: &ApplyRequest,
        mut allocate: impl FnMut() -> UuidV4,
        at: UtcMillis,
    ) -> Result<(ApplyReceipt, bool), ApplyError> {
        let (store, intent) = self.open(context, request)?;
        let (receipt, replayed) = store.transact_noting_replay(
            context.session().session_id(),
            &ReceiptActorScope::Agent {
                binding_id: context.binding_id().clone(),
            },
            &request.op_id,
            &intent,
            |session| batch::execute(session, context, request, &mut allocate, &at),
        )?;
        validate_apply_receipt(&receipt, context, request)?;
        Ok((receipt, replayed))
    }
    /// Validate-only `execute`: the same wire checks, replay lookup, current-state
    /// guards, batch and candidate validation, with nothing written. Fresh IDs
    /// come from `allocate` and are discarded.
    pub fn preview(
        &self,
        context: &AgentContext,
        request: &ApplyRequest,
        mut allocate: impl FnMut() -> UuidV4,
        at: UtcMillis,
    ) -> Result<ApplyPreview, ApplyError> {
        let (store, intent) = self.open(context, request)?;
        let staged = store.preview(
            context.session().session_id(),
            &ReceiptActorScope::Agent {
                binding_id: context.binding_id().clone(),
            },
            &request.op_id,
            &intent,
            |session| batch::execute(session, context, request, &mut allocate, &at),
        )?;
        validate_apply_receipt(&staged.receipt, context, request)?;
        Ok(ApplyPreview {
            receipt: staged.receipt,
            session: staged.session,
            replayed: staged.replayed,
        })
    }
    /// The compact view of a saved apply receipt, with labels read from the
    /// session as it is now.
    pub fn summary(
        &self,
        context: &AgentContext,
        receipt: &ApplyReceipt,
    ) -> Result<ApplySummary, ApplyError> {
        let route = context.session();
        let project = self.registry.resolve_project(route.project_id())?;
        let store = Store::open_registered(
            &self.registry.project_dir(&project.project_id),
            project.project_id,
        )?;
        let session = store.read(route.session_id())?;
        Ok(summarize(&session, receipt)?)
    }
    fn open(
        &self,
        context: &AgentContext,
        request: &ApplyRequest,
    ) -> Result<(Store, serde_json::Value), ApplyError> {
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
        let store = Store::open_registered(
            &self.registry.project_dir(&project.project_id),
            project.project_id,
        )?;
        Ok((store, intent))
    }
}
