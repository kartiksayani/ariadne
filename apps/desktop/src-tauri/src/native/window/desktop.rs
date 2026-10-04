use super::{geometry::WorkArea, preferences::WindowPreferenceWrite};
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
    applied_revision: Arc<AtomicU64>,
    movement: Arc<AtomicU64>,
}
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
    let saved = super::geometry::clamp_geometry(saved, &areas)?;
    let scale = window.scale_factor().map_err(|_| unavailable())?;
    if !scale.is_finite() || scale <= 0.0 {
        return Err(unavailable());
    }
    let outer = window.outer_size().map_err(|_| unavailable())?;
    let inner = window.inner_size().map_err(|_| unavailable())?;
    // Saved dimensions cover the whole frame; set_size sets the inner content.
    let chrome_width = f64::from(outer.width.saturating_sub(inner.width)) / scale;
    let chrome_height = f64::from(outer.height.saturating_sub(inner.height)) / scale;
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
        let service = app.state::<DesktopService>().inner().clone();
        let revision = self.applied_revision.clone();
        let movement = self.movement.clone();
        let captured_movement = movement.load(Ordering::Acquire);
        tauri::async_runtime::spawn(async move {
            let result =
                tauri::async_runtime::spawn_blocking(move || service.native_preferences()).await;
            if let Ok(Ok(snapshot)) = result {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    let observed = snapshot.revision.value();
                    if observed < revision.load(Ordering::Acquire) {
                        return;
                    }
                    revision.fetch_max(observed, Ordering::AcqRel);
                    if let Some(window) = handle.get_webview_window("main") {
                        if window.set_always_on_top(snapshot.global.pinned).is_err() {
                            eprintln!("Ariadne could not apply the saved native pin preference.");
                        }
                        if restore && movement.load(Ordering::Acquire) == captured_movement {
                            if let Some(saved) = snapshot.global.window {
                                if restore_geometry(&window,&saved).is_err() {
                                    eprintln!("Ariadne could not restore the saved native window geometry.");
                                }
                            }
                        }
                    }
                });
            }
        });
    }

    pub(crate) fn moved<R: tauri::Runtime>(&self, window: &tauri::Window<R>) {
        self.movement.fetch_add(1, Ordering::AcqRel);
        let Ok(geometry) = geometry(window) else {
            return;
        };
        let Ok(mut latest) = self.latest_geometry.lock() else {
            return;
        };
        *latest = Some(geometry);
        if self.writing.swap(true, Ordering::AcqRel) {
            return;
        }
        drop(latest);
        let manager = self.clone();
        let service = window.state::<DesktopService>().inner().clone();
        tauri::async_runtime::spawn(async move {
            let _ =
                tauri::async_runtime::spawn_blocking(move || manager.save_latest(&service)).await;
        });
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
