//! No live hosts: a local wire-fixture daemon and argv-recording executable exercise the seam.
use ariadne_adapter_codex::{CodexAdapter, CodexDaemonReader, CodexOptions, QualifiedCodexThread};
use ariadne_agent_protocol::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256 as Hasher};
use std::{
    fs,
    future::Future,
    os::unix::{fs::PermissionsExt, net::UnixListener},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    task::{Context, Poll, Wake, Waker},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tungstenite::Message;

const BINDING: &str = "11111111-1111-4111-8111-111111111111";
const GENERATION: &str = "22222222-2222-4222-8222-222222222222";
const THREAD: &str = "chosen thread:opaque";
fn id(n: usize) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn fixture(name: &str) -> Value {
    serde_json::from_slice(
        &fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../contracts/providers/codex/0.160.0/fixtures")
                .join(name),
        )
        .unwrap(),
    )
    .unwrap()
}
struct Notify(thread::Thread);
impl Wake for Notify {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
    fn wake_by_ref(self: &Arc<Self>) {
        self.0.unpark();
    }
}
fn block_on<T>(future: impl Future<Output = T>) -> T {
    let waker = Waker::from(Arc::new(Notify(thread::current())));
    let mut context = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => thread::park_timeout(Duration::from_secs(2)),
        }
    }
}
struct Harness {
    directory: tempfile::TempDir,
    executable: PathBuf,
    socket: PathBuf,
    argv: PathBuf,
    stop: Arc<AtomicBool>,
    calls: Arc<Mutex<Vec<Value>>>,
    turns: Arc<Mutex<Value>>,
    read: Arc<Mutex<Value>>,
    initialize_delay: Arc<Mutex<Duration>>,
    read_delay: Arc<Mutex<Duration>>,
    worker: Option<JoinHandle<()>>,
}
impl Harness {
    fn new(mode: &str) -> Self {
        let directory = tempfile::Builder::new()
            .prefix("ariadne-queue-")
            .tempdir_in("/tmp")
            .unwrap();
        let executable = directory.path().join("codex executable");
        let argv = directory.path().join("argv");
        let count = directory.path().join("count");
        let release = directory.path().join("release");
        let behavior = match mode {
            "nonzero" => "exit 7\n".to_owned(),
            "gate" => format!(
                "while [ ! -f '{}' ]; do sleep 0.01; done\n",
                release.display()
            ),
            "flood" => "head -c 131072 /dev/zero\nhead -c 131072 /dev/zero >&2\n".to_owned(),
            _ => "exit 0\n".to_owned(),
        };
        // Owner bytes are never interpolated here: the stub records its actual argument vector.
        fs::write(&executable, format!("#!/bin/sh\nif [ \"$1\" = --version ]; then printf 'codex-cli 0.160.0\\n'; exit 0; fi\nprintf '%s\\0' \"$@\" > '{}'\nprintf 'sent\\n' >> '{}'\n{}", argv.display(), count.display(), behavior)).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let socket = directory.path().join("daemon.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let called = calls.clone();
        let mut anchor = fixture("turns-response.json");
        anchor["data"].as_array_mut().unwrap().truncate(1);
        anchor["data"][0]["id"] = json!("pre-submit-anchor");
        let turns = Arc::new(Mutex::new(anchor));
        let history = turns.clone();
        let read = Arc::new(Mutex::new(fixture("read-response.json")));
        let metadata = read.clone();
        let initialize_delay = Arc::new(Mutex::new(Duration::ZERO));
        let init_delay = initialize_delay.clone();
        let read_delay = Arc::new(Mutex::new(Duration::ZERO));
        let thread_delay = read_delay.clone();
        let worker = thread::spawn(move || {
            let mut connections = Vec::new();
            while !stopped.load(Ordering::SeqCst) {
                let stream = match listener.accept() {
                    Ok((stream, _)) => stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(e) => panic!("fixture accept {e}"),
                };
                // macOS accepted sockets can inherit the listener's nonblocking flag.
                // Fixture server handshakes are blocking with their own bounded timeout.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let stopped = stopped.clone();
                let called = called.clone();
                let history = history.clone();
                let metadata = metadata.clone();
                let init_delay = init_delay.clone();
                let thread_delay = thread_delay.clone();
                connections.push(thread::spawn(move || {
                    let Ok(mut ws) = tungstenite::accept(stream) else {
                        return;
                    };
                    ws.get_mut()
                        .set_read_timeout(Some(Duration::from_millis(100)))
                        .unwrap();
                    loop {
                        if stopped.load(Ordering::SeqCst) {
                            break;
                        }
                        let message = match ws.read() {
                            Ok(m) => m,
                            Err(tungstenite::Error::Io(e))
                                if matches!(
                                    e.kind(),
                                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                                ) =>
                            {
                                continue
                            }
                            Err(_) => break,
                        };
                        let Message::Text(text) = message else {
                            continue;
                        };
                        let request: Value = serde_json::from_str(text.as_str()).unwrap();
                        called.lock().unwrap().push(request.clone());
                        let result = match request["method"].as_str().unwrap() {
                            "initialized" => continue,
                            "initialize" => {
                                let delay = *init_delay.lock().unwrap();
                                thread::sleep(delay);
                                fixture("initialize-response.json")
                            }
                            "thread/read" => {
                                let delay = *thread_delay.lock().unwrap();
                                thread::sleep(delay);
                                let mut value = metadata.lock().unwrap().clone();
                                value["thread"]["id"] = request["params"]["threadId"].clone();
                                value
                            }
                            "thread/queue/list" => fixture("queue-response.json"),
                            "thread/turns/list" => {
                                let history = history.lock().unwrap();
                                if let Some(pages) = history.get("pages") {
                                    pages[request["params"]["cursor"].as_str().unwrap_or("")]
                                        .clone()
                                } else {
                                    history.clone()
                                }
                            }
                            "thread/loaded/list" => fixture("loaded-response.json"),
                            method => panic!("unexpected mutation {method}"),
                        };
                        if ws
                            .send(Message::Text(
                                json!({"id":request["id"],"result":result})
                                    .to_string()
                                    .into(),
                            ))
                            .is_err()
                        {
                            break;
                        }
                    }
                }));
            }
            for connection in connections {
                connection.join().unwrap();
            }
        });
        Self {
            directory,
            executable,
            socket,
            argv,
            stop,
            calls,
            turns,
            read,
            initialize_delay,
            read_delay,
            worker: Some(worker),
        }
    }
    fn qualified(&self) -> QualifiedCodexThread {
        self.read.lock().unwrap()["thread"]["cwd"] = json!(self.directory.path());
        let deadline = Instant::now() + Duration::from_secs(10);
        CodexDaemonReader::open_before(
            CodexOptions::new(self.executable.clone(), self.directory.path().to_owned()).unwrap(),
            self.connect().endpoint,
            deadline,
        )
        .unwrap()
        .qualify_selected_thread(THREAD, self.directory.path(), deadline)
        .unwrap()
    }
    fn method_count(&self, method: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call["method"] == method)
            .count()
    }
    fn adapter(&self) -> CodexAdapter {
        CodexAdapter::new(
            CodexOptions::new(self.executable.clone(), self.directory.path().to_owned()).unwrap(),
            id(9),
        )
        .unwrap()
    }
    fn connect(&self) -> ConnectRequest {
        serde_json::from_value(json!({"binding_id":BINDING,"generation":GENERATION,"external_session_id":THREAD,"endpoint":{"kind":"unix_socket","path":self.socket},"configuration":{"namespace":"codex","values":{}}})).unwrap()
    }
    fn submit(&self, n: usize) -> SubmitRequest {
        let input_id = id(n * 2);
        let attempt_id = id(n * 2 + 1);
        let wire_marker = format!(
            "[ARIADNE_INPUT:{}:{}]",
            input_id.as_str(),
            attempt_id.as_str()
        );
        let formatted_payload = format!(
            "{wire_marker}\n{}",
            json!({"binding_id":BINDING,"generation":GENERATION,"owner_text":" exact  ☃\n`$HOME` $(touch ignored) ' \" ","kind":"ask","context":[]})
        );
        SubmitRequest {
            binding_id: self.connect().binding_id,
            generation: self.connect().generation,
            input_id,
            attempt_id,
            payload_sha256: Sha256::new(format!(
                "{:x}",
                Hasher::digest(formatted_payload.as_bytes())
            ))
            .unwrap(),
            formatted_payload,
            wire_marker,
        }
    }
    fn observe(&self, checkpoint: Option<Checkpoint>, limit: u16) -> ObserveRequest {
        ObserveRequest {
            binding_id: self.connect().binding_id,
            generation: self.connect().generation,
            checkpoint,
            limit: ObserveLimit::new(limit).unwrap(),
        }
    }
    fn delivered(&self, request: &SubmitRequest, status: &str) {
        let mut page = fixture("turns-response.json");
        page["data"].as_array_mut().unwrap().truncate(1);
        let turn = &mut page["data"][0];
        turn["id"] = json!(format!("actual-turn-{}", request.attempt_id.as_str()));
        turn["status"] = json!(status);
        turn["items"][0]["content"][0]["text"] = json!(request.formatted_payload);
        let mut history = self.turns.lock().unwrap();
        page["data"]
            .as_array_mut()
            .unwrap()
            .push(history["data"].as_array().unwrap().last().unwrap().clone());
        *history = page;
    }
    fn count(&self) -> usize {
        fs::read_to_string(self.directory.path().join("count"))
            .unwrap_or_default()
            .lines()
            .count()
    }
    fn wait_sent(&self) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while self.count() == 0 {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(2));
        }
    }
    fn release(&self) {
        fs::write(self.directory.path().join("release"), b"").unwrap();
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.release();
        self.worker.take().unwrap().join().unwrap();
    }
}

