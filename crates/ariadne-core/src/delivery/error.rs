use crate::{CoreError, CoreErrorCode};
use ariadne_store::{
    registry::RegistryError,
    session::{StoreError, TransactionError},
};
use std::fmt;

#[derive(Debug)]
pub enum DeliveryError {
    Core(CoreError),
    Registry(RegistryError),
    Store(StoreError),
}
impl From<CoreError> for DeliveryError {
    fn from(e: CoreError) -> Self {
        Self::Core(e)
    }
}
impl From<RegistryError> for DeliveryError {
    fn from(e: RegistryError) -> Self {
        Self::Registry(e)
    }
}
impl From<StoreError> for DeliveryError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}
impl From<TransactionError<CoreError>> for DeliveryError {
    fn from(e: TransactionError<CoreError>) -> Self {
        match e {
            TransactionError::Store(e) => Self::Store(e),
            TransactionError::Command(e) => Self::Core(e),
        }
    }
}
impl fmt::Display for DeliveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for DeliveryError {}
pub(super) fn core(code: CoreErrorCode, message: impl Into<String>) -> CoreError {
    CoreError::new(code,message,"Retain the original claim/event IDs, reload the registered binding and reconcile in Ariadne; never automatically resend.")
}
