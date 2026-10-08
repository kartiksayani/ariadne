use serde::{Deserialize, Serialize};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use tauri::Manager;
pub mod commands;
pub mod composition;
#[cfg(feature = "e2e")]
mod e2e_quit;
pub mod native;
pub mod watchers;

#[derive(Deserialize)]
pub struct PingRequest {
    nonce: String,
    payload: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct PingReceipt {
    nonce: String,
    payload: String,
    pid: u32,
    receipt_id: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidNonce,
    NonceMismatch,
    InvalidPayload,
    Io,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct CommandError {
    code: ErrorCode,
}

struct PingState {
    root: PathBuf,
    expected: Option<String>,
    sequence: AtomicU64,
}

fn valid_nonce(nonce: &str) -> bool {
    nonce.len() == 64 && nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
}

impl PingState {
    #[cfg(feature = "e2e")]
    fn environment() -> std::io::Result<Self> {
        let required = |name| {
            std::env::var(name).map_err(|_| std::io::Error::other(format!("Missing {name}")))
        };
        Self::isolated(
            required("ARIADNE_E2E_ROOT")?.into(),
            required("ARIADNE_E2E_NONCE")?,
        )
    }
    #[cfg(any(not(feature = "e2e"), test))]
    fn ordinary() -> std::io::Result<(Self, tempfile::TempDir)> {
        let owner = tempfile::Builder::new()
            .prefix("ariadne-ping-")
            .permissions(fs::Permissions::from_mode(0o700))
            .tempdir()?;
        let state = Self {
            root: owner.path().to_path_buf(),
            expected: None,
            sequence: AtomicU64::new(0),
        };
        Ok((state, owner))
    }

    #[cfg(feature = "e2e")]
    fn isolated(root: PathBuf, nonce: String) -> std::io::Result<Self> {
        let metadata = fs::metadata(&root)?;
        let valid = fs::canonicalize(&root)? == root
            && root.parent() == Some(std::path::Path::new("/private/tmp"))
            && root
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .starts_with("ariadne-e2e-")
            && metadata.is_dir()
            && metadata.permissions().mode() & 0o777 == 0o700
            && valid_nonce(&nonce);
        if !valid {
            return Err(std::io::Error::other("Invalid private E2E root or nonce"));
        }
        fs::write(
            root.join("startup.json"),
            serde_json::to_vec(&serde_json::json!({"nonce": nonce, "pid": std::process::id()}))?,
        )?;
        Ok(Self {
            root,
            expected: Some(nonce),
            sequence: AtomicU64::new(0),
        })
    }

    fn ping(&self, request: PingRequest) -> Result<PingReceipt, CommandError> {
        let error = |code| CommandError { code };
        if !valid_nonce(&request.nonce) {
            return Err(error(ErrorCode::InvalidNonce));
        }
        if self
            .expected
            .as_ref()
            .is_some_and(|expected| expected != &request.nonce)
        {
            return Err(error(ErrorCode::NonceMismatch));
        }
        if request.payload.is_empty()
            || request.payload.len() > 128
            || request.payload.chars().any(char::is_control)
        {
            return Err(error(ErrorCode::InvalidPayload));
        }
        let receipt = PingReceipt {
            nonce: request.nonce,
            payload: request.payload,
            pid: std::process::id(),
            receipt_id: format!(
                "ping-{}-{}",
                std::process::id(),
                self.sequence.fetch_add(1, Ordering::Relaxed)
            ),
        };
        fs::create_dir_all(self.root.join("smoke")).map_err(|_| error(ErrorCode::Io))?;
        fs::write(
            self.root.join("smoke/receipt.json"),
            serde_json::to_vec(&receipt).map_err(|_| error(ErrorCode::Io))?,
        )
        .map_err(|_| error(ErrorCode::Io))?;
        Ok(receipt)
    }
}

fn complete_run(owner: Option<tempfile::TempDir>, exit_code: i32) -> i32 {
    drop(owner);
    exit_code
}

#[tauri::command]
fn native_ping(
    request: PingRequest,
    state: tauri::State<'_, PingState>,
) -> Result<PingReceipt, CommandError> {
    state.ping(request)
}

pub fn run() {
    // Parsing is pure. Single-instance ownership is established by the plugin
    // before trusted startup can create directories, probes, leases or workers.
    let configuration =
        composition::NativeConfiguration::from_startup_args(&std::env::args().collect::<Vec<_>>())
            .expect("Invalid native startup configuration");
    run_native(None, move |app| composition::establish(app, configuration));
}

fn desktop_handler<R: tauri::Runtime>(
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    let handler: fn(tauri::ipc::Invoke<R>) -> bool = tauri::generate_handler![
        native_ping,
        native::routes::route_ready,
        native::notifications::notification_permission,
        commands::project_list,
        commands::session_list,
        commands::session_get,
        commands::session_read,
        commands::item_messages,
        commands::item_rounds,
        commands::topic_continue_preview,
        commands::preferences_get,
        commands::discovery_snapshot,
        commands::discovery_ui_open,
        commands::codex_default_endpoint,
        commands::supervisor_health,
        commands::open_link,
        commands::clipboard_write,
        commands::file_references_resolve,
        commands::file_reference_open,
        commands::reveal_item,
        commands::project_register,
        commands::binding_connect,
        commands::binding_pause,
        commands::binding_resume,
        commands::binding_disconnect,
        commands::input_submit,
        commands::input_cancel,
        commands::input_resolve,
        commands::topic_archive,
        commands::topic_restore,
        commands::session_close,
        commands::session_reopen,
        commands::session_label_set,
        commands::topic_continue,
        commands::preferences_patch,
        commands::item_remove,
        commands::topic_remove,
        commands::session_remove,
        commands::project_remove,
    ];
    #[cfg(feature = "e2e")]
    {
        let quit: fn(tauri::ipc::Invoke<R>) -> bool =
            tauri::generate_handler![e2e_quit::native_e2e_quit];
        move |invoke: tauri::ipc::Invoke<R>| {
            if invoke.message.command() == "native_e2e_quit" {
                quit(invoke)
            } else {
                handler(invoke)
            }
        }
    }
    #[cfg(not(feature = "e2e"))]
    handler
}

#[cfg(target_os = "macos")]
fn reconcile_after_wake<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    quitting: Arc<AtomicBool>,
    waking: Arc<AtomicBool>,
) {
    if quitting.load(Ordering::Acquire) || waking.swap(true, Ordering::AcqRel) {
        return;
    }
    let lifecycle = app
        .state::<native::window::lifecycle::NativeLifecycle>()
        .inner()
        .clone();
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || lifecycle.reconcile()).await;
        if !matches!(result, Ok(Ok(()))) {
            eprintln!("Ariadne could not confirm owning-runtime wake reconciliation.");
        }
        // Display restoration is independent of dispatch readiness.
        app.state::<native::window::NativeWindow>()
            .reconcile(app.clone(), true);
        waking.store(false, Ordering::Release);
    });
}

