//! Native provider qualification, with owned pre-ID facts and no host launch.
use crate::{discovery::Discovery, supervisor::NativeFacts};
use ariadne_adapter_claude::{
    ClaudeAdapter, ClaudeOptions, ModEvidenceSlot, SUPPORTED_HOST_VERSION,
};
use ariadne_adapter_codex::{CodexAdapter, CodexDaemonReader, CodexOptions, QualifiedCodexThread};
use ariadne_agent_protocol::{
    host_version::classify_host_version, Adapter, AdapterFuture, Availability, Compatibility,
    ConnectRequest, ConnectResult,
};
use ariadne_core::{bindings::VerifiedHost, BindingConnectParams, CoreError, CoreErrorCode};
use ariadne_domain::models::*;
use std::{path::PathBuf, sync::Arc, time::Instant};

/// Resolves registration and releases its locks before returning the owned root.
pub type ProjectRootResolver = dyn Fn(&UuidV4) -> Result<PathBuf, CoreError> + Send + Sync;
/// The installed composition supplies the canonical shared agent instructions;
/// runtime stores no duplicate copy and Core bounds/persists the final body.
#[derive(Clone)]
pub struct ProviderInstructions {
    pub claude: String,
    pub codex: String,
    /// Exact CLI invocation named in the saved setup instruction; the agent's
    /// tool shell neither inherits `ARIADNE_HOME` nor finds the helper on PATH.
    pub cli_invocation: String,
}

#[derive(Clone)]
pub struct ProviderFactory {
    roots: Arc<ProjectRootResolver>,
    discovery: Discovery,
    claude: Option<ClaudeOptions>,
    codex: Option<CodexOptions>,
    facts: NativeFacts,
    instructions: ProviderInstructions,
}

/// Kept only by the current bootstrap call. This is neither a replay cache nor
/// dispatch authority; the Codex variant owns its initialized observer reader.
pub struct QualifiedProvider {
    pub host: VerifiedHost,
    provider: Provider,
}
enum Provider {
    Claude {
        options: ClaudeOptions,
        slot: ModEvidenceSlot,
    },
    Codex(Box<QualifiedCodexThread>),
}
pub struct PreparedProviderAdapter {
    pub adapter: Arc<dyn Adapter>,
    pub initial_connect:
        Box<dyn FnOnce(ConnectRequest, Instant) -> AdapterFuture<'static, ConnectResult> + Send>,
}
impl QualifiedProvider {
    pub(crate) fn claude_slot(&self) -> Option<ModEvidenceSlot> {
        match &self.provider {
            Provider::Claude { slot, .. } => Some(slot.clone()),
            Provider::Codex(_) => None,
        }
    }
    pub fn into_adapter(self, instance_id: UuidV4) -> Result<PreparedProviderAdapter, CoreError> {
        match self.provider {
            Provider::Claude { options, slot } => {
                let adapter = Arc::new(
                    ClaudeAdapter::new(options, slot, instance_id).map_err(CoreError::from)?,
                );
                let initial = adapter.clone();
                Ok(PreparedProviderAdapter {
                    adapter,
                    initial_connect: Box::new(move |request, deadline| {
                        Box::pin(async move { initial.connect_before(request, deadline).await })
                    }),
                })
            }
            Provider::Codex(qualified) => {
                let adapter = Arc::new(
                    CodexAdapter::from_qualified_thread(*qualified, instance_id)
                        .map_err(CoreError::from)?,
                );
                let initial = adapter.clone();
                Ok(PreparedProviderAdapter {
                    adapter,
                    initial_connect: Box::new(move |request, deadline| {
                        Box::pin(async move { initial.connect_before(request, deadline).await })
                    }),
                })
            }
        }
    }
}
impl ProviderFactory {
    /// Installed executable/resource paths and the project resolver are trusted
    /// native dependencies. No environment/provider configuration is read here.
    pub fn new(
        roots: Arc<ProjectRootResolver>,
        discovery: Discovery,
        claude: Option<ClaudeOptions>,
        codex: Option<CodexOptions>,
        facts: NativeFacts,
        instructions: ProviderInstructions,
    ) -> Self {
        Self {
            roots,
            discovery,
            claude,
            codex,
            facts,
            instructions,
        }
    }
    pub fn discovery(&self) -> &Discovery {
        &self.discovery
    }
    pub fn facts(&self) -> &NativeFacts {
        &self.facts
    }
    pub fn project_root(&self, project_id: &UuidV4) -> Result<PathBuf, CoreError> {
        (self.roots)(project_id)
    }

