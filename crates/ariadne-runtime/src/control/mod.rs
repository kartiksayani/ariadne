//! UID-checked Unix-only control; socket IO never spans a store transaction.
mod codec;
mod wire;
use crate::leases::{
    fs::{error, io_error, uid, Directory},
    BindingLease, DesktopOwner,
};
use crate::supervisor::ClaimGate;
use ariadne_core::{
    CoreError, CoreErrorCode, CoreService, OwnerContext, OwnerScope, QueryContext, QueryRequest,
    QueryResult,
};
use ariadne_domain::models::BindingSummary;
use std::{
    collections::HashMap,
    fs,
    os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    net::{UnixListener, UnixStream},
    sync::{oneshot, Semaphore},
    time::timeout,
};
pub use wire::*;

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const CONTROL_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CONNECTIONS: usize = 16;

/// Bound errors at native transport boundaries without exposing malformed facts.
/// The original operation may have committed; this fallback never authorizes resend.
pub fn validated_error(error: CoreError) -> CoreError {
    if error.validate().is_ok() {
        error
    } else {
        CoreError::new(
            CoreErrorCode::ProtocolConflict,
            "Received a malformed canonical core error.",
            "Retain the original request, event and operation IDs; effects may already exist. Check matching app/helper versions before repeating that exact operation.",
        )
    }
}

