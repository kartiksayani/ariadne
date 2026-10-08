//! Independent binding scheduling; core owns FIFO, replay and durable effects.
mod core_io;
mod diagnostics;
mod gate;
pub use diagnostics::Diagnostic;
pub use gate::ClaimGate;

use crate::{
    control::validated_error,
    health::{plain_reason, HealthObserver, SupervisorHealth},
    leases::BindingLease,
    logging,
};
use ariadne_agent_protocol::*;
use ariadne_core::*;
use ariadne_domain::models::{
    Binding, ConnectionState, DeliveryMode, ExecutionState, Freshness, InputState,
    PresenceObservation, PresenceSource,
};
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
/// Retry delay after a failed cycle: doubles from the first value up to the cap.
const BACKOFF_FIRST: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
const WAITING_ON_EARLIER: &str = "Checking whether an earlier answer reached Codex.";
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
const FRAME_BYTES: usize = 8 * 1024 * 1024;
const SCAN_BYTES: usize = 16 * 1024 * 1024;

/// Opt-in native observation sink. These facts follow validated Core receipts;
/// they never authorize a claim or change durable domain state.
#[derive(Clone)]
pub enum PresenceUpdate {
    Connected {
        hint: PresenceChangedHint,
        endpoint: EndpointFingerprint,
    },
    Observed {
        hint: PresenceChangedHint,
        endpoint: EndpointFingerprint,
    },
    Stopped {
        hint: PresenceChangedHint,
        endpoint: EndpointFingerprint,
    },
}
pub type PresenceObserver = dyn Fn(PresenceUpdate) + Send + Sync;

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
    presence: Option<Arc<PresenceObserver>>,
    health: Option<Arc<HealthObserver>>,
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
            presence: None,
            health: None,
        })
    }
    pub fn with_presence_observer(mut self, observer: Arc<PresenceObserver>) -> Self {
        self.presence = Some(observer);
        self
    }
    /// Health is published only for push delivery (the desktop sends). Pull
    /// bindings are delivered by their host-side Mod and never publish health.
    pub fn with_health_observer(mut self, observer: Arc<HealthObserver>) -> Self {
        self.health = Some(observer);
        self
    }
    pub fn delivery_mode(&self) -> DeliveryMode {
        self.connected.capabilities.delivery_mode.clone()
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
    last_presence: Option<PresenceObservation>,
    presence_tasks: Vec<JoinHandle<Result<(), CoreError>>>,
    /// Throttles re-checks of earlier attempts that history could not settle yet.
    reconcile_after: Option<tokio::time::Instant>,
    reconcile_backoff: Backoff,
    last_health: Option<SupervisorHealth>,
}
#[derive(Debug)]
struct Backoff {
    next: Duration,
}
impl Default for Backoff {
    fn default() -> Self {
        Self {
            next: BACKOFF_FIRST,
        }
    }
}
impl Backoff {
    fn reset(&mut self) {
        self.next = BACKOFF_FIRST;
    }
    fn take(&mut self) -> Duration {
        let delay = self.next;
        self.next = (self.next * 2).min(BACKOFF_MAX);
        delay
    }
}
/// Core's final answer to a reported attempt fact: the attempt is sealed, or
/// Core saved this contradiction (with whatever barrier it needs; a saved
/// conflict carries its revision). The same event ID gets the same answer
/// forever, so the fact is acknowledged rather than retried.
fn final_verdict(error: &CoreError) -> bool {
    match error.code {
        CoreErrorCode::AttemptSealed => true,
        CoreErrorCode::ProtocolConflict => error.current_revision.is_some(),
        _ => false,
    }
}
/// Error code and Ariadne's own barrier reason for the log. Never the message:
/// it can carry text a provider sent (ADR-0087).
fn log_cause(error: &CoreError) -> String {
    match error.details.as_ref().and_then(|details| details.reason) {
        Some(reason) => format!("{:?} ({reason:?})", error.code),
        None => format!("{:?}", error.code),
    }
}
/// The supervisor's scope no longer exists or no longer selects this host:
/// retrying cannot succeed, so the task ends and composition is told why.
fn scope_ended(error: &CoreError) -> bool {
    matches!(
        error.code,
        CoreErrorCode::StaleGeneration
            | CoreErrorCode::BindingMismatch
            | CoreErrorCode::BindingConflict
            | CoreErrorCode::BindingAmbiguous
            | CoreErrorCode::NotFound
    ) || error
        .details
        .as_ref()
        .is_some_and(|details| details.reason == Some(BarrierReason::Disconnected))
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
            last_presence: None,
            presence_tasks: Vec::new(),
            reconcile_after: None,
            reconcile_backoff: Backoff::default(),
            last_health: None,
        }
    }
    fn label(&self) -> String {
        format!(
            "binding={} generation={}",
            self.connected.binding.id.as_str(),
            self.connected.binding.generation.as_str()
        )
    }
    /// Publishes a changed health entry for push delivery only; pull bindings
    /// (Claude Code via its Mod) never publish, so no UI says "Not sending".
    fn publish_health(&mut self, health: SupervisorHealth) {
        if self.connected.connected.capabilities.delivery_mode != DeliveryMode::Push {
            return;
        }
        if self
            .last_health
            .as_ref()
            .is_some_and(|prior| prior.same_as(&health))
        {
            return;
        }
        self.last_health = Some(health.clone());
        if let Some(observer) = &self.connected.health {
            observer(health);
        }
    }
    fn health_running(&mut self) {
        let health = SupervisorHealth::running(
            self.connected.binding.id.clone(),
            self.connected.binding.generation.clone(),
            (self.connected.facts.now)(),
        );
        self.publish_health(health);
    }
    fn health_backing_off(&mut self, reason: String, retry: Duration) {
        let health = SupervisorHealth::backing_off(
            self.connected.binding.id.clone(),
            self.connected.binding.generation.clone(),
            reason,
            retry,
            (self.connected.facts.now)(),
        );
        self.publish_health(health);
    }
    fn health_stopped(&mut self, reason: String) {
        let health = SupervisorHealth::stopped(
            self.connected.binding.id.clone(),
            self.connected.binding.generation.clone(),
            reason,
            (self.connected.facts.now)(),
        );
        self.publish_health(health);
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
        // All or nothing: a retried cycle must never acknowledge a checkpoint
        // past an event that was rejected here and never became pending.
        let mut accepted = Vec::new();
        for event in events {
            event.validate().map_err(adapter_error)?;
            let context = self.context(&event, historical)?;
            accepted.push(PendingReport { event, context });
        }
        self.pending.extend(accepted);
        Ok(())
    }
    async fn report(&mut self) -> Result<(), CoreError> {
        while let Some(pending) = self.pending.front() {
            let context = pending.context.clone();
            let core = self.connected.core.clone();
            let reported = pending.event.clone();
            let receipt = core_io::call(self.lease.clone(), move || {
                let receipt = core.report(context.clone(), reported.clone())?;
                receipt.validate_for(&context, &reported)?;
                Ok(receipt)
            })
            .await;
            if let Err(e) = &receipt {
                let event = &self.pending.front().expect("retained until verdict").event;
                // Retrying this event ID can only repeat the same answer and
                // would hold every later fact and claim behind it. Binding facts
                // (the opening Connected one above all) keep failing loudly.
                if event.attempt_id.is_some() && final_verdict(e) {
                    let id = |value: Option<&UuidV4>| value.map_or("-", UuidV4::as_str).to_owned();
                    logging::warn(
                        "delivery",
                        &format!(
                            "{} acknowledged a late fact Core already settled: {:?} input={} attempt={}",
                            self.label(),
                            e.code,
                            id(event.input_id.as_ref()),
                            id(event.attempt_id.as_ref()),
                        ),
                    );
                    self.pending.pop_front();
                    self.validated_reports = self.validated_reports.saturating_add(1);
                    continue;
                }
            }
            receipt?;
            let observation = match &self
                .pending
                .front()
                .expect("retained until receipt")
                .event
                .event
            {
                EventPayload::Connected { .. } => {
                    Some((self.connected.connected.observation.clone(), true))
                }
                EventPayload::Presence { observation } => Some((observation.clone(), false)),
                EventPayload::Disconnected { .. } => {
                    self.invalidate_presence().await?;
                    None
                }
                _ => None,
            };
            if let Some((observation, initial)) = observation {
                self.observe_presence(observation, initial).await?;
            }
            log_delivery_fact(&self.pending.front().expect("retained until receipt").event);
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
    async fn observe_presence(
        &mut self,
        observation: PresenceObservation,
        initial: bool,
    ) -> Result<(), CoreError> {
        if observation.instance_id != self.connected.connected.observation.instance_id
            || observation.generation != self.connected.binding.generation
        {
            return Ok(());
        }
        self.last_presence = Some(observation.clone());
        let hint = PresenceChangedHint {
            binding_id: self.connected.binding.id.clone(),
            generation: self.connected.binding.generation.clone(),
            observation,
        };
        let endpoint = self.connected.connected.endpoint_fingerprint.clone();
        self.publish_presence(if initial {
            PresenceUpdate::Connected { hint, endpoint }
        } else {
            PresenceUpdate::Observed { hint, endpoint }
        })
        .await
    }
    async fn publish_presence(&mut self, update: PresenceUpdate) -> Result<(), CoreError> {
        let Some(observer) = self.connected.presence.clone() else {
            return Ok(());
        };
        // Retain the task if run's stop selection cancels this await. Shutdown
        // drains it before any replacement instance can publish observations.
        self.presence_tasks
            .push(core_io::start(self.lease.clone(), move || {
                observer(update);
                Ok(())
            }));
        self.presence_tasks
            .last_mut()
            .expect("owned observation task")
            .await
            .map_err(|_| protocol_error("Native presence observer failed."))??;
        self.presence_tasks.pop();
        Ok(())
    }
    async fn invalidate_presence(&mut self) -> Result<(), CoreError> {
        if let Some(mut observation) = self.last_presence.clone() {
            observation.connection_state = ConnectionState::Disconnected;
            observation.execution_state = ExecutionState::Unknown;
            observation.freshness = Freshness::Unknown;
            let hint = PresenceChangedHint {
                binding_id: self.connected.binding.id.clone(),
                generation: self.connected.binding.generation.clone(),
                observation,
            };
            let endpoint = self.connected.connected.endpoint_fingerprint.clone();
            self.publish_presence(PresenceUpdate::Stopped { hint, endpoint })
                .await?;
        }
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
    /// Returns the `input=… attempt=…` labels history could not settle yet;
    /// empty means every persisted attempt was reconciled.
    async fn reconcile(&mut self) -> Result<Vec<String>, CoreError> {
        let attempts = self.inputs().await?;
        let batches = if attempts.is_empty() {
            1
        } else {
            attempts.len().div_ceil(100)
        };
        let mut waiting = Vec::new();
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
                // Reconcile continuations are provider-private and never become
                // the observation checkpoint, so a retried cycle keeps its place.
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
            waiting.extend(
                attempts
                    .iter()
                    .filter(|a| unresolved.contains(&a.attempt_id))
                    .map(|a| {
                        format!(
                            "input={} attempt={}",
                            a.input_id.as_str(),
                            a.attempt_id.as_str()
                        )
                    }),
            );
        }
        Ok(waiting)
    }
    async fn submit(&mut self) -> Result<(), CoreError> {
        if self.connected.connected.capabilities.delivery_mode
            == ariadne_domain::models::DeliveryMode::Pull
        {
            return Ok(());
        }
        // A claim whose receipt was lost may already be saved: retry that exact
        // request ID so Core replays it instead of preparing another attempt.
        let request = match self.pending_claim.clone() {
            Some(retained) => retained,
            None => ClaimRequest {
                binding_id: self.connected.binding.id.clone(),
                generation: self.connected.binding.generation.clone(),
                request_id: (self.connected.facts.next_id)(),
            },
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
        logging::info(
            "delivery",
            &format!(
                "{} claimed input={} attempt={}",
                self.label(),
                attempt.input_id.as_str(),
                attempt.attempt_id.as_str()
            ),
        );
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
        logging::info(
            "delivery",
            &format!(
                "{} submitted input={} attempt={} outcome={}",
                self.label(),
                attempt.input_id.as_str(),
                attempt.attempt_id.as_str(),
                match &outcome {
                    SubmitOutcome::Accepted { .. } => "accepted",
                    SubmitOutcome::RejectedBeforeDelivery { .. } => "rejected_before_delivery",
                    SubmitOutcome::Uncertain { .. } => "uncertain",
                }
            ),
        );
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
        self.queue(result.events, false)?;
        self.offered = result.next_checkpoint;
        self.report().await
    }
    /// A preparation stranded by an earlier failed cycle becomes its terminal
    /// fact: possibly sent is uncertain, never admitted is rejected. Never resent.
    fn settle_submitting(&mut self, reason: &str) -> Result<(), CoreError> {
        let Some((attempt, started)) = self.submitting.take() else {
            return Ok(());
        };
        let (kind, payload) = if started {
            (
                TerminalEventKind::Uncertain,
                EventPayload::Uncertain {
                    reason: format!(
                        "{reason} during possible submission; delivery cannot be ruled out."
                    ),
                },
            )
        } else {
            (
                TerminalEventKind::Rejected,
                EventPayload::Rejected {
                    reason: format!("{reason} before adapter submission admission."),
                },
            )
        };
        let id = terminal_event_id(
            &self.connected.binding.id,
            &self.connected.binding.generation,
            &attempt.attempt_id,
            None,
            kind,
            None,
        )
        .map_err(adapter_error)?;
        self.queue([self.event(id, payload, Some(&attempt))], false)
    }
    /// One scheduling pass. Pending facts always flush first, with their
    /// original IDs, so a retried pass never skips or duplicates a fact.
    async fn cycle(&mut self) -> Result<(), CoreError> {
        self.settle_submitting("A delivery step failed")?;
        if !self.pending.is_empty() {
            self.report().await?;
        }
        if !self.reconciled
            && self
                .reconcile_after
                .is_none_or(|after| tokio::time::Instant::now() >= after)
        {
            let waiting = self.reconcile().await?;
            if waiting.is_empty() {
                self.reconciled = true;
                self.reconcile_after = None;
                self.gate.reconciled_from_trusted_native()?;
                logging::info(
                    "supervisor",
                    &format!("{} reconciled; sending is open.", self.label()),
                );
                self.publish();
            } else {
                // Core's FIFO refuses every claim on this binding while these
                // attempts' inputs are in flight or need attention, so the
                // gate stays closed; re-check with backoff and say what blocks.
                let delay = self.reconcile_backoff.take();
                self.reconcile_after = Some(tokio::time::Instant::now() + delay);
                logging::warn(
                    "supervisor",
                    &format!(
                        "{} waiting on earlier attempts history cannot settle yet: {}; re-checking in {}s.",
                        self.label(),
                        waiting.join(", "),
                        delay.as_secs()
                    ),
                );
                self.health_backing_off(WAITING_ON_EARLIER.into(), delay);
            }
        }
        self.observe().await?;
        if self.reconciled {
            self.submit().await?;
        }
        Ok(())
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
        logging::info(
            "supervisor",
            &format!(
                "{} started ({:?} delivery).",
                self.label(),
                self.connected.delivery_mode()
            ),
        );
        // The connected fact opens the binding's lifecycle; without its receipt
        // nothing later is attributable, so this one failure ends the task.
        let mut error = self.queue([initial], false).err();
        if error.is_none() {
            error = self.report().await.err();
        }
        let mut backoff = Backoff::default();
        // The failure being retried, handed to the caller if a stop interrupts it.
        let mut unresolved: Option<CoreError> = None;
        while error.is_none() {
            let outcome = tokio::select! {
                biased;
                _ = &mut stop => None,
                result = self.cycle() => Some(result),
            };
            let Some(result) = outcome else {
                // A retry was under way; whether it cleared the cause is unknown.
                unresolved = None;
                break;
            };
            let delay = match result {
                Ok(()) => None,
                // Core owns durable pause/result barriers. Continue observation.
                Err(e)
                    if matches!(
                        e.code,
                        CoreErrorCode::InvalidTransition
                            | CoreErrorCode::ResultMissing
                            | CoreErrorCode::DeliveryUncertain
                    ) && self.pending.is_empty()
                        && !scope_ended(&e) =>
                {
                    None
                }
                Err(e) if scope_ended(&e) => {
                    error = Some(e);
                    break;
                }
                Err(e) => {
                    let delay = backoff.take();
                    logging::warn(
                        "supervisor",
                        &format!(
                            "{} cycle failed: {}; retrying in {}s.",
                            self.label(),
                            log_cause(&e),
                            delay.as_secs()
                        ),
                    );
                    self.health_backing_off(plain_reason(&e), delay);
                    unresolved = Some(e);
                    Some(delay)
                }
            };
            let delay = delay.unwrap_or_else(|| {
                unresolved = None;
                backoff.reset();
                if self.reconciled {
                    self.health_running();
                }
                POLL
            });
            tokio::select! { biased; _ = &mut stop => break, _ = tokio::time::sleep(delay) => {} }
        }
        // Only a lost connected receipt or an ended scope reaches here with an
        // error; every other failure was retried above.
        if let Some(e) = &error {
            logging::error(
                "supervisor",
                &format!("{} stopped: {}.", self.label(), log_cause(e)),
            );
            self.health_stopped(plain_reason(e));
        } else {
            logging::info(
                "supervisor",
                &format!("{} stopped on request.", self.label()),
            );
        }
        self.gate.stop();
        if let Err(e) = self.settle_submitting("Desktop stopped") {
            if error.is_none() {
                error = Some(e);
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
        if error.is_none() {
            error = unresolved;
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
        for task in std::mem::take(&mut self.presence_tasks) {
            if !matches!(task.await, Ok(Ok(()))) && error.is_none() {
                error = Some(protocol_error("Native presence observer did not complete."));
            }
        }
        if let Err(e) = self.invalidate_presence().await {
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
/// Logs a saved delivery fact by kind and IDs only. Output text, reasons and
/// diagnostics may quote the conversation, so they never reach the log.
fn log_delivery_fact(event: &NormalizedEvent) {
    let kind = match &event.event {
        EventPayload::Accepted { .. } => "accepted",
        EventPayload::Rejected { .. } => "rejected",
        EventPayload::Uncertain { .. } => "uncertain",
        EventPayload::TurnFinished { status, .. } => match status {
            TurnFinishedStatus::Completed => "turn_finished completed",
            TurnFinishedStatus::Failed => "turn_finished failed",
            TurnFinishedStatus::Interrupted => "turn_finished interrupted",
        },
        EventPayload::Disconnected { .. } => "disconnected",
        EventPayload::Connected { .. } => "connected",
        EventPayload::TurnStarted {}
        | EventPayload::VisibleOutput { .. }
        | EventPayload::Presence { .. } => return,
    };
    let id = |value: Option<&UuidV4>| value.map_or("-", UuidV4::as_str).to_owned();
    logging::info(
        "delivery",
        &format!(
            "saved {kind} binding={} generation={} input={} attempt={}",
            event.binding_id.as_str(),
            event.generation.as_str(),
            id(event.input_id.as_ref()),
            id(event.attempt_id.as_ref()),
        ),
    );
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
