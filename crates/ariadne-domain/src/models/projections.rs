//! Canonical bounded query records. Query execution belongs to later tasks.
use super::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SummaryCounts {
    pub items_by_status: ItemsByStatus,
    pub waiting_unanswered: NonnegativeSafeInteger,
    pub sent_inputs: SentInputCounts,
    pub archived_topics: NonnegativeSafeInteger,
    pub completeness: Completeness,
    pub unavailable_session_ids: Vec<UuidV4>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ItemsByStatus {
    pub open: NonnegativeSafeInteger,
    pub waiting_on_me: NonnegativeSafeInteger,
    pub in_progress: NonnegativeSafeInteger,
    pub decided: NonnegativeSafeInteger,
    pub done: NonnegativeSafeInteger,
    pub dropped: NonnegativeSafeInteger,
    pub replaced: NonnegativeSafeInteger,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SentInputCounts {
    pub queued: NonnegativeSafeInteger,
    pub in_flight: NonnegativeSafeInteger,
    pub needs_attention: NonnegativeSafeInteger,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum Completeness {
    Complete,
    Partial,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct QueryCursor {
    pub schema: SchemaVersion,
    pub view: QueryView,
    pub filter_digest: Sha256,
    pub after: Option<CursorPosition>,
    pub revision: PositiveSafeInteger,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum QueryView {
    Projects,
    Sessions,
    Topics,
    Items,
    Messages,
    Inputs,
    ItemMessages,
    ItemRounds,
    RoundAnswers,
    RoundOwnerMessages,
    RoundAgentMessages,
    RoundResults,
    RoundForks,
    ItemStatusHistory,
    ItemUpdatedMessages,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CursorPosition {
    Sequence {
        number: PositiveSafeInteger,
        id: UuidV4,
    },
    Topic {
        order: PositiveSafeInteger,
        id: UuidV4,
    },
    Item {
        ordinals: Vec<PositiveSafeInteger>,
        id: ItemRef,
    },
    Round {
        ordinal: PositiveSafeInteger,
        id: UuidV4,
    },
    Project {
        canonical_root: String,
        id: UuidV4,
    },
    Session {
        updated_at: UtcMillis,
        project_id: UuidV4,
        id: UuidV4,
    },
    History {
        index: NonnegativeSafeInteger,
    },
    Result {
        input_seq: PositiveSafeInteger,
        attempt_ordinal: PositiveSafeInteger,
        input_id: UuidV4,
        attempt_id: UuidV4,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "Page_{T}")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<QueryCursor>,
    pub snapshot_revision: PositiveSafeInteger,
}

/// All current item fields except unbounded updated-message and status-history arrays.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ItemSnapshot {
    pub id: ItemRef,
    pub ordinal: PositiveSafeInteger,
    pub topic_id: UuidV4,
    pub parent: Option<ItemRef>,
    pub question: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub related: Option<Vec<ItemRef>>,
    pub outcome: Option<String>,
    pub why: Option<String>,
    pub replaced_by: Option<ItemRef>,
    pub created_at: UtcMillis,
    pub updated_at: UtcMillis,
    pub created_message_id: UuidV4,
    pub waiting_since: Option<UtcMillis>,
    pub recipient_binding_id: Option<UuidV4>,
    pub current_round_id: Option<UuidV4>,
    pub source_round_id: Option<UuidV4>,
    pub origin: Option<ItemOrigin>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ItemReadProjection {
    pub item: ItemSnapshot,
    pub updated_messages: Page<Message>,
    pub status_history: Page<StatusHistoryEntry>,
}

/// Frozen round fields; each historical list has an independent page below.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RoundSnapshot {
    pub id: UuidV4,
    pub item_id: ItemRef,
    pub ordinal: PositiveSafeInteger,
    pub opened_message_id: UuidV4,
    pub question_snapshot: String,
    pub ask_snapshot: Option<String>,
    pub options_snapshot: Vec<ItemOption>,
    pub question_revision: PositiveSafeInteger,
    pub closed_at: Option<UtcMillis>,
    pub origin: Option<RoundOrigin>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RoundProjection {
    pub round: RoundSnapshot,
    pub answers: Page<Answer>,
    pub owner_messages: Page<Message>,
    pub agent_messages: Page<Message>,
    pub results: Page<ResultProjection>,
    pub forks: Page<ItemLink>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ResultProjection {
    pub input_id: UuidV4,
    pub attempt_id: UuidV4,
    pub result: DomainResult,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ItemLink {
    pub project_id: UuidV4,
    pub session_id: UuidV4,
    pub item_id: ItemRef,
    pub question: String,
    pub status: ItemStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ItemMessagesProjection {
    pub item_id: ItemRef,
    pub messages: Page<Message>,
    pub timeline_context: TimelineContext,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct TimelineContext {
    pub parent_item_id: Option<ItemRef>,
    pub created_message: Option<Message>,
    pub source_round_id: Option<UuidV4>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ItemRoundsProjection {
    pub item_id: ItemRef,
    pub rounds: Page<RoundProjection>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ProjectSummary {
    pub project_id: UuidV4,
    #[serde(deserialize_with = "Option::<Project>::deserialize")]
    pub project: Option<Project>,
    pub canonical_root: String,
    pub availability: ProjectAvailability,
    pub counts: SummaryCounts,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ProjectAvailability {
    Available,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SessionSummary {
    pub project_id: UuidV4,
    pub session_id: UuidV4,
    pub title: String,
    // The session's owner-set name and description (ADR-0091).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub description: Option<String>,
    pub state: SessionState,
    pub revision: PositiveSafeInteger,
    pub created_at: UtcMillis,
    pub updated_at: UtcMillis,
    pub closed_at: Option<UtcMillis>,
    pub active_binding: Option<BindingSummary>,
    pub counts: SummaryCounts,
    // Every topic in the session, archived included; `counts.archived_topics`
    // is the archived subset.
    pub topic_count: NonnegativeSafeInteger,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct BindingSummary {
    pub id: UuidV4,
    pub adapter_id: String,
    pub external_session_id: String,
    pub generation: UuidV4,
    pub dispatch_state: DispatchState,
    pub owner_paused: bool,
    pub pause_reason: Option<PauseReason>,
    pub connection_state: ConnectionState,
    pub presence: Option<PresenceObservation>,
    // The binding's `host_location` (ADR-0085).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub host_location: Option<String>,
}
