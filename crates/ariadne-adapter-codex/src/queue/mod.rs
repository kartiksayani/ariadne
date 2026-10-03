//! Bounded provider-local correlation and IO. Core owns durable claims, replay and effects.
mod observe;
mod process;
use crate::{
    history::HistoryScan, transport::error, CodexDaemonReader, CodexHistoryClient, CodexOptions,
};
use ariadne_agent_protocol::*;
use futures_channel::oneshot;
use sha2::{Digest, Sha256 as Hasher};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{sync_channel, SyncSender, TrySendError},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub(crate) const MAX_CONTEXTS: usize = 100;
type Job = Box<dyn FnOnce(&mut State) + Send>;
#[derive(Clone)]
pub(crate) struct Record {
    request: Arc<SubmitRequest>,
    outcome: Option<SubmitOutcome>,
    anchor: Option<String>,
}
#[derive(Default)]
pub(crate) struct Shared {
    connection: Option<ConnectRequest>,
    last_connection: Option<ConnectRequest>,
    identity: Option<EndpointFingerprint>,
    records: HashMap<UuidV4, Record>,
}
pub(crate) struct Worker {
    sender: SyncSender<Job>,
    shared: Arc<Mutex<Shared>>,
}
pub(crate) struct State {
    options: CodexOptions,
    instance_id: UuidV4,
    client: Option<CodexHistoryClient>,
    shared: Arc<Mutex<Shared>>,
    observation: observe::Observer,
    observing: Option<(UuidV4, HistoryScan)>,
    last_observed: Option<UuidV4>,
    reconciliation: Option<(ReconcileRequest, HistoryScan)>,
}
impl Worker {
    pub(crate) fn new(options: CodexOptions, instance_id: UuidV4) -> Result<Self, AdapterError> {
        let shared = Arc::new(Mutex::new(Shared::default()));
        let (sender, receiver) = sync_channel::<Job>(1);
        let mut state = State {
            options,
            instance_id: instance_id.clone(),
            client: None,
            shared: shared.clone(),
            observation: observe::Observer::new(nonce(&instance_id)),
            observing: None,
            last_observed: None,
            reconciliation: None,
        };
        std::thread::Builder::new()
            .name("ariadne-codex-io".to_owned())
            .spawn(move || {
                while let Ok(job) = receiver.recv() {
                    job(&mut state);
                }
                // Dropping the observer transport leaves the externally owned host running.
            })
            .map_err(|_| {
                error(
                    AdapterErrorCode::HostUnreachable,
                    "Cannot start the bounded Codex IO worker.",
                )
            })?;
        Ok(Self { sender, shared })
    }
    pub(crate) fn call<T: Send + 'static>(
        &self,
        budget: Duration,
        operation: impl FnOnce(&mut State, Instant) -> Result<T, AdapterError> + Send + 'static,
    ) -> AdapterFuture<'static, T> {
        let deadline = Instant::now() + budget;
        let (reply, receive) = oneshot::channel();
        let job: Job = Box::new(move |state| {
            if !reply.is_canceled() {
                let result = if Instant::now() >= deadline {
                    Err(error(
                        AdapterErrorCode::HostUnreachable,
                        "Codex adapter IO deadline expired while waiting; no operation started.",
                    ))
                } else {
                    operation(state, deadline)
                };
                let _ = reply.send(result);
            }
        });
        if self.sender.try_send(job).is_err() {
            return Box::pin(async { Err(busy()) });
        }
        Box::pin(async move {
            receive.await.map_err(|_| {
                error(
                    AdapterErrorCode::HostUnreachable,
                    "Codex IO worker stopped; reconnect and reconcile outstanding attempts.",
                )
            })?
        })
    }
    pub(crate) fn submit(&self, request: SubmitRequest) -> AdapterFuture<'static, SubmitOutcome> {
        self.submit_before(request, Instant::now() + Duration::from_secs(20))
    }
    fn submit_before(
        &self,
        request: SubmitRequest,
        deadline: Instant,
    ) -> AdapterFuture<'static, SubmitOutcome> {
        if let Err(e) = validate_submit(&request) {
            return Box::pin(async { Err(e) });
        }
        let retained_request = Arc::new(request.clone());
        let mut shared = match self.shared.lock() {
            Ok(value) => value,
            Err(_) => return Box::pin(async { Err(poisoned()) }),
        };
        if let Err(e) = scope(&shared, &request.binding_id, &request.generation) {
            return Box::pin(async { Err(e) });
        }
        // This precedes capacity and worker admission: a duplicate can already have been sent.
        if let Some(prior) = shared.records.get(&request.attempt_id) {
            let prior = prior.clone();
            drop(shared);
            let result = if prior.request.as_ref() != &request {
                Err(error(
                    AdapterErrorCode::ProtocolConflict,
                    "Retained Codex attempt has different payload or scope.",
                ))
            } else {
                Ok(prior.outcome.clone().unwrap_or_else(|| process::uncertain("This exact Codex attempt is already queued or running; reconcile instead of resending.")))
            };
            return Box::pin(async { result });
        }
        if shared.records.len() >= MAX_CONTEXTS {
            let result = process::rejected("Codex has 100 retained attempt contexts; persist and acknowledge terminal observations before new work. Sender was not admitted.");
            return Box::pin(async { Ok(result) });
        }
        let attempt_id = request.attempt_id.clone();
        let job_attempt_id = attempt_id.clone();
        shared.records.insert(
            attempt_id.clone(),
            Record {
                request: retained_request,
                outcome: None,
                anchor: None,
            },
        );
        let (reply, receive) = oneshot::channel();
        let job: Job = Box::new(move |state| {
            let result = if reply.is_canceled() {
                Ok(process::rejected(
                    "Codex submit was abandoned before IO began; sender was not spawned.",
                ))
            } else {
                state.submit(request, deadline)
            };
            if let Ok(mut shared) = state.shared.lock() {
                if let Some(record) = shared.records.get_mut(&job_attempt_id) {
                    record.outcome = Some(result.as_ref().cloned().unwrap_or_else(|_| {
                        process::rejected("Codex pre-submit check failed; sender was not spawned.")
                    }));
                }
            }
            // A dropped active caller does not cancel the sender or discard its retained outcome.
            let _ = reply.send(result);
        });
        if let Err(failure) = self.sender.try_send(job) {
            shared.records.remove(&attempt_id);
            // The new job was never admitted. Existing attempts already returned above.
            let reason = match failure {
                TrySendError::Full(_) => {
                    "Codex adapter IO is busy; this new sender was not admitted or spawned."
                }
                TrySendError::Disconnected(_) => {
                    "Codex IO worker stopped; this new sender was not admitted or spawned."
                }
            };
            return Box::pin(async move { Ok(process::rejected(reason)) });
        }
        drop(shared);
        Box::pin(async move {
            receive.await.unwrap_or_else(|_| Ok(process::uncertain("Codex IO worker lost the submit receipt; delivery cannot be ruled out. Reconcile before recovery.")))
        })
    }
}

