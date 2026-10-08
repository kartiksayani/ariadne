use ariadne_agent_protocol::{
    Availability, Compatibility, EventPayload, NormalizedEvent, TurnFinishedStatus,
};
use ariadne_core::{
    bindings::VerifiedHost,
    native::{NativeCoreService, PreferencesService},
    *,
};
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
use std::{
    fs,
    os::unix::fs::{symlink, MetadataExt, PermissionsExt},
    process::{Child, Command},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tempfile::TempDir;

/// Project store directory under a data-root home, as `Registry::project_dir` derives it.
fn store_dir(home: &std::path::Path, project: u64) -> std::path::PathBuf {
    home.join(".ariadne/projects").join(id(project).as_str())
}
fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn one() -> SchemaVersion {
    SchemaVersion::new(1).unwrap()
}
fn revision(n: u64) -> PositiveSafeInteger {
    PositiveSafeInteger::new(n).unwrap()
}
fn at() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:06.000Z").unwrap()
}
fn owner() -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Preferences)
}
fn route() -> RegisteredSession {
    RegisteredSession::from_trusted_entrypoint(id(1), id(2))
}
fn session_owner() -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Session(route()))
}
fn reference(n: u64) -> SessionRef {
    SessionRef {
        project_id: id(n),
        session_id: id(n + 1),
    }
}
fn patch(op: u64, expected: u64, entries: Vec<PreferencesPatchEntry>) -> OwnerCommand {
    OwnerCommand::PreferencesPatch {
        api_version: one(),
        op_id: id(op),
        params: PreferencesPatch {
            expected_preferences_revision: revision(expected),
            entries,
        },
    }
}
fn draft(n: u64, text: &str) -> OwnerDraft {
    OwnerDraft {
        submission_attempted: false,
        op_id: id(n),
        session: reference(700),
        binding_id: id(702),
        target: InputTarget {
            topic_id: id(703),
            item_id: Some(ItemRef::new("1").unwrap()),
        },
        intent: InputKind::Answer,
        text: text.into(),
        selected_option_id: Some("saved-option".into()),
        target_revision: revision(3),
        question_revision: Some(revision(2)),
        supersedes_answer_id: Some(id(704)),
    }
}
fn view() -> SessionPreferences {
    SessionPreferences {
        session: reference(700),
        tab_open: false,
        selected_item_id: Some(ItemRef::new("1").unwrap()),
        tab_order: NonnegativeSafeInteger::new(4).unwrap(),
        expanded_item_ids: vec![ItemRef::new("1").unwrap()],
        filters: ViewFilters {
            search: " exact café\n".into(),
            statuses: vec![ItemStatus::WaitingOnMe],
            owners: vec![],
            topic_id: Some(id(703)),
            archived: true,
            hide_later: false,
        },
        rail: RailView::Sent,
        scroll: Some(ScrollAnchor {
            item_id: None,
            offset: 37.5,
        }),
        collapsed_topic_ids: vec![id(703)],
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
    fn preferences(&self) -> PreferencesService<'_> {
        PreferencesService::new(&self.registry)
    }
    fn live(&self) -> std::path::PathBuf {
        self.home.path().join(".ariadne/ui.json")
    }
    fn backup(&self) -> std::path::PathBuf {
        self.home.path().join(".ariadne/ui.previous.json")
    }
}
fn write_private(path: &std::path::Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

#[test]
fn attempted_drafts_survive_restart_and_cannot_change_payload_or_marker() {
    let s = Setup::new();
    let mut saved = draft(80, " Exact attempted bytes ");
    saved.submission_attempted = true;
    s.preferences()
        .patch(
            &owner(),
            &patch(
                90,
                1,
                vec![PreferencesPatchEntry::UpsertDraft {
                    draft: saved.clone(),
                }],
            ),
        )
        .unwrap();
    let reopened = Registry::open(s.home.path()).unwrap();
    assert_eq!(
        PreferencesService::new(&reopened)
            .get(&owner())
            .unwrap()
            .drafts,
        vec![saved.clone()]
    );
    for changed in [
        OwnerDraft {
            text: "Different body".into(),
            ..saved.clone()
        },
        OwnerDraft {
            submission_attempted: false,
            ..saved.clone()
        },
    ] {
        assert_eq!(
            s.preferences()
                .patch(
                    &owner(),
                    &patch(
                        91,
                        2,
                        vec![PreferencesPatchEntry::UpsertDraft { draft: changed }]
                    )
                )
                .unwrap_err()
                .code,
            CoreErrorCode::OperationReused
        );
    }
    assert_eq!(s.preferences().get(&owner()).unwrap().revision, revision(2));
    s.preferences()
        .patch(
            &owner(),
            &patch(
                92,
                2,
                vec![PreferencesPatchEntry::UpsertDraft {
                    draft: saved.clone(),
                }],
            ),
        )
        .unwrap();
    s.preferences()
        .patch(
            &owner(),
            &patch(
                93,
                3,
                vec![PreferencesPatchEntry::DeleteDraft {
                    operation_id: saved.op_id,
                }],
            ),
        )
        .unwrap();
    assert!(s.preferences().get(&owner()).unwrap().drafts.is_empty());
}

#[test]
fn older_unsent_draft_defaults_marker_and_attempted_empty_body_is_rejected() {
    let mut value = serde_json::to_value(draft(80, "Unsent bytes")).unwrap();
    value
        .as_object_mut()
        .unwrap()
        .remove("submission_attempted");
    let restored: OwnerDraft = serde_json::from_value(value).unwrap();
    assert!(!restored.submission_attempted);
    let mut invalid = draft(80, " ");
    invalid.selected_option_id = None;
    invalid.submission_attempted = true;
    assert_eq!(
        patch(
            90,
            1,
            vec![PreferencesPatchEntry::UpsertDraft { draft: invalid }]
        )
        .validate_wire()
        .unwrap_err()
        .code,
        CoreErrorCode::InvalidArgument
    );
}

#[test]
fn legacy_draft_patch_replays_with_unchanged_normalized_command_bytes() {
    let s = Setup::new();
    let command = patch(
        90,
        1,
        vec![PreferencesPatchEntry::UpsertDraft {
            draft: draft(80, "Legacy exact bytes"),
        }],
    );
    let legacy = serde_json::to_value(&command).unwrap();
    assert!(legacy["params"]["entries"][0]["draft"]
        .get("submission_attempted")
        .is_none());
    let decoded: OwnerCommand = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(serde_json::to_value(&decoded).unwrap(), legacy);
    let saved = s.preferences().patch(&owner(), &decoded).unwrap();
    let before = fs::read(s.live()).unwrap();
    assert!(!String::from_utf8(before.clone())
        .unwrap()
        .contains("submission_attempted"));
    let reopened = Registry::open(s.home.path()).unwrap();
    assert_eq!(
        PreferencesService::new(&reopened)
            .patch(&owner(), &command)
            .unwrap(),
        saved
    );
    assert_eq!(fs::read(s.live()).unwrap(), before);
}

#[test]
fn absent_preferences_are_canonical_defaults_without_a_data_write() {
    let s = Setup::new();
    let value = s.preferences().get(&owner()).unwrap();
    assert_eq!(value.revision, revision(1));
    assert_eq!(value.schema_version, one());
    assert_eq!(value.global.theme, Theme::System);
    assert_eq!(
        value.global.selected_navigation,
        NavigationSelection::Projects {}
    );
    assert!(!value.global.pinned);
    assert!(value.global.window.is_none());
    assert!(value.global.notification_watermark.is_none());
    assert!(value.global.detail_width.is_none() && !value.global.waiting_collapsed);
    assert!(value.sessions.is_empty() && value.later.is_empty() && value.drafts.is_empty());
    assert!(!s.live().exists());
    assert!(!s.backup().exists());
    let lock = fs::metadata(s.home.path().join(".ariadne/ui.lock")).unwrap();
    assert_eq!(lock.mode() & 0o777, 0o600);
    assert_eq!(s.preferences().get(&owner()).unwrap(), value);
}

#[test]
fn all_typed_patch_effects_are_durable_preserving_stale_routes_and_inert_exact_drafts() {
    let s = Setup::new();
    let mut global = s.preferences().get(&owner()).unwrap().global;
    global.theme = Theme::Dark;
    global.pinned = true;
    global.window = Some(WindowGeometry {
        x: -12.0,
        y: 7.0,
        width: 800.0,
        height: 600.0,
        monitor_id: Some("display✓".into()),
    });
    global.notification_watermark = Some(at());
    global.detail_width = Some(DETAIL_WIDTH_MAX);
    global.waiting_collapsed = true;
    global.selected_navigation = NavigationSelection::Session {
        session: reference(700),
    };
    let saved_view = view();
    let saved_draft = draft(80, "\n Exact unsent text café \n");
    let later = ItemRoute {
        project_id: id(700),
        session_id: id(701),
        item_id: ItemRef::new("1").unwrap(),
    };
    let entries = vec![
        PreferencesPatchEntry::SetGlobal {
            preferences: global.clone(),
        },
        PreferencesPatchEntry::SetSessionView {
            preferences: saved_view.clone(),
        },
        PreferencesPatchEntry::SetLater {
            item: later.clone(),
            later: true,
        },
        PreferencesPatchEntry::UpsertDraft {
            draft: saved_draft.clone(),
        },
    ];
    let first = s
        .preferences()
        .patch(&owner(), &patch(90, 1, entries))
        .unwrap();
    assert_eq!(first.preferences_revision, revision(2));
    assert_eq!(first.operation_id, id(90));
    assert!(!s.backup().exists());
    let lock = fs::metadata(s.home.path().join(".ariadne/ui.lock"))
        .unwrap()
        .ino();
    let first_bytes = fs::read(s.live()).unwrap();
    let reopened = Registry::open(s.home.path()).unwrap();
    let before = PreferencesService::new(&reopened).get(&owner()).unwrap();
    assert_eq!(before.global, global);
    assert_eq!(before.sessions, vec![saved_view.clone()]);
    assert_eq!(before.drafts, vec![saved_draft.clone()]);
    assert_eq!(before.later, vec![later.clone()]);
    // Unrelated global writes preserve unavailable routes/drafts without opening domains.
    global.theme = Theme::Light;
    s.preferences()
        .patch(
            &owner(),
            &patch(
                91,
                2,
                vec![PreferencesPatchEntry::SetGlobal {
                    preferences: global.clone(),
                }],
            ),
        )
        .unwrap();
    let after = s.preferences().get(&owner()).unwrap();
    assert_eq!(after.drafts, before.drafts);
    assert_eq!(after.sessions, before.sessions);
    assert_eq!(after.later, before.later);
    assert_eq!(fs::read(s.backup()).unwrap(), first_bytes);
    assert_eq!(fs::metadata(s.live()).unwrap().mode() & 0o777, 0o600);
    assert_eq!(
        fs::metadata(s.home.path().join(".ariadne/ui.lock"))
            .unwrap()
            .ino(),
        lock
    );
    let mut changed = saved_draft;
    changed.text = "updated exact draft".into();
    let mut changed_view = saved_view;
    changed_view.tab_open = true;
    s.preferences()
        .patch(
            &owner(),
            &patch(
                92,
                3,
                vec![
                    PreferencesPatchEntry::UpsertDraft {
                        draft: changed.clone(),
                    },
                    PreferencesPatchEntry::SetSessionView {
                        preferences: changed_view.clone(),
                    },
                    PreferencesPatchEntry::SetLater {
                        item: later.clone(),
                        later: true,
                    },
                ],
            ),
        )
        .unwrap();
    let after = s.preferences().get(&owner()).unwrap();
    assert_eq!(after.drafts, vec![changed]);
    assert_eq!(after.sessions, vec![changed_view]);
    assert_eq!(after.later, vec![later.clone()]);
    s.preferences()
        .patch(
            &owner(),
            &patch(
                93,
                4,
                vec![
                    PreferencesPatchEntry::DeleteDraft {
                        operation_id: id(80),
                    },
                    PreferencesPatchEntry::SetLater {
                        item: later,
                        later: false,
                    },
                ],
            ),
        )
        .unwrap();
    let after = s.preferences().get(&owner()).unwrap();
    assert!(after.drafts.is_empty() && after.later.is_empty());
    assert_eq!(after.sessions.len(), 1);
    assert!(!s.home.path().join(".ariadne/sessions").exists());
    assert!(!s.home.path().join(".ariadne/projects.json").exists());
}

#[test]
fn replay_precedes_revision_guards_and_same_operation_changed_parameters_conflict() {
    let s = Setup::new();
    let original = patch(
        100,
        1,
        vec![PreferencesPatchEntry::UpsertDraft {
            draft: draft(101, "exact draft"),
        }],
    );
    let saved = s.preferences().patch(&owner(), &original).unwrap();
    s.preferences()
        .patch(&owner(), &patch(102, 2, vec![]))
        .unwrap();
    let live = fs::read(s.live()).unwrap();
    let backup = fs::read(s.backup()).unwrap();
    assert_eq!(s.preferences().patch(&owner(), &original).unwrap(), saved);
    assert_eq!(fs::read(s.live()).unwrap(), live);
    assert_eq!(fs::read(s.backup()).unwrap(), backup);
    assert_eq!(
        s.preferences()
            .patch(&owner(), &patch(100, 3, vec![]))
            .unwrap_err()
            .code,
        CoreErrorCode::OperationReused
    );
    let error = s
        .preferences()
        .patch(&owner(), &patch(103, 1, vec![]))
        .unwrap_err();
    assert_eq!(error.code, CoreErrorCode::RevisionConflict);
    assert_eq!(error.current_revision, Some(revision(3)));
    assert_eq!(fs::read(s.live()).unwrap(), live);
}

#[test]
fn malformed_future_and_invalid_persisted_preferences_preserve_live_and_backup_bytes() {
    let s = Setup::new();
    s.preferences()
        .patch(
            &owner(),
            &patch(
                100,
                1,
                vec![PreferencesPatchEntry::UpsertDraft {
                    draft: draft(101, "saved"),
                }],
            ),
        )
        .unwrap();
    let original: serde_json::Value = serde_json::from_slice(&fs::read(s.live()).unwrap()).unwrap();
    write_private(&s.backup(), b"preserved previous evidence");
    let mut cases = vec![
        (b"{broken".to_vec(), CoreErrorCode::CorruptSession),
        (
            b"{\"snapshot\":{},\"snapshot\":{},\"operations\":[]}".to_vec(),
            CoreErrorCode::CorruptSession,
        ),
    ];
    for (pointer, replacement, code) in [
        (
            "/snapshot/schema_version",
            serde_json::json!(2),
            CoreErrorCode::FutureSchema,
        ),
        (
            "/snapshot/unknown",
            serde_json::json!(1),
            CoreErrorCode::CorruptSession,
        ),
        (
            "/snapshot/drafts/0/text",
            serde_json::json!("bad\u{0}draft"),
            CoreErrorCode::CorruptSession,
        ),
        (
            "/operations/0/result/preferences_revision",
            serde_json::json!(3),
            CoreErrorCode::CorruptSession,
        ),
        (
            "/operations/0/actor_scope",
            serde_json::json!({"kind":"adapter","binding_id":id(8)}),
            CoreErrorCode::CorruptSession,
        ),
    ] {
        let mut value = original.clone();
        if pointer == "/snapshot/unknown" {
            value["snapshot"]["unknown"] = replacement;
        } else {
            *value.pointer_mut(pointer).unwrap() = replacement;
        }
        cases.push((serde_json::to_vec(&value).unwrap(), code));
    }
    for (bytes, code) in cases {
        write_private(&s.live(), &bytes);
        let error = s.preferences().get(&owner()).unwrap_err();
        assert_eq!(error.code, code);
        error.validate().unwrap();
        assert!(error.message.contains("ui.json"));
        assert_eq!(
            s.preferences()
                .patch(&owner(), &patch(200, 2, vec![]))
                .unwrap_err()
                .code,
            code
        );
        assert_eq!(fs::read(s.live()).unwrap(), bytes);
        assert_eq!(
            fs::read(s.backup()).unwrap(),
            b"preserved previous evidence"
        );
    }
}

#[test]
fn invalid_patch_and_response_capacity_reject_before_publication() {
    let s = Setup::new();
    let mut bad = view();
    bad.scroll.as_mut().unwrap().offset = f64::INFINITY;
    assert_eq!(
        s.preferences()
            .patch(
                &owner(),
                &patch(
                    10,
                    1,
                    vec![PreferencesPatchEntry::SetSessionView { preferences: bad }]
                )
            )
            .unwrap_err()
            .code,
        CoreErrorCode::InvalidArgument
    );
    assert!(!s.live().exists());
    // Layout preferences stay inside the renderer's bounds.
    let mut global = s.preferences().get(&owner()).unwrap().global;
    for width in [DETAIL_WIDTH_MIN - 1, DETAIL_WIDTH_MAX + 1] {
        global.detail_width = Some(width);
        let entries = vec![PreferencesPatchEntry::SetGlobal {
            preferences: global.clone(),
        }];
        assert_eq!(
            s.preferences()
                .patch(&owner(), &patch(11, 1, entries))
                .unwrap_err()
                .code,
            CoreErrorCode::InvalidArgument
        );
    }
    let mut folded = view();
    folded.collapsed_topic_ids = vec![id(703), id(703)];
    let entries = vec![PreferencesPatchEntry::SetSessionView {
        preferences: folded.clone(),
    }];
    assert_eq!(
        s.preferences()
            .patch(&owner(), &patch(12, 1, entries))
            .unwrap_err()
            .code,
        CoreErrorCode::InvalidArgument
    );
    folded.collapsed_topic_ids = (0..=COLLAPSED_TOPICS_CAPACITY as u64)
        .map(|n| id(5000 + n))
        .collect();
    let entries = vec![PreferencesPatchEntry::SetSessionView {
        preferences: folded,
    }];
    assert_eq!(
        s.preferences()
            .patch(&owner(), &patch(13, 1, entries))
            .unwrap_err()
            .code,
        CoreErrorCode::CapacityExceeded
    );
    assert!(!s.live().exists());
    // Each request is below512KiB; their aggregate response must remain retrievable.
    let mut n = 0;
    let mut expected = 1;
    let mut rejected = false;
    for batch in 0..5 {
        let entries = (0..16)
            .map(|_| {
                n += 1;
                PreferencesPatchEntry::UpsertDraft {
                    draft: draft(1000 + n, &"é".repeat(8000)),
                }
            })
            .collect();
        let before = fs::read(s.live()).ok();
        let backup = fs::read(s.backup()).ok();
        match s
            .preferences()
            .patch(&owner(), &patch(100 + batch, expected, entries))
        {
            Ok(_) => expected += 1,
            Err(error) => {
                assert_eq!(error.code, CoreErrorCode::CapacityExceeded);
                assert_eq!(fs::read(s.live()).ok(), before);
                assert_eq!(fs::read(s.backup()).ok(), backup);
                rejected = true;
                break;
            }
        }
    }
    assert!(rejected);
    let snapshot = s.preferences().get(&owner()).unwrap();
    let framed = ApplicationEnvelope::Success(SuccessEnvelope {
        api_version: one(),
        ok: SuccessFlag,
        data: QueryResult::PreferencesGet(snapshot),
    });
    assert!(serde_json::to_vec(&framed).unwrap().len() <= 1024 * 1024);
}

#[test]
fn unsafe_targets_and_backup_failure_never_publish_a_candidate() {
    for is_link in [false, true] {
        let s = Setup::new();
        let other = s.home.path().join("preserve");
        write_private(&other, b"authoritative bytes");
        if is_link {
            symlink(&other, s.live()).unwrap();
        } else {
            write_private(&s.live(), b"data");
            fs::set_permissions(s.live(), fs::Permissions::from_mode(0o644)).unwrap();
        }
        let expected = if is_link {
            CoreErrorCode::IoError
        } else {
            CoreErrorCode::PermissionDenied
        };
        assert_eq!(s.preferences().get(&owner()).unwrap_err().code, expected);
        assert_eq!(
            s.preferences()
                .patch(&owner(), &patch(5, 1, vec![]))
                .unwrap_err()
                .code,
            expected
        );
        assert_eq!(fs::read(other).unwrap(), b"authoritative bytes");
    }
    let s = Setup::new();
    s.preferences()
        .patch(&owner(), &patch(1, 1, vec![]))
        .unwrap();
    let live = fs::read(s.live()).unwrap();
    fs::create_dir(s.backup()).unwrap();
    assert!(s
        .preferences()
        .patch(&owner(), &patch(2, 2, vec![]))
        .is_err());
    assert_eq!(fs::read(s.live()).unwrap(), live);
    assert!(!fs::read_dir(s.live().parent().unwrap()).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains(".tmp-")));
}

