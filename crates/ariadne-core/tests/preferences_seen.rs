use ariadne_core::{native::PreferencesService, *};
use ariadne_domain::models::*;
use ariadne_store::registry::Registry;
use serde_json::{json, Value};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};
use tempfile::TempDir;

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn revision(n: u64) -> PositiveSafeInteger {
    PositiveSafeInteger::new(n).unwrap()
}
fn at(second: u8) -> UtcMillis {
    UtcMillis::new(format!("2026-10-13T12:00:{second:02}.000Z")).unwrap()
}
fn route() -> SessionRef {
    SessionRef {
        project_id: id(1),
        session_id: id(2),
    }
}
fn owner() -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Preferences)
}
fn item(n: usize, seen_revision: u64) -> ItemSeen {
    ItemSeen {
        item_id: ItemRef::new(n.to_string()).unwrap(),
        revision: revision(seen_revision),
    }
}
fn topic(n: u64, second: u8) -> TopicSeen {
    TopicSeen {
        topic_id: id(n),
        at: at(second),
    }
}
fn mark(second: u8, items: Vec<ItemSeen>, topics: Vec<TopicSeen>) -> PreferencesPatchEntry {
    PreferencesPatchEntry::MarkSeen {
        session: route(),
        at: at(second),
        items,
        topics,
    }
}
fn patch(op: u64, expected: u64, entries: Vec<PreferencesPatchEntry>) -> OwnerCommand {
    OwnerCommand::PreferencesPatch {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(op),
        params: PreferencesPatch {
            expected_preferences_revision: revision(expected),
            entries,
        },
    }
}
struct Setup {
    home: TempDir,
    registry: Registry,
}
impl Setup {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        Self { home, registry }
    }
    fn service(&self) -> PreferencesService<'_> {
        PreferencesService::new(&self.registry)
    }
    fn live(&self) -> PathBuf {
        self.home.path().join(".ariadne/ui.json")
    }
    fn backup(&self) -> PathBuf {
        self.home.path().join(".ariadne/ui.previous.json")
    }
    fn record(&self) -> Value {
        serde_json::from_slice(&fs::read(self.live()).unwrap()).unwrap()
    }
    fn write(&self, value: &Value) {
        fs::write(self.live(), serde_json::to_vec_pretty(value).unwrap()).unwrap();
        fs::set_permissions(self.live(), fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn saved(&self) -> PreferencesSnapshot {
        self.service().get(&owner()).unwrap()
    }
}

#[test]
fn absent_and_legacy_seen_state_preserves_old_keys_bytes_and_replay() {
    let s = Setup::new();
    assert!(s.saved().seen.is_empty());
    assert!(!s.live().exists());
    let command = patch(100, 1, vec![]);
    let result = s.service().patch(&owner(), &command).unwrap();
    let before = fs::read(s.live()).unwrap();
    let original = s.record();
    assert!(original["snapshot"].get("seen").is_none());
    let snapshot: PreferencesSnapshot =
        serde_json::from_value(original["snapshot"].clone()).unwrap();
    assert_eq!(
        serde_json::to_value(snapshot).unwrap(),
        original["snapshot"]
    );
    let reopened = Registry::open(s.home.path()).unwrap();
    assert!(PreferencesService::new(&reopened)
        .get(&owner())
        .unwrap()
        .seen
        .is_empty());
    assert_eq!(
        PreferencesService::new(&reopened)
            .patch(&owner(), &command)
            .unwrap(),
        result
    );
    assert_eq!(fs::read(s.live()).unwrap(), before);
    assert!(!s.backup().exists());
}

#[test]
fn seen_merges_only_upward_and_keeps_first_since_across_reopen() {
    let s = Setup::new();
    let domain_file = s
        .home
        .path()
        .join(".ariadne/projects")
        .join(id(1).as_str())
        .join("sessions")
        .join(format!("{}.json", id(2).as_str()));
    fs::create_dir_all(domain_file.parent().unwrap()).unwrap();
    fs::write(&domain_file, b"agent-owned session bytes").unwrap();
    s.service()
        .patch(
            &owner(),
            &patch(100, 1, vec![mark(20, vec![item(1, 5)], vec![topic(3, 20)])]),
        )
        .unwrap();
    s.service()
        .patch(
            &owner(),
            &patch(
                101,
                2,
                vec![mark(
                    10,
                    vec![item(1, 2), item(2, 7)],
                    vec![topic(3, 10), topic(4, 30)],
                )],
            ),
        )
        .unwrap();
    s.service()
        .patch(
            &owner(),
            &patch(102, 3, vec![mark(40, vec![item(1, 9)], vec![topic(3, 40)])]),
        )
        .unwrap();
    let expected = SessionSeen {
        session: route(),
        since: at(20),
        items: vec![item(1, 9), item(2, 7)],
        topics: vec![topic(3, 40), topic(4, 30)],
    };
    assert_eq!(s.saved().seen, vec![expected.clone()]);
    let reopened = Registry::open(s.home.path()).unwrap();
    assert_eq!(
        PreferencesService::new(&reopened)
            .get(&owner())
            .unwrap()
            .seen,
        vec![expected]
    );
    assert_eq!(fs::read(domain_file).unwrap(), b"agent-owned session bytes");
    assert!(!s.home.path().join(".ariadne/projects.json").exists());
}

#[test]
fn empty_first_mark_sets_since_and_routes_have_independent_seen_state() {
    let s = Setup::new();
    let other = SessionRef {
        project_id: id(9),
        session_id: id(2),
    };
    s.service()
        .patch(
            &owner(),
            &patch(
                100,
                1,
                vec![
                    mark(20, vec![], vec![]),
                    PreferencesPatchEntry::MarkSeen {
                        session: other.clone(),
                        at: at(10),
                        items: vec![item(1, 3)],
                        topics: vec![],
                    },
                ],
            ),
        )
        .unwrap();
    s.service()
        .patch(
            &owner(),
            &patch(101, 2, vec![mark(40, vec![item(1, 4)], vec![])]),
        )
        .unwrap();
    let seen = s.saved().seen;
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].since, at(20));
    assert_eq!(seen[0].items, vec![item(1, 4)]);
    assert_eq!(seen[1].session, other);
    assert_eq!(seen[1].since, at(10));
    assert_eq!(seen[1].items, vec![item(1, 3)]);
}

