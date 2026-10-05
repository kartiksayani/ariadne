//! Read-only existing-daemon history. Run these blocking operations off an async executor.
mod daemon;
mod normalize;
mod preflight;
use crate::{
    generated::v0_160_0 as wire,
    transport::{error, ExecutableIdentity, RpcClient, SocketIdentity, SUPPORTED_CODEX_VERSION},
};
use ariadne_agent_protocol::{
    host_version::{accepted_range, classify_host_version, HostVersionStatus},
    AdapterError, AdapterErrorCode as Code, Capabilities, Capability, ConnectRequest,
    ConnectResult, DeliveryMode, EndpointRef, PresenceObservation, ReconcileRequest,
    ReconcileResult, UtcMillis, UuidV4,
};
use ariadne_domain::models::{ConnectionState, ExecutionState, Freshness, PresenceSource};
pub use daemon::CodexDaemonReader;
pub use preflight::{CodexHostFacts, QualifiedCodexThread};
use std::{
    collections::{HashMap, HashSet},
    env,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

/// Explicit executable selection is mandatory; there is no host launch or PATH fallback.
#[derive(Clone, Debug)]
pub struct CodexOptions {
    pub executable: PathBuf,
    pub codex_home: PathBuf,
}
impl CodexOptions {
    /// A detected version is diagnostic only and never qualifies a daemon/thread.
    pub fn read_host_version(&self, deadline: Instant) -> Result<String, AdapterError> {
        ExecutableIdentity::read(&self.executable)?
            .read_version_before(deadline.min(Instant::now() + Duration::from_secs(5)))
    }
    /// Reads only CODEX_HOME/HOME, never provider credentials or configuration files.
    pub fn from_environment(executable: PathBuf) -> Result<Self, AdapterError> {
        let codex_home = env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")))
            .ok_or_else(|| {
                error(
                    Code::InvalidArgument,
                    "Set CODEX_HOME or provide the Codex home explicitly.",
                )
            })?;
        Self::new(executable, codex_home)
    }
    pub fn new(executable: PathBuf, codex_home: PathBuf) -> Result<Self, AdapterError> {
        if !executable.is_absolute() || !codex_home.is_absolute() {
            return Err(error(
                Code::InvalidArgument,
                "Codex executable and home must be absolute paths.",
            ));
        }
        Ok(Self {
            executable,
            codex_home,
        })
    }
    /// Build the canonical default endpoint before constructing a ConnectRequest.
    pub fn default_endpoint(&self) -> Result<EndpointRef, AdapterError> {
        let path = self
            .codex_home
            .join("app-server-control/app-server-control.sock");
        Ok(EndpointRef::UnixSocket {
            path: path
                .to_str()
                .ok_or_else(|| error(Code::InvalidArgument, "Codex endpoint must be UTF-8."))?
                .to_owned(),
        })
    }
    pub fn endpoint_path(&self, endpoint: &EndpointRef) -> Result<PathBuf, AdapterError> {
        let EndpointRef::UnixSocket { path } = endpoint else {
            return Err(error(
                Code::InvalidArgument,
                "Codex requires a local Unix socket endpoint.",
            ));
        };
        let resolved = PathBuf::from(path);
        if !resolved.is_absolute() {
            return Err(error(
                Code::InvalidArgument,
                "Codex socket path must be absolute.",
            ));
        }
        Ok(resolved)
    }
}

/// Read-only metadata, deliberately omitting rollout paths, previews and raw items.
#[derive(Debug, Clone, PartialEq)]
pub struct ThreadCandidate {
    pub external_session_id: String,
    pub cwd: PathBuf,
    pub title: Option<String>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct DiscoveryPage {
    pub candidates: Vec<ThreadCandidate>,
    pub next_cursor: Option<String>,
}

/// Provider-private continuation, never a domain checkpoint or proof of non-delivery.
/// Keep this across bounded calls; reset only for an explicit new reconciliation pass.
pub struct HistoryScan {
    thread_id: String,
    endpoint: ariadne_agent_protocol::EndpointFingerprint,
    anchor: Option<String>,
    cursor: Option<String>,
    scope: Option<String>,
    seen_cursors: HashSet<String>,
    matched_turns: HashMap<UuidV4, String>,
    message_identities: HashMap<UuidV4, UserMessageIdentity>,
    progress: ScanProgress,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScanProgress {
    pub anchor_reached: bool,
    pub exhausted: bool,
    pub has_more: bool,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserMessageIdentity {
    pub host_turn_id: String,
    pub host_message_id: String,
    pub client_id: Option<String>,
}
impl HistoryScan {
    pub fn user_message_identity(&self, attempt_id: &UuidV4) -> Option<&UserMessageIdentity> {
        self.message_identities.get(attempt_id)
    }
    pub fn progress(&self) -> ScanProgress {
        self.progress
    }
}

/// Owns only the observer socket. Dropping it never stops the external Codex host.
pub struct CodexHistoryClient {
    daemon: CodexDaemonReader,
    binding_id: UuidV4,
    generation: UuidV4,
    instance_id: UuidV4,
    thread_id: String,
    latest_anchor: Option<String>,
}
impl CodexHistoryClient {
    pub fn connect(
        options: CodexOptions,
        request: ConnectRequest,
        instance_id: UuidV4,
        observed_at: UtcMillis,
    ) -> Result<(Self, ConnectResult), AdapterError> {
        request.validate()?;
        let deadline = Instant::now() + Duration::from_secs(10);
        let daemon = CodexDaemonReader::open_before(options, request.endpoint.clone(), deadline)?;
        daemon.bind_before(request, instance_id, observed_at, deadline)
    }
    /// Read-only compatibility/liveness fence. A failed read invalidates this connection.
    pub fn presence(
        &mut self,
        observed_at: UtcMillis,
    ) -> Result<PresenceObservation, AdapterError> {
        let result = self
            .read_thread(Instant::now() + Duration::from_secs(5))
            .map(|thread| self.presence_for(&thread, observed_at));
        self.fence(result)
    }
    pub fn latest_anchor(&self) -> Option<&str> {
        self.latest_anchor.as_deref()
    }
    pub fn resolved_socket(&self) -> &Path {
        &self.daemon.socket.path
    }
    pub fn begin_scan(&self, anchor: Option<String>) -> Result<HistoryScan, AdapterError> {
        self.verify_identity()?;
        if let Some(anchor) = &anchor {
            bounded_identifier(anchor)?;
        }
        Ok(HistoryScan {
            thread_id: self.thread_id.clone(),
            endpoint: self.daemon.socket.fingerprint(),
            anchor,
            cursor: None,
            scope: None,
            seen_cursors: HashSet::new(),
            matched_turns: HashMap::new(),
            message_identities: HashMap::new(),
            progress: ScanProgress {
                anchor_reached: false,
                exhausted: false,
                has_more: true,
            },
        })
    }
    /// Discovery orchestration/refresh belongs to P3.7; this returns one read-only page.
    pub fn discover(&mut self, cursor: Option<String>) -> Result<DiscoveryPage, AdapterError> {
        self.daemon.discover(cursor)
    }
    /// Bounded full-item reconciliation, at most 1000 turns/50 pages/ten seconds per call.
    /// Returned facts do not commit domain effects or advance a durable checkpoint.
    pub fn read_history(
        &mut self,
        request: ReconcileRequest,
        scan: &mut HistoryScan,
        observed_at: UtcMillis,
    ) -> Result<ReconcileResult, AdapterError> {
        self.read_history_before(
            request,
            scan,
            observed_at,
            Instant::now() + Duration::from_secs(10),
        )
    }
    pub(crate) fn read_history_before(
        &mut self,
        request: ReconcileRequest,
        scan: &mut HistoryScan,
        observed_at: UtcMillis,
        deadline: Instant,
    ) -> Result<ReconcileResult, AdapterError> {
        let result = self.read_history_inner(&request, scan, observed_at, deadline);
        self.fence(result)
    }
    fn read_history_inner(
        &mut self,
        request: &ReconcileRequest,
        scan: &mut HistoryScan,
        observed_at: UtcMillis,
        deadline: Instant,
    ) -> Result<ReconcileResult, AdapterError> {
        request.validate()?;
        if request.attempts.len() > 100 {
            return Err(error(
                Code::InvalidArgument,
                "Codex reconciliation supports at most 100 attempts; request a narrower batch.",
            ));
        }
        for attempt in &request.attempts {
            if attempt.wire_marker.is_empty()
                || attempt.wire_marker.len() > 4096
                || attempt.wire_marker.contains(['\n', '\r'])
            {
                return Err(error(
                    Code::InvalidArgument,
                    "Codex correlation marker must be one nonempty line of at most 4 KiB.",
                ));
            }
        }
        self.verify_scope(&request.binding_id, &request.generation)?;
        self.verify_identity()?;
        if scan.thread_id != self.thread_id || scan.endpoint != self.daemon.socket.fingerprint() {
            return Err(error(
                Code::BindingMismatch,
                "Codex history continuation belongs to another endpoint/thread.",
            ));
        }
        let scope =
            normalize::digest(&serde_json::to_vec(request).map_err(|_| {
                error(Code::InvalidArgument, "Cannot encode reconciliation scope.")
            })?);
        if scan.scope.as_ref().is_some_and(|prior| prior != &scope) {
            return Err(error(
                Code::BindingMismatch,
                "Codex history continuation belongs to another reconciliation request.",
            ));
        }
        scan.scope = Some(scope);
        let mut result = ReconcileResult {
            attempt_evidence: Vec::new(),
            unresolved_attempt_ids: request
                .attempts
                .iter()
                .map(|attempt| attempt.attempt_id.clone())
                .collect(),
            next_checkpoint: request.checkpoint.clone(),
        };
        if !scan.progress.has_more {
            result.validate_for(request)?;
            return Ok(result);
        }
        // Reverify exact selected thread identity/status before accepting page evidence.
        let thread = self.read_thread(deadline)?;
        if matches!(
            thread.status,
            wire::thread_read_response::ThreadStatus::NotLoaded
                | wire::thread_read_response::ThreadStatus::SystemError
        ) {
            return Err(error(
                Code::HostUnreachable,
                "Selected Codex thread is unavailable; reconciliation remains unresolved.",
            ));
        }
        let mut seen_turns = HashSet::new();
        for _ in 0..50 {
            let page = self.turn_page(scan.cursor.clone(), 20, deadline)?;
            for turn in &page.data {
                if Instant::now() >= deadline {
                    return Err(error(
                        Code::HostUnreachable,
                        "Codex reconciliation deadline expired; start a fresh bounded read.",
                    ));
                }
                if !seen_turns.insert(turn.id.clone()) {
                    return Err(error(
                        Code::ProtocolConflict,
                        "Codex repeated a turn across history pages.",
                    ));
                }
                if Some(&turn.id) == scan.anchor.as_ref() {
                    scan.progress = ScanProgress {
                        anchor_reached: true,
                        exhausted: false,
                        has_more: false,
                    };
                    break;
                }
                normalize::match_turn(turn, request, scan, &mut result, observed_at.clone())?;
            }
            if scan.progress.anchor_reached {
                break;
            }
            let Some(cursor) = page.next_cursor else {
                scan.progress = ScanProgress {
                    anchor_reached: false,
                    exhausted: true,
                    has_more: false,
                };
                break;
            };
            bounded_identifier(&cursor)?;
            if !scan.seen_cursors.insert(cursor.clone()) {
                return Err(error(
                    Code::ProtocolConflict,
                    "Codex history repeated a pagination cursor.",
                ));
            }
            if scan.seen_cursors.len() > 4096 {
                return Err(error(Code::Unsupported, "Codex reconciliation pass exceeded its continuation bound; start an explicit new pass."));
            }
            scan.cursor = Some(cursor);
        }
        self.verify_identity()?;
        result.validate_for(request)?;
        Ok(result)
    }
    fn turn_page(
        &mut self,
        cursor: Option<String>,
        limit: u32,
        deadline: Instant,
    ) -> Result<wire::thread_turns_list_response::ThreadTurnsListResponse, AdapterError> {
        self.daemon
            .turn_page_id(&self.thread_id, cursor, limit, deadline)
    }

    fn read_thread(
        &mut self,
        deadline: Instant,
    ) -> Result<wire::thread_read_response::Thread, AdapterError> {
        self.verify_identity()?;
        self.read_thread_id(&self.thread_id.clone(), deadline)
    }
    fn read_thread_id(
        &mut self,
        id: &str,
        deadline: Instant,
    ) -> Result<wire::thread_read_response::Thread, AdapterError> {
        self.daemon.read_thread_id(id, deadline)
    }
    fn presence_for(
        &self,
        thread: &wire::thread_read_response::Thread,
        observed_at: UtcMillis,
    ) -> PresenceObservation {
        use wire::thread_read_response::{ThreadActiveFlag, ThreadStatus};
        let execution_state = match &thread.status {
            ThreadStatus::Idle => ExecutionState::Idle,
            ThreadStatus::Active(flags) if flags.contains(&ThreadActiveFlag::WaitingOnApproval) => {
                ExecutionState::WaitingForApproval
            }
            ThreadStatus::Active(flags)
                if flags.contains(&ThreadActiveFlag::WaitingOnUserInput) =>
            {
                ExecutionState::Unknown
            }
            ThreadStatus::Active(_) => ExecutionState::Running,
            _ => ExecutionState::Unknown,
        };
        PresenceObservation {
            instance_id: self.instance_id.clone(),
            generation: self.generation.clone(),
            connection_state: ConnectionState::Connected,
            execution_state,
            last_seen_at: Some(observed_at),
            source: Some(PresenceSource::HostPoll),
            process_identity: None,
            freshness: Freshness::Fresh,
        }
    }
    pub(crate) fn verify_scope(
        &self,
        binding_id: &UuidV4,
        generation: &UuidV4,
    ) -> Result<(), AdapterError> {
        if binding_id != &self.binding_id {
            return Err(error(
                Code::BindingMismatch,
                "Codex reader belongs to another binding.",
            ));
        }
        if generation != &self.generation {
            return Err(error(
                Code::StaleGeneration,
                "Codex reader belongs to an older binding generation.",
            ));
        }
        Ok(())
    }
    pub(crate) fn verify_identity(&self) -> Result<(), AdapterError> {
        self.daemon.verify_identity()
    }
    /// Fresh pre-submit anchor, captured before the native sender is spawned.
    pub(crate) fn prepare_queue(
        &mut self,
        deadline: Instant,
    ) -> Result<Option<String>, AdapterError> {
        let result = self.prepare_queue_inner(deadline);
        self.fence(result)
    }
    fn prepare_queue_inner(&mut self, deadline: Instant) -> Result<Option<String>, AdapterError> {
        let thread = self.read_thread(deadline)?;
        if matches!(
            thread.status,
            wire::thread_read_response::ThreadStatus::NotLoaded
                | wire::thread_read_response::ThreadStatus::SystemError
        ) {
            return Err(error(
                Code::HostUnreachable,
                "Selected Codex thread is unavailable; sender was not spawned.",
            ));
        }
        let page = self.turn_page(None, 20, deadline)?;
        self.verify_identity()?;
        Ok(page.data.first().map(|turn| turn.id.clone()))
    }
    pub(crate) fn queue_executable(&self) -> &Path {
        self.daemon.queue_executable()
    }
    pub(crate) fn presence_before(
        &mut self,
        observed_at: UtcMillis,
        deadline: Instant,
    ) -> Result<PresenceObservation, AdapterError> {
        let result = self
            .read_thread(deadline)
            .map(|thread| self.presence_for(&thread, observed_at));
        self.fence(result)
    }
    fn fence<T>(&mut self, result: Result<T, AdapterError>) -> Result<T, AdapterError> {
        self.daemon.fence(result)
    }
}
/// Daemon `userAgent` is `codex-tui/<version> <platform...>`; apply the shared rule to it.
fn daemon_version_status(user_agent: &str) -> Option<HostVersionStatus> {
    let (product, _) = user_agent.split_once(' ')?;
    classify_host_version(SUPPORTED_CODEX_VERSION, product.strip_prefix("codex-tui/")?)
}
fn bounded_identifier(id: &str) -> Result<(), AdapterError> {
    if id.is_empty() || id.len() > 4096 {
        return Err(error(
            Code::IncompatibleAdapter,
            "Codex returned an empty or oversized identity/cursor.",
        ));
    }
    Ok(())
}
fn read_capabilities() -> Capabilities {
    let yes = || Capability {
        supported: true,
        conditions: vec![format!(
            "Read-only, initialized Codex {} existing daemon/thread.",
            accepted_range(SUPPORTED_CODEX_VERSION)
        )],
    };
    let no = || Capability {
        supported: false,
        conditions: vec![
            "Submission and domain commands require the later Codex queue adapter.".to_owned(),
        ],
    };
    Capabilities {
        existing_session: yes(),
        deferred_delivery: no(),
        turn_correlation: yes(),
        turn_completion: yes(),
        domain_cli: no(),
        domain_mcp: no(),
        history_reconcile: yes(),
        streaming_output: no(),
        final_text_read: yes(),
        discover_sessions: yes(),
        delivery_mode: DeliveryMode::Push,
    }
}
