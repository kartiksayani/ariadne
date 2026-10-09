//! Deliberate owner lifecycle controls and copied topic handoffs.
mod ack;
mod continuation;
mod error;
mod label;
mod lifecycle;
mod preview;
mod remove;
pub use error::HistoryActionError;

use crate::*;
use ariadne_domain::models::*;
use ariadne_store::{
    registry::Registry,
    session::{Store, StoreError, TransactionError},
};

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
        if matches!(command, OwnerCommand::Ack { .. }) {
            return Err(core(
                CoreErrorCode::InvalidArgument,
                "Ack requires its owner message allocator",
            )
            .into());
        }
        self.execute_with_allocator(context, command, at, || {
            unreachable!("Only Ack requires a message allocator")
        })
    }

    /// Ack allocates a durable owner Activity message in the same transaction.
    pub fn acknowledge(
        &self,
        context: &OwnerContext,
        command: &OwnerCommand,
        at: UtcMillis,
        allocate: impl FnMut() -> UuidV4,
    ) -> Result<MutationReceipt, HistoryActionError> {
        if !matches!(command, OwnerCommand::Ack { .. }) {
            return Err(core(CoreErrorCode::InvalidArgument, "Expected an Ack command").into());
        }
        self.execute_with_allocator(context, command, at, allocate)
    }

    fn execute_with_allocator(
        &self,
        context: &OwnerContext,
        command: &OwnerCommand,
        at: UtcMillis,
        mut allocate: impl FnMut() -> UuidV4,
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
            | OwnerCommand::SessionReopen { api_version, .. }
            | OwnerCommand::SessionLabelSet { api_version, .. }
            | OwnerCommand::Ack { api_version, .. } => api_version,
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
            OwnerCommand::Ack { params, .. } => crate::receipts::normalized("ack", params)?,
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
            // Digest the stored form, so a retry typed with other spacing replays.
            OwnerCommand::SessionLabelSet { params, .. } => {
                let (name, description) = params.normalized()?;
                crate::receipts::normalized("session_label_set", &(name, description))?
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
        let store = Store::open_registered(
            &self.registry.project_dir(&project.project_id),
            project.project_id,
        )?;
        let receipt = store.transact(
            route.session_id(),
            &ReceiptActorScope::Owner {},
            command.operation_id(),
            &normalized,
            |session| {
                // A rename is not session activity: `updated_at` stays put.
                if matches!(command, OwnerCommand::SessionLabelSet { .. }) {
                    return label::apply(session, command);
                }
                let data = if matches!(command, OwnerCommand::Ack { .. }) {
                    ack::apply(session, command, &at, &mut allocate)?
                } else {
                    lifecycle::apply(session, command, &at)?
                };
                session.updated_at = at;
                Ok::<_, CoreError>(data)
            },
        );
        match receipt {
            Ok(receipt) => Ok(MutationReceipt::Session(Box::new(receipt))),
            // A removed session has no file left: say so instead of an I/O error.
            Err(TransactionError::Store(error))
                if matches!(command, OwnerCommand::SessionLabelSet { .. })
                    && is_missing(&error) =>
            {
                Err(CoreError::new(
                    CoreErrorCode::NotFound,
                    "This session was removed, so it can't be renamed.",
                    "Go back to the project page and pick a session that is still there.",
                )
                .into())
            }
            Err(error) => Err(error.into()),
        }
    }
}

fn is_missing(error: &StoreError) -> bool {
    match error {
        StoreError::Io { kind, .. } => *kind == std::io::ErrorKind::NotFound,
        StoreError::SessionFile { source, .. } => is_missing(source),
        _ => false,
    }
}

fn core(code: CoreErrorCode, message: &str) -> CoreError {
    CoreError::new(
        code,
        message,
        "Reload the registered session and resolve the displayed lifecycle guards.",
    )
}
