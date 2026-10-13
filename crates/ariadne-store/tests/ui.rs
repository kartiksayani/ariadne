use ariadne_domain::models::UuidV4;
use ariadne_store::{registry::Registry, session::StoreError};
use std::{fs, os::unix::fs::PermissionsExt};

#[test]
fn first_ui_publication_preserves_an_ordinary_restore_after_locked_absence() {
    let home = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    let path = home.path().join(".ariadne/ui.json");
    let result = registry.with_ui_file(|file| {
        assert!(file.bytes().is_none());
        fs::write(&path, b"restored owner draft bytes").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        file.publish(
            b"new candidate",
            &UuidV4::new("00000000-0000-4000-8000-000000000001").unwrap(),
        )
    });
    assert!(matches!(result, Err(StoreError::AlreadyExists)));
    assert_eq!(fs::read(&path).unwrap(), b"restored owner draft bytes");
    assert!(!home.path().join(".ariadne/ui.previous.json").exists());
    assert_eq!(
        fs::read_dir(home.path().join(".ariadne")).unwrap().count(),
        3
    );
}

#[test]
fn stable_ui_lock_has_a_bounded_wait_without_changing_data() {
    let home = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    let second = Registry::open(home.path()).unwrap();
    registry
        .with_ui_file(|file| {
            assert!(file.bytes().is_none());
            let start = std::time::Instant::now();
            let result =
                std::thread::spawn(move || second.with_ui_file(|_| Ok::<_, StoreError>(())))
                    .join()
                    .unwrap();
            assert!(matches!(result, Err(StoreError::Busy)));
            assert!(start.elapsed() < std::time::Duration::from_secs(3));
            Ok::<_, StoreError>(())
        })
        .unwrap();
    assert!(!home.path().join(".ariadne/ui.json").exists());
}

#[test]
fn recovery_companion_shares_ui_lock_and_publishes_private_fixed_files() {
    let home = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    let second = Registry::open(home.path()).unwrap();
    let operation = UuidV4::new("00000000-0000-4000-8000-000000000001").unwrap();
    registry
        .with_ui_file(|mut file| {
            assert!(file.recovery_bytes().is_none());
            file.publish_recovery(b"ledger one", &operation)?;
            assert_eq!(file.recovery_bytes(), Some(b"ledger one".as_slice()));
            let result =
                std::thread::spawn(move || second.with_ui_file(|_| Ok::<_, StoreError>(())))
                    .join()
                    .unwrap();
            assert!(matches!(result, Err(StoreError::Busy)));
            file.publish_current(b"main one", &operation)?;
            file.publish_current(b"main two", &operation)?;
            file.publish_recovery(b"ledger two", &operation)?;
            file.confirm_recovery(&operation)
        })
        .unwrap();
    let root = home.path().join(".ariadne");
    assert_eq!(fs::read(root.join("ui.json")).unwrap(), b"main two");
    assert_eq!(
        fs::read(root.join("ui.previous.json")).unwrap(),
        b"main one"
    );
    assert_eq!(
        fs::read(root.join("ui-recovery.json")).unwrap(),
        b"ledger two"
    );
    for name in ["ui.json", "ui.previous.json", "ui-recovery.json", "ui.lock"] {
        assert_eq!(
            fs::metadata(root.join(name)).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn recovery_companion_does_not_follow_links_or_replace_a_restore_after_absence() {
    let home = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    let root = home.path().join(".ariadne");
    let outside = home.path().join("preserved");
    fs::write(&outside, b"owner bytes").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("ui-recovery.json")).unwrap();
    assert!(registry.with_ui_file(|_| Ok::<_, StoreError>(())).is_err());
    assert_eq!(fs::read(&outside).unwrap(), b"owner bytes");
    fs::remove_file(root.join("ui-recovery.json")).unwrap();
    let operation = UuidV4::new("00000000-0000-4000-8000-000000000001").unwrap();
    let result = registry.with_ui_file(|mut file| {
        fs::write(root.join("ui-recovery.json"), b"restored ledger").unwrap();
        fs::set_permissions(
            root.join("ui-recovery.json"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        file.publish_recovery(b"candidate", &operation)
    });
    assert!(matches!(result, Err(StoreError::AlreadyExists)));
    assert_eq!(
        fs::read(root.join("ui-recovery.json")).unwrap(),
        b"restored ledger"
    );
    assert!(!root.join("ui.json").exists());
}
