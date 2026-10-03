use crate::CoreError;
use ariadne_store::registry::RegistryError;
use ariadne_store::session::{StoreError, TransactionError};
use std::fmt;

/// Native errors retain definite filesystem failures and affected paths.
#[derive(Debug)]
pub enum InputError {
    Core(CoreError),
    Registry(RegistryError),
    Store(StoreError),
}
impl From<CoreError> for InputError {
    fn from(error: CoreError) -> Self {
        Self::Core(error)
    }
}
impl From<RegistryError> for InputError {
    fn from(error: RegistryError) -> Self {
        Self::Registry(error)
    }
}
impl From<StoreError> for InputError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}
impl From<TransactionError<CoreError>> for InputError {
    fn from(error: TransactionError<CoreError>) -> Self {
        match error {
            TransactionError::Store(error) => Self::Store(error),
            TransactionError::Command(error) => Self::Core(error),
        }
    }
}
impl fmt::Display for InputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}
impl std::error::Error for InputError {}
