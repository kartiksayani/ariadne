use super::{
    geometry::{MinimumSize, WorkArea},
    preferences::WindowPreferenceWrite,
};
use crate::commands::DesktopService;
use ariadne_core::{CoreError, CoreErrorCode, WindowGeometry};
use ariadne_domain::models::UuidV4;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::Manager;

#[derive(Clone, Default)]
pub struct NativeWindow {
    writer: Arc<Mutex<WindowPreferenceWrite>>,
    latest_geometry: Arc<Mutex<Option<WindowGeometry>>>,
    writing: Arc<AtomicBool>,
    worker: Arc<Mutex<Option<std::thread::JoinHandle<()>>>>,
    worker_failed: Arc<AtomicBool>,
    applied_revision: Arc<AtomicU64>,
    movement: Arc<AtomicU64>,
    stopped: Arc<AtomicBool>,
}
type AfterReconcile<R> = Box<dyn FnOnce(&tauri::AppHandle<R>) + Send>;
/// How long launch waits for the saved size before showing the window anyway.
const LAUNCH_FALLBACK: std::time::Duration = std::time::Duration::from_secs(3);
fn unavailable() -> CoreError {
    CoreError::new(
        CoreErrorCode::IoError,
        "Native window geometry is unavailable.",
        "Keep the current window and reconcile its displays after wake.",
    )
}
fn monitor_id(monitor: &tauri::Monitor) -> String {
    format!(
        "{}@{},{}",
        monitor.name().map_or("display", String::as_str),
        monitor.position().x,
        monitor.position().y
    )
}
fn geometry<R: tauri::Runtime>(window: &tauri::Window<R>) -> Result<WindowGeometry, CoreError> {
    let scale = window.scale_factor().map_err(|_| unavailable())?;
    if !scale.is_finite() || scale <= 0.0 {
        return Err(unavailable());
    }
    let position = window.outer_position().map_err(|_| unavailable())?;
    let size = window.outer_size().map_err(|_| unavailable())?;
    Ok(WindowGeometry {
        x: f64::from(position.x) / scale,
        y: f64::from(position.y) / scale,
        width: f64::from(size.width) / scale,
        height: f64::from(size.height) / scale,
        monitor_id: window
            .current_monitor()
            .map_err(|_| unavailable())?
            .as_ref()
            .map(monitor_id),
    })
}
/// The configured minimum content size of the main window (tauri.conf.json).
fn content_minimum<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> MinimumSize {
    window
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == window.label())
        .map(|config| MinimumSize {
            width: config.min_width.unwrap_or(0.0),
            height: config.min_height.unwrap_or(0.0),
        })
        .unwrap_or_default()
}
/// Whether the window's current frame is a resting size worth saving: not the
/// full-screen Space, a minimized or hidden window, or a size mid-transition.
fn resting<R: tauri::Runtime>(window: &tauri::Window<R>) -> bool {
    window.is_visible().unwrap_or(false)
        && !window.is_minimized().unwrap_or(true)
        && !window.is_fullscreen().unwrap_or(true)
}
/// Brings the main window forward with keyboard focus inside the webview, so
/// shortcuts work without a click first.
pub(crate) fn present<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> tauri::Result<()> {
    window.show()?;
    window.unminimize()?;
    window.set_focus()?;
    focus_webview(window);
    Ok(())
}
/// Makes the webview the window's first responder. A failure leaves focus
/// where it was; the renderer still handles keys at window level.
pub(crate) fn focus_webview<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let webview: &tauri::Webview<R> = window.as_ref();
    let _ = webview.set_focus();
}
/// The window's first show, run once by whichever launch path gets there
/// first. It always releases a held startup route, even if the window
/// could not be shown, so the route can still present it.
pub(crate) fn first_show<R: tauri::Runtime>(
) -> impl Fn(&tauri::AppHandle<R>) + Clone + Send + 'static {
    let shown = Arc::new(AtomicBool::new(false));
    move |app: &tauri::AppHandle<R>| {
        if shown.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(window) = app.get_webview_window("main") {
            if present(&window).is_err() {
                eprintln!("Ariadne could not show its main window.");
            }
        }
        crate::native::routes::window_shown(app);
    }
}
/// The launch fallback: shows the window after `delay` even if the saved
/// preferences never arrive.
pub(crate) fn show_after<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    show: impl Fn(&tauri::AppHandle<R>) + Send + 'static,
    delay: std::time::Duration,
) {
    let spawned = std::thread::Builder::new()
        .name("ariadne-window-launch".into())
        .spawn(move || {
            std::thread::sleep(delay);
            let handle = app.clone();
            if app.run_on_main_thread(move || show(&handle)).is_err() {
                eprintln!("Ariadne could not show its main window.");
            }
        });
    if spawned.is_err() {
        eprintln!("Ariadne could not start its window launch fallback.");
    }
}
fn restore_geometry<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    saved: &WindowGeometry,
) -> Result<(), CoreError> {
    let primary = window.primary_monitor().map_err(|_| unavailable())?;
    let mut monitors = window.available_monitors().map_err(|_| unavailable())?;
    let primary_id = primary.as_ref().map(monitor_id);
    monitors.sort_by_key(|monitor| Some(monitor_id(monitor)) != primary_id);
    let mut areas = Vec::new();
    for monitor in monitors {
        let scale = monitor.scale_factor();
        if !scale.is_finite() || scale <= 0.0 {
            return Err(unavailable());
        }
        let area = monitor.work_area();
        areas.push(WorkArea {
            monitor_id: monitor_id(&monitor),
            x: f64::from(area.position.x) / scale,
            y: f64::from(area.position.y) / scale,
            width: f64::from(area.size.width) / scale,
            height: f64::from(area.size.height) / scale,
        });
    }
    let scale = window.scale_factor().map_err(|_| unavailable())?;
    if !scale.is_finite() || scale <= 0.0 {
        return Err(unavailable());
    }
    let outer = window.outer_size().map_err(|_| unavailable())?;
    let inner = window.inner_size().map_err(|_| unavailable())?;
    // Saved dimensions cover the whole frame; set_size sets the inner content.
    let chrome_width = f64::from(outer.width.saturating_sub(inner.width)) / scale;
    let chrome_height = f64::from(outer.height.saturating_sub(inner.height)) / scale;
    let content = content_minimum(window);
    let minimum = MinimumSize {
        width: content.width + chrome_width,
        height: content.height + chrome_height,
    };
    let saved = super::geometry::clamp_geometry(saved, &areas, minimum)?;
    window
        .set_size(tauri::LogicalSize::new(
            (saved.width - chrome_width).max(1.0),
            (saved.height - chrome_height).max(1.0),
        ))
        .map_err(|_| unavailable())?;
    window
        .set_position(tauri::LogicalPosition::new(saved.x, saved.y))
        .map_err(|_| unavailable())
}