#[test]
fn setting_session_view_cannot_overwrite_seen_state() {
    let s = Setup::new();
    s.service()
        .patch(
            &owner(),
            &patch(100, 1, vec![mark(20, vec![item(1, 5)], vec![topic(3, 20)])]),
        )
        .unwrap();
    let seen = s.saved().seen;
    let view = SessionPreferences {
        session: route(),
        tab_open: true,
        selected_item_id: None,
        tab_order: NonnegativeSafeInteger::new(0).unwrap(),
        expanded_item_ids: vec![],
        hidden_item_ids: vec![],
        filters: ViewFilters {
            search: String::new(),
            statuses: vec![],
            owners: vec![],
            topic_id: None,
            archived: false,
            hide_later: false,
        },
        rail: RailView::Activity,
        scroll: None,
        collapsed_topic_ids: vec![],
        focused_item_id: None,
        recent_items: vec![],
    };
    s.service()
        .patch(
            &owner(),
            &patch(
                101,
                2,
                vec![PreferencesPatchEntry::SetSessionView {
                    preferences: view.clone(),
                }],
            ),
        )
        .unwrap();
    assert_eq!(s.saved().sessions, vec![view]);
    assert_eq!(s.saved().seen, seen);
}

#[test]
fn exact_seen_bounds_allow_updates_but_refuse_cumulative_growth_atomically() {
    let s = Setup::new();
    let items: Vec<_> = (1..=SEEN_ITEMS_CAPACITY).map(|n| item(n, 1)).collect();
    let topics: Vec<_> = (1..=SEEN_TOPICS_CAPACITY)
        .map(|n| topic(n as u64, 20))
        .collect();
    s.service()
        .patch(
            &owner(),
            &patch(100, 1, vec![mark(20, items.clone(), topics.clone())]),
        )
        .unwrap();
    s.service()
        .patch(
            &owner(),
            &patch(101, 2, vec![mark(10, vec![item(1, 2)], vec![topic(1, 30)])]),
        )
        .unwrap();
    let live = fs::read(s.live()).unwrap();
    let backup = fs::read(s.backup()).unwrap();
    for entry in [
        mark(20, vec![item(SEEN_ITEMS_CAPACITY + 1, 1)], vec![]),
        mark(20, vec![], vec![topic(SEEN_TOPICS_CAPACITY as u64 + 1, 20)]),
    ] {
        let mut global = s.saved().global;
        global.pinned = true;
        let error = s
            .service()
            .patch(
                &owner(),
                &patch(
                    102,
                    3,
                    vec![
                        PreferencesPatchEntry::SetGlobal {
                            preferences: global,
                        },
                        entry,
                    ],
                ),
            )
            .unwrap_err();
        assert_eq!(error.code, CoreErrorCode::CapacityExceeded);
        let serialized = serde_json::to_value(&error).unwrap().to_string();
        for jargon in ["operation", "revision", "binding", "target", "ref", "ID"] {
            assert!(!serialized.contains(jargon), "{serialized}");
        }
        assert_eq!(fs::read(s.live()).unwrap(), live);
        assert_eq!(fs::read(s.backup()).unwrap(), backup);
    }
    assert_eq!(s.saved().seen[0].items.len(), SEEN_ITEMS_CAPACITY);
    assert_eq!(s.saved().seen[0].topics.len(), SEEN_TOPICS_CAPACITY);
    assert_eq!(s.saved().seen[0].items[0].revision, revision(2));
    assert_eq!(s.saved().seen[0].topics[0].at, at(30));
}

