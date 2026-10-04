//! Deliberate owner lifecycle controls and copied topic handoffs.
mod continuation;
mod error;
mod lifecycle;
mod preview;
pub use error::HistoryActionError;

use crate::*;
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};

pub struct HistoryActionService<'a> {
    registry: &'a Registry,
}
impl<'a> HistoryActionService<'a> {
    pub fn new(registry: &'a Registry) -> Self {
        Self { registry }
    }

    /// The native entrypoint supplies the registered owner route and time.
    /// Saved operation replay precedes lifecycle revision and blocker checks.
    pub fn execute(
        &self,
        context: &OwnerContext,
        command: &OwnerCommand,
        at: UtcMillis,
    ) -> Result<MutationReceipt, HistoryActionError> {
        let OwnerScope::Session(route) = context.scope() else {
            return Err(core(
                CoreErrorCode::PermissionDenied,
                "History controls require an owner session route",
            )
            .into());
        };
        let version = match command {
            OwnerCommand::TopicArchive { api_version, .. }
            | OwnerCommand::TopicRestore { api_version, .. }
            | OwnerCommand::SessionClose { api_version, .. }
            | OwnerCommand::SessionReopen { api_version, .. } => api_version,
            _ => {
                return Err(core(
                    CoreErrorCode::InvalidArgument,
                    "Expected an owner lifecycle command",
                )
                .into())
            }
        };
        if version.value() != 1 {
            return Err(core(CoreErrorCode::Unsupported, "Unsupported owner API version").into());
        }
        command.validate_wire()?;
        let normalized = match command {
            OwnerCommand::TopicArchive { params, .. } => {
                crate::receipts::normalized("topic_archive", params)?
            }
            OwnerCommand::TopicRestore { params, .. } => {
                crate::receipts::normalized("topic_restore", params)?
            }
            OwnerCommand::SessionClose { params, .. } => {
                crate::receipts::normalized("session_close", params)?
            }
            OwnerCommand::SessionReopen { params, .. } => {
                crate::receipts::normalized("session_reopen", params)?
            }
            _ => {
                return Err(core(
                    CoreErrorCode::InvalidArgument,
                    "Expected an owner topic/session lifecycle command",
                )
                .into())
            }
        };
        let project = self.registry.resolve_project(route.project_id())?;
        let store = Store::open_registered(&project.root, project.project_id)?;
        let receipt = store.transact(
            route.session_id(),
            &ReceiptActorScope::Owner {},
            command.operation_id(),
            &normalized,
            |session| {
                let data = lifecycle::apply(session, command, &at)?;
                session.updated_at = at;
                Ok::<_, CoreError>(data)
            },
        )?;
        Ok(MutationReceipt::Session(Box::new(receipt)))
    }
}

fn core(code: CoreErrorCode, message: &str) -> CoreError {
    CoreError::new(
        code,
        message,
        "Reload the registered session and resolve the displayed lifecycle guards.",
    )
}
