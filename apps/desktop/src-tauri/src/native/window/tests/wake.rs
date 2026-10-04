use super::*;
use objc2_foundation::NSString;
use std::sync::atomic::AtomicUsize;

#[test]
fn exact_workspace_did_wake_notification_only_and_drop_removes_observer() {
    let calls = Arc::new(AtomicUsize::new(0));
    objc2::rc::autoreleasepool(|_| {
        let center = NSNotificationCenter::new();
        let notified = calls.clone();
        let observer = WakeObserver::with_center(center.clone(), move || {
            notified.fetch_add(1, Ordering::SeqCst);
        });
        // A process-local isolated center exercises real Foundation delivery
        // without generating a system wake or invoking another app's observers.
        unsafe {
            center.postNotificationName_object(&NSString::from_str("ariadne-unrelated"), None);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        unsafe {
            center.postNotificationName_object(NSWorkspaceDidWakeNotification, None);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let active = observer.active.clone();
        drop(observer);
        assert!(!active.load(Ordering::Acquire));
        unsafe {
            center.postNotificationName_object(NSWorkspaceDidWakeNotification, None);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    });
    assert_eq!(
        Arc::strong_count(&calls),
        1,
        "the observer must release its callback"
    );
}

#[test]
fn workspace_delivery_schedules_trusted_reconciliation_off_posting_thread_and_coalesces() {
    use crate::{
        commands::DesktopService,
        native::window::{lifecycle::NativeLifecycle, NativeWindow},
    };
    use std::{sync::mpsc, thread, time::Duration};
    let posting_thread = thread::current().id();
    let (entered, observed) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let wait = std::sync::Mutex::new(wait);
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let app = tauri::test::mock_builder()
        .manage(DesktopService::default())
        .manage(NativeWindow::default())
        .manage(NativeLifecycle::from_trusted_owner(
            || Ok(()),
            move || {
                counted.fetch_add(1, Ordering::SeqCst);
                entered.send(thread::current().id()).unwrap();
                wait.lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
                Ok(())
            },
        ))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let handle = app.handle().clone();
    let quitting = Arc::new(AtomicBool::new(false));
    let waking = Arc::new(AtomicBool::new(false));
    let wake_quitting = quitting.clone();
    let wake_active = waking.clone();
    let center = NSNotificationCenter::new();
    let observer = WakeObserver::with_center(center.clone(), move || {
        crate::reconcile_after_wake(handle.clone(), wake_quitting.clone(), wake_active.clone());
    });
    unsafe {
        center.postNotificationName_object(NSWorkspaceDidWakeNotification, None);
    }
    let callback_thread = observed.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_ne!(
        callback_thread, posting_thread,
        "the synchronous owner must not run on the notification/UI thread"
    );
    unsafe {
        center.postNotificationName_object(NSWorkspaceDidWakeNotification, None);
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "a running reconciliation coalesces further wake notifications"
    );
    drop(observer);
    unsafe {
        center.postNotificationName_object(NSWorkspaceDidWakeNotification, None);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    release.send(()).unwrap();
}

#[test]
fn shutdown_admission_suppresses_workspace_reconciliation() {
    use crate::native::window::lifecycle::NativeLifecycle;
    let app = tauri::test::mock_builder()
        .manage(NativeLifecycle::from_trusted_owner(
            || Ok(()),
            || panic!("must not reconcile while quitting"),
        ))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    crate::reconcile_after_wake(
        app.handle().clone(),
        Arc::new(AtomicBool::new(true)),
        Arc::new(AtomicBool::new(false)),
    );
}
