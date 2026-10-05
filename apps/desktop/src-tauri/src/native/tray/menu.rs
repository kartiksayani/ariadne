use super::{feed::NativeTray, TrayProjection};
use crate::native::routes::NativeRoutes;
use ariadne_core::{CoreError, OpenRoute};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager,
};

const ID: &str = "ariadne-waiting";
const ROUTE: &str = "ariadne:route:";
mod publication;
use publication::{label, MenuRow, MenuSnapshot, Publication};

fn error(_: tauri::Error) -> CoreError {
    super::feed::unavailable()
}
fn snapshot(projection: &TrayProjection, pinned: bool) -> Result<MenuSnapshot, CoreError> {
    Ok(MenuSnapshot {
        title: projection.title.clone(),
        rows: projection
            .oldest
            .iter()
            .map(|row| {
                let route =
                    serde_json::to_string(&row.route()).map_err(|_| super::feed::unavailable())?;
                Ok(MenuRow {
                    id: format!("{ROUTE}{route}"),
                    label: format!(
                        "{} · {} · #{}",
                        label(&row.project_label),
                        label(&row.session_label),
                        row.episode.item_id.as_str()
                    ),
                })
            })
            .collect::<Result<_, CoreError>>()?,
        diagnostics: projection
            .diagnostics
            .iter()
            .map(|text| label(text))
            .collect(),
        pinned,
    })
}

fn build<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    projection: Option<&MenuSnapshot>,
) -> Result<Menu<R>, CoreError> {
    let menu = Menu::new(app).map_err(error)?;
    if let Some(projection) = projection {
        for row in &projection.rows {
            let item = MenuItem::with_id(app, row.id.clone(), &row.label, true, None::<&str>)
                .map_err(error)?;
            menu.append(&item).map_err(error)?;
        }
        if projection.rows.is_empty() {
            menu.append(
                &MenuItem::new(app, "No questions waiting", false, None::<&str>).map_err(error)?,
            )
            .map_err(error)?;
        }
        for diagnostic in &projection.diagnostics {
            menu.append(&MenuItem::new(app, diagnostic, false, None::<&str>).map_err(error)?)
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
        &CheckMenuItem::with_id(
            app,
            "ariadne-pin",
            "Pin",
            true,
            projection.is_some_and(|snapshot| snapshot.pinned),
            None::<&str>,
        )
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
        .menu(&build(app, None)?)
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
                        // macOS toggles this checkmark before delivering the
                        // event. Even a rejected save must restore canonical Pin.
                        let invalidated = (|| {
                            let publication = app
                                .try_state::<Mutex<Publication>>()
                                .ok_or_else(super::feed::unavailable)?;
                            publication
                                .lock()
                                .map_err(|_| super::feed::unavailable())?
                                .invalidate();
                            Ok::<_, CoreError>(())
                        })();
                        if invalidated.is_err() {
                            eprintln!("Ariadne could not reconcile its native Pin state.");
                            return;
                        }
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
    // A new install starts from its loading menu even if setup is retried on
    // the same App. Publication state is never shared between App lifetimes.
    if let Some(publication) = app.try_state::<Mutex<Publication>>() {
        *publication.lock().map_err(|_| super::feed::unavailable())? = Publication::default();
    } else {
        app.manage(Mutex::new(Publication::default()));
    }
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
            let next = snapshot(&projection, pinned)?;
            let publication = handle
                .try_state::<Mutex<Publication>>()
                .ok_or_else(super::feed::unavailable)?;
            let mut publication = publication.lock().map_err(|_| super::feed::unavailable())?;
            publication
                .publish(next, stopped.load(Ordering::Acquire), |next| {
                    let tray = handle.tray_by_id(ID).ok_or_else(super::feed::unavailable)?;
                    let menu = build(&handle, Some(next))?;
                    tray.set_title(Some(&next.title)).map_err(error)?;
                    tray.set_menu(Some(menu)).map_err(error)
                })
                .map(|_| ())
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