#[test]
fn exact_native_argv_acceptance_and_repeated_attempt_are_read_only() {
    let h = Harness::new("flood");
    let adapter = h.adapter();
    let ready = block_on(adapter.connect(h.connect())).unwrap();
    assert!(ready.capabilities.deferred_delivery.supported);
    assert!(!ready.capabilities.domain_mcp.supported);
    let request = h.submit(1);
    assert_eq!(
        block_on(adapter.submit(request.clone())).unwrap(),
        SubmitOutcome::Accepted { receipt: None }
    );
    let actual: Vec<_> = fs::read(&h.argv)
        .unwrap()
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8(s.to_vec()).unwrap())
        .collect();
    assert_eq!(
        actual,
        [
            "queue",
            "--remote",
            &format!("unix://{}", fs::canonicalize(&h.socket).unwrap().display()),
            "--thread",
            THREAD,
            "--message",
            &request.formatted_payload
        ]
    );
    assert_eq!(
        block_on(adapter.submit(request.clone())).unwrap(),
        SubmitOutcome::Accepted { receipt: None }
    );
    assert_eq!(h.count(), 1);
    let mut changed = request;
    changed.formatted_payload.push('x');
    changed.payload_sha256 = Sha256::new(format!(
        "{:x}",
        Hasher::digest(changed.formatted_payload.as_bytes())
    ))
    .unwrap();
    assert_eq!(
        block_on(adapter.submit(changed)).unwrap_err().code,
        AdapterErrorCode::ProtocolConflict
    );
    assert!(h.calls.lock().unwrap().iter().all(|c| [
        "initialize",
        "initialized",
        "thread/read",
        "thread/queue/list",
        "thread/turns/list"
    ]
    .contains(&c["method"].as_str().unwrap())));
}

