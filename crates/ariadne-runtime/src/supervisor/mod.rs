//! Independent binding scheduling; core owns FIFO, replay and durable effects.
mod core_io;
mod diagnostics;
mod gate;
pub use diagnostics::Diagnostic;
pub use gate::ClaimGate;

use crate::{control::validated_error, leases::BindingLease};
use ariadne_agent_protocol::*;
use ariadne_core::*;
use ariadne_domain::models::{Binding, ConnectionState, Freshness, InputState, PresenceSource};
use std::{
    collections::VecDeque,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    sync::{oneshot, watch},
    task::JoinHandle,
    time::timeout,
};

const POLL: Duration = Duration::from_millis(250);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
const FRAME_BYTES: usize = 8 * 1024 * 1024;
const SCAN_BYTES: usize = 16 * 1024 * 1024;

/// Native factories supplied by composition, never renderer/model-controlled.
/// Factories must be brief and nonblocking; IDs must be fresh UUIDv4 values.
#[derive(Clone)]
pub struct NativeFacts {
    pub next_id: Arc<dyn Fn() -> UuidV4 + Send + Sync>,
    pub now: Arc<dyn Fn() -> UtcMillis + Send + Sync>,
}
/// Coalesced native scheduling progress; never a durable/domain state projection.
#[derive(Debug, Clone, Default)]
pub struct SupervisorProgress {
    pub reconciled: bool,
    pub acknowledged_checkpoint: Option<Checkpoint>,
    pub validated_reports: u64,
    pub validated_claims: u64,
}

/// Unacknowledged facts. A returned page is an explicit handoff, not a saved receipt.
#[derive(Debug)]
pub struct PendingReport {
    pub event: NormalizedEvent,
    pub context: AdapterContext,
}
#[derive(Debug)]
pub struct PendingPage {
    pub reports: Vec<PendingReport>,
    pub next_checkpoint: Option<Checkpoint>,
}
#[must_use = "Inspect pending facts and errors before considering shutdown complete"]
#[derive(Debug)]
pub struct SupervisorExit {
    pub pending: Option<PendingPage>,
    pub pending_claim: Option<ClaimRequest>,
    /// Volatile progress only; restart always reconciles persisted attempts afresh.
    pub acknowledged_checkpoint: Option<Checkpoint>,
    pub diagnostics: Vec<Diagnostic>,
    pub error: Option<CoreError>,
}

