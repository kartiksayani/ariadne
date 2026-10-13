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
    #[serde(deserialize_with = "crate::native::session_preferences_without_legacy_rail")]
    pub sessions: Vec<SessionPreferences>,
    pub later: Vec<ItemRoute>,
    pub drafts: Vec<OwnerDraft>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<SessionSeen>>", optional)]
    pub seen: Vec<SessionSeen>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 10_000))]
    #[ts(as = "Option<Vec<UuidV4>>", optional)]
    pub resolved_unsent_input_ids: Vec<UuidV4>,
}

pub const RESOLVED_UNSENT_INPUT_CAPACITY: usize = 10_000;
/// Ordinary preferences retain their original envelope budget. Recovery IDs
/// and revision metadata have a separate bounded allowance so older writers
/// cannot crowd them out.
pub const PREFERENCES_RESPONSE_BYTES: usize = 1024 * 1024;
pub const RECOVERY_RESPONSE_BYTES: usize = 400 * 1024;
pub const SEEN_ITEMS_CAPACITY: usize = 10_000;
pub const SEEN_TOPICS_CAPACITY: usize = 1_024;

/// Owner browsing state is kept independently of session view preferences.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SessionSeen {
    pub session: SessionRef,
    pub since: UtcMillis,
    #[schemars(length(max = 10_000))]
    pub items: Vec<ItemSeen>,
    #[schemars(length(max = 1_024))]
    pub topics: Vec<TopicSeen>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ItemSeen {
    pub item_id: ItemRef,
    pub revision: PositiveSafeInteger,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct TopicSeen {
    pub topic_id: UuidV4,
    pub at: UtcMillis,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct GlobalPreferences {
    pub theme: Theme,
    // Percentage of the original text size; older preferences use the smaller default.
    #[serde(
        default = "default_text_scale",
        skip_serializing_if = "is_default_text_scale"
    )]
    #[schemars(schema_with = "text_scale_schema")]
    #[ts(as = "Option<u16>", optional)]
    pub text_scale: u16,
    pub selected_navigation: NavigationSelection,
    pub window: Option<WindowGeometry>,
    pub pinned: bool,
    pub notification_watermark: Option<UtcMillis>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 256))]
    #[ts(as = "Option<Vec<NotificationEpisode>>", optional)]
    pub notification_ledger: Vec<NotificationEpisode>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub notification_preview: bool,
    // Width of the item detail panel in CSS pixels, as the owner dragged it; absent means the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = DETAIL_WIDTH_MIN, max = DETAIL_WIDTH_MAX))]
    #[ts(optional)]
    pub detail_width: Option<u32>,
    // The owner collapsed the left "Waiting on me" column.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub waiting_collapsed: bool,
    // Project archive groups the owner expanded; all others start folded.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 256))]
    #[ts(as = "Option<Vec<UuidV4>>", optional)]
    pub session_archive_expanded_project_ids: Vec<UuidV4>,
}

pub const TEXT_SCALE_DEFAULT: u16 = 80;
pub const TEXT_SCALE_STEPS: [u16; 6] = [70, 80, 90, 100, 110, 120];
fn default_text_scale() -> u16 {
    TEXT_SCALE_DEFAULT
}
fn is_default_text_scale(scale: &u16) -> bool {
    *scale == TEXT_SCALE_DEFAULT
}
fn text_scale_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "type": "integer", "enum": TEXT_SCALE_STEPS })
}

/// Bounds of `GlobalPreferences::detail_width`; the renderer clamps to the same range.
pub const DETAIL_WIDTH_MIN: u32 = 320;
pub const DETAIL_WIDTH_MAX: u32 = 2400;
/// Most folded topic bands kept per session.
pub const COLLAPSED_TOPICS_CAPACITY: usize = 256;
pub const RECENT_ITEMS_CAPACITY: usize = 15;
pub const SESSION_ARCHIVE_EXPANSION_CAPACITY: usize = 256;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub focused_item_id: Option<ItemRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 15))]
    #[ts(as = "Option<Vec<RecentItem>>", optional)]
    pub recent_items: Vec<RecentItem>,
    pub tab_order: NonnegativeSafeInteger,
    pub expanded_item_ids: Vec<ItemRef>,
    // Items the owner hid in this session; descendants inherit their parent's visibility.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<ItemRef>>", optional)]
    pub hidden_item_ids: Vec<ItemRef>,
    pub filters: ViewFilters,
    pub scroll: Option<ScrollAnchor>,
    // Topic bands the owner folded in this session's tree.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 256))]
    #[ts(as = "Option<Vec<UuidV4>>", optional)]
    pub collapsed_topic_ids: Vec<UuidV4>,
}
/// Local browsing trail; it never creates a domain Input or acknowledgement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RecentItem {
    pub item_id: ItemRef,
    pub action: RecentAction,
    pub visited_at: UtcMillis,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum RecentAction {
    Viewed,
    Peeked,
    Answered,
    Acked,
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ScrollAnchor {
    pub item_id: Option<ItemRef>,
    pub offset: f64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct OwnerDraft {
    // Persist before dispatch. Restored attempted drafts only replay their exact body.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub submission_attempted: bool,
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
    SetGlobal {
        preferences: GlobalPreferences,
    },
    SetSessionView {
        preferences: SessionPreferences,
    },
    SetLater {
        item: ItemRoute,
        later: bool,
    },
    UpsertDraft {
        draft: OwnerDraft,
    },
    DeleteDraft {
        operation_id: UuidV4,
    },
    ResolveUnsentInput {
        input_id: UuidV4,
    },
    MarkSeen {
        session: SessionRef,
        at: UtcMillis,
        #[schemars(length(max = 10_000))]
        items: Vec<ItemSeen>,
        #[schemars(length(max = 1_024))]
        topics: Vec<TopicSeen>,
    },
}
