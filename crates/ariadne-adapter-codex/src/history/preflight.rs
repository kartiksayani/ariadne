//! Shared read-only selected-thread checks, before any durable binding identity.
use super::*;
use ariadne_agent_protocol::{Availability, Compatibility, EndpointFingerprint};

/// Provider-owned facts, never deserialized authority or a durable binding.
#[derive(Debug, Clone)]
pub struct CodexHostFacts {
    pub external_session_id: String,
    pub canonical_root: PathBuf,
    pub endpoint: EndpointRef,
    pub host_version: String,
    pub endpoint_fingerprint: EndpointFingerprint,
    pub capabilities: Capabilities,
    pub compatibility: Compatibility,
    pub availability: Availability,
}

/// Owns one initialized reader qualified for one exact thread and project root.
/// Dropping it closes only the observer transport, never the external host.
pub struct QualifiedCodexThread {
    reader: CodexDaemonReader,
    facts: CodexHostFacts,
}
impl QualifiedCodexThread {
    pub fn facts(&self) -> &CodexHostFacts {
        &self.facts
    }
    /// After Core allocates final IDs, re-read the same thread/root before binding.
    /// Qualification cannot be reused for another selected thread or endpoint.
    pub fn bind(
        self,
        request: ConnectRequest,
        instance_id: UuidV4,
        observed_at: UtcMillis,
    ) -> Result<(CodexHistoryClient, ariadne_agent_protocol::ConnectResult), AdapterError> {
        self.bind_before(
            request,
            instance_id,
            observed_at,
            Instant::now() + Duration::from_secs(10),
        )
    }
    pub(crate) fn executable_identity(&self) -> ExecutableIdentity {
        self.reader.executable.clone()
    }
    pub(crate) fn options(&self) -> CodexOptions {
        self.reader.options.clone()
    }
    pub(crate) fn bind_before(
        self,
        request: ConnectRequest,
        instance_id: UuidV4,
        observed_at: UtcMillis,
        deadline: Instant,
    ) -> Result<(CodexHistoryClient, ariadne_agent_protocol::ConnectResult), AdapterError> {
        request.validate()?;
        if request.external_session_id != self.facts.external_session_id {
            return Err(error(
                Code::BindingMismatch,
                "Qualified Codex thread cannot be retargeted to another selected session.",
            ));
        }
        self.reader.bind_with_root(
            request,
            instance_id,
            observed_at,
            Some(&self.facts.canonical_root),
            deadline,
        )
    }
}

pub(super) struct SelectedThread {
    pub metadata: wire::thread_read_response::Thread,
    pub latest_anchor: Option<String>,
    pub canonical_root: Option<PathBuf>,
}