    /// Blocking offload entrypoint: all IO uses the caller's original deadline.
    /// Core invokes this outside registration/store locks, before durable IDs.
    pub fn qualify_before(
        &self,
        params: &BindingConnectParams,
        deadline: Instant,
    ) -> Result<QualifiedProvider, CoreError> {
        within(deadline)?;
        configuration(params)?;
        self.instruction(&params.adapter_id)?;
        let root = (self.roots)(&params.project_id)?;
        within(deadline)?;
        match params.adapter_id.as_str() {
            "claude_code_mod" => self.claude_before(
                params,
                root,
                None,
                ModEvidenceSlot::default(),
                None,
                deadline,
            ),
            "codex" => {
                let options = self.codex.clone().ok_or_else(unconfigured)?;
                let reader =
                    CodexDaemonReader::open_before(options, params.endpoint.clone(), deadline)
                        .map_err(CoreError::from)?;
                let qualified = reader
                    .qualify_selected_thread(&params.external_session_id, &root, deadline)
                    .map_err(CoreError::from)?;
                let facts = qualified.facts();
                let host = VerifiedHost {
                    adapter_id: params.adapter_id.clone(),
                    adapter_version: env!("CARGO_PKG_VERSION").into(),
                    protocol_major: PositiveSafeInteger::new(1).expect("literal"),
                    config_version: PositiveSafeInteger::new(1).expect("literal"),
                    external_session_id: facts.external_session_id.clone(),
                    endpoint: facts.endpoint.clone(),
                    endpoint_fingerprint: facts.endpoint_fingerprint.clone(),
                    configuration: params.configuration.clone(),
                    capabilities: facts.capabilities.clone(),
                    compatibility: facts.compatibility,
                    availability: facts.availability,
                    connection_state: ConnectionState::Unknown,
                    setup_instruction: self.instructions.codex.clone(),
                    cli_invocation: self.instructions.cli_invocation.clone(),
                    // The desktop talks to the Codex daemon; no agent-side
                    // process reports its terminal on this path (ADR-0085).
                    host_location: None,
                };
                within(deadline)?;
                Ok(QualifiedProvider {
                    host,
                    provider: Provider::Codex(Box::new(qualified)),
                })
            }
            _ => Err(unconfigured()),
        }
    }

