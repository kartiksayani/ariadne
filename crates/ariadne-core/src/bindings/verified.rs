use crate::{BindingConnectParams, CoreError, CoreErrorCode};
use ariadne_agent_protocol::{Availability, Compatibility};
use ariadne_domain::models::*;

/// Trusted, read-only provider qualification, not a connection handle or wire DTO.
/// Composition verifies provider/config/version/endpoint and the explicitly chosen
/// host thread before constructing these facts. No placeholder binding IDs are used.
#[derive(Debug, Clone)]
pub struct VerifiedHost {
    pub adapter_id: String,
    pub adapter_version: String,
    pub protocol_major: PositiveSafeInteger,
    pub config_version: PositiveSafeInteger,
    pub external_session_id: String,
    pub endpoint: EndpointRef,
    pub endpoint_fingerprint: EndpointFingerprint,
    pub configuration: AdapterConfig,
    pub capabilities: Capabilities,
    pub compatibility: Compatibility,
    pub availability: Availability,
    /// Connected only for an actually verified connection observation; otherwise
    /// Unknown. Neither observation grants a runtime dispatch lease.
    pub connection_state: ConnectionState,
    pub setup_instruction: String,
    /// Exact shell prefix that runs the Ariadne CLI from the agent's tool shell
    /// (absolute helper path, plus `ARIADNE_HOME=<root> ` for a non-default root);
    /// `ariadne` when the composition knows no helper path.
    pub cli_invocation: String,
}
impl VerifiedHost {
    pub(super) fn validate(&self, request: &BindingConnectParams) -> Result<(), CoreError> {
        if self.adapter_id != request.adapter_id
            || self.external_session_id != request.external_session_id
            || self.endpoint != request.endpoint
            || self.configuration != request.configuration
        {
            return Err(CoreError::new(
                CoreErrorCode::BindingMismatch,
                "Verified host facts disagree with the explicitly selected route",
                "Verify the selected endpoint, host session and configuration.",
            ));
        }
        if !matches!(
            self.compatibility,
            Compatibility::Compatible | Compatibility::Untested
        ) || self.protocol_major.value() != 1
            || !self.capabilities.existing_session.supported
        {
            return Err(CoreError::new(
                CoreErrorCode::IncompatibleAdapter,
                "Adapter compatibility or existing-session qualification is not established",
                "Use a qualified compatible adapter for the selected host session.",
            ));
        }
        if self.availability != Availability::Available {
            return Err(CoreError::new(
                CoreErrorCode::HostUnreachable,
                "The selected host endpoint is not verified available",
                "Restore access to that endpoint, then retry the same operation.",
            ));
        }
        let valid = |value: &str, max: usize| {
            !value.trim().is_empty() && !value.contains('\0') && value.len() <= max
        };
        if !valid(&self.endpoint_fingerprint.0, 4096)
            || !valid(&self.adapter_version, 4096)
            || !valid(&self.setup_instruction, 64 * 1024)
            || !valid(&self.cli_invocation, 4096)
            || self.cli_invocation.contains('\n')
            || !matches!(
                self.connection_state,
                ConnectionState::Connected | ConnectionState::Unknown
            )
        {
            return Err(CoreError::new(
                CoreErrorCode::InvalidArgument,
                "Verified host facts contain invalid identity or observation values",
                "Correct the trusted provider qualification.",
            ));
        }
        Ok(())
    }
}
