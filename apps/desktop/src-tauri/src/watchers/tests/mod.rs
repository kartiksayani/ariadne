use super::*;
use ariadne_domain::models::{PositiveSafeInteger, Session, UuidV4};
use ariadne_store::session::Store;
use std::fs;
use std::os::unix::fs::PermissionsExt;

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn seed() -> Session {
    serde_json::from_str(include_str!(
        "../../../../../../fixtures/domain/history/seed.json"
    ))
    .unwrap()
}
fn new_session(project: u64, session: u64) -> Session {
    let mut text = serde_json::to_string(&seed()).unwrap();
    // Preserve every canonical relationship while giving each test session
    // distinct binding/generation/message/topic identities.
    for original in 3..=6 {
        text = text.replace(
            id(original).as_str(),
            id(session * 1000 + original).as_str(),
        );
    }
    text = text.replace(id(2).as_str(), id(session).as_str());
    text = text.replace(id(1).as_str(), id(project).as_str());
    serde_json::from_str(&text).unwrap()
}
struct Files {
    _home: tempfile::TempDir,
    _project: tempfile::TempDir,
    data: PathBuf,
    root: PathBuf,
}
impl Files {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        registry
            .register(project.path(), &id(90), || id(1))
            .unwrap();
        let root = registry.project_dir(&id(1));
        Store::open_registered(&root, id(1))
            .unwrap()
            .create(&seed())
            .unwrap();
        Self {
            data: fs::canonicalize(home.path().join(".ariadne")).unwrap(),
            root,
            _home: home,
            _project: project,
        }
    }
    fn registry(&self) -> Registry {
        Registry::open_data_directory(&self.data).unwrap()
    }
    fn live(&self) -> PathBuf {
        self.root.join(format!("sessions/{}.json", id(2).as_str()))
    }
    fn publish(&self, revision: u64) {
        let mut session = seed();
        session.revision = PositiveSafeInteger::new(revision).unwrap();
        let temp = self.live().with_extension("next");
        fs::write(&temp, serde_json::to_vec(&session).unwrap()).unwrap();
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600)).unwrap();
        fs::rename(temp, self.live()).unwrap();
    }
}

#[test]
fn registered_scan_validates_and_retains_last_revision_on_bad_deleted_or_unavailable_data() {
    let files = Files::new();
    let registry = files.registry();
    let projects = registry.registered_projects().unwrap();
    let mut scan = scan::Scan::default();
    let hints = Arc::new(Mutex::new(Vec::new()));
    let capture = hints.clone();
    let emit = move |hint| {
        capture.lock().unwrap().push(hint);
        true
    };
    let route = SessionRef {
        project_id: id(1),
        session_id: id(2),
    };
    scan.reconcile(&registry, &projects, Some(&route), &emit);
    assert_eq!(hints.lock().unwrap().len(), 1); // Selected plus catalogue dedupe.
    files.publish(3);
    scan.reconcile(&registry, &projects, Some(&route), &emit);
    assert_eq!(hints.lock().unwrap().last().unwrap().revision.value(), 3);
    let valid = fs::read(files.live()).unwrap();
    fs::write(files.live(), b"{invalid snapshot").unwrap();
    scan.reconcile(&registry, &projects, Some(&route), &emit);
    fs::remove_file(files.live()).unwrap();
    scan.reconcile(&registry, &projects, Some(&route), &emit);
    let data = files.root.clone();
    let offline = files.root.with_file_name("offline");
    fs::rename(&data, &offline).unwrap();
    scan.reconcile(&registry, &projects, Some(&route), &emit);
    fs::rename(offline, data).unwrap();
    fs::write(files.live(), valid).unwrap();
    files.publish(2); // A restored older snapshot cannot regress the hint cache.
    scan.reconcile(&registry, &projects, Some(&route), &emit);
    assert_eq!(hints.lock().unwrap().len(), 2);
    files.publish(4);
    scan.reconcile(&registry, &projects, Some(&route), &emit);
    assert_eq!(hints.lock().unwrap().last().unwrap().revision.value(), 4);
}

#[test]
fn failed_event_publication_retries_and_wrong_project_selection_cannot_route_a_read() {
    let files = Files::new();
    let registry = files.registry();
    let projects = registry.registered_projects().unwrap();
    let mut scan = scan::Scan::default();
    let wrong = SessionRef {
        project_id: id(999),
        session_id: id(2),
    };
    let rejected = Arc::new(Mutex::new(0));
    let record = rejected.clone();
    scan.reconcile(&registry, &projects, Some(&wrong), &move |_| {
        *record.lock().unwrap() += 1;
        false
    });
    assert_eq!(*rejected.lock().unwrap(), 1); // Only actual registered catalogue.
    let accepted = Arc::new(Mutex::new(Vec::new()));
    let record = accepted.clone();
    scan.reconcile(&registry, &projects, None, &move |hint| {
        record.lock().unwrap().push(hint);
        true
    });
    assert_eq!(accepted.lock().unwrap().len(), 1);
}

