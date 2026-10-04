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
    run_with_startup(commands::DesktopService::default(), |_| {
        // This diagnostic entrypoint starts no owning runtime or watchers.
        Ok(native::window::lifecycle::NativeLifecycle::diagnostic_only())
    });
}

fn desktop_handler<R: tauri::Runtime>(
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        native_ping,
        native::routes::route_ready,
        commands::project_list,
        commands::session_list,
        commands::session_get,
        commands::session_read,
        commands::item_messages,
        commands::item_rounds,
        commands::topic_continue_preview,
        commands::preferences_get,
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
        commands::topic_continue,
        commands::preferences_patch,
    ]
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
        .manage(service)
        .manage(native::routes::NativeRoutes::default())
        .manage(native::window::NativeWindow::default())
        .on_window_event(move |window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
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
            establish_lifecycle(app.handle(), startup).map_err(|_| {
                std::io::Error::other("Native ownership/startup could not be established.")
            })?;
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
            native::routes::receive_launch(app.handle().clone(), std::env::args().collect());
            app.state::<native::window::NativeWindow>()
                .reconcile(app.handle().clone(), true);
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
                let lifecycle = app
                    .state::<native::window::lifecycle::NativeLifecycle>()
                    .inner()
                    .clone();
                let window = app.state::<native::window::NativeWindow>().inner().clone();
                let app = app.clone();
                let exit_allowed = exit_allowed.clone();
                let quitting = quitting.clone();
                tauri::async_runtime::spawn(async move {
                    let result = tauri::async_runtime::spawn_blocking(move || {
                        window.join_writer()?;
                        lifecycle.prepare_exit()
                    }).await;
                    if matches!(result, Ok(Ok(()))) {
                        exit_allowed.store(true, Ordering::Release);
                        app.exit(code.unwrap_or(0));
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
