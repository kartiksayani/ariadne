mod launch;
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
    pub(crate) fn webview_loading(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.set_ready(false);
        }
    }
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
            if crate::native::window::present(&window).is_ok()
                && window.emit("ariadne://route", route).is_ok()
            {
                pending.delivered(ticket);
            }
        })
        .map_err(|_| unavailable())
    }
}

/// The first plugin intercepts second launches before any owning startup code.
pub(crate) fn receive_launch<R: tauri::Runtime>(app: tauri::AppHandle<R>, args: Vec<String>) {
    if open_launch_route(&app, &args) == Some(false) {
        show_main_window(&app);
    }
}

/// The app's own launch arguments. Only a route is opened here: the first
/// show waits for the saved window size (`NativeWindow::launch`), and the
/// route waits for that show (`window_shown`).
pub(crate) fn receive_startup<R: tauri::Runtime>(app: tauri::AppHandle<R>, args: Vec<String>) {
    if let Ok(mut pending) = app.state::<NativeRoutes>().pending.lock() {
        pending.hold_until_shown();
    }
    open_launch_route(&app, &args);
}

/// Called once by every path that first shows the main window (including
/// the launch fallback). Releases a held startup route.
pub(crate) fn window_shown<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let routes = app.state::<NativeRoutes>();
    match routes.pending.lock() {
        Ok(mut pending) => pending.shown(),
        Err(_) => return,
    }
    if routes.flush(app).is_err() {
        eprintln!("Ariadne could not open the requested registered route.");
    }
}

/// Opens a route named in `args`. Returns whether there was one, or None for
/// arguments that are not a valid route.
fn open_launch_route<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    args: &[String],
) -> Option<bool> {
    let app = app.clone();
    match launch::parse(args) {
        Ok(Some(route)) => {
            tauri::async_runtime::spawn(async move {
                let routes = app.state::<NativeRoutes>().inner().clone();
                if routes.open(app, route).await.is_err() {
                    // Do not print untrusted argv or registered owner content.
                    eprintln!("Ariadne could not open the requested registered route.");
                }
            });
            Some(true)
        }
        Ok(None) => Some(false),
        Err(_) => {
            eprintln!("Ariadne rejected invalid native route arguments.");
            None
        }
    }
}

/// Used by ordinary second launches and macOS Dock reopen. This deliberately
/// leaves pending routes, webview readiness and renderer selection untouched.
fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            let _ = crate::native::window::present(&window);
        }
    });
}

#[cfg(target_os = "macos")]
pub(crate) fn reopen<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    show_main_window(app);
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