#[test]
fn nonzero_receipt_is_uncertain_and_history_supplies_actual_lifecycle() {
    let h = Harness::new("nonzero");
    let adapter = h.adapter();
    block_on(adapter.connect(h.connect())).unwrap();
    let request = h.submit(2);
    assert!(matches!(
        block_on(adapter.submit(request.clone())).unwrap(),
        SubmitOutcome::Uncertain { .. }
    ));
    h.delivered(&request, "completed");
    let result = block_on(adapter.observe(h.observe(None, 100))).unwrap();
    assert!(result
        .events
        .iter()
        .any(|e| matches!(e.event, EventPayload::TurnStarted { .. })));
    assert!(result.events.iter().any(|e| matches!(
        e.event,
        EventPayload::TurnFinished {
            status: TurnFinishedStatus::Completed,
            ..
        }
    )));
    assert!(result
        .events
        .iter()
        .filter(|e| e.attempt_id.is_some())
        .all(|e| e.host_turn_id.as_ref().unwrap().starts_with("actual-turn")));
    assert_eq!(h.count(), 1);
}

#[test]
fn checkpoint_replays_candidate_and_acknowledges_only_offered_progress() {
    let h = Harness::new("success");
    let adapter = h.adapter();
    block_on(adapter.connect(h.connect())).unwrap();
    let request = h.submit(3);
    block_on(adapter.submit(request.clone())).unwrap();
    h.delivered(&request, "completed");
    let first = block_on(adapter.observe(h.observe(None, 1))).unwrap();
    assert_eq!(
        first,
        block_on(adapter.observe(h.observe(None, 1))).unwrap()
    );
    assert_eq!(
        block_on(
            adapter.observe(h.observe(Some(Checkpoint::new("invented future offset").unwrap()), 1))
        )
        .unwrap_err()
        .code,
        AdapterErrorCode::InvalidArgument
    );
    let disconnect = DisconnectRequest {
        binding_id: request.binding_id.clone(),
        generation: request.generation.clone(),
    };
    assert_eq!(
        block_on(adapter.disconnect(disconnect)).unwrap_err().code,
        AdapterErrorCode::ProtocolConflict
    );
    let mut checkpoint = first.next_checkpoint;
    let mut completed = false;
    for _ in 0..10 {
        let page = block_on(adapter.observe(h.observe(checkpoint, 1))).unwrap();
        completed |= page
            .events
            .iter()
            .any(|e| matches!(e.event, EventPayload::TurnFinished { .. }));
        checkpoint = page.next_checkpoint;
        if completed
            && page
                .events
                .iter()
                .any(|e| matches!(e.event, EventPayload::Presence { .. }))
        {
            break;
        }
    }
    assert!(completed);
    // Echo the candidate after durable persistence. The next fresh batch has qualified presence.
    let after = block_on(adapter.observe(h.observe(checkpoint, 100))).unwrap();
    assert!(after.events.iter().all(|e| e.attempt_id.is_none()));
}

#[test]
fn active_duplicate_and_dropped_receipt_do_not_resend_or_claim_rejection_when_busy() {
    let h = Harness::new("gate");
    let adapter = h.adapter();
    block_on(adapter.connect(h.connect())).unwrap();
    let request = h.submit(4);
    let active = adapter.submit(request.clone());
    h.wait_sent();
    // Fill the one waiting job slot, while the first sender remains active.
    let waiting = adapter.observe(h.observe(None, 1));
    assert!(matches!(
        block_on(adapter.submit(request.clone())).unwrap(),
        SubmitOutcome::Uncertain { .. }
    ));
    assert!(matches!(
        block_on(adapter.submit(h.submit(5))).unwrap(),
        SubmitOutcome::RejectedBeforeDelivery { .. }
    ));
    assert_eq!(
        block_on(adapter.observe(h.observe(None, 1)))
            .unwrap_err()
            .code,
        AdapterErrorCode::HostUnreachable
    );
    drop(active);
    drop(waiting);
    h.release();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let result = block_on(adapter.submit(request.clone())).unwrap();
        if matches!(result, SubmitOutcome::Accepted { .. }) {
            break;
        }
        assert!(matches!(result, SubmitOutcome::Uncertain { .. }));
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(h.count(), 1);
}

#[test]
fn invalid_exact_payload_scope_and_marker_never_spawn() {
    let h = Harness::new("success");
    let adapter = h.adapter();
    block_on(adapter.connect(h.connect())).unwrap();
    let mut request = h.submit(6);
    request.formatted_payload.push(' ');
    assert_eq!(
        block_on(adapter.submit(request)).unwrap_err().code,
        AdapterErrorCode::InvalidArgument
    );
    let mut request = h.submit(6);
    request.wire_marker.push(' ');
    assert_eq!(
        block_on(adapter.submit(request)).unwrap_err().code,
        AdapterErrorCode::InvalidArgument
    );
    let mut request = h.submit(6);
    request.generation = id(99);
    assert_eq!(
        block_on(adapter.submit(request)).unwrap_err().code,
        AdapterErrorCode::StaleGeneration
    );
    let mut request = h.submit(6);
    request.binding_id = id(99);
    assert_eq!(
        block_on(adapter.submit(request)).unwrap_err().code,
        AdapterErrorCode::BindingMismatch
    );
    assert_eq!(h.count(), 0);
}

