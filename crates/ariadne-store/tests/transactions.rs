mod support;
use ariadne_domain::models::*;
use ariadne_store::session::{Store, StoreError, TransactionError};
use std::fs;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
use std::process::{Child, Command};
use std::sync::{mpsc, Arc, Barrier};
use std::time::{Duration, Instant};
use support::*;

#[test]
fn create_read_and_previous_snapshot_are_durable_private_and_deterministic() {
    let project = ProjectDir::new();
    let store = project.store();
    let original = fs::read(project.live()).unwrap();
    let inode = fs::metadata(project.lock()).unwrap().ino();
    assert!(!project.backup().exists());
    assert_eq!(store.read(&id(2)).unwrap(), seed());
    assert!(matches!(
        store.create(&seed()),
        Err(StoreError::AlreadyExists)
    ));
    let receipt = transact(&store, "1", 100, Some(1)).unwrap();
    assert_eq!(receipt.revision.value(), 2);
    assert_eq!(fs::read(project.backup()).unwrap(), original);
    let saved = store.read(&id(2)).unwrap();
    assert_eq!(saved.messages.len(), 2);
    assert_eq!(saved.items.0[&item("1")].revision.value(), 2);
    assert_eq!(fs::metadata(project.lock()).unwrap().ino(), inode);
    for path in [project.live(), project.backup(), project.lock()] {
        assert_eq!(fs::metadata(path).unwrap().mode() & 0o777, 0o600);
    }
    for directory in ["", "sessions", "locks", "backups"] {
        assert_eq!(
            fs::metadata(project.root.path().join(directory))
                .unwrap()
                .mode()
                & 0o777,
            0o700
        );
        assert!(fs::read_dir(project.root.path().join(directory))
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".tmp-")));
    }
    let second = ProjectDir::new();
    transact(&second.store(), "1", 100, Some(1)).unwrap();
    assert_eq!(
        fs::read(project.live()).unwrap(),
        fs::read(second.live()).unwrap()
    );
}

#[test]
fn exact_replay_precedes_current_revision_checks_and_changed_command_is_rejected() {
    let project = ProjectDir::new();
    let store = project.store();
    let saved = transact(&store, "1", 100, Some(1)).unwrap();
    transact(&store, "1", 101, Some(2)).unwrap();
    let live = fs::read(project.live()).unwrap();
    let backup = fs::read(project.backup()).unwrap();
    assert_eq!(transact(&store, "1", 100, Some(1)).unwrap(), saved);
    let replay: Result<_, TransactionError<()>> = store.transact(
        &id(2),
        &actor(),
        &id(100),
        &command("1", 100, Some(1)),
        |_| panic!("replay must not run callback"),
    );
    assert_eq!(replay.unwrap(), saved);
    assert!(matches!(
        transact(&store, "2", 100, Some(1)),
        Err(TransactionError::Store(StoreError::OperationReused))
    ));
    assert!(matches!(
        transact(&store, "1", 102, Some(1)),
        Err(TransactionError::Command("stale_item_revision"))
    ));
    assert_eq!(fs::read(project.live()).unwrap(), live);
    assert_eq!(fs::read(project.backup()).unwrap(), backup);
}

#[test]
fn actor_scopes_share_operation_uuid_without_sharing_replay() {
    let project = ProjectDir::new();
    let store = project.store();
    let first = transact(&store, "1", 100, None).unwrap();
    let other: Result<_, TransactionError<&str>> = store.transact(
        &id(2),
        &ReceiptActorScope::Owner {},
        &id(100),
        &command("1", 100, None),
        |session| {
            session.title = "Changed by trusted owner test callback".into();
            Ok(SavedReceiptData::SessionLifecycle {
                state: session.state.clone(),
                closed_at: session.closed_at.clone(),
            })
        },
    );
    assert_eq!(other.unwrap().revision.value(), 3);
    let read = store.read(&id(2)).unwrap();
    let bucket = &read.operation_receipts.0[&id(100)];
    assert_eq!(bucket.len(), 2);
    assert_ne!(bucket[0].command_digest, bucket[1].command_digest);
    assert_eq!(transact(&store, "1", 100, None).unwrap(), first);
}

