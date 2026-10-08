//! Exercise the production pure native modules without building or launching Tauri.
#[path = "../../../apps/desktop/src-tauri/src/native/notifications/burst.rs"]
mod burst;
#[path = "../../../apps/desktop/src-tauri/src/native/tray/capture.rs"]
mod capture;
#[path = "../../../apps/desktop/src-tauri/src/native/tray/coalescing.rs"]
mod coalescing;
#[path = "../../../apps/desktop/src-tauri/src/native/tray/diagnostics.rs"]
mod diagnostics;
#[path = "../../../apps/desktop/src-tauri/src/native/notifications/policy.rs"]
mod policy;
#[path = "../../../apps/desktop/src-tauri/src/native/tray/projection.rs"]
mod projection;
#[path = "../../../apps/desktop/src-tauri/src/native/notifications/writer.rs"]
mod writer;
use ariadne_core::*;
use ariadne_domain::models::*;
use capture::*;
use serde_json::json;

fn fixture<T: serde::de::DeserializeOwned>(path: &str) -> T {
    serde_json::from_slice(
        &std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../fixtures")
                .join(path),
        )
        .unwrap(),
    )
    .unwrap()
}
fn global() -> GlobalPreferences {
    serde_json::from_value(
        json!({"theme":"system","selected_navigation":{"kind":"projects"},
        "window":null,"pinned":false,"notification_watermark":null}),
    )
    .unwrap()
}
fn at(second: u64) -> UtcMillis {
    UtcMillis::new(format!("2026-10-04T12:00:{second:02}.000Z")).unwrap()
}
fn row(revision: u64, second: u64) -> WaitingRow {
    WaitingRow {
        episode: NotificationEpisode {
            session: SessionRef {
                project_id: UuidV4::new("00000000-0000-4000-8000-000000000001").unwrap(),
                session_id: UuidV4::new("00000000-0000-4000-8000-000000000002").unwrap(),
            },
            item_id: ItemRef::new("1").unwrap(),
            question_revision: PositiveSafeInteger::new(revision).unwrap(),
        },
        waiting_since: at(second),
        project_label: "Project".into(),
        session_label: "Session".into(),
        question: "Private question content".into(),
    }
}
fn queue(rows: Vec<WaitingRow>, complete: bool) -> WaitingCapture {
    let page: Page<ProjectSummary> = fixture("domain/projections/projects.json");
    let mut counts = page.items[0].counts.clone();
    counts.waiting_unanswered = NonnegativeSafeInteger::new(rows.len() as u64).unwrap();
    counts.completeness = if complete {
        Completeness::Complete
    } else {
        Completeness::Partial
    };
    WaitingCapture {
        counts,
        rows,
        diagnostics: vec![],
        labels: Default::default(),
    }
}

fn preferences(global: GlobalPreferences, revision: u64) -> PreferencesSnapshot {
    PreferencesSnapshot {
        schema_version: SchemaVersion::new(1).unwrap(),
        revision: PositiveSafeInteger::new(revision).unwrap(),
        global,
        sessions: vec![],
        later: vec![],
        drafts: vec![],
    }
}
fn operation_id() -> UuidV4 {
    UuidV4::new("00000000-0000-4000-8000-000000000003").unwrap()
}
fn receipt(request: &OwnerMutationRequest) -> PreferencesPatchedReceipt {
    PreferencesPatchedReceipt {
        operation_id: request.command.operation_id().clone(),
        preferences_revision: PositiveSafeInteger::new(2).unwrap(),
    }
}

fn native_preferences() -> (tempfile::TempDir, native::NativeCoreService) {
    let home = tempfile::tempdir().unwrap();
    let core = native::NativeCoreService::new(
        ariadne_store::registry::Registry::open(home.path()).unwrap(),
        || panic!("preferences allocate their operation ID at the writer"),
        || at(1),
        |_| panic!("preferences never qualify a host"),
    );
    (home, core)
}
fn preference_owner() -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Preferences)
}
fn native_receipt(
    core: &native::NativeCoreService,
    request: &OwnerMutationRequest,
) -> Result<PreferencesPatchedReceipt, CoreError> {
    let result = core.execute_owner(preference_owner(), request.command.clone())?;
    validate_owner_receipt(request, &result)?;
    let MutationReceipt::PreferencesPatched(receipt) = result else {
        panic!("preferences receipt");
    };
    Ok(receipt)
}