#[test]
fn more_than_one_hundred_sequential_acknowledged_attempts_remain_usable() {
    let h = Harness::new("success");
    let adapter = h.adapter();
    block_on(adapter.connect(h.connect())).unwrap();
    let mut checkpoint = None;
    for n in 100..202 {
        let request = h.submit(n);
        assert!(matches!(
            block_on(adapter.submit(request.clone())).unwrap(),
            SubmitOutcome::Accepted { .. }
        ));
        h.delivered(&request, "completed");
        let batch = block_on(adapter.observe(h.observe(checkpoint, 100))).unwrap();
        assert!(batch
            .events
            .iter()
            .any(|e| e.attempt_id.as_ref() == Some(&request.attempt_id)
                && matches!(e.event, EventPayload::TurnFinished { .. })));
        checkpoint = batch.next_checkpoint;
        // Ack this terminal batch. The fresh presence batch is retained until the next iteration.
        checkpoint = block_on(adapter.observe(h.observe(checkpoint, 100)))
            .unwrap()
            .next_checkpoint;
    }
    assert_eq!(h.count(), 102);
}

#[test]
fn foreign_observer_checkpoint_does_not_block_persisted_attempt_reconciliation() {
    let h = Harness::new("success");
    let adapter = h.adapter();
    block_on(adapter.connect(h.connect())).unwrap();
    let request = h.submit(7);
    block_on(adapter.submit(request.clone())).unwrap();
    h.delivered(&request, "completed");
    let checkpoint = Some(Checkpoint::new("old-instance-checkpoint").unwrap());
    assert_eq!(
        block_on(adapter.observe(h.observe(checkpoint.clone(), 100)))
            .unwrap_err()
            .code,
        AdapterErrorCode::InvalidArgument
    );
    let evidence = ReconcileRequest {
        binding_id: request.binding_id,
        generation: request.generation.clone(),
        attempts: vec![AttemptEvidenceRequest {
            input_id: request.input_id,
            attempt_id: request.attempt_id,
            binding_generation: request.generation,
            payload_sha256: request.payload_sha256,
            wire_marker: request.wire_marker,
            host_turn_id: None,
        }],
        checkpoint: checkpoint.clone(),
    };
    let result = block_on(adapter.reconcile(evidence)).unwrap();
    assert_eq!(result.next_checkpoint, checkpoint);
    assert!(result.unresolved_attempt_ids.is_empty());
    assert!(result.attempt_evidence[0]
        .events
        .iter()
        .any(|e| matches!(e.event, EventPayload::TurnFinished { .. })));
}

#[test]
fn retained_capacity_is_simultaneous_and_never_discards_attempt_certainty() {
    let h = Harness::new("success");
    let adapter = h.adapter();
    block_on(adapter.connect(h.connect())).unwrap();
    for n in 300..400 {
        assert!(matches!(
            block_on(adapter.submit(h.submit(n))).unwrap(),
            SubmitOutcome::Accepted { .. }
        ));
    }
    assert!(matches!(
        block_on(adapter.submit(h.submit(400))).unwrap(),
        SubmitOutcome::RejectedBeforeDelivery { .. }
    ));
    assert!(matches!(
        block_on(adapter.submit(h.submit(300))).unwrap(),
        SubmitOutcome::Accepted { .. }
    ));
    assert_eq!(h.count(), 100);
    let request = h.submit(300);
    h.delivered(&request, "completed");
    let batch = block_on(adapter.observe(h.observe(None, 100))).unwrap();
    assert!(batch
        .events
        .iter()
        .any(|e| matches!(e.event, EventPayload::TurnFinished { .. })));
    block_on(adapter.observe(h.observe(batch.next_checkpoint, 100))).unwrap();
    assert!(matches!(
        block_on(adapter.submit(h.submit(400))).unwrap(),
        SubmitOutcome::Accepted { .. }
    ));
    assert_eq!(h.count(), 101);
}

#[test]
fn idle_disconnect_probe_and_same_identity_reconnect_are_usable() {
    let h = Harness::new("success");
    let adapter = h.adapter();
    let probe = block_on(adapter.probe(ProbeRequest {
        endpoint: h.connect().endpoint,
        configuration: h.connect().configuration,
    }))
    .unwrap();
    assert_eq!(probe.compatibility, Compatibility::Compatible);
    block_on(adapter.connect(h.connect())).unwrap();
    let idle = block_on(adapter.observe(h.observe(None, 100))).unwrap();
    assert!(idle.next_checkpoint.is_none());
    block_on(adapter.disconnect(DisconnectRequest {
        binding_id: h.connect().binding_id,
        generation: h.connect().generation,
    }))
    .unwrap();
    block_on(adapter.connect(h.connect())).unwrap();
    let request = h.submit(500);
    block_on(adapter.submit(request.clone())).unwrap();
    block_on(adapter.connect(h.connect())).unwrap();
    assert!(matches!(
        block_on(adapter.submit(request)).unwrap(),
        SubmitOutcome::Accepted { .. }
    ));
    assert_eq!(h.count(), 1);
}

#[test]
fn generation_change_cannot_discard_pending_batch_and_historical_recovery_remains_qualified() {
    let h = Harness::new("success");
    let adapter = h.adapter();
    block_on(adapter.connect(h.connect())).unwrap();
    let request = h.submit(501);
    block_on(adapter.submit(request.clone())).unwrap();
    h.delivered(&request, "completed");
    let first = block_on(adapter.observe(h.observe(None, 100))).unwrap();
    let mut next = h.connect();
    next.generation = id(502);
    assert_eq!(
        block_on(adapter.connect(next.clone())).unwrap_err().code,
        AdapterErrorCode::ProtocolConflict
    );
    assert_eq!(
        first,
        block_on(adapter.observe(h.observe(None, 100))).unwrap()
    );
    let idle = block_on(adapter.observe(h.observe(first.next_checkpoint, 100))).unwrap();
    assert!(idle.events.iter().all(|e| e.attempt_id.is_none()));
    block_on(adapter.connect(next.clone())).unwrap();
    let evidence = ReconcileRequest {
        binding_id: next.binding_id,
        generation: next.generation,
        attempts: vec![AttemptEvidenceRequest {
            input_id: request.input_id,
            attempt_id: request.attempt_id,
            binding_generation: request.generation.clone(),
            payload_sha256: request.payload_sha256,
            wire_marker: request.wire_marker,
            host_turn_id: None,
        }],
        checkpoint: idle.next_checkpoint,
    };
    let recovered = block_on(adapter.reconcile(evidence)).unwrap();
    assert!(recovered.unresolved_attempt_ids.is_empty());
    assert!(recovered.attempt_evidence[0]
        .events
        .iter()
        .all(|e| e.generation == request.generation));
    assert_eq!(h.count(), 1);
}