impl CodexDaemonReader {
    /// Blocking native pre-ID verification. Initialize the selected endpoint first,
    /// then pass the same absolute admission deadline across both operations.
    /// Run outside executor and Registry/Store locks; no IDs are allocated here.
    pub fn qualify_selected_thread(
        mut self,
        thread_id: &str,
        expected_root: &Path,
        deadline: Instant,
    ) -> Result<QualifiedCodexThread, AdapterError> {
        let deadline = deadline.min(Instant::now() + Duration::from_secs(10));
        if thread_id.trim().is_empty()
            || thread_id.contains('\0')
            || thread_id.len() > 4096
            || !expected_root.is_absolute()
        {
            return Err(error(
                Code::InvalidArgument,
                "Select a bounded exact thread ID and explicit absolute registered project root.",
            ));
        }
        before(deadline)?;
        let selected = self.selected_thread(thread_id, Some(expected_root), deadline)?;
        before(deadline)?;
        let facts = CodexHostFacts {
            external_session_id: thread_id.to_owned(),
            canonical_root: selected
                .canonical_root
                .expect("project-qualified selection has a canonical root"),
            endpoint: EndpointRef::UnixSocket {
                path: self
                    .configured_socket
                    .to_str()
                    .expect("selected endpoint originated as UTF-8")
                    .to_owned(),
            },
            host_version: self.host_version.clone(),
            endpoint_fingerprint: self.socket.fingerprint(),
            capabilities: crate::queue::queue_capabilities(read_capabilities()),
            compatibility: self.host_status.compatibility(),
            availability: Availability::Available,
        };
        Ok(QualifiedCodexThread {
            reader: self,
            facts,
        })
    }
    pub(super) fn selected_thread(
        &mut self,
        thread_id: &str,
        expected_root: Option<&Path>,
        deadline: Instant,
    ) -> Result<SelectedThread, AdapterError> {
        self.verify_identity()?;
        let metadata = self.read_thread_id(thread_id, deadline)?;
        if matches!(
            metadata.status,
            wire::thread_read_response::ThreadStatus::NotLoaded
                | wire::thread_read_response::ThreadStatus::SystemError
        ) {
            return Err(error(
                Code::HostUnreachable,
                "Selected Codex thread is not available in the existing daemon.",
            ));
        }
        let canonical_root = expected_root
            .map(|expected| {
                let root = canonical_directory(expected)?;
                if canonical_directory(Path::new(metadata.cwd.as_str()))? != root {
                    return Err(error(
                        Code::BindingMismatch,
                        "Selected Codex thread belongs to another canonical project root.",
                    ));
                }
                Ok(root)
            })
            .transpose()?;
        let queue: wire::thread_queue_list_response::ThreadQueueListResponse = self.rpc.request(
            "thread/queue/list",
            &wire::thread_queue_list_params::ThreadQueueListParams {
                thread_id: thread_id.to_owned(),
                cursor: None,
                limit: Some(20),
            },
            deadline,
        )?;
        if queue.data.len() > 20 {
            return Err(error(
                Code::IncompatibleAdapter,
                "Codex queue probe exceeded its page bound.",
            ));
        }
        let turns = self.turn_page_id(thread_id, None, 20, deadline)?;
        self.verify_identity()?;
        Ok(SelectedThread {
            metadata,
            latest_anchor: turns.data.first().map(|turn| turn.id.clone()),
            canonical_root,
        })
    }

    pub(super) fn turn_page_id(
        &mut self,
        thread_id: &str,
        cursor: Option<String>,
        limit: u32,
        deadline: Instant,
    ) -> Result<wire::thread_turns_list_response::ThreadTurnsListResponse, AdapterError> {
        let page: wire::thread_turns_list_response::ThreadTurnsListResponse = self.rpc.request(
            "thread/turns/list",
            &wire::thread_turns_list_params::ThreadTurnsListParams {
                thread_id: thread_id.to_owned(),
                cursor,
                limit: Some(limit),
                sort_direction: Some(wire::thread_turns_list_params::SortDirection::Desc),
                items_view: Some(wire::thread_turns_list_params::TurnItemsView::Full),
            },
            deadline,
        )?;
        if page.data.len() > limit as usize {
            return Err(error(
                Code::IncompatibleAdapter,
                "Codex history page exceeded its requested turn bound.",
            ));
        }
        for turn in &page.data {
            bounded_identifier(&turn.id)?;
            if turn.items_view != wire::thread_turns_list_response::TurnItemsView::Full {
                return Err(error(
                    Code::UnsupportedHostVersion,
                    "Codex did not return full history items; reconciliation cannot proceed.",
                ));
            }
        }
        Ok(page)
    }
}
fn before(deadline: Instant) -> Result<(), AdapterError> {
    if Instant::now() >= deadline {
        Err(error(
            Code::HostUnreachable,
            "Codex selected-thread verification exceeded its original deadline.",
        ))
    } else {
        Ok(())
    }
}
fn canonical_directory(path: &Path) -> Result<PathBuf, AdapterError> {
    let root = std::fs::canonicalize(path).map_err(|_| error(Code::HostUnreachable, "Selected Codex project root cannot be verified; restore the original registered directory."))?;
    if !root.is_dir() {
        return Err(error(
            Code::BindingMismatch,
            "Selected Codex project root must resolve to a directory.",
        ));
    }
    Ok(root)
}