fn path_limit(path: &Path) -> Result<(), CoreError> {
    use std::os::unix::ffi::OsStrExt;
    // SAFETY: zero is a valid sockaddr_un representation used only for its array capacity.
    let address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    let bytes = path.as_os_str().as_bytes();
    if bytes.len() >= address.sun_path.len() || bytes.contains(&0) {
        return Err(CoreError::new(
            CoreErrorCode::ControlPathTooLong,
            "Private control socket path exceeds the native Unix path limit.",
            "Choose a shorter absolute ARIADNE_HOME directory.",
        ));
    }
    Ok(())
}
fn socket_metadata(path: &Path) -> Result<fs::Metadata, CoreError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|e| io_error("Inspect private control socket", e))?;
    if !metadata.file_type().is_socket()
        || metadata.uid() != uid()
        || metadata.mode() & 0o777 != 0o600
    {
        return Err(error(
            CoreErrorCode::PermissionDenied,
            "Control endpoint must be an owned Unix socket with mode 0600, without symlinks.",
        ));
    }
    Ok(metadata)
}
/// Resolve only the fixed private endpoint, never caller-chosen arbitrary socket paths.
pub fn control_path(home: &Path) -> Result<PathBuf, CoreError> {
    let home = Directory::home(home, false)?;
    let run = home.child("run", false)?;
    home.validate_path()?;
    run.validate_path()?;
    let path = run.path.join("control.sock");
    path_limit(&path)?;
    socket_metadata(&path)?;
    Ok(path)
}
pub struct ControlServer {
    _owner: DesktopOwner,
    listener: std::os::unix::net::UnixListener,
    core: Arc<dyn CoreService>,
    bindings: Arc<HashMap<String, (BindingLease, ClaimGate)>>,
    binding_connect: bool,
}
impl ControlServer {
    /// Blocking native setup. Holding DesktopOwner proves stale removal is permitted.
    pub fn bind(
        owner: DesktopOwner,
        core: Arc<dyn CoreService>,
        bindings: Vec<(BindingLease, ClaimGate)>,
    ) -> Result<Self, CoreError> {
        owner.home.validate_path()?;
        owner.run.validate_path()?;
        let path = owner.control_path();
        path_limit(&path)?;
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                socket_metadata(&path)?;
                fs::remove_file(&path).map_err(|e| {
                    io_error(
                        "Remove validated stale control socket after instance lease",
                        e,
                    )
                })?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_error("Inspect stale control endpoint", e)),
        }
        let listener = std::os::unix::net::UnixListener::bind(&path)
            .map_err(|e| io_error("Bind private control socket", e))?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|e| io_error("Set private socket mode", e))?;
        socket_metadata(&path)?;
        listener
            .set_nonblocking(true)
            .map_err(|e| io_error("Set control listener nonblocking", e))?;
        let mut routes = HashMap::new();
        for (lease, gate) in bindings {
            if routes
                .insert(lease.binding_id().as_str().to_owned(), (lease, gate))
                .is_some()
            {
                return Err(error(
                    CoreErrorCode::BindingConflict,
                    "Duplicate binding supplied to the desktop control server.",
                ));
            }
        }
        Ok(Self {
            _owner: owner,
            listener,
            core,
            bindings: Arc::new(routes),
            binding_connect: false,
        })
    }
    /// Native composition opts in only with its real configured CoreService.
    /// This bootstrap route grants no dispatch lease or supervisor readiness.
    pub fn with_binding_connect(mut self) -> Self {
        self.binding_connect = true;
        self
    }
    pub async fn serve(self, mut stop: oneshot::Receiver<()>) -> Result<(), CoreError> {
        let listener = UnixListener::from_std(self.listener)
            .map_err(|e| io_error("Adopt private control listener", e))?;
        let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
        let mut connections = tokio::task::JoinSet::new();
        loop {
            let accepted = tokio::select! {
                biased;
                _ = &mut stop => return Ok(()),
                _ = connections.join_next(), if !connections.is_empty() => continue,
                accepted = listener.accept() => accepted,
            };
            let (stream, _) = accepted.map_err(|e| io_error("Accept control connection", e))?;
            let Ok(slot) = slots.clone().try_acquire_owned() else {
                continue;
            };
            let Ok(peer) = stream.peer_cred() else {
                continue;
            };
            if peer.uid() != uid() {
                continue;
            }
            let core = self.core.clone();
            let bindings = self.bindings.clone();
            let binding_connect = self.binding_connect;
            let deadline = Instant::now() + CONTROL_TIMEOUT;
            connections.spawn(async move {
                let slot = Arc::new(slot);
                let _ = tokio::time::timeout_at(
                    tokio::time::Instant::from_std(deadline),
                    handle(stream, core, bindings, binding_connect, slot, deadline),
                )
                .await;
            });
        }
    }
}
async fn handle(
    mut stream: UnixStream,
    core: Arc<dyn CoreService>,
    bindings: Arc<HashMap<String, (BindingLease, ClaimGate)>>,
    binding_connect: bool,
    slot: Arc<tokio::sync::OwnedSemaphorePermit>,
    deadline: Instant,
) -> Result<(), CoreError> {
    let bytes = codec::read_frame(&mut stream).await?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| {
        error(
            CoreErrorCode::InvalidArgument,
            "Control frame is malformed UTF-8 JSON.",
        )
    })?;
    let Some(id) = value
        .get("id")
        .and_then(|id| serde_json::from_value(id.clone()).ok())
    else {
        return Err(error(
            CoreErrorCode::InvalidArgument,
            "Control request has no trusted UUID id.",
        ));
    };
    // Decode the original bytes again so duplicate fields cannot disappear through Value.
    let request: Result<ControlRequest, _> = serde_json::from_slice(&bytes);
    let result = match request {
        Err(_) => Err(error(
            CoreErrorCode::InvalidArgument,
            "Control request has invalid method/params/envelope.",
        )),
        Ok(request) => match request.validate() {
            Err(e) => Err(e),
            Ok(()) => {
                if let ControlMethod::BindingConnect(request) = request.method {
                    if !binding_connect {
                        Err(CoreError::new(CoreErrorCode::Unsupported,
                            "Native binding connect is not configured on this desktop.",
                            "Use matching installed app/helper versions with native provider verification; retain the original operation ID."))
                    } else if Instant::now() >= deadline {
                        Err(connect_unavailable())
                    } else {
                        tokio::task::spawn_blocking(move || {
                            let _retained_slot = slot;
                            if Instant::now() >= deadline {
                                return Err(connect_unavailable());
                            }
                            let context = OwnerContext::from_trusted_entrypoint(OwnerScope::Registry);
                            let receipt = core.execute_owner(context, request.command.clone())?;
                            wire::validate_connect_receipt(&request, &receipt)?;
                            Ok(ControlResult::BindingConnect(receipt))
                        }).await.map_err(|_| CoreError::new(CoreErrorCode::HostUnreachable,
                            "Blocking native binding connect did not return a receipt.",
                            "Retain the original operation ID and parameters; effects may already exist. Look up its exact saved receipt before repeating that operation."))?
                    }
                } else {
                    let scope = request.scope().ok_or_else(|| {
                        error(
                            CoreErrorCode::InvalidArgument,
                            "Control method requires its declared binding scope.",
                        )
                    })?;
                    match bindings.get(scope.binding_id.as_str()) {
                        None => Err(error(
                            CoreErrorCode::NotFound,
                            "No current desktop supervisor holds this binding lease.",
                        )),
                        Some((lease, gate)) => match lease.context(
                            &scope.binding_id,
                            if matches!(request.method, ControlMethod::Claim(_)) {
                                lease.generation()
                            } else {
                                &scope.generation
                            },
                        ) {
                            Err(e) => Err(e),
                            Ok(context) => match request.method {
                                ControlMethod::Ping(scope) => Ok(ControlResult::Ping(scope)),
                                ControlMethod::Claim(request) => {
                                    let lease = lease.clone();
                                    let slot = slot.clone();
                                    gate.admit(|| tokio::task::spawn_blocking(move || {
                                    let _retained_lease = lease;
                                    let _retained_slot = slot;
                                    let result = core.claim(context, request.clone())?;
                                    if let Some(result) = &result { result.validate_for(&request)?; }
                                    Ok(ControlResult::Claim(result))
                                }))?.await.map_err(|_| error(CoreErrorCode::HostUnreachable, "Blocking core claim failed; reuse the same claim request ID to recover its possibly saved receipt."))?
                                }
                                ControlMethod::ConnectionStatus(_) => {
                                    let lease = lease.clone();
                                    let slot = slot.clone();
                                    tokio::task::spawn_blocking(move || {
                                        let _retained_slot = slot;
                                        status(core.as_ref(), &lease)
                                    })
                                    .await
                                    .map_err(|_| {
                                        error(
                                            CoreErrorCode::HostUnreachable,
                                            "Blocking core status read failed.",
                                        )
                                    })?
                                }
                                ControlMethod::BindingConnect(_) => Err(error(
                                    CoreErrorCode::InvalidArgument,
                                    "Binding connect cannot use the lease-required route.",
                                )),
                            },
                        },
                    }
                }
            }
        },
    };
    codec::write(&mut stream, &ControlResponse::from_result(id, result)).await
}
fn connect_unavailable() -> CoreError {
    CoreError::new(CoreErrorCode::HostUnreachable,
        "Native binding connect is unavailable or exceeded its control deadline.",
        "Open the matching desktop for new provider verification. Retain the original operation ID and parameters; effects may already exist after response loss. Check its exact saved receipt before repeating that operation.")
}
fn status(core: &dyn CoreService, lease: &BindingLease) -> Result<ControlResult, CoreError> {
    let context = QueryContext::owner(OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        lease.session().clone(),
    )));
    let request = QueryRequest::SessionGet {};
    let result = core.query(context.clone(), request.clone())?;
    result.validate_for(&context, &request)?;
    let QueryResult::SessionGet(snapshot) = result else {
        return Err(error(
            CoreErrorCode::ProtocolConflict,
            "Core returned a different query for control connection status.",
        ));
    };
    let binding = snapshot
        .session
        .bindings
        .0
        .get(lease.binding_id())
        .ok_or_else(|| {
            error(
                CoreErrorCode::NotFound,
                "Registered session no longer contains this binding.",
            )
        })?;
    if &binding.generation != lease.generation() {
        return Err(error(
            CoreErrorCode::StaleGeneration,
            "Persisted binding generation changed.",
        ));
    }
    Ok(ControlResult::Status(BindingSummary {
        id: binding.id.clone(),
        adapter_id: binding.adapter_id.clone(),
        external_session_id: binding.external_session_id.clone(),
        generation: binding.generation.clone(),
        dispatch_state: binding.dispatch_state.clone(),
        owner_paused: binding.owner_paused,
        pause_reason: binding.pause_reason.clone(),
        connection_state: binding.connection_state.clone(),
        presence: None,
    }))
}
/// Native client. One absolute timeout includes validation, connect and complete frame IO.
pub async fn call(home: PathBuf, request: ControlRequest) -> Result<ControlResult, CoreError> {
    request.validate()?;
    let binding_connect = matches!(request.method, ControlMethod::BindingConnect(_));
    timeout(CONTROL_TIMEOUT, async move {
        let response: ControlResponse = async {
        let path = tokio::task::spawn_blocking(move || control_path(&home)).await.map_err(|_| error(CoreErrorCode::HostUnreachable, "Private endpoint validation failed."))??;
        let mut stream = UnixStream::connect(path).await.map_err(|e| io_error("Connect desktop control socket", e))?;
        if stream.peer_cred().map_err(|e| io_error("Verify desktop peer UID", e))?.uid() != uid() { return Err(error(CoreErrorCode::PermissionDenied, "Desktop control peer UID differs.")); }
        codec::write(&mut stream, &request).await?;
        codec::read(&mut stream).await
        }.await.map_err(|mut cause: CoreError| {
            if binding_connect && cause.code == CoreErrorCode::HostUnreachable {
                cause.hint = connect_unavailable().hint;
            }
            cause
        })?;
        response.into_result(&request)
    }).await.map_err(|_| if binding_connect { connect_unavailable() } else { error(CoreErrorCode::HostUnreachable, "Desktop control exceeded its 5-second frame IO bound; reuse the same claim request ID after a possibly saved claim.") })?
}
/// CLI-only blocking entrypoint. Async/native UI callers use call instead.
pub fn call_blocking(home: PathBuf, request: ControlRequest) -> Result<ControlResult, CoreError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| io_error("Create bridge IPC runtime", e))?
        .block_on(call(home, request))
}
