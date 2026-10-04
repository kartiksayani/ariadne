use crate::{CoreError, CoreErrorCode};
use ariadne_domain::history::HistoryError;
use ariadne_domain::transitions::TransitionError;
use ariadne_store::registry::RegistryError;
use ariadne_store::session::{StoreError, TransactionError};
use std::fmt;

/// Definite filesystem failures retain their original cause and path.
#[derive(Debug)]
pub enum ApplyError {
    Core(CoreError),
    Registry(RegistryError),
    Store(StoreError),
}
impl From<CoreError> for ApplyError {
    fn from(error: CoreError) -> Self {
        Self::Core(error)
    }
}
impl From<RegistryError> for ApplyError {
    fn from(error: RegistryError) -> Self {
        Self::Registry(error)
    }
}
impl From<StoreError> for ApplyError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}
impl From<TransactionError<CoreError>> for ApplyError {
    fn from(error: TransactionError<CoreError>) -> Self {
        match error {
            TransactionError::Store(error) => Self::Store(error),
            TransactionError::Command(error) => Self::Core(error),
        }
    }
}
impl fmt::Display for ApplyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for ApplyError {}

pub(super) fn core(code: CoreErrorCode, message: impl Into<String>) -> CoreError {
    CoreError::new(code, message, "Read the current registered session and correct the apply request; retain the operation ID for an exact retry.")
}
pub(super) fn history(error: HistoryError) -> CoreError {
    let code = match error {
        HistoryError::MissingReference | HistoryError::InvalidRound => CoreErrorCode::InvalidRef,
        HistoryError::BindingMismatch => CoreErrorCode::BindingMismatch,
        HistoryError::StaleGeneration => CoreErrorCode::StaleGeneration,
        HistoryError::AttemptSealed => CoreErrorCode::AttemptSealed,
        HistoryError::ResultAlreadyCommitted => CoreErrorCode::ResultAlreadyCommitted,
        HistoryError::CounterOverflow => CoreErrorCode::CapacityExceeded,
        _ => CoreErrorCode::InvalidArgument,
    };
    core(
        code,
        format!("Agent history rejected the operation: {error}"),
    )
}
pub(super) fn transition(error: TransitionError) -> CoreError {
    let code = match error {
        TransitionError::StaleRevision => CoreErrorCode::RevisionConflict,
        TransitionError::StaleQuestionRevision => CoreErrorCode::QuestionChanged,
        TransitionError::MissingItem => CoreErrorCode::InvalidRef,
        TransitionError::MissingBinding | TransitionError::DisconnectedBinding => {
            CoreErrorCode::BindingMismatch
        }
        TransitionError::StaleGeneration => CoreErrorCode::StaleGeneration,
        TransitionError::UnhandledOwnerMessages { .. } => CoreErrorCode::UnhandledOwnerMessage,
        TransitionError::CounterOverflow => CoreErrorCode::CapacityExceeded,
        TransitionError::InvalidTransition | TransitionError::MissingReason => {
            CoreErrorCode::InvalidTransition
        }
        _ => CoreErrorCode::InvalidArgument,
    };
    core(
        code,
        format!("Item transition rejected the operation: {error}"),
    )
}
