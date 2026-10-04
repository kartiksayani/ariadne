//! Validation of captured Mod facts; this does not dispatch or report them to Core.
use ariadne_agent_protocol::{
    AdapterError, AdapterErrorCode, EventPayload, NormalizedEvent, UuidV4,
};

/// Native route/callback correlation, never deserialized from provider JSON.
#[derive(Debug, Clone)]
pub struct CapturedScope {
    pub binding_id: UuidV4,
    pub generation: UuidV4,
    pub input_id: Option<UuidV4>,
    pub attempt_id: Option<UuidV4>,
    pub host_turn_id: Option<String>,
}

/// Preserve the original event identity, timestamp, receipt and callback scope.
/// The existing bridge report route remains the only lifecycle transport.
pub fn normalize_mod_event(
    frame: &[u8],
    scope: &CapturedScope,
) -> Result<NormalizedEvent, AdapterError> {
    if frame.len() > 8 * 1024 * 1024 {
        return Err(error(
            AdapterErrorCode::InvalidArgument,
            "Mod event exceeds the 8MiB frame bound",
        ));
    }
    let event: NormalizedEvent = serde_json::from_slice(frame).map_err(|_| {
        error(
            AdapterErrorCode::InvalidArgument,
            "Mod event is not a canonical normalized fact; retain its original identity",
        )
    })?;
    event.validate()?;
    if matches!(
        event.event,
        EventPayload::Connected { .. } | EventPayload::Presence { .. }
    ) {
        return Err(error(
            AdapterErrorCode::InvalidArgument,
            "Mod callbacks cannot supply native qualified connection/presence facts",
        ));
    }
    if event.binding_id != scope.binding_id
        || event.input_id != scope.input_id
        || event.attempt_id != scope.attempt_id
        || event.host_turn_id != scope.host_turn_id
    {
        return Err(error(
            AdapterErrorCode::BindingMismatch,
            "Mod event differs from its captured route/attempt/turn scope",
        ));
    }
    if event.generation != scope.generation {
        return Err(error(
            AdapterErrorCode::StaleGeneration,
            "Mod event differs from its captured originating generation",
        ));
    }
    Ok(event)
}

pub(crate) fn error(code: AdapterErrorCode, message: &str) -> AdapterError {
    AdapterError {
        code,
        message: message.into(),
        retryable: false,
    }
}