    /// A Claude receipt cannot activate itself. Require a fresh announcement
    /// bound to the actual saved IDs and requalify its original aged snapshot.
    pub fn qualify_bound_claude_before(
        &self,
        project_id: UuidV4,
        binding: &Binding,
        deadline: Instant,
    ) -> Result<QualifiedProvider, CoreError> {
        self.refresh_bound_claude_before(project_id, binding, ModEvidenceSlot::default(), deadline)
    }
    pub(crate) fn refresh_bound_claude_before(
        &self,
        project_id: UuidV4,
        binding: &Binding,
        slot: ModEvidenceSlot,
        deadline: Instant,
    ) -> Result<QualifiedProvider, CoreError> {
        within(deadline)?;
        let params = BindingConnectParams {
            project_id,
            adapter_id: binding.adapter_id.clone(),
            external_session_id: binding.external_session_id.clone(),
            endpoint: binding.endpoint.clone(),
            configuration: binding.adapter_config.clone(),
            existing_session_id: None,
        };
        configuration(&params)?;
        self.instruction(&params.adapter_id)?;
        let root = (self.roots)(&params.project_id)?;
        let qualified = self.claude_before(
            &params,
            root,
            Some((&binding.id, &binding.generation)),
            slot,
            Some(&binding.endpoint_fingerprint),
            deadline,
        )?;
        if qualified.host.endpoint_fingerprint != binding.endpoint_fingerprint {
            return Err(mismatch(
                "Bound Claude resources differ from the saved host identity.",
            ));
        }
        Ok(qualified)
    }
    fn claude_before(
        &self,
        params: &BindingConnectParams,
        root: PathBuf,
        bound: Option<(&UuidV4, &UuidV4)>,
        slot: ModEvidenceSlot,
        expected: Option<&EndpointFingerprint>,
        deadline: Instant,
    ) -> Result<QualifiedProvider, CoreError> {
        let mut options = self.claude.clone().ok_or_else(unconfigured)?;
        options.project_root = root.clone();
        let candidate = self.discovery.snapshot()?.candidates.into_iter().find(|candidate| {
            candidate.adapter_id == params.adapter_id
                && candidate.external_session_id == params.external_session_id
                && candidate.endpoint == params.endpoint && candidate.cwd == root
                && candidate.announcement().is_some_and(|announcement| match bound {
                    Some((id, generation)) => announcement.binding_scope.as_ref().is_some_and(|scope|
                        &scope.binding_id == id && &scope.generation == generation),
                    None => true,
                })
        }).ok_or_else(|| CoreError::new(CoreErrorCode::HostUnreachable,
            "No fresh matching native Claude announcement is available.",
            "Refresh the original conversation's announcement; saved routing IDs alone grant no readiness."))?;
        let host_location = candidate
            .announcement()
            .and_then(|announcement| announcement.host_location.clone());
        let qualified = self.discovery.qualify_claude_host_matching_before(
            candidate,
            options.clone(),
            slot.clone(),
            deadline,
            expected,
        )?;
        let host = VerifiedHost {
            adapter_id: params.adapter_id.clone(),
            adapter_version: env!("CARGO_PKG_VERSION").into(),
            protocol_major: PositiveSafeInteger::new(1).expect("literal"),
            config_version: PositiveSafeInteger::new(1).expect("literal"),
            external_session_id: qualified.identity().external_session_id.clone(),
            endpoint: params.endpoint.clone(),
            endpoint_fingerprint: qualified.endpoint_fingerprint().clone(),
            configuration: params.configuration.clone(),
            capabilities: qualified.capabilities(),
            compatibility: classify_host_version(
                SUPPORTED_HOST_VERSION,
                &qualified.identity().engine_version,
            )
            .map_or(Compatibility::Incompatible, |status| status.compatibility()),
            availability: Availability::Available,
            connection_state: ConnectionState::Unknown,
            setup_instruction: self.instructions.claude.clone(),
            cli_invocation: self.instructions.cli_invocation.clone(),
            host_location,
        };
        Ok(QualifiedProvider {
            host,
            provider: Provider::Claude { options, slot },
        })
    }
    fn instruction(&self, provider: &str) -> Result<(), CoreError> {
        let body = if provider == "codex" {
            &self.instructions.codex
        } else {
            &self.instructions.claude
        };
        if body.trim().is_empty() || body.contains('\0') || body.len() > 64 * 1024 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidArgument,
                "Native provider instructions are empty, malformed or oversized.",
                "Supply the canonical installed agent instructions before qualifying a provider.",
            ));
        }
        Ok(())
    }
}
fn configuration(params: &BindingConnectParams) -> Result<(), CoreError> {
    let endpoint = match params.adapter_id.as_str() {
        "claude_code_mod" => {
            params.endpoint
                == EndpointRef::LocalBridge {
                    name: "claude-mod".into(),
                }
        }
        "codex" => matches!(params.endpoint, EndpointRef::UnixSocket { .. }),
        _ => return Err(unconfigured()),
    };
    if !endpoint
        || params.configuration.namespace != params.adapter_id
        || !params.configuration.values.0.is_empty()
    {
        return Err(CoreError::new(
            CoreErrorCode::InvalidArgument,
            "Provider setup requires its exact local endpoint and empty native configuration.",
            "Select the installed provider's local endpoint and matching configuration namespace.",
        ));
    }
    Ok(())
}
pub(crate) fn within(deadline: Instant) -> Result<(), CoreError> {
    if Instant::now() >= deadline {
        return Err(CoreError::new(CoreErrorCode::HostUnreachable,
            "Native provider setup exceeded its original admission deadline.",
            "Retain the original operation and routing IDs; check its saved receipt before repeating setup."));
    }
    Ok(())
}
fn unconfigured() -> CoreError {
    CoreError::new(
        CoreErrorCode::Unsupported,
        "Selected native provider is not configured.",
        "Use the matching installed desktop with explicit provider paths; no host is launched.",
    )
}
fn mismatch(message: &str) -> CoreError {
    CoreError::new(
        CoreErrorCode::BindingMismatch,
        message,
        "Keep the original route; explicitly reconnect and qualify changed host identity.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    fn factory(body: &str) -> ProviderFactory {
        ProviderFactory::new(
            Arc::new(|_| panic!("invalid admission must not resolve registration")),
            Discovery::new(
                Arc::new(|| UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()),
                None,
            ),
            None,
            None,
            NativeFacts {
                next_id: Arc::new(|| panic!("qualification never allocates binding IDs")),
                now: Arc::new(|| UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()),
            },
            ProviderInstructions {
                claude: body.into(),
                codex: body.into(),
                cli_invocation: "ariadne".into(),
            },
        )
    }
    fn params() -> BindingConnectParams {
        serde_json::from_value(serde_json::json!({"project_id":"11111111-1111-4111-8111-111111111111",
            "adapter_id":"codex", "external_session_id":"selected", "endpoint":{"kind":"unix_socket","path":"/absent/daemon.sock"},
            "configuration":{"namespace":"codex","values":{}},"existing_session_id":null})).unwrap()
    }
    #[test]
    fn expired_or_invalid_native_admission_never_reads_roots_or_provider_paths() {
        let factory = factory("canonical fixture instructions");
        assert_eq!(
            factory
                .qualify_before(&params(), Instant::now() - Duration::from_secs(1))
                .err()
                .unwrap()
                .code,
            CoreErrorCode::HostUnreachable
        );
        let mut bad = params();
        bad.configuration.namespace = "other".into();
        assert_eq!(
            factory
                .qualify_before(&bad, Instant::now() + Duration::from_secs(1))
                .err()
                .unwrap()
                .code,
            CoreErrorCode::InvalidArgument
        );
        bad.adapter_id = "unconfigured".into();
        assert_eq!(
            factory
                .qualify_before(&bad, Instant::now() + Duration::from_secs(1))
                .err()
                .unwrap()
                .code,
            CoreErrorCode::Unsupported
        );
    }
    #[test]
    fn shared_instruction_bodies_are_utf8_bounded_before_qualification() {
        for body in [" ".into(), "bad\0instructions".into(), "😀".repeat(16_385)] {
            assert_eq!(
                factory(&body)
                    .qualify_before(&params(), Instant::now() + Duration::from_secs(1))
                    .err()
                    .unwrap()
                    .code,
                CoreErrorCode::InvalidArgument
            );
        }
        factory(&"😀".repeat(16_384)).instruction("codex").unwrap();
    }
}