#[test]
fn preferences_never_cross_owner_global_scope_or_create_inputs() {
    let s = Setup::new();
    for wrong in [
        OwnerContext::from_trusted_entrypoint(OwnerScope::Registry),
        session_owner(),
    ] {
        assert_eq!(
            s.preferences().get(&wrong).unwrap_err().code,
            CoreErrorCode::PermissionDenied
        );
        assert_eq!(
            s.preferences()
                .patch(&wrong, &patch(1, 1, vec![]))
                .unwrap_err()
                .code,
            CoreErrorCode::PermissionDenied
        );
    }
    let core = NativeCoreService::new(
        s.registry,
        || panic!("preferences don't allocate domain IDs"),
        at,
        |_| panic!("preferences don't qualify hosts"),
    );
    let agent = AgentContext::from_trusted_entrypoint(
        route(),
        id(3),
        id(4),
        AgentReadScope::Terminal {
            issued_through_message_number: NonnegativeSafeInteger::new(0).unwrap(),
        },
    );
    assert_eq!(
        core.query(QueryContext::agent(agent), QueryRequest::PreferencesGet {})
            .unwrap_err()
            .code,
        CoreErrorCode::PermissionDenied
    );
    assert!(matches!(
        core.query(
            QueryContext::owner(owner()),
            QueryRequest::PreferencesGet {}
        )
        .unwrap(),
        QueryResult::PreferencesGet(_)
    ));
    assert!(matches!(
        core.execute_owner(
            owner(),
            patch(
                1,
                1,
                vec![PreferencesPatchEntry::UpsertDraft {
                    draft: draft(2, "only an unsent draft")
                }]
            )
        )
        .unwrap(),
        MutationReceipt::PreferencesPatched(_)
    ));
    assert!(!s.home.path().join(".ariadne/sessions").exists());
}

