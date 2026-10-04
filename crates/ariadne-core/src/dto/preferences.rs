//! Local owner-only UI preferences; never submitted domain Input or agent data.
use super::query::{ItemRoute, SessionRef};
use ariadne_domain::models::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PreferencesSnapshot {
    pub schema_version: SchemaVersion,
    pub revision: PositiveSafeInteger,
    pub global: GlobalPreferences,
    pub sessions: Vec<SessionPreferences>,
    pub later: Vec<ItemRoute>,
    pub drafts: Vec<OwnerDraft>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct GlobalPreferences {
    pub theme: Theme,
    pub selected_navigation: NavigationSelection,
    pub window: Option<WindowGeometry>,
    pub pinned: bool,
    pub notification_watermark: Option<UtcMillis>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 256))]
    #[ts(as = "Option<Vec<NotificationEpisode>>", optional)]
    pub notification_ledger: Vec<NotificationEpisode>,
    #[serde(default, skip_serializing_if = "is_false")]
    #[ts(as = "Option<bool>", optional)]
    pub notification_preview: bool,
}

fn is_false(value: &bool) -> bool {
    !value
}

pub const NOTIFICATION_LEDGER_CAPACITY: usize = 256;

/// Waiting episode identity is item + question revision within a registered session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct NotificationEpisode {
    pub session: SessionRef,
    pub item_id: ItemRef,
    pub question_revision: PositiveSafeInteger,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum NavigationSelection {
    Projects {},
    AllSessions {},
    Project { project_id: UuidV4 },
    Session { session: SessionRef },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    System,
    Light,
    Dark,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct WindowGeometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub monitor_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SessionPreferences {
    pub session: SessionRef,
    pub tab_open: bool,
    pub selected_item_id: Option<ItemRef>,
    pub tab_order: NonnegativeSafeInteger,
    pub expanded_item_ids: Vec<ItemRef>,
    pub filters: ViewFilters,
    pub rail: RailView,
    pub scroll: Option<ScrollAnchor>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ViewFilters {
    pub search: String,
    pub statuses: Vec<ItemStatus>,
    pub owners: Vec<ItemOwner>,
    pub topic_id: Option<UuidV4>,
    pub archived: bool,
    pub hide_later: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum RailView {
    Waiting,
    Sent,
    Activity,
    Hidden,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ScrollAnchor {
    pub item_id: Option<ItemRef>,
    pub offset: f64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct OwnerDraft {
    pub op_id: UuidV4,
    pub session: SessionRef,
    pub binding_id: UuidV4,
    pub target: InputTarget,
    pub intent: InputKind,
    pub text: String,
    pub selected_option_id: Option<String>,
    pub target_revision: PositiveSafeInteger,
    pub question_revision: Option<PositiveSafeInteger>,
    pub supersedes_answer_id: Option<UuidV4>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PreferencesPatch {
    pub expected_preferences_revision: PositiveSafeInteger,
    pub entries: Vec<PreferencesPatchEntry>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PreferencesPatchEntry {
    SetGlobal { preferences: GlobalPreferences },
    SetSessionView { preferences: SessionPreferences },
    SetLater { item: ItemRoute, later: bool },
    UpsertDraft { draft: OwnerDraft },
    DeleteDraft { operation_id: UuidV4 },
}