#[test]
fn saved_uncertain_preferences_survive_transport_store_and_unknown_errors_then_replay_exactly() {
    let (_home, core) = native_preferences();
    let service = native::PreferencesService::new(core.registry());
    let snapshot = service.get(&preference_owner()).unwrap();
    let baseline = policy::evaluate(&snapshot.global, &queue(vec![row(1, 1)], true), at(1));
    let baseline_request = OwnerMutationRequest {
        session: None,
        command: OwnerCommand::PreferencesPatch {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: UuidV4::new("00000000-0000-4000-8000-000000000004").unwrap(),
            params: PreferencesPatch {
                expected_preferences_revision: snapshot.revision,
                entries: vec![PreferencesPatchEntry::SetGlobal {
                    preferences: baseline.preferences,
                }],
            },
        },
    };
    native_receipt(&core, &baseline_request).unwrap();
    let captured = queue(vec![row(2, 2)], true);
    let mut writer = writer::PreferenceWriter::default();
    writer
        .observe(
            service.get(&preference_owner()).unwrap(),
            &captured,
            at(3),
            operation_id,
        )
        .unwrap();
    let mut frozen = None;
    let error = writer
        .confirm(|request| {
            frozen = Some(request.clone());
            native_receipt(&core, request)?;
            Err(CoreError::new(
                CoreErrorCode::CommitUncertain,
                "Saved receipt was lost.",
                "Replay the exact operation.",
            ))
        })
        .err()
        .unwrap();
    assert_eq!(error.code, CoreErrorCode::CommitUncertain);
    let saved = service.get(&preference_owner()).unwrap();
    assert_eq!(saved.revision.value(), 3);
    for code in [
        CoreErrorCode::HostUnreachable,
        CoreErrorCode::IoError,
        CoreErrorCode::StoreBusy,
        CoreErrorCode::Unsupported,
        CoreErrorCode::OperationReused,
        CoreErrorCode::CorruptSession,
        CoreErrorCode::FutureSchema,
        CoreErrorCode::PermissionDenied,
        CoreErrorCode::CapacityExceeded,
        CoreErrorCode::InvalidArgument,
        CoreErrorCode::ProtocolConflict,
        CoreErrorCode::RevisionConflict,
    ] {
        let error = writer
            .confirm(|request| {
                assert_eq!(Some(request), frozen.as_ref());
                Err(CoreError::new(
                    code,
                    "Reconciliation did not establish an outcome.",
                    "Keep the exact operation.",
                ))
            })
            .err()
            .unwrap();
        assert_eq!(error.code, code);
        assert!(
            writer.pending(),
            "{code:?} must not discard an uncertain saved operation"
        );
        assert!(writer
            .observe(saved.clone(), &captured, at(4), || panic!(
                "must not rebuild the pending operation"
            ))
            .unwrap()
            .is_none());
    }
    let plan = writer
        .confirm(|request| {
            assert_eq!(Some(request), frozen.as_ref());
            native_receipt(&core, request)
        })
        .unwrap()
        .unwrap();
    assert!(!writer.pending());
    assert_eq!(plan.arrivals[0].identifier(), row(2, 2).identifier());
    assert_eq!(service.get(&preference_owner()).unwrap(), saved);
}

#[test]
fn transactional_preferences_revision_rejection_allows_fresh_snapshot_rebuild() {
    let (_home, core) = native_preferences();
    let service = native::PreferencesService::new(core.registry());
    let snapshot = service.get(&preference_owner()).unwrap();
    let mut writer = writer::PreferenceWriter::default();
    let captured = queue(vec![row(1, 1)], true);
    writer
        .observe(snapshot.clone(), &captured, at(1), operation_id)
        .unwrap();
    let mut updated = snapshot.global.clone();
    updated.pinned = true;
    let competing = OwnerMutationRequest {
        session: None,
        command: OwnerCommand::PreferencesPatch {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: UuidV4::new("00000000-0000-4000-8000-000000000004").unwrap(),
            params: PreferencesPatch {
                expected_preferences_revision: snapshot.revision,
                entries: vec![PreferencesPatchEntry::SetGlobal {
                    preferences: updated,
                }],
            },
        },
    };
    native_receipt(&core, &competing).unwrap();
    let error = writer
        .confirm(|request| native_receipt(&core, request))
        .err()
        .unwrap();
    assert_eq!(error.code, CoreErrorCode::RevisionConflict);
    assert_eq!(error.current_revision.unwrap().value(), 2);
    assert!(!writer.pending());
    let fresh_id = UuidV4::new("00000000-0000-4000-8000-000000000005").unwrap();
    writer
        .observe(
            service.get(&preference_owner()).unwrap(),
            &captured,
            at(2),
            || fresh_id.clone(),
        )
        .unwrap();
    let plan = writer
        .confirm(|request| {
            assert_eq!(request.command.operation_id(), &fresh_id);
            native_receipt(&core, request)
        })
        .unwrap()
        .unwrap();
    assert!(plan.preferences.pinned);
    assert!(plan.arrivals.is_empty());
    assert_eq!(
        service.get(&preference_owner()).unwrap().revision.value(),
        3
    );
}

