#[allow(dead_code)]
mod support;
use ariadne_domain::models::*;
use ariadne_store::registry::{Registry, RegistryError};
use ariadne_store::session::{Store, StoreError};
use serde_json::json;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{symlink, MetadataExt};
use std::process::{Child, Command};
use std::time::{Duration, Instant};
use support::*;

fn registration(registry: &Registry, project: &std::path::Path, number: u64) {
    registry
        .register(project, &id(number + 1000), || id(number))
        .unwrap();
}
fn blank(project: u64, session: u64, binding: u64, host: &str) -> Session {
    let mut value = seed();
    value.project_id = id(project);
    value.id = id(session);
    value.title = "Explicit test session".into();
    value.topics.0.clear();
    value.items.0.clear();
    value.messages.clear();
    value.rounds.0.clear();
    value.answers.clear();
    value.inputs.0.clear();
    value.operation_receipts.0.clear();
    value.continuations.0.clear();
    value.counters = SessionCounters {
        next_root: PositiveSafeInteger::new(1).unwrap(),
        next_topic_order: PositiveSafeInteger::new(1).unwrap(),
        next_message: PositiveSafeInteger::new(1).unwrap(),
        next_input: PositiveSafeInteger::new(1).unwrap(),
        next_answer: PositiveSafeInteger::new(1).unwrap(),
    };
    let mut selected = value.bindings.0[&id(3)].clone();
    selected.id = id(binding);
    selected.external_session_id = host.into();
    value.bindings.0.clear();
    value.bindings.0.insert(selected.id.clone(), selected);
    value.active_binding_id = Some(id(binding));
    value
}

#[test]
fn registration_canonicalizes_roots_preserves_receipts_and_never_persists_zero_revision() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let alias = home.path().join("alias");
    symlink(root.path(), &alias).unwrap();
    let registry = Registry::open(home.path()).unwrap();
    assert!(!home.path().join(".ariadne/projects.json").exists());
    assert!(registry.registered_projects().unwrap().is_empty());
    let result = registry.register(&alias, &id(101), || id(1)).unwrap();
    assert_eq!(result.registry_revision.value(), 1);
    let projects = registry.registered_projects().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].root, root.path().canonicalize().unwrap());
    assert_eq!(registry.resolve_project(&id(1)).unwrap(), projects[0]);
    let bytes = fs::read(home.path().join(".ariadne/projects.json")).unwrap();
    fs::rename(
        root.path().join(".ariadne"),
        root.path().join("temporarily-unavailable"),
    )
    .unwrap();
    assert_eq!(
        registry
            .register(&alias, &id(101), || panic!("exact replay"))
            .unwrap(),
        result
    );
    assert_eq!(
        fs::read(home.path().join(".ariadne/projects.json")).unwrap(),
        bytes
    );
    assert!(matches!(
        registry.resolve_project(&id(1)),
        Err(RegistryError::Unavailable { .. })
    ));
    assert!(matches!(
        registry.register(&alias.join("changed"), &id(101), || id(9)),
        Err(RegistryError::Store(StoreError::OperationReused))
    ));
    assert_eq!(
        fs::metadata(home.path().join(".ariadne")).unwrap().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(home.path().join(".ariadne/projects.json"))
            .unwrap()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn fixed_registration_replay_binds_mode_and_exact_expected_identity_before_preflight() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    let first = registry
        .register_fixed(root.path(), &id(100), &id(1))
        .unwrap();
    assert_eq!(first.project_id, id(1));
    let before = fs::read(home.path().join(".ariadne/projects.json")).unwrap();
    fs::rename(
        root.path().join(".ariadne"),
        root.path().join("unavailable"),
    )
    .unwrap();
    assert_eq!(
        registry
            .register_fixed(root.path(), &id(100), &id(1))
            .unwrap(),
        first
    );
    for error in [
        registry
            .register_fixed(root.path(), &id(100), &id(2))
            .unwrap_err(),
        registry
            .register(root.path(), &id(100), || {
                panic!("mode conflict before allocation")
            })
            .unwrap_err(),
    ] {
        assert!(matches!(
            error,
            RegistryError::Store(StoreError::OperationReused)
        ));
    }
    assert_eq!(
        fs::read(home.path().join(".ariadne/projects.json")).unwrap(),
        before
    );

    let ordinary = tempfile::tempdir().unwrap();
    // Restore the registered root before a valid new ordinary registration.
    fs::rename(
        root.path().join("unavailable"),
        root.path().join(".ariadne"),
    )
    .unwrap();
    registry
        .register(ordinary.path(), &id(101), || id(2))
        .unwrap();
    assert!(matches!(
        registry.register_fixed(ordinary.path(), &id(101), &id(2)),
        Err(RegistryError::Store(StoreError::OperationReused))
    ));
}

