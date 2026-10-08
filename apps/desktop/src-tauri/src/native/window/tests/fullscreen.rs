use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn the_exit_continuation_runs_once_whichever_path_reaches_it_first() {
    let runs = Arc::new(AtomicUsize::new(0));
    let counted = runs.clone();
    let once = Once::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
    });
    // The did-exit notification, a later re-exit post and the timeout.
    let (notification, timeout) = (once.clone(), once.clone());
    notification.run();
    notification.run();
    timeout.run();
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}

#[test]
fn a_windowed_window_continues_at_once() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let runs = Arc::new(AtomicUsize::new(0));
    let counted = runs.clone();
    leave_then(&window.as_ref().window(), move || {
        counted.fetch_add(1, Ordering::SeqCst);
    });
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}