#[test]
fn native_parent_watch_observes_atomic_publish_new_session_and_registration_then_joins() {
    let files = Files::new();
    let (send, receive) = mpsc::channel();
    // A long fallback proves these updates arrive through installed OS watches.
    let watcher = RegisteredWatcher::start_with_fallback(
        files.registry(),
        files.data.clone(),
        move |hint| send.send(hint).is_ok(),
        Duration::from_secs(60),
    )
    .unwrap();
    assert_eq!(
        receive
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .revision
            .value(),
        1
    );
    files.publish(2);
    assert_eq!(
        receive
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .revision
            .value(),
        2
    );
    let created = new_session(1, 20);
    Store::open_registered(&files.root, id(1))
        .unwrap()
        .create(&created)
        .unwrap();
    assert_eq!(
        receive
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .session_id,
        id(20)
    );
    let another = tempfile::tempdir().unwrap();
    let registry = files.registry();
    registry
        .register(another.path(), &id(91), || id(10))
        .unwrap();
    let session = new_session(10, 21);
    Store::open_registered(&registry.project_dir(&id(10)), id(10))
        .unwrap()
        .create(&session)
        .unwrap();
    assert_eq!(
        receive
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .session_id,
        id(21)
    );
    let stopped = Instant::now();
    drop(watcher);
    assert!(stopped.elapsed() < Duration::from_secs(5));
    files.publish(3);
    assert!(matches!(
        receive.recv_timeout(Duration::from_millis(200)),
        Err(mpsc::RecvTimeoutError::Disconnected)
    ));
}

#[test]
fn fallback_recovers_an_unwatchable_registered_parent_without_fabricating_empty_data() {
    let files = Files::new();
    let offline = files.root.with_extension("offline");
    fs::rename(&files.root, &offline).unwrap();
    let (send, receive) = mpsc::channel();
    let watcher = RegisteredWatcher::start(files.registry(), files.data.clone(), move |hint| {
        send.send(hint).is_ok()
    })
    .unwrap();
    // Start returns after the initial failed parent watch attempts. Restoring
    // this sibling root is outside the registry-parent watch; the actual 2s
    // fallback must re-resolve it and publish its first validated revision.
    fs::rename(offline, &files.root).unwrap();
    let hint = receive.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(hint.session_id, id(2));
    assert_eq!(hint.revision.value(), 1);
    drop(watcher);
}

#[test]
fn wake_reconcile_prioritizes_registered_selection_and_coalesces_bounded_signals() {
    let files = Files::new();
    let (send, receive) = mpsc::channel();
    let watcher = RegisteredWatcher::start_with_fallback(
        files.registry(),
        files.data.clone(),
        move |hint| send.send(hint).is_ok(),
        Duration::from_millis(100),
    )
    .unwrap();
    assert_eq!(
        receive
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .revision
            .value(),
        1
    );
    watcher.select(Some(SessionRef {
        project_id: id(1),
        session_id: id(2),
    }));
    for _ in 0..1000 {
        watcher.reconcile();
    }
    files.publish(2);
    assert_eq!(
        receive
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .revision
            .value(),
        2
    );
    assert!(receive.recv_timeout(Duration::from_millis(250)).is_err());
    drop(watcher);
}

#[test]
fn unchanged_fallback_scans_notify_native_consumers_without_fabricating_revisions() {
    let files = Files::new();
    let (hints, revisions) = mpsc::channel();
    let (refresh, completed) = mpsc::channel();
    let watcher = RegisteredWatcher::start_observer(
        files.registry(),
        files.data.clone(),
        move |hint| hints.send(hint).is_ok(),
        Duration::from_millis(100),
        Arc::new(move || {
            let _ = refresh.send(());
        }),
    )
    .unwrap();
    revisions.recv_timeout(Duration::from_secs(2)).unwrap();
    completed.recv_timeout(Duration::from_secs(2)).unwrap();
    completed.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(revisions.try_recv().is_err());
    drop(watcher);
    while completed.try_recv().is_ok() {}
    assert!(matches!(
        completed.try_recv(),
        Err(mpsc::TryRecvError::Disconnected)
    ));
}
