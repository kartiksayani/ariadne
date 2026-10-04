use super::*;
use ariadne_domain::models::{PositiveSafeInteger, UtcMillis};

fn snapshot() -> PreferencesSnapshot {
    serde_json::from_value(serde_json::json!({
        "schema_version":1,"revision":4,
        "global":{"theme":"dark","selected_navigation":{"kind":"all_sessions"},
            "window":null,"pinned":true,"notification_watermark":"2026-10-04T12:00:00.000Z"},
        "sessions":[],"later":[],"drafts":[]
    }))
    .unwrap()
}
fn geometry(x: f64) -> WindowGeometry {
    WindowGeometry {
        x,
        y: 10.0,
        width: 1000.0,
        height: 700.0,
        monitor_id: Some("display".into()),
    }
}
fn id(n: u8) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn receipt(request: &OwnerMutationRequest) -> PreferencesPatchedReceipt {
    PreferencesPatchedReceipt {
        operation_id: request.command.operation_id().clone(),
        preferences_revision: PositiveSafeInteger::new(5).unwrap(),
    }
}

#[test]
fn geometry_uses_captured_revision_and_preserves_unrelated_global_fields() {
    let mut writer = WindowPreferenceWrite::default();
    let original = snapshot();
    assert!(writer
        .save(
            geometry(20.0),
            || id(1),
            || Ok(original.clone()),
            |request| {
                let OwnerCommand::PreferencesPatch { params, .. } = &request.command else {
                    panic!("patch")
                };
                assert_eq!(params.expected_preferences_revision.value(), 4);
                let [PreferencesPatchEntry::SetGlobal { preferences }] = params.entries.as_slice()
                else {
                    panic!("global only")
                };
                assert_eq!(preferences.theme, original.global.theme);
                assert_eq!(
                    preferences.selected_navigation,
                    original.global.selected_navigation
                );
                assert_eq!(preferences.pinned, original.global.pinned);
                assert_eq!(
                    preferences.notification_watermark,
                    Some(UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap())
                );
                assert_eq!(preferences.window, Some(geometry(20.0)));
                assert!(request.session.is_none());
                Ok(receipt(request))
            }
        )
        .unwrap());
    assert!(writer.pending.is_none());
}

#[test]
fn uncertainty_reconciles_exact_operation_without_a_fresh_revision_or_geometry() {
    let mut writer = WindowPreferenceWrite::default();
    let mut attempted = None;
    let error = writer
        .save(
            geometry(20.0),
            || id(1),
            || Ok(snapshot()),
            |request| {
                attempted = Some(request.clone());
                Err(CoreError::new(
                    CoreErrorCode::CommitUncertain,
                    "Publication is uncertain.",
                    "Reconcile the same operation.",
                ))
            },
        )
        .unwrap_err();
    assert_eq!(error.code, CoreErrorCode::CommitUncertain);
    assert_eq!(
        writer.ready_to_exit().unwrap_err().code,
        CoreErrorCode::CommitUncertain
    );
    assert!(!writer
        .save(
            geometry(90.0),
            || panic!("never allocate on replay"),
            || panic!("never reread on replay"),
            |request| {
                assert_eq!(Some(request), attempted.as_ref());
                Ok(receipt(request))
            }
        )
        .unwrap());
    assert!(writer.pending.is_none());
    writer.ready_to_exit().unwrap();
}

#[test]
fn definite_revision_conflict_is_not_automatically_overwritten() {
    let mut writer = WindowPreferenceWrite::default();
    let error = writer
        .save(
            geometry(20.0),
            || id(1),
            || Ok(snapshot()),
            |_| {
                let mut error = CoreError::new(
                    CoreErrorCode::RevisionConflict,
                    "Preferences changed.",
                    "Reload before a new action.",
                );
                error.current_revision = Some(PositiveSafeInteger::new(5).unwrap());
                Err(error)
            },
        )
        .unwrap_err();
    assert_eq!(error.code, CoreErrorCode::RevisionConflict);
    assert!(writer.pending.is_none());
}

#[test]
fn malformed_success_retains_original_operation_and_unchanged_geometry_does_not_write() {
    let mut writer = WindowPreferenceWrite::default();
    assert_eq!(
        writer
            .save(
                geometry(20.0),
                || id(1),
                || Ok(snapshot()),
                |request| {
                    let mut value = receipt(request);
                    value.operation_id = id(2);
                    Ok(value)
                }
            )
            .unwrap_err()
            .code,
        CoreErrorCode::ProtocolConflict
    );
    assert!(writer.pending.is_some());
    let mut writer = WindowPreferenceWrite::default();
    let mut original = snapshot();
    original.global.window = Some(geometry(20.0));
    assert!(writer
        .save(
            geometry(20.0),
            || panic!("no operation"),
            || Ok(original),
            |_| panic!("no write")
        )
        .unwrap());
}