#[test]
fn fixed_registration_rejects_existing_metadata_without_a_registry_receipt_or_write() {
    let home = tempfile::tempdir().unwrap();
    let other_home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let other = Registry::open(other_home.path()).unwrap();
    registration(&other, root.path(), 2);
    let metadata = root.path().join(".ariadne/project.json");
    let before = fs::read(&metadata).unwrap();
    let registry = Registry::open(home.path()).unwrap();
    let error = registry
        .register_fixed(root.path(), &id(100), &id(1))
        .unwrap_err();
    let RegistryError::Conflict { paths } = error else {
        panic!("{error:?}")
    };
    assert_eq!(paths, vec![metadata.canonicalize().unwrap()]);
    assert_eq!(fs::read(&metadata).unwrap(), before);
    assert!(!home.path().join(".ariadne/projects.json").exists());
    assert!(registry.registered_projects().unwrap().is_empty());
    // Rejection saved no receipt; the same operation can register the actual
    // matching fixed identity after the caller corrects its first attempt.
    assert_eq!(
        registry
            .register_fixed(root.path(), &id(100), &id(2))
            .unwrap()
            .project_id,
        id(2)
    );
}

#[test]
fn restored_project_metadata_after_absence_keeps_bytes_and_cannot_publish_wrong_identity() {
    let home = tempfile::tempdir().unwrap();
    let registered_root = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    registration(&registry, registered_root.path(), 10);
    registry.rebuild().unwrap();
    let registry_path = home.path().join(".ariadne/projects.json");
    let index_path = home.path().join(".ariadne/bindings.json");
    let registry_before = fs::read(&registry_path).unwrap();
    let index_before = fs::read(&index_path).unwrap();
    let projects_before = registry.registered_projects().unwrap();
    let metadata_path = root.path().join(".ariadne/project.json");
    let restored = serde_json::to_vec(&Project {
        schema_version: SchemaVersion::new(1).unwrap(),
        id: id(2),
        display_name: "Restored authoritative project".into(),
    })
    .unwrap();
    assert!(!metadata_path.exists());
    assert!(matches!(
        registry.register(root.path(), &id(1001), || {
            // Ordinary external restoration after the locked absence decision.
            write_private(&metadata_path, &restored);
            id(1)
        }),
        Err(RegistryError::Store(StoreError::AlreadyExists))
    ));
    assert_eq!(fs::read(&metadata_path).unwrap(), restored);
    assert_eq!(fs::read(&registry_path).unwrap(), registry_before);
    assert_eq!(fs::read(&index_path).unwrap(), index_before);
    assert_eq!(registry.registered_projects().unwrap(), projects_before);
    assert!(fs::read_dir(metadata_path.parent().unwrap())
        .unwrap()
        .all(|entry| !entry
            .unwrap()
            .file_name()
            .to_str()
            .unwrap()
            .contains(".tmp-")));

    // The failed publication left no receipt: retry reads the restored identity.
    let result = registry
        .register(root.path(), &id(1001), || panic!("existing metadata"))
        .unwrap();
    assert_eq!(result.project_id, id(2));
    assert_eq!(
        registry.resolve_project(&id(2)).unwrap().root,
        root.path().canonicalize().unwrap()
    );
}

