//! Exercise the production pure native modules without building or launching Tauri.
#[path = "../../../apps/desktop/src-tauri/src/native/tray/capture.rs"]
mod capture;
#[path = "../../../apps/desktop/src-tauri/src/native/tray/coalescing.rs"]
mod coalescing;
#[path = "../../../apps/desktop/src-tauri/src/native/notifications/policy.rs"]
mod policy;
#[path = "../../../apps/desktop/src-tauri/src/native/tray/projection.rs"]
mod projection;
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
    }
}

#[test]
fn old_preferences_round_trip_without_changing_normalized_command_bytes() {
    let old = json!({"theme":"system","selected_navigation":{"kind":"projects"},
        "window":null,"pinned":false,"notification_watermark":null});
    let decoded: GlobalPreferences = serde_json::from_value(old.clone()).unwrap();
    assert!(!decoded.notification_preview);
    assert!(decoded.notification_ledger.is_empty());
    assert_eq!(serde_json::to_value(decoded).unwrap(), old);
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
    let session: Session = fixture("domain/demo/session.json");
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
    assert_eq!(captured.rows[0].session_label, session.title);
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