/// Connection cause plus any exact failure fact whose receipt was not validated.
#[derive(Debug)]
pub struct ConnectFailure {
    pub cause: CoreError,
    pub pending: Option<PendingReport>,
    pub report_error: Option<CoreError>,
}
impl ConnectFailure {
    fn before_attempt(cause: CoreError) -> Box<Self> {
        Box::new(Self {
            cause,
            pending: None,
            report_error: None,
        })
    }
}
/// Host qualification occurs before the caller acquires a dispatch lease.
pub struct ConnectedSupervisor {
    core: Arc<dyn CoreService>,
    adapter: Arc<dyn Adapter>,
    session: RegisteredSession,
    binding: Binding,
    connected: ConnectResult,
    facts: NativeFacts,
}
impl ConnectedSupervisor {
    pub async fn connect(
        core: Arc<dyn CoreService>,
        adapter: Arc<dyn Adapter>,
        session: RegisteredSession,
        binding: Binding,
        facts: NativeFacts,
    ) -> Result<Self, Box<ConnectFailure>> {
        let initial = adapter.clone();
        Self::connect_before(
            core,
            adapter,
            session,
            binding,
            facts,
            Instant::now() + Duration::from_secs(10),
            move |request| Box::pin(async move { initial.connect(request).await }),
        )
        .await
    }
    /// Native composition supplies the real provider's deadline-aware initial
    /// connect, invoked exactly once after request validation and before leasing.
    pub async fn connect_before(
        core: Arc<dyn CoreService>,
        adapter: Arc<dyn Adapter>,
        session: RegisteredSession,
        binding: Binding,
        facts: NativeFacts,
        deadline: Instant,
        connect: impl FnOnce(ConnectRequest) -> AdapterFuture<'static, ConnectResult>,
    ) -> Result<Self, Box<ConnectFailure>> {
        crate::providers::within(deadline).map_err(ConnectFailure::before_attempt)?;
        let request = ConnectRequest {
            binding_id: binding.id.clone(),
            generation: binding.generation.clone(),
            external_session_id: binding.external_session_id.clone(),
            endpoint: binding.endpoint.clone(),
            configuration: binding.adapter_config.clone(),
        };
        request
            .validate()
            .map_err(adapter_error)
            .map_err(ConnectFailure::before_attempt)?;
        let attempted = async {
            let connected = tokio::time::timeout_at(
                tokio::time::Instant::from_std(deadline),
                connect(request.clone()),
            )
            .await
            .map_err(|_| {
                host_error("Adapter connection exceeded its original admission deadline.")
            })?
            .map_err(adapter_error)?;
            connected.validate_for(&request).map_err(adapter_error)?;
            if connected.endpoint_fingerprint != binding.endpoint_fingerprint
                || connected.observation.connection_state != ConnectionState::Connected
                || connected.observation.freshness != Freshness::Fresh
                || !matches!(
                    connected.observation.source,
                    Some(
                        PresenceSource::HostPoll
                            | PresenceSource::HostEvent
                            | PresenceSource::BridgeHeartbeat
                    )
                )
            {
                return Err(host_error(
                    "Selected host did not provide fresh matching connection evidence.",
                ));
            }
            Ok(connected)
        }
        .await;
        let connected = match attempted {
            Ok(connected) => connected,
            Err(cause) => {
                // This reports inability to establish Ariadne's connection. It
                // never asserts host termination, turn completion or no delivery.
                let event = NormalizedEvent {
                    event_id: format!("runtime:disconnected:{}", (facts.next_id)().as_str()),
                    binding_id: binding.id.clone(),
                    generation: binding.generation.clone(),
                    input_id: None,
                    attempt_id: None,
                    host_turn_id: None,
                    observed_at: (facts.now)(),
                    event: EventPayload::Disconnected {
                        reason: Some(
                            "Ariadne could not establish a qualified connection to this binding."
                                .into(),
                        ),
                    },
                };
                let context = AdapterContext::from_trusted_entrypoint(
                    session,
                    binding.id,
                    binding.generation,
                    None,
                );
                let pending = PendingReport { event, context };
                let reported = pending.event.clone();
                let scope = pending.context.clone();
                let report = core_io::unleased(move || {
                    let receipt = core.report(scope.clone(), reported.clone())?;
                    receipt.validate_for(&scope, &reported)?;
                    Ok(receipt)
                })
                .await;
                return Err(Box::new(match report {
                    Ok(_) => ConnectFailure {
                        cause,
                        pending: None,
                        report_error: None,
                    },
                    Err(error) => ConnectFailure {
                        cause,
                        pending: Some(pending),
                        report_error: Some(error),
                    },
                }));
            }
        };
        Ok(Self {
            core,
            adapter,
            session,
            binding,
            connected,
            facts,
        })
    }
    pub fn start(self, lease: BindingLease) -> Result<SupervisorHandle, CoreError> {
        if lease.session() != &self.session
            || lease.binding_id() != &self.binding.id
            || lease.generation() != &self.binding.generation
        {
            return Err(protocol_error(
                "Supervisor facts and physical lease scopes differ.",
            ));
        }
        let gate = ClaimGate::new();
        let (stop, stopped) = oneshot::channel();
        let (progress, observed) = watch::channel(SupervisorProgress::default());
        let task =
            tokio::spawn(Worker::new(self, lease.clone(), gate.clone(), progress).run(stopped));
        Ok(SupervisorHandle {
            lease,
            gate,
            stop: Some(stop),
            task: Some(task),
            progress: observed,
        })
    }
}

