use super::*;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use tempfile::TempDir;

fn id(number: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{number:012x}")).unwrap()
}

fn project() -> TempDir {
    let root = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let project = Project {
        schema_version: SchemaVersion::new(1).unwrap(),
        id: id(1),
        display_name: "Peek test".into(),
    };
    let metadata = root.path().join("project.json");
    fs::write(&metadata, encode(&project).unwrap()).unwrap();
    fs::set_permissions(&metadata, fs::Permissions::from_mode(0o600)).unwrap();
    let seed: Session = serde_json::from_str(include_str!(
        "../../../../../fixtures/domain/history/seed.json"
    ))
    .unwrap();
    store(root.path()).create(&seed).unwrap();
    root
}

fn store(root: &Path) -> Store {
    Store::open_registered(root, id(1)).unwrap()
}

/// One committed write: a new revision with this title.
fn retitle(root: &Path, op: u64, wait: impl FnOnce()) -> SavedReceipt {
    store(root)
        .transact(
            &id(2),
            &ReceiptActorScope::Owner {},
            &id(op),
            &serde_json::json!({"kind": "test_title", "op": op}),
            |session| {
                wait();
                session.title = format!("Title {op}");
                Ok::<_, StoreError>(SavedReceiptData::SessionLifecycle {
                    state: session.state.clone(),
                    closed_at: session.closed_at.clone(),
                    archived_at: None,
                    cancelled_input_ids: vec![],
                })
            },
        )
        .unwrap()
}

#[test]
fn peek_reparses_only_when_a_commit_replaces_the_file() {
    let root = project();
    let first = store(root.path()).peek(&id(2)).unwrap();
    let again = store(root.path()).peek(&id(2)).unwrap();
    assert!(
        Arc::ptr_eq(&first, &again),
        "unchanged file reuses the parse"
    );
    assert_eq!(*first, store(root.path()).read(&id(2)).unwrap());

    // A refused transaction writes nothing, so the cached parse stays valid.
    let refused = store(root.path()).transact(
        &id(2),
        &ReceiptActorScope::Owner {},
        &id(90),
        &serde_json::json!({"kind": "refused"}),
        |_| Err::<SavedReceiptData, _>("refused"),
    );
    assert!(matches!(refused, Err(TransactionError::Command("refused"))));
    assert!(Arc::ptr_eq(
        &first,
        &store(root.path()).peek(&id(2)).unwrap()
    ));

    for op in 100..105 {
        let saved = retitle(root.path(), op, || {});
        let fresh = store(root.path()).peek(&id(2)).unwrap();
        assert!(!Arc::ptr_eq(&first, &fresh));
        assert_eq!(fresh.revision, saved.revision, "the commit is seen at once");
        assert_eq!(fresh.title, format!("Title {op}"));
        assert_eq!(*fresh, store(root.path()).read(&id(2)).unwrap());
        assert!(Arc::ptr_eq(
            &fresh,
            &store(root.path()).peek(&id(2)).unwrap()
        ));
    }
}

#[test]
fn peek_never_waits_for_the_session_lock_and_sees_the_commit_after_it() {
    let root = project();
    let writer_root = root.path().to_path_buf();
    let (locked_tx, locked_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let writer = std::thread::spawn(move || {
        retitle(&writer_root, 100, move || {
            locked_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(30)).unwrap();
        })
    });
    locked_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let started = Instant::now();
    let during = store(root.path()).peek(&id(2));
    let waited = started.elapsed();
    // A locked read waits for the writer; peek must not.
    let (busy_tx, busy_rx) = mpsc::channel();
    let reader_root = root.path().to_path_buf();
    std::thread::spawn(move || busy_tx.send(store(&reader_root).read(&id(2))).unwrap());
    let locked_read = busy_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    release_tx.send(()).unwrap();
    let saved = writer.join().unwrap();
    let during = during.unwrap();
    assert!(waited < Duration::from_secs(1), "peek waited {waited:?}");
    assert!(matches!(locked_read, Err(StoreError::Busy)));
    assert_eq!(
        during.revision.value(),
        1,
        "the in-flight write is not seen"
    );
    let after = store(root.path()).peek(&id(2)).unwrap();
    assert_eq!(after.revision, saved.revision);
}

#[test]
fn concurrent_peeks_see_only_committed_revisions_in_order() {
    let root = project();
    let committed = Arc::new(AtomicU64::new(1));
    let done = Arc::new(AtomicBool::new(false));
    let readers: Vec<_> = (0..4)
        .map(|_| {
            let root = root.path().to_path_buf();
            let committed = committed.clone();
            let done = done.clone();
            std::thread::spawn(move || {
                let mut last = 0;
                let mut seen = 0;
                while !done.load(Ordering::SeqCst) {
                    let before = committed.load(Ordering::SeqCst);
                    let session = store(&root).peek(&id(2)).unwrap();
                    let after = committed.load(Ordering::SeqCst);
                    let revision = session.revision.value();
                    // Linearizable: no older than what committed before the
                    // call, at most the one commit still being acknowledged.
                    assert!(before <= revision && revision <= after + 1);
                    assert!(revision >= last, "revisions never go back");
                    // Whole snapshots only: the title is the one its revision saved.
                    if revision > 1 {
                        assert_eq!(session.title, format!("Title {}", 1000 + revision - 2));
                    }
                    last = revision;
                    seen += 1;
                }
                seen
            })
        })
        .collect();
    for op in 0..60 {
        let saved = retitle(root.path(), 1000 + op, || {});
        committed.store(saved.revision.value(), Ordering::SeqCst);
    }
    done.store(true, Ordering::SeqCst);
    for reader in readers {
        assert!(reader.join().unwrap() > 0);
    }
    let last = store(root.path()).peek(&id(2)).unwrap();
    assert_eq!(last.revision.value(), committed.load(Ordering::SeqCst));
}

#[test]
fn peek_fails_closed_like_a_locked_read() {
    let root = project();
    let live = root
        .path()
        .join(format!("sessions/{}.json", id(2).as_str()));
    store(root.path()).peek(&id(2)).unwrap();
    // A replaced file with invalid content is never served from the cache.
    let staged = root.path().join("sessions/.staged");
    fs::write(&staged, b"{\"schema_version\":1}").unwrap();
    fs::set_permissions(&staged, fs::Permissions::from_mode(0o600)).unwrap();
    fs::rename(&staged, &live).unwrap();
    assert!(store(root.path()).peek(&id(2)).is_err());
    assert!(store(root.path()).read(&id(2)).is_err());
    fs::remove_file(&live).unwrap();
    assert!(matches!(
        store(root.path()).peek(&id(2)),
        Err(StoreError::Io {
            kind: std::io::ErrorKind::NotFound,
            ..
        })
    ));
}
