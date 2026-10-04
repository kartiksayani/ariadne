mod pending;

use crate::commands::DesktopService;
use ariadne_core::{CoreError, CoreErrorCode, OpenRoute};
use pending::PendingRoute;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

#[derive(Clone, Default)]
pub struct NativeRoutes {
    pending: Arc<Mutex<PendingRoute>>,
}
fn unavailable() -> CoreError {
    CoreError::new(
        CoreErrorCode::IoError,
        "Native window routing is unavailable.",
        "Keep the registered route and reopen Ariadne.",
    )
}
fn main_window(label: &str) -> Result<(), CoreError> {
    if label == "main" {
        Ok(())
    } else {
        Err(CoreError::new(
            CoreErrorCode::PermissionDenied,
            "Only the main webview may acknowledge route readiness.",
            "Subscribe to registered routes in the main Ariadne window.",
        ))
    }
}
impl NativeRoutes {
    /// Native callers provide explicit IDs, never paths or model-chosen scope.
    pub async fn open<R: tauri::Runtime>(
        &self,
        app: tauri::AppHandle<R>,
        route: OpenRoute,
    ) -> Result<(), CoreError> {
        let ticket = self.pending.lock().map_err(|_| unavailable())?.begin()?;
        let service = app.state::<DesktopService>().inner().clone();
        let checked = route.clone();
        tauri::async_runtime::spawn_blocking(move || service.resolve_open_route(&checked))
            .await
            .map_err(|_| unavailable())??;
        self.pending
            .lock()
            .map_err(|_| unavailable())?
            .validated(ticket, route);
        self.flush(&app)
    }
    fn flush<R: tauri::Runtime>(&self, app: &tauri::AppHandle<R>) -> Result<(), CoreError> {
        let pending = self.pending.clone();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let Ok(mut pending) = pending.lock() else {
                return;
            };
            let Some((ticket, route)) = pending.current() else {
                return;
            };
            let Some(window) = handle.get_webview_window("main") else {
                return;
            };
            // UI failures preserve the pending navigation intent for reconcile.
            if window.show().is_ok()
                && window.unminimize().is_ok()
                && window.set_focus().is_ok()
                && window.emit("ariadne://route", route).is_ok()
            {
                pending.delivered(ticket);
            }
        })
        .map_err(|_| unavailable())
    }
}

#[tauri::command]
pub fn route_ready<R: tauri::Runtime>(window: tauri::WebviewWindow<R>) -> Result<(), CoreError> {
    main_window(window.label())?;
    let app = window.app_handle();
    let state = app.state::<NativeRoutes>();
    state
        .pending
        .lock()
        .map_err(|_| unavailable())?
        .set_ready(true);
    state.flush(app)
}

#[cfg(test)]
#[path = "tests/readiness.rs"]
mod tests;