impl State {
    pub(crate) fn probe(
        &mut self,
        request: ProbeRequest,
        deadline: Instant,
    ) -> Result<ProbeResult, AdapterError> {
        let _reader =
            CodexDaemonReader::open_before(self.options.clone(), request.endpoint, deadline)?;
        Ok(ProbeResult {
            host_version: Some("0.160.0".to_owned()),
            compatibility: Compatibility::Compatible,
            availability: Availability::Available,
            setup_steps: Vec::new(),
        })
    }
    pub(crate) fn connect(
        &mut self,
        request: ConnectRequest,
        deadline: Instant,
    ) -> Result<ConnectResult, AdapterError> {
        request.validate()?;
        if self.observation.has_unacknowledged() {
            return Err(error(
                AdapterErrorCode::ProtocolConflict,
                "Persist and acknowledge the retained Codex observation batch before reconnecting.",
            ));
        }
        let daemon = CodexDaemonReader::open_before(
            self.options.clone(),
            request.endpoint.clone(),
            deadline,
        )?;
        let (client, mut result) =
            daemon.bind_before(request.clone(), self.instance_id.clone(), now()?, deadline)?;
        let mut shared = self.shared.lock().map_err(|_| poisoned())?;
        if let Some(prior) = &shared.last_connection {
            if prior.binding_id == request.binding_id
                && prior.generation == request.generation
                && (prior.external_session_id != request.external_session_id
                    || shared.identity.as_ref() != Some(&result.endpoint_fingerprint))
            {
                return Err(error(AdapterErrorCode::BindingMismatch, "Same-generation Codex reconnect changed endpoint/thread identity; use a fresh generation and reconcile persisted attempts."));
            }
        }
        result.capabilities.deferred_delivery = Capability { supported: true, conditions: vec!["Installed pinned Codex queue, explicit existing endpoint and thread; runtime owns durable claim and lease validation.".to_owned()] };
        result.validate_for(&request)?;
        shared.records.retain(|_, record| {
            record.request.binding_id == request.binding_id
                && record.request.generation == request.generation
        });
        shared.identity = Some(result.endpoint_fingerprint.clone());
        shared.last_connection = Some(request.clone());
        shared.connection = Some(request);
        self.client = Some(client);
        self.observing = None;
        self.reconciliation = None;
        self.observation.reset();
        Ok(result)
    }
    fn submit(
        &mut self,
        request: SubmitRequest,
        deadline: Instant,
    ) -> Result<SubmitOutcome, AdapterError> {
        if Instant::now() >= deadline {
            return Ok(process::rejected(
                "Codex submit deadline expired before IO; sender was not spawned.",
            ));
        }
        let thread = self
            .shared
            .lock()
            .map_err(|_| poisoned())?
            .connection
            .as_ref()
            .map(|r| r.external_session_id.clone())
            .ok_or_else(|| {
                error(
                    AdapterErrorCode::BindingMismatch,
                    "Connect the selected Codex thread before submitting.",
                )
            })?;
        let client = self.client.as_mut().ok_or_else(|| {
            error(
                AdapterErrorCode::HostUnreachable,
                "Connect Codex before submitting.",
            )
        })?;
        client.verify_scope(&request.binding_id, &request.generation)?;
        let anchor = client.prepare_queue(deadline)?;
        self.shared
            .lock()
            .map_err(|_| poisoned())?
            .records
            .get_mut(&request.attempt_id)
            .ok_or_else(poisoned)?
            .anchor = anchor;
        client.verify_identity()?;
        let outcome = process::send(
            client.queue_executable(),
            client.resolved_socket(),
            &thread,
            &request.formatted_payload,
            deadline,
        );
        if !matches!(outcome, SubmitOutcome::RejectedBeforeDelivery { .. })
            && client.verify_identity().is_err()
        {
            return Ok(process::uncertain("Codex endpoint/executable identity changed after sender spawn; reconcile under a freshly verified connection."));
        }
        Ok(outcome)
    }
    pub(crate) fn disconnect(
        &mut self,
        request: DisconnectRequest,
    ) -> Result<DisconnectResult, AdapterError> {
        scope(
            &*self.shared.lock().map_err(|_| poisoned())?,
            &request.binding_id,
            &request.generation,
        )?;
        if self.observation.has_unacknowledged() {
            return Err(error(AdapterErrorCode::ProtocolConflict, "Persist and acknowledge the retained Codex observation batch before disconnecting."));
        }
        self.client = None;
        self.observing = None;
        self.reconciliation = None;
        self.shared.lock().map_err(|_| poisoned())?.connection = None;
        self.observation.reset();
        Ok(DisconnectResult {})
    }
    pub(crate) fn reconcile(
        &mut self,
        request: ReconcileRequest,
        deadline: Instant,
    ) -> Result<ReconcileResult, AdapterError> {
        request.validate()?;
        let client = self.client.as_mut().ok_or_else(|| {
            error(
                AdapterErrorCode::HostUnreachable,
                "Connect the exact Codex thread before reconciliation.",
            )
        })?;
        client.verify_scope(&request.binding_id, &request.generation)?;
        // Observation tokens are deliberately not parsed here. Recovery uses persisted attempt
        // evidence and fresh provider-private continuation, even after process restart.
        let reset = self
            .reconciliation
            .as_ref()
            .is_none_or(|(prior, scan)| prior != &request || !scan.progress().has_more);
        if reset {
            self.reconciliation = Some((request.clone(), client.begin_scan(None)?));
        }
        let scan = &mut self.reconciliation.as_mut().ok_or_else(poisoned)?.1;
        let mut result = client.read_history_before(request.clone(), scan, now()?, deadline)?;
        recover_acceptance(&mut result, scan)?;
        result.validate_for(&request)?;
        Ok(result)
    }
}
fn recover_acceptance(
    result: &mut ReconcileResult,
    scan: &HistoryScan,
) -> Result<(), AdapterError> {
    for evidence in &mut result.attempt_evidence {
        let Some(started) = evidence
            .events
            .iter()
            .find(|event| matches!(event.event, EventPayload::TurnStarted { .. }))
            .cloned()
        else {
            continue;
        };
        let original = scan.user_message_identity(&evidence.attempt_id).ok_or_else(|| error(AdapterErrorCode::ProtocolConflict, "Verified Codex original-message identity is missing; acceptance remains unresolved."))?;
        evidence
            .events
            .insert(0, acceptance_event(started, original)?);
    }
    Ok(())
}
fn acceptance_event(
    started: NormalizedEvent,
    original: &crate::history::UserMessageIdentity,
) -> Result<NormalizedEvent, AdapterError> {
    let provider_reference = original
        .client_id
        .as_deref()
        .filter(|id| !id.is_empty() && id.len() <= 4096)
        .or_else(|| {
            (!original.host_message_id.is_empty() && original.host_message_id.len() <= 4096)
                .then_some(original.host_message_id.as_str())
        });
    let receipt = provider_reference.map(|reference| HostReceipt {
        provider_reference: reference.to_owned(),
        observed_at: started.observed_at.clone(),
    });
    let event_id = digest(
        &serde_json::to_vec(&(
            "codex-accepted-v1",
            &started.binding_id,
            &started.generation,
            &started.attempt_id,
            &started.host_turn_id,
            &original.host_message_id,
        ))
        .map_err(|_| poisoned())?,
    );
    Ok(NormalizedEvent {
        event_id,
        event: EventPayload::Accepted { receipt },
        ..started
    })
}
fn scope(shared: &Shared, binding: &UuidV4, generation: &UuidV4) -> Result<(), AdapterError> {
    let connection = shared.connection.as_ref().ok_or_else(|| {
        error(
            AdapterErrorCode::BindingMismatch,
            "Connect the selected Codex thread first.",
        )
    })?;
    if &connection.binding_id != binding {
        return Err(error(
            AdapterErrorCode::BindingMismatch,
            "Codex adapter belongs to another binding.",
        ));
    }
    if &connection.generation != generation {
        return Err(error(
            AdapterErrorCode::StaleGeneration,
            "Codex adapter belongs to another generation.",
        ));
    }
    Ok(())
}
fn validate_submit(request: &SubmitRequest) -> Result<(), AdapterError> {
    let marker = format!(
        "[ARIADNE_INPUT:{}:{}]",
        request.input_id.as_str(),
        request.attempt_id.as_str()
    );
    if request.formatted_payload.len() > 64 * 1024
        || request.wire_marker != marker
        || request.formatted_payload.split('\n').next() != Some(marker.as_str())
        || request.formatted_payload.contains('\0')
        || digest(request.formatted_payload.as_bytes()) != request.payload_sha256.as_str()
    {
        return Err(error(AdapterErrorCode::InvalidArgument, "Codex requires the exact persisted payload (at most 64 KiB), first-line input/attempt marker and complete SHA256; no normalization is allowed."));
    }
    Ok(())
}
fn busy() -> AdapterError {
    error(
        AdapterErrorCode::HostUnreachable,
        "Codex adapter IO is busy; retry this read/connect operation later.",
    )
}
fn poisoned() -> AdapterError {
    error(
        AdapterErrorCode::ProtocolConflict,
        "Codex provider-local IO state is unavailable; reconnect and reconcile persisted attempts.",
    )
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Hasher::digest(bytes))
}
fn nonce(instance: &UuidV4) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    digest(
        format!(
            "{}:{:?}:{}:{}",
            instance.as_str(),
            SystemTime::now(),
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )
        .as_bytes(),
    )
}
fn now() -> Result<UtcMillis, AdapterError> {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| {
        error(
            AdapterErrorCode::HostUnreachable,
            "System clock precedes UTC epoch.",
        )
    })?;
    utc(elapsed)
}
fn utc(elapsed: Duration) -> Result<UtcMillis, AdapterError> {
    let seconds: libc::time_t = elapsed.as_secs().try_into().map_err(|_| {
        error(
            AdapterErrorCode::HostUnreachable,
            "System clock exceeds supported UTC range.",
        )
    })?;
    // SAFETY: valid seconds input and writable tm output; gmtime_r has no shared static storage.
    let mut calendar: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::gmtime_r(&seconds, &mut calendar) }.is_null() {
        return Err(error(
            AdapterErrorCode::HostUnreachable,
            "Cannot read UTC system clock.",
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
            "System clock is outside supported UTC range.",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::Future,
        task::{Context, Poll, Wake, Waker},
        thread,
    };
    struct Notify(thread::Thread);
    impl Wake for Notify {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }
    fn wait<T>(future: impl Future<Output = T>) -> T {
        let waker = Waker::from(Arc::new(Notify(thread::current())));
        let mut context = Context::from_waker(&waker);
        let mut future = std::pin::pin!(future);
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match future.as_mut().poll(&mut context) {
                Poll::Ready(value) => return value,
                Poll::Pending => {
                    assert!(Instant::now() < deadline);
                    thread::park_timeout(Duration::from_millis(10));
                }
            }
        }
    }
    fn connection() -> ConnectRequest {
        serde_json::from_value(serde_json::json!({"binding_id":"11111111-1111-4111-8111-111111111111","generation":"22222222-2222-4222-8222-222222222222","external_session_id":"thread","endpoint":{"kind":"unix_socket","path":"/unused"},"configuration":{"namespace":"codex","values":{}}})).unwrap()
    }
    #[test]
    fn fresh_acceptance_identity_preserves_reference_and_excludes_observation_times() {
        let original = crate::history::UserMessageIdentity {
            host_turn_id: "actual-turn".to_owned(),
            host_message_id: "actual-message".to_owned(),
            client_id: Some("actual-client".to_owned()),
        };
        let make = |at: &str| {
            let started = serde_json::from_value(serde_json::json!({
                "event_id":"actual-start",
                "binding_id":connection().binding_id,
                "generation":connection().generation,
                "input_id":"33333333-3333-4333-8333-333333333333",
                "attempt_id":"44444444-4444-4444-8444-444444444444",
                "host_turn_id":"actual-turn",
                "observed_at":at,
                "kind":"turn_started",
                "payload":{}
            }))
            .unwrap();
            acceptance_event(started, &original).unwrap()
        };
        let first = make("2026-10-04T12:00:00.000Z");
        let mut later = make("2026-10-04T12:00:01.000Z");
        assert_eq!(first.event_id, later.event_id);
        assert_ne!(first.observed_at, later.observed_at);
        let EventPayload::Accepted {
            receipt: Some(first_receipt),
        } = &first.event
        else {
            panic!("missing provider receipt")
        };
        let EventPayload::Accepted {
            receipt: Some(later_receipt),
        } = &mut later.event
        else {
            panic!("missing provider receipt")
        };
        assert_eq!(first_receipt.provider_reference, "actual-client");
        assert_eq!(
            later_receipt.provider_reference,
            first_receipt.provider_reference
        );
        assert_eq!(later_receipt.observed_at, later.observed_at);
        assert_ne!(first_receipt.observed_at, later_receipt.observed_at);
        later_receipt.observed_at = first_receipt.observed_at.clone();
        later.observed_at = first.observed_at.clone();
        assert_eq!(first, later);
    }
    #[test]
    fn queued_read_and_submit_budgets_expire_before_any_operation_starts() {
        for submit in [false, true] {
            let instance = connection().binding_id;
            let worker = Worker::new(
                CodexOptions::new("/unused".into(), "/unused".into()).unwrap(),
                instance,
            )
            .unwrap();
            worker.shared.lock().unwrap().connection = Some(connection());
            let (started, began) = std::sync::mpsc::channel();
            let (release, gate) = std::sync::mpsc::channel();
            let active = worker.call(Duration::from_secs(1), move |_, _| {
                started.send(()).unwrap();
                gate.recv().unwrap();
                Ok(())
            });
            began.recv_timeout(Duration::from_secs(1)).unwrap();
            let read = if !submit {
                Some(worker.call(
                    Duration::from_millis(10),
                    |_, _| -> Result<(), AdapterError> { panic!("expired operation started") },
                ))
            } else {
                None
            };
            let sending = if submit {
                let input_id = UuidV4::new("33333333-3333-4333-8333-333333333333").unwrap();
                let attempt_id = UuidV4::new("44444444-4444-4444-8444-444444444444").unwrap();
                let wire_marker = format!(
                    "[ARIADNE_INPUT:{}:{}]",
                    input_id.as_str(),
                    attempt_id.as_str()
                );
                let formatted_payload = format!("{wire_marker}\n{{\"owner_text\":\"exact\"}}");
                Some(worker.submit_before(
                    SubmitRequest {
                        binding_id: connection().binding_id,
                        generation: connection().generation,
                        input_id,
                        attempt_id,
                        payload_sha256: Sha256::new(digest(formatted_payload.as_bytes())).unwrap(),
                        formatted_payload,
                        wire_marker,
                    },
                    Instant::now() + Duration::from_millis(10),
                ))
            } else {
                None
            };
            thread::sleep(Duration::from_millis(30));
            release.send(()).unwrap();
            wait(active).unwrap();
            if let Some(read) = read {
                assert_eq!(
                    wait(read).unwrap_err().code,
                    AdapterErrorCode::HostUnreachable
                );
            }
            if let Some(sending) = sending {
                assert!(matches!(
                    wait(sending).unwrap(),
                    SubmitOutcome::RejectedBeforeDelivery { .. }
                ));
            }
        }
    }
    #[test]
    fn observation_time_is_exact_utc_and_worker_nonce_changes_for_the_same_instance() {
        assert_eq!(
            utc(Duration::from_millis(1_000)).unwrap().as_str(),
            "1970-01-01T00:00:01.000Z"
        );
        assert_eq!(
            utc(Duration::from_millis(951_827_696_123))
                .unwrap()
                .as_str(),
            "2000-02-29T12:34:56.123Z"
        );
        assert!(utc(Duration::from_secs(u64::MAX)).is_err());
        assert_ne!(
            nonce(&connection().binding_id),
            nonce(&connection().binding_id)
        );
    }
}