struct Children(Vec<Child>);
impl Drop for Children {
    fn drop(&mut self) {
        for child in &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
#[test]
fn preference_writer_subprocess() {
    let Ok(home) = std::env::var("ARIADNE_TEST_PREF_HOME") else {
        return;
    };
    let slot: u64 = std::env::var("ARIADNE_TEST_PREF_SLOT")
        .unwrap()
        .parse()
        .unwrap();
    let registry = Registry::open(std::path::Path::new(&home)).unwrap();
    let prefs = PreferencesService::new(&registry);
    fs::write(
        std::path::Path::new(&home).join(format!("ready-{slot}")),
        b"ready",
    )
    .unwrap();
    let begin = Instant::now();
    while !std::path::Path::new(&home).join("start").exists() {
        assert!(begin.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(5));
    }
    for _ in 0..10 {
        let revision = prefs.get(&owner()).unwrap().revision.value();
        match prefs.patch(
            &owner(),
            &patch(
                500 + slot,
                revision,
                vec![PreferencesPatchEntry::UpsertDraft {
                    draft: draft(700 + slot, &format!("writer{slot} exact draft")),
                }],
            ),
        ) {
            Ok(_) => return,
            Err(error) if error.code == CoreErrorCode::RevisionConflict => {}
            Err(error) => panic!("{error:?}"),
        }
    }
    panic!("bounded revision retry exhausted")
}
#[test]
fn separate_writer_processes_reread_and_preserve_both_drafts() {
    let s = Setup::new();
    let mut children = Children(vec![]);
    for slot in [1, 2] {
        children.0.push(
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "preference_writer_subprocess", "--nocapture"])
                .env("ARIADNE_TEST_PREF_HOME", s.home.path())
                .env("ARIADNE_TEST_PREF_SLOT", slot.to_string())
                .spawn()
                .unwrap(),
        );
    }
    let begin = Instant::now();
    while !(1..=2).all(|slot| s.home.path().join(format!("ready-{slot}")).exists()) {
        for child in &mut children.0 {
            assert!(
                child.try_wait().unwrap().is_none(),
                "writer exited before ready"
            );
        }
        assert!(begin.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(5));
    }
    fs::write(s.home.path().join("start"), b"start").unwrap();
    for child in &mut children.0 {
        let begin = Instant::now();
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(begin.elapsed() < Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    let snapshot = s.preferences().get(&owner()).unwrap();
    assert_eq!(snapshot.revision, revision(3));
    assert_eq!(snapshot.drafts.len(), 2);
    for slot in [1, 2] {
        assert!(snapshot
            .drafts
            .contains(&draft(700 + slot, &format!("writer{slot} exact draft"))));
    }
}

fn native_with_seed() -> (TempDir, TempDir, NativeCoreService) {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    registry.register(root.path(), &id(99), || id(1)).unwrap();
    let seed: Session =
        serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json")).unwrap();
    Store::open_registered(&store_dir(home.path(), 1), id(1))
        .unwrap()
        .create(&seed)
        .unwrap();
    let ids = Arc::new(AtomicU64::new(10000));
    let core = NativeCoreService::new(
        registry,
        move || id(ids.fetch_add(1, Ordering::SeqCst)),
        at,
        |_| panic!("no provider preflight in delivery"),
    );
    (home, root, core)
}
fn submit(core: &dyn CoreService, n: u64) -> UuidV4 {
    let saved = core
        .execute_owner(
            session_owner(),
            OwnerCommand::InputSubmit {
                api_version: one(),
                op_id: id(n),
                params: InputSubmitParams {
                    binding_id: id(3),
                    target: InputTarget {
                        topic_id: id(5),
                        item_id: Some(ItemRef::new("1").unwrap()),
                    },
                    kind: InputKind::Reply,
                    text: format!("exact owner reply{n}\n"),
                    selected_option_id: None,
                    expected_question_revision: None,
                    supersedes_answer_id: None,
                },
            },
        )
        .unwrap();
    let MutationReceipt::Session(saved) = saved else {
        panic!()
    };
    let SavedReceiptData::InputSubmit { input_id, .. } = saved.data else {
        panic!()
    };
    input_id
}
fn lease() -> ValidatedDispatchContext {
    ValidatedDispatchContext::from_trusted_current_lease(route(), id(3), id(4))
}
fn adapter() -> AdapterContext {
    AdapterContext::from_trusted_entrypoint(route(), id(3), id(4), None)
}
fn event(p: &PreparedAttempt, name: &str, payload: EventPayload) -> NormalizedEvent {
    NormalizedEvent {
        event_id: name.into(),
        binding_id: id(3),
        generation: id(4),
        input_id: Some(p.input_id.clone()),
        attempt_id: Some(p.attempt_id.clone()),
        host_turn_id: Some("real-source/test-turn".into()),
        observed_at: UtcMillis::new("2026-10-04T12:00:01.000Z").unwrap(),
        event: payload,
    }
}

#[test]
fn concrete_core_routes_real_input_fifo_claim_report_apply_and_join_receipts() {
    let (home, _root, core) = native_with_seed();
    let service: &dyn CoreService = &core;
    let first = submit(service, 100);
    let second = submit(service, 101);
    let request = ClaimRequest {
        binding_id: id(3),
        generation: id(4),
        request_id: id(102),
    };
    let prepared = service.claim(lease(), request.clone()).unwrap().unwrap();
    assert_eq!(prepared.input_id, first);
    prepared.validate_for(&request).unwrap();
    assert_eq!(
        service.claim(lease(), request).unwrap(),
        Some(prepared.clone())
    );
    assert!(service
        .claim(
            lease(),
            ClaimRequest {
                binding_id: id(3),
                generation: id(4),
                request_id: id(103)
            }
        )
        .unwrap()
        .is_none());
    let start = event(&prepared, "start-full-id", EventPayload::TurnStarted {});
    let mut receipt = service.report(adapter(), start.clone()).unwrap();
    assert!(receipt.durable_effect);
    receipt.replayed = true;
    assert_eq!(service.report(adapter(), start).unwrap(), receipt);
    let current = Store::open_registered(&store_dir(home.path(), 1), id(1))
        .unwrap()
        .read(&id(2))
        .unwrap();
    let result = ApplyRequest {
        op_id: id(105),
        source_input_id: Some(first.clone()),
        attempt_id: Some(prepared.attempt_id.clone()),
        expected_item_revisions: UniqueMap(std::collections::BTreeMap::from([(
            ItemRef::new("1").unwrap(),
            current.items.0[&ItemRef::new("1").unwrap()].revision,
        )])),
        expected_topic_revisions: UniqueMap(Default::default()),
        summary: String::new(),
        operations: vec![Operation::Reply {
            r#ref: RequestRef::new("full_reply").unwrap(),
            item: EntityRef::Existing(ExistingRef {
                id: ItemRef::new("1").unwrap(),
            }),
            text: "Complete structured reply from the real Apply delegate.".into(),
            round_id: None,
        }],
        input_result: Some(ResultDraft {
            outcome: ResultOutcome::Deferred,
            explanation: "No domain change is required.".into(),
            reply_refs: vec![UuidRef::Local(LocalRef {
                r#ref: RequestRef::new("full_reply").unwrap(),
            })],
            followup_item_refs: vec![],
            handled_through_message_number: revision(2),
        }),
    };
    let agent = AgentContext::from_trusted_entrypoint(
        route(),
        id(3),
        id(4),
        AgentReadScope::Dispatched {
            source_input_id: first.clone(),
            attempt_id: prepared.attempt_id.clone(),
            issued_through_message_number: NonnegativeSafeInteger::new(2).unwrap(),
        },
    );
    let applied = service.apply(agent.clone(), result.clone()).unwrap();
    assert_eq!(service.apply(agent, result).unwrap(), applied);
    service
        .report(
            adapter(),
            event(
                &prepared,
                "finish-full-id",
                EventPayload::TurnFinished {
                    status: TurnFinishedStatus::Completed,
                    reason: None,
                    diagnostic_text: None,
                    truncated: false,
                },
            ),
        )
        .unwrap();
    let saved = Store::open_registered(&store_dir(home.path(), 1), id(1))
        .unwrap()
        .read(&id(2))
        .unwrap();
    assert_eq!(saved.inputs.0[&first].state, InputState::Handled);
    assert!(saved.inputs.0[&first].attempts[0].sealed_at.is_some());
    assert_eq!(saved.inputs.0[&second].state, InputState::Queued);
    let next = service
        .claim(
            lease(),
            ClaimRequest {
                binding_id: id(3),
                generation: id(4),
                request_id: id(106),
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(next.input_id, second);
    let queried = service
        .query(
            QueryContext::owner(session_owner()),
            QueryRequest::SessionGet {},
        )
        .unwrap();
    let QueryResult::SessionGet(snapshot) = queried else {
        panic!()
    };
    assert_eq!(
        snapshot.session.inputs.0[&second].active_attempt_id,
        Some(next.attempt_id)
    );
}

#[test]
fn concrete_native_expiry_and_cancel_delegate_preserve_owned_history() {
    let (home, _root, core) = native_with_seed();
    let cancelled = submit(&core, 100);
    let before = Store::open_registered(&store_dir(home.path(), 1), id(1))
        .unwrap()
        .read(&id(2))
        .unwrap();
    core.execute_owner(
        session_owner(),
        OwnerCommand::InputCancel {
            api_version: one(),
            op_id: id(101),
            params: InputCancelParams {
                input_id: cancelled.clone(),
                expected_revision: before.revision,
                purpose: None,
            },
        },
    )
    .unwrap();
    let input = submit(&core, 102);
    let prepared = core
        .claim(
            lease(),
            ClaimRequest {
                binding_id: id(3),
                generation: id(4),
                request_id: id(103),
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(prepared.input_id, input);
    core.report(
        adapter(),
        event(
            &prepared,
            "completed-without-result",
            EventPayload::TurnFinished {
                status: TurnFinishedStatus::Completed,
                reason: None,
                diagnostic_text: None,
                truncated: false,
            },
        ),
    )
    .unwrap();
    let expiry = core
        .expire_missing_result(&adapter(), &input, &prepared.attempt_id, &id(104))
        .unwrap()
        .unwrap();
    assert!(matches!(
        expiry.data,
        SavedReceiptData::DeliveryExpiry { .. }
    ));
    assert_eq!(
        core.expire_missing_result(&adapter(), &input, &prepared.attempt_id, &id(104))
            .unwrap(),
        Some(expiry)
    );
    assert!(core
        .expire_missing_result(&adapter(), &input, &prepared.attempt_id, &id(105))
        .unwrap()
        .is_none());
    let saved = Store::open_registered(&store_dir(home.path(), 1), id(1))
        .unwrap()
        .read(&id(2))
        .unwrap();
    assert_eq!(saved.inputs.0[&cancelled].state, InputState::Cancelled);
    assert!(saved.inputs.0[&cancelled].attempts.is_empty());
    assert!(before.messages.iter().all(|m| saved.messages.contains(m)));
    assert_eq!(saved.inputs.0[&input].state, InputState::NeedsAttention);
    assert_eq!(
        saved.bindings.0[&id(3)].pause_reason,
        Some(PauseReason::ResultMissing)
    );
    // Owner rule: close is one step; it abandons the input needing attention
    // and lifts the barrier it caused, leaving only the owner pause.
    let MutationReceipt::Session(closed) = core
        .execute_owner(
            session_owner(),
            OwnerCommand::SessionClose {
                api_version: one(),
                op_id: id(107),
                params: SessionLifecycleParams {
                    expected_revision: saved.revision,
                },
            },
        )
        .unwrap()
    else {
        panic!("session receipt")
    };
    assert!(matches!(
        &closed.data,
        SavedReceiptData::SessionLifecycle { cancelled_input_ids, .. }
            if cancelled_input_ids == &vec![input.clone()]
    ));
    let saved = Store::open_registered(&store_dir(home.path(), 1), id(1))
        .unwrap()
        .read(&id(2))
        .unwrap();
    assert_eq!(saved.inputs.0[&input].state, InputState::Cancelled);
    assert_eq!(
        saved.inputs.0[&input].cancel_cause,
        Some(CancelCause::SessionClosed)
    );
    // The one the owner cancelled earlier keeps its own cause.
    assert_eq!(
        saved.inputs.0[&cancelled].cancel_cause,
        Some(CancelCause::Owner)
    );
    let binding = &saved.bindings.0[&id(3)];
    assert_eq!(binding.pause_reason, None);
    assert!(binding.owner_paused);
    assert_eq!(binding.dispatch_state, DispatchState::Paused);
}

/// Reads the saved session back from the store.
fn read_saved(home: &std::path::Path) -> Session {
    Store::open_registered(&store_dir(home, 1), id(1))
        .unwrap()
        .read(&id(2))
        .unwrap()
}
fn cancel_command(
    op: u64,
    input_id: &UuidV4,
    expected_revision: PositiveSafeInteger,
) -> OwnerCommand {
    OwnerCommand::InputCancel {
        api_version: one(),
        op_id: id(op),
        params: InputCancelParams {
            input_id: input_id.clone(),
            expected_revision,
            purpose: None,
        },
    }
}

#[test]
fn cancelling_a_queued_input_ignores_unrelated_session_changes_but_never_beats_a_claim() {
    let (home, _root, core) = native_with_seed();
    let first = submit(&core, 100);
    let reviewed = read_saved(home.path()).revision;
    // Later submits (and in real life agent reports or applies) bump the session revision.
    let second = submit(&core, 101);
    let third = submit(&core, 102);
    assert!(read_saved(home.path()).revision > reviewed);
    // A queued input cancels against a stale revision: it has not reached the agent.
    core.execute_owner(session_owner(), cancel_command(110, &third, reviewed))
        .unwrap();
    let saved = read_saved(home.path());
    assert_eq!(saved.inputs.0[&third].state, InputState::Cancelled);
    assert_eq!(
        saved.inputs.0[&third].cancel_cause,
        Some(CancelCause::Owner)
    );
    // The claim takes the oldest queued input, and bumps the revision.
    let reviewed = saved.revision;
    let prepared = core
        .claim(
            lease(),
            ClaimRequest {
                binding_id: id(3),
                generation: id(4),
                request_id: id(120),
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(prepared.input_id, first);
    let claimed = read_saved(home.path());
    assert_eq!(claimed.inputs.0[&first].state, InputState::InFlight);
    assert!(claimed.revision > reviewed);
    // A cancel that was reviewed before the claim is the in-flight path: it conflicts
    // instead of silently abandoning the attempt, and nothing changes.
    let error = core
        .execute_owner(session_owner(), cancel_command(111, &first, reviewed))
        .unwrap_err();
    assert_eq!(error.code, CoreErrorCode::RevisionConflict);
    assert_eq!(read_saved(home.path()), claimed);
    // The one still queued behind it cancels regardless of the claim's bump.
    core.execute_owner(session_owner(), cancel_command(112, &second, reviewed))
        .unwrap();
    let saved = read_saved(home.path());
    assert_eq!(saved.inputs.0[&second].state, InputState::Cancelled);
    assert_eq!(saved.inputs.0[&first].state, InputState::InFlight);
}

#[test]
fn native_registration_and_binding_preflight_use_actual_locks_and_exact_replay() {
    let (home, root, old_core) = native_with_seed();
    let seed = Store::open_registered(&store_dir(home.path(), 1), id(1))
        .unwrap()
        .read(&id(2))
        .unwrap();
    let template = seed.bindings.0[&id(3)].clone();
    let calls = Arc::new(AtomicU64::new(0));
    let observed = calls.clone();
    let data_home = home.path().to_owned();
    let project_root = store_dir(home.path(), 1);
    let ids = Arc::new(AtomicU64::new(20000));
    drop(old_core);
    let core = NativeCoreService::new(
        Registry::open(home.path()).unwrap(),
        move || id(ids.fetch_add(1, Ordering::SeqCst)),
        at,
        move |params| {
            observed.fetch_add(1, Ordering::SeqCst);
            // Reentrant reads acquire the same real registry, session and UI locks.
            // Qualification must not be running under any of them.
            let registry = Registry::open(&data_home).unwrap();
            assert_eq!(registry.registered_projects().unwrap().len(), 1);
            assert_eq!(
                Store::open_registered(&project_root, id(1))
                    .unwrap()
                    .read(&id(2))
                    .unwrap()
                    .id,
                id(2)
            );
            assert_eq!(
                PreferencesService::new(&registry)
                    .get(&owner())
                    .unwrap()
                    .revision,
                revision(1)
            );
            Ok(VerifiedHost {
                adapter_id: params.adapter_id.clone(),
                adapter_version: "test-owned-qualified-provider".into(),
                protocol_major: revision(1),
                config_version: revision(1),
                external_session_id: params.external_session_id.clone(),
                endpoint: params.endpoint.clone(),
                endpoint_fingerprint: EndpointFingerprint("test/native-second-thread".into()),
                configuration: params.configuration.clone(),
                capabilities: template.capabilities.clone(),
                compatibility: Compatibility::Compatible,
                availability: Availability::Available,
                connection_state: ConnectionState::Unknown,
                cli_invocation: "ariadne".into(),
                host_location: None,
                setup_instruction: "Explicit owner resume guidance.".into(),
            })
        },
    );
    let registry_owner = OwnerContext::from_trusted_entrypoint(OwnerScope::Registry);
    let register = OwnerCommand::ProjectRegister {
        api_version: one(),
        op_id: id(80),
        params: ProjectRegisterParams {
            canonical_root: root.path().canonicalize().unwrap().to_str().unwrap().into(),
        },
    };
    let registered = core
        .execute_owner(registry_owner.clone(), register.clone())
        .unwrap();
    assert_eq!(
        core.execute_owner(registry_owner.clone(), register)
            .unwrap(),
        registered
    );
    let old_input = submit(&core, 76);
    let current = Store::open_registered(&store_dir(home.path(), 1), id(1))
        .unwrap()
        .read(&id(2))
        .unwrap();
    core.execute_owner(
        session_owner(),
        OwnerCommand::InputCancel {
            api_version: one(),
            op_id: id(77),
            params: InputCancelParams {
                input_id: old_input,
                expected_revision: current.revision,
                purpose: None,
            },
        },
    )
    .unwrap();
    let history = Store::open_registered(&store_dir(home.path(), 1), id(1))
        .unwrap()
        .read(&id(2))
        .unwrap();
    core.execute_owner(
        session_owner(),
        OwnerCommand::BindingPause {
            api_version: one(),
            op_id: id(81),
            params: BindingStateParams {
                binding_id: id(3),
                expected_generation: id(4),
            },
        },
    )
    .unwrap();
    let cmd = OwnerCommand::BindingConnect {
        api_version: one(),
        op_id: id(82),
        params: BindingConnectParams {
            project_id: id(1),
            adapter_id: "test.native".into(),
            external_session_id: "explicit-second-thread".into(),
            endpoint: EndpointRef::LocalBridge {
                name: "test-native".into(),
            },
            configuration: AdapterConfig {
                namespace: "test.native".into(),
                values: UniqueMap(Default::default()),
            },
            existing_session_id: Some(id(2)),
        },
    };
    let saved = core
        .execute_owner(registry_owner.clone(), cmd.clone())
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(core.execute_owner(registry_owner, cmd).unwrap(), saved);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let MutationReceipt::Session(receipt) = saved else {
        panic!()
    };
    let SavedReceiptData::BindingConnect {
        binding_id,
        generation,
        ..
    } = receipt.data
    else {
        panic!()
    };
    let live = Store::open_registered(&store_dir(home.path(), 1), id(1))
        .unwrap()
        .read(&id(2))
        .unwrap();
    assert_eq!(live.messages, history.messages);
    assert_eq!(live.inputs, history.inputs);
    assert_eq!(
        live.bindings.0[&binding_id]
            .issued_through_message_number
            .value(),
        2
    );
    let read_context = QueryContext::agent(AgentContext::from_trusted_entrypoint(
        route(),
        binding_id.clone(),
        generation.clone(),
        AgentReadScope::Terminal {
            issued_through_message_number: NonnegativeSafeInteger::new(2).unwrap(),
        },
    ));
    let read_request = QueryRequest::SessionRead(SessionReadRequest {
        selection: ReadView::Messages {
            topic_id: None,
            item_id: None,
        },
        cursor: None,
        limit: PageLimit::new(100).unwrap(),
        item_pages: vec![],
    });
    let QueryResult::SessionRead(SessionReadResult::Messages(page)) = core
        .query(read_context.clone(), read_request.clone())
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(page.items, history.messages);
    core.execute_owner(
        session_owner(),
        OwnerCommand::InputSubmit {
            api_version: one(),
            op_id: id(84),
            params: InputSubmitParams {
                binding_id: binding_id.clone(),
                target: InputTarget {
                    topic_id: id(5),
                    item_id: Some(ItemRef::new("1").unwrap()),
                },
                kind: InputKind::Note,
                text: "future owner context remains private until issued".into(),
                selected_option_id: None,
                expected_question_revision: None,
                supersedes_answer_id: None,
            },
        },
    )
    .unwrap();
    let QueryResult::SessionRead(SessionReadResult::Messages(page)) =
        core.query(read_context, read_request).unwrap()
    else {
        panic!()
    };
    assert_eq!(page.items, history.messages);
    assert_eq!(
        live.bindings.0[&binding_id].connection_state,
        ConnectionState::Unknown
    );
    assert_eq!(
        live.bindings.0[&binding_id].dispatch_state,
        DispatchState::Disconnected
    );
    let dispatch = ValidatedDispatchContext::from_trusted_current_lease(
        route(),
        binding_id.clone(),
        generation.clone(),
    );
    assert_eq!(
        core.claim(
            dispatch,
            ClaimRequest {
                binding_id,
                generation,
                request_id: id(83)
            }
        )
        .unwrap_err()
        .code,
        CoreErrorCode::HostUnreachable
    );
}
