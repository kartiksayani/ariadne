//! Bounded agent change history; absent fields are unchanged, null is empty.
use super::*;
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ItemChangeRecord {
    pub revision: PositiveSafeInteger,
    pub at: UtcMillis,
    pub cause_message_id: UuidV4,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub wording_only: bool,
    pub before: ItemChangeBefore,
}

fn present_nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ItemChangeBefore {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nullable"
    )]
    #[ts(as = "Option<String>", optional = nullable)]
    pub question: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nullable"
    )]
    #[ts(as = "Option<String>", optional = nullable)]
    pub short: Option<Option<String>>,
    #[serde(
        rename = "type",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nullable"
    )]
    #[ts(as = "Option<ItemType>", optional = nullable)]
    pub item_type: Option<Option<ItemType>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nullable"
    )]
    #[ts(as = "Option<ItemStatus>", optional = nullable)]
    pub status: Option<Option<ItemStatus>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nullable"
    )]
    #[ts(as = "Option<String>", optional = nullable)]
    pub note: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nullable"
    )]
    #[ts(as = "Option<String>", optional = nullable)]
    pub ask: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nullable"
    )]
    #[ts(as = "Option<Vec<ItemOption>>", optional = nullable)]
    pub options: Option<Option<Vec<ItemOption>>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nullable"
    )]
    #[ts(as = "Option<String>", optional = nullable)]
    pub outcome: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nullable"
    )]
    #[ts(as = "Option<String>", optional = nullable)]
    pub why: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nullable"
    )]
    #[ts(as = "Option<Vec<ItemLinkTarget>>", optional = nullable)]
    pub links: Option<Option<Vec<ItemLinkTarget>>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nullable"
    )]
    #[ts(as = "Option<Vec<ItemRef>>", optional = nullable)]
    pub related: Option<Option<Vec<ItemRef>>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nullable"
    )]
    #[ts(as = "Option<Vec<ItemRef>>", optional = nullable)]
    pub affects: Option<Option<Vec<ItemRef>>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nullable"
    )]
    #[ts(as = "Option<Vec<ItemRef>>", optional = nullable)]
    pub depends_on: Option<Option<Vec<ItemRef>>>,
}
