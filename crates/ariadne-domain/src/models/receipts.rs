//! Typed durable replay and continuation receipts; no command union.
use super::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReceiptActorScope {
    Owner {},
    Agent { binding_id: UuidV4 },
    Adapter { binding_id: UuidV4 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct OperationReceipt {
    pub operation_id: UuidV4,
    pub actor_scope: ReceiptActorScope,
    pub command_digest: Sha256,
    pub result: SavedReceipt,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SavedReceipt {
    pub operation_id: UuidV4,
    pub session_id: UuidV4,
    pub revision: PositiveSafeInteger,
    pub data: SavedReceiptData,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SavedReceiptData {
    InputSubmit {
        input_id: UuidV4,
        message_id: UuidV4,
        message_number: PositiveSafeInteger,
        answer_id: Option<UuidV4>,
        input_seq: PositiveSafeInteger,
    },
    InputCancel {
        input_id: UuidV4,
        state: InputState,
    },
    InputResolve {
        input_id: UuidV4,
        attempt_id: UuidV4,
        resolution_kind: ResolutionKind,
        state: InputState,
    },
    TopicLifecycle {
        topic_id: UuidV4,
        topic_revision: PositiveSafeInteger,
        archived_at: Option<UtcMillis>,
        // Unsent owner inputs an archive cancelled (queued, in flight or
        // needing attention), as session close lists them.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[ts(as = "Option<Vec<UuidV4>>", optional)]
        cancelled_input_ids: Vec<UuidV4>,
    },
    SessionLifecycle {
        state: SessionState,
        closed_at: Option<UtcMillis>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        archived_at: Option<UtcMillis>,
        // Inputs a close cancelled (queued, in flight or needing attention).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[ts(as = "Option<Vec<UuidV4>>", optional)]
        cancelled_input_ids: Vec<UuidV4>,
    },
    /// Owner rename: the name and description now stored (`None` when cleared).
    SessionLabel {
        name: Option<String>,
        description: Option<String>,
    },
    BindingConnect {
        binding_id: UuidV4,
        generation: UuidV4,
        capabilities: Capabilities,
        setup_instruction: String,
    },
    BindingState {
        binding_id: UuidV4,
        generation: UuidV4,
        dispatch_state: DispatchState,
        owner_paused: bool,
        pause_reason: Option<PauseReason>,
        connection_state: ConnectionState,
    },
    Apply {
        allocated_refs: UniqueMap<RequestRef, AllocatedRef>,
        messages: Vec<MessageIdentity>,
        item_revisions: UniqueMap<ItemRef, PositiveSafeInteger>,
        topic_revisions: UniqueMap<UuidV4, PositiveSafeInteger>,
        input_result_state: Option<ResultState>,
        queue_join_state: Option<InputState>,
    },
    Claim {
        input_id: UuidV4,
        attempt_id: UuidV4,
    },
    DeliveryExpiry {
        input_id: UuidV4,
        attempt_id: UuidV4,
    },
    Event {
        event_id: String,
        input_id: Option<UuidV4>,
        attempt_id: Option<UuidV4>,
        durable_effect: bool,
    },
    EventConflict {
        event_id: String,
        input_id: Option<UuidV4>,
        attempt_id: Option<UuidV4>,
    },
    Continuation {
        continuation: ContinuationReceipt,
    },
    /// Owner item/topic removal in this session. `family` lists every
    /// session/topic pair a topic removal covers (empty for an item removal).
    Removal {
        item_ids: Vec<ItemRef>,
        topic_ids: Vec<UuidV4>,
        input_ids: Vec<UuidV4>,
        family: Vec<RemovalTarget>,
        notice: Option<RemovalTarget>,
        backup: String,
    },
}

/// A session-qualified topic (family member) or notice input.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RemovalTarget {
    pub session_id: UuidV4,
    pub id: UuidV4,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AllocatedRef {
    Topic { id: UuidV4 },
    Item { id: ItemRef },
    Message { id: UuidV4 },
    Round { id: UuidV4 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct MessageIdentity {
    pub id: UuidV4,
    pub number: PositiveSafeInteger,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ContinuationReceipt {
    pub operation_id: UuidV4,
    pub source_project_id: UuidV4,
    pub source_session_id: UuidV4,
    pub source_topic_id: UuidV4,
    pub source_revision: PositiveSafeInteger,
    pub source_sha256: Sha256,
    pub target_topic_id: UuidV4,
    pub target_input_id: UuidV4,
    pub item_id_map: UniqueMap<ItemRef, ItemRef>,
    pub message_id_map: UniqueMap<UuidV4, UuidV4>,
    pub round_id_map: UniqueMap<UuidV4, UuidV4>,
    pub answer_id_map: UniqueMap<UuidV4, UuidV4>,
    pub summary: String,
    pub confirmed_at: UtcMillis,
}