#[test]
fn command_key_order_is_irrelevant_but_exact_text_and_revisions_are_part_of_digest() {
    let project = ProjectDir::new();
    let store = project.store();
    let command: serde_json::Value = serde_json::from_str(
        r#"{"text":"one\ntwo", "defaults":{"b":null,"a":1},"expected_revision":1}"#,
    )
    .unwrap();
    let saved: Result<_, TransactionError<()>> =
        store.transact(&id(2), &actor(), &id(100), &command, |session| {
            Ok(SavedReceiptData::SessionLifecycle {
                state: session.state.clone(),
                closed_at: session.closed_at.clone(),
            })
        });
    let reordered = serde_json::from_str(
        r#"{"expected_revision":1,"defaults":{"a":1,"b":null},"text":"one\ntwo"}"#,
    )
    .unwrap();
    let replay: Result<_, TransactionError<()>> =
        store.transact(&id(2), &actor(), &id(100), &reordered, |_| panic!());
    assert_eq!(saved.unwrap(), replay.unwrap());
    for changed in [
        serde_json::json!({"text":"one two","defaults":{"a":1,"b":null},"expected_revision":1}),
        serde_json::json!({"text":"one\ntwo","defaults":{"a":1,"b":null},"expected_revision":2}),
    ] {
        let result: Result<_, TransactionError<()>> =
            store.transact(&id(2), &actor(), &id(100), &changed, |_| panic!());
        assert!(matches!(
            result,
            Err(TransactionError::Store(StoreError::OperationReused))
        ));
    }
}

#[test]
fn routing_is_included_by_the_store_even_when_command_input_is_identical() {
    let project = ProjectDir::new();
    let store = project.store();
    let mut other = seed();
    other.id = id(999);
    store.create(&other).unwrap();
    for session_id in [id(2), id(999)] {
        let result: Result<_, TransactionError<()>> = store.transact(
            &session_id,
            &actor(),
            &id(100),
            &serde_json::json!({"kind":"test"}),
            |session| {
                Ok(SavedReceiptData::SessionLifecycle {
                    state: session.state.clone(),
                    closed_at: None,
                })
            },
        );
        assert_eq!(result.unwrap().session_id, session_id);
    }
    let first = store.read(&id(2)).unwrap();
    let second = store.read(&id(999)).unwrap();
    assert_ne!(
        first.operation_receipts.0[&id(100)][0].command_digest,
        second.operation_receipts.0[&id(100)][0].command_digest
    );
}

#[test]
fn merged_history_validation_runs_on_both_live_and_candidate_snapshots() {
    let project = ProjectDir::new();
    let store = project.store();
    let mut invalid = seed();
    invalid.messages[0].host_turn_id = Some("unmatched-turn".into());
    // P1.1's item/tree seam accepts this shape, but P1.2 rejects its provenance.
    ariadne_domain::validation::validate_session_items(&invalid).unwrap();
    let before = fs::read(project.live()).unwrap();
    let result: Result<_, TransactionError<()>> = store.transact(
        &id(2),
        &actor(),
        &id(100),
        &serde_json::json!({}),
        |candidate| {
            candidate.messages[0].host_turn_id = invalid.messages[0].host_turn_id.clone();
            Ok(SavedReceiptData::SessionLifecycle {
                state: candidate.state.clone(),
                closed_at: None,
            })
        },
    );
    assert!(matches!(
        result,
        Err(TransactionError::Store(StoreError::History(_)))
    ));
    assert_eq!(fs::read(project.live()).unwrap(), before);
    let invalid_bytes = serde_json::to_vec(&invalid).unwrap();
    write_private(&project.live(), &invalid_bytes);
    assert!(matches!(store.read(&id(2)), Err(StoreError::History(_))));
    assert!(transact(&store, "1", 101, None).is_err());
    assert_eq!(fs::read(project.live()).unwrap(), invalid_bytes);
    assert!(!project.backup().exists());
}

