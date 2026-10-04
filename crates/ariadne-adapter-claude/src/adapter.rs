//! First-party pull adapter: compatibility/presence only, never a second lifecycle transport.
use crate::{
    capabilities::capabilities,
    evidence::{fresh, ModEvidence, ModEvidenceSlot},
    normalization::error,
    probe::{self, ClaudeOptions, SUPPORTED_HOST_VERSION},
    worker::Worker,
};
use ariadne_agent_protocol::*;
use ariadne_domain::models::{ConnectionState, ExecutionState, Freshness, PresenceSource};
use sha2::{Digest, Sha256 as Hasher};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub struct ClaudeAdapter {
    worker: Worker,
}
impl ClaudeAdapter {
    /// Native activation retains one original deadline through worker admission
    /// and resource IO. Ordinary Adapter.connect keeps its existing default.
    pub fn connect_before(
        &self,
        request: ConnectRequest,
        deadline: Instant,
    ) -> AdapterFuture<'_, ConnectResult> {
        self.worker.call_before(deadline, move |state, deadline| {
            state.connect(request, deadline)
        })
    }
    pub fn new(
        options: ClaudeOptions,
        evidence: ModEvidenceSlot,
        instance_id: UuidV4,
    ) -> Result<Self, AdapterError> {
        options.validate()?;
        Ok(Self {
            worker: Worker::new(State {
                options,
                evidence,
                instance_id,
                connection: None,
                last_connection: None,
            })?,
        })
    }
}
impl Adapter for ClaudeAdapter {
    fn probe(&self, request: ProbeRequest) -> AdapterFuture<'_, ProbeResult> {
        self.worker
            .call(move |state, deadline| state.probe(request, deadline))
    }
    fn connect(&self, request: ConnectRequest) -> AdapterFuture<'_, ConnectResult> {
        self.worker
            .call(move |state, deadline| state.connect(request, deadline))
    }
    fn submit(&self, _request: SubmitRequest) -> AdapterFuture<'_, SubmitOutcome> {
        Box::pin(async {
            Err(error(AdapterErrorCode::Unsupported, "Claude delivery is pull-driven through the existing Mod claim/report flow; native submit cannot send or resend"))
        })
    }
    fn observe(&self, request: ObserveRequest) -> AdapterFuture<'_, ObserveResult> {
        self.worker
            .call(move |state, deadline| state.observe(request, deadline))
    }
    fn reconcile(&self, request: ReconcileRequest) -> AdapterFuture<'_, ReconcileResult> {
        if let Err(cause) = reconcile_bounds(&request) {
            return Box::pin(async { Err(cause) });
        }
        self.worker.call(move |state, _| state.reconcile(request))
    }
    fn disconnect(&self, request: DisconnectRequest) -> AdapterFuture<'_, DisconnectResult> {
        self.worker.call(move |state, _| {
            state.scope(&request.binding_id, &request.generation)?;
            state.connection = None;
            Ok(DisconnectResult {})
        })
    }
}
pub(crate) struct State {
    options: ClaudeOptions,
    evidence: ModEvidenceSlot,
    instance_id: UuidV4,
    connection: Option<(ConnectRequest, EndpointFingerprint)>,
    last_connection: Option<(ConnectRequest, EndpointFingerprint)>,
}
impl State {
    fn probe(&self, request: ProbeRequest, deadline: Instant) -> Result<ProbeResult, AdapterError> {
        configuration(&request.endpoint, &request.configuration)?;
        let version = probe::version(&self.options, deadline)?;
        if version != SUPPORTED_HOST_VERSION {
            return Ok(ProbeResult { host_version: Some(version), compatibility: Compatibility::Incompatible, availability: Availability::Unknown, setup_steps: vec!["Use the qualified Claude Code 2.1.287 baseline; other versions require conformance and live existing-session qualification.".into()] });
        }
        let Some(evidence) = self.evidence.snapshot()? else {
            return Ok(unknown(version, "Load/reload the installed Ariadne Mod in the selected conversation; a fresh native-validated SDK identity announcement is required."));
        };
        if !fresh(&evidence) {
            return Ok(unknown(version, "The Mod announcement is stale; refresh its native heartbeat or reload the plugin. Stale presence does not mean the host exited."));
        }
        if evidence.identity.engine_version != version {
            return Ok(ProbeResult { host_version: Some(version), compatibility: Compatibility::Incompatible, availability: Availability::Unknown, setup_steps: vec!["Loaded Claude SDK engine and selected executable versions differ; reload and requalify the original conversation.".into()] });
        }
        match probe::resource_identity(&self.options, &evidence, deadline) {
            Ok(_) => {
                self.current_evidence(&evidence, deadline)?;
                Ok(ProbeResult {
                    host_version: Some(version),
                    compatibility: Compatibility::Compatible,
                    availability: Availability::Available,
                    setup_steps: vec![],
                })
            }
            Err(cause) if cause.code == AdapterErrorCode::IncompatibleAdapter => Ok(ProbeResult {
                host_version: Some(version),
                compatibility: Compatibility::Incompatible,
                availability: Availability::Unknown,
                setup_steps: vec![cause.message],
            }),
            Err(cause) if cause.code == AdapterErrorCode::HostUnreachable => {
                Ok(unknown(version, &cause.message))
            }
            Err(cause) => Err(cause),
        }
    }
    fn connect(
        &mut self,
        request: ConnectRequest,
        deadline: Instant,
    ) -> Result<ConnectResult, AdapterError> {
        request.validate()?;
        configuration(&request.endpoint, &request.configuration)?;
        let evidence = self.evidence.snapshot()?.ok_or_else(unavailable)?;
        check_evidence_scope(&evidence, &request)?;
        let fingerprint = self.qualify(&evidence, deadline)?;
        if let Some((prior, identity)) = &self.last_connection {
            if prior.binding_id == request.binding_id
                && prior.generation == request.generation
                && (prior.external_session_id != request.external_session_id
                    || *identity != fingerprint)
            {
                return Err(error(AdapterErrorCode::BindingMismatch, "Same-generation Claude reconnect changed qualified identity; use explicit binding recovery"));
            }
        }
        let result = ConnectResult {
            external_session_id: request.external_session_id.clone(),
            endpoint_fingerprint: fingerprint.clone(),
            capabilities: capabilities(&evidence.identity.app_version),
            observation: self.presence(request.generation.clone(), Some(&evidence)),
        };
        result.validate_for(&request)?;
        self.last_connection = Some((request.clone(), fingerprint.clone()));
        self.connection = Some((request, fingerprint));
        Ok(result)
    }
    fn qualify(
        &self,
        evidence: &ModEvidence,
        deadline: Instant,
    ) -> Result<EndpointFingerprint, AdapterError> {
        let fingerprint = probe::qualify(&self.options, evidence, deadline)?;
        self.current_evidence(evidence, deadline)?;
        Ok(fingerprint)
    }
    fn current_evidence(
        &self,
        evidence: &ModEvidence,
        deadline: Instant,
    ) -> Result<(), AdapterError> {
        probe::check_deadline(deadline)?;
        if !fresh(evidence) {
            return Err(unavailable());
        }
        if self
            .evidence
            .snapshot()?
            .is_none_or(|current| current.identity != evidence.identity)
        {
            return Err(error(AdapterErrorCode::BindingMismatch, "Mod identity changed or disappeared during native qualification; refresh and recover explicitly"));
        }
        Ok(())
    }
    fn observe(
        &self,
        request: ObserveRequest,
        deadline: Instant,
    ) -> Result<ObserveResult, AdapterError> {
        let (connection, identity) = self.scope(&request.binding_id, &request.generation)?;
        if request.checkpoint.is_some() {
            return Err(error(AdapterErrorCode::InvalidArgument, "Claude native presence has no lifecycle checkpoint; explicitly reconcile persisted attempts after restart"));
        }
        let evidence = self.evidence.snapshot()?;
        if let Some(evidence) = evidence.as_ref() {
            check_evidence_scope(evidence, connection)?;
        }
        if let Some(evidence) = evidence.as_ref().filter(|evidence| fresh(evidence)) {
            if self.qualify(evidence, deadline)? != *identity {
                return Err(error(
                    AdapterErrorCode::BindingMismatch,
                    "Claude qualified resource/executable identity changed; recover explicitly",
                ));
            }
        }
        let observation = self.presence(request.generation.clone(), evidence.as_deref());
        // Compact JSON identifies the qualified observation semantics, including freshness.
        // Clearing evidence reports Unknown with native time; it never refreshes a heartbeat.
        let observed_at = match evidence.as_ref() {
            Some(evidence) => evidence.observed_at.clone(),
            None => now()?,
        };
        let event_id = presence_id(&request.binding_id, &observation)?;
        let event = NormalizedEvent {
            event_id,
            binding_id: request.binding_id,
            generation: request.generation,
            input_id: None,
            attempt_id: None,
            host_turn_id: None,
            observed_at,
            event: EventPayload::Presence { observation },
        };
        let result = ObserveResult {
            events: vec![event],
            next_checkpoint: None,
        };
        result.validate_for(&ObserveRequest {
            binding_id: connection.binding_id.clone(),
            generation: connection.generation.clone(),
            checkpoint: None,
            limit: request.limit,
        })?;
        Ok(result)
    }
    fn reconcile(&self, request: ReconcileRequest) -> Result<ReconcileResult, AdapterError> {
        self.scope(&request.binding_id, &request.generation)?;
        request.validate()?;
        reconcile_bounds(&request)?;
        // There is no supported Claude history read in this seam. Later Mod reports commit
        // directly to Core. Old observation tokens cannot prove delivery absence or block recovery.
        let result = ReconcileResult {
            unresolved_attempt_ids: request
                .attempts
                .iter()
                .map(|attempt| attempt.attempt_id.clone())
                .collect(),
            attempt_evidence: vec![],
            next_checkpoint: None,
        };
        result.validate_for(&request)?;
        Ok(result)
    }
    fn scope(
        &self,
        binding: &UuidV4,
        generation: &UuidV4,
    ) -> Result<&(ConnectRequest, EndpointFingerprint), AdapterError> {
        let connection = self.connection.as_ref().ok_or_else(|| {
            error(
                AdapterErrorCode::BindingMismatch,
                "Connect the explicit Claude conversation before reading this scope",
            )
        })?;
        if connection.0.binding_id != *binding {
            return Err(error(
                AdapterErrorCode::BindingMismatch,
                "Claude request uses a different binding",
            ));
        }
        if connection.0.generation != *generation {
            return Err(error(
                AdapterErrorCode::StaleGeneration,
                "Claude request uses a different current generation",
            ));
        }
        Ok(connection)
    }
    fn presence(&self, generation: UuidV4, evidence: Option<&ModEvidence>) -> PresenceObservation {
        let is_fresh = evidence.is_some_and(fresh);
        PresenceObservation {
            instance_id: self.instance_id.clone(),
            generation,
            connection_state: if is_fresh {
                ConnectionState::Connected
            } else {
                ConnectionState::Unknown
            },
            execution_state: ExecutionState::Unknown,
            last_seen_at: evidence.map(|evidence| evidence.observed_at.clone()),
            source: evidence.map(|_| PresenceSource::BridgeHeartbeat),
            process_identity: None,
            freshness: match evidence {
                Some(_) if is_fresh => Freshness::Fresh,
                Some(_) => Freshness::Stale,
                None => Freshness::Unknown,
            },
        }
    }
}
fn presence_id(
    binding_id: &UuidV4,
    observation: &PresenceObservation,
) -> Result<String, AdapterError> {
    let encoded =
        serde_json::to_vec(&("claude-presence-v1", binding_id, observation)).map_err(|_| {
            error(
                AdapterErrorCode::InvalidArgument,
                "Claude presence identity could not be encoded",
            )
        })?;
    Ok(format!("claude-presence-v1:{:x}", Hasher::digest(encoded)))
}
fn now() -> Result<UtcMillis, AdapterError> {
    utc(SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| {
        error(
            AdapterErrorCode::HostUnreachable,
            "System clock precedes UTC epoch",
        )
    })?)
}
fn utc(elapsed: Duration) -> Result<UtcMillis, AdapterError> {
    let seconds: libc::time_t = elapsed.as_secs().try_into().map_err(|_| {
        error(
            AdapterErrorCode::HostUnreachable,
            "System clock exceeds supported UTC range",
        )
    })?;
    // SAFETY: initialized writable calendar output; gmtime_r uses no shared static buffer.
    let mut calendar: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::gmtime_r(&seconds, &mut calendar) }.is_null() {
        return Err(error(
            AdapterErrorCode::HostUnreachable,
            "Cannot read native UTC system clock",
        ));
    }
    UtcMillis::new(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        calendar.tm_year + 1900,
        calendar.tm_mon + 1,
        calendar.tm_mday,
        calendar.tm_hour,
        calendar.tm_min,
        calendar.tm_sec,
        elapsed.subsec_millis()
    ))
    .map_err(|_| {
        error(
            AdapterErrorCode::HostUnreachable,
            "Native clock is not a canonical UTC millisecond time",
        )
    })
}
fn check_evidence_scope(
    evidence: &ModEvidence,
    request: &ConnectRequest,
) -> Result<(), AdapterError> {
    if evidence.identity.external_session_id != request.external_session_id {
        return Err(error(
            AdapterErrorCode::BindingMismatch,
            "Mod evidence belongs to a different external session",
        ));
    }
    if let Some((binding, generation)) = &evidence.identity.binding_scope {
        if *binding != request.binding_id {
            return Err(error(
                AdapterErrorCode::BindingMismatch,
                "Mod evidence belongs to a different binding",
            ));
        }
        if *generation != request.generation {
            return Err(error(
                AdapterErrorCode::StaleGeneration,
                "Mod evidence belongs to a different generation",
            ));
        }
    }
    Ok(())
}
fn reconcile_bounds(request: &ReconcileRequest) -> Result<(), AdapterError> {
    if request.attempts.len() > 100
        || request
            .attempts
            .iter()
            .any(|attempt| attempt.wire_marker.is_empty() || attempt.wire_marker.len() > 4096)
    {
        return Err(error(AdapterErrorCode::InvalidArgument, "Claude reconciliation accepts at most 100 attempts with nonempty markers up to 4KiB; request a narrower batch"));
    }
    Ok(())
}
fn unavailable() -> AdapterError {
    error(AdapterErrorCode::HostUnreachable, "No fresh scoped native Mod evidence; load/reload the original conversation and refresh its announcement")
}
fn unknown(version: String, step: &str) -> ProbeResult {
    ProbeResult {
        host_version: Some(version),
        compatibility: Compatibility::Unknown,
        availability: Availability::Unavailable,
        setup_steps: vec![step.into()],
    }
}
fn configuration(endpoint: &EndpointRef, config: &AdapterConfig) -> Result<(), AdapterError> {
    if *endpoint
        != (EndpointRef::LocalBridge {
            name: "claude-mod".into(),
        })
        || config.namespace != "claude_code_mod"
        || !config.values.0.is_empty()
    {
        return Err(error(AdapterErrorCode::InvalidArgument, "Claude requires local_bridge claude-mod and claude_code_mod configuration with empty values"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::LoadedModIdentity;
    #[test]
    fn stale_announcement_preserves_original_time_and_never_means_dead_or_idle() {
        let id = UuidV4::new("11111111-1111-4111-8111-111111111111").unwrap();
        let timestamp = UtcMillis::new("2026-10-04T00:00:00.123Z").unwrap();
        let mut evidence = ModEvidence::received(
            LoadedModIdentity {
                plugin_name: "ariadne".into(),
                plugin_root: "/loaded".into(),
                helper_path: "/helper".into(),
                app_version: "0.1.0".into(),
                api_version: 1,
                engine_version: SUPPORTED_HOST_VERSION.into(),
                external_session_id: "session".into(),
                project_root: "/project".into(),
                binding_scope: None,
            },
            timestamp.clone(),
        )
        .unwrap();
        let state = State {
            options: ClaudeOptions {
                executable: "/absent".into(),
                installed_plugin: "/installed".into(),
                helper: "/helper".into(),
                project_root: "/project".into(),
                app_version: "0.1.0".into(),
            },
            evidence: ModEvidenceSlot::default(),
            instance_id: id.clone(),
            connection: None,
            last_connection: None,
        };
        let fresh_observation = state.presence(id.clone(), Some(&evidence));
        let fresh_id = presence_id(&id, &fresh_observation).unwrap();
        evidence.received = Instant::now() - Duration::from_secs(90);
        assert_eq!(
            state
                .qualify(&evidence, Instant::now() + Duration::from_secs(5))
                .unwrap_err()
                .code,
            AdapterErrorCode::HostUnreachable
        );
        let observation = state.presence(id.clone(), Some(&evidence));
        assert_ne!(fresh_id, presence_id(&id, &observation).unwrap());
        assert_eq!(
            presence_id(&id, &observation).unwrap(),
            presence_id(&id, &observation).unwrap()
        );
        assert_eq!(
            utc(Duration::from_millis(123)).unwrap().as_str(),
            "1970-01-01T00:00:00.123Z"
        );
        assert_eq!(observation.last_seen_at, Some(timestamp));
        assert_eq!(observation.freshness, Freshness::Stale);
        assert_eq!(observation.connection_state, ConnectionState::Unknown);
        assert_eq!(observation.execution_state, ExecutionState::Unknown);
    }
}
