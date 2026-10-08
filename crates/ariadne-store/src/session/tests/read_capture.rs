use super::*;
use std::cell::RefCell;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::mpsc;
use std::time::Duration;
use tempfile::TempDir;

thread_local! {
    static BEFORE_DECODE: RefCell<Option<Box<dyn FnOnce()>>> = RefCell::new(None);
}

pub(super) fn before_decode() {
    let callback = BEFORE_DECODE.with(|slot| slot.borrow_mut().take());
    if let Some(callback) = callback {
        callback();
    }
}

fn id(number: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{number:012x}")).unwrap()
}

fn seed() -> Session {
    serde_json::from_str(include_str!(
        "../../../../../fixtures/domain/history/seed.json"
    ))
    .unwrap()
}

fn write_private(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

fn project() -> TempDir {
    let root = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    // The tempdir is the project's store directory (`<data root>/projects/<id>`).
    let data = root.path().to_path_buf();
    fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).unwrap();
    let project = Project {
        schema_version: SchemaVersion::new(1).unwrap(),
        id: id(1),
        display_name: "Captured read test".into(),
    };
    write_private(&data.join("project.json"), &encode(&project).unwrap());
    Store::open_registered(root.path(), id(1))
        .unwrap()
        .create(&seed())
        .unwrap();
    // Strict diagnostics need the pre-existing outer coordination file too.
    Store::read_registered(root.path(), &id(1), &id(2)).unwrap();
    root
}

#[derive(Clone, Copy, Debug)]
enum ReadPath {
    Store,
    Registered,
    Inspect,
    Diagnose,
}

const READ_PATHS: [ReadPath; 4] = [
    ReadPath::Store,
    ReadPath::Registered,
    ReadPath::Inspect,
    ReadPath::Diagnose,
];

impl ReadPath {
    fn read(self, root: &Path) -> Result<Session, StoreError> {
        match self {
            Self::Store => Store::open_registered(root, id(1))?.read(&id(2)),
            Self::Registered => Store::read_registered(root, &id(1), &id(2)),
            Self::Inspect | Self::Diagnose => {
                let catalogue = if matches!(self, Self::Inspect) {
                    Store::inspect_registered(root, &id(1))?
                } else {
                    Store::diagnose_registered(root, &id(1))?
                };
                assert_eq!(catalogue.project.id, id(1));
                let mut sessions = catalogue.sessions?;
                assert_eq!(sessions.len(), 1);
                let outcome = sessions.remove(0);
                assert_eq!(outcome.session_id, Some(id(2)));
                assert_eq!(outcome.path, live(root));
                outcome.result
            }
        }
    }
}

fn live(root: &Path) -> PathBuf {
    root.join(format!("sessions/{}.json", id(2).as_str()))
}

#[test]
fn captured_reads_release_project_and_session_guards_before_validation() {
    for path in READ_PATHS {
        let root = project();
        let reader_root = root.path().to_path_buf();
        let writer_root = reader_root.clone();
        let (captured_tx, captured_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            BEFORE_DECODE.with(|slot| {
                *slot.borrow_mut() = Some(Box::new(move || {
                    captured_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(30)).unwrap();
                }));
            });
            path.read(&reader_root)
        });
        captured_rx.recv_timeout(Duration::from_secs(5)).unwrap();

        let (saved_tx, saved_rx) = mpsc::channel();
        let writer = std::thread::spawn(move || {
            // Acquire both real coordination paths. A retained process mutex or
            // flock on either project or session prevents this commit.
            let data = Directory::root(&writer_root).unwrap();
            let saved = lock::with_lock(&data, "project.lock", || {
                let store = Store::open_registered(&writer_root, id(1))?;
                store
                    .transact(
                        &id(2),
                        &ReceiptActorScope::Owner {},
                        &id(100),
                        &serde_json::json!({"kind": "test_title", "title": "After capture"}),
                        |session| {
                            session.title = "After capture".into();
                            Ok::<_, StoreError>(SavedReceiptData::SessionLifecycle {
                                state: session.state.clone(),
                                closed_at: session.closed_at.clone(),
                                cancelled_input_ids: vec![],
                            })
                        },
                    )
                    .map_err(|error| match error {
                        TransactionError::Store(error) | TransactionError::Command(error) => error,
                    })
            });
            saved_tx.send(saved).unwrap();
        });
        let saved = saved_rx.recv_timeout(Duration::from_secs(5));
        // Always unblock the reader before reporting a failure or joining.
        release_tx.send(()).unwrap();
        writer.join().unwrap();
        let captured = reader.join().unwrap().unwrap();
        let saved = saved.unwrap().unwrap();
        assert_eq!(saved.revision.value(), 2, "{path:?}");
        assert_eq!(captured, seed(), "{path:?} returns the captured revision");
        let current = Store::open_registered(root.path(), id(1))
            .unwrap()
            .read(&id(2))
            .unwrap();
        assert_eq!(current.revision.value(), 2);
        assert_eq!(current.title, "After capture");
    }
}