#[test]
fn generic_errors_never_replace_a_pending_geometry_operation() {
    let mut writer = WindowPreferenceWrite::default();
    let mut original = None;
    writer
        .save(
            geometry(20.0),
            || id(1),
            || Ok(snapshot()),
            |request| {
                original = Some(request.clone());
                Err(CoreError::new(
                    CoreErrorCode::CommitUncertain,
                    "Lost receipt.",
                    "Confirm it.",
                ))
            },
        )
        .unwrap_err();
    for code in [
        CoreErrorCode::IoError,
        CoreErrorCode::HostUnreachable,
        CoreErrorCode::StoreBusy,
        CoreErrorCode::RevisionConflict,
        CoreErrorCode::OperationReused,
        CoreErrorCode::InvalidArgument,
    ] {
        writer
            .save(
                geometry(99.0),
                || panic!("never allocate"),
                || panic!("never reread"),
                |request| {
                    assert_eq!(Some(request), original.as_ref());
                    Err(CoreError::new(
                        code,
                        "Generic failure.",
                        "Confirm the same operation.",
                    ))
                },
            )
            .unwrap_err();
        assert!(writer.ready_to_exit().is_err());
    }
    writer
        .confirm(|request| {
            assert_eq!(Some(request), original.as_ref());
            Ok(receipt(request))
        })
        .unwrap();
    writer.ready_to_exit().unwrap();
}

#[test]
fn queued_geometry_before_quit_finishes_its_first_read_and_save_after_the_fence() {
    use crate::{
        composition::{NativeConfiguration, NativeRuntime},
        native::window::NativeWindow,
    };
    use std::{
        sync::{mpsc, Arc, Mutex},
        time::Duration,
    };
    let directory = tempfile::tempdir().unwrap();
    let runtime = NativeRuntime::start(
        NativeConfiguration {
            home: directory.path().join("data"),
            claude: None,
            codex: None,
            discovery_endpoints: vec![],
        },
        Arc::new(|_| {}),
        Arc::new(|_| true),
    )
    .unwrap();
    let service = runtime.bridge().desktop_service();
    let read = service.clone();
    let write = service.clone();
    let (started, began) = mpsc::channel();
    let (released, release) = mpsc::channel();
    let release = Mutex::new(release);
    let delayed = service.with_native_preferences(
        move || {
            started.send(()).unwrap();
            release.lock().unwrap().recv().unwrap();
            read.native_preferences()
        },
        move |request| write.native_preferences_write(request),
    );
    let window = NativeWindow::default();
    assert!(window.queue_geometry(geometry(20.0), delayed.clone()));
    began.recv_timeout(Duration::from_secs(1)).unwrap();
    window.begin_stop();
    runtime.begin_shutdown().unwrap();
    assert!(!window.queue_geometry(geometry(99.0), delayed.clone()));
    released.send(()).unwrap();
    window.join_writer(&delayed).unwrap();
    let core = runtime.bridge().core().clone();
    let QueryResult::PreferencesGet(saved) = core
        .query(
            QueryContext::owner(OwnerContext::from_trusted_entrypoint(
                OwnerScope::Preferences,
            )),
            QueryRequest::PreferencesGet {},
        )
        .unwrap()
    else {
        panic!("preferences")
    };
    assert_eq!(saved.global.window, Some(geometry(20.0)));
    assert_eq!(saved.revision.value(), 2);
    assert!(runtime
        .bridge()
        .query(
            QueryContext::owner(OwnerContext::from_trusted_entrypoint(
                OwnerScope::Preferences
            )),
            QueryRequest::PreferencesGet {},
        )
        .is_err());
    runtime.shutdown().unwrap();
    assert!(delayed.native_preferences().is_err());
}

#[test]
fn actual_native_preferences_keep_session_views_later_and_unsent_drafts() {
    use ariadne_core::native::NativeCoreService;
    use ariadne_store::registry::Registry;
    let root = tempfile::tempdir().unwrap();
    let core = NativeCoreService::new(
        Registry::open(root.path()).unwrap(),
        || id(99),
        || UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap(),
        |_| {
            Err(CoreError::new(
                CoreErrorCode::Unsupported,
                "No test provider is composed.",
                "This test only exercises preferences.",
            ))
        },
    );
    let owner = || OwnerContext::from_trusted_entrypoint(OwnerScope::Preferences);
    let inventory: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../../../fixtures/contracts/core/inventory.json"
    ))
    .unwrap();
    let mut seed: OwnerCommand = serde_json::from_value(
        inventory["owner_commands"]
            .as_array()
            .unwrap()
            .iter()
            .find(|command| command["command"] == "preferences_patch")
            .unwrap()
            .clone(),
    )
    .unwrap();
    let OwnerCommand::PreferencesPatch { params, .. } = &mut seed else {
        panic!("preferences")
    };
    params
        .entries
        .retain(|entry| !matches!(entry, PreferencesPatchEntry::DeleteDraft { .. }));
    core.execute_owner(owner(), seed).unwrap();
    let read = || match core
        .query(
            QueryContext::owner(owner()),
            QueryRequest::PreferencesGet {},
        )
        .unwrap()
    {
        QueryResult::PreferencesGet(snapshot) => Ok(snapshot),
        _ => panic!("preferences"),
    };
    let before = read().unwrap();
    assert!(!before.sessions.is_empty() && !before.later.is_empty() && !before.drafts.is_empty());
    let mut writer = WindowPreferenceWrite::default();
    assert!(writer
        .save(
            geometry(37.0),
            || id(55),
            read,
            |request| {
                match core.execute_owner(owner(), request.command.clone())? {
                    MutationReceipt::PreferencesPatched(receipt) => Ok(receipt),
                    _ => panic!("preferences receipt"),
                }
            }
        )
        .unwrap());
    let after = read().unwrap();
    assert_eq!(after.revision.value(), before.revision.value() + 1);
    assert_eq!(after.sessions, before.sessions);
    assert_eq!(after.later, before.later);
    assert_eq!(after.drafts, before.drafts);
    let mut global = before.global;
    global.window = Some(geometry(37.0));
    assert_eq!(after.global, global);
}
