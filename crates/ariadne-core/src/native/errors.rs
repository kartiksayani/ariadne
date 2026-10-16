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
    CoreError::new(code, message, hint(code))
}

/// One plain hint per code for local errors: what to do next, in words the
/// owner and the agent both follow. `retryable` comes from the code itself
/// (`CoreErrorCode::is_transient`), never from the hint.
pub(crate) fn hint(code: CoreErrorCode) -> &'static str {
    use CoreErrorCode as C;
    match code {
        C::InvalidArgument => "Check the request, correct it and send it again.",
        C::NotFound => "It may have been removed. Reload, then choose it again.",
        C::BindingAmbiguous => "More than one connection matches. Choose the exact connection.",
        C::BindingMismatch => "This connection is not the current one. Reload the connection first.",
        C::BindingConflict => "This already exists. Reload to see the saved one.",
        C::StaleGeneration => "This connection was replaced. Reload it and use the new one.",
        C::IncompatibleAdapter => "Ariadne and the agent's plugin don't match. Update both to the same release.",
        C::HostUnreachable => "The agent can't be reached. Reconnect it, then try again.",
        C::RevisionConflict => "It changed since it was read. Reload, then try again.",
        C::QuestionChanged => "The question changed. Reload and answer the new question.",
        C::UnhandledOwnerMessage => "A message from the owner is still waiting. Handle it first.",
        C::InvalidRef => "A reference doesn't match the saved data. Reload and use current ids.",
        C::InvalidTransition => "That step isn't allowed right now. Reload to see the current state.",
        C::OperationReused => "This operation id was already used for a different request. Use a new id for new work.",
        C::ResultAlreadyCommitted => "A result is already saved for this work. Reload to see it.",
        C::AttemptSealed => "This attempt is already finished. Reload to see how it ended.",
        C::ResultMissing => "The agent finished without saving a result. Check the conversation.",
        C::DeliveryUncertain => "It may already have been sent. Check the conversation before sending again.",
        C::QueueFull => "Too much is waiting to be sent. Wait for some of it to finish.",
        C::TopicNotArchivable => "This topic can't be archived yet. Settle its open work first.",
        C::SessionNotClosable => "This session can't be closed yet. Settle its open work first.",
        C::PreviewStale => "The preview is out of date. Make a new preview.",
        C::SnapshotChanged => "The saved data changed while it was read. Reload and try again.",
        C::IoError => "Ariadne couldn't read or write its data folder. Check disk space and access, then reload.",
        C::StoreBusy => "Ariadne is busy for a moment; try again.",
        C::CapacityExceeded => "This is over a size limit. Make it smaller or split it up.",
        C::CommitUncertain => "The save may or may not have finished. Send the identical request again with the same operation id; a saved one is replayed, not repeated.",
        C::CorruptSession => "Ariadne can't read this saved data. Nothing was changed or repaired; keep the files as they are.",
        C::FutureSchema => "This data was saved by a newer Ariadne. Update Ariadne.",
        C::PermissionDenied => "Ariadne isn't allowed to do this here. Check access to its data folder, or do it from the Ariadne app.",
        C::Unsupported => "This isn't supported here.",
        C::ProtocolConflict => "Ariadne and the agent disagree about what happened. Reload and check the conversation.",
        C::UnsupportedHostVersion => "Use the agent version that `ariadne doctor` shows as tested.",
        C::ControlPathTooLong => "The data folder path is too long. Use a shorter ARIADNE_HOME.",
    }
}

pub(super) fn store(error: StoreError) -> CoreError {
    store_ref(&error)
}
const BUSY_MESSAGE: &str = "Another Ariadne task is using this session right now.";