#[test]
fn unwritable_sessions_directory_returns_save_error_and_preserves_live_data() {
    let project = ProjectDir::new();
    let store = project.store();
    let before = fs::read(project.live()).unwrap();
    let sessions = project.live().parent().unwrap().to_path_buf();
    fs::set_permissions(&sessions, fs::Permissions::from_mode(0o500)).unwrap();
    let result = transact(&store, "1", 100, None);
    fs::set_permissions(&sessions, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(matches!(
        result,
        Err(TransactionError::Store(StoreError::Io {
            kind: std::io::ErrorKind::PermissionDenied,
            ..
        }))
    ));
    assert_eq!(fs::read(project.live()).unwrap(), before);
    assert!(!project.backup().exists());
    assert!(transact(&store, "1", 100, None).is_ok());
}

fn child(project: &ProjectDir, target: &str, operation: u64) -> Child {
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "writer_worker", "--nocapture"])
        .env("ARIADNE_STORE_TEST_ROOT", project.root.path())
        .env("ARIADNE_STORE_TEST_ITEM", target)
        .env("ARIADNE_STORE_TEST_OPERATION", operation.to_string())
        .spawn()
        .unwrap()
}

fn wait_for(path: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "worker coordination timed out at {path:?}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn writer_worker() {
    let Ok(root) = std::env::var("ARIADNE_STORE_TEST_ROOT") else {
        return;
    };
    let root = std::path::Path::new(&root);
    let target = std::env::var("ARIADNE_STORE_TEST_ITEM").unwrap();
    let operation: u64 = std::env::var("ARIADNE_STORE_TEST_OPERATION")
        .unwrap()
        .parse()
        .unwrap();
    let store = Store::open_registered(root, id(1)).unwrap();
    // Both processes deliberately observe the same old revision before entering
    // transact; it must re-read and use only the touched item's expected revision.
    let expected = store.read(&id(2)).unwrap().items.0[&item(&target)]
        .revision
        .value();
    fs::write(root.join(format!("ready-{operation}")), b"ready").unwrap();
    wait_for(&root.join("go"));
    let result = transact(&store, &target, operation, Some(expected));
    let status = match result {
        Ok(_) => "saved",
        Err(TransactionError::Command("stale_item_revision")) => "conflict",
        other => panic!("unexpected child result: {other:?}"),
    };
    fs::write(root.join(format!("result-{operation}")), status).unwrap();
}

fn process_pair(second_target: &str) -> (ProjectDir, String, String) {
    let project = ProjectDir::new();
    let mut first = child(&project, "1", 100);
    let mut second = child(&project, second_target, 101);
    wait_for(&project.root.path().join("ready-100"));
    wait_for(&project.root.path().join("ready-101"));
    fs::write(project.root.path().join("go"), b"go").unwrap();
    assert!(first.wait().unwrap().success());
    assert!(second.wait().unwrap().success());
    let a = fs::read_to_string(project.root.path().join("result-100")).unwrap();
    let b = fs::read_to_string(project.root.path().join("result-101")).unwrap();
    (project, a, b)
}

#[test]
fn separate_processes_preserve_different_item_updates_and_a_complete_previous_snapshot() {
    let (project, first, second) = process_pair("2");
    assert_eq!((first.as_str(), second.as_str()), ("saved", "saved"));
    let saved = project.store().read(&id(2)).unwrap();
    assert_eq!(saved.revision.value(), 3);
    assert_eq!(saved.messages.len(), 3);
    assert_eq!(saved.items.0[&item("1")].revision.value(), 2);
    assert_eq!(saved.items.0[&item("2")].revision.value(), 2);
    assert_eq!(saved.operation_receipts.0.len(), 2);
    let backup: Session = serde_json::from_slice(&fs::read(project.backup()).unwrap()).unwrap();
    assert_eq!(backup.revision.value(), 2);
    assert_eq!(backup.messages.len(), 2);
}

#[test]
fn separate_processes_conflict_on_stale_same_item_instead_of_losing_an_update() {
    let (project, a, b) = process_pair("1");
    assert!((a == "saved" && b == "conflict") || (a == "conflict" && b == "saved"));
    let saved = project.store().read(&id(2)).unwrap();
    assert_eq!(saved.revision.value(), 2);
    assert_eq!(saved.messages.len(), 2);
    assert_eq!(saved.operation_receipts.0.len(), 1);
}