fn establish_lifecycle<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    startup: impl FnOnce(
        &tauri::AppHandle<R>,
    )
        -> Result<native::window::lifecycle::NativeLifecycle, ariadne_core::CoreError>,
) -> Result<(), ariadne_core::CoreError> {
    let lifecycle = startup(app)?;
    app.manage(lifecycle);
    Ok(())
}

/// Rust startup composition only; the renderer cannot install a service or resolver.
pub fn run_with_service(service: commands::DesktopService) {
    run_with_startup(service, |_| {
        Ok(native::window::lifecycle::NativeLifecycle::default())
    });
}

/// Trusted Rust composition only. Acquire existing native control ownership
/// before starting owned workers, and return callbacks only after it succeeds.
/// A failure aborts setup; the renderer cannot supply or replace this callback.
pub fn run_with_startup(
    service: commands::DesktopService,
    startup: impl FnOnce(
            &tauri::AppHandle,
        )
            -> Result<native::window::lifecycle::NativeLifecycle, ariadne_core::CoreError>
        + Send
        + 'static,
) {
    run_native(Some(service), startup);
}

fn run_native(
    service: Option<commands::DesktopService>,
    startup: impl FnOnce(
            &tauri::AppHandle,
        )
            -> Result<native::window::lifecycle::NativeLifecycle, ariadne_core::CoreError>
        + Send
        + 'static,
) {
    #[cfg(feature = "e2e")]
    let state = PingState::environment().expect("Invalid E2E startup");
    #[cfg(feature = "e2e")]
    let owner = None;
    #[cfg(not(feature = "e2e"))]
    let (state, owner) = PingState::ordinary().expect("Cannot create private diagnostic directory");
    #[cfg(not(feature = "e2e"))]
    let owner = Some(owner);
    let exit_allowed = Arc::new(AtomicBool::new(false));
    let quitting = Arc::new(AtomicBool::new(false));
    #[cfg(target_os = "macos")]
    let waking = Arc::new(AtomicBool::new(false));
    let window_quitting = quitting.clone();
    #[cfg(target_os = "macos")]
    let wake_quitting = quitting.clone();
    #[cfg(target_os = "macos")]
    let wake_active = waking.clone();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            native::routes::receive_launch(app.clone(), args);
        }))
        .manage(state)
        .manage(native::routes::NativeRoutes::default())
        .manage(native::window::NativeWindow::default())
        .on_window_event(move |window, event| {
            if window.label() != "main" {
                return;
            }
            if window.try_state::<commands::DesktopService>().is_none() {
                return;
            }
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    // Hiding a full-screen window would leave its Space black.
                    let hidden = window.clone();
                    native::window::fullscreen::leave_then(window, move || {
                        let _ = hidden.hide();
                    });
                }
                #[cfg(target_os = "macos")]
                tauri::WindowEvent::ThemeChanged(theme) => {
                    native::window::dock::follow(*theme);
                }
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                    if !window_quitting.load(Ordering::Acquire) {
                        window.state::<native::window::NativeWindow>().moved(window);
                    }
                }
                tauri::WindowEvent::ScaleFactorChanged { .. } => {
                    window
                        .state::<native::window::NativeWindow>()
                        .reconcile(window.app_handle().clone(), true);
                }
                tauri::WindowEvent::Focused(true) if !window_quitting.load(Ordering::Acquire) => {
                    // Activation (Cmd+Tab, Dock, a click on the title bar)
                    // puts key focus in the page so shortcuts work at once.
                    if let Some(main) = window.app_handle().get_webview_window("main") {
                        native::window::focus_webview(&main);
                    }
                    if let Some(runtime) = window.try_state::<Arc<composition::NativeRuntime>>() {
                        let _ = runtime.refresh_snapshots();
                    }
                    if let Some(tray) = window.try_state::<native::tray::NativeTray>() {
                        tray.refresh();
                    }
                }
                _ => {}
            }
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                webview
                    .state::<native::routes::NativeRoutes>()
                    .webview_loading();
            }
        })
        .setup(move |app| {
            // Plugin setup runs first: ordinary second launches are intercepted
            // before this callback can acquire authority or start owned workers.
            if let Some(service) = service {
                app.manage(service);
            }
            establish_lifecycle(app.handle(), startup).map_err(|_| {
                std::io::Error::other("Native ownership/startup could not be established.")
            })?;
            if app.try_state::<commands::DesktopService>().is_none() {
                return Err(std::io::Error::other(
                    "Trusted startup did not install the desktop service.",
                )
                .into());
            }
            let tray = native::tray::NativeTray::install(app.handle()).map_err(|_| {
                std::io::Error::other("Native Waiting feed could not be established.")
            })?;
            app.manage(tray);
            #[cfg(target_os = "macos")]
            {
                let handle = app.handle().clone();
                native::window::wake::install(move || {
                    reconcile_after_wake(
                        handle.clone(),
                        wake_quitting.clone(),
                        wake_active.clone(),
                    );
                })
                .map_err(|_| {
                    std::io::Error::other(
                        "Native workspace wake observation could not be established.",
                    )
                })?;
            }
            #[cfg(target_os = "macos")]
            if let Some(theme) = app
                .get_webview_window("main")
                .and_then(|window| window.theme().ok())
            {
                native::window::dock::follow(theme);
            }
            native::routes::receive_startup(app.handle().clone(), std::env::args().collect());
            // The window is created hidden; it first shows at its saved size.
            app.state::<native::window::NativeWindow>()
                .launch(app.handle().clone());
            Ok(())
        });
    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());
    let exit_code = builder
        .invoke_handler(desktop_handler())
        .build(tauri::generate_context!())
        .expect("Tauri startup failed")
        .run_return(move |app, event| {
            match event {
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => native::routes::reopen(app),
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                if exit_allowed.load(Ordering::Acquire) {
                    return;
                }
                api.prevent_exit();
                if quitting.swap(true, Ordering::AcqRel) {
                    return;
                }
                app.state::<native::window::NativeWindow>().begin_stop();
                if let Some(tray) = app.try_state::<native::tray::NativeTray>() {
                    tray.begin_stop();
                }
                // Fence wake publication and new runtime admission at the Quit
                // event, before off-UI window/tray drains can wait for IO.
                if let Some(runtime) = app.try_state::<Arc<composition::NativeRuntime>>() {
                    if runtime.begin_shutdown().is_err() {
                        eprintln!("Ariadne could not fence its owning-runtime shutdown.");
                        return;
                    }
                }
                let lifecycle = app
                    .state::<native::window::lifecycle::NativeLifecycle>()
                    .inner()
                    .clone();
                let window = app.state::<native::window::NativeWindow>().inner().clone();
                let app = app.clone();
                let exit_allowed = exit_allowed.clone();
                let quitting = quitting.clone();
                let service = app.state::<commands::DesktopService>().inner().clone();
                let tray = app.try_state::<native::tray::NativeTray>().map(|tray| tray.inner().clone());
                // Capture only the canonical read authority. Ordinary bridge
                // admission remains fenced; this Core reference owns no helper,
                // external host or runtime/binding lease after the drain.
                let note_core = app.try_state::<Arc<composition::NativeRuntime>>()
                    .map(|runtime| runtime.bridge().core().clone());
                tauri::async_runtime::spawn(async move {
                    let result = tauri::async_runtime::spawn_blocking(move || {
                        window.join_writer(&service)?;
                        if let Some(tray) = tray {
                            tray.stop()?;
                        }
                        lifecycle.prepare_exit()?;
                        Ok::<_, ariadne_core::CoreError>(note_core.map(|core| {
                            native::window::quit_note::required(&core)
                        }))
                    }).await;
                    if let Ok(Ok(note)) = result {
                        let show_note = match note {
                            Some(Ok(active)) => active,
                            Some(Err(_)) => {
                                // A read failure is unknown remaining host work,
                                // not a failed owning shutdown or a no-work claim.
                                eprintln!("Ariadne could not inspect remaining host work before quitting; inspect the registered sessions after reopening.");
                                false
                            }
                            None => false,
                        };
                        let exiting = app.clone();
                        let allowed = exit_allowed.clone();
                        if app.run_on_main_thread(move || {
                            let main = exiting.get_webview_window("main");
                            let finish = move || {
                                #[cfg(target_os = "macos")]
                                if show_note {
                                    native::window::quit_note::present();
                                }
                                #[cfg(not(target_os = "macos"))]
                                let _ = show_note;
                                // The initial Quit fence stays set while the native
                                // alert runs its event loop. Repeated Quit requests
                                // cannot drain again or produce a second alert.
                                allowed.store(true, Ordering::Release);
                                exiting.exit(code.unwrap_or(0));
                            };
                            // Exiting from full screen would leave its Space black.
                            match main {
                                Some(main) => native::window::fullscreen::leave_then(
                                    &main.as_ref().window(),
                                    finish,
                                ),
                                None => finish(),
                            }
                        }).is_err() {
                            eprintln!("Ariadne could not present its native Quit note after owning shutdown.");
                            exit_allowed.store(true, Ordering::Release);
                            app.exit(code.unwrap_or(0));
                        }
                    } else {
                        quitting.store(false, Ordering::Release);
                        eprintln!("Ariadne could not confirm its owning-runtime shutdown; the app remains running.");
                    }
                });
            }
            tauri::RunEvent::Exit => {
                #[cfg(target_os = "macos")]
                native::window::wake::remove();
            }
            _ => {}
            }
        });
    #[cfg(target_os = "macos")]
    native::window::wake::remove();
    std::process::exit(complete_run(owner, exit_code));
}

#[cfg(test)]
mod tests;