#[test]
fn bursts_dedupe_with_a_fixed_deadline_and_group_only_more_than_three() {
    let now = std::time::Instant::now();
    let mut pending = burst::Burst::default();
    pending.push(vec![row(1, 1), row(2, 2)], now);
    pending.push(
        vec![row(2, 2), row(3, 3)],
        now + std::time::Duration::from_millis(499),
    );
    assert_eq!(pending.deadline(), Some(now + burst::BURST_WINDOW));
    assert!(pending
        .take_due(now + std::time::Duration::from_millis(499))
        .is_none());
    let rows = pending.take_due(now + burst::BURST_WINDOW).unwrap();
    assert_eq!(rows.len(), 3);
    let notices = burst::announcements(&rows, false);
    assert_eq!(notices.len(), 3);
    assert_eq!(notices[0].identifier, row(1, 1).identifier());
    assert_eq!(notices[0].title, "Ariadne");
    assert_eq!(notices[0].route, row(1, 1).route());
    assert!(!notices[0].body.contains("Private"));
    assert_eq!(
        burst::announcements(&rows, true)[0].body,
        row(1, 1).question
    );
    pending.push(
        (1..=4).map(|revision| row(revision, revision)).collect(),
        now,
    );
    let rows = pending.take_due(now + burst::BURST_WINDOW).unwrap();
    let notices = burst::announcements(&rows, true);
    assert_eq!(notices.len(), 1);
    assert_eq!(
        notices[0].identifier,
        format!("{}:burst", row(1, 1).identifier())
    );
    assert_eq!(notices[0].body, "4 questions are waiting for your answer.");
    assert!(pending.take_due(now + burst::BURST_WINDOW).is_none());
}

#[test]
fn fresh_preferences_default_to_generic_notification_text() {
    let (_home, core) = native_preferences();
    let snapshot = native::PreferencesService::new(core.registry())
        .get(&preference_owner())
        .unwrap();
    assert!(!snapshot.global.notification_preview);
    let notices = burst::announcements(&[row(1, 1)], snapshot.global.notification_preview);
    assert_eq!(notices[0].body, "A question is waiting for your answer.");
    assert!(!notices[0].body.contains("Private"));
}

#[test]
fn complete_capture_removes_resolved_pending_bursts_but_partial_does_not_infer_absence() {
    let now = std::time::Instant::now();
    let mut pending = burst::Burst::default();
    pending.push(vec![row(1, 1), row(2, 2)], now);
    pending.retain(&[], false);
    pending.retain(&[row(2, 2)], true);
    assert_eq!(
        pending.take_due(now + burst::BURST_WINDOW).unwrap().len(),
        1
    );
    pending.push(vec![row(3, 3)], now);
    pending.retain(&[], true);
    assert!(pending
        .take_due(now + burst::BURST_WINDOW)
        .unwrap()
        .is_empty());
}

#[test]
fn preference_writer_freezes_uncertain_request_before_releasing_arrivals() {
    let baseline = policy::evaluate(&global(), &queue(vec![row(1, 1)], true), at(1));
    let captured = queue(vec![row(2, 2)], true);
    let mut writer = writer::PreferenceWriter::default();
    assert!(writer
        .observe(
            preferences(baseline.preferences, 1),
            &captured,
            at(3),
            operation_id
        )
        .unwrap()
        .is_none());
    let mut original = None;
    let error = writer
        .confirm(|request| {
            original = Some(request.clone());
            Err(CoreError::new(
                CoreErrorCode::CommitUncertain,
                "Receipt was lost.",
                "Reconcile the same operation.",
            ))
        })
        .err()
        .unwrap();
    assert_eq!(error.code, CoreErrorCode::CommitUncertain);
    assert!(writer.pending());
    assert!(writer
        .observe(preferences(global(), 99), &captured, at(4), || panic!(
            "must not allocate another operation"
        ))
        .unwrap()
        .is_none());
    let plan = writer
        .confirm(|request| {
            assert_eq!(Some(request), original.as_ref());
            Ok(receipt(request))
        })
        .unwrap()
        .unwrap();
    assert_eq!(plan.arrivals[0].identifier(), row(2, 2).identifier());
    assert!(!writer.pending());
    assert!(writer
        .confirm(|_| panic!("nothing pending"))
        .unwrap()
        .is_none());
}

