//! Owned read requests/results. All historical pages reuse domain cursor scopes.
use super::preferences::*;
use ariadne_domain::models::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(
    tag = "command",
    content = "params",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum QueryRequest {
    ProjectList(ProjectListRequest),
    SessionList(SessionListRequest),
    SessionGet {},
    SessionRead(SessionReadRequest),
    ItemMessages(ItemMessagesRequest),
    ItemRounds(ItemRoundsRequest),
    TopicContinuePreview(ContinuePreviewRequest),
    PreferencesGet {},
    RevealItem { item_id: ItemRef },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ProjectListRequest {
    pub cursor: Option<QueryCursor>,
    pub limit: PageLimit,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SessionListRequest {
    pub project_id: Option<UuidV4>,
    pub state: Option<SessionState>,
    pub cursor: Option<QueryCursor>,
    pub limit: PageLimit,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SessionRef {
    pub project_id: UuidV4,
    pub session_id: UuidV4,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ItemRoute {
    pub project_id: UuidV4,
    pub session_id: UuidV4,
    pub item_id: ItemRef,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(
    tag = "view",
    content = "filters",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ReadView {
    Topics {
        archived: Option<bool>,
    },
    Items {
        topic_id: Option<UuidV4>,
        item_id: Option<ItemRef>,
        parent_item_id: Option<ItemRef>,
        statuses: Vec<ItemStatus>,
        archived: Option<bool>,
    },
    Messages {
        topic_id: Option<UuidV4>,
        item_id: Option<ItemRef>,
    },
    Inputs {
        topic_id: Option<UuidV4>,
        item_id: Option<ItemRef>,
        states: Vec<InputState>,
    },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SessionReadRequest {
    pub selection: ReadView,
    pub cursor: Option<QueryCursor>,
    pub limit: PageLimit,
    pub item_pages: Vec<ItemPageRequest>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "view", rename_all = "snake_case", deny_unknown_fields)]
pub enum ItemPageRequest {
    ItemUpdatedMessages {
        item_id: ItemRef,
        cursor: Option<QueryCursor>,
        limit: PageLimit,
    },
    ItemStatusHistory {
        item_id: ItemRef,
        cursor: Option<QueryCursor>,
        limit: PageLimit,
    },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ItemMessagesRequest {
    pub item_id: ItemRef,
    pub cursor: Option<QueryCursor>,
    pub limit: PageLimit,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ItemRoundsRequest {
    pub item_id: ItemRef,
    pub cursor: Option<QueryCursor>,
    pub limit: PageLimit,
    pub round_pages: Vec<RoundPageRequest>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "view", rename_all = "snake_case", deny_unknown_fields)]
pub enum RoundPageRequest {
    RoundAnswers {
        round_id: UuidV4,
        cursor: Option<QueryCursor>,
        limit: PageLimit,
    },
    RoundOwnerMessages {
        round_id: UuidV4,
        cursor: Option<QueryCursor>,
        limit: PageLimit,
    },
    RoundAgentMessages {
        round_id: UuidV4,
        cursor: Option<QueryCursor>,
        limit: PageLimit,
    },
    RoundResults {
        round_id: UuidV4,
        cursor: Option<QueryCursor>,
        limit: PageLimit,
    },
    RoundForks {
        round_id: UuidV4,
        cursor: Option<QueryCursor>,
        limit: PageLimit,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
// One result is built per query and sent straight to the wire; boxing the session snapshot
// would change this public enum and every consumer for no saving.
#[allow(clippy::large_enum_variant)]
pub enum QueryResult {
    ProjectList(ProjectListResult),
    SessionList(SessionListResult),
    SessionGet(SessionSnapshot),
    SessionRead(SessionReadResult),
    ItemMessages(Box<ItemMessagesProjection>),
    ItemRounds(ItemRoundsProjection),
    TopicContinuePreview(ContinuePreview),
    PreferencesGet(PreferencesSnapshot),
    RevealItem(ItemRoute),
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ProjectListResult {
    pub projects: Page<ProjectSummary>,
    pub counts: SummaryCounts,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SessionListResult {
    pub sessions: Page<SessionSummary>,
    pub active_total: NonnegativeSafeInteger,
    pub closed_total: NonnegativeSafeInteger,
    pub counts: SummaryCounts,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SessionSnapshot {
    pub session: Session,
    pub freshness: Freshness,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(
    tag = "view",
    content = "page",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum SessionReadResult {
    Topics(Page<Topic>),
    Items(Page<ItemReadProjection>),
    Messages(Page<Message>),
    Inputs(Page<Input>),
    InputsQueue(Page<InputQueueEntry>),
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct InputQueueEntry {
    pub id: UuidV4,
    pub seq: PositiveSafeInteger,
    pub binding_id: UuidV4,
    pub state: InputState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ContinuePreviewRequest {
    pub source: SessionRef,
    pub source_topic_id: UuidV4,
    pub target: SessionRef,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ContinuePreview {
    pub source: SessionRef,
    pub source_topic_id: UuidV4,
    pub source_revision: PositiveSafeInteger,
    pub source_sha256: Sha256,
    pub target: SessionRef,
    pub summary: String,
    pub mapping: Vec<ContinueItemPreview>,
    pub readiness: ContinueReadiness,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ContinueItemPreview {
    pub source_item_id: ItemRef,
    pub action: ContinueCopyAction,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ContinueCopyAction {
    Copy {},
    ImportedDrop {
        external_replacement_id: ItemRef,
        outcome: String,
        why: String,
    },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ContinueReadiness {
    Ready {
        binding_id: UuidV4,
        generation: UuidV4,
        host_available: bool,
    },
    Blocked {
        reasons: Vec<ContinueBlockReason>,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ContinueBlockReason {
    SameSession,
    TargetClosed,
    BindingUnknown,
    BindingAmbiguous,
    BindingInvalid,
    TargetUnavailable,
}

// Implemented outside this declaration module so executable validation is measured.
pub use crate::wire::PageLimit;
