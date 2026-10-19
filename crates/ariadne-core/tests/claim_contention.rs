//! Pollers, writers and readers on one session at once: reads never fail on a
//! busy store, and every queued input is claimed exactly once.
use ariadne_agent_protocol::{EventPayload, NormalizedEvent, TurnFinishedStatus};
use ariadne_core::{
    apply::ApplyService,
    delivery::{DeliveryError, DeliveryService},
    inputs::InputService,
    native::{retry_busy_read, AgentResolver, NativeCoreService},
    *,
};
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const POLLERS: usize = 4;
const READERS: usize = 3;
const INPUTS: u64 = 10;

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn at() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
}
fn route() -> RegisteredSession {
    RegisteredSession::from_trusted_entrypoint(id(1), id(2))
}

struct Shared {
    home: tempfile::TempDir,
    _root: tempfile::TempDir,
    next: AtomicU64,
    generation: UuidV4,
}
impl Shared {
    fn uuid(&self) -> UuidV4 {
        id(self.next.fetch_add(1, Ordering::SeqCst))
    }
    fn registry(&self) -> Registry {
        Registry::open(self.home.path()).unwrap()
    }
    fn store(&self) -> Store {
        Store::open_registered(
            &self
                .home
                .path()
                .join(".ariadne/projects")
                .join(id(1).as_str()),
            id(1),
        )
        .unwrap()
    }
    fn saved(&self) -> Session {
        retry(|| self.store().read(&id(2)).map_err(CoreError::from))
    }
}

/// Writers resend the same operation on a busy store; that is always safe.
fn retry<T>(write: impl FnMut() -> Result<T, CoreError>) -> T {
    retry_noting(&AtomicUsize::new(0), write)
}
/// `retry`, counting each store_busy answer in `busy`.
fn retry_noting<T>(busy: &AtomicUsize, mut write: impl FnMut() -> Result<T, CoreError>) -> T {
    loop {
        match write() {
            Err(error) if error.code == CoreErrorCode::StoreBusy => {
                busy.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(5))
            }
            other => return other.unwrap(),
        }
    }
}
fn core_error(error: DeliveryError) -> CoreError {
    match error {
        DeliveryError::Core(error) => error,
        DeliveryError::Store(error) => error.into(),
        DeliveryError::Registry(error) => error.into(),
    }
}

fn setup() -> Arc<Shared> {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    registry.register(root.path(), &id(99), || id(1)).unwrap();
    let seed: Session =
        serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json")).unwrap();
    let generation = seed.bindings.0[&id(3)].generation.clone();
    let shared = Arc::new(Shared {
        home,
        _root: root,
        next: AtomicU64::new(100_000),
        generation,
    });
    shared.store().create(&seed).unwrap();
    shared
}

/// The owner queues input `n`, resending the same op on store_busy (counted in `busy`).
fn queue(shared: &Shared, n: u64, busy: &AtomicUsize) {
    let command = OwnerCommand::InputSubmit {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(n),
        params: InputSubmitParams {
            binding_id: id(3),
            target: InputTarget {
                topic_id: id(5),
                item_id: Some(ItemRef::new("1").unwrap()),
            },
            kind: InputKind::Reply,
            text: format!("Owner text {n}"),
            selected_option_id: None,
            expected_question_revision: None,
            supersedes_answer_id: None,
        },
    };
    let registry = shared.registry();
    retry_noting(busy, || {
        InputService::new(&registry)
            .execute(
                &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(route())),
                &command,
                || shared.uuid(),
                at(),
            )
            .map_err(|error| match error {
                ariadne_core::inputs::InputError::Core(error) => error,
                ariadne_core::inputs::InputError::Store(error) => error.into(),
                ariadne_core::inputs::InputError::Registry(error) => error.into(),
            })
    });
}

