use super::{
    geometry::{
        DisplayState, MinimumSize, MonitorPrint, SaveGate, WorkArea, DISPLAY_QUIET, FIT_QUIET,
    },
    preferences::WindowPreferenceWrite,
};
use crate::commands::DesktopService;
use ariadne_core::{CoreError, CoreErrorCode, WindowGeometry};
use ariadne_domain::models::UuidV4;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::Manager;

#[derive(Clone, Default)]
pub struct NativeWindow {
    writer: Arc<Mutex<WindowPreferenceWrite>>,
    latest_geometry: Arc<Mutex<Option<WindowGeometry>>>,
    writing: Arc<AtomicBool>,
    worker: Arc<Mutex<Option<std::thread::JoinHandle<()>>>>,
    worker_failed: Arc<AtomicBool>,
    applied_revision: Arc<AtomicU64>,
    /// Counts the owner's own moves and resizes: those the save gate allowed.
    owner_movement: Arc<AtomicU64>,
    /// Keeps the app's own fits and display changes from being saved.
    gate: Arc<Mutex<SaveGate>>,
    stopped: Arc<AtomicBool>,
}
type Gate = Mutex<SaveGate>;
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
/// How the displays look now, for the save gate. None when they cannot be read.
fn display_state<R: tauri::Runtime>(window: &tauri::Window<R>) -> Option<DisplayState> {
    let monitors = window
        .available_monitors()
        .ok()?
        .iter()
        .map(|monitor| MonitorPrint {
            id: monitor_id(monitor),
            width: monitor.size().width,
            height: monitor.size().height,
            scale_milli: (monitor.scale_factor() * 1000.0).round() as i64,
        })
        .collect();
    let current = window.current_monitor().ok()?.as_ref().map(monitor_id);
    Some(DisplayState { monitors, current })
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
            // The fit's events arrive after the show: keep them out of the
            // saved frame. `present` alone does not hush (tray, routes).
            let gate = app.try_state::<NativeWindow>();
            let hush = || {
                if let Some(native) = &gate {
                    native.hush(Instant::now(), FIT_QUIET);
                }
            };
            hush();
            if present(&window).is_err() {
                eprintln!("Ariadne could not show its main window.");
            }
            hush();
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
/// The monitors' work areas (primary first) and the window's chrome, in
/// logical pixels.
struct Screen {
    areas: Vec<WorkArea>,
    /// Whole frame minus content: the title bar's height, any side borders.
    chrome: MinimumSize,
}
fn screen<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<Screen, CoreError> {
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
    Ok(Screen {
        areas,
        chrome: MinimumSize {
            width: f64::from(outer.width.saturating_sub(inner.width)) / scale,
            height: f64::from(outer.height.saturating_sub(inner.height)) / scale,
        },
    })
}
/// Sets the window's live minimum for the screen `frame` is on (the configured
/// minimum, but never more than the work area leaves after the chrome), then
/// fits `frame` through `clamp_geometry` with that same minimum. With
/// `only_if_needed`, a frame that is on screen and reachable is left alone.
fn fit_window<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    frame: &WindowGeometry,
    only_if_needed: bool,
    gate: &Gate,
) -> Result<(), CoreError> {
    let screen = screen(window)?;
    let plan = super::geometry::plan_fit(
        frame,
        &screen.areas,
        screen.chrome,
        content_minimum(window),
        only_if_needed,
    )?;
    let minimum = plan.content_minimum;
    run_fit(
        gate,
        Instant::now,
        plan.frame.is_some(),
        || {
            window
                .set_min_size(Some(tauri::LogicalSize::new(minimum.width, minimum.height)))
                .map_err(|_| unavailable())
        },
        || {
            let fitted = plan.frame.as_ref().ok_or_else(unavailable)?;
            window
                .set_size(tauri::LogicalSize::new(
                    (fitted.width - screen.chrome.width).max(1.0),
                    (fitted.height - screen.chrome.height).max(1.0),
                ))
                .map_err(|_| unavailable())
        },
        || {
            let fitted = plan.frame.as_ref().ok_or_else(unavailable)?;
            window
                .set_position(tauri::LogicalPosition::new(fitted.x, fitted.y))
                .map_err(|_| unavailable())
        },
    )
}
/// Runs a fit's setters inside a quiet save window: hushed before the first
/// setter, so none of the events they cause is saved, and again after the last,
/// so the events macOS delivers late stay inside it. `now` reads the clock.
fn run_fit(
    gate: &Gate,
    now: impl Fn() -> Instant,
    moves_frame: bool,
    set_min_size: impl FnOnce() -> Result<(), CoreError>,
    set_size: impl FnOnce() -> Result<(), CoreError>,
    set_position: impl FnOnce() -> Result<(), CoreError>,
) -> Result<(), CoreError> {
    hush_gate(gate, now(), FIT_QUIET);
    let result = (|| {
        set_min_size()?;
        if moves_frame {
            set_size()?;
            set_position()?;
        }
        Ok(())
    })();
    hush_gate(gate, now(), FIT_QUIET);
    result
}
fn hush_gate(gate: &Gate, now: Instant, span: Duration) {
    gate.lock()
        .unwrap_or_else(|error| error.into_inner())
        .hush(now, span);
}
/// What a reconcile does with the window's frame, after applying the pin.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fit {
    /// Leave the frame alone (a pin change).
    Keep,
    /// Launch: place the saved frame, or fit the default frame on first launch,
    /// always inside a work area.
    Launch,
    /// Wake or scale change: re-fit only a frame that no longer fits its screen
    /// or whose title bar is unreachable; never move a reachable window.
    IfNeeded,
}
/// The frame a fit works from.
#[derive(Debug, PartialEq)]
enum FitFrame<'a> {
    /// The saved frame, placed inside a work area.
    Saved(&'a WindowGeometry),
    /// The window's own frame, fitted (`only_if_needed`: only when it no longer
    /// fits or its title bar is unreachable).
    Current { only_if_needed: bool },
}
/// Which frame `fit` works from, or None when the frame is left alone. Launch
/// without a saved frame (before the read returns, or when it fails) fits the
/// current frame, so the window never shows unfitted.
fn fit_frame(fit: Fit, saved: Option<&WindowGeometry>) -> Option<FitFrame<'_>> {
    match (fit, saved) {
        (Fit::Keep, _) => None,
        (Fit::Launch, Some(saved)) => Some(FitFrame::Saved(saved)),
        (Fit::Launch, None) => Some(FitFrame::Current {
            only_if_needed: false,
        }),
        (Fit::IfNeeded, _) => Some(FitFrame::Current {
            only_if_needed: true,
        }),
    }
}
/// Applies `fit` to the main window. A window that is minimized or full screen
/// keeps its frame: its size is not a resting one.
fn fit_main<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    fit: Fit,
    saved: Option<&WindowGeometry>,
    gate: &Gate,
) -> Result<(), CoreError> {
    let Some(frame) = fit_frame(fit, saved) else {
        return Ok(());
    };
    if window.is_minimized().unwrap_or(true) || window.is_fullscreen().unwrap_or(true) {
        return Ok(());
    }
    match frame {
        FitFrame::Saved(saved) => fit_window(window, saved, false, gate),
        FitFrame::Current { only_if_needed } => fit_window(
            window,
            &geometry(&window.as_ref().window())?,
            only_if_needed,
            gate,
        ),
    }
}