#[test]
fn independent_store_instances_in_one_process_serialize_the_same_session() {
    let project = ProjectDir::new();
    let barrier = Arc::new(Barrier::new(8));
    std::thread::scope(|scope| {
        for operation in 100..108 {
            let store = project.store();
            let barrier = barrier.clone();
            scope.spawn(move || {
                barrier.wait();
                transact(&store, "1", operation, None).unwrap();
            });
        }
    });
    let saved = project.store().read(&id(2)).unwrap();
    assert_eq!(saved.revision.value(), 9);
    assert_eq!(saved.items.0[&item("1")].revision.value(), 9);
    assert_eq!(saved.messages.len(), 9);
    assert_eq!(saved.operation_receipts.0.len(), 8);
}

#[test]
fn invalid_future_and_duplicate_snapshots_are_never_replaced_or_backed_up() {
    let project = ProjectDir::new();
    let store = project.store();
    let mut invalid_item = serde_json::to_value(seed()).unwrap();
    invalid_item["items"]["1"]["question"] = " ".into();
    let mut invalid_history = serde_json::to_value(seed()).unwrap();
    invalid_history["items"]["1"]["created_message_id"] = serde_json::to_value(id(999)).unwrap();
    let mut future = serde_json::to_value(seed()).unwrap();
    future["schema_version"] = 2.into();
    let seed_json = serde_json::to_string(&seed()).unwrap();
    let duplicate = seed_json.replace("\"items\":{", "\"items\":{},\"items\":{");
    for bytes in [
        b"invalid JSON".to_vec(),
        serde_json::to_vec(&invalid_item).unwrap(),
        serde_json::to_vec(&invalid_history).unwrap(),
        serde_json::to_vec(&future).unwrap(),
        duplicate.into_bytes(),
    ] {
        write_private(&project.live(), &bytes);
        let result: Result<_, TransactionError<()>> =
            store.transact(&id(2), &actor(), &id(100), &serde_json::json!({}), |_| {
                panic!("invalid live data must reject before callback")
            });
        assert!(result.is_err());
        assert_eq!(fs::read(project.live()).unwrap(), bytes);
        assert!(!project.backup().exists());
    }
    write_private(&project.live(), &serde_json::to_vec(&future).unwrap());
    assert!(matches!(store.read(&id(2)), Err(StoreError::FutureSchema)));
}

#[test]
fn invalid_candidates_and_callback_errors_have_no_persistent_effects() {
    let project = ProjectDir::new();
    let store = project.store();
    let before = fs::read(project.live()).unwrap();
    let error: Result<_, TransactionError<&str>> = store.transact(
        &id(2),
        &actor(),
        &id(100),
        &serde_json::json!({}),
        |candidate| {
            candidate.title = "Abandoned".into();
            Err("command rejected")
        },
    );
    assert!(matches!(
        error,
        Err(TransactionError::Command("command rejected"))
    ));
    let invalid: Result<_, TransactionError<()>> = store.transact(
        &id(2),
        &actor(),
        &id(100),
        &serde_json::json!({}),
        |candidate| {
            candidate.items.0.get_mut(&item("1")).unwrap().question = " ".into();
            Ok(SavedReceiptData::SessionLifecycle {
                state: candidate.state.clone(),
                closed_at: None,
            })
        },
    );
    assert!(matches!(
        invalid,
        Err(TransactionError::Store(StoreError::Validation(_)))
    ));
    assert_eq!(fs::read(project.live()).unwrap(), before);
    assert!(!project.backup().exists());
}

#[test]
fn transaction_bookkeeping_identity_and_old_receipts_cannot_be_changed_by_callback() {
    let project = ProjectDir::new();
    let store = project.store();
    transact(&store, "1", 100, None).unwrap();
    let before = fs::read(project.live()).unwrap();
    for field in ["id", "project", "revision", "receipts"] {
        let result: Result<_, TransactionError<()>> = store.transact(
            &id(2),
            &actor(),
            &id(101),
            &serde_json::json!({}),
            |candidate| {
                match field {
                    "id" => candidate.id = id(999),
                    "project" => candidate.project_id = id(999),
                    "revision" => candidate.revision = PositiveSafeInteger::new(999).unwrap(),
                    "receipts" => candidate.operation_receipts.0.clear(),
                    _ => unreachable!(),
                }
                Ok(SavedReceiptData::SessionLifecycle {
                    state: candidate.state.clone(),
                    closed_at: None,
                })
            },
        );
        assert!(matches!(
            result,
            Err(TransactionError::Store(StoreError::IdentityMismatch))
        ));
        assert_eq!(fs::read(project.live()).unwrap(), before);
    }
}