#[test]
fn same_generation_cannot_reuse_context_for_a_different_thread() {
    let h = Harness::new("success");
    let adapter = h.adapter();
    block_on(adapter.connect(h.connect())).unwrap();
    let request = h.submit(503);
    block_on(adapter.submit(request.clone())).unwrap();
    let mut changed = h.connect();
    changed.external_session_id = "different exact thread".to_owned();
    assert_eq!(
        block_on(adapter.connect(changed)).unwrap_err().code,
        AdapterErrorCode::BindingMismatch
    );
    assert!(matches!(
        block_on(adapter.submit(request)).unwrap(),
        SubmitOutcome::Accepted { .. }
    ));
    assert_eq!(h.count(), 1);
}

#[test]
fn abandoned_pending_submit_never_spawns_and_retains_proven_unsent_outcome() {
    let h = Harness::new("gate");
    let adapter = h.adapter();
    block_on(adapter.connect(h.connect())).unwrap();
    let active = adapter.submit(h.submit(504));
    h.wait_sent();
    let request = h.submit(505);
    let pending = adapter.submit(request.clone());
    drop(pending);
    h.release();
    block_on(active).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let result = block_on(adapter.submit(request.clone())).unwrap();
        if matches!(result, SubmitOutcome::RejectedBeforeDelivery { .. }) {
            break;
        }
        assert!(matches!(result, SubmitOutcome::Uncertain { .. }));
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(h.count(), 1);
}

#[test]
fn zero_match_is_unresolved_and_multiple_exact_turns_are_a_conflict() {
    let h = Harness::new("success");
    let adapter = h.adapter();
    block_on(adapter.connect(h.connect())).unwrap();
    let request = h.submit(506);
    block_on(adapter.submit(request.clone())).unwrap();
    let evidence = ReconcileRequest {
        binding_id: request.binding_id.clone(),
        generation: request.generation.clone(),
        attempts: vec![AttemptEvidenceRequest {
            input_id: request.input_id.clone(),
            attempt_id: request.attempt_id.clone(),
            binding_generation: request.generation.clone(),
            payload_sha256: request.payload_sha256.clone(),
            wire_marker: request.wire_marker.clone(),
            host_turn_id: None,
        }],
        checkpoint: None,
    };
    let empty = block_on(adapter.reconcile(evidence.clone())).unwrap();
    assert!(empty.attempt_evidence.is_empty());
    assert_eq!(
        empty.unresolved_attempt_ids,
        vec![request.attempt_id.clone()]
    );
    assert_eq!(h.count(), 1);
    h.delivered(&request, "completed");
    {
        let mut history = h.turns.lock().unwrap();
        let mut duplicate = history["data"][0].clone();
        duplicate["id"] = json!("different-matching-turn");
        history["data"].as_array_mut().unwrap().insert(1, duplicate);
    }
    assert_eq!(
        block_on(adapter.reconcile(evidence)).unwrap_err().code,
        AdapterErrorCode::ProtocolConflict
    );
    assert_eq!(h.count(), 1);
}

#[test]
fn fresh_pre_submit_anchor_excludes_identical_older_content() {
    let h = Harness::new("success");
    let adapter = h.adapter();
    block_on(adapter.connect(h.connect())).unwrap();
    let request = h.submit(507);
    h.delivered(&request, "completed");
    block_on(adapter.submit(request.clone())).unwrap();
    let no_match = block_on(adapter.observe(h.observe(None, 100))).unwrap();
    assert!(no_match.events.iter().all(|e| e.attempt_id.is_none()));
    assert!(no_match.next_checkpoint.is_none());
    h.delivered(&request, "completed");
    h.turns.lock().unwrap()["data"][0]["id"] = json!("new-after-anchor-turn");
    let matched = block_on(adapter.observe(h.observe(None, 100))).unwrap();
    assert!(matched
        .events
        .iter()
        .filter(|e| e.attempt_id.is_some())
        .all(|e| e.host_turn_id.as_deref() == Some("new-after-anchor-turn")));
}

#[test]
fn bounded_observe_resumes_after_one_thousand_turns_without_checkpoint_advance() {
    let h = Harness::new("success");
    let adapter = h.adapter();
    block_on(adapter.connect(h.connect())).unwrap();
    let request = h.submit(508);
    block_on(adapter.submit(request.clone())).unwrap();
    h.delivered(&request, "completed");
    let tail = h.turns.lock().unwrap().clone();
    let mut pages = serde_json::Map::new();
    for page in 0..50 {
        let mut data = Vec::new();
        for n in 0..20 {
            let mut turn = fixture("turns-response.json")["data"][0].clone();
            turn["id"] = json!(format!("unrelated-{page}-{n}"));
            turn["items"] = json!([]);
            data.push(turn);
        }
        pages.insert(
            if page == 0 {
                "".to_owned()
            } else {
                format!("page-{page}")
            },
            json!({"data":data,"nextCursor":format!("page-{}",page+1),"backwardsCursor":null}),
        );
    }
    pages.insert("page-50".to_owned(), tail);
    *h.turns.lock().unwrap() = json!({"pages":pages});
    let first = block_on(adapter.observe(h.observe(None, 100))).unwrap();
    assert!(first.next_checkpoint.is_none());
    assert!(first.events.iter().all(|e| e.attempt_id.is_none()));
    let second = block_on(adapter.observe(h.observe(None, 100))).unwrap();
    assert!(second
        .events
        .iter()
        .any(|e| matches!(e.event, EventPayload::TurnFinished { .. })));
    assert_eq!(h.count(), 1);
    assert!(h
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|c| c["params"]["cursor"] == "page-50"));
}