#[test]
fn captured_reads_keep_schema_identity_and_semantic_failures_closed() {
    let root = project();
    let mut wrong_session = seed();
    wrong_session.id = id(90);
    let mut wrong_project = seed();
    wrong_project.project_id = id(90);
    let mut invalid_items = seed();
    invalid_items.messages.clear();
    let mut invalid_history = seed();
    invalid_history.messages[0].host_turn_id = Some("unmatched-turn".into());
    let cases = [
        (b"{".to_vec(), "invalid"),
        (br#"{"schema_version":2}"#.to_vec(), "future"),
        (encode(&wrong_session).unwrap(), "identity"),
        (encode(&wrong_project).unwrap(), "identity"),
        (encode(&invalid_items).unwrap(), "validation"),
        (encode(&invalid_history).unwrap(), "history"),
    ];
    for (bytes, expected) in cases {
        write_private(&live(root.path()), &bytes);
        for path in READ_PATHS {
            let error = path.read(root.path()).unwrap_err();
            assert!(
                matches!(
                    (&error, expected),
                    (StoreError::InvalidSnapshot, "invalid")
                        | (StoreError::FutureSchema, "future")
                        | (StoreError::IdentityMismatch, "identity")
                        | (StoreError::Validation(_), "validation")
                        | (StoreError::History(_), "history")
                ),
                "{path:?}: {error:?} instead of {expected}"
            );
        }
    }
}

#[test]
fn catalogue_preserves_partial_failures_and_strict_diagnostic_authority() {
    let root = project();
    let sessions = root.path().join("sessions");
    write_private(&sessions.join("not-a-session.json"), b"{}");
    write_private(
        &sessions.join(format!("{}.json", id(90).as_str())),
        br#"{"schema_version":2}"#,
    );
    // Inspection creates only the missing permanent coordination file.
    let inspected = Store::inspect_registered(root.path(), &id(1)).unwrap();
    let inspected = inspected.sessions.unwrap();
    assert_eq!(inspected.len(), 3);
    assert_eq!(
        inspected
            .iter()
            .filter(|entry| entry.result.is_ok())
            .count(),
        1
    );
    assert!(inspected.iter().any(|entry| entry.session_id.is_none()
        && matches!(&entry.result, Err(StoreError::UnsafePath { .. }))));
    assert!(inspected
        .iter()
        .any(|entry| entry.session_id == Some(id(90))
            && matches!(&entry.result, Err(StoreError::FutureSchema))));

    let missing_lock = root.path().join(format!("locks/{}.lock", id(90).as_str()));
    fs::remove_file(&missing_lock).unwrap();
    let diagnosed = Store::diagnose_registered(root.path(), &id(1)).unwrap();
    let diagnosed = diagnosed.sessions.unwrap();
    assert_eq!(diagnosed.len(), 3);
    assert_eq!(
        diagnosed
            .iter()
            .filter(|entry| entry.result.is_ok())
            .count(),
        1
    );
    assert!(diagnosed
        .iter()
        .any(|entry| entry.session_id == Some(id(90))
            && matches!(
                &entry.result,
                Err(StoreError::Io {
                    kind: io::ErrorKind::NotFound,
                    ..
                })
            )));
    assert!(!missing_lock.exists());
}

#[test]
fn project_identity_gate_precedes_session_coordination_creation() {
    let root = project();
    let locks = root.path().join("locks");
    fs::remove_dir_all(&locks).unwrap();
    let wrong_project = Project {
        schema_version: SchemaVersion::new(1).unwrap(),
        id: id(90),
        display_name: "Different project".into(),
    };
    write_private(
        &root.path().join("project.json"),
        &encode(&wrong_project).unwrap(),
    );
    assert!(matches!(
        Store::read_registered(root.path(), &id(1), &id(2)),
        Err(StoreError::IdentityMismatch)
    ));
    assert!(matches!(
        Store::inspect_registered(root.path(), &id(1)),
        Err(StoreError::IdentityMismatch)
    ));
    assert!(!locks.exists());
}