#[test]
fn duplicate_actor_receipts_wrong_route_and_revision_overflow_fail_safely() {
    let project = ProjectDir::new();
    let store = project.store();
    transact(&store, "1", 100, None).unwrap();
    let valid = store.read(&id(2)).unwrap();
    let mut duplicate = valid.clone();
    let bucket = duplicate.operation_receipts.0.get_mut(&id(100)).unwrap();
    bucket.push(bucket[0].clone());
    let mut wrong_route = valid.clone();
    wrong_route.project_id = id(999);
    let mut wrong_receipt = valid.clone();
    wrong_receipt
        .operation_receipts
        .0
        .get_mut(&id(100))
        .unwrap()[0]
        .result
        .session_id = id(999);
    for snapshot in [duplicate, wrong_route, wrong_receipt] {
        let bytes = serde_json::to_vec(&snapshot).unwrap();
        write_private(&project.live(), &bytes);
        assert!(store.read(&id(2)).is_err());
        assert!(transact(&store, "1", 101, None).is_err());
        assert_eq!(fs::read(project.live()).unwrap(), bytes);
    }
    let mut overflow = seed();
    overflow.revision = PositiveSafeInteger::new(9_007_199_254_740_991).unwrap();
    let bytes = serde_json::to_vec(&overflow).unwrap();
    write_private(&project.live(), &bytes);
    assert!(matches!(
        transact(&store, "1", 101, None),
        Err(TransactionError::Store(StoreError::CounterOverflow))
    ));
    assert_eq!(fs::read(project.live()).unwrap(), bytes);
}

#[test]
fn unsafe_backup_target_rejects_replacement_and_cleans_candidate_temp() {
    let project = ProjectDir::new();
    let before = fs::read(project.live()).unwrap();
    let outside = project.root.path().join("external-sentinel");
    write_private(&outside, b"untouched");
    symlink(&outside, project.backup()).unwrap();
    assert!(transact(&project.store(), "1", 100, None).is_err());
    assert_eq!(fs::read(project.live()).unwrap(), before);
    assert_eq!(fs::read(&outside).unwrap(), b"untouched");
    for directory in ["sessions", "backups"] {
        assert!(fs::read_dir(project.root.path().join(directory))
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".tmp-")));
    }
}

#[test]
fn target_replaced_after_reread_is_rechecked_before_commit() {
    let project = ProjectDir::new();
    let before = fs::read(project.live()).unwrap();
    let outside = project.root.path().join("external-sentinel");
    write_private(&outside, b"untouched");
    let result: Result<_, TransactionError<&str>> = project.store().transact(
        &id(2),
        &actor(),
        &id(100),
        &command("1", 100, None),
        |candidate| {
            let data = reply(candidate, "1", 100, None)?;
            fs::remove_file(project.live()).unwrap();
            symlink(&outside, project.live()).unwrap();
            Ok(data)
        },
    );
    assert!(result.is_err());
    assert_eq!(fs::read(&outside).unwrap(), b"untouched");
    assert_eq!(fs::read(project.backup()).unwrap(), before);
    assert!(fs::symlink_metadata(project.live())
        .unwrap()
        .file_type()
        .is_symlink());
}

#[test]
fn project_data_metadata_descendants_locks_and_sessions_reject_symlinks() {
    {
        // The store directory itself must not be reached through a link.
        let project = ProjectDir::new();
        let holder = tempfile::tempdir().unwrap();
        let link = holder.path().join("store");
        symlink(project.root.path(), &link).unwrap();
        assert!(Store::open_registered(&link, id(1)).is_err());
    }
    for target in ["project.json", "sessions", "locks", "backups"] {
        let project = ProjectDir::new();
        let path = project.root.path().join(target);
        let moved = project.root.path().join("moved");
        fs::rename(&path, &moved).unwrap();
        symlink(&moved, &path).unwrap();
        assert!(
            Store::open_registered(project.root.path(), id(1)).is_err(),
            "{target}"
        );
    }
    for is_lock in [false, true] {
        let project = ProjectDir::new();
        let store = project.store();
        let path = if is_lock {
            project.lock()
        } else {
            project.live()
        };
        let moved = project.root.path().join("moved");
        fs::rename(&path, &moved).unwrap();
        symlink(&moved, &path).unwrap();
        let before = fs::read(&moved).unwrap();
        assert!(store.read(&id(2)).is_err());
        assert!(transact(&store, "1", 100, None).is_err());
        assert_eq!(fs::read(&moved).unwrap(), before);
    }
}

