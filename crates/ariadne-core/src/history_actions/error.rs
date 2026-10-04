use crate::CoreError;
use ariadne_store::{
    registry::RegistryError,
    session::{StoreError, TransactionError},
};
use std::fmt;

/// Preserve definite local filesystem causes separately from owner rejection.
#[derive(Debug)]
pub enum HistoryActionError {
    Core(CoreError),
    Registry(RegistryError),
    Store(StoreError),
}
impl From<CoreError> for HistoryActionError {
    fn from(error: CoreError) -> Self {
        Self::Core(error)
    }
}
impl From<RegistryError> for HistoryActionError {
    fn from(error: RegistryError) -> Self {
        Self::Registry(error)
    }
}
impl From<StoreError> for HistoryActionError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}
impl From<TransactionError<CoreError>> for HistoryActionError {
    fn from(error: TransactionError<CoreError>) -> Self {
        match error {
            TransactionError::Store(error) => Self::Store(error),
            TransactionError::Command(error) => Self::Core(error),
        }
    }
}
impl fmt::Display for HistoryActionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}
impl std::error::Error for HistoryActionError {}
