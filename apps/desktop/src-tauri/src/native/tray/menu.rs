use super::{feed::NativeTray, TrayProjection};
use crate::native::routes::NativeRoutes;
use ariadne_core::{CoreError, OpenRoute};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager,
};

const ID: &str = "ariadne-waiting";
const ROUTE: &str = "ariadne:route:";

fn error(_: tauri::Error) -> CoreError {
    super::feed::unavailable()
}
fn label(text: &str) -> String {
    text.chars()
        .filter(|character| !character.is_control())
        .take(64)
        .collect()
}

fn build<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    projection: Option<&TrayProjection>,
    pinned: bool,
) -> Result<Menu<R>, CoreError> {
    let menu = Menu::new(app).map_err(error)?;
    if let Some(projection) = projection {
        for row in &projection.oldest {
            let route =
                serde_json::to_string(&row.route()).map_err(|_| super::feed::unavailable())?;
            let item = MenuItem::with_id(
                app,
                format!("{ROUTE}{route}"),
                format!(
                    "{} · {} · #{}",
                    label(&row.project_label),
                    label(&row.session_label),
                    row.episode.item_id.as_str()
                ),
                true,
                None::<&str>,
            )
            .map_err(error)?;
            menu.append(&item).map_err(error)?;
        }
        if projection.oldest.is_empty() {
            menu.append(
                &MenuItem::new(app, "No questions waiting", false, None::<&str>).map_err(error)?,
            )
            .map_err(error)?;
        }
        for diagnostic in &projection.diagnostics {
            menu.append(
                &MenuItem::new(app, label(diagnostic), false, None::<&str>).map_err(error)?,
            )
            .map_err(error)?;
        }
    } else {
        menu.append(
            &MenuItem::new(
                app,
                "Loading registered Waiting queue…",
                false,
                None::<&str>,
            )
            .map_err(error)?,
        )
        .map_err(error)?;
    }
    menu.append(&PredefinedMenuItem::separator(app).map_err(error)?)
        .map_err(error)?;
    menu.append(
        &MenuItem::with_id(app, "ariadne-show", "Show Ariadne", true, None::<&str>)
            .map_err(error)?,
    )
    .map_err(error)?;
    menu.append(
        &CheckMenuItem::with_id(app, "ariadne-pin", "Pin", true, pinned, None::<&str>)
            .map_err(error)?,
    )
    .map_err(error)?;
    menu.append(
        &MenuItem::with_id(
            app,
            "ariadne-permission",
            "Enable notifications…",
            true,
            None::<&str>,
        )
        .map_err(error)?,
    )
    .map_err(error)?;
    menu.append(
        &MenuItem::with_id(app, "ariadne-quit", "Quit Ariadne", true, None::<&str>)
            .map_err(error)?,
    )
    .map_err(error)?;
    Ok(menu)
}

pub(crate) fn install<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), CoreError> {
    let icon = app
        .default_window_icon()
        .ok_or_else(super::feed::unavailable)?
        .clone();
    TrayIconBuilder::with_id(ID)
        .title("*")
        .icon(icon)
        .icon_as_template(true)
        .menu(&build(app, None, false)?)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if let Some(route) = id
                .strip_prefix(ROUTE)
                .and_then(|route| serde_json::from_str::<OpenRoute>(route).ok())
            {
                open(app.clone(), route);
            } else {
                match id {
                    "ariadne-show" => show(app),
                    "ariadne-pin" => {
                        if let Some(tray) = app.try_state::<NativeTray>() {
                            tray.pin();
                        }
                    }
                    "ariadne-permission" => {
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Some(tray) = handle.try_state::<NativeTray>() {
                                if tray.permission().await.is_err() {
                                    eprintln!(
                                        "Ariadne could not request native notification permission."
                                    );
                                }
                            }
                        });
                    }
                    "ariadne-quit" => app.exit(0),
                    _ => {}
                }
            }
        })
        .build(app)
        .map_err(error)?;
    Ok(())
}

pub(crate) fn update<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    projection: TrayProjection,
    pinned: bool,
    stopped: Arc<AtomicBool>,
) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if stopped.load(Ordering::Acquire) {
            return;
        }
        let result = (|| {
            let tray = handle.tray_by_id(ID).ok_or_else(super::feed::unavailable)?;
            tray.set_title(Some(&projection.title)).map_err(error)?;
            tray.set_menu(Some(build(&handle, Some(&projection), pinned)?))
                .map_err(error)
        })();
        if result.is_err() {
            eprintln!("Ariadne could not refresh its native Waiting menu.");
        }
    });
}

pub(crate) fn open<R: tauri::Runtime>(app: tauri::AppHandle<R>, route: OpenRoute) {
    tauri::async_runtime::spawn(async move {
        if let Some(routes) = app.try_state::<NativeRoutes>() {
            if routes.open(app.clone(), route).await.is_err() {
                eprintln!("Ariadne could not open a registered notification route.");
            }
        }
    });
}

fn show<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
