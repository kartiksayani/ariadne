//! Stored entity declarations. Semantic validation belongs to P1.1.
use super::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Project {
    pub schema_version: SchemaVersion,
    pub id: UuidV4,
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Session {
    pub schema_version: SchemaVersion,
    pub id: UuidV4,
    pub project_id: UuidV4,
    pub title: String,
    // Owner-set name and one-line description (ADR-0091), absent in stores written
    // before them. Not doc comments: ts-rs renders field docs with trailing spaces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub description: Option<String>,
    pub state: SessionState,
    pub created_at: UtcMillis,
    pub updated_at: UtcMillis,
    pub revision: PositiveSafeInteger,
    pub closed_at: Option<UtcMillis>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub archived_at: Option<UtcMillis>,
    pub counters: SessionCounters,
    pub active_binding_id: Option<UuidV4>,
    pub topics: UniqueMap<UuidV4, Topic>,
    pub items: UniqueMap<ItemRef, Item>,
    pub messages: Vec<Message>,
    pub rounds: UniqueMap<UuidV4, Round>,
    pub answers: Vec<Answer>,
    pub bindings: UniqueMap<UuidV4, Binding>,
    pub inputs: UniqueMap<UuidV4, Input>,
    pub operation_receipts: UniqueMap<UuidV4, Vec<OperationReceipt>>,
    pub continuations: UniqueMap<UuidV4, ContinuationReceipt>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Active,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SessionCounters {
    pub next_root: PositiveSafeInteger,
    pub next_topic_order: PositiveSafeInteger,
    pub next_message: PositiveSafeInteger,
    pub next_input: PositiveSafeInteger,
    pub next_answer: PositiveSafeInteger,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Topic {
    pub id: UuidV4,
    pub name: String,
    // Agent-written 2-4 word label (ADR-0084), absent in stores written before it.
    // Not a doc comment: ts-rs renders field docs with trailing spaces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub short: Option<String>,
    pub order: PositiveSafeInteger,
    pub revision: PositiveSafeInteger,
    pub created_at: UtcMillis,
    pub archived_at: Option<UtcMillis>,
    pub origin: Option<TopicOrigin>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Item {
    pub id: ItemRef,
    pub ordinal: PositiveSafeInteger,
    pub topic_id: UuidV4,
    pub parent: Option<ItemRef>,
    pub question: String,
    // Agent-written 2-4 word label (ADR-0084), absent in stores written before it.
    // Not a doc comment: ts-rs renders field docs with trailing spaces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub short: Option<String>,
    #[serde(rename = "type")]
    pub item_type: ItemType,
    pub status: ItemStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub ack_to: Option<AckTarget>,
    pub owner: ItemOwner,
    pub revision: PositiveSafeInteger,
    pub question_revision: PositiveSafeInteger,
    pub next_child: PositiveSafeInteger,
    pub ask: Option<String>,
    pub note: Option<String>,
    pub options: Vec<ItemOption>,
    pub links: Vec<ItemLinkTarget>,
    pub outcome: Option<String>,
    pub why: Option<String>,
    pub replaced_by: Option<ItemRef>,
    pub created_at: UtcMillis,
    pub updated_at: UtcMillis,
    pub created_message_id: UuidV4,
    pub updated_message_ids: Vec<UuidV4>,
    pub status_history: Vec<StatusHistoryEntry>,
    pub waiting_since: Option<UtcMillis>,
    pub recipient_binding_id: Option<UuidV4>,
    pub current_round_id: Option<UuidV4>,
    pub source_round_id: Option<UuidV4>,
    pub origin: Option<ItemOrigin>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ItemType {
    Question,
    Decision,
    Finding,
    Task,
    Explanation,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    Open,
    WaitingOnMe,
    InProgress,
    Decided,
    Done,
    Dropped,
    Replaced,
}

/// Terminal state the agent proposes for an explicit owner acknowledgment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum AckTarget {
    Decided,
    Done,
    Dropped,
}
impl AckTarget {
    pub fn status(self) -> ItemStatus {
        match self {
            Self::Decided => ItemStatus::Decided,
            Self::Done => ItemStatus::Done,
            Self::Dropped => ItemStatus::Dropped,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ItemOwner {
    Me {},
    Agent { binding_id: UuidV4 },
    Other { name: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ItemOption {
    pub id: String,
    pub label: String,
    pub consequence: String,
    pub recommended: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ItemLinkTarget {
    pub kind: LinkKind,
    pub label: String,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum LinkKind {
    Pr,
    File,
    Doc,
    // A same-session item reference; `target` is the raw dotted item id.
    Item,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct StatusHistoryEntry {
    pub old_status: ItemStatus,
    pub new_status: ItemStatus,
    pub previous_outcome: Option<String>,
    pub previous_why: Option<String>,
    pub previous_replaced_by: Option<ItemRef>,
    pub cause_message_id: UuidV4,
    pub at: UtcMillis,
    pub binding_id: Option<UuidV4>,
    pub handled_through_message_number: NonnegativeSafeInteger,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub id: UuidV4,
    pub number: PositiveSafeInteger,
    pub author: MessageAuthor,
    pub kind: MessageKind,
    pub body: String,
    pub created_at: UtcMillis,
    pub item_id: Option<ItemRef>,
    pub topic_id: Option<UuidV4>,
    pub items_touched: Vec<ItemRef>,
    pub binding_id: Option<UuidV4>,
    pub input_id: Option<UuidV4>,
    pub attempt_id: Option<UuidV4>,
    pub host_turn_id: Option<String>,
    pub round_id: Option<UuidV4>,
    pub origin: Option<MessageOrigin>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum MessageAuthor {
    Owner,
    Agent,
    System,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    OwnerInput,
    Reply,
    Activity,
    Lifecycle,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Answer {
    pub id: UuidV4,
    pub seq: PositiveSafeInteger,
    pub item_id: ItemRef,
    pub question_revision: PositiveSafeInteger,
    pub question_snapshot: String,
    pub ask_snapshot: Option<String>,
    pub options_snapshot: Vec<ItemOption>,
    pub selected_option_id: Option<String>,
    pub text: String,
    pub message_id: UuidV4,
    pub input_id: UuidV4,
    pub supersedes_answer_id: Option<UuidV4>,
    pub created_at: UtcMillis,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Round {
    pub id: UuidV4,
    pub item_id: ItemRef,
    pub ordinal: PositiveSafeInteger,
    pub opened_message_id: UuidV4,
    pub question_snapshot: String,
    pub ask_snapshot: Option<String>,
    pub options_snapshot: Vec<ItemOption>,
    pub question_revision: PositiveSafeInteger,
    pub owner_message_ids: Vec<UuidV4>,
    pub agent_message_ids: Vec<UuidV4>,
    pub result_input_ids: Vec<UuidV4>,
    pub fork_item_ids: Vec<ItemRef>,
    pub closed_at: Option<UtcMillis>,
    pub origin: Option<RoundOrigin>,
}