#[must_use = "Stop the supervisor and inspect its pending-fact handoff"]
pub struct SupervisorHandle {
    lease: BindingLease,
    gate: ClaimGate,
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<SupervisorExit>>,
    progress: watch::Receiver<SupervisorProgress>,
}
impl SupervisorHandle {
    pub fn progress(&self) -> watch::Receiver<SupervisorProgress> {
        self.progress.clone()
    }
    /// Install this gated route in the desktop control server, including during startup.
    pub fn control_binding(&self) -> (BindingLease, ClaimGate) {
        (self.lease.clone(), self.gate.clone())
    }
    pub fn request_stop(&mut self) {
        self.gate.stop();
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
    pub async fn stop(mut self) -> Result<SupervisorExit, CoreError> {
        self.request_stop();
        self.task.take().expect("handle owns one task").await
            .map_err(|_| protocol_error("Supervisor task failed; reconcile persisted attempts before reopening dispatch."))
    }
}
impl Drop for SupervisorHandle {
    fn drop(&mut self) {
        self.request_stop();
    }
}

struct Worker {
    connected: ConnectedSupervisor,
    lease: BindingLease,
    gate: ClaimGate,
    pending: VecDeque<PendingReport>,
    offered: Option<Checkpoint>,
    checkpoint: Option<Checkpoint>,
    pending_claim: Option<ClaimRequest>,
    submitting: Option<(PreparedAttempt, bool)>,
    diagnostics: diagnostics::Diagnostics,
    reconciled: bool,
    progress: watch::Sender<SupervisorProgress>,
    validated_reports: u64,
    validated_claims: u64,
}
impl Worker {
    fn new(
        connected: ConnectedSupervisor,
        lease: BindingLease,
        gate: ClaimGate,
        progress: watch::Sender<SupervisorProgress>,
    ) -> Self {
        Self {
            connected,
            lease,
            gate,
            pending: VecDeque::new(),
            offered: None,
            checkpoint: None,
            pending_claim: None,
            submitting: None,
            diagnostics: diagnostics::Diagnostics::default(),
            reconciled: false,
            progress,
            validated_reports: 0,
            validated_claims: 0,
        }
    }
    fn context(
        &self,
        event: &NormalizedEvent,
        historical: bool,
    ) -> Result<AdapterContext, CoreError> {
        let scope = if historical {
            Some(VerifiedHistoricalScope::from_trusted_reconciliation(
                event.generation.clone(),
                event
                    .input_id
                    .clone()
                    .ok_or_else(|| protocol_error("Historical event has no input scope."))?,
                event
                    .attempt_id
                    .clone()
                    .ok_or_else(|| protocol_error("Historical event has no attempt scope."))?,
                self.connected.connected.endpoint_fingerprint.clone(),
            ))
        } else {
            None
        };
        Ok(AdapterContext::from_trusted_entrypoint(
            self.connected.session.clone(),
            self.connected.binding.id.clone(),
            self.connected.binding.generation.clone(),
            scope,
        ))
    }
    fn event(
        &self,
        event_id: String,
        event: EventPayload,
        attempt: Option<&PreparedAttempt>,
    ) -> NormalizedEvent {
        NormalizedEvent {
            event_id,
            binding_id: self.connected.binding.id.clone(),
            generation: self.connected.binding.generation.clone(),
            input_id: attempt.map(|a| a.input_id.clone()),
            attempt_id: attempt.map(|a| a.attempt_id.clone()),
            host_turn_id: None,
            observed_at: (self.connected.facts.now)(),
            event,
        }
    }
    fn queue(
        &mut self,
        events: impl IntoIterator<Item = NormalizedEvent>,
        historical: bool,
    ) -> Result<(), CoreError> {
        for event in events {
            event.validate().map_err(adapter_error)?;
            let context = self.context(&event, historical)?;
            self.pending.push_back(PendingReport { event, context });
        }
        Ok(())
    }
    async fn report(&mut self) -> Result<(), CoreError> {
        while let Some(pending) = self.pending.front() {
            let context = pending.context.clone();
            let core = self.connected.core.clone();
            let reported = pending.event.clone();
            core_io::call(self.lease.clone(), move || {
                let receipt = core.report(context.clone(), reported.clone())?;
                receipt.validate_for(&context, &reported)?;
                Ok(receipt)
            })
            .await?;
            self.diagnostics
                .record(&self.pending.front().expect("retained until receipt").event);
            self.pending.pop_front();
            self.validated_reports = self.validated_reports.saturating_add(1);
        }
        if self.offered.is_some() {
            self.checkpoint = self.offered.take();
        }
        self.publish();
        Ok(())
    }
    fn publish(&self) {
        self.progress.send_replace(SupervisorProgress {
            reconciled: self.reconciled,
            acknowledged_checkpoint: self.checkpoint.clone(),
            validated_reports: self.validated_reports,
            validated_claims: self.validated_claims,
        });
    }
    async fn inputs(&self) -> Result<Vec<AttemptEvidenceRequest>, CoreError> {
        // A revision conflict restarts the entire scan, never just a later page.
        for _ in 0..3 {
            let mut cursor = None;
            let mut attempts = Vec::new();
            let mut scanned = Counter {
                bytes: 0,
                limit: SCAN_BYTES,
            };
            let mut last_sequence = None;
            loop {
                let request = QueryRequest::SessionRead(SessionReadRequest {
                    selection: ReadView::Inputs {
                        topic_id: None,
                        item_id: None,
                        states: vec![InputState::InFlight, InputState::NeedsAttention],
                    },
                    cursor: cursor.clone(),
                    limit: PageLimit::new(100).expect("constant limit"),
                    item_pages: vec![],
                });
                let context = QueryContext::owner(OwnerContext::from_trusted_entrypoint(
                    OwnerScope::Session(self.connected.session.clone()),
                ));
                let core = self.connected.core.clone();
                let response = core_io::call(self.lease.clone(), move || {
                    let result = core.query(context.clone(), request.clone())?;
                    result.validate_for(&context, &request)?;
                    Ok(result)
                })
                .await;
                let result = match response {
                    Err(error) if error.code == CoreErrorCode::SnapshotChanged => break,
                    other => other?,
                };
                let QueryResult::SessionRead(SessionReadResult::Inputs(page)) = result else {
                    return Err(protocol_error(
                        "Owner input scan returned a different projection.",
                    ));
                };
                if let Some(next) = &page.next_cursor {
                    let last = page.items.last().ok_or_else(|| {
                        protocol_error("Empty input page supplied a continuation without progress.")
                    })?;
                    if !matches!(&next.after, Some(ariadne_domain::models::CursorPosition::Sequence { number, id }) if number == &last.seq && id == &last.id)
                    {
                        return Err(protocol_error(
                            "Input continuation does not identify its last returned sequence.",
                        ));
                    }
                }
                for input in page.items {
                    if last_sequence.is_some_and(|sequence| input.seq.value() <= sequence) {
                        return Err(protocol_error(
                            "Input pages repeated or reversed their sequence positions.",
                        ));
                    }
                    last_sequence = Some(input.seq.value());
                    serde_json::to_writer(&mut scanned, &input).map_err(|_| CoreError::new(
                        CoreErrorCode::CapacityExceeded,
                        "Input scan exceeds the existing 16MiB session budget.",
                        "Dispatch remains closed; inspect the registered session projection. No persisted attempt was omitted or classified as undelivered.",
                    ))?;
                    if input.binding_id == self.connected.binding.id {
                        for attempt in input.attempts.into_iter().filter(|a| a.sealed_at.is_none())
                        {
                            attempts.push(AttemptEvidenceRequest {
                                input_id: input.id.clone(),
                                attempt_id: attempt.id,
                                binding_generation: attempt.binding_generation,
                                payload_sha256: attempt.payload_sha256,
                                wire_marker: attempt.wire_marker,
                                host_turn_id: attempt.host_turn_id,
                            });
                        }
                    }
                }
                if page.next_cursor.is_none() {
                    return Ok(attempts);
                }
                if page.next_cursor == cursor {
                    return Err(protocol_error("Input cursor did not advance."));
                }
                cursor = page.next_cursor;
            }
        }
        Err(CoreError::new(
            CoreErrorCode::SnapshotChanged,
            "Input snapshot changed during all three bounded scans.",
            "Reload and reconcile from the first page; no dispatch was enabled.",
        ))
    }
    async fn reconcile(&mut self) -> Result<bool, CoreError> {
        let attempts = self.inputs().await?;
        let batches = if attempts.is_empty() {
            1
        } else {
            attempts.len().div_ceil(100)
        };
        let mut complete = true;
        for batch in 0..batches {
            let attempts = &attempts[batch * 100..attempts.len().min((batch + 1) * 100)];
            let mut checkpoint = None;
            let mut unresolved: std::collections::BTreeSet<_> =
                attempts.iter().map(|a| a.attempt_id.clone()).collect();
            loop {
                let request = ReconcileRequest {
                    binding_id: self.connected.binding.id.clone(),
                    generation: self.connected.binding.generation.clone(),
                    attempts: attempts.to_vec(),
                    checkpoint: checkpoint.clone(),
                };
                request.validate().map_err(adapter_error)?;
                let result = timeout(
                    Duration::from_secs(10),
                    self.connected.adapter.reconcile(request.clone()),
                )
                .await
                .map_err(|_| host_error("Reconciliation exceeded its 10-second batch bound."))?
                .map_err(adapter_error)?;
                result.validate_for(&request).map_err(adapter_error)?;
                frame_bound(result.attempt_evidence.iter().flat_map(|a| a.events.iter()))?;
                for evidence in &result.attempt_evidence {
                    if !result.unresolved_attempt_ids.contains(&evidence.attempt_id) {
                        unresolved.remove(&evidence.attempt_id);
                    }
                }
                unresolved.extend(result.unresolved_attempt_ids.iter().cloned());
                self.offered = result.next_checkpoint.clone();
                self.queue(
                    result.attempt_evidence.into_iter().flat_map(|a| a.events),
                    true,
                )?;
                self.report().await?;
                if result.next_checkpoint.is_none() {
                    break;
                }
                if result.next_checkpoint == checkpoint {
                    return Err(protocol_error(
                        "Reconciliation continuation did not advance.",
                    ));
                }
                checkpoint = result.next_checkpoint;
            }
            complete &= unresolved.is_empty();
        }
        // Reconcile and observe tokens are different provider-private cursors.
        self.checkpoint = None;
        Ok(complete)
    }
    async fn submit(&mut self) -> Result<(), CoreError> {
        if self.connected.connected.capabilities.delivery_mode
            == ariadne_domain::models::DeliveryMode::Pull
        {
            return Ok(());
        }
        let request = ClaimRequest {
            binding_id: self.connected.binding.id.clone(),
            generation: self.connected.binding.generation.clone(),
            request_id: (self.connected.facts.next_id)(),
        };
        let context = self
            .lease
            .context(&request.binding_id, &request.generation)?;
        let core = self.connected.core.clone();
        let claim = request.clone();
        self.pending_claim = Some(request);
        let task = self.gate.admit(|| {
            core_io::start(self.lease.clone(), move || {
                let result = core.claim(context, claim.clone())?;
                if let Some(attempt) = &result {
                    attempt.validate_for(&claim)?;
                }
                Ok(result)
            })
        })?;
        let attempt = match core_io::finish(task).await {
            Err(error)
                if matches!(
                    error.code,
                    CoreErrorCode::InvalidTransition
                        | CoreErrorCode::HostUnreachable
                        | CoreErrorCode::ResultMissing
                        | CoreErrorCode::DeliveryUncertain
                ) =>
            {
                // A known canonical dispatch barrier is not an eligible claim.
                // Timeout/panic retains its request ID because preparation may exist.
                if error.code != CoreErrorCode::HostUnreachable {
                    self.pending_claim = None;
                }
                return Err(error);
            }
            other => other?,
        };
        self.pending_claim = None;
        self.validated_claims = self.validated_claims.saturating_add(1);
        self.publish();
        let Some(attempt) = attempt else {
            return Ok(());
        };
        self.submitting = Some((attempt.clone(), false));
        let request = SubmitRequest {
            binding_id: self.connected.binding.id.clone(),
            generation: self.connected.binding.generation.clone(),
            input_id: attempt.input_id.clone(),
            attempt_id: attempt.attempt_id.clone(),
            formatted_payload: attempt.formatted_payload.clone(),
            payload_sha256: attempt.payload_sha256.clone(),
            wire_marker: attempt.wire_marker.clone(),
        };
        // A prepared attempt is never sent after a concurrent stop fence.
        self.gate.admit(|| ())?;
        self.submitting.as_mut().expect("retained preparation").1 = true;
        let outcome = match timeout(
            Duration::from_secs(20),
            self.connected.adapter.submit(request),
        )
        .await
        {
            Ok(Ok(outcome)) if outcome.validate().is_ok() => outcome,
            _ => SubmitOutcome::Uncertain {
                reason:
                    "Submission did not return a validated outcome; delivery cannot be ruled out."
                        .into(),
            },
        };
        let (id, payload) = match outcome {
            SubmitOutcome::Accepted { receipt } => (
                format!(
                    "runtime:accepted:{}:{}:{}",
                    self.connected.binding.id.as_str(),
                    self.connected.binding.generation.as_str(),
                    attempt.attempt_id.as_str()
                ),
                EventPayload::Accepted { receipt },
            ),
            SubmitOutcome::RejectedBeforeDelivery { reason } => (
                terminal_event_id(
                    &self.connected.binding.id,
                    &self.connected.binding.generation,
                    &attempt.attempt_id,
                    None,
                    TerminalEventKind::Rejected,
                    None,
                )
                .map_err(adapter_error)?,
                EventPayload::Rejected { reason },
            ),
            SubmitOutcome::Uncertain { reason } => (
                terminal_event_id(
                    &self.connected.binding.id,
                    &self.connected.binding.generation,
                    &attempt.attempt_id,
                    None,
                    TerminalEventKind::Uncertain,
                    None,
                )
                .map_err(adapter_error)?,
                EventPayload::Uncertain { reason },
            ),
        };
        self.queue([self.event(id, payload, Some(&attempt))], false)?;
        self.submitting = None;
        self.report().await
    }
    async fn observe(&mut self) -> Result<(), CoreError> {
        let request = ObserveRequest {
            binding_id: self.connected.binding.id.clone(),
            generation: self.connected.binding.generation.clone(),
            checkpoint: self.checkpoint.clone(),
            limit: ObserveLimit::new(100).expect("constant limit"),
        };
        let result = timeout(
            Duration::from_secs(5),
            self.connected.adapter.observe(request.clone()),
        )
        .await
        .map_err(|_| host_error("Observation exceeded its 5-second bound."))?
        .map_err(adapter_error)?;
        result.validate_for(&request).map_err(adapter_error)?;
        frame_bound(result.events.iter())?;
        self.offered = result.next_checkpoint;
        self.queue(result.events, false)?;
        self.report().await
    }
    async fn run(mut self, mut stop: oneshot::Receiver<()>) -> SupervisorExit {
        let initial = self.event(
            format!(
                "runtime:connected:{}:{}",
                self.connected.binding.id.as_str(),
                self.connected.binding.generation.as_str()
            ),
            EventPayload::Connected {
                external_session_id: self.connected.connected.external_session_id.clone(),
                endpoint_fingerprint: self.connected.connected.endpoint_fingerprint.clone(),
                capabilities: Box::new(self.connected.connected.capabilities.clone()),
            },
            None,
        );
        let mut error = self.queue([initial], false).err();
        if error.is_none() {
            error = self.report().await.err();
        }
        while error.is_none() {
            let operation = async {
                if !self.reconciled && self.reconcile().await? {
                    self.reconciled = true;
                    self.gate.reconciled_from_trusted_native()?;
                    self.publish();
                }
                self.observe().await?;
                if self.reconciled {
                    self.submit().await?;
                }
                Ok::<_, CoreError>(())
            };
            tokio::select! {
                biased;
                _ = &mut stop => break,
                result = operation => {
                    if let Err(e) = result {
                        if matches!(e.code, CoreErrorCode::InvalidTransition | CoreErrorCode::ResultMissing | CoreErrorCode::DeliveryUncertain) && self.pending.is_empty() {
                            // Core owns durable pause/result barriers. Continue observation.
                        } else { error = Some(e); }
                    }
                }
            }
            if error.is_none() {
                tokio::select! { biased; _ = &mut stop => break, _ = tokio::time::sleep(POLL) => {} }
            }
        }
        self.gate.stop();
        if let Some((attempt, started)) = self.submitting.take() {
            let (kind, payload) = if started {
                (TerminalEventKind::Uncertain, EventPayload::Uncertain { reason: "Desktop stopped during possible submission; delivery cannot be ruled out.".into() })
            } else {
                (
                    TerminalEventKind::Rejected,
                    EventPayload::Rejected {
                        reason: "Desktop stopped before adapter submission admission.".into(),
                    },
                )
            };
            match terminal_event_id(
                &self.connected.binding.id,
                &self.connected.binding.generation,
                &attempt.attempt_id,
                None,
                kind,
                None,
            ) {
                Ok(id) => {
                    if let Err(e) = self.queue([self.event(id, payload, Some(&attempt))], false) {
                        if error.is_none() {
                            error = Some(e);
                        }
                    }
                }
                Err(e) => {
                    if error.is_none() {
                        error = Some(adapter_error(e));
                    }
                }
            }
        }
        if !self.pending.is_empty() && error.is_none() {
            error = match timeout(SHUTDOWN_GRACE, self.report()).await {
                Ok(result) => result.err(),
                Err(_) => Some(host_error(
                    "Shutdown flush exceeded its bound; pending facts were not acknowledged.",
                )),
            };
        }
        if self.pending_claim.is_some() && error.is_none() {
            error = Some(host_error(
                "Shutdown interrupted a possibly saved claim; retain its original request ID.",
            ));
        }
        if let Err(e) = timeout(
            Duration::from_secs(5),
            self.connected.adapter.disconnect(DisconnectRequest {
                binding_id: self.connected.binding.id.clone(),
                generation: self.connected.binding.generation.clone(),
            }),
        )
        .await
        .map_err(|_| host_error("Observer shutdown exceeded its 5-second bound."))
        .and_then(|r| r.map_err(adapter_error))
        {
            if error.is_none() {
                error = Some(e);
            }
        }
        SupervisorExit {
            pending: (!self.pending.is_empty()).then(|| PendingPage {
                reports: self.pending.into(),
                next_checkpoint: self.offered,
            }),
            pending_claim: self.pending_claim,
            acknowledged_checkpoint: self.checkpoint,
            diagnostics: self.diagnostics.take(),
            error,
        }
    }
}
fn adapter_error(error: AdapterError) -> CoreError {
    if error.validate().is_err() {
        protocol_error("Adapter returned a malformed error; no delivery absence is inferred.")
    } else {
        validated_error(error.into())
    }
}
fn host_error(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::HostUnreachable, message, "Retain original request/event IDs and reconcile before dispatch. This error does not prove absence of effects.")
}
fn protocol_error(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::ProtocolConflict, message, "Pause this binding, retain original IDs and reconcile verified facts; do not automatically resend.")
}
struct Counter {
    bytes: usize,
    limit: usize,
}
impl std::io::Write for Counter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.bytes = self.bytes.saturating_add(bytes.len());
        if self.bytes > self.limit {
            return Err(std::io::Error::other("bounded native response"));
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn frame_bound<'a>(events: impl Iterator<Item = &'a NormalizedEvent>) -> Result<(), CoreError> {
    let mut bytes = Counter {
        bytes: 0,
        limit: FRAME_BYTES,
    };
    for event in events {
        // Count into a sink; never materialize another response-sized buffer.
        serde_json::to_writer(&mut bytes, event).map_err(|_| {
            protocol_error("Provider response exceeds the existing 8MiB frame bound.")
        })?;
    }
    Ok(())
}