#[test]
fn wrong_project_identity_unsafe_permissions_and_nonregular_files_are_rejected() {
    let project = ProjectDir::new();
    assert!(matches!(
        Store::open_registered(project.root.path(), id(999)),
        Err(StoreError::IdentityMismatch)
    ));
    fs::set_permissions(project.live(), fs::Permissions::from_mode(0o644)).unwrap();
    assert!(matches!(
        project.store().read(&id(2)),
        Err(StoreError::UnsafePath { .. })
    ));
    fs::set_permissions(project.live(), fs::Permissions::from_mode(0o600)).unwrap();
    fs::remove_file(project.live()).unwrap();
    fs::create_dir(project.live()).unwrap();
    assert!(matches!(
        project.store().read(&id(2)),
        Err(StoreError::UnsafePath { .. })
    ));
    fs::set_permissions(project.root.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(
        Store::open_registered(project.root.path(), id(1)),
        Err(StoreError::UnsafePath { .. })
    ));
}

#[test]
fn first_creation_rejects_invalid_and_mismatched_session_without_overwriting() {
    let project = ProjectDir::empty();
    let store = project.store();
    let mut wrong = seed();
    wrong.project_id = id(999);
    assert!(matches!(
        store.create(&wrong),
        Err(StoreError::IdentityMismatch)
    ));
    let mut invalid = seed();
    invalid.items.0.get_mut(&item("1")).unwrap().question = "".into();
    assert!(matches!(
        store.create(&invalid),
        Err(StoreError::Validation(_))
    ));
    assert!(!project.live().exists());
    assert!(!project.backup().exists());
    store.create(&seed()).unwrap();
    let before = fs::read(project.live()).unwrap();
    assert!(matches!(
        store.create(&invalid),
        Err(StoreError::AlreadyExists)
    ));
    assert_eq!(fs::read(project.live()).unwrap(), before);
}

#[test]
fn os_lock_contention_is_bounded_and_does_not_touch_snapshot() {
    let project = ProjectDir::new();
    let before = fs::read(project.live()).unwrap();
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(project.lock())
        .unwrap();
    // SAFETY: this test-owned regular file is a live descriptor.
    assert_eq!(
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    let start = Instant::now();
    assert!(matches!(
        project.store().read(&id(2)),
        Err(StoreError::Busy)
    ));
    assert!(start.elapsed() >= Duration::from_millis(1900));
    assert!(start.elapsed() < Duration::from_secs(4));
    assert_eq!(fs::read(project.live()).unwrap(), before);
    drop(file);
    assert!(project.store().read(&id(2)).is_ok());
}

#[test]
fn keyed_in_process_lock_wait_is_bounded_and_other_sessions_remain_available() {
    let project = ProjectDir::new();
    let mut other = seed();
    other.id = id(999);
    project.store().create(&other).unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    std::thread::scope(|scope| {
        let store = project.store();
        let holder = scope.spawn(move || {
            let result: Result<_, TransactionError<()>> = store.transact(
                &id(2),
                &actor(),
                &id(100),
                &serde_json::json!({}),
                |session| {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(SavedReceiptData::SessionLifecycle {
                        state: session.state.clone(),
                        closed_at: None,
                    })
                },
            );
            result.unwrap();
        });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(project.store().read(&id(999)).unwrap().id, id(999));
        let start = Instant::now();
        let result = project.store().read(&id(2));
        // Release before assertions so a failure cannot leave the worker waiting.
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        assert!(matches!(result, Err(StoreError::Busy)));
        assert!(start.elapsed() < Duration::from_secs(4));
    });
}
