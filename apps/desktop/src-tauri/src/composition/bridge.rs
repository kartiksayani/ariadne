use super::NativeRuntime;
use crate::commands::DesktopService;
use ariadne_core::{native::NativeCoreService, *};
use std::sync::{Arc, Weak};

/// Renderer calls use the actual Core on the owning blocking executor. Managed
/// services never retain native dispatch ownership after runtime shutdown.
#[derive(Clone)]
pub struct CoreBridge {
    core: Arc<NativeCoreService>,
    runtime: Weak<NativeRuntime>,
}
impl CoreBridge {
    pub(super) fn new(core: Arc<NativeCoreService>, runtime: Weak<NativeRuntime>) -> Self {
        Self { core, runtime }
    }
    pub fn core(&self) -> &Arc<NativeCoreService> {
        &self.core
    }
    pub fn desktop_service(&self) -> DesktopService {
        let resolver = self.core.clone();
        let runtime = self.runtime.clone();
        DesktopService::from_trusted_startup_with_connect(
            Arc::new(self.clone()),
            move |route| resolver.resolve_session(route),
            move |request, deadline| {
                runtime
                    .upgrade()
                    .ok_or_else(super::runtime::unavailable)?
                    .connect_before(request, deadline)
            },
        )
    }
}
impl CoreService for CoreBridge {
    fn query(
        &self,
        context: QueryContext,
        request: QueryRequest,
    ) -> Result<QueryResult, CoreError> {
        let core = self.core.clone();
        let runtime = self
            .runtime
            .upgrade()
            .ok_or_else(super::runtime::unavailable)?;
        let mut result = runtime.run_owned(super::runtime::unavailable(), move || {
            core.query(context, request)
        })?;
        {
            runtime.overlay_presence(&mut result);
        }
        Ok(result)
    }
    fn execute_owner(
        &self,
        context: OwnerContext,
        command: OwnerCommand,
    ) -> Result<MutationReceipt, CoreError> {
        let core = self.core.clone();
        self.runtime
            .upgrade()
            .ok_or_else(super::runtime::unavailable)?
            .run_owned(super::runtime::uncertain(), move || {
                core.execute_owner(context, command)
            })
    }
    fn apply(
        &self,
        context: AgentContext,
        request: ApplyRequest,
    ) -> Result<ApplyReceipt, CoreError> {
        let core = self.core.clone();
        self.runtime
            .upgrade()
            .ok_or_else(super::runtime::unavailable)?
            .run_owned(super::runtime::uncertain(), move || {
                core.apply(context, request)
            })
    }
    fn claim(
        &self,
        context: ValidatedDispatchContext,
        request: ClaimRequest,
    ) -> Result<Option<PreparedAttempt>, CoreError> {
        let core = self.core.clone();
        self.runtime
            .upgrade()
            .ok_or_else(super::runtime::unavailable)?
            .run_owned(super::runtime::uncertain(), move || {
                core.claim(context, request)
            })
    }
    fn report(
        &self,
        context: AdapterContext,
        event: ariadne_agent_protocol::NormalizedEvent,
    ) -> Result<EventReceipt, CoreError> {
        let core = self.core.clone();
        self.runtime
            .upgrade()
            .ok_or_else(super::runtime::unavailable)?
            .run_owned(super::runtime::uncertain(), move || {
                core.report(context, event)
            })
    }
}