/// Finish a claimed attempt (its result, then the completed turn) so the
/// binding can take the next input.
fn complete(shared: &Shared, prepared: &PreparedAttempt) {
    let registry = shared.registry();
    loop {
        let session = shared.saved();
        let owner = session
            .messages
            .iter()
            .find(|m| m.id == session.inputs.0[&prepared.input_id].message_id)
            .unwrap();
        let context = AgentContext::from_trusted_entrypoint(
            route(),
            id(3),
            prepared.binding_generation.clone(),
            AgentReadScope::Dispatched {
                source_input_id: prepared.input_id.clone(),
                attempt_id: prepared.attempt_id.clone(),
                issued_through_message_number: NonnegativeSafeInteger::new(owner.number.value())
                    .unwrap(),
            },
        );
        let item = ItemRef::new("1").unwrap();
        let request = ApplyRequest {
            op_id: shared.uuid(),
            source_input_id: Some(prepared.input_id.clone()),
            attempt_id: Some(prepared.attempt_id.clone()),
            expected_item_revisions: UniqueMap(std::collections::BTreeMap::from([(
                item.clone(),
                session.items.0[&item].revision,
            )])),
            expected_topic_revisions: UniqueMap(Default::default()),
            summary: String::new(),
            operations: vec![Operation::Reply {
                r#ref: RequestRef::new("result_reply").unwrap(),
                item: EntityRef::Existing(ExistingRef { id: item.clone() }),
                text: "Handled.".into(),
                round_id: None,
            }],
            input_result: Some(ResultDraft {
                outcome: ResultOutcome::Deferred,
                explanation: "Handled under contention.".into(),
                reply_refs: vec![UuidRef::Local(LocalRef {
                    r#ref: RequestRef::new("result_reply").unwrap(),
                })],
                followup_item_refs: vec![],
                handled_through_message_number: owner.number,
            }),
        };
        let saved = loop {
            match ApplyService::new(&registry).execute(&context, &request, || shared.uuid(), at()) {
                Err(ariadne_core::apply::ApplyError::Store(
                    ariadne_store::session::StoreError::Busy,
                )) => std::thread::sleep(Duration::from_millis(5)),
                other => break other,
            }
        };
        match saved {
            Ok(_) => break,
            // A concurrent owner message moved the item: read again and redo.
            Err(ariadne_core::apply::ApplyError::Core(error))
                if error.code == CoreErrorCode::RevisionConflict => {}
            Err(error) => panic!("result failed: {error:?}"),
        }
    }
    let event = NormalizedEvent {
        event_id: format!("completed-{}", prepared.attempt_id.as_str()),
        binding_id: id(3),
        generation: prepared.binding_generation.clone(),
        input_id: Some(prepared.input_id.clone()),
        attempt_id: Some(prepared.attempt_id.clone()),
        host_turn_id: Some("turn".into()),
        observed_at: at(),
        event: EventPayload::TurnFinished {
            status: TurnFinishedStatus::Completed,
            reason: None,
            diagnostic_text: None,
            truncated: false,
        },
    };
    let context =
        AdapterContext::from_trusted_entrypoint(route(), id(3), shared.generation.clone(), None);
    retry(|| {
        DeliveryService::new(&registry)
            .report(&context, &event, || shared.uuid())
            .map_err(core_error)
    });
}

/// What the pollers and the owner saw during one run.
#[derive(Default)]
struct Tally {
    /// Each claimed input with the claim request id that claimed it.
    claimed: Mutex<Vec<(UuidV4, UuidV4)>>,
    /// Claim request ids that got store_busy and were resent unchanged.
    resent: Mutex<Vec<UuidV4>>,
    polls: AtomicUsize,
    /// store_busy answers to the owner's queue writes.
    busy_owner_writes: AtomicUsize,
}

