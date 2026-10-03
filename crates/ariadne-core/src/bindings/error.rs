use crate::CoreError;
use ariadne_store::registry::RegistryError;
use ariadne_store::session::{StoreError, TransactionError};
use std::fmt;

/// Native setup preserves ordinary filesystem failures and affected paths rather
/// than incorrectly describing a pre-publication I/O failure as a saved commit.
#[derive(Debug)]
pub enum BindingError {
    Core(CoreError),
    Registry(RegistryError),
    Store(StoreError),
}
impl From<CoreError> for BindingError {
    fn from(error: CoreError) -> Self {
        Self::Core(error)
    }
}
impl From<RegistryError> for BindingError {
    fn from(error: RegistryError) -> Self {
        Self::Registry(error)
    }
}
impl From<StoreError> for BindingError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}
impl From<TransactionError<BindingError>> for BindingError {
    fn from(error: TransactionError<BindingError>) -> Self {
        match error {
            TransactionError::Store(error) => Self::Store(error),
            TransactionError::Command(error) => error,
        }
    }
}
impl fmt::Display for BindingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}
impl std::error::Error for BindingError {}