#[test]
fn incoming_seen_duplicates_and_oversized_lists_refuse_without_writes() {
    let s = Setup::new();
    let cases = [
        (
            mark(20, vec![item(1, 1), item(1, 2)], vec![]),
            CoreErrorCode::InvalidArgument,
        ),
        (
            mark(20, vec![], vec![topic(1, 10), topic(1, 20)]),
            CoreErrorCode::InvalidArgument,
        ),
        (
            mark(
                20,
                (1..=SEEN_ITEMS_CAPACITY + 1).map(|n| item(n, 1)).collect(),
                vec![],
            ),
            CoreErrorCode::CapacityExceeded,
        ),
        (
            mark(
                20,
                vec![],
                (1..=SEEN_TOPICS_CAPACITY + 1)
                    .map(|n| topic(n as u64, 20))
                    .collect(),
            ),
            CoreErrorCode::CapacityExceeded,
        ),
    ];
    for (entry, code) in cases {
        let command = patch(100, 1, vec![entry]);
        assert_eq!(command.validate_wire().unwrap_err().code, code);
        assert_eq!(
            s.service().patch(&owner(), &command).unwrap_err().code,
            code
        );
        assert!(!s.live().exists());
        assert!(!s.backup().exists());
    }
}

#[test]
fn accumulated_seen_state_can_exceed_one_request_budget_within_response_budget() {
    let s = Setup::new();
    for offset in 0..2 {
        let items = (1 + offset * 3000..=3000 + offset * 3000)
            .map(|n| ItemSeen {
                item_id: ItemRef::new(format!(
                    "{n}.9007199254740991.9007199254740991.9007199254740991.9007199254740991"
                ))
                .unwrap(),
                revision: revision(1),
            })
            .collect();
        s.service()
            .patch(
                &owner(),
                &patch(100 + offset, 1 + offset, vec![mark(20, items, vec![])]),
            )
            .unwrap();
    }
    let saved = s.saved();
    let size = serde_json::to_vec(&saved).unwrap().len();
    assert!(size > 512 * 1024 && size < 1024 * 1024);
    assert_eq!(saved.seen[0].items.len(), 6000);
    let reopened = Registry::open(s.home.path()).unwrap();
    assert_eq!(
        PreferencesService::new(&reopened).get(&owner()).unwrap(),
        saved
    );
}

#[test]
fn corrupt_saved_seen_state_preserves_live_and_backup_evidence() {
    let s = Setup::new();
    s.service()
        .patch(
            &owner(),
            &patch(100, 1, vec![mark(20, vec![item(1, 2)], vec![topic(1, 20)])]),
        )
        .unwrap();
    let original = s.record();
    fs::write(s.backup(), b"previous evidence").unwrap();
    fs::set_permissions(s.backup(), fs::Permissions::from_mode(0o600)).unwrap();
    let mut cases = vec![];
    for (field, value) in [
        ("items", json!([item(1, 2), item(1, 3)])),
        ("topics", json!([topic(1, 20), topic(1, 30)])),
        (
            "items",
            json!((1..=SEEN_ITEMS_CAPACITY + 1)
                .map(|n| item(n, 1))
                .collect::<Vec<_>>()),
        ),
        (
            "topics",
            json!((1..=SEEN_TOPICS_CAPACITY + 1)
                .map(|n| topic(n as u64, 20))
                .collect::<Vec<_>>()),
        ),
        ("since", json!("invalid")),
        ("unknown", json!(true)),
    ] {
        let mut record = original.clone();
        record["snapshot"]["seen"][0][field] = value;
        cases.push(record);
    }
    let mut duplicate = original.clone();
    duplicate["snapshot"]["seen"]
        .as_array_mut()
        .unwrap()
        .push(original["snapshot"]["seen"][0].clone());
    cases.push(duplicate);
    for record in cases {
        s.write(&record);
        let live = fs::read(s.live()).unwrap();
        assert_eq!(
            s.service().get(&owner()).unwrap_err().code,
            CoreErrorCode::CorruptSession
        );
        assert_eq!(
            s.service()
                .patch(&owner(), &patch(101, 2, vec![]))
                .unwrap_err()
                .code,
            CoreErrorCode::CorruptSession
        );
        assert_eq!(fs::read(s.live()).unwrap(), live);
        assert_eq!(fs::read(s.backup()).unwrap(), b"previous evidence");
    }
}

