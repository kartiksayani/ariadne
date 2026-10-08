use super::*;

#[test]
fn only_main_webview_can_release_pending_registered_routes() {
    assert!(main_window("main").is_ok());
    for label in ["", "secondary", "Main"] {
        let error = main_window(label).unwrap_err();
        assert_eq!(error.code, CoreErrorCode::PermissionDenied);
        assert!(!error.retryable);
    }
}

#[test]
fn actual_route_ready_ipc_rejects_other_windows_without_releasing_the_route() {
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets};
    let app = mock_builder()
        .manage(NativeRoutes::default())
        .invoke_handler(crate::desktop_handler())
        .build(mock_context(noop_assets()))
        .unwrap();
    {
        let routes = app.state::<NativeRoutes>();
        let mut pending = routes.pending.lock().unwrap();
        let ticket = pending.begin().unwrap();
        pending.validated(
            ticket,
            serde_json::from_value(serde_json::json!({
                "project_id":"00000000-0000-4000-8000-000000000001",
                "session_id":"00000000-0000-4000-8000-000000000002",
                "item_id":null
            }))
            .unwrap(),
        );
    }
    let window = tauri::WebviewWindowBuilder::new(&app, "secondary", Default::default())
        .build()
        .unwrap();
    let result = get_ipc_response(
        &window,
        tauri::webview::InvokeRequest {
            cmd: "route_ready".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    );
    let error: CoreError = serde_json::from_value(result.unwrap_err()).unwrap();
    assert_eq!(error.code, CoreErrorCode::PermissionDenied);
    assert!(!error.retryable);
    let routes = app.state::<NativeRoutes>();
    assert!(routes.pending.lock().unwrap().current().is_none());
}

#[test]
fn a_startup_route_waits_for_the_first_show_and_the_launch_fallback_delivers_it() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tauri::Listener;
    let app = tauri::test::mock_builder()
        .manage(NativeRoutes::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let delivered = Arc::new(AtomicUsize::new(0));
    let counted = delivered.clone();
    window.listen("ariadne://route", move |_| {
        counted.fetch_add(1, Ordering::SeqCst);
    });
    let route: OpenRoute = serde_json::from_value(serde_json::json!({
        "project_id":"00000000-0000-4000-8000-000000000001",
        "session_id":"00000000-0000-4000-8000-000000000002",
        "item_id":"2.1"
    }))
    .unwrap();
    // Startup with no route in argv still holds; the route arrives and the
    // webview is ready before the saved size is restored.
    receive_startup(app.handle().clone(), vec!["ariadne".into()]);
    let routes = app.state::<NativeRoutes>();
    {
        let mut pending = routes.pending.lock().unwrap();
        let ticket = pending.begin().unwrap();
        pending.validated(ticket, route);
        pending.set_ready(true);
    }
    routes.flush(app.handle()).unwrap();
    assert_eq!(
        delivered.load(Ordering::SeqCst),
        0,
        "the route must not show the window early"
    );
    assert!(routes.pending.lock().unwrap().current().is_none());
    // The preference read never finishes: the fallback's first show releases it.
    let show = crate::native::window::first_show();
    crate::native::window::show_after(
        app.handle().clone(),
        show.clone(),
        std::time::Duration::from_millis(10),
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while delivered.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert_eq!(delivered.load(Ordering::SeqCst), 1);
    assert!(routes.pending.lock().unwrap().current().is_none());
    // A late normal show runs once only and has nothing left to deliver.
    show(app.handle());
    assert_eq!(delivered.load(Ordering::SeqCst), 1);
}

#[test]
#[cfg(target_os = "macos")]
fn dock_reopen_reveal_preserves_registered_route_and_readiness() {
    let app = tauri::test::mock_builder()
        .manage(NativeRoutes::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let _window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let route: OpenRoute = serde_json::from_value(serde_json::json!({
        "project_id":"00000000-0000-4000-8000-000000000001",
        "session_id":"00000000-0000-4000-8000-000000000002",
        "item_id":"2.1"
    }))
    .unwrap();
    let routes = app.state::<NativeRoutes>();
    let ticket = {
        let mut pending = routes.pending.lock().unwrap();
        let ticket = pending.begin().unwrap();
        pending.validated(ticket, route.clone());
        pending.set_ready(true);
        ticket
    };
    // Tauri's non-exhaustive Reopen is matched by the actual run handler. This
    // exercises its same reveal helper; the mock runtime's OS window methods
    // are no-ops, so actual hidden/minimized visibility remains packaged proof.
    reopen(app.handle());
    reopen(app.handle());
    assert_eq!(
        routes.pending.lock().unwrap().current(),
        Some((ticket, route))
    );
}
