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