pub(super) fn store_ref(error: &StoreError) -> CoreError {
    let message = match store_code(error) {
        CoreErrorCode::StoreBusy => BUSY_MESSAGE.into(),
        _ => error.to_string(),
    };
    local(store_code(error), message)
}
fn store_code(error: &StoreError) -> CoreErrorCode {
    match error {
        StoreError::Io {
            kind: std::io::ErrorKind::PermissionDenied,
            ..
        }
        | StoreError::UnsafePath { .. } => CoreErrorCode::PermissionDenied,
        StoreError::Io { .. } | StoreError::Migration { .. } => CoreErrorCode::IoError,
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
        | RegistryError::Unavailable { path, source } => match store_code(&source) {
            CoreErrorCode::StoreBusy => local(CoreErrorCode::StoreBusy, BUSY_MESSAGE),
            code => local(code, format!("{}: {source}", path.display())),
        },
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

#[cfg(test)]
mod tests {
    use super::*;
    use ariadne_domain::{
        history::HistoryError,
        validation::{ValidationError, ValidationErrorKind},
    };
    use std::{io::ErrorKind, path::PathBuf};

    /// Every StoreError variant, so a new one cannot skip this table.
    fn every_store_error() -> Vec<StoreError> {
        let path = PathBuf::from("/data/projects/p/sessions/s.json");
        let io = |kind| StoreError::Io {
            action: "read",
            path: path.clone(),
            kind,
        };
        let all = vec![
            io(ErrorKind::PermissionDenied),
            io(ErrorKind::NotFound),
            StoreError::UnsafePath { path: path.clone() },
            StoreError::InvalidSnapshot,
            StoreError::FutureSchema,
            StoreError::SessionFile {
                path: path.clone(),
                source: Box::new(StoreError::Busy),
            },
            StoreError::IdentityMismatch,
            StoreError::Validation(ValidationError {
                path: "items".into(),
                kind: ValidationErrorKind::Duplicate,
            }),
            StoreError::History(HistoryError::DuplicateId),
            StoreError::Busy,
            StoreError::LockPoisoned,
            StoreError::AlreadyExists,
            StoreError::OperationReused,
            StoreError::CounterOverflow,
            StoreError::CommitUncertain { operation_id: None },
            StoreError::Migration {
                legacy: path.clone(),
                project: path.clone(),
                detail: "copy",
            },
        ];
        for error in &all {
            // Exhaustive on purpose: adding a variant fails to compile here.
            match error {
                StoreError::Io { .. }
                | StoreError::UnsafePath { .. }
                | StoreError::InvalidSnapshot
                | StoreError::FutureSchema
                | StoreError::SessionFile { .. }
                | StoreError::IdentityMismatch
                | StoreError::Validation(_)
                | StoreError::History(_)
                | StoreError::Busy
                | StoreError::LockPoisoned
                | StoreError::AlreadyExists
                | StoreError::OperationReused
                | StoreError::CounterOverflow
                | StoreError::CommitUncertain { .. }
                | StoreError::Migration { .. } => {}
            }
        }
        all
    }

    #[test]
    fn every_store_error_maps_to_one_code_with_its_plain_hint_and_retryable() {
        use CoreErrorCode as C;
        let expected = [
            (C::PermissionDenied, false),
            (C::IoError, false),
            (C::PermissionDenied, false),
            (C::CorruptSession, false),
            (C::FutureSchema, false),
            // A session file's cause decides: here the file was busy.
            (C::StoreBusy, true),
            (C::CorruptSession, false),
            (C::CorruptSession, false),
            (C::CorruptSession, false),
            (C::StoreBusy, true),
            (C::CorruptSession, false),
            (C::BindingConflict, false),
            (C::OperationReused, false),
            (C::CapacityExceeded, false),
            (C::CommitUncertain, false),
            (C::IoError, false),
        ];
        let errors = every_store_error();
        assert_eq!(errors.len(), expected.len());
        for (error, (code, retryable)) in errors.iter().zip(expected) {
            let mapped = store_ref(error);
            assert_eq!(mapped.code, code, "{error:?}");
            assert_eq!(mapped.retryable, retryable, "{error:?}");
            assert_eq!(mapped.hint, hint(code), "{error:?}");
            // Every busy cause, nested in a session file or not, reads plainly.
            if code == C::StoreBusy {
                assert_eq!(mapped.message, BUSY_MESSAGE, "{error:?}");
            }
            mapped.validate().unwrap();
        }
        let busy = store(StoreError::Busy);
        assert_eq!(busy.hint, "Ariadne is busy for a moment; try again.");
        assert!(
            !busy.message.contains("Busy"),
            "plain message: {}",
            busy.message
        );
    }

    #[test]
    fn every_code_has_its_own_plain_hint_and_only_store_busy_is_transient() {
        use CoreErrorCode as C;
        let codes = [
            C::InvalidArgument,
            C::NotFound,
            C::BindingAmbiguous,
            C::BindingMismatch,
            C::BindingConflict,
            C::StaleGeneration,
            C::IncompatibleAdapter,
            C::HostUnreachable,
            C::RevisionConflict,
            C::QuestionChanged,
            C::UnhandledOwnerMessage,
            C::InvalidRef,
            C::InvalidTransition,
            C::OperationReused,
            C::ResultAlreadyCommitted,
            C::AttemptSealed,
            C::ResultMissing,
            C::DeliveryUncertain,
            C::QueueFull,
            C::TopicNotArchivable,
            C::SessionNotClosable,
            C::PreviewStale,
            C::SnapshotChanged,
            C::IoError,
            C::StoreBusy,
            C::CapacityExceeded,
            C::CommitUncertain,
            C::CorruptSession,
            C::FutureSchema,
            C::PermissionDenied,
            C::Unsupported,
            C::ProtocolConflict,
            C::UnsupportedHostVersion,
            C::ControlPathTooLong,
        ];
        let mut hints = std::collections::BTreeSet::new();
        for code in codes {
            let error = local(code, "Concrete local failure.");
            error.validate().unwrap();
            assert_eq!(error.retryable, code == C::StoreBusy, "{code:?}");
            assert!(hints.insert(error.hint.clone()), "shared hint for {code:?}");
            for jargon in ["operation/event IDs", "reconcile", "local data path"] {
                assert!(!error.hint.contains(jargon), "{code:?}: {}", error.hint);
            }
        }
        // The serialized error code list matches this table exactly.
        let schema = serde_json::to_value(schemars::schema_for!(CoreErrorCode)).unwrap();
        assert_eq!(schema["enum"].as_array().unwrap().len(), codes.len());
    }

    #[test]
    fn registry_errors_carry_the_plain_hint_of_their_code() {
        let path = PathBuf::from("/data/projects/p");
        let busy_file = || StoreError::SessionFile {
            path: path.join("sessions/s.json"),
            source: Box::new(StoreError::Busy),
        };
        for busy in [
            registry(RegistryError::Unavailable {
                path: path.clone(),
                source: StoreError::Busy,
            }),
            registry(RegistryError::Unavailable {
                path: path.clone(),
                source: busy_file(),
            }),
            registry(RegistryError::InvalidData {
                path: path.clone(),
                source: busy_file(),
            }),
            registry(RegistryError::Store(busy_file())),
        ] {
            assert_eq!(busy.code, CoreErrorCode::StoreBusy);
            assert!(busy.retryable);
            assert_eq!(busy.hint, hint(CoreErrorCode::StoreBusy));
            assert_eq!(
                busy.message, BUSY_MESSAGE,
                "plain, no path or variant names"
            );
        }
        let unreadable = registry(RegistryError::Unavailable {
            path: path.clone(),
            source: StoreError::InvalidSnapshot,
        });
        assert!(unreadable.message.starts_with("/data/projects/p: "));
        let missing = registry(RegistryError::NotFound);
        assert_eq!(missing.code, CoreErrorCode::NotFound);
        assert!(!missing.retryable);
        assert_eq!(missing.hint, hint(CoreErrorCode::NotFound));
    }
}
