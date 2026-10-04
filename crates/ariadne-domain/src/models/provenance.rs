//! Canonical continuation provenance declarations.
use super::{ItemRef, MessageAuthor, PositiveSafeInteger, UtcMillis, UuidV4};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct TopicOrigin {
    pub project_id: UuidV4,
    pub session_id: UuidV4,
    pub topic_id: UuidV4,
    pub source_revision: PositiveSafeInteger,
    pub continued_at: UtcMillis,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ItemOrigin {
    pub project_id: UuidV4,
    pub session_id: UuidV4,
    pub topic_id: UuidV4,
    pub entity_id: ItemRef,
    pub source_revision: PositiveSafeInteger,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RoundOrigin {
    pub project_id: UuidV4,
    pub session_id: UuidV4,
    pub topic_id: UuidV4,
    pub entity_id: UuidV4,
    pub source_revision: PositiveSafeInteger,
}

/// Historical direct route; these qualified IDs never provide local routing or authority.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct MessageSourceTarget {
    pub project_id: UuidV4,
    pub session_id: UuidV4,
    pub topic_id: Option<UuidV4>,
    pub item_id: Option<ItemRef>,
    pub round_id: Option<UuidV4>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct MessageOrigin {
    pub source_target: MessageSourceTarget,
    pub project_id: UuidV4,
    pub session_id: UuidV4,
    pub topic_id: UuidV4,
    pub entity_id: UuidV4,
    pub source_revision: PositiveSafeInteger,
    pub author: MessageAuthor,
    pub binding_id: Option<UuidV4>,
    pub adapter_id: Option<String>,
    pub external_session_id: Option<String>,
}
