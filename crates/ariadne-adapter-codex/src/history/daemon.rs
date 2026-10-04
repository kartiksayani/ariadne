//! Unbound read-only daemon transport for discovery before explicit owner selection.
use super::*;

pub struct CodexDaemonReader {
    pub(super) rpc: RpcClient,
    pub(super) socket: SocketIdentity,
    pub(super) configured_socket: PathBuf,
    executable: ExecutableIdentity,
    configured_executable: PathBuf,
    usable: bool,
}
impl CodexDaemonReader {
    pub(crate) fn queue_executable(&self) -> &Path {
        self.executable.path()
    }
    pub fn open(options: CodexOptions, endpoint: EndpointRef) -> Result<Self, AdapterError> {
        Self::open_before(options, endpoint, Instant::now() + Duration::from_secs(10))
    }
    /// Blocking native initialization under the caller's absolute admission deadline.
    /// Pass that same deadline to selected-thread qualification; run outside locks
    /// and off the executor. `open` retains its ten-second convenience default.
    pub fn open_before(
        options: CodexOptions,
        endpoint: EndpointRef,
        deadline: Instant,
    ) -> Result<Self, AdapterError> {
        let configured_socket = options.endpoint_path(&endpoint)?;
        let executable = ExecutableIdentity::read(&options.executable)?;
        executable.version_before(deadline)?;
        let socket = SocketIdentity::read(&configured_socket)?;
        let stream = socket.connect(deadline)?;
        socket.verify_peer(&stream)?;
        if SocketIdentity::read(&configured_socket)? != socket {
            return Err(error(
                Code::BindingMismatch,
                "Codex socket changed during connect; initialize again.",
            ));
        }
        let mut rpc = RpcClient::open(stream, deadline)?;
        let initialized: wire::initialize_response::InitializeResponse = rpc.request(
            "initialize",
            &wire::initialize_params::InitializeParams {
                client_info: wire::initialize_params::ClientInfo {
                    name: "ariadne".to_owned(),
                    title: None,
                    version: env!("CARGO_PKG_VERSION").to_owned(),
                },
                capabilities: Some(wire::initialize_params::InitializeCapabilities {
                    experimental_api: true,
                    explicit_gateway_oauth: None,
                    extensions: None,
                    mcp_server_openai_form_elicitation: None,
                    opt_out_notification_methods: None,
                    request_attestation: false,
                }),
            },
            deadline,
        )?;
        if !supported_daemon(&initialized.user_agent) || initialized.platform_family != "unix" {
            return Err(error(
                Code::UnsupportedHostVersion,
                "Initialized Codex daemon must match the supported CLI 0.160.0 pair.",
            ));
        }
        rpc.notify_initialized()?;
        let reader = Self {
            rpc,
            socket,
            configured_socket,
            executable,
            configured_executable: options.executable,
            usable: true,
        };
        reader.verify_identity()?;
        Ok(reader)
    }
    /// Explicit selected-thread binding reuses the initialized transport; discovery never binds.
    pub fn bind(
        self,
        request: ConnectRequest,
        instance_id: UuidV4,
        observed_at: UtcMillis,
    ) -> Result<(CodexHistoryClient, ConnectResult), AdapterError> {
        self.bind_before(
            request,
            instance_id,
            observed_at,
            Instant::now() + Duration::from_secs(10),
        )
    }
    pub(crate) fn bind_before(
        self,
        request: ConnectRequest,
        instance_id: UuidV4,
        observed_at: UtcMillis,
        deadline: Instant,
    ) -> Result<(CodexHistoryClient, ConnectResult), AdapterError> {
        self.bind_with_root(request, instance_id, observed_at, None, deadline)
    }
    pub(super) fn bind_with_root(
        mut self,
        request: ConnectRequest,
        instance_id: UuidV4,
        observed_at: UtcMillis,
        expected_root: Option<&Path>,
        deadline: Instant,
    ) -> Result<(CodexHistoryClient, ConnectResult), AdapterError> {
        request.validate()?;
        self.verify_identity()?;
        let EndpointRef::UnixSocket { path } = &request.endpoint else {
            return Err(error(
                Code::InvalidArgument,
                "Codex binding requires a Unix socket endpoint.",
            ));
        };
        if SocketIdentity::read(Path::new(path))? != self.socket {
            return Err(error(
                Code::BindingMismatch,
                "Selected Codex binding uses another endpoint; initialize it explicitly.",
            ));
        }
        let selected =
            self.selected_thread(&request.external_session_id, expected_root, deadline)?;
        let client = CodexHistoryClient {
            daemon: self,
            binding_id: request.binding_id.clone(),
            generation: request.generation.clone(),
            instance_id,
            thread_id: request.external_session_id.clone(),
            latest_anchor: selected.latest_anchor,
        };
        let result = ConnectResult {
            external_session_id: client.thread_id.clone(),
            endpoint_fingerprint: client.daemon.socket.fingerprint(),
            capabilities: read_capabilities(),
            observation: client.presence_for(&selected.metadata, observed_at),
        };
        result.validate_for(&request)?;
        Ok((client, result))
    }
    /// One loaded page plus at most twenty metadata joins, under one ten-second deadline.
    /// Caller retains the cursor and schedules more pages while the connection UI is open.
    pub fn discover(&mut self, cursor: Option<String>) -> Result<DiscoveryPage, AdapterError> {
        let result = self.discover_inner(cursor);
        // Unsupported discovery leaves manual exact-thread reading available.
        if result.as_ref().is_err_and(|e| e.code == Code::Unsupported) {
            return result;
        }
        self.fence(result)
    }
    fn discover_inner(&mut self, cursor: Option<String>) -> Result<DiscoveryPage, AdapterError> {
        self.verify_identity()?;
        if let Some(cursor) = &cursor {
            bounded_identifier(cursor)?;
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        let page: wire::thread_loaded_list_response::ThreadLoadedListResponse = self.rpc.request(
            "thread/loaded/list",
            &wire::thread_loaded_list_params::ThreadLoadedListParams {
                cursor: cursor.clone(),
                limit: Some(20),
            },
            deadline,
        )?;
        if page.data.len() > 20
            || page
                .next_cursor
                .as_ref()
                .is_some_and(|next| Some(next) == cursor.as_ref())
        {
            return Err(error(
                Code::IncompatibleAdapter,
                "Codex loaded discovery exceeded its bound or repeated its cursor.",
            ));
        }
        if let Some(next) = &page.next_cursor {
            bounded_identifier(next)?;
        }
        let mut candidates = Vec::new();
        let mut seen = HashSet::new();
        for id in page.data {
            bounded_identifier(&id)?;
            if !seen.insert(id.clone()) {
                return Err(error(
                    Code::ProtocolConflict,
                    "Codex loaded discovery repeated a thread identity.",
                ));
            }
            let thread = self.read_thread_id(&id, deadline)?;
            if matches!(
                thread.status,
                wire::thread_read_response::ThreadStatus::NotLoaded
            ) {
                continue;
            }
            candidates.push(ThreadCandidate {
                external_session_id: id,
                cwd: PathBuf::from(thread.cwd.as_str()),
                title: thread.name.map(|title| normalize::bounded_text(&title).0),
            });
        }
        self.verify_identity()?;
        Ok(DiscoveryPage {
            candidates,
            next_cursor: page.next_cursor,
        })
    }
    pub(super) fn read_thread_id(
        &mut self,
        id: &str,
        deadline: Instant,
    ) -> Result<wire::thread_read_response::Thread, AdapterError> {
        let response: wire::thread_read_response::ThreadReadResponse = self.rpc.request(
            "thread/read",
            &wire::thread_read_params::ThreadReadParams {
                thread_id: id.to_owned(),
                include_turns: Some(false),
            },
            deadline,
        )?;
        if response.thread.id != id {
            return Err(error(
                Code::BindingMismatch,
                "Codex returned a different thread; select the original session explicitly.",
            ));
        }
        if !Path::new(response.thread.cwd.as_str()).is_absolute() {
            return Err(error(
                Code::IncompatibleAdapter,
                "Codex metadata cwd is not absolute.",
            ));
        }
        Ok(response.thread)
    }
    pub(super) fn verify_identity(&self) -> Result<(), AdapterError> {
        if !self.usable {
            return Err(error(
                Code::HostUnreachable,
                "Codex reader requires a fresh initialize/connect before further reads.",
            ));
        }
        if ExecutableIdentity::read(&self.configured_executable)? != self.executable {
            return Err(error(
                Code::UnsupportedHostVersion,
                "Codex executable identity changed; re-probe before dispatch.",
            ));
        }
        if SocketIdentity::read(&self.configured_socket)? != self.socket {
            return Err(error(
                Code::BindingMismatch,
                "Codex endpoint identity changed; reconnect and initialize again.",
            ));
        }
        Ok(())
    }
    pub(super) fn fence<T>(&mut self, result: Result<T, AdapterError>) -> Result<T, AdapterError> {
        if result.is_err() {
            self.usable = false;
        }
        result
    }
}