#[test]
fn incompatible_cli_and_required_history_shape_stop_before_sender_spawn() {
    let h = Harness::new("success");
    let adapter = h.adapter();
    block_on(adapter.connect(h.connect())).unwrap();
    h.turns.lock().unwrap()["data"][0]["itemsView"] = json!("summary");
    assert_eq!(
        block_on(adapter.submit(h.submit(509))).unwrap_err().code,
        AdapterErrorCode::UnsupportedHostVersion
    );
    assert_eq!(h.count(), 0);
    assert_eq!(
        block_on(adapter.observe(h.observe(None, 100)))
            .unwrap_err()
            .code,
        AdapterErrorCode::HostUnreachable
    );
    let h = Harness::new("success");
    fs::write(&h.executable, "#!/bin/sh\nprintf 'codex-cli 0.159.0\\n'\n").unwrap();
    let adapter = h.adapter();
    assert_eq!(
        block_on(adapter.connect(h.connect())).unwrap_err().code,
        AdapterErrorCode::UnsupportedHostVersion
    );
    assert_eq!(h.count(), 0);
}

#[test]
fn fresh_adapter_rejects_real_old_token_then_reconciles_persisted_attempts() {
    let h = Harness::new("success");
    let adapter = h.adapter();
    block_on(adapter.connect(h.connect())).unwrap();
    let request = h.submit(510);
    block_on(adapter.submit(request.clone())).unwrap();
    h.delivered(&request, "completed");
    let old_token = block_on(adapter.observe(h.observe(None, 100)))
        .unwrap()
        .next_checkpoint;
    drop(adapter);
    let adapter = h.adapter();
    block_on(adapter.connect(h.connect())).unwrap();
    assert_eq!(
        block_on(adapter.observe(h.observe(old_token.clone(), 100)))
            .unwrap_err()
            .code,
        AdapterErrorCode::InvalidArgument
    );
    let evidence = ReconcileRequest {
        binding_id: request.binding_id,
        generation: request.generation.clone(),
        attempts: vec![AttemptEvidenceRequest {
            input_id: request.input_id,
            attempt_id: request.attempt_id,
            binding_generation: request.generation,
            payload_sha256: request.payload_sha256,
            wire_marker: request.wire_marker,
            host_turn_id: None,
        }],
        checkpoint: old_token,
    };
    assert!(block_on(adapter.reconcile(evidence))
        .unwrap()
        .unresolved_attempt_ids
        .is_empty());
    assert!(block_on(adapter.observe(h.observe(None, 100)))
        .unwrap()
        .events
        .iter()
        .all(|e| e.attempt_id.is_none()));
    assert_eq!(h.count(), 1);
}

#[test]
fn retained_verified_facts_replay_after_endpoint_loss_and_acknowledgement_allows_reconnect() {
    let h = Harness::new("success");
    let adapter = h.adapter();
    block_on(adapter.connect(h.connect())).unwrap();
    let request = h.submit(511);
    block_on(adapter.submit(request.clone())).unwrap();
    h.delivered(&request, "completed");
    let batch = block_on(adapter.observe(h.observe(None, 100))).unwrap();
    fs::remove_file(&h.socket).unwrap();
    assert_eq!(
        batch,
        block_on(adapter.observe(h.observe(None, 100))).unwrap()
    );
    let mut wrong = h.observe(None, 100);
    wrong.generation = id(512);
    assert_eq!(
        block_on(adapter.observe(wrong)).unwrap_err().code,
        AdapterErrorCode::StaleGeneration
    );
    // The caller has committed this page. Ack succeeds internally; the subsequent fresh read
    // fails honestly without discarding facts or preventing a verified new connection.
    assert_eq!(
        block_on(adapter.observe(h.observe(batch.next_checkpoint, 100)))
            .unwrap_err()
            .code,
        AdapterErrorCode::HostUnreachable
    );
    let replacement = Harness::new("success");
    let mut connect = replacement.connect();
    connect.generation = id(512);
    block_on(adapter.connect(connect.clone())).unwrap();
    let fresh = ObserveRequest {
        binding_id: connect.binding_id,
        generation: connect.generation,
        checkpoint: None,
        limit: ObserveLimit::new(100).unwrap(),
    };
    assert!(block_on(adapter.observe(fresh))
        .unwrap()
        .events
        .iter()
        .all(|e| e.attempt_id.is_none()));
    assert_eq!(h.count(), 1);
}

#[test]
fn retry_with_narrower_limit_preserves_previously_offered_checkpoint() {
    let h = Harness::new("success");
    let adapter = h.adapter();
    block_on(adapter.connect(h.connect())).unwrap();
    let request = h.submit(513);
    block_on(adapter.submit(request.clone())).unwrap();
    h.delivered(&request, "completed");
    let complete = block_on(adapter.observe(h.observe(None, 100))).unwrap();
    let narrow = block_on(adapter.observe(h.observe(None, 1))).unwrap();
    assert_eq!(narrow.events, complete.events[..1]);
    assert!(
        block_on(adapter.observe(h.observe(complete.next_checkpoint, 100)))
            .unwrap()
            .events
            .iter()
            .all(|e| e.attempt_id.is_none())
    );
    assert_eq!(
        block_on(adapter.observe(h.observe(narrow.next_checkpoint, 100)))
            .unwrap_err()
            .code,
        AdapterErrorCode::InvalidArgument
    );
}