#[test]
fn preference_writer_rejects_mismatched_receipt_and_refreshes_after_definite_conflict() {
    let captured = queue(vec![row(1, 1)], true);
    let mut writer = writer::PreferenceWriter::default();
    writer
        .observe(preferences(global(), 1), &captured, at(1), operation_id)
        .unwrap();
    let error = writer
        .confirm(|request| {
            let mut response = receipt(request);
            response.operation_id = UuidV4::new("00000000-0000-4000-8000-000000000004").unwrap();
            Ok(response)
        })
        .err()
        .unwrap();
    assert_eq!(error.code, CoreErrorCode::ProtocolConflict);
    assert!(writer.pending());
    writer
        .pin(preferences(global(), 2), || {
            panic!("pending operation must be reconciled first")
        })
        .unwrap();
    let error = writer
        .confirm(|_| {
            let mut error = CoreError::new(
                CoreErrorCode::RevisionConflict,
                "Preferences changed.",
                "Read a fresh snapshot.",
            );
            error.current_revision = Some(PositiveSafeInteger::new(2).unwrap());
            Err(error)
        })
        .err()
        .unwrap();
    assert_eq!(error.code, CoreErrorCode::RevisionConflict);
    assert!(!writer.pending());
    writer.pin(preferences(global(), 2), operation_id).unwrap();
    let plan = writer
        .confirm(|request| Ok(receipt(request)))
        .unwrap()
        .unwrap();
    assert!(plan.preferences.pinned);
    assert!(plan.arrivals.is_empty());
    let no_change = writer
        .observe(
            preferences(plan.preferences.clone(), 3),
            &queue(vec![], false),
            at(4),
            || panic!("partial baseline cannot write"),
        )
        .unwrap()
        .unwrap();
    assert!(no_change.diagnostic.is_some());
    assert!(!writer.pending());
}

#[test]
fn old_preferences_round_trip_without_changing_normalized_command_bytes() {
    let old = json!({"theme":"system","selected_navigation":{"kind":"projects"},
        "window":null,"pinned":false,"notification_watermark":null});
    let decoded: GlobalPreferences = serde_json::from_value(old.clone()).unwrap();
    assert!(!decoded.notification_preview);
    assert!(decoded.notification_ledger.is_empty());
    assert_eq!(serde_json::to_value(decoded).unwrap(), old);

    let mut disabled = old.clone();
    disabled["notification_preview"] = json!(false);
    let decoded: GlobalPreferences = serde_json::from_value(disabled).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), old);

    let mut enabled = old;
    enabled["notification_preview"] = json!(true);
    let decoded: GlobalPreferences = serde_json::from_value(enabled.clone()).unwrap();
    assert!(decoded.notification_preview);
    assert_eq!(serde_json::to_value(decoded).unwrap(), enabled);
}

#[test]
fn ledger_bound_and_duplicates_are_rejected_before_preferences_write() {
    let check = |preferences| {
        OwnerCommand::PreferencesPatch {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: UuidV4::new("00000000-0000-4000-8000-000000000003").unwrap(),
            params: PreferencesPatch {
                expected_preferences_revision: PositiveSafeInteger::new(1).unwrap(),
                entries: vec![PreferencesPatchEntry::SetGlobal { preferences }],
            },
        }
        .validate_wire()
    };
    let mut preferences = global();
    preferences.notification_ledger = vec![row(1, 1).episode; 2];
    assert_eq!(
        check(preferences.clone()).unwrap_err().code,
        CoreErrorCode::InvalidArgument
    );
    preferences.notification_ledger = (1..=257).map(|revision| row(revision, 1).episode).collect();
    assert_eq!(
        check(preferences).unwrap_err().code,
        CoreErrorCode::CapacityExceeded
    );
}

