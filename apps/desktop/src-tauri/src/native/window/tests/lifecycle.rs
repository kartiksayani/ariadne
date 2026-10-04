use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn absent_composition_cannot_claim_shutdown_or_wake_reconciliation() {
    let lifecycle = NativeLifecycle::default();
    for result in [lifecycle.shutdown(), lifecycle.reconcile()] {
        let error = result.unwrap_err();
        assert_eq!(error.code, CoreErrorCode::Unsupported);
        assert!(!error.retryable);
    }
}

#[test]
fn successful_owned_shutdown_runs_once_and_prevents_later_reconciliation() {
    let shutdown = Arc::new(AtomicUsize::new(0));
    let reconcile = Arc::new(AtomicUsize::new(0));
    let stopped = shutdown.clone();
    let woken = reconcile.clone();
    let lifecycle = NativeLifecycle::from_trusted_owner(
        move || {
            stopped.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
        move || {
            woken.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
    );
    lifecycle.reconcile().unwrap();
    lifecycle.shutdown().unwrap();
    lifecycle.clone().shutdown().unwrap();
    assert_eq!(
        lifecycle.reconcile().unwrap_err().code,
        CoreErrorCode::Unsupported
    );
    assert_eq!(shutdown.load(Ordering::SeqCst), 1);
    assert_eq!(reconcile.load(Ordering::SeqCst), 1);
}

#[test]
fn failed_shutdown_is_not_reported_as_complete() {
    let calls = Arc::new(AtomicUsize::new(0));
    let callback_calls = calls.clone();
    let lifecycle = NativeLifecycle::from_trusted_owner(
        move || {
            if callback_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                Err(CoreError::new(
                    CoreErrorCode::IoError,
                    "An owned worker has not joined.",
                    "Keep the owning app and reconcile shutdown.",
                ))
            } else {
                Ok(())
            }
        },
        || Ok(()),
    );
    assert_eq!(
        lifecycle.shutdown().unwrap_err().code,
        CoreErrorCode::IoError
    );
    lifecycle.shutdown().unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}
