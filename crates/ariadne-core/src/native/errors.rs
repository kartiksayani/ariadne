use crate::{CoreError, CoreErrorCode};
use ariadne_store::{registry::RegistryError, session::StoreError};

pub(super) fn local(code: CoreErrorCode, message: impl Into<String>) -> CoreError {
    let mut message = message.into();
    if message.len() > 4096 {
        let mut end = 4093;
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
        message.push_str("...");
    }
    CoreError::new(code, message, "Keep the original operation/event IDs and check the affected local data path. Reload or reconcile before any new action; no data was repaired.")
}

pub(super) fn store(error: StoreError) -> CoreError {
    local(store_code(&error), error.to_string())
}
fn store_code(error: &StoreError) -> CoreErrorCode {
    match error {
        StoreError::Io {
            kind: std::io::ErrorKind::PermissionDenied,
            ..
        }
        | StoreError::UnsafePath { .. } => CoreErrorCode::PermissionDenied,
        StoreError::Io { .. } => CoreErrorCode::IoError,
        StoreError::SessionFile { source, .. } => store_code(source),
        StoreError::FutureSchema => CoreErrorCode::FutureSchema,
        StoreError::Busy => CoreErrorCode::StoreBusy,
        StoreError::AlreadyExists => CoreErrorCode::BindingConflict,
        StoreError::OperationReused => CoreErrorCode::OperationReused,
        StoreError::CounterOverflow => CoreErrorCode::CapacityExceeded,
        StoreError::CommitUncertain { .. } => CoreErrorCode::CommitUncertain,
        StoreError::InvalidSnapshot
        | StoreError::IdentityMismatch
        | StoreError::Validation(_)
        | StoreError::History(_)
        | StoreError::LockPoisoned => CoreErrorCode::CorruptSession,
    }
}
pub(super) fn registry(error: RegistryError) -> CoreError {
    match error {
        RegistryError::Store(error) => store(error),
        RegistryError::InvalidData { path, source }
        | RegistryError::Unavailable { path, source } => {
            local(store_code(&source), format!("{}: {source}", path.display()))
        }
        RegistryError::InvalidRegistry => {
            local(CoreErrorCode::CorruptSession, "Invalid registry data")
        }
        RegistryError::InvalidArgument => {
            local(CoreErrorCode::InvalidArgument, "Invalid registry argument")
        }
        RegistryError::NotRegistered | RegistryError::NotFound => {
            local(CoreErrorCode::NotFound, "Registered route is missing")
        }
        RegistryError::Conflict { paths } => local(
            CoreErrorCode::BindingConflict,
            format!("Conflicting registered identities: {paths:?}"),
        ),
        RegistryError::CommitUncertain { operation_id, .. } => local(
            CoreErrorCode::CommitUncertain,
            format!(
                "Registry publication is uncertain for operation {}",
                operation_id.as_str()
            ),
        ),
    }
}

macro_rules! native_error {
    ($name:ident, $ty:path) => {
        pub(super) fn $name(error: $ty) -> CoreError {
            use $ty as NativeError;
            match error {
                NativeError::Core(error) => error,
                NativeError::Registry(error) => registry(error),
                NativeError::Store(error) => store(error),
            }
        }
    };
}
native_error!(query, crate::queries::QueryError);
native_error!(binding, crate::bindings::BindingError);
native_error!(input, crate::inputs::InputError);
native_error!(apply, crate::apply::ApplyError);
native_error!(delivery, crate::delivery::DeliveryError);

native_error!(recovery, crate::recovery::RecoveryError);
native_error!(history, crate::history_actions::HistoryActionError);
impl From<ariadne_store::session::StoreError> for CoreError {
    fn from(error: ariadne_store::session::StoreError) -> Self {
        store(error)
    }
}
impl From<ariadne_store::registry::RegistryError> for CoreError {
    fn from(error: ariadne_store::registry::RegistryError) -> Self {
        registry(error)
    }
}
impl From<crate::bindings::BindingError> for CoreError {
    fn from(error: crate::bindings::BindingError) -> Self {
        binding(error)
    }
}
