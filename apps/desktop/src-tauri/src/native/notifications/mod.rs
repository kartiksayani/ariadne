//! Single native delegate; permission is an explicit owner action.
use crate::native::tray::{capture, NativeTray};
pub(crate) mod burst;
#[cfg(target_os = "macos")]
mod macos;
mod policy;
pub(crate) mod writer;
use ariadne_core::{CoreError, CoreErrorCode};
#[cfg(target_os = "macos")]
pub(crate) use macos::Platform;
pub use policy::{evaluate, NotificationPlan};
use tauri::Manager;

pub(crate) fn unavailable() -> CoreError {
    CoreError::new(
        CoreErrorCode::IoError,
        "Native notifications are unavailable.",
        "Keep using the in-app Waiting queue and retry the explicit permission action.",
    )
}

#[tauri::command]
pub async fn notification_permission<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
) -> Result<bool, CoreError> {
    if window.label() != "main" {
        return Err(CoreError::new(
            CoreErrorCode::PermissionDenied,
            "Only the main Ariadne window may request notification permission.",
            "Use the notification permission action in the main window.",
        ));
    }
    let tray = window.try_state::<NativeTray>().ok_or_else(unavailable)?;
    tray.permission().await
}
