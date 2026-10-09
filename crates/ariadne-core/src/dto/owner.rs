//! Explicit owner command inventory; no owner status-write operation.
use super::{PreferencesPatch, SessionRef};
use ariadne_domain::models::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

macro_rules! owner_commands {
    ($($variant:ident($params:ty)),+ $(,)?) => {
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
        #[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
        pub enum OwnerCommand { $($variant { api_version: SchemaVersion, op_id: UuidV4, params: $params }),+ }
    };
}
owner_commands!(
    ProjectRegister(ProjectRegisterParams),
    BindingConnect(BindingConnectParams),
    BindingPause(BindingStateParams),
    BindingResume(BindingStateParams),
    BindingDisconnect(BindingStateParams),
    InputSubmit(InputSubmitParams),
    InputCancel(InputCancelParams),
    InputResolve(InputResolveParams),
    TopicArchive(TopicLifecycleParams),
    TopicRestore(TopicLifecycleParams),
    SessionClose(SessionLifecycleParams),
    SessionReopen(SessionLifecycleParams),
    SessionArchive(SessionLifecycleParams),
    SessionRestore(SessionRestoreParams),
    TopicContinue(TopicContinueParams),
    PreferencesPatch(PreferencesPatch),
    ItemRemove(ItemRemoveParams),
    TopicRemove(TopicLifecycleParams),
    SessionRemove(SessionRemoveParams),
    ProjectRemove(ProjectRemoveParams),
    SessionLabelSet(SessionLabelParams),
);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ProjectRegisterParams {
    pub canonical_root: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct BindingConnectParams {
    pub project_id: UuidV4,
    pub adapter_id: String,
    pub external_session_id: String,
    pub endpoint: EndpointRef,
    pub configuration: AdapterConfig,
    pub existing_session_id: Option<UuidV4>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct BindingStateParams {
    pub binding_id: UuidV4,
    pub expected_generation: UuidV4,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct InputSubmitParams {
    pub binding_id: UuidV4,
    pub target: InputTarget,
    pub kind: InputKind,
    pub text: String,
    pub selected_option_id: Option<String>,
    pub expected_question_revision: Option<PositiveSafeInteger>,
    pub supersedes_answer_id: Option<UuidV4>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct InputCancelParams {
    pub input_id: UuidV4,
    pub expected_revision: PositiveSafeInteger,
    // Why the owner cancels: delete (the default when absent) or take it back
    // to edit. Recorded as the input's `cancel_cause` (Owner or OwnerEdit).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub purpose: Option<CancelPurpose>,
}
/// What an owner `input_cancel` is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum CancelPurpose {
    /// Delete the message: it is not sent.
    Delete,
    /// Take the message back to edit: only a message still queued can be.
    Edit,
}
impl CancelPurpose {
    /// The cause recorded on the cancelled input.
    pub fn cause(self) -> CancelCause {
        match self {
            Self::Delete => CancelCause::Owner,
            Self::Edit => CancelCause::OwnerEdit,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct InputResolveParams {
    pub input_id: UuidV4,
    pub attempt_id: UuidV4,
    pub decision: ResolutionKind,
    pub reason: String,
    pub expected_revision: PositiveSafeInteger,
    pub evidence: Option<OwnerResolutionEvidence>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct TopicLifecycleParams {
    pub topic_id: UuidV4,
    pub expected_revision: PositiveSafeInteger,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SessionLifecycleParams {
    pub expected_revision: PositiveSafeInteger,
}
/// Restore normally leaves the session Closed. Undo of an active archive
/// requests reopening in the same revision-guarded transaction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SessionRestoreParams {
    pub expected_revision: PositiveSafeInteger,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub reopen: bool,
}
/// Replaces the routed session's owner-set name and description. `null` or a
/// blank string clears a field (the session falls back to its agent label).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SessionLabelParams {
    pub name: Option<String>,
    pub description: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct TopicContinueParams {
    pub source: SessionRef,
    pub source_topic_id: UuidV4,
    pub source_revision: PositiveSafeInteger,
    pub source_sha256: Sha256,
    pub target: SessionRef,
    pub target_binding_id: UuidV4,
    pub summary: String,
}

/// Removes the item and everything below it (session route).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ItemRemoveParams {
    pub item_id: ItemRef,
    pub expected_revision: PositiveSafeInteger,
}
/// Uses `session: null` so an exact retry still replays after the file is gone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SessionRemoveParams {
    pub project_id: UuidV4,
    pub session_id: UuidV4,
    pub expected_revision: PositiveSafeInteger,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ProjectRemoveParams {
    pub project_id: UuidV4,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum MutationReceipt {
    Session(Box<SavedReceipt>),
    ProjectRegistered(ProjectRegisteredReceipt),
    PreferencesPatched(PreferencesPatchedReceipt),
    Removed(RemovedReceipt),
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum RemovedScope {
    Session,
    Project,
}
/// Session or project removal. `backup` is the absolute path of the
/// pre-remove snapshot (a file for a session, a directory for a project).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RemovedReceipt {
    pub operation_id: UuidV4,
    pub scope: RemovedScope,
    pub project_id: UuidV4,
    pub session_ids: Vec<UuidV4>,
    pub backup: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ProjectRegisteredReceipt {
    pub operation_id: UuidV4,
    pub project_id: UuidV4,
    pub registry_revision: PositiveSafeInteger,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PreferencesPatchedReceipt {
    pub operation_id: UuidV4,
    pub preferences_revision: PositiveSafeInteger,
}

pub type ApplyReceipt = SavedReceipt;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct OwnerQueryRequest {
    pub session: Option<SessionRef>,
    pub request: super::QueryRequest,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct OwnerMutationRequest {
    pub session: Option<SessionRef>,
    pub command: OwnerCommand,
}