#[test]
fn invalid_native_registration_text_paths_and_persisted_zero_have_typed_no_effect_errors() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    let invalid = std::path::Path::new(std::ffi::OsStr::from_bytes(b"/tmp/invalid-\xff"));
    assert!(matches!(
        registry.register(invalid, &id(1), || panic!("invalid")),
        Err(RegistryError::InvalidArgument)
    ));
    assert!(!root.path().join(".ariadne").exists());
    assert!(!home.path().join(".ariadne/projects.json").exists());
    let path = home.path().join(".ariadne/projects.json");
    let bytes = br#"{"schema_version":1,"revision":0,"projects":[],"operations":[]}"#;
    write_private(&path, bytes);
    assert!(matches!(
        registry.registered_projects(),
        Err(RegistryError::InvalidData { .. })
    ));
    assert_eq!(fs::read(&path).unwrap(), bytes);
}

#[test]
fn duplicate_metadata_identity_and_unavailable_registered_roots_stop_new_registration() {
    let home = tempfile::tempdir().unwrap();
    let one = tempfile::tempdir().unwrap();
    let two = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    registration(&registry, one.path(), 1);
    let bytes = fs::read(home.path().join(".ariadne/projects.json")).unwrap();
    assert!(matches!(
        registry.register(two.path(), &id(1002), || id(1)),
        Err(RegistryError::Conflict { .. })
    ));
    assert!(!two.path().join(".ariadne/project.json").exists());
    fs::rename(one.path().join(".ariadne"), one.path().join("unavailable")).unwrap();
    assert!(matches!(
        registry.register(two.path(), &id(1002), || id(2)),
        Err(RegistryError::Unavailable { .. })
    ));
    assert_eq!(
        fs::read(home.path().join(".ariadne/projects.json")).unwrap(),
        bytes
    );
    assert_eq!(registry.registered_projects().unwrap().len(), 1);
}

#[test]
fn changed_registered_metadata_and_noncanonical_session_files_stop_routing_without_index_changes() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    registration(&registry, root.path(), 1);
    let store = Store::open_registered(root.path(), id(1)).unwrap();
    store.create(&blank(1, 2, 3, "host")).unwrap();
    registry.rebuild().unwrap();
    let index = fs::read(home.path().join(".ariadne/bindings.json")).unwrap();
    let metadata = root.path().join(".ariadne/project.json");
    let before = fs::read(&metadata).unwrap();
    let mut changed: Project = serde_json::from_slice(&before).unwrap();
    changed.id = id(9);
    write_private(&metadata, &serde_json::to_vec(&changed).unwrap());
    assert!(matches!(
        registry.rebuild(),
        Err(RegistryError::Conflict { .. })
    ));
    assert_eq!(
        fs::read(home.path().join(".ariadne/bindings.json")).unwrap(),
        index
    );
    write_private(&metadata, &before);
    let invalid = root.path().join(".ariadne/sessions/not-a-uuid.json");
    write_private(&invalid, b"not a canonical session");
    assert!(registry.rebuild().is_err());
    assert_eq!(
        fs::read(home.path().join(".ariadne/bindings.json")).unwrap(),
        index
    );
    assert_eq!(fs::read(&invalid).unwrap(), b"not a canonical session");
}

#[test]
fn registered_project_session_scan_is_local_but_global_uniqueness_requires_every_root() {
    let home = tempfile::tempdir().unwrap();
    let one = tempfile::tempdir().unwrap();
    let two = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    registration(&registry, one.path(), 1);
    registration(&registry, two.path(), 10);
    Store::open_registered(one.path(), id(1))
        .unwrap()
        .create(&blank(1, 2, 3, "one"))
        .unwrap();
    fs::rename(two.path().join(".ariadne"), two.path().join("unavailable")).unwrap();
    registry
        .with_binding_setup(|setup| {
            assert_eq!(setup.project_sessions(&id(1))?.len(), 1);
            assert!(matches!(
                setup.sessions(),
                Err(RegistryError::Unavailable { .. })
            ));
            Ok::<_, RegistryError>(())
        })
        .unwrap();
}