#[test]
fn verified_original_message_recovers_acceptance_and_preserves_only_valid_provider_receipt() {
    for client in [
        Some("provider-selected-client".to_owned()),
        None,
        Some(String::new()),
        Some("☃".repeat(1366)),
    ] {
        let h = Harness::new("nonzero");
        let adapter = h.adapter();
        block_on(adapter.connect(h.connect())).unwrap();
        let request = h.submit(514);
        assert!(matches!(
            block_on(adapter.submit(request.clone())).unwrap(),
            SubmitOutcome::Uncertain { .. }
        ));
        h.delivered(&request, "completed");
        let user_message_id = {
            let mut history = h.turns.lock().unwrap();
            let user = &mut history["data"][0]["items"][0];
            if let Some(client) = &client {
                user["clientId"] = json!(client);
            } else {
                user.as_object_mut().unwrap().remove("clientId");
            }
            user["id"].as_str().unwrap().to_owned()
        };
        let expected = client
            .filter(|id| !id.is_empty() && id.len() <= 4096)
            .unwrap_or(user_message_id);
        let observed = block_on(adapter.observe(h.observe(None, 100))).unwrap();
        let accepted = &observed.events[0];
        assert!(matches!(
            observed.events[1].event,
            EventPayload::TurnStarted { .. }
        ));
        let EventPayload::Accepted {
            receipt: Some(receipt),
        } = &accepted.event
        else {
            panic!("verified original content lost its acceptance evidence")
        };
        assert_eq!(receipt.provider_reference, expected);
        assert_eq!(receipt.observed_at, accepted.observed_at);
        assert_eq!(
            observed,
            block_on(adapter.observe(h.observe(None, 100))).unwrap()
        );
        let evidence = ReconcileRequest {
            binding_id: request.binding_id,
            generation: request.generation.clone(),
            attempts: vec![AttemptEvidenceRequest {
                input_id: request.input_id,
                attempt_id: request.attempt_id,
                binding_generation: request.generation,
                payload_sha256: request.payload_sha256,
                wire_marker: request.wire_marker,
                host_turn_id: None,
            }],
            checkpoint: None,
        };
        let recovered = block_on(adapter.reconcile(evidence.clone())).unwrap();
        let rescanned = block_on(adapter.reconcile(evidence)).unwrap();
        let mut rescanned = rescanned.attempt_evidence[0].events[0].clone();
        let recovered = &recovered.attempt_evidence[0].events[0];
        assert_eq!(accepted.event_id, recovered.event_id);
        let EventPayload::Accepted {
            receipt: Some(receipt),
        } = &recovered.event
        else {
            panic!("reconciliation lost its acceptance evidence")
        };
        assert_eq!(receipt.provider_reference, expected);
        assert_eq!(receipt.observed_at, recovered.observed_at);
        let EventPayload::Accepted {
            receipt: Some(rescanned_receipt),
        } = &mut rescanned.event
        else {
            panic!("fresh repeated reconciliation lost acceptance evidence")
        };
        assert_eq!(rescanned_receipt.observed_at, rescanned.observed_at);
        rescanned_receipt.observed_at = receipt.observed_at.clone();
        rescanned.observed_at = recovered.observed_at.clone();
        assert_eq!(*recovered, rescanned);
        assert_eq!(h.count(), 1);
    }
}

#[test]
fn qualified_adapter_reuses_initialization_and_final_checks_before_native_queue() {
    let h = Harness::new("success");
    let qualified = h.qualified();
    let fingerprint = qualified.facts().endpoint_fingerprint.clone();
    let capabilities = qualified.facts().capabilities.clone();
    let adapter = CodexAdapter::from_qualified_thread(qualified, id(9)).unwrap();
    assert!(block_on(adapter.submit(h.submit(700))).is_err());
    assert_eq!(h.count(), 0);
    let ready = block_on(adapter.connect(h.connect())).unwrap();
    ready.validate_for(&h.connect()).unwrap();
    assert_eq!(ready.endpoint_fingerprint, fingerprint);
    assert_eq!(ready.capabilities, capabilities);
    assert_eq!(h.method_count("initialize"), 1);
    assert_eq!(h.method_count("thread/read"), 2);
    assert_eq!(h.method_count("thread/queue/list"), 2);
    assert_eq!(h.method_count("thread/turns/list"), 2);
    assert_eq!(h.count(), 0);
    assert!(matches!(
        block_on(adapter.submit(h.submit(700))).unwrap(),
        SubmitOutcome::Accepted { .. }
    ));
    assert_eq!(h.count(), 1);
}

#[test]
fn native_final_connect_keeps_callers_shorter_original_deadline() {
    let h = Harness::new("success");
    let adapter = CodexAdapter::from_qualified_thread(h.qualified(), id(9)).unwrap();
    *h.read_delay.lock().unwrap() = Duration::from_millis(1500);
    let started = Instant::now();
    let error = block_on(adapter.connect_before(h.connect(), started + Duration::from_millis(600)))
        .unwrap_err();
    assert_eq!(error.code, AdapterErrorCode::HostUnreachable);
    assert!(
        started.elapsed() < Duration::from_millis(1200),
        "native connect renewed its worker IO deadline"
    );
    assert_eq!(
        h.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call["method"] == "initialize")
            .count(),
        1
    );
    assert!(
        !h.argv.exists(),
        "final connect must not submit or launch a host"
    );
}

