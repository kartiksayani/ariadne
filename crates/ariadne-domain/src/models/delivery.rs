//! Provider-neutral stored delivery and qualified presence declarations.
use super::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(transparent)]
pub struct EndpointFingerprint(pub String);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum EndpointRef {
    UnixSocket { path: String },
    LocalBridge { name: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AdapterConfig {
    pub namespace: String,
    #[serde(deserialize_with = "super::wire::deserialize_config_values")]
    pub values: UniqueMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Capability {
    pub supported: bool,
    pub conditions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Capabilities {
    pub existing_session: Capability,
    pub deferred_delivery: Capability,
    pub turn_correlation: Capability,
    pub turn_completion: Capability,
    pub domain_cli: Capability,
    pub domain_mcp: Capability,
    pub history_reconcile: Capability,
    pub streaming_output: Capability,
    pub final_text_read: Capability,
    pub discover_sessions: Capability,
    pub delivery_mode: DeliveryMode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryMode {
    Pull,
    Push,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub id: UuidV4,
    pub adapter_id: String,
    pub adapter_version: String,
    pub protocol_major: PositiveSafeInteger,
    pub config_version: PositiveSafeInteger,
    pub external_session_id: String,
    pub endpoint: EndpointRef,
    pub endpoint_fingerprint: EndpointFingerprint,
    pub generation: UuidV4,
    pub created_at: UtcMillis,
    pub dispatch_state: DispatchState,
    pub owner_paused: bool,
    pub pause_reason: Option<PauseReason>,
    pub connection_state: ConnectionState,
    pub capabilities: Capabilities,
    pub active_input_id: Option<UuidV4>,
    pub issued_through_message_number: NonnegativeSafeInteger,
    pub adapter_config: AdapterConfig,
}

impl Binding {
    /// True when nothing can be dispatched through this binding: dispatch is paused
    /// or disconnected, or the connection is not `connected`. This is the session
    /// close precondition. Mirrored by `dispatchQuiesced` in
    /// `apps/desktop/src/components/history-actions/selectors.ts`.
    pub fn dispatch_quiesced(&self) -> bool {
        matches!(
            self.dispatch_state,
            DispatchState::Paused | DispatchState::Disconnected
        ) || self.connection_state != ConnectionState::Connected
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum DispatchState {
    Enabled,
    Paused,
    RecoveryRequired,
    Disconnected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum PauseReason {
    ResultMissing,
    Uncertain,
    HostFailure,
    StoreError,
    Incompatible,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    Connected,
    Disconnected,
    Reconnecting,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PresenceObservation {
    pub instance_id: UuidV4,
    pub generation: UuidV4,
    pub connection_state: ConnectionState,
    pub execution_state: ExecutionState,
    pub last_seen_at: Option<UtcMillis>,
    pub source: Option<PresenceSource>,
    pub process_identity: Option<ProcessIdentity>,
    pub freshness: Freshness,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionState {
    Idle,
    Running,
    WaitingForApproval,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum PresenceSource {
    BridgeHeartbeat,
    HostPoll,
    HostEvent,
    ProcessHint,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum Freshness {
    Fresh,
    Stale,
    Historical,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ProcessIdentity {
    pub pid: PositiveSafeInteger,
    pub started_at: UtcMillis,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub id: UuidV4,
    pub seq: PositiveSafeInteger,
    pub binding_id: UuidV4,
    pub kind: InputKind,
    pub target: InputTarget,
    pub message_id: UuidV4,
    pub answer_id: Option<UuidV4>,
    pub created_at: UtcMillis,
    pub expected_question_revision: Option<PositiveSafeInteger>,
    pub payload: InputPayload,
    pub state: InputState,
    pub attempts: Vec<Attempt>,
    pub active_attempt_id: Option<UuidV4>,
    pub resolution_history: Vec<ResolutionHistoryEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum InputKind {
    Answer,
    Bring,
    Reply,
    Note,
    Followup,
    Reopen,
    Drop,
    Continue,
    /// The owner removed items or topics; the agent stops work on them.
    Removed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum InputState {
    Queued,
    InFlight,
    Handled,
    Cancelled,
    NeedsAttention,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct InputTarget {
    pub topic_id: UuidV4,
    pub item_id: Option<ItemRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct InputPayload {
    pub text: String,
    pub intent: InputKind,
    pub target_snapshot: InputTargetSnapshot,
    pub selected_option_id: Option<String>,
    pub context: InputContext,
    // Present exactly on `removed` inputs: what the owner removed. A plain
    // comment, so the generated TypeScript stays on one line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub removed: Option<RemovedNotice>,
}

/// The owner's removal notice. Removed refs no longer exist in Ariadne.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RemovedNotice {
    pub refs: Vec<RemovedRef>,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RemovedRef {
    Item { r#ref: ItemRef, question: String },
    Topic { topic_id: UuidV4, name: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct InputTargetSnapshot {
    pub topic_name: String,
    pub item_question: Option<String>,
    pub question_revision: Option<PositiveSafeInteger>,
    pub ask: Option<String>,
    pub options: Vec<ItemOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct InputContext {
    pub message_ids: Vec<UuidV4>,
    pub item_ids: Vec<ItemRef>,
    pub round_id: Option<UuidV4>,
    pub continuation_operation_id: Option<UuidV4>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Attempt {
    pub id: UuidV4,
    pub purpose: AttemptPurpose,
    pub repair_for_attempt_id: Option<UuidV4>,
    pub claim_request_id: UuidV4,
    pub binding_generation: UuidV4,
    pub prepared_at: UtcMillis,
    pub formatted_payload: String,
    pub payload_sha256: Sha256,
    pub wire_marker: String,
    pub acceptance: AcceptanceState,
    pub acceptance_receipt: Option<HostReceipt>,
    pub acceptance_observed_at: Option<UtcMillis>,
    pub host_turn_id: Option<String>,
    pub turn_state: TurnState,
    pub turn_observed_at: Option<UtcMillis>,
    pub domain_result: Option<DomainResult>,
    pub result_state: ResultState,
    pub sealed_at: Option<UtcMillis>,
    pub error: Option<AttemptError>,
    pub reconciliation_checkpoint: Option<Checkpoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum AttemptPurpose {
    Work,
    ResultRepair,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum AcceptanceState {
    Prepared,
    Accepted,
    Rejected,
    Uncertain,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum TurnState {
    Unknown,
    Running,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ResultState {
    Pending,
    Committed,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct HostReceipt {
    pub provider_reference: String,
    pub observed_at: UtcMillis,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct DomainResult {
    pub operation_id: UuidV4,
    pub outcome: ResultOutcome,
    pub explanation: String,
    pub reply_message_ids: Vec<UuidV4>,
    pub followup_item_ids: Vec<ItemRef>,
    pub handled_through_message_number: NonnegativeSafeInteger,
    pub committed_revision: PositiveSafeInteger,
    pub committed_at: UtcMillis,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ResultOutcome {
    Answered,
    Deferred,
    Unable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AttemptError {
    pub code: String,
    pub reason: String,
    pub retryable: bool,
    pub observed_at: UtcMillis,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ResolutionHistoryEntry {
    pub op_id: UuidV4,
    pub kind: ResolutionKind,
    pub reason: String,
    pub at: UtcMillis,
    pub attempt_id: UuidV4,
    pub evidence: Option<OwnerResolutionEvidence>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ResolutionKind {
    RetryUnexecuted,
    Resend,
    Skip,
    RequestResultRepair,
    ConfirmEvidence,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct OwnerResolutionEvidence {
    pub source: OwnerEvidenceSource,
    pub turn_state: TurnState,
    pub host_turn_id: Option<String>,
    pub owner_attested_idle: bool,
    pub at: UtcMillis,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum OwnerEvidenceSource {
    OwnerAttestation,
}
