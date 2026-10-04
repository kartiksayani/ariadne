use serde::{Deserialize, Serialize};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
pub mod commands;
pub mod composition;
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
    run_with_service(commands::DesktopService::default());
}

fn desktop_handler<R: tauri::Runtime>(
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        native_ping,
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

/// Rust startup composition only; the renderer cannot install a service or resolver.
pub fn run_with_service(service: commands::DesktopService) {
    #[cfg(feature = "e2e")]
    let state = PingState::environment().expect("Invalid E2E startup");
    #[cfg(feature = "e2e")]
    let owner = None;
    #[cfg(not(feature = "e2e"))]
    let (state, owner) = PingState::ordinary().expect("Cannot create private diagnostic directory");
    #[cfg(not(feature = "e2e"))]
    let owner = Some(owner);
    let builder = tauri::Builder::default().manage(state).manage(service);
    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());
    let exit_code = builder
        .invoke_handler(desktop_handler())
        .build(tauri::generate_context!())
        .expect("Tauri startup failed")
        .run_return(|_app, _event| {});
    std::process::exit(complete_run(owner, exit_code));
}

#[cfg(test)]
mod tests;