fn spawn_pollers(
    shared: &Arc<Shared>,
    done: &Arc<AtomicBool>,
    tally: &Arc<Tally>,
) -> Vec<std::thread::JoinHandle<()>> {
    (0..POLLERS)
        .map(|_| {
            let (shared, done, tally) = (shared.clone(), done.clone(), tally.clone());
            std::thread::spawn(move || {
                let registry = shared.registry();
                let lease = ValidatedDispatchContext::from_trusted_current_lease(
                    route(),
                    id(3),
                    shared.generation.clone(),
                );
                while !done.load(Ordering::SeqCst) {
                    let request = ClaimRequest {
                        binding_id: id(3),
                        generation: shared.generation.clone(),
                        request_id: shared.uuid(),
                    };
                    tally.polls.fetch_add(1, Ordering::SeqCst);
                    // A busy claim is resent with its same request id.
                    let busy = AtomicUsize::new(0);
                    let prepared = retry_noting(&busy, || {
                        DeliveryService::new(&registry)
                            .claim(&lease, &request, || shared.uuid(), at())
                            .map_err(core_error)
                    });
                    if busy.load(Ordering::SeqCst) > 0 {
                        tally
                            .resent
                            .lock()
                            .unwrap()
                            .push(request.request_id.clone());
                    }
                    if let Some(prepared) = prepared {
                        tally
                            .claimed
                            .lock()
                            .unwrap()
                            .push((prepared.input_id.clone(), request.request_id.clone()));
                        complete(&shared, &prepared);
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
            })
        })
        .collect()
}

/// A long write (a large session) holds the session lock for 2.3 s, past the
/// store's 2 s lock deadline. `held` is true while the lock is taken.
fn hold(shared: &Shared, n: u64, held: &AtomicBool) {
    let _ = shared.store().transact(
        &id(2),
        &ReceiptActorScope::Owner {},
        &id(90_000 + n),
        &serde_json::json!({"hold": n}),
        |_| {
            held.store(true, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(2_300));
            Err::<SavedReceiptData, _>(())
        },
    );
    held.store(false, Ordering::SeqCst);
}

/// Wait until all `INPUTS` are handled (or 120 s pass), then stop `threads`.
fn finish(shared: &Shared, done: &AtomicBool, threads: Vec<std::thread::JoinHandle<()>>) -> bool {
    let started = Instant::now();
    let finished = loop {
        let session = shared.saved();
        let open = session
            .inputs
            .0
            .values()
            .filter(|input| input.state != InputState::Handled)
            .count();
        if open == 0 && session.inputs.0.len() as u64 == INPUTS {
            break true;
        }
        if started.elapsed() > Duration::from_secs(120) {
            break false;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    done.store(true, Ordering::SeqCst);
    for thread in threads {
        thread.join().unwrap();
    }
    finished
}

/// Every queued input was claimed exactly once, by the request that saved its attempt.
fn assert_claimed_once(shared: &Shared, tally: &Tally) {
    let session = shared.saved();
    let claimed = tally.claimed.lock().unwrap().clone();
    let unique: BTreeSet<_> = claimed.iter().map(|(input, _)| input.clone()).collect();
    assert_eq!(unique.len(), claimed.len(), "no input claimed twice");
    assert_eq!(
        unique,
        session.inputs.0.keys().cloned().collect::<BTreeSet<_>>(),
        "every queued input claimed"
    );
    for input in session.inputs.0.values() {
        assert_eq!(input.attempts.len(), 1, "one attempt per input");
    }
    for (input, request) in &claimed {
        assert_eq!(
            &session.inputs.0[input].attempts[0].claim_request_id, request,
            "the attempt records the claim request that claimed it"
        );
    }
    assert!(tally.polls.load(Ordering::SeqCst) as u64 > INPUTS);
}

#[test]
fn pollers_and_readers_together_lose_no_read_and_claim_each_input_once() {
    let shared = setup();
    let done = Arc::new(AtomicBool::new(false));
    let tally = Arc::new(Tally::default());
    let read_failures = Arc::new(Mutex::new(Vec::new()));
    let reads = Arc::new(AtomicUsize::new(0));

    let pollers = spawn_pollers(&shared, &done, &tally);

    let readers: Vec<_> = (0..READERS)
        .map(|_| {
            let (shared, done, failures, reads) = (
                shared.clone(),
                done.clone(),
                read_failures.clone(),
                reads.clone(),
            );
            std::thread::spawn(move || {
                let core = NativeCoreService::new(
                    shared.registry(),
                    || unreachable!("reads allocate nothing"),
                    at,
                    |_| unreachable!("reads verify nothing"),
                );
                let request: QueryRequest = serde_json::from_value(serde_json::json!({
                    "command": "session_read",
                    "params": {"selection": {"view": "items", "filters": {"topic_id": null,
                        "item_id": null, "parent_item_id": null, "statuses": [], "archived": null}},
                        "cursor": null, "limit": 100, "item_pages": []}
                }))
                .unwrap();
                while !done.load(Ordering::SeqCst) {
                    // The agent CLI's read: resolve the binding from the
                    // catalogue (a busy session fails the try), then the query.
                    let read = retry_busy_read(|| {
                        let catalogue = core.registry().catalogue().map_err(CoreError::from)?;
                        let context = AgentResolver::resolve_from_catalogue(
                            &catalogue,
                            id(3),
                            shared.generation.clone(),
                            None,
                            None,
                        )?;
                        core.query(QueryContext::agent(context), request.clone())
                    });
                    reads.fetch_add(1, Ordering::SeqCst);
                    if let Err(error) = read {
                        failures.lock().unwrap().push(error);
                    }
                }
            })
        })
        .collect();

    // Long holds: a read without the retry would fail with store_busy here.
    let holding = Arc::new(AtomicBool::new(false));
    let holder = {
        let (shared, holding) = (shared.clone(), holding.clone());
        std::thread::spawn(move || {
            for n in 0..2 {
                hold(&shared, n, &holding);
                // Room for the queued writers between long holds.
                std::thread::sleep(Duration::from_millis(1_000));
            }
        })
    };
    // The owner queues inputs between the holds, spaced like a person typing,
    // so no artificial burst of claims lands in a reader's one retry window.
    // (`claims_and_owner_writes_resent_through_a_long_hold_claim_each_input_once`
    // queues and claims during the holds.)
    while !holding.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(1));
    }
    for n in 0..INPUTS {
        while holding.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(5));
        }
        queue(&shared, 1_000 + n, &tally.busy_owner_writes);
        std::thread::sleep(Duration::from_millis(175));
    }
    holder.join().unwrap();
    let finished = finish(&shared, &done, pollers.into_iter().chain(readers).collect());
    assert!(finished, "every queued input was handled");

    assert_claimed_once(&shared, &tally);
    let failures = read_failures.lock().unwrap();
    assert!(failures.is_empty(), "read failures: {failures:?}");
    assert!(reads.load(Ordering::SeqCst) > 0);
}