#[test]
fn receipt_window_retains_replay_and_refuses_old_stale_operations() {
    let s = Setup::new();
    let first = patch(100, 1, vec![mark(20, vec![item(1, 2)], vec![])]);
    s.service().patch(&owner(), &first).unwrap();
    let retained = patch(102, 3, vec![]);
    let mut saved = None;
    for offset in 1..258 {
        let command = patch(100 + offset, 1 + offset, vec![]);
        let result = s.service().patch(&owner(), &command).unwrap();
        if offset == 2 {
            saved = Some(result);
        }
    }
    let record = s.record();
    let operations = record["operations"].as_array().unwrap();
    assert_eq!(operations.len(), 256);
    assert_eq!(
        operations.first().unwrap()["result"]["preferences_revision"],
        4
    );
    assert_eq!(
        operations.last().unwrap()["result"]["preferences_revision"],
        259
    );
    let live = fs::read(s.live()).unwrap();
    let backup = fs::read(s.backup()).unwrap();
    assert_eq!(
        s.service().patch(&owner(), &retained).unwrap(),
        saved.unwrap()
    );
    assert_eq!(
        s.service()
            .patch(&owner(), &patch(102, 259, vec![]))
            .unwrap_err()
            .code,
        CoreErrorCode::OperationReused
    );
    assert_eq!(
        s.service().patch(&owner(), &first).unwrap_err().code,
        CoreErrorCode::RevisionConflict
    );
    assert_eq!(s.saved().seen[0].items, vec![item(1, 2)]);
    assert_eq!(fs::read(s.live()).unwrap(), live);
    assert_eq!(fs::read(s.backup()).unwrap(), backup);
}

#[test]
fn oversized_legacy_receipt_history_loads_and_trims_on_next_write_with_backup() {
    let s = Setup::new();
    let first = patch(100, 1, vec![]);
    let first_result = s.service().patch(&owner(), &first).unwrap();
    let mut record = s.record();
    let template = record["operations"][0].clone();
    for offset in 1..300 {
        let mut operation = template.clone();
        operation["operation_id"] = json!(id(1000 + offset));
        operation["result"]["operation_id"] = json!(id(1000 + offset));
        operation["result"]["preferences_revision"] = json!(offset + 2);
        record["operations"].as_array_mut().unwrap().push(operation);
    }
    record["snapshot"]["revision"] = json!(301);
    s.write(&record);
    let legacy = fs::read(s.live()).unwrap();
    assert_eq!(s.saved().revision, revision(301));
    assert_eq!(s.service().patch(&owner(), &first).unwrap(), first_result);
    assert_eq!(fs::read(s.live()).unwrap(), legacy);
    assert!(!s.backup().exists());
    s.service()
        .patch(&owner(), &patch(5000, 301, vec![]))
        .unwrap();
    let trimmed = s.record();
    assert_eq!(trimmed["operations"].as_array().unwrap().len(), 256);
    assert_eq!(
        trimmed["operations"][0]["result"]["preferences_revision"],
        47
    );
    assert_eq!(
        trimmed["operations"][255]["result"]["preferences_revision"],
        302
    );
    assert_eq!(fs::read(s.backup()).unwrap(), legacy);
    assert_eq!(s.saved().revision, revision(302));
}

#[test]
fn retained_receipts_require_nonempty_consecutive_history_ending_at_snapshot() {
    let s = Setup::new();
    for offset in 0..3 {
        s.service()
            .patch(&owner(), &patch(100 + offset, 1 + offset, vec![]))
            .unwrap();
    }
    let original = s.record();
    let mut tail = original.clone();
    tail["operations"].as_array_mut().unwrap().remove(0);
    s.write(&tail);
    assert_eq!(s.saved().revision, revision(4));
    let mut cases = vec![];
    let mut gap = original.clone();
    gap["operations"].as_array_mut().unwrap().remove(1);
    cases.push(gap);
    let mut missing_end = original.clone();
    missing_end["operations"].as_array_mut().unwrap().pop();
    cases.push(missing_end);
    let mut empty = original.clone();
    empty["operations"] = json!([]);
    cases.push(empty);
    let mut reordered = original;
    reordered["operations"].as_array_mut().unwrap().swap(0, 1);
    cases.push(reordered);
    for record in cases {
        s.write(&record);
        assert_eq!(
            s.service().get(&owner()).unwrap_err().code,
            CoreErrorCode::CorruptSession
        );
    }
}
