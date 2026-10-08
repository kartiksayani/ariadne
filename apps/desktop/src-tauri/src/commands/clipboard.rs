//! Writes owner-selected message text directly to the system clipboard.
use ariadne_core::{CoreError, CoreErrorCode};

fn unavailable() -> CoreError {
    CoreError::new(
        CoreErrorCode::IoError,
        "The message could not be copied.",
        "Try copying the message again.",
    )
}

#[tauri::command]
pub fn clipboard_write(text: String) -> Result<(), CoreError> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
        use objc2_foundation::NSString;

        let clipboard = NSPasteboard::generalPasteboard();
        clipboard.clearContents();
        // AppKit's constant names the plain-text pasteboard format. NSString
        // preserves the source text, including Unicode and line breaks.
        if clipboard.setString_forType(&NSString::from_str(&text), unsafe {
            NSPasteboardTypeString
        }) {
            Ok(())
        } else {
            Err(unavailable())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
        Err(unavailable())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn desktop_handler_registers_clipboard_write_and_requires_a_string() {
        use serde_json::json;
        use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets};

        let app = mock_builder()
            .invoke_handler(crate::desktop_handler())
            .build(mock_context(noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        // These requests never write to the owner's clipboard. Their argument
        // errors prove the real handler routes the name to this command.
        for body in [json!({}), json!({"text": 42})] {
            let error = get_ipc_response(
                &window,
                tauri::webview::InvokeRequest {
                    cmd: "clipboard_write".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            )
            .unwrap_err();
            let error = error.as_str().unwrap();
            assert!(error.contains("text"), "{error}");
            assert!(!error.contains("not found"), "{error}");
        }
    }
}
