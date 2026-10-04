//! Small invalidation/routing records; snapshots remain authoritative backend reads.
use ariadne_domain::models::{ItemRef, PositiveSafeInteger, PresenceObservation, UuidV4};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SessionChangedHint {
    pub session_id: UuidV4,
    pub revision: PositiveSafeInteger,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PresenceChangedHint {
    pub binding_id: UuidV4,
    pub generation: UuidV4,
    pub observation: PresenceObservation,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct OpenRoute {
    pub project_id: UuidV4,
    pub session_id: UuidV4,
    pub item_id: Option<ItemRef>,
}
