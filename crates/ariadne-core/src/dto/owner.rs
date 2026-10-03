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
    TopicContinue(TopicContinueParams),
    PreferencesPatch(PreferencesPatch),
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum MutationReceipt {
    Session(Box<SavedReceipt>),
    ProjectRegistered(ProjectRegisteredReceipt),
    PreferencesPatched(PreferencesPatchedReceipt),
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