#[test]
fn baseline_waits_for_complete_roots_without_announcing_the_backlog() {
    let plan = policy::evaluate(&global(), &queue(vec![row(1, 1)], false), at(5));
    assert!(plan.preferences.notification_watermark.is_none());
    assert!(plan.arrivals.is_empty());
    assert!(plan.diagnostic.is_some());
    let plan = policy::evaluate(&global(), &queue(vec![row(1, 1)], true), at(5));
    assert_eq!(plan.preferences.notification_watermark, Some(at(1)));
    assert_eq!(
        plan.preferences.notification_ledger,
        vec![row(1, 1).episode]
    );
    assert!(plan.arrivals.is_empty());
}

#[test]
fn boundary_episodes_dedupe_and_new_question_revision_notifies_once() {
    let baseline = policy::evaluate(&global(), &queue(vec![row(1, 1)], true), at(1));
    let newer = queue(vec![row(1, 1), row(2, 1), row(3, 2)], true);
    let plan = policy::evaluate(&baseline.preferences, &newer, at(3));
    assert_eq!(
        plan.arrivals
            .iter()
            .map(WaitingRow::identifier)
            .collect::<Vec<_>>(),
        vec![row(2, 1).identifier(), row(3, 2).identifier()]
    );
    assert_eq!(
        plan.preferences.notification_ledger,
        vec![row(3, 2).episode]
    );
    assert!(policy::evaluate(&plan.preferences, &newer, at(4))
        .arrivals
        .is_empty());
    assert_eq!(row(2, 1).route().item_id, Some(ItemRef::new("1").unwrap()));
}

#[test]
fn partial_capacity_pauses_without_eviction_then_complete_capture_compacts() {
    let baseline = policy::evaluate(&global(), &queue(vec![row(1, 1)], true), at(1));
    let rows: Vec<_> = (2..=257).map(|revision| row(revision, 2)).collect();
    let plan = policy::evaluate(&baseline.preferences, &queue(rows.clone(), false), at(2));
    assert!(plan.diagnostic.is_some());
    assert!(plan.arrivals.is_empty());
    assert_eq!(plan.preferences, baseline.preferences);
    let plan = policy::evaluate(&baseline.preferences, &queue(rows.clone(), true), at(2));
    assert_eq!(plan.arrivals.len(), 256);
    assert_eq!(plan.preferences.notification_ledger.len(), 256);
    assert!(
        policy::evaluate(&plan.preferences, &queue(rows, false), at(3))
            .arrivals
            .is_empty()
    );
}

#[test]
fn capture_uses_global_counts_labels_and_registered_snapshots() {
    let projects: Page<ProjectSummary> = fixture("domain/projections/projects.json");
    let sessions: Page<SessionSummary> = fixture("domain/projections/sessions.json");
    let mut session: Session = fixture("domain/demo/session.json");
    // Keep this capture fixture unanswered, consistent with its global counts.
    session
        .inputs
        .0
        .get_mut(&UuidV4::new("00000000-0000-4000-8000-000000000071").unwrap())
        .unwrap()
        .state = InputState::Skipped;
    let counts = projects.items[0].counts.clone();
    let read = |request: OwnerQueryRequest| {
        Ok(match request.request {
            QueryRequest::ProjectList(_) => QueryResult::ProjectList(ProjectListResult {
                projects: projects.clone(),
                counts: counts.clone(),
            }),
            QueryRequest::SessionList(_) => QueryResult::SessionList(SessionListResult {
                sessions: sessions.clone(),
                active_total: NonnegativeSafeInteger::new(1).unwrap(),
                closed_total: NonnegativeSafeInteger::new(0).unwrap(),
                counts: counts.clone(),
            }),
            QueryRequest::SessionGet {} => QueryResult::SessionGet(SessionSnapshot {
                session: session.clone(),
                freshness: Freshness::Fresh,
            }),
            _ => panic!("unexpected query"),
        })
    };
    let captured = capture(read).unwrap();
    assert_eq!(
        captured.rows.len() as u64,
        counts.waiting_unanswered.value()
    );
    assert_eq!(captured.rows[0].project_label, "Ariadne canonical demo");
    // The session bar's label (agent · host location), not the raw title,
    // which is the agent's external session ID.
    assert_eq!(
        captured.rows[0].session_label,
        "demo.local · iTerm window 1"
    );
    assert!(!captured.rows[0].question.is_empty());
    assert!(captured.diagnostics.is_empty());
    // An independently changed snapshot is rejected without substituting its
    // visible rows for the previously authoritative global count.
    let changed = |request: OwnerQueryRequest| {
        let mut result = read(request)?;
        if let QueryResult::SessionGet(snapshot) = &mut result {
            snapshot.session.revision =
                PositiveSafeInteger::new(snapshot.session.revision.value() + 1).unwrap();
        }
        Ok(result)
    };
    assert_eq!(
        capture(changed).unwrap_err().code,
        CoreErrorCode::RevisionConflict
    );
    let lists = std::cell::Cell::new(0);
    let changed_after_snapshot = |request: OwnerQueryRequest| {
        let mut result = read(request)?;
        if let QueryResult::SessionList(list) = &mut result {
            lists.set(lists.get() + 1);
            if lists.get() == 2 {
                list.sessions.items[0].revision =
                    PositiveSafeInteger::new(list.sessions.items[0].revision.value() + 1).unwrap();
            }
        }
        Ok(result)
    };
    assert_eq!(
        capture(changed_after_snapshot).unwrap_err().code,
        CoreErrorCode::RevisionConflict
    );
}