#[test]
fn claims_and_owner_writes_resent_through_a_long_hold_claim_each_input_once() {
    let shared = setup();
    let done = Arc::new(AtomicBool::new(false));
    let tally = Arc::new(Tally::default());

    // Inputs wait to be claimed when the first hold starts.
    for n in 0..3 {
        queue(&shared, 1_000 + n, &tally.busy_owner_writes);
    }
    let holding = Arc::new(AtomicBool::new(false));
    let holder = {
        let (shared, holding) = (shared.clone(), holding.clone());
        std::thread::spawn(move || {
            for n in 0..2 {
                hold(&shared, n, &holding);
                std::thread::sleep(Duration::from_millis(1_000));
            }
        })
    };
    while !holding.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(1));
    }
    // Pollers start inside the hold: their claims wait out the lock deadline,
    // get store_busy and are resent with the same request id.
    let pollers = spawn_pollers(&shared, &done, &tally);
    // The owner keeps queueing 20 ms apart, into the holds.
    for n in 3..INPUTS {
        queue(&shared, 1_000 + n, &tally.busy_owner_writes);
        std::thread::sleep(Duration::from_millis(20));
    }
    holder.join().unwrap();
    let finished = finish(&shared, &done, pollers);
    assert!(finished, "every queued input was handled");

    assert_claimed_once(&shared, &tally);
    assert!(
        tally.busy_owner_writes.load(Ordering::SeqCst) > 0,
        "an owner write met a hold"
    );
    let resent: BTreeSet<_> = tally.resent.lock().unwrap().iter().cloned().collect();
    assert!(!resent.is_empty(), "a claim met a hold");
    assert!(
        tally
            .claimed
            .lock()
            .unwrap()
            .iter()
            .any(|(_, request)| resent.contains(request)),
        "a resent claim request claimed its input once"
    );
}

/// P11.24: an agent's `session_read` is answered from the lock-free snapshot, so a long hold of the session lock
/// neither delays nor fails it, and it returns what a locked read returns once the hold ends.
#[test]
fn session_read_is_answered_while_the_session_lock_is_held() {
    let shared = setup();
    let core = NativeCoreService::new(
        shared.registry(),
        || unreachable!("reads allocate nothing"),
        at,
        |_| unreachable!("reads verify nothing"),
    );
    let request: QueryRequest = serde_json::from_value(serde_json::json!({
        "command": "session_read",
        "params": {"selection": {"view": "items", "filters": {"topic_id": null,
            "item_id": null, "parent_item_id": null, "statuses": [], "archived": null}},
            "cursor": null, "limit": 100, "item_pages": []}
    }))
    .unwrap();
    let context = || {
        QueryContext::owner(OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
            route(),
        )))
    };
    let unheld = core.query(context(), request.clone()).unwrap();

    let holding = Arc::new(AtomicBool::new(false));
    let holder = {
        let (shared, holding) = (shared.clone(), holding.clone());
        std::thread::spawn(move || hold(&shared, 0, &holding))
    };
    while !holding.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(1));
    }
    let started = Instant::now();
    let held = core
        .query(context(), request.clone())
        .expect("a read does not wait for the session lock");
    assert!(
        started.elapsed() < Duration::from_millis(1_000),
        "a locked read would wait the store's 2 s lock wait and fail: {:?}",
        started.elapsed()
    );
    assert_eq!(
        held, unheld,
        "the hold wrote nothing, so both reads see the same committed session"
    );
    holder.join().unwrap();
}
