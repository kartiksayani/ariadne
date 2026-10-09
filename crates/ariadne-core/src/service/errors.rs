//! Public error vocabulary and exhaustive adapter mapping.
use ariadne_agent_protocol::{AdapterError, AdapterErrorCode};
use ariadne_domain::models::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum CoreErrorCode {
    InvalidArgument,
    NotFound,
    BindingAmbiguous,
    BindingMismatch,
    BindingConflict,
    StaleGeneration,
    IncompatibleAdapter,
    HostUnreachable,
    RevisionConflict,
    QuestionChanged,
    UnhandledOwnerMessage,
    InvalidRef,
    InvalidTransition,
    OperationReused,
    ResultAlreadyCommitted,
    AttemptSealed,
    ResultMissing,
    DeliveryUncertain,
    QueueFull,
    TopicNotArchivable,
    SessionNotClosable,
    PreviewStale,
    SnapshotChanged,
    IoError,
    StoreBusy,
    CapacityExceeded,
    CommitUncertain,
    CorruptSession,
    FutureSchema,
    PermissionDenied,
    Unsupported,
    ProtocolConflict,
    UnsupportedHostVersion,
    ControlPathTooLong,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct CoreError {
    pub code: CoreErrorCode,
    pub message: String,
    pub hint: String,
    pub retryable: bool,
    pub field_errors: Vec<FieldError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub current_revision: Option<PositiveSafeInteger>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub details: Option<Box<ErrorDetails>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct FieldError {
    pub field: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ErrorDetails {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub connected_session_name: Option<String>,
    pub reason: Option<BarrierReason>,
    pub binding_id: Option<UuidV4>,
    pub input_id: Option<UuidV4>,
    pub attempt_id: Option<UuidV4>,
    pub blocking_item_ids: Vec<ItemRef>,
    pub blocking_input_ids: Vec<UuidV4>,
    pub dispatch_must_pause: bool,
    // Set when a topic removal committed to some sessions but not all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub partial_removal: Option<PartialRemoval>,
}

/// The sessions a partial topic removal already left and still has to leave.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PartialRemoval {
    pub removed: Vec<UuidV4>,
    pub remaining: Vec<UuidV4>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum BarrierReason {
    OwnerPaused,
    RecoveryRequired,
    Disconnected,
    LeaseInvalid,
    Incompatible,
    ResultMissing,
    DeliveryUncertain,
    HostFailure,
    StoreError,
    /// The binding's session is closed; reopening it resumes dispatch.
    SessionClosed,
    /// The binding exists in no registered session (removed or unknown).
    SessionRemoved,
    /// The owner cancelled or removed the input the agent names.
    InputCancelled,
    /// The owner archived the topic an agent write targets; restore reopens it.
    TopicArchived,
}

impl CoreError {
    pub fn new(code: CoreErrorCode, message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            hint: hint.into(),
            retryable: false,
            field_errors: Vec::new(),
            current_revision: None,
            details: None,
        }
    }
}

impl From<AdapterError> for CoreError {
    fn from(error: AdapterError) -> Self {
        let (code, hint) = match error.code {
            AdapterErrorCode::InvalidArgument => (
                CoreErrorCode::InvalidArgument,
                "Correct the adapter request.",
            ),
            AdapterErrorCode::BindingMismatch => (
                CoreErrorCode::BindingMismatch,
                "Verify the registered binding and host identity.",
            ),
            AdapterErrorCode::StaleGeneration => (
                CoreErrorCode::StaleGeneration,
                "Reload the binding generation.",
            ),
            AdapterErrorCode::IncompatibleAdapter => (
                CoreErrorCode::IncompatibleAdapter,
                "Use a compatible installed adapter.",
            ),
            AdapterErrorCode::HostUnreachable => (
                CoreErrorCode::HostUnreachable,
                "Reconnect the existing host session.",
            ),
            AdapterErrorCode::DeliveryUncertain => (
                CoreErrorCode::DeliveryUncertain,
                "Reconcile host evidence before an owner decides whether to resend.",
            ),
            AdapterErrorCode::PermissionDenied => (
                CoreErrorCode::PermissionDenied,
                "Check local access to the configured endpoint.",
            ),
            AdapterErrorCode::Unsupported => (
                CoreErrorCode::Unsupported,
                "Use a supported adapter operation.",
            ),
            AdapterErrorCode::ProtocolConflict => (
                CoreErrorCode::ProtocolConflict,
                "Pause dispatch and reconcile contradictory host evidence.",
            ),
            AdapterErrorCode::UnsupportedHostVersion => (
                CoreErrorCode::UnsupportedHostVersion,
                "Use the tested host version shown by doctor.",
            ),
        };
        let mut mapped = Self::new(code, error.message, hint);
        mapped.retryable = error.retryable && code != CoreErrorCode::DeliveryUncertain;
        mapped
    }
}

impl CoreErrorCode {
    pub fn cli_exit(self) -> i32 {
        match self {
            Self::InvalidArgument | Self::InvalidRef => 2,
            Self::IncompatibleAdapter
            | Self::Unsupported
            | Self::UnsupportedHostVersion
            | Self::FutureSchema => 5,
            Self::HostUnreachable
            | Self::IoError
            | Self::StoreBusy
            | Self::CapacityExceeded
            | Self::CommitUncertain
            | Self::CorruptSession
            | Self::PermissionDenied
            | Self::ControlPathTooLong => 4,
            _ => 3,
        }
    }
}
