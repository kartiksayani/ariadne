//! Isolated native acceptance requests the real ExitRequested path.
use super::{valid_nonce, CommandError, ErrorCode, PingState};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct QuitRequest {
    nonce: String,
}

fn request_exit(
    state: &PingState,
    request: QuitRequest,
    exit: impl FnOnce(),
) -> Result<(), CommandError> {
    if !valid_nonce(&request.nonce) {
        return Err(CommandError {
            code: ErrorCode::InvalidNonce,
        });
    }
    if state.expected.as_ref() != Some(&request.nonce) {
        return Err(CommandError {
            code: ErrorCode::NonceMismatch,
        });
    }
    let bytes = serde_json::to_vec(&serde_json::json!({
        "nonce": request.nonce, "pid": std::process::id()
    }))
    .map_err(|_| CommandError {
        code: ErrorCode::Io,
    })?;
    std::fs::write(state.root.join("quit-request.json"), bytes).map_err(|_| CommandError {
        code: ErrorCode::Io,
    })?;
    // Acceptance is not shutdown proof: the native runner independently waits
    // for this exact PID to exit and for its private ownership lease to release.
    exit();
    Ok(())
}

#[tauri::command]
pub(super) fn native_e2e_quit<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, PingState>,
    request: QuitRequest,
) -> Result<(), CommandError> {
    request_exit(&state, request, || app.exit(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, fs, os::unix::fs::PermissionsExt};

    #[test]
    fn exact_isolated_nonce_writes_before_exit_and_rejections_have_no_effect() {
        let root = tempfile::Builder::new()
            .prefix("ariadne-e2e-")
            .permissions(fs::Permissions::from_mode(0o700))
            .tempdir_in("/private/tmp")
            .unwrap();
        let nonce = "1".repeat(64);
        let state = PingState::isolated(root.path().into(), nonce.clone()).unwrap();
        let file = root.path().join("quit-request.json");
        for wrong in ["bad".into(), "2".repeat(64)] {
            assert!(
                request_exit(&state, QuitRequest { nonce: wrong }, || panic!(
                    "rejected request cannot exit"
                ))
                .is_err()
            );
            assert!(!file.exists());
        }
        assert!(serde_json::from_str::<QuitRequest>("{}").is_err());
        let exited = Cell::new(false);
        request_exit(
            &state,
            QuitRequest {
                nonce: nonce.clone(),
            },
            || {
                let witness: serde_json::Value =
                    serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
                assert_eq!(witness["nonce"], nonce);
                assert_eq!(witness["pid"], std::process::id());
                exited.set(true);
            },
        )
        .unwrap();
        assert!(exited.get());
        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap();
        assert_eq!(
            request_exit(&state, QuitRequest { nonce }, || panic!(
                "write failure cannot exit"
            ))
            .unwrap_err()
            .code,
            ErrorCode::Io
        );
    }
}
