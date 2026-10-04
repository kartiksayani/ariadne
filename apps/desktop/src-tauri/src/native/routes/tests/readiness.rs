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
    let error: CoreError = result.unwrap_err().deserialize().unwrap();
    assert_eq!(error.code, CoreErrorCode::PermissionDenied);
    assert!(!error.retryable);
    let routes = app.state::<NativeRoutes>();
    assert!(routes.pending.lock().unwrap().current().is_none());
}