impl NativeWindow {
    /// The existing synchronous preferences backend runs off the UI executor.
    /// A saved receipt remains saved even if an OS window action fails.
    pub(crate) fn reconcile<R: tauri::Runtime>(&self, app: tauri::AppHandle<R>, restore: bool) {
        self.reconcile_then(app, restore, None);
    }

    /// `then` runs on the UI thread after the saved preferences are applied,
    /// or once the read fails.
    fn reconcile_then<R: tauri::Runtime>(
        &self,
        app: tauri::AppHandle<R>,
        restore: bool,
        then: Option<AfterReconcile<R>>,
    ) {
        let service = app.state::<DesktopService>().inner().clone();
        let revision = self.applied_revision.clone();
        let movement = self.movement.clone();
        let captured_movement = movement.load(Ordering::Acquire);
        tauri::async_runtime::spawn(async move {
            let result =
                tauri::async_runtime::spawn_blocking(move || service.native_preferences()).await;
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Ok(Ok(snapshot)) = result {
                    let observed = snapshot.revision.value();
                    if observed >= revision.load(Ordering::Acquire) {
                        revision.fetch_max(observed, Ordering::AcqRel);
                        if let Some(window) = handle.get_webview_window("main") {
                            if window.set_always_on_top(snapshot.global.pinned).is_err() {
                                eprintln!("Ariadne could not apply the saved native pin preference.");
                            }
                            if restore && movement.load(Ordering::Acquire) == captured_movement {
                                if let Some(saved) = snapshot.global.window {
                                    if restore_geometry(&window, &saved).is_err() {
                                        eprintln!("Ariadne could not restore the saved native window geometry.");
                                    }
                                }
                            }
                        }
                    }
                }
                if let Some(then) = then {
                    then(&handle);
                }
            });
        });
    }

    /// First show at startup. The window is created hidden (tauri.conf.json),
    /// so it appears once, at its saved size, instead of growing from the
    /// default. A failed or slow preference read still shows it.
    pub(crate) fn launch<R: tauri::Runtime>(&self, app: tauri::AppHandle<R>) {
        let show = first_show::<R>();
        show_after(app.clone(), show.clone(), LAUNCH_FALLBACK);
        self.reconcile_then(app, true, Some(Box::new(show)));
    }

    pub(crate) fn moved<R: tauri::Runtime>(&self, window: &tauri::Window<R>) {
        if self.stopped.load(Ordering::Acquire) || !resting(window) {
            return;
        }
        self.movement.fetch_add(1, Ordering::AcqRel);
        let Ok(geometry) = geometry(window) else {
            return;
        };
        let service = window.state::<DesktopService>().inner().clone();
        self.queue_geometry(geometry, service);
    }
    pub(crate) fn queue_geometry(
        &self,
        geometry: ariadne_core::WindowGeometry,
        service: DesktopService,
    ) -> bool {
        let Ok(mut latest) = self.latest_geometry.lock() else {
            return false;
        };
        if self.stopped.load(Ordering::Acquire) {
            return false;
        }
        *latest = Some(geometry);
        if self.writing.swap(true, Ordering::AcqRel) {
            return true;
        }
        // Hold the admission lock until the owned handle is installed. Quit
        // suppresses subsequent movement before joining this exact worker.
        let Ok(mut worker) = self.worker.lock() else {
            self.writing.store(false, Ordering::Release);
            return false;
        };
        if let Some(previous) = worker.take() {
            let _ = previous.join();
        }
        let manager = self.clone();
        match std::thread::Builder::new()
            .name("ariadne-window-preferences".into())
            .spawn(move || manager.save_latest(&service))
        {
            Ok(handle) => *worker = Some(handle),
            Err(_) => {
                self.writing.store(false, Ordering::Release);
                eprintln!("Ariadne could not start its native preference writer.");
            }
        }
        drop(latest);
        true
    }
    /// Movement admission has stopped on the UI thread. Join this native
    /// writer before exiting; uncertainty still retains its original request.
    pub(crate) fn join_writer(&self, service: &DesktopService) -> Result<(), CoreError> {
        self.begin_stop();
        let worker = self.worker.lock().map_err(|_| unavailable())?.take();
        if worker.is_some_and(|worker| worker.join().is_err()) {
            self.worker_failed.store(true, Ordering::Release);
        }
        if self.worker_failed.load(Ordering::Acquire) {
            return Err(CoreError::new(CoreErrorCode::CommitUncertain,
                "The native preference writer did not finish normally.",
                "Keep the app running and reconcile the original preference operation; saved effects may already exist."));
        }
        let mut writer = self.writer.lock().map_err(|_| unavailable())?;
        writer.confirm(|request| service.native_preferences_write(request))?;
        writer.ready_to_exit()
    }
    /// Pure producer fence at accepted Quit, before any owned IO is joined.
    pub(crate) fn begin_stop(&self) {
        // Serialize with the owned geometry queue, without joining/doing IO.
        let _latest = self
            .latest_geometry
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.stopped.store(true, Ordering::Release);
    }
    fn save_latest(&self, service: &DesktopService) {
        loop {
            let next = self.latest_geometry.lock().ok().and_then(|mut value| {
                let next = value.take();
                if next.is_none() {
                    self.writing.store(false, Ordering::Release);
                }
                next
            });
            let Some(next) = next else { return };
            let result = self
                .writer
                .lock()
                .map_err(|_| unavailable())
                .and_then(|mut writer| {
                    writer.save(
                        next.clone(),
                        || UuidV4::new(uuid::Uuid::new_v4().to_string()).expect("generated v4"),
                        || service.native_preferences(),
                        |request| service.native_preferences_write(request),
                    )
                });
            match result {
                Ok(false) => {
                    if let Ok(mut latest) = self.latest_geometry.lock() {
                        if latest.is_none() {
                            *latest = Some(next);
                        }
                    }
                }
                Ok(true) => {}
                Err(error) => {
                    if error.code == CoreErrorCode::RevisionConflict {
                        // A definite conflict refreshes without resubmitting the
                        // attempted edit under another revision or operation ID.
                        let _ = service.native_preferences();
                    }
                    if let Ok(mut latest) = self.latest_geometry.lock() {
                        if matches!(
                            error.code,
                            CoreErrorCode::CommitUncertain | CoreErrorCode::ProtocolConflict
                        ) {
                            if latest.is_none() {
                                *latest = Some(next);
                            }
                        } else {
                            *latest = None;
                        }
                        self.writing.store(false, Ordering::Release);
                    }
                    eprintln!("Ariadne could not confirm its native window preferences.");
                    return;
                }
            }
        }
    }
}