impl NativeWindow {
    /// The existing synchronous preferences backend runs off the UI executor.
    /// A saved receipt remains saved even if an OS window action fails.
    pub(crate) fn reconcile<R: tauri::Runtime>(&self, app: tauri::AppHandle<R>, fit: Fit) {
        self.reconcile_then(app, fit, None);
    }

    /// `then` runs on the UI thread after the saved preferences are applied,
    /// or once the read fails.
    fn reconcile_then<R: tauri::Runtime>(
        &self,
        app: tauri::AppHandle<R>,
        fit: Fit,
        then: Option<AfterReconcile<R>>,
    ) {
        let service = app.state::<DesktopService>().inner().clone();
        let revision = self.applied_revision.clone();
        let native = self.clone();
        let captured_movement = self.owner_movement.load(Ordering::Acquire);
        tauri::async_runtime::spawn(async move {
            let result =
                tauri::async_runtime::spawn_blocking(move || service.native_preferences()).await;
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(window) = handle.get_webview_window("main") {
                    // A failed or stale read still fits the window; only the
                    // saved frame and the pin need a current snapshot.
                    let mut saved = None;
                    if let Ok(Ok(snapshot)) = result {
                        let observed = snapshot.revision.value();
                        if observed >= revision.load(Ordering::Acquire) {
                            revision.fetch_max(observed, Ordering::AcqRel);
                            if window.set_always_on_top(snapshot.global.pinned).is_err() {
                                eprintln!(
                                    "Ariadne could not apply the saved native pin preference."
                                );
                            }
                            saved = snapshot.global.window;
                        }
                    }
                    if !native.owner_moved_since(captured_movement)
                        && fit_main(&window, fit, saved.as_ref(), &native.gate).is_err()
                    {
                        eprintln!("Ariadne could not fit the native window to its screen.");
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
    /// default. A failed or slow preference read still shows it, and the window
    /// is fitted to its screen first, so a slow read never shows it unfitted.
    pub(crate) fn launch<R: tauri::Runtime>(&self, app: tauri::AppHandle<R>) {
        if let Some(window) = app.get_webview_window("main") {
            // Seed the displays before anything moves the window, so a change
            // before the owner's first move is noticed.
            if let Some(display) = display_state(&window.as_ref().window()) {
                self.lock_gate().monitors(Instant::now(), &display.monitors);
            }
            if fit_main(&window, Fit::Launch, None, &self.gate).is_err() {
                eprintln!("Ariadne could not fit the native window to its screen.");
            }
        }
        let show = first_show::<R>();
        show_after(app.clone(), show.clone(), LAUNCH_FALLBACK);
        self.reconcile_then(app, Fit::Launch, Some(Box::new(show)));
    }

    /// Saves only the owner's own moves and resizes: not the app's fits, the
    /// first show or a display change (see `SaveGate`).
    pub(crate) fn moved<R: tauri::Runtime>(&self, window: &tauri::Window<R>) {
        if self.stopped.load(Ordering::Acquire) || !resting(window) {
            return;
        }
        if !self.admit_move(Instant::now(), display_state(window)) {
            return;
        }
        let Ok(geometry) = geometry(window) else {
            return;
        };
        let service = window.state::<DesktopService>().inner().clone();
        self.queue_geometry(geometry, service);
    }
    /// Whether a window event may be saved. An allowed one is the owner's: it
    /// fences a pending launch restore, before its save is queued.
    fn admit_move(&self, now: Instant, display: Option<DisplayState>) -> bool {
        let mut gate = self.lock_gate();
        let admitted = gate.admit(now, display);
        if admitted {
            self.owner_movement.fetch_add(1, Ordering::AcqRel);
        }
        admitted
    }
    /// Whether an allowed (owner) move happened since `captured` was read.
    fn owner_moved_since(&self, captured: u64) -> bool {
        self.owner_movement.load(Ordering::Acquire) != captured
    }
    /// Keeps saving quiet until `span` after `now`.
    pub(crate) fn hush(&self, now: Instant, span: Duration) {
        hush_gate(&self.gate, now, span);
    }
    /// A display change (a scale change) is under way: its events are not saved.
    pub(crate) fn display_changed(&self) {
        self.hush(Instant::now(), DISPLAY_QUIET);
    }
    fn lock_gate(&self) -> std::sync::MutexGuard<'_, SaveGate> {
        self.gate.lock().unwrap_or_else(|error| error.into_inner())
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

#[cfg(test)]
#[path = "tests/desktop.rs"]
mod tests;
