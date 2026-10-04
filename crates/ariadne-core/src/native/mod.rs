//! Concrete synchronous delegates. Entrypoints retain responsibility for trusted
//! routes, provider qualification, actual leases, scheduler ticks and UI hints.
mod agent;
mod connection;
pub use agent::AgentResolver;
mod errors;
mod preferences;
pub use preferences::PreferencesService;

use crate::{
    apply::ApplyService,
    bindings::{BindingService, VerifiedHost},
    delivery::DeliveryService,
    history_actions::HistoryActionService,
    inputs::InputService,
    queries::QueryService,
    recovery::RecoveryService,
    *,
};
use ariadne_domain::models::*;
use ariadne_store::registry::Registry;
use std::sync::Arc;

type Verify = dyn Fn(&BindingConnectParams) -> Result<VerifiedHost, CoreError> + Send + Sync;

pub struct NativeCoreService {
    registry: Registry,
    allocate: Arc<dyn Fn() -> UuidV4 + Send + Sync>,
    now: Arc<dyn Fn() -> UtcMillis + Send + Sync>,
    verify: Arc<Verify>,
}
impl NativeCoreService {
    /// All callbacks are native dependencies. IDs/time must be local, bounded
    /// and nonblocking. Host verification is read-only and runs outside locks.
    /// No default provider facts, placeholder IDs or active connection are made.
    pub fn new(
        registry: Registry,
        allocate: impl Fn() -> UuidV4 + Send + Sync + 'static,
        now: impl Fn() -> UtcMillis + Send + Sync + 'static,
        verify: impl Fn(&BindingConnectParams) -> Result<VerifiedHost, CoreError>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        Self {
            registry,
            allocate: Arc::new(allocate),
            now: Arc::new(now),
            verify: Arc::new(verify),
        }
    }

    pub fn registry(&self) -> &Registry {
        &self.registry
    }

    /// Resolve only registered project/session membership. Mutation eligibility,
    /// current binding selection and replay guards remain inside the core call.
    pub fn resolve_session(&self, route: &SessionRef) -> Result<RegisteredSession, CoreError> {
        let project = self
            .registry
            .resolve_project(&route.project_id)
            .map_err(errors::registry)?;
        let session = ariadne_store::session::Store::read_registered(
            &project.root,
            &route.project_id,
            &route.session_id,
        )
        .map_err(errors::store)?;
        Ok(RegisteredSession::from_trusted_entrypoint(
            session.project_id,
            session.id,
        ))
    }

    /// Explicit native scheduler call, outside UI and all between-tick locks.
    /// This does not start a timer or invent an adapter lifecycle event.
    pub fn expire_missing_result(
        &self,
        context: &AdapterContext,
        input_id: &UuidV4,
        attempt_id: &UuidV4,
        operation_id: &UuidV4,
    ) -> Result<Option<SavedReceipt>, CoreError> {
        DeliveryService::new(&self.registry)
            .expire_missing_result(context, input_id, attempt_id, operation_id, (self.now)())
            .map_err(errors::delivery)
    }
}

impl CoreService for NativeCoreService {
    fn query(
        &self,
        context: QueryContext,
        request: QueryRequest,
    ) -> Result<QueryResult, CoreError> {
        request.validate_wire(&context)?;
        if matches!(request, QueryRequest::PreferencesGet {}) {
            let QueryVisibility::Owner(owner) = context.visibility() else {
                return Err(errors::local(
                    CoreErrorCode::PermissionDenied,
                    "Preferences are owner-only",
                ));
            };
            return PreferencesService::new(&self.registry)
                .get(owner)
                .map(QueryResult::PreferencesGet);
        }
        if let QueryRequest::TopicContinuePreview(request) = &request {
            let QueryVisibility::Owner(owner) = context.visibility() else {
                return Err(errors::local(
                    CoreErrorCode::PermissionDenied,
                    "Continuation preview is owner-only",
                ));
            };
            let target_owner;
            let owner = if matches!(owner.scope(), OwnerScope::Registry) {
                target_owner = OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
                    self.resolve_session(&request.target)?,
                ));
                &target_owner
            } else {
                owner
            };
            return HistoryActionService::new(&self.registry)
                .preview(owner, request)
                .map(QueryResult::TopicContinuePreview)
                .map_err(errors::history);
        }
        QueryService::new(&self.registry)
            .query(&context, &request)
            .map_err(errors::query)
    }

    fn execute_owner(
        &self,
        context: OwnerContext,
        command: OwnerCommand,
    ) -> Result<MutationReceipt, CoreError> {
        command.validate_wire()?;
        match &command {
            OwnerCommand::ProjectRegister { .. } => BindingService::new(&self.registry)
                .register(&context, &command, || (self.allocate)())
                .map_err(errors::binding),
            OwnerCommand::BindingConnect { .. } => BindingService::new(&self.registry)
                .connect(
                    &context,
                    &command,
                    |params| (self.verify)(params),
                    || (self.allocate)(),
                    (self.now)(),
                )
                .map_err(errors::binding),
            OwnerCommand::BindingPause { .. }
            | OwnerCommand::BindingResume { .. }
            | OwnerCommand::BindingDisconnect { .. } => BindingService::new(&self.registry)
                .state(&context, &command, (self.now)())
                .map_err(errors::binding),
            OwnerCommand::InputSubmit { .. } | OwnerCommand::InputCancel { .. } => {
                InputService::new(&self.registry)
                    .execute(&context, &command, || (self.allocate)(), (self.now)())
                    .map_err(errors::input)
            }
            OwnerCommand::InputResolve { .. } => RecoveryService::new(&self.registry)
                .execute(&context, &command, None, (self.now)())
                .map_err(errors::recovery),
            OwnerCommand::TopicArchive { .. }
            | OwnerCommand::TopicRestore { .. }
            | OwnerCommand::SessionClose { .. }
            | OwnerCommand::SessionReopen { .. } => HistoryActionService::new(&self.registry)
                .execute(&context, &command, (self.now)())
                .map_err(errors::history),
            OwnerCommand::TopicContinue { .. } => HistoryActionService::new(&self.registry)
                .continue_topic(&context, &command, || (self.allocate)(), (self.now)())
                .map_err(errors::history),
            OwnerCommand::PreferencesPatch { .. } => PreferencesService::new(&self.registry)
                .patch(&context, &command)
                .map(MutationReceipt::PreferencesPatched),
        }
    }

    fn apply(
        &self,
        context: AgentContext,
        request: ApplyRequest,
    ) -> Result<ApplyReceipt, CoreError> {
        ApplyService::new(&self.registry)
            .execute(&context, &request, || (self.allocate)(), (self.now)())
            .map_err(errors::apply)
    }

    fn claim(
        &self,
        context: ValidatedDispatchContext,
        request: ClaimRequest,
    ) -> Result<Option<PreparedAttempt>, CoreError> {
        DeliveryService::new(&self.registry)
            .claim(&context, &request, || (self.allocate)(), (self.now)())
            .map_err(errors::delivery)
    }

    fn report(
        &self,
        context: AdapterContext,
        event: ariadne_agent_protocol::NormalizedEvent,
    ) -> Result<EventReceipt, CoreError> {
        DeliveryService::new(&self.registry)
            .report(&context, &event, || (self.allocate)())
            .map_err(errors::delivery)
    }
}
