use super::*;
#[cfg(feature = "e2e")]
use std::os::unix::fs::symlink;

fn request(nonce: &str, payload: &str) -> PingRequest {
    PingRequest {
        nonce: nonce.into(),
        payload: payload.into(),
    }
}

#[test]
fn ordinary_receipts_use_private_owned_storage_and_cleanup() {
    let (state, owner) = PingState::ordinary().unwrap();
    let root = state.root.clone();
    assert_eq!(
        fs::metadata(&root).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert!(state.expected.is_none());
    let first = state
        .ping(request(&"a".repeat(64), "temporary diagnostic"))
        .unwrap();
    let disk: PingReceipt =
        serde_json::from_slice(&fs::read(root.join("smoke/receipt.json")).unwrap()).unwrap();
    assert_eq!(first, disk);
    assert_eq!(first.pid, std::process::id());
    assert_ne!(
        first.receipt_id,
        state
            .ping(request(&"b".repeat(64), "next"))
            .unwrap()
            .receipt_id
    );
    drop(state);
    assert_eq!(complete_run(Some(owner), 7), 7);
    assert!(!root.exists());
}

#[test]
fn request_validation_and_io_errors_never_claim_a_receipt() {
    let (state, _owner) = PingState::ordinary().unwrap();
    for nonce in ["", "abc", &"z".repeat(64)] {
        assert_eq!(
            state.ping(request(nonce, "ok")).unwrap_err().code,
            ErrorCode::InvalidNonce
        );
    }
    for payload in ["", "line\nfeed", &"é".repeat(65)] {
        assert_eq!(
            state
                .ping(request(&"0".repeat(64), payload))
                .unwrap_err()
                .code,
            ErrorCode::InvalidPayload
        );
    }
    assert!(!state.root.join("smoke").exists());
    fs::write(state.root.join("smoke"), b"obstruction").unwrap();
    assert_eq!(
        state.ping(request(&"0".repeat(64), "ok")).unwrap_err().code,
        ErrorCode::Io
    );
    assert_eq!(
        serde_json::to_string(&CommandError {
            code: ErrorCode::Io
        })
        .unwrap(),
        r#"{"code":"io"}"#
    );
}

#[test]
#[cfg(feature = "e2e")]
fn isolated_startup_nonce_and_rejected_request_preserve_disk_bytes() {
    let root = tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .prefix("ariadne-e2e-")
        .tempdir_in("/private/tmp")
        .unwrap();
    let nonce = "1".repeat(64);
    let state = PingState::isolated(root.path().to_path_buf(), nonce.clone()).unwrap();
    let startup: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join("startup.json")).unwrap()).unwrap();
    assert_eq!(startup["nonce"], nonce);
    assert_eq!(startup["pid"], std::process::id());
    state.ping(request(&nonce, "native diagnostic")).unwrap();
    let file = root.path().join("smoke/receipt.json");
    let bytes = fs::read(&file).unwrap();
    assert_eq!(
        state
            .ping(request(&"2".repeat(64), "wrong"))
            .unwrap_err()
            .code,
        ErrorCode::NonceMismatch
    );
    assert_eq!(fs::read(file).unwrap(), bytes);
    assert_eq!(fs::read_dir(root.path().join("smoke")).unwrap().count(), 1);
}

#[test]
#[cfg(feature = "e2e")]
fn isolated_startup_rejects_aliases_modes_missing_roots_and_bad_nonce() {
    let root = tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .prefix("ariadne-e2e-")
        .tempdir_in("/private/tmp")
        .unwrap();
    let nonce = "a".repeat(64);
    assert!(PingState::isolated(root.path().into(), "bad".into()).is_err());
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(PingState::isolated(root.path().into(), nonce.clone()).is_err());
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let alias = root.path().join("alias");
    symlink(root.path(), &alias).unwrap();
    assert!(PingState::isolated(alias, nonce.clone()).is_err());
    assert!(PingState::isolated(root.path().join("missing"), nonce).is_err());
    assert!(!root.path().join("startup.json").exists());
    fs::create_dir(root.path().join("startup.json")).unwrap();
    assert!(PingState::isolated(root.path().into(), "a".repeat(64)).is_err());
}

#[test]
#[cfg(feature = "e2e")]
fn process_environment_requires_both_values_and_writes_real_startup() {
    let root = tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .prefix("ariadne-e2e-")
        .tempdir_in("/private/tmp")
        .unwrap();
    let previous =
        ["ARIADNE_E2E_ROOT", "ARIADNE_E2E_NONCE"].map(|key| (key, std::env::var_os(key)));
    std::env::remove_var("ARIADNE_E2E_ROOT");
    std::env::remove_var("ARIADNE_E2E_NONCE");
    assert!(PingState::environment().is_err());
    assert!(std::panic::catch_unwind(run).is_err());
    std::env::set_var("ARIADNE_E2E_ROOT", root.path());
    assert!(PingState::environment().is_err());
    assert!(std::panic::catch_unwind(run).is_err());
    std::env::set_var("ARIADNE_E2E_NONCE", "a".repeat(64));
    assert!(PingState::environment().is_ok());
    assert!(root.path().join("startup.json").is_file());
    for (key, value) in previous {
        if let Some(value) = value {
            std::env::set_var(key, value);
        } else {
            std::env::remove_var(key);
        }
    }
}

#[test]
fn trusted_setup_failure_aborts_before_installing_lifecycle_authority() {
    use ariadne_core::{CoreError, CoreErrorCode};
    use native::window::lifecycle::NativeLifecycle;
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let error = establish_lifecycle(app.handle(), |_| {
        Err(CoreError::new(
            CoreErrorCode::StoreBusy,
            "Native control is already owned.",
            "Keep the existing owner; this startup cannot start supervisors.",
        ))
    })
    .unwrap_err();
    assert_eq!(error.code, CoreErrorCode::StoreBusy);
    assert!(app.try_state::<NativeLifecycle>().is_none());
}

#[test]
fn trusted_setup_installs_the_returned_owner_once_without_running_shutdown() {
    use native::window::lifecycle::NativeLifecycle;
    use std::sync::atomic::AtomicUsize;
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let shutdown = Arc::new(AtomicUsize::new(0));
    let calls = shutdown.clone();
    // Move-only captured state demonstrates the startup FnOnce composition.
    let startup = Box::new(7);
    establish_lifecycle(app.handle(), move |_| {
        assert_eq!(*startup, 7);
        Ok(NativeLifecycle::from_trusted_owner(
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
            || Ok(()),
        ))
    })
    .unwrap();
    assert_eq!(shutdown.load(Ordering::SeqCst), 0);
    let lifecycle = app.state::<NativeLifecycle>();
    lifecycle.prepare_exit().unwrap();
    lifecycle.prepare_exit().unwrap();
    assert_eq!(shutdown.load(Ordering::SeqCst), 1);
}
