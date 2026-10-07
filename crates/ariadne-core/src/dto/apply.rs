//! Agent command declarations import canonical domain records.
use ariadne_domain::models::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Schema description of the optional `short` label on created topics and items
/// (ADR-0084). Field doc comments are avoided: ts-rs renders them with trailing spaces.
const SHORT_LABEL: &str = "Optional 2-4 word label; trimmed, one line, at most 40 characters.";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplyRequest {
    pub op_id: UuidV4,
    pub source_input_id: Option<UuidV4>,
    pub attempt_id: Option<UuidV4>,
    pub expected_item_revisions: UniqueMap<ItemRef, PositiveSafeInteger>,
    pub expected_topic_revisions: UniqueMap<UuidV4, PositiveSafeInteger>,
    pub summary: String,
    pub operations: Vec<Operation>,
    pub input_result: Option<ResultDraft>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum EntityRef {
    Existing(ExistingRef),
    Local(LocalRef),
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ExistingRef {
    pub id: ItemRef,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct LocalRef {
    pub r#ref: RequestRef,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum UuidRef {
    Existing(ExistingUuidRef),
    Local(LocalRef),
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ExistingUuidRef {
    pub id: UuidV4,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "op", deny_unknown_fields)]
pub enum Operation {
    #[serde(rename = "topic.add")]
    TopicAdd {
        r#ref: RequestRef,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(length(max = 40), description = SHORT_LABEL)]
        #[ts(optional = nullable)]
        short: Option<String>,
    },
    #[serde(rename = "item.add")]
    ItemAdd(Box<ItemAddOperation>),
    #[serde(rename = "item.edit")]
    ItemEdit { item: EntityRef, patch: ItemPatch },
    #[serde(rename = "item.ask")]
    ItemAsk {
        item: EntityRef,
        ask: String,
        options: Vec<ItemOption>,
        recipient_binding_id: UuidV4,
    },
    #[serde(rename = "item.status")]
    ItemStatus {
        item: EntityRef,
        status: ItemStatus,
        outcome: Option<String>,
        why: Option<String>,
        reason: Option<String>,
    },
    #[serde(rename = "item.replace")]
    ItemReplace {
        item: EntityRef,
        replacement: EntityRef,
        outcome: String,
        why: String,
    },
    #[serde(rename = "reply")]
    Reply {
        r#ref: RequestRef,
        item: EntityRef,
        text: String,
        round_id: Option<UuidV4>,
    },
    #[serde(rename = "round.close")]
    RoundClose { round_id: UuidV4 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ItemPatch {
    pub question: Option<String>,
    #[serde(rename = "type")]
    pub item_type: Option<ItemType>,
    #[serde(
        default,
        deserialize_with = "crate::wire::nullable_patch",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional, type = "string | null")]
    pub note: Option<Option<String>>,
    pub links: Option<Vec<ItemLinkTarget>>,
    #[serde(
        default,
        deserialize_with = "crate::wire::nullable_patch",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(
        length(max = 40),
        description = "Absent keeps the label, null clears it, a string replaces it (trimmed)."
    )]
    #[ts(optional, type = "string | null")]
    pub short: Option<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ResultDraft {
    pub outcome: ResultOutcome,
    pub explanation: String,
    pub reply_refs: Vec<UuidRef>,
    pub followup_item_refs: Vec<EntityRef>,
    pub handled_through_message_number: PositiveSafeInteger,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ItemAddOperation {
    pub r#ref: RequestRef,
    pub topic: UuidRef,
    pub parent: Option<EntityRef>,
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 40), description = SHORT_LABEL)]
    #[ts(optional = nullable)]
    pub short: Option<String>,
    #[serde(rename = "type")]
    pub item_type: ItemType,
    pub status: ItemStatus,
    pub owner: ItemOwner,
    pub ask: Option<String>,
    pub options: Option<Vec<ItemOption>>,
    pub note: Option<String>,
    pub links: Option<Vec<ItemLinkTarget>>,
    pub outcome: Option<String>,
    pub why: Option<String>,
    pub replaced_by: Option<EntityRef>,
    pub source_round_id: Option<UuidV4>,
}
