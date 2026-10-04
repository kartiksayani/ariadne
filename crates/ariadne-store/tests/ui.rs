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