#[test]
fn registry_lock_is_stable_and_bounded_while_other_homes_remain_independent() {
    let home = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    let other_registry = Registry::open(other.path()).unwrap();
    let inode = fs::metadata(home.path().join(".ariadne/registry.lock"))
        .unwrap()
        .ino();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        let registry_ref = &registry;
        scope.spawn(move || {
            registry_ref
                .with_binding_setup(|_| {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok::<_, RegistryError>(())
                })
                .unwrap()
        });
        entered_rx.recv().unwrap();
        assert!(other_registry.registered_projects().unwrap().is_empty());
        let start = Instant::now();
        assert!(matches!(
            registry.registered_projects(),
            Err(RegistryError::Store(StoreError::Busy))
        ));
        assert!(start.elapsed() < Duration::from_secs(3));
        release_tx.send(()).unwrap();
    });
    assert_eq!(
        fs::metadata(home.path().join(".ariadne/registry.lock"))
            .unwrap()
            .ino(),
        inode
    );
}

#[test]
fn rebuild_uses_only_registered_selected_bindings_and_preserves_unavailable_knowledge() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let foreign = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    registration(&registry, root.path(), 1);
    let mut session = blank(1, 2, 3, "opaque selected");
    let mut historical = session.bindings.0[&id(3)].clone();
    historical.id = id(8);
    historical.external_session_id = "old host".into();
    historical.dispatch_state = DispatchState::Disconnected;
    session.bindings.0.insert(id(8), historical);
    session.state = SessionState::Closed;
    session.closed_at = Some(session.updated_at.clone());
    session.bindings.0.get_mut(&id(3)).unwrap().dispatch_state = DispatchState::Paused;
    Store::open_registered(root.path(), id(1))
        .unwrap()
        .create(&session)
        .unwrap();
    // Nearby unregistered project is not discovered or indexed.
    fs::create_dir(foreign.path().join(".ariadne")).unwrap();
    let routes = registry.rebuild().unwrap();
    assert_eq!(routes.len(), 1);
    assert_eq!(routes[0].binding_id, id(3));
    assert_eq!(registry.resolve_binding(&id(3)).unwrap(), routes[0]);
    assert!(matches!(
        registry.resolve_binding(&id(8)),
        Err(RegistryError::NotFound)
    ));
    let registrations = fs::read(home.path().join(".ariadne/projects.json")).unwrap();
    let index = fs::read(home.path().join(".ariadne/bindings.json")).unwrap();
    fs::rename(
        root.path().join(".ariadne"),
        root.path().join("unavailable"),
    )
    .unwrap();
    assert!(matches!(
        registry.rebuild(),
        Err(RegistryError::Unavailable { .. })
    ));
    assert!(matches!(
        registry.resolve_binding(&id(3)),
        Err(RegistryError::Unavailable { .. })
    ));
    assert_eq!(
        fs::read(home.path().join(".ariadne/projects.json")).unwrap(),
        registrations
    );
    assert_eq!(
        fs::read(home.path().join(".ariadne/bindings.json")).unwrap(),
        index
    );
}

#[test]
fn duplicate_selected_identity_stops_with_both_paths_and_opaque_tuple_delimiters_do_not_collide() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    registration(&registry, root.path(), 1);
    let store = Store::open_registered(root.path(), id(1)).unwrap();
    store.create(&blank(1, 2, 3, "same host")).unwrap();
    store.create(&blank(1, 20, 30, "same host")).unwrap();
    assert!(
        matches!(registry.rebuild(), Err(RegistryError::Conflict { paths }) if paths.len() == 2)
    );
    assert!(!home.path().join(".ariadne/bindings.json").exists());
    let actor = ReceiptActorScope::Owner {};
    let _: SavedReceipt = store
        .transact(
            &id(2),
            &actor,
            &id(80),
            &json!({"test":"tuple one"}),
            |session| {
                let b = session.bindings.0.get_mut(&id(3)).unwrap();
                b.adapter_id = "a:b".into();
                b.endpoint_fingerprint.0 = "c".into();
                Ok::<_, ()>(SavedReceiptData::SessionLifecycle {
                    state: session.state.clone(),
                    closed_at: session.closed_at.clone(),
                })
            },
        )
        .unwrap();
    store
        .transact(
            &id(20),
            &actor,
            &id(81),
            &json!({"test":"tuple two"}),
            |session| {
                let b = session.bindings.0.get_mut(&id(30)).unwrap();
                b.adapter_id = "a".into();
                b.endpoint_fingerprint.0 = "b:c".into();
                Ok::<_, ()>(SavedReceiptData::SessionLifecycle {
                    state: session.state.clone(),
                    closed_at: session.closed_at.clone(),
                })
            },
        )
        .unwrap();
    assert_eq!(registry.rebuild().unwrap().len(), 2);
}

