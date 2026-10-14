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

#[test]
fn retired_rail_loads_without_rewriting_and_saves_hidden_on_next_patch() {
    let s = Setup::new();
    s.service().patch(&owner(), &patch(100, 1, vec![])).unwrap();
    let mut record = s.record();
    let view = json!({
        "session": route(), "tab_open": true, "selected_item_id": "1", "tab_order": 0,
        "expanded_item_ids": ["1"], "filters": { "search": "kept", "statuses": [], "owners": [],
            "topic_id": null, "archived": false, "hide_later": false }, "scroll": {"item_id": "1", "offset": 42}
    });
    let expected: SessionPreferences = serde_json::from_value(view.clone()).unwrap();
    for rail in ["waiting", "sent", "activity", "hidden"] {
        let mut legacy = view.clone();
        legacy["rail"] = json!(rail);
        record["snapshot"]["sessions"] = json!([legacy]);
        s.write(&record);
        let bytes = fs::read(s.live()).unwrap();
        let reopened = Registry::open(s.home.path()).unwrap();
        assert_eq!(
            PreferencesService::new(&reopened)
                .get(&owner())
                .unwrap()
                .sessions,
            vec![expected.clone()]
        );
        assert_eq!(fs::read(s.live()).unwrap(), bytes);
        assert!(!s.backup().exists());
    }
    let bytes = fs::read(s.live()).unwrap();
    s.service().patch(&owner(), &patch(101, 2, vec![])).unwrap();
    assert_eq!(s.saved().sessions, vec![expected]);
    assert_eq!(s.record()["snapshot"]["sessions"][0]["rail"], "hidden");
    assert_eq!(fs::read(s.backup()).unwrap(), bytes);
}

#[test]
fn retired_rail_compatibility_keeps_unknown_and_duplicate_fields_invalid() {
    let s = Setup::new();
    s.service().patch(&owner(), &patch(100, 1, vec![])).unwrap();
    let mut record = s.record();
    record["snapshot"]["sessions"] = json!([{
        "session": route(), "tab_open": true, "selected_item_id": null, "tab_order": 0,
        "expanded_item_ids": [], "filters": { "search": "", "statuses": [], "owners": [],
            "topic_id": null, "archived": false, "hide_later": false }, "scroll": null, "rail": "hidden"
    }]);
    let canonical = serde_json::to_string(&record).unwrap();
    for invalid in [
        canonical.replace(
            "\"rail\":\"hidden\"",
            "\"rail\":\"hidden\",\"unknown\":true",
        ),
        canonical.replace("\"tab_open\":true", "\"tab_open\":true,\"tab_open\":false"),
        canonical.replace(
            "\"rail\":\"hidden\"",
            "\"rail\":\"hidden\",\"rail\":\"activity\"",
        ),
    ] {
        fs::write(s.live(), invalid.as_bytes()).unwrap();
        assert_eq!(
            s.service().get(&owner()).unwrap_err().code,
            CoreErrorCode::CorruptSession
        );
        assert_eq!(fs::read(s.live()).unwrap(), invalid.as_bytes());
    }
    assert!(serde_json::from_value::<SessionPreferences>(
        record["snapshot"]["sessions"][0].clone()
    )
    .is_err());
}

fn resolve(input: u64) -> PreferencesPatchEntry {
    PreferencesPatchEntry::ResolveUnsentInput {
        input_id: id(input),
    }
}

fn recovery_path(s: &Setup) -> PathBuf {
    s.home.path().join(".ariadne/ui-recovery.json")
}