#[test]
fn capture_skips_empty_sessions_but_keeps_diagnostics_and_rechecks_their_revision() {
    for partial in [false, true] {
        let mut projects: Page<ProjectSummary> = fixture("domain/projections/projects.json");
        let mut sessions: Page<SessionSummary> = fixture("domain/projections/sessions.json");
        let mut counts = projects.items[0].counts.clone();
        counts.waiting_unanswered = NonnegativeSafeInteger::new(0).unwrap();
        if partial {
            counts.completeness = Completeness::Partial;
        }
        projects.items[0].counts = counts.clone();
        sessions.items[0].counts = counts.clone();
        sessions.items[0]
            .active_binding
            .as_mut()
            .unwrap()
            .owner_paused = true;
        for changed in [false, true] {
            let lists = std::cell::Cell::new(0);
            let result = capture(|request| {
                Ok(match request.request {
                    QueryRequest::ProjectList(_) => QueryResult::ProjectList(ProjectListResult {
                        projects: projects.clone(),
                        counts: counts.clone(),
                    }),
                    QueryRequest::SessionList(_) => {
                        lists.set(lists.get() + 1);
                        let mut sessions = sessions.clone();
                        if changed && lists.get() == 2 {
                            sessions.items[0].revision =
                                PositiveSafeInteger::new(sessions.items[0].revision.value() + 1)
                                    .unwrap();
                        }
                        QueryResult::SessionList(SessionListResult {
                            sessions,
                            active_total: NonnegativeSafeInteger::new(1).unwrap(),
                            closed_total: NonnegativeSafeInteger::new(0).unwrap(),
                            counts: counts.clone(),
                        })
                    }
                    QueryRequest::SessionGet {} => panic!("zero Waiting rows need no snapshot"),
                    _ => panic!("unexpected query"),
                })
            });
            assert_eq!(lists.get(), 2);
            if changed {
                assert_eq!(result.unwrap_err().code, CoreErrorCode::RevisionConflict);
            } else {
                let captured = result.unwrap();
                assert!(captured.rows.is_empty());
                assert_eq!(captured.counts, counts);
                // Named by the session label, not the binding's IDs.
                assert!(captured
                    .diagnostics
                    .iter()
                    .any(|row| row == "demo.local · iTerm window 1: paused"));
                assert_eq!(
                    captured.labels.get("00000000-0000-4000-8000-000000000020"),
                    Some(&"demo.local · iTerm window 1".to_owned())
                );
                assert_eq!(captured.diagnostics.len(), if partial { 2 } else { 1 });
            }
        }
    }
}

#[test]
fn tray_keeps_authoritative_count_oldest_ten_and_separate_diagnostics() {
    let mut capture = queue(
        (1..=11).map(|revision| row(revision, revision)).collect(),
        false,
    );
    capture.counts.waiting_unanswered = NonnegativeSafeInteger::new(15).unwrap();
    capture
        .diagnostics
        .push("Registered root unavailable".into());
    let tray = projection::TrayProjection::from_capture(&capture, &["Runtime reconnecting".into()]);
    assert_eq!(tray.title, "15*");
    assert_eq!(tray.oldest.len(), 10);
    assert_eq!(tray.oldest[9].episode.question_revision.value(), 10);
    assert_eq!(
        tray.diagnostics,
        vec!["Registered root unavailable", "Runtime reconnecting"]
    );
    assert_eq!(
        projection::TrayProjection::from_capture(&queue(vec![], true), &[]).title,
        ""
    );
    assert_eq!(
        projection::TrayProjection::from_capture(&queue(vec![], false), &[]).title,
        "*"
    );
}
