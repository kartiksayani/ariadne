//! Claims describe a persisted preparation, never host acceptance.
use ariadne_domain::models::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ClaimRequest {
    pub binding_id: UuidV4,
    pub generation: UuidV4,
    pub request_id: UuidV4,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PreparedAttempt {
    pub input_id: UuidV4,
    pub attempt_id: UuidV4,
    pub binding_generation: UuidV4,
    pub formatted_payload: String,
    pub payload_sha256: Sha256,
    pub wire_marker: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct EventReceipt {
    pub event_id: String,
    pub session_id: UuidV4,
    pub revision: Option<PositiveSafeInteger>,
    pub durable_effect: bool,
    pub replayed: bool,
}