fn quarantined_paths(s: &Setup) -> Vec<PathBuf> {
    let mut paths = fs::read_dir(s.home.path().join(".ariadne"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("ui-recovery.corrupt-")
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

fn assert_quarantined(s: &Setup, bytes: &[u8]) {
    assert!(!recovery_path(s).exists());
    let before = quarantined_paths(s);
    assert!(before.iter().any(|path| fs::read(path).unwrap() == bytes));
    let reopened = Registry::open(s.home.path()).unwrap();
    assert!(PreferencesService::new(&reopened)
        .get(&owner())
        .unwrap()
        .resolved_unsent_input_ids
        .is_empty());
    assert_eq!(quarantined_paths(s), before);
}

fn restored_draft() -> OwnerDraft {
    OwnerDraft {
        submission_attempted: false,
        op_id: id(80),
        session: route(),
        binding_id: id(3),
        target: InputTarget {
            topic_id: id(4),
            item_id: None,
        },
        intent: InputKind::Reply,
        text: "Preserved draft".into(),
        selected_option_id: None,
        target_revision: revision(1),
        question_revision: None,
        supersedes_answer_id: None,
    }
}

#[test]
fn malformed_and_future_companions_preserve_main_and_allow_draft_saves() {
    for kind in 0..9 {
        let s = Setup::new();
        s.service()
            .patch(
                &owner(),
                &patch(
                    100,
                    1,
                    vec![PreferencesPatchEntry::UpsertDraft {
                        draft: restored_draft(),
                    }],
                ),
            )
            .unwrap();
        s.service()
            .patch(&owner(), &patch(101, 2, vec![resolve(90)]))
            .unwrap();
        let mut bad: Value = serde_json::from_slice(&fs::read(recovery_path(&s)).unwrap()).unwrap();
        match kind {
            1 => bad["schema_version"] = json!(2),
            2 => bad["schema_version"] = json!(0),
            3 => bad["operations"] = json!([]),
            4 => bad["operations"][0]["result"]["operation_id"] = json!(id(999)),
            5 => bad["operations"][0]["actor_scope"] = json!({"agent": {}}),
            6 => bad["unknown"] = json!(true),
            7 => {
                let duplicate = bad["operations"][0].clone();
                bad["operations"].as_array_mut().unwrap().push(duplicate);
            }
            8 => bad["operations"] = json!(vec![bad["operations"][0].clone(); 257]),
            _ => (),
        }
        let bytes = if kind == 0 {
            b"{malformed owner text".to_vec()
        } else {
            serde_json::to_vec(&bad).unwrap()
        };
        fs::write(recovery_path(&s), &bytes).unwrap();
        let main = fs::read(s.live()).unwrap();
        let saved = s.saved();
        assert_eq!(saved.revision, revision(3));
        assert_eq!(saved.drafts, vec![restored_draft()]);
        assert!(saved.resolved_unsent_input_ids.is_empty());
        assert_eq!(fs::read(s.live()).unwrap(), main);
        assert_quarantined(&s, &bytes);
        let mut draft = restored_draft();
        draft.text = "Updated draft".into();
        s.service()
            .patch(
                &owner(),
                &patch(
                    102,
                    3,
                    vec![PreferencesPatchEntry::UpsertDraft {
                        draft: draft.clone(),
                    }],
                ),
            )
            .unwrap();
        assert_eq!(s.saved().drafts, vec![draft]);
        assert_eq!(quarantined_paths(&s).len(), 1);
    }
}

#[test]
fn companion_ahead_of_restored_or_deleted_main_never_blocks_drafts() {
    for deleted in [false, true] {
        let s = Setup::new();
        s.service()
            .patch(
                &owner(),
                &patch(
                    100,
                    1,
                    vec![PreferencesPatchEntry::UpsertDraft {
                        draft: restored_draft(),
                    }],
                ),
            )
            .unwrap();
        let restored = fs::read(s.live()).unwrap();
        s.service().patch(&owner(), &patch(101, 2, vec![])).unwrap();
        s.service()
            .patch(&owner(), &patch(102, 3, vec![resolve(90)]))
            .unwrap();
        let companion = fs::read(recovery_path(&s)).unwrap();
        if deleted {
            fs::remove_file(s.live()).unwrap();
        } else {
            fs::write(s.live(), &restored).unwrap();
        }
        let saved = s.saved();
        let expected_revision = if deleted { 1 } else { 2 };
        assert_eq!(saved.revision, revision(expected_revision));
        assert!(saved.resolved_unsent_input_ids.is_empty());
        if deleted {
            assert!(!s.live().exists());
        } else {
            assert_eq!(fs::read(s.live()).unwrap(), restored);
            assert_eq!(saved.drafts, vec![restored_draft()]);
        }
        assert_quarantined(&s, &companion);
        let mut draft = restored_draft();
        draft.text = "New local draft".into();
        s.service()
            .patch(
                &owner(),
                &patch(
                    103,
                    expected_revision,
                    vec![PreferencesPatchEntry::UpsertDraft {
                        draft: draft.clone(),
                    }],
                ),
            )
            .unwrap();
        assert_eq!(s.saved().drafts, vec![draft]);
        assert_eq!(quarantined_paths(&s).len(), 1);
    }
}

#[test]
fn companion_projection_failure_preserves_marker_until_publication_retry() {
    let s = Setup::new();
    let mut global = s.saved().global;
    global.selected_navigation = NavigationSelection::Session { session: route() };
    s.service()
        .patch(
            &owner(),
            &patch(
                100,
                1,
                vec![
                    PreferencesPatchEntry::SetGlobal {
                        preferences: global.clone(),
                    },
                    PreferencesPatchEntry::UpsertDraft {
                        draft: restored_draft(),
                    },
                ],
            ),
        )
        .unwrap();
    let original = fs::read(s.live()).unwrap();
    let marker_command = patch(101, 2, vec![resolve(90)]);
    let marker_receipt = s.service().patch(&owner(), &marker_command).unwrap();
    let companion = fs::read(recovery_path(&s)).unwrap();
    fs::write(s.live(), &original).unwrap();
    fs::remove_file(s.backup()).unwrap();
    let outside = s.home.path().join("untouched");
    fs::write(&outside, b"outside owner evidence").unwrap();
    std::os::unix::fs::symlink(&outside, s.backup()).unwrap();
    let mut updated_draft = restored_draft();
    updated_draft.text = "Updated draft".into();
    let draft_command = patch(
        102,
        3,
        vec![PreferencesPatchEntry::UpsertDraft {
            draft: updated_draft.clone(),
        }],
    );
    for _ in 0..3 {
        let saved = s.saved();
        assert_eq!(saved.revision, revision(3));
        assert_eq!(saved.resolved_unsent_input_ids, vec![id(90)]);
        assert_eq!(saved.global, global);
        assert_eq!(saved.drafts, vec![restored_draft()]);
        for command in [&marker_command, &draft_command] {
            let error = s.service().patch(&owner(), command).unwrap_err();
            assert_eq!(error.code, CoreErrorCode::CommitUncertain);
            assert!(error.message.contains(id(101).as_str()));
        }
        assert_eq!(fs::read(recovery_path(&s)).unwrap(), companion);
        assert!(quarantined_paths(&s).is_empty());
    }
    assert_eq!(fs::read(s.live()).unwrap(), original);
    assert_eq!(fs::read(outside).unwrap(), b"outside owner evidence");
    fs::remove_file(s.backup()).unwrap();
    let saved = s.saved();
    assert_eq!(saved.revision, revision(3));
    assert_eq!(saved.resolved_unsent_input_ids, vec![id(90)]);
    assert_eq!(
        s.service().patch(&owner(), &marker_command).unwrap(),
        marker_receipt
    );
    let draft_receipt = s.service().patch(&owner(), &draft_command).unwrap();
    assert_eq!(s.saved().drafts, vec![updated_draft]);
    assert_eq!(s.saved().global, global);
    assert_eq!(
        s.service().patch(&owner(), &draft_command).unwrap(),
        draft_receipt
    );
}

#[test]
fn resolve_after_successful_quarantine_creates_fresh_companion_with_only_new_id() {
    let s = Setup::new();
    s.service()
        .patch(&owner(), &patch(100, 1, vec![resolve(90)]))
        .unwrap();
    let corrupt = b"malformed recovery evidence";
    fs::write(recovery_path(&s), corrupt).unwrap();
    assert!(s.saved().resolved_unsent_input_ids.is_empty());
    assert_quarantined(&s, corrupt);
    let evidence = quarantined_paths(&s);
    s.service()
        .patch(&owner(), &patch(101, 2, vec![resolve(91)]))
        .unwrap();
    let companion: Value = serde_json::from_slice(&fs::read(recovery_path(&s)).unwrap()).unwrap();
    assert_eq!(companion["resolved_input_ids"], json!([id(91)]));
    assert_eq!(companion["operations"].as_array().unwrap().len(), 1);
    assert_eq!(companion["operations"][0]["operation_id"], json!(id(101)));
    let reopened = Registry::open(s.home.path()).unwrap();
    assert_eq!(
        PreferencesService::new(&reopened)
            .get(&owner())
            .unwrap()
            .resolved_unsent_input_ids,
        vec![id(91)]
    );
    assert_eq!(quarantined_paths(&s), evidence);
    assert_eq!(fs::read(&evidence[0]).unwrap(), corrupt);
}

#[test]
fn unreadable_or_unquarantinable_companion_allows_get_and_draft_patch() {
    for directory in [false, true] {
        let s = Setup::new();
        let marker_command = patch(100, 1, vec![resolve(90)]);
        let marker_receipt = s.service().patch(&owner(), &marker_command).unwrap();
        let path = recovery_path(&s);
        if directory {
            fs::remove_file(&path).unwrap();
            fs::create_dir(&path).unwrap();
            fs::write(path.join("evidence"), b"preserve owner evidence").unwrap();
        } else {
            fs::write(&path, b"unreadable companion bytes").unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        }
        let before = fs::read(s.live()).unwrap();
        assert_eq!(s.saved().revision, revision(2));
        assert_eq!(fs::read(s.live()).unwrap(), before);
        s.service()
            .patch(
                &owner(),
                &patch(
                    101,
                    2,
                    vec![PreferencesPatchEntry::UpsertDraft {
                        draft: restored_draft(),
                    }],
                ),
            )
            .unwrap();
        assert_eq!(s.saved().drafts, vec![restored_draft()]);
        assert_eq!(
            s.service().patch(&owner(), &marker_command).unwrap(),
            marker_receipt
        );
        assert!(s.saved().resolved_unsent_input_ids.is_empty());
        if directory {
            assert_eq!(
                fs::read(path.join("evidence")).unwrap(),
                b"preserve owner evidence"
            );
            assert!(quarantined_paths(&s).is_empty());
            assert!(s
                .service()
                .patch(&owner(), &patch(102, 3, vec![resolve(90)]))
                .is_err());
            assert_eq!(s.saved().revision, revision(3));
        } else {
            let evidence = quarantined_paths(&s);
            assert_eq!(evidence.len(), 1);
            fs::set_permissions(&evidence[0], fs::Permissions::from_mode(0o600)).unwrap();
            assert_quarantined(&s, b"unreadable companion bytes");
        }
    }
}

#[test]
fn main_corruption_and_future_schema_still_error_without_quarantining_valid_companion() {
    let s = Setup::new();
    s.service()
        .patch(&owner(), &patch(100, 1, vec![resolve(90)]))
        .unwrap();
    let original = s.record();
    let companion = fs::read(recovery_path(&s)).unwrap();
    for future in [false, true] {
        let bytes = if future {
            let mut main = original.clone();
            main["snapshot"]["schema_version"] = json!(2);
            serde_json::to_vec(&main).unwrap()
        } else {
            b"malformed main record".to_vec()
        };
        fs::write(s.live(), &bytes).unwrap();
        let expected = if future {
            CoreErrorCode::FutureSchema
        } else {
            CoreErrorCode::CorruptSession
        };
        assert_eq!(s.service().get(&owner()).unwrap_err().code, expected);
        assert_eq!(
            s.service()
                .patch(
                    &owner(),
                    &patch(
                        101,
                        2,
                        vec![PreferencesPatchEntry::UpsertDraft {
                            draft: restored_draft()
                        }]
                    )
                )
                .unwrap_err()
                .code,
            expected
        );
        assert_eq!(fs::read(s.live()).unwrap(), bytes);
        assert_eq!(fs::read(recovery_path(&s)).unwrap(), companion);
        assert!(quarantined_paths(&s).is_empty());
    }
}

// Copied strict alpha.14 record/session shape. Do not deserialize through the
// new snapshot DTO: that would hide an accidentally introduced disk extension.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct OldRecord {
    snapshot: OldSnapshot,
    operations: Vec<OldOperation>,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct OldSnapshot {
    schema_version: SchemaVersion,
    revision: PositiveSafeInteger,
    global: GlobalPreferences,
    sessions: Vec<OldSessionPreferences>,
    later: Vec<ItemRoute>,
    drafts: Vec<OwnerDraft>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    seen: Vec<SessionSeen>,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct OldSessionPreferences {
    session: SessionRef,
    tab_open: bool,
    selected_item_id: Option<ItemRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    focused_item_id: Option<ItemRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    recent_items: Vec<RecentItem>,
    tab_order: NonnegativeSafeInteger,
    rail: OldRail,
    expanded_item_ids: Vec<ItemRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    hidden_item_ids: Vec<ItemRef>,
    filters: ViewFilters,
    scroll: Option<ScrollAnchor>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    collapsed_topic_ids: Vec<UuidV4>,
}
#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
enum OldRail {
    Waiting,
    Sent,
    Activity,
    Hidden,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct OldOperation {
    actor_scope: ReceiptActorScope,
    operation_id: UuidV4,
    command_digest: Sha256,
    result: PreferencesPatchedReceipt,
}

#[test]
fn recovery_markers_survive_reopen_and_strict_old_binary_saves_full_preferences() {
    let s = Setup::new();
    assert!(s.saved().resolved_unsent_input_ids.is_empty());
    let view: SessionPreferences = serde_json::from_value(json!({
        "session": route(), "tab_open": true, "selected_item_id": "1", "tab_order": 3,
        "expanded_item_ids": ["1"], "hidden_item_ids": ["2"], "focused_item_id": "1",
        "recent_items": [{"item_id":"1", "action":"viewed", "visited_at":at(10)}],
        "collapsed_topic_ids": [id(12)],
        "filters": {"search":"owner text", "statuses":[], "owners":[], "topic_id":null, "archived":false, "hide_later":true},
        "scroll":{"item_id":"1", "offset":42}
    })).unwrap();
    let draft = OwnerDraft {
        submission_attempted: false,
        op_id: id(80),
        session: route(),
        binding_id: id(3),
        target: InputTarget {
            topic_id: id(4),
            item_id: None,
        },
        intent: InputKind::Reply,
        text: "Restored topic reply".into(),
        selected_option_id: None,
        target_revision: revision(1),
        question_revision: None,
        supersedes_answer_id: None,
    };
    let later = ItemRoute {
        project_id: id(1),
        session_id: id(2),
        item_id: ItemRef::new("1").unwrap(),
    };
    s.service()
        .patch(
            &owner(),
            &patch(
                100,
                1,
                vec![
                    PreferencesPatchEntry::SetSessionView {
                        preferences: view.clone(),
                    },
                    PreferencesPatchEntry::UpsertDraft {
                        draft: draft.clone(),
                    },
                    PreferencesPatchEntry::SetLater {
                        item: later.clone(),
                        later: true,
                    },
                    mark(10, vec![item(1, 2)], vec![topic(4, 10)]),
                ],
            ),
        )
        .unwrap();
    // Same marker operation handles both dismissal and confirmed Put back.
    for (op, expected, input) in [(101, 2, 90), (102, 3, 91), (103, 4, 90)] {
        s.service()
            .patch(&owner(), &patch(op, expected, vec![resolve(input)]))
            .unwrap();
    }
    let saved = s.saved();
    assert_eq!(saved.resolved_unsent_input_ids, vec![id(90), id(91)]);
    assert_eq!(saved.sessions, vec![view]);
    assert_eq!(saved.drafts, vec![draft]);
    assert_eq!(saved.later, vec![later]);
    assert_eq!(saved.seen[0].items, vec![item(1, 2)]);
    let mut old: OldRecord = serde_json::from_slice(&fs::read(s.live()).unwrap()).unwrap();
    assert_eq!(old.snapshot.sessions[0].rail, OldRail::Hidden);
    assert!(s.record()["snapshot"]
        .get("resolved_unsent_input_ids")
        .is_none());
    assert!(serde_json::to_value(&saved).unwrap()["sessions"][0]
        .get("rail")
        .is_none());
    let companion = fs::read(recovery_path(&s)).unwrap();
    // Emulate alpha.14 writing its typed record after changing owner data. It
    // neither understands nor rewrites the recovery companion.
    old.snapshot.global.pinned = true;
    old.snapshot.drafts[0].text = "New text saved by the older binary".into();
    old.snapshot.revision = revision(6);
    let mut operation: OldOperation =
        serde_json::from_value(s.record()["operations"][0].clone()).unwrap();
    operation.operation_id = id(200);
    operation.result.operation_id = id(200);
    operation.result.preferences_revision = revision(6);
    old.operations.push(operation);
    fs::write(s.live(), serde_json::to_vec_pretty(&old).unwrap()).unwrap();
    let downgraded = fs::read(s.live()).unwrap();
    let reopened = Registry::open(s.home.path()).unwrap();
    let reloaded = PreferencesService::new(&reopened).get(&owner()).unwrap();
    assert_eq!(reloaded.resolved_unsent_input_ids, vec![id(90), id(91)]);
    assert!(reloaded.global.pinned);
    assert_eq!(
        reloaded.drafts[0].text,
        "New text saved by the older binary"
    );
    assert_eq!(fs::read(recovery_path(&s)).unwrap(), companion);
    assert_eq!(fs::read(s.live()).unwrap(), downgraded);
}

#[test]
fn durable_marker_replays_after_failed_main_publication_without_false_success() {
    let s = Setup::new();
    s.service().patch(&owner(), &patch(100, 1, vec![])).unwrap();
    let before = fs::read(s.live()).unwrap();
    // A directory at the fixed backup target refuses main publication after the
    // durable companion commit, exercising the real store path without hooks.
    fs::create_dir(s.backup()).unwrap();
    let command = patch(101, 2, vec![resolve(90)]);
    assert_eq!(
        s.service().patch(&owner(), &command).unwrap_err().code,
        CoreErrorCode::CommitUncertain
    );
    assert_eq!(fs::read(s.live()).unwrap(), before);
    let companion = fs::read(recovery_path(&s)).unwrap();
    let saved = s.saved();
    assert_eq!(saved.revision, revision(3));
    assert_eq!(saved.resolved_unsent_input_ids, vec![id(90)]);
    assert_eq!(fs::read(s.live()).unwrap(), before);
    assert_eq!(fs::read(recovery_path(&s)).unwrap(), companion);
    assert!(quarantined_paths(&s).is_empty());
    // Restore the publication destination before reloading: a still-valid
    // pending receipt rolls forward and replays without a second marker write.
    // A reload while projection remains broken is covered separately above.
    fs::remove_dir(s.backup()).unwrap();
    let reopened = Registry::open(s.home.path()).unwrap();
    let service = PreferencesService::new(&reopened);
    let result = service.patch(&owner(), &command).unwrap();
    assert_eq!(result.preferences_revision, revision(3));
    assert_eq!(
        service.get(&owner()).unwrap().resolved_unsent_input_ids,
        vec![id(90)]
    );
    assert_eq!(fs::read(s.backup()).unwrap(), before);
    assert_eq!(fs::read(recovery_path(&s)).unwrap(), companion);
    let after = fs::read(s.live()).unwrap();
    assert_eq!(service.patch(&owner(), &command).unwrap(), result);
    assert_eq!(fs::read(s.live()).unwrap(), after);
    assert_eq!(
        service
            .patch(&owner(), &patch(101, 3, vec![resolve(91)]))
            .unwrap_err()
            .code,
        CoreErrorCode::OperationReused
    );
    assert_eq!(
        service
            .patch(&owner(), &patch(101, 3, vec![]))
            .unwrap_err()
            .code,
        CoreErrorCode::OperationReused
    );
}

#[test]
fn older_binary_advance_after_interrupted_marker_keeps_all_its_changes() {
    let s = Setup::new();
    s.service().patch(&owner(), &patch(100, 1, vec![])).unwrap();
    fs::create_dir(s.backup()).unwrap();
    let command = patch(101, 2, vec![resolve(90)]);
    assert_eq!(
        s.service().patch(&owner(), &command).unwrap_err().code,
        CoreErrorCode::CommitUncertain
    );
    let mut old = s.record();
    old["snapshot"]["global"]["pinned"] = json!(true);
    old["snapshot"]["revision"] = json!(3);
    let mut operation = old["operations"][0].clone();
    operation["operation_id"] = json!(id(200));
    operation["result"]["operation_id"] = json!(id(200));
    operation["result"]["preferences_revision"] = json!(3);
    old["operations"].as_array_mut().unwrap().push(operation);
    s.write(&old);
    fs::remove_dir(s.backup()).unwrap();
    let bytes = fs::read(s.live()).unwrap();
    let saved = s.saved();
    assert!(saved.global.pinned);
    assert_eq!(saved.revision, revision(3));
    assert_eq!(saved.resolved_unsent_input_ids, vec![id(90)]);
    assert_eq!(
        s.service()
            .patch(&owner(), &command)
            .unwrap()
            .preferences_revision,
        revision(3)
    );
    assert_eq!(fs::read(s.live()).unwrap(), bytes);
    s.service()
        .patch(&owner(), &patch(102, 3, vec![resolve(91)]))
        .unwrap();
    assert!(s.saved().global.pinned);
    assert_eq!(s.saved().resolved_unsent_input_ids, vec![id(90), id(91)]);
}

#[test]
fn recovery_markers_reject_mixed_duplicate_and_invalid_uuid_entries_without_writes() {
    let s = Setup::new();
    for entries in [
        vec![resolve(90), resolve(90)],
        vec![resolve(90), mark(10, vec![], vec![])],
    ] {
        let command = patch(100, 1, entries);
        assert_eq!(
            command.validate_wire().unwrap_err().code,
            CoreErrorCode::InvalidArgument
        );
        assert_eq!(
            s.service().patch(&owner(), &command).unwrap_err().code,
            CoreErrorCode::InvalidArgument
        );
    }
    assert!(serde_json::from_value::<PreferencesPatchEntry>(
        json!({"kind":"resolve_unsent_input","input_id":"invalid"})
    )
    .is_err());
    assert!(!s.live().exists());
    assert!(!recovery_path(&s).exists());
    let other_scope = OwnerContext::from_trusted_entrypoint(OwnerScope::Registry);
    assert_eq!(
        s.service()
            .patch(&other_scope, &patch(100, 1, vec![resolve(90)]))
            .unwrap_err()
            .code,
        CoreErrorCode::PermissionDenied
    );
}

#[test]
fn recovery_companion_enforces_capacity_integrity_and_preserves_evidence() {
    let s = Setup::new();
    s.service()
        .patch(&owner(), &patch(100, 1, vec![resolve(90)]))
        .unwrap();
    let path = recovery_path(&s);
    let mut full: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    full["resolved_input_ids"] = json!((10000..20000).map(id).collect::<Vec<_>>());
    fs::write(&path, serde_json::to_vec(&full).unwrap()).unwrap();
    assert_eq!(s.saved().resolved_unsent_input_ids.len(), 10000);
    // Existing IDs do not refresh their insertion position at capacity.
    let existing_command = patch(101, 2, vec![resolve(10000)]);
    let existing_receipt = s.service().patch(&owner(), &existing_command).unwrap();
    assert_eq!(
        s.saved().resolved_unsent_input_ids,
        (10000..20000).map(id).collect::<Vec<_>>()
    );
    // New IDs evict oldest-first; repeated IDs in later operations remain stable.
    s.service()
        .patch(&owner(), &patch(102, 3, vec![resolve(91), resolve(92)]))
        .unwrap();
    let expected = (10002..20000)
        .map(id)
        .chain([id(91), id(92)])
        .collect::<Vec<_>>();
    assert_eq!(s.saved().resolved_unsent_input_ids, expected);
    assert_eq!(
        s.service().patch(&owner(), &existing_command).unwrap(),
        existing_receipt
    );
    assert_eq!(s.saved().resolved_unsent_input_ids, expected);
    let reopened = Registry::open(s.home.path()).unwrap();
    assert_eq!(
        PreferencesService::new(&reopened)
            .get(&owner())
            .unwrap()
            .resolved_unsent_input_ids,
        expected
    );
    let original: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for ids in [
        json!([id(90), id(90)]),
        json!(["invalid"]),
        json!((10000..20001).map(id).collect::<Vec<_>>()),
    ] {
        let mut bad = original.clone();
        bad["resolved_input_ids"] = ids;
        fs::write(&path, serde_json::to_vec(&bad).unwrap()).unwrap();
        let bytes = fs::read(&path).unwrap();
        let main = fs::read(s.live()).unwrap();
        assert!(s.saved().resolved_unsent_input_ids.is_empty());
        assert_eq!(fs::read(s.live()).unwrap(), main);
        assert_quarantined(&s, &bytes);
    }
}

#[test]
fn companion_receipt_deduplicates_after_ordinary_main_history_prunes_it() {
    let s = Setup::new();
    let command = patch(100, 1, vec![resolve(90)]);
    let result = s.service().patch(&owner(), &command).unwrap();
    for offset in 1..=257 {
        s.service()
            .patch(&owner(), &patch(100 + offset, 1 + offset, vec![]))
            .unwrap();
    }
    assert!(!s.record()["operations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|saved| saved["operation_id"] == json!(id(100))));
    let before = fs::read(s.live()).unwrap();
    let companion = fs::read(recovery_path(&s)).unwrap();
    assert_eq!(s.service().patch(&owner(), &command).unwrap(), result);
    assert_eq!(
        s.service()
            .patch(&owner(), &patch(100, 259, vec![resolve(91)]))
            .unwrap_err()
            .code,
        CoreErrorCode::OperationReused
    );
    assert_eq!(fs::read(s.live()).unwrap(), before);
    assert_eq!(fs::read(recovery_path(&s)).unwrap(), companion);
}

#[test]
fn first_marker_recovers_from_companion_without_main_and_quarantines_a_larger_gap() {
    let s = Setup::new();
    let command = patch(100, 1, vec![resolve(90)]);
    let receipt = s.service().patch(&owner(), &command).unwrap();
    // Model a process exit immediately after its first companion publication.
    fs::remove_file(s.live()).unwrap();
    let reopened = Registry::open(s.home.path()).unwrap();
    let service = PreferencesService::new(&reopened);
    assert_eq!(service.get(&owner()).unwrap().revision, revision(2));
    assert_eq!(service.patch(&owner(), &command).unwrap(), receipt);
    assert!(!s.backup().exists());
    let mut ledger: Value = serde_json::from_slice(&fs::read(recovery_path(&s)).unwrap()).unwrap();
    ledger["operations"][0]["result"]["preferences_revision"] = json!(4);
    fs::write(recovery_path(&s), serde_json::to_vec(&ledger).unwrap()).unwrap();
    let main = fs::read(s.live()).unwrap();
    let companion = fs::read(recovery_path(&s)).unwrap();
    let saved = service.get(&owner()).unwrap();
    assert_eq!(saved.revision, revision(2));
    assert!(saved.resolved_unsent_input_ids.is_empty());
    assert_eq!(fs::read(s.live()).unwrap(), main);
    assert_quarantined(&s, &companion);
}

#[test]
fn old_valid_full_preferences_keep_markers_with_bounded_additive_response() {
    let s = Setup::new();
    s.service().patch(&owner(), &patch(100, 1, vec![])).unwrap();
    s.service()
        .patch(
            &owner(),
            &patch(101, 2, (10000..15000).map(resolve).collect()),
        )
        .unwrap();
    let mut old: OldRecord = serde_json::from_slice(&fs::read(s.live()).unwrap()).unwrap();
    s.service()
        .patch(
            &owner(),
            &patch(102, 3, (15000..20000).map(resolve).collect()),
        )
        .unwrap();
    old.snapshot.sessions = vec![serde_json::from_value(json!({
        "session":route(),"tab_open":true,"selected_item_id":"1","tab_order":0,
        "rail":"hidden","expanded_item_ids":["1"],
        "filters":{"search":"old owner's data","statuses":[],"owners":[],"topic_id":null,"archived":false,"hide_later":false},
        "scroll":{"item_id":"1","offset":42}
    })).unwrap()];
    old.snapshot.later = vec![ItemRoute {
        project_id: id(1),
        session_id: id(2),
        item_id: ItemRef::new("1").unwrap(),
    }];
    old.snapshot.seen = vec![SessionSeen {
        session: route(),
        since: at(10),
        items: vec![item(1, 2)],
        topics: vec![topic(4, 10)],
    }];
    let draft = |n| OwnerDraft {
        submission_attempted: false,
        op_id: id(n),
        session: route(),
        binding_id: id(3),
        target: InputTarget {
            topic_id: id(4),
            item_id: None,
        },
        intent: InputKind::Reply,
        text: String::new(),
        selected_option_id: None,
        target_revision: revision(1),
        question_revision: None,
        supersedes_answer_id: None,
    };
    let response_size = |snapshot: PreferencesSnapshot| {
        serde_json::to_vec(&ApplicationEnvelope::Success(SuccessEnvelope {
            api_version: SchemaVersion::new(1).unwrap(),
            ok: SuccessFlag,
            data: QueryResult::PreferencesGet(snapshot),
        }))
        .unwrap()
        .len()
    };
    let old_size = |snapshot: &OldSnapshot| {
        response_size(serde_json::from_value(serde_json::to_value(snapshot).unwrap()).unwrap())
    };
    let mut n = 1000;
    while old_size(&old.snapshot) < PREFERENCES_RESPONSE_BYTES - 16 * 1024 - 1024 {
        let mut saved = draft(n);
        saved.text = "x".repeat(16 * 1024);
        old.snapshot.drafts.push(saved);
        n += 1;
    }
    old.snapshot.drafts.push(draft(n));
    let remaining = PREFERENCES_RESPONSE_BYTES - old_size(&old.snapshot) - 1024;
    assert!(remaining <= 16 * 1024);
    old.snapshot.drafts.last_mut().unwrap().text = "y".repeat(remaining);
    assert_eq!(old_size(&old.snapshot), PREFERENCES_RESPONSE_BYTES - 1024);
    // Model the old-valid snapshot present after an interrupted latest marker:
    // projection may advance only its receipt/revision and must keep all data.
    let old_bytes = serde_json::to_vec_pretty(&old).unwrap();
    fs::write(s.live(), &old_bytes).unwrap();
    let saved = s.saved();
    assert_eq!(saved.revision, revision(4));
    assert_eq!(saved.resolved_unsent_input_ids.len(), 10000);
    assert_eq!(saved.drafts, old.snapshot.drafts);
    assert_eq!(saved.later, old.snapshot.later);
    assert_eq!(saved.seen, old.snapshot.seen);
    assert!(saved.sessions[0].tab_open);
    assert_eq!(fs::read(s.backup()).unwrap(), old_bytes);
    let complete_size = response_size(saved.clone());
    assert!(complete_size > PREFERENCES_RESPONSE_BYTES);
    assert!(complete_size <= PREFERENCES_RESPONSE_BYTES + RECOVERY_RESPONSE_BYTES);
    let context = QueryContext::owner(owner());
    QueryResult::PreferencesGet(saved.clone())
        .validate_for(&context, &QueryRequest::PreferencesGet {})
        .unwrap();
    // The allowance belongs only to recovery metadata: ordinary growth still
    // refuses before saving and boundary validation enforces the same rule.
    let mut oversized = draft(n + 1);
    oversized.text = "z".repeat(2048);
    let before = fs::read(s.live()).unwrap();
    let companion = fs::read(recovery_path(&s)).unwrap();
    assert_eq!(
        s.service()
            .patch(
                &owner(),
                &patch(
                    103,
                    4,
                    vec![PreferencesPatchEntry::UpsertDraft {
                        draft: oversized.clone()
                    }]
                )
            )
            .unwrap_err()
            .code,
        CoreErrorCode::CapacityExceeded
    );
    let mut invalid = saved;
    invalid.drafts.push(oversized);
    assert_eq!(
        QueryResult::PreferencesGet(invalid)
            .validate_for(&context, &QueryRequest::PreferencesGet {})
            .unwrap_err()
            .code,
        CoreErrorCode::CapacityExceeded
    );
    assert_eq!(fs::read(s.live()).unwrap(), before);
    assert_eq!(fs::read(recovery_path(&s)).unwrap(), companion);
    let reopened = Registry::open(s.home.path()).unwrap();
    assert_eq!(
        PreferencesService::new(&reopened)
            .get(&owner())
            .unwrap()
            .resolved_unsent_input_ids
            .len(),
        10000
    );
}

#[test]
fn exact_old_response_limit_survives_recovery_revision_digit_rollover() {
    let s = Setup::new();
    s.service()
        .patch(&owner(), &patch(101, 1, vec![resolve(90)]))
        .unwrap();
    let mut old: OldRecord = serde_json::from_slice(&fs::read(s.live()).unwrap()).unwrap();
    old.snapshot.revision = revision(99);
    old.operations[0].operation_id = id(200);
    old.operations[0].result.operation_id = id(200);
    old.operations[0].result.preferences_revision = revision(99);
    // No views: ignoring their old rail key must not create artificial room.
    assert!(old.snapshot.sessions.is_empty());
    let response_size = |snapshot: PreferencesSnapshot| {
        serde_json::to_vec(&ApplicationEnvelope::Success(SuccessEnvelope {
            api_version: SchemaVersion::new(1).unwrap(),
            ok: SuccessFlag,
            data: QueryResult::PreferencesGet(snapshot),
        }))
        .unwrap()
        .len()
    };
    let old_size = |snapshot: &OldSnapshot| {
        response_size(serde_json::from_value(serde_json::to_value(snapshot).unwrap()).unwrap())
    };
    let mut n = 1000;
    let draft = |n| OwnerDraft {
        submission_attempted: false,
        op_id: id(n),
        session: route(),
        binding_id: id(3),
        target: InputTarget {
            topic_id: id(4),
            item_id: None,
        },
        intent: InputKind::Reply,
        text: String::new(),
        selected_option_id: None,
        target_revision: revision(1),
        question_revision: None,
        supersedes_answer_id: None,
    };
    while old_size(&old.snapshot) < PREFERENCES_RESPONSE_BYTES - 16 * 1024 - 1024 {
        let mut saved = draft(n);
        saved.text = "x".repeat(16 * 1024);
        old.snapshot.drafts.push(saved);
        n += 1;
    }
    old.snapshot.drafts.push(draft(n));
    let remaining = PREFERENCES_RESPONSE_BYTES - old_size(&old.snapshot);
    assert!(remaining <= 16 * 1024);
    old.snapshot.drafts.last_mut().unwrap().text = "y".repeat(remaining);
    assert_eq!(old_size(&old.snapshot), PREFERENCES_RESPONSE_BYTES);
    let mut ledger: Value = serde_json::from_slice(&fs::read(recovery_path(&s)).unwrap()).unwrap();
    ledger["operations"][0]["result"]["preferences_revision"] = json!(100);
    fs::write(recovery_path(&s), serde_json::to_vec(&ledger).unwrap()).unwrap();
    let old_bytes = serde_json::to_vec_pretty(&old).unwrap();
    fs::write(s.live(), &old_bytes).unwrap();
    let saved = s.saved();
    assert_eq!(saved.revision, revision(100));
    assert_eq!(saved.drafts, old.snapshot.drafts);
    assert_eq!(saved.resolved_unsent_input_ids, vec![id(90)]);
    assert_eq!(fs::read(s.backup()).unwrap(), old_bytes);
    assert!(response_size(saved.clone()) > PREFERENCES_RESPONSE_BYTES);
    let context = QueryContext::owner(owner());
    QueryResult::PreferencesGet(saved.clone())
        .validate_for(&context, &QueryRequest::PreferencesGet {})
        .unwrap();
    let mut oversized = draft(n + 1);
    oversized.text = "z".repeat(32);
    let before = fs::read(s.live()).unwrap();
    assert_eq!(
        s.service()
            .patch(
                &owner(),
                &patch(
                    103,
                    100,
                    vec![PreferencesPatchEntry::UpsertDraft { draft: oversized }]
                )
            )
            .unwrap_err()
            .code,
        CoreErrorCode::CapacityExceeded
    );
    assert_eq!(fs::read(s.live()).unwrap(), before);
    let reopened = Registry::open(s.home.path()).unwrap();
    assert_eq!(
        PreferencesService::new(&reopened).get(&owner()).unwrap(),
        saved
    );
}
