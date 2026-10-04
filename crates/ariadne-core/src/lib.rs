//! Canonical synchronous service contract and native registered binding setup.
pub mod apply;
pub mod bindings;
#[path = "service/context.rs"]
mod context;
pub mod delivery;
mod delivery_join;
mod dto;
#[path = "service/errors.rs"]
mod errors;
#[cfg(any(test, feature = "test-support"))]
#[path = "service/fake.rs"]
pub mod fake;
pub mod inputs;
pub mod native;
pub mod queries;
mod receipts;
#[path = "service/validation.rs"]
mod validation;
#[path = "service/wire.rs"]
mod wire;
pub mod service {
    pub use crate::context::*;
    pub use crate::dto::*;
    pub use crate::errors::*;
    pub use crate::validation::validate_apply_receipt;
    /// Blocking, owned, provider-neutral calls. Real implementations recheck persisted
    /// routing, leases and visibility, validate the complete candidate, then commit.
    /// Replay precedes revision/generation/state guards. Report order never substitutes
    /// host completion for an explicit domain result; checkpoint advances only after
    /// every corresponding report effect persists. No store lock spans a host wait.
    pub trait CoreService: Send + Sync {
        fn query(
            &self,
            context: QueryContext,
            request: QueryRequest,
        ) -> Result<QueryResult, CoreError>;
        fn execute_owner(
            &self,
            context: OwnerContext,
            command: OwnerCommand,
        ) -> Result<MutationReceipt, CoreError>;
        fn apply(
            &self,
            context: AgentContext,
            request: ApplyRequest,
        ) -> Result<ApplyReceipt, CoreError>;
        /// None means healthy empty/in-flight; pause/recovery/lease/scope return errors.
        fn claim(
            &self,
            context: ValidatedDispatchContext,
            request: ClaimRequest,
        ) -> Result<Option<PreparedAttempt>, CoreError>;
        fn report(
            &self,
            context: AdapterContext,
            event: ariadne_agent_protocol::NormalizedEvent,
        ) -> Result<EventReceipt, CoreError>;
    }
}
pub use service::*;