#[test]
fn malformed_future_and_symlink_registry_or_index_are_never_replaced() {
    for name in ["projects.json", "bindings.json"] {
        for bytes in [
            b"not json".as_slice(),
            br#"{"schema_version":2}"#.as_slice(),
        ] {
            let home = tempfile::tempdir().unwrap();
            let registry = Registry::open(home.path()).unwrap();
            let path = home.path().join(".ariadne").join(name);
            write_private(&path, bytes);
            let result = if name == "projects.json" {
                registry.registered_projects().map(|_| ())
            } else {
                registry.rebuild().map(|_| ())
            };
            assert!(
                matches!(result, Err(RegistryError::InvalidData { path: reported, .. }) if reported == path.canonicalize().unwrap())
            );
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }
    let home = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    let foreign = home.path().join("foreign");
    write_private(&foreign, b"foreign bytes");
    symlink(&foreign, home.path().join(".ariadne/bindings.json")).unwrap();
    assert!(registry.rebuild().is_err());
    assert_eq!(fs::read(&foreign).unwrap(), b"foreign bytes");
}

#[test]
fn receipt_creation_is_first_commit_replayable_and_index_failure_is_uncertain_without_new_mutation()
{
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    registration(&registry, root.path(), 1);
    let session = blank(1, 2, 3, "host");
    let operation = id(100);
    let command = json!({"kind":"binding_connect","host":"host"});
    let data = SavedReceiptData::BindingConnect {
        binding_id: id(3),
        generation: id(4),
        capabilities: session.bindings.0[&id(3)].capabilities.clone(),
        setup_instruction: "Explicit binding instruction".into(),
    };
    let store = Store::open_registered(root.path(), id(1)).unwrap();
    let receipt = store
        .create_with_receipt(
            &session,
            &ReceiptActorScope::Owner {},
            &operation,
            &command,
            data.clone(),
        )
        .unwrap();
    assert_eq!(receipt.revision.value(), 1);
    assert!(!root
        .path()
        .join(format!(".ariadne/backups/{}.previous.json", id(2).as_str()))
        .exists());
    let bytes = fs::read(
        root.path()
            .join(format!(".ariadne/sessions/{}.json", id(2).as_str())),
    )
    .unwrap();
    write_private(
        &home.path().join(".ariadne/bindings.json"),
        b"invalid index",
    );
    assert!(
        matches!(registry.with_binding_setup(|setup| setup.synchronize(&operation)), Err(RegistryError::CommitUncertain { operation_id, .. }) if operation_id == operation)
    );
    assert_eq!(
        store
            .create_with_receipt(
                &session,
                &ReceiptActorScope::Owner {},
                &operation,
                &command,
                data
            )
            .unwrap(),
        receipt
    );
    fs::remove_file(home.path().join(".ariadne/bindings.json")).unwrap();
    registry
        .with_binding_setup(|setup| {
            setup.with_store(&id(1), |store| {
                assert_eq!(
                    store.replay(&id(2), &ReceiptActorScope::Owner {}, &operation, &command)?,
                    Some(receipt)
                );
                Ok::<_, RegistryError>(())
            })?;
            setup.synchronize(&operation)
        })
        .unwrap();
    assert_eq!(
        fs::read(
            root.path()
                .join(format!(".ariadne/sessions/{}.json", id(2).as_str()))
        )
        .unwrap(),
        bytes
    );
}

struct Writer(Child);
impl Drop for Writer {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn writer(home: &std::path::Path, root: &std::path::Path, number: u64, marker: &str) -> Writer {
    Writer(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "registration_writer_subprocess", "--nocapture"])
            .env("ARIADNE_REGISTRY_TEST_HOME", home)
            .env("ARIADNE_REGISTRY_TEST_ROOT", root)
            .env("ARIADNE_REGISTRY_TEST_NUMBER", number.to_string())
            .env("ARIADNE_REGISTRY_TEST_MARKER", marker)
            .spawn()
            .unwrap(),
    )
}
#[test]
fn registration_writer_subprocess() {
    let Some(home) = std::env::var_os("ARIADNE_REGISTRY_TEST_HOME") else {
        return;
    };
    let root = std::env::var_os("ARIADNE_REGISTRY_TEST_ROOT").unwrap();
    let number: u64 = std::env::var("ARIADNE_REGISTRY_TEST_NUMBER")
        .unwrap()
        .parse()
        .unwrap();
    let marker = std::env::var("ARIADNE_REGISTRY_TEST_MARKER").unwrap();
    let home = std::path::PathBuf::from(home);
    let registry = Registry::open(&home).unwrap();
    fs::write(home.join(format!("ready-{marker}")), b"ready").unwrap();
    let start = Instant::now();
    while !home.join("start").exists() {
        assert!(start.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(10));
    }
    registration(&registry, std::path::Path::new(&root), number);
}
#[test]
fn separate_process_registration_reuses_project_identity_and_keeps_both_operation_receipts() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let mut one = writer(home.path(), root.path(), 1, "one");
    let mut two = writer(home.path(), root.path(), 2, "two");
    let start = Instant::now();
    while !home.path().join("ready-one").exists() || !home.path().join("ready-two").exists() {
        assert!(
            one.0.try_wait().unwrap().is_none(),
            "first registry writer exited before readiness"
        );
        assert!(
            two.0.try_wait().unwrap().is_none(),
            "second registry writer exited before readiness"
        );
        assert!(start.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(10));
    }
    fs::write(home.path().join("start"), b"start").unwrap();
    assert!(one.0.wait().unwrap().success());
    assert!(two.0.wait().unwrap().success());
    let registry = Registry::open(home.path()).unwrap();
    assert_eq!(registry.registered_projects().unwrap().len(), 1);
    for number in [1, 2] {
        let replay = registry
            .register(root.path(), &id(number + 1000), || {
                panic!("saved registration")
            })
            .unwrap();
        assert_eq!(
            replay.project_id,
            registry.registered_projects().unwrap()[0].project_id
        );
    }
}

#[test]
fn explicit_data_setup_creates_only_missing_private_final_component_and_never_repairs_paths() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let parent = tempfile::tempdir().unwrap();
    let data = parent.path().join("custom-data");
    assert!(Registry::open_data_directory(&data).is_err());
    assert!(!data.exists());
    Registry::create_data_directory(&data).unwrap();
    assert_eq!(
        fs::metadata(&data).unwrap().permissions().mode() & 0o777,
        0o700
    );
    Registry::open_data_directory(&data).unwrap();
    let file = parent.path().join("existing-file");
    fs::write(&file, b"preserve").unwrap();
    assert!(Registry::create_data_directory(&file).is_err());
    assert_eq!(fs::read(&file).unwrap(), b"preserve");
    let link = parent.path().join("link");
    symlink(&data, &link).unwrap();
    assert!(Registry::create_data_directory(&link).is_err());
    assert!(fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    fs::set_permissions(&data, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(Registry::create_data_directory(&data).is_err());
    assert_eq!(
        fs::metadata(&data).unwrap().permissions().mode() & 0o777,
        0o755
    );
    let nested = parent.path().join("missing-parent/data");
    assert!(Registry::create_data_directory(&nested).is_err());
    assert!(!nested.parent().unwrap().exists());
}
