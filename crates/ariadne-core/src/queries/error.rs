use crate::CoreError;
use ariadne_store::{registry::RegistryError, session::StoreError};
use std::fmt;

/// Native query errors retain filesystem paths and definite I/O causes.
#[derive(Debug)]
pub enum QueryError {
    Core(CoreError),
    Registry(RegistryError),
    Store(StoreError),
}
impl From<CoreError> for QueryError {
    fn from(error: CoreError) -> Self {
        Self::Core(error)
    }
}
impl From<RegistryError> for QueryError {
    fn from(error: RegistryError) -> Self {
        Self::Registry(error)
    }
}
impl From<StoreError> for QueryError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}
impl fmt::Display for QueryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}
impl std::error::Error for QueryError {}
