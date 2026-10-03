//! Application envelopes and explicit model-tool routing, generated from Rust.
use crate::service::*;
pub use crate::wire::{FailureFlag, SuccessFlag};
use ariadne_domain::models::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
#[schemars(rename = "ApplicationEnvelope_{T}")]
pub enum ApplicationEnvelope<T> {
    Success(SuccessEnvelope<T>),
    Failure(FailureEnvelope),
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "SuccessEnvelope_{T}")]
pub struct SuccessEnvelope<T> {
    pub api_version: SchemaVersion,
    pub ok: SuccessFlag,
    pub data: T,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct FailureEnvelope {
    pub api_version: SchemaVersion,
    pub ok: FailureFlag,
    pub error: CoreError,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentApplyToolRequest {
    pub binding_id: UuidV4,
    pub generation: UuidV4,
    pub request: ApplyRequest,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentReadToolRequest {
    pub binding_id: UuidV4,
    pub generation: UuidV4,
    pub source_input_id: Option<UuidV4>,
    pub attempt_id: Option<UuidV4>,
    pub params: SessionReadRequest,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentMessagesToolRequest {
    pub binding_id: UuidV4,
    pub generation: UuidV4,
    pub source_input_id: Option<UuidV4>,
    pub attempt_id: Option<UuidV4>,
    pub params: ItemMessagesRequest,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentRoundsToolRequest {
    pub binding_id: UuidV4,
    pub generation: UuidV4,
    pub source_input_id: Option<UuidV4>,
    pub attempt_id: Option<UuidV4>,
    pub params: ItemRoundsRequest,
}

// Named transparent roots preserve the same wire envelope and generate distinct
// reusable schema/TS names; Rust type aliases erase those names during derivation.
macro_rules! envelope_root {
    ($($name:ident($data:ty)),+ $(,)?) => { $(
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
        #[serde(transparent)]
        pub struct $name(pub ApplicationEnvelope<$data>);
    )+ };
}
envelope_root!(
    QueryEnvelope(QueryResult),
    MutationEnvelope(MutationReceipt),
    ApplyEnvelope(ApplyReceipt),
    ClaimEnvelope(Option<PreparedAttempt>),
    ReportEnvelope(EventReceipt)
);
