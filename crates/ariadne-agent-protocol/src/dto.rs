//! Declaration-only method records; canonical domain support types are imported.
use crate::{
    AdapterConfig, Capabilities, Checkpoint, EndpointFingerprint, EndpointRef, HostReceipt,
    ObserveLimit, PresenceObservation, Sha256, UtcMillis, UuidV4,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AdapterError {
    pub code: AdapterErrorCode,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum AdapterErrorCode {
    InvalidArgument,
    BindingMismatch,
    StaleGeneration,
    IncompatibleAdapter,
    HostUnreachable,
    DeliveryUncertain,
    PermissionDenied,
    Unsupported,
    ProtocolConflict,
    UnsupportedHostVersion,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ProbeRequest {
    pub endpoint: EndpointRef,
    pub configuration: AdapterConfig,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ProbeResult {
    pub host_version: Option<String>,
    pub compatibility: Compatibility,
    pub availability: Availability,
    pub setup_steps: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum Compatibility {
    Compatible,
    /// Same major.minor as the qualified baseline with a newer patch: accepted, not verified.
    Untested,
    Incompatible,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Available,
    Unavailable,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ConnectRequest {
    pub binding_id: UuidV4,
    pub generation: UuidV4,
    pub external_session_id: String,
    pub endpoint: EndpointRef,
    pub configuration: AdapterConfig,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ConnectResult {
    pub external_session_id: String,
    pub endpoint_fingerprint: EndpointFingerprint,
    pub capabilities: Capabilities,
    pub observation: PresenceObservation,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SubmitRequest {
    pub binding_id: UuidV4,
    pub generation: UuidV4,
    pub input_id: UuidV4,
    pub attempt_id: UuidV4,
    pub formatted_payload: String,
    pub payload_sha256: Sha256,
    pub wire_marker: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SubmitOutcome {
    Accepted { receipt: Option<HostReceipt> },
    RejectedBeforeDelivery { reason: String },
    Uncertain { reason: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ObserveRequest {
    pub binding_id: UuidV4,
    pub generation: UuidV4,
    pub checkpoint: Option<Checkpoint>,
    pub limit: ObserveLimit,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ObserveResult {
    pub events: Vec<NormalizedEvent>,
    pub next_checkpoint: Option<Checkpoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ReconcileRequest {
    pub binding_id: UuidV4,
    pub generation: UuidV4,
    pub attempts: Vec<AttemptEvidenceRequest>,
    pub checkpoint: Option<Checkpoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AttemptEvidenceRequest {
    pub input_id: UuidV4,
    pub attempt_id: UuidV4,
    pub binding_generation: UuidV4,
    pub payload_sha256: Sha256,
    pub wire_marker: String,
    pub host_turn_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AttemptEvidence {
    pub input_id: UuidV4,
    pub attempt_id: UuidV4,
    pub events: Vec<NormalizedEvent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ReconcileResult {
    pub attempt_evidence: Vec<AttemptEvidence>,
    pub unresolved_attempt_ids: Vec<UuidV4>,
    pub next_checkpoint: Option<Checkpoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct DisconnectRequest {
    pub binding_id: UuidV4,
    pub generation: UuidV4,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct DisconnectResult {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct NormalizedEvent {
    pub event_id: String,
    pub binding_id: UuidV4,
    pub generation: UuidV4,
    pub input_id: Option<UuidV4>,
    pub attempt_id: Option<UuidV4>,
    pub host_turn_id: Option<String>,
    pub observed_at: UtcMillis,
    #[serde(flatten)]
    pub event: EventPayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
pub enum EventPayload {
    Connected {
        external_session_id: String,
        endpoint_fingerprint: EndpointFingerprint,
        capabilities: Box<Capabilities>,
    },
    Accepted {
        receipt: Option<HostReceipt>,
    },
    TurnStarted {},
    VisibleOutput {
        host_message_id: Option<String>,
        phase: OutputPhase,
        operation: OutputOperation,
        text: String,
        truncated: bool,
        gap_before: bool,
    },
    TurnFinished {
        status: TurnFinishedStatus,
        reason: Option<String>,
        diagnostic_text: Option<String>,
        truncated: bool,
    },
    Rejected {
        reason: String,
    },
    Uncertain {
        reason: String,
    },
    Presence {
        observation: PresenceObservation,
    },
    Disconnected {
        reason: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum OutputPhase {
    Commentary,
    Final,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum OutputOperation {
    Append,
    Replace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum TurnFinishedStatus {
    Completed,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum TerminalEventKind {
    TurnFinished,
    Rejected,
    Uncertain,
}
