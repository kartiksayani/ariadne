//! Native routing from authoritative retained bindings, before invoking Core.
use ariadne_core::{AgentContext, AgentReadScope, CoreError, CoreErrorCode, RegisteredSession};
use ariadne_domain::models::*;
use ariadne_store::{
    registry::{Registry, RegistryError},
    session::StoreError,
};

pub(super) fn context(
    registry: &Registry,
    binding_id: UuidV4,
    generation: UuidV4,
    source: Option<UuidV4>,
    attempt_id: Option<UuidV4>,
) -> Result<AgentContext, CoreError> {
    if source.is_some() != attempt_id.is_some() {
        return Err(invalid(
            "Source input and attempt must both be supplied or both absent.",
        ));
    }
    let catalogue = registry.catalogue().map_err(registry_error)?;
    let mut found = None;
    for project in catalogue.projects {
        let project = project.result.map_err(store_error)?;
        for outcome in project.sessions.map_err(store_error)? {
            let session = outcome.result.map_err(store_error)?;
            if session.bindings.0.contains_key(&binding_id) && found.replace(session).is_some() {
                return Err(CoreError::new(
                    CoreErrorCode::BindingAmbiguous,
                    "Binding ID occurs in more than one registered session.",
                    "Resolve the duplicate registered identities before retrying.",
                ));
            }
        }
    }
    let session = found.ok_or_else(|| {
        CoreError::new(
            CoreErrorCode::NotFound,
            "Binding ID is not retained in any registered session.",
            "Use an explicitly registered binding ID.",
        )
    })?;
    let binding = &session.bindings.0[&binding_id];
    let issued = binding.issued_through_message_number;
    let scope = match (source, attempt_id) {
        (None, None) => AgentReadScope::Terminal {
            issued_through_message_number: issued,
        },
        (Some(source_input_id), Some(attempt_id)) => {
            let input = session
                .inputs
                .0
                .get(&source_input_id)
                .filter(|input| {
                    input.binding_id == binding_id
                        && input
                            .attempts
                            .iter()
                            .any(|attempt| attempt.id == attempt_id)
                })
                .ok_or_else(|| invalid("Source input/attempt is not retained in this binding."))?;
            let message = session
                .messages
                .iter()
                .find(|message| {
                    message.id == input.message_id
                        && message.author == MessageAuthor::Owner
                        && message.input_id.as_ref() == Some(&source_input_id)
                })
                .ok_or_else(|| invalid("Source owner message is missing."))?;
            AgentReadScope::Dispatched {
                source_input_id,
                attempt_id,
                issued_through_message_number: NonnegativeSafeInteger::new(
                    issued.value().min(message.number.value()),
                )
                .expect("validated counters"),
            }
        }
        _ => unreachable!("paired above"),
    };
    // Do not precheck selected route, generation, active attempt or seal: Apply's
    // locked exact receipt replay must remain available after rebind/reconciliation.
    Ok(AgentContext::from_trusted_entrypoint(
        RegisteredSession::from_trusted_entrypoint(session.project_id, session.id),
        binding_id,
        generation,
        scope,
    ))
}
pub(super) fn invalid(message: &str) -> CoreError {
    CoreError::new(
        CoreErrorCode::InvalidArgument,
        message,
        "Use ariadne --help; supply explicit binding/generation and canonical JSON parameters.",
    )
}
pub(super) fn registry_error(error: RegistryError) -> CoreError {
    match error {
        RegistryError::Store(error) => store_error(error),
        RegistryError::InvalidData { path, source }
        | RegistryError::Unavailable { path, source } => {
            let mut error = store_error(source);
            error.message = format!("{}: {}", path.display(), error.message);
            error
        }
        RegistryError::InvalidRegistry => {
            local(CoreErrorCode::CorruptSession, "Invalid registry data")
        }
        RegistryError::InvalidArgument => invalid("Invalid registry argument."),
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
pub(super) fn store_error(error: StoreError) -> CoreError {
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
fn local(code: CoreErrorCode, message: impl Into<String>) -> CoreError {
    CoreError::new(code, message, "Check the registered data path and original error; keep the same operation ID for an exact retry. No data was repaired.")
}