#[test]
fn qualified_adapter_rejects_retargeting_without_consuming_selected_reader() {
    let h = Harness::new("success");
    let adapter = CodexAdapter::from_qualified_thread(h.qualified(), id(9)).unwrap();
    for endpoint in [false, true] {
        let mut request = h.connect();
        if endpoint {
            request.endpoint = EndpointRef::UnixSocket {
                path: "/tmp/another-daemon.sock".into(),
            };
        } else {
            request.external_session_id = "another-thread".into();
        }
        assert_eq!(
            block_on(adapter.connect(request)).unwrap_err().code,
            AdapterErrorCode::BindingMismatch
        );
    }
    assert_eq!(h.method_count("thread/read"), 1);
    block_on(adapter.connect(h.connect())).unwrap();
    assert_eq!(h.method_count("initialize"), 1);
    assert_eq!(h.method_count("thread/read"), 2);
}

#[test]
fn qualified_adapter_rechecks_final_root_and_full_items() {
    for root in [false, true] {
        let h = Harness::new("success");
        let adapter = CodexAdapter::from_qualified_thread(h.qualified(), id(9)).unwrap();
        let other = tempfile::tempdir().unwrap();
        if root {
            h.read.lock().unwrap()["thread"]["cwd"] = json!(other.path());
        } else {
            h.turns.lock().unwrap()["data"][0]["itemsView"] = json!("summary");
        }
        let error = block_on(adapter.connect(h.connect())).unwrap_err();
        assert_eq!(
            error.code,
            if root {
                AdapterErrorCode::BindingMismatch
            } else {
                AdapterErrorCode::UnsupportedHostVersion
            }
        );
        assert_eq!(h.method_count("initialize"), 1);
        assert!(block_on(adapter.submit(h.submit(701))).is_err());
        assert_eq!(h.count(), 0);
    }
}

#[test]
fn qualified_adapter_reconnect_keeps_root_socket_and_executable_identity() {
    let h = Harness::new("success");
    let adapter = CodexAdapter::from_qualified_thread(h.qualified(), id(9)).unwrap();
    let ready = block_on(adapter.connect(h.connect())).unwrap();
    let disconnect = || DisconnectRequest {
        binding_id: h.connect().binding_id,
        generation: h.connect().generation,
    };
    block_on(adapter.disconnect(disconnect())).unwrap();
    let again = block_on(adapter.connect(h.connect())).unwrap();
    assert_eq!(ready.endpoint_fingerprint, again.endpoint_fingerprint);
    assert_eq!(h.method_count("initialize"), 2);
    assert_eq!(h.method_count("thread/read"), 3);
    block_on(adapter.disconnect(disconnect())).unwrap();
    let other = tempfile::tempdir().unwrap();
    h.read.lock().unwrap()["thread"]["cwd"] = json!(other.path());
    assert_eq!(
        block_on(adapter.connect(h.connect())).unwrap_err().code,
        AdapterErrorCode::BindingMismatch
    );
    h.read.lock().unwrap()["thread"]["cwd"] = json!(h.directory.path());
    block_on(adapter.connect(h.connect())).unwrap();
    block_on(adapter.disconnect(disconnect())).unwrap();
    let replacement = h.directory.path().join("replacement-executable");
    fs::copy(&h.executable, &replacement).unwrap();
    fs::rename(&replacement, &h.executable).unwrap();
    let reads = h.method_count("thread/read");
    assert_eq!(
        block_on(adapter.connect(h.connect())).unwrap_err().code,
        AdapterErrorCode::BindingMismatch
    );
    assert_eq!(h.method_count("thread/read"), reads);
    assert_eq!(h.count(), 0);
}

#[test]
fn qualified_adapter_reconnect_rejects_replaced_same_version_socket() {
    let h = Harness::new("success");
    let adapter = CodexAdapter::from_qualified_thread(h.qualified(), id(9)).unwrap();
    block_on(adapter.connect(h.connect())).unwrap();
    block_on(adapter.disconnect(DisconnectRequest {
        binding_id: h.connect().binding_id,
        generation: h.connect().generation,
    }))
    .unwrap();
    let replacement = Harness::new("success");
    replacement.read.lock().unwrap()["thread"]["cwd"] = json!(h.directory.path());
    fs::rename(&h.socket, h.directory.path().join("original.sock")).unwrap();
    fs::rename(&replacement.socket, &h.socket).unwrap();
    assert_eq!(
        block_on(adapter.connect(h.connect())).unwrap_err().code,
        AdapterErrorCode::BindingMismatch
    );
    assert!(block_on(adapter.submit(h.submit(702))).is_err());
    assert_eq!(h.count(), 0);
    assert_eq!(replacement.count(), 0);
}

#[test]
fn qualified_adapter_final_bind_keeps_original_queued_connect_deadline() {
    let h = Harness::new("success");
    let adapter = CodexAdapter::from_qualified_thread(h.qualified(), id(9)).unwrap();
    // A preceding read-only probe occupies this same bounded IO worker. The final
    // thread read would fit a reset ten-second budget, but not the original one.
    *h.initialize_delay.lock().unwrap() = Duration::from_secs(3);
    *h.read_delay.lock().unwrap() = Duration::from_secs(8);
    let probe = adapter.probe(ProbeRequest {
        endpoint: h.connect().endpoint,
        configuration: h.connect().configuration,
    });
    let observed_by = Instant::now() + Duration::from_secs(2);
    while h.method_count("initialize") < 2 {
        assert!(Instant::now() < observed_by);
        thread::sleep(Duration::from_millis(2));
    }
    let started = Instant::now();
    assert_eq!(
        block_on(adapter.connect(h.connect())).unwrap_err().code,
        AdapterErrorCode::HostUnreachable
    );
    assert!(started.elapsed() < Duration::from_millis(10_800));
    assert_eq!(
        block_on(probe).unwrap().compatibility,
        Compatibility::Compatible
    );
    assert_eq!(h.method_count("initialize"), 2);
    assert_eq!(h.method_count("thread/queue/list"), 1);
    assert_eq!(h.count(), 0);
}
