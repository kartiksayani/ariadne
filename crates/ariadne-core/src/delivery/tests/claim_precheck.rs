//! The lock-free claim pre-check: it may answer "nothing to send" and refusals
//! without the lock, but every claim is decided again on the locked read.
use super::*;
use crate::inputs::InputService;
use ariadne_store::{registry::Registry, session::Store};
use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tempfile::TempDir;

thread_local! {
    static BEFORE_LOCK: RefCell<Option<Box<dyn FnOnce()>>> = RefCell::new(None);
}

/// Runs once, between the lock-free check and taking the session lock.
pub(super) fn before_lock() {
    let hook = BEFORE_LOCK.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook();
    }
}

fn between_check_and_lock(hook: impl FnOnce() + 'static) {
    BEFORE_LOCK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn at() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
}
fn route() -> RegisteredSession {
    RegisteredSession::from_trusted_entrypoint(id(1), id(2))
}

struct Setup {
    home: TempDir,
    _root: TempDir,
    registry: Registry,
    next: AtomicU64,
}
impl Setup {
    fn new() -> std::rc::Rc<Self> {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        registry.register(root.path(), &id(99), || id(1)).unwrap();
        let seed: Session = serde_json::from_str(include_str!(
            "../../../../../fixtures/domain/history/seed.json"
        ))
        .unwrap();
        let setup = Self {
            home,
            _root: root,
            registry,
            next: AtomicU64::new(10_000),
        };
        setup.store().create(&seed).unwrap();
        std::rc::Rc::new(setup)
    }
    fn store_dir(&self) -> std::path::PathBuf {
        self.home
            .path()
            .join(".ariadne/projects")
            .join(id(1).as_str())
    }
    fn store(&self) -> Store {
        Store::open_registered(&self.store_dir(), id(1)).unwrap()
    }
    fn saved(&self) -> Session {
        self.store().read(&id(2)).unwrap()
    }
    fn uuid(&self) -> UuidV4 {
        id(self.next.fetch_add(1, Ordering::SeqCst))
    }
    /// The binding generation; these tests never rotate it. Read without the
    /// lock so a poll can be built while a test holds the session lock.
    fn generation(&self) -> UuidV4 {
        self.store().peek(&id(2)).unwrap().bindings.0[&id(3)]
            .generation
            .clone()
    }
    fn lease(&self) -> ValidatedDispatchContext {
        ValidatedDispatchContext::from_trusted_current_lease(route(), id(3), self.generation())
    }
    fn request(&self, n: u64) -> ClaimRequest {
        ClaimRequest {
            binding_id: id(3),
            generation: self.generation(),
            request_id: id(n),
        }
    }
    fn claim(&self, n: u64) -> Result<Option<PreparedAttempt>, DeliveryError> {
        DeliveryService::new(&self.registry).claim(
            &self.lease(),
            &self.request(n),
            || self.uuid(),
            at(),
        )
    }
    fn owner(&self, command: OwnerCommand) {
        InputService::new(&self.registry)
            .execute(
                &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(route())),
                &command,
                || self.uuid(),
                at(),
            )
            .unwrap();
    }
    fn queue(&self, n: u64) -> UuidV4 {
        let before: std::collections::BTreeSet<_> = self.saved().inputs.0.keys().cloned().collect();
        self.owner(OwnerCommand::InputSubmit {
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
        });
        let after = self.saved();
        after
            .inputs
            .0
            .keys()
            .find(|input| !before.contains(*input))
            .cloned()
            .unwrap()
    }
    fn cancel(&self, input: &UuidV4, n: u64) {
        self.owner(OwnerCommand::InputCancel {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(n),
            params: InputCancelParams {
                input_id: input.clone(),
                expected_revision: self.saved().revision,
                purpose: None,
            },
        });
    }
    fn attempts(&self, input: &UuidV4) -> usize {
        self.saved().inputs.0[input].attempts.len()
    }
    /// Holds the session lock until the returned sender is dropped or sent to.
    fn hold_lock(&self) -> (mpsc::Sender<()>, std::thread::JoinHandle<()>) {
        let dir = self.store_dir();
        let (locked_tx, locked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let holder = std::thread::spawn(move || {
            let store = Store::open_registered(&dir, id(1)).unwrap();
            let _ = store.transact(
                &id(2),
                &ReceiptActorScope::Owner {},
                &id(77_777),
                &serde_json::json!({"hold": true}),
                |_| {
                    locked_tx.send(()).unwrap();
                    let _ = release_rx.recv_timeout(Duration::from_secs(30));
                    Err::<SavedReceiptData, _>(())
                },
            );
        });
        locked_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        (release_tx, holder)
    }
}

fn code(error: DeliveryError) -> CoreErrorCode {
    match error {
        DeliveryError::Core(error) => error.code,
        DeliveryError::Store(error) => CoreError::from(error).code,
        DeliveryError::Registry(error) => CoreError::from(error).code,
    }
}

#[test]
fn a_cancel_landing_between_the_check_and_the_lock_is_decided_on_the_locked_read() {
    let t = Setup::new();
    let first = t.queue(100);
    let second = t.queue(101);
    let hook = t.clone();
    let cancelled = first.clone();
    // The lock-free check sees `first` queued; the owner cancels it before
    // the claim takes the lock. The locked read must deliver `second` instead.
    between_check_and_lock(move || hook.cancel(&cancelled, 102));
    let prepared = t.claim(200).unwrap().unwrap();
    assert_eq!(prepared.input_id, second);
    assert_eq!(t.attempts(&first), 0, "a cancelled input is never sent");
    assert_eq!(t.saved().inputs.0[&first].state, InputState::Cancelled);
}

#[test]
fn a_competing_claim_between_the_check_and_the_lock_wins_once() {
    let t = Setup::new();
    let only = t.queue(100);
    let hook = t.clone();
    let rival = std::rc::Rc::new(RefCell::new(None));
    let won = rival.clone();
    // Two pollers both see `only` queued without the lock; one claims first.
    between_check_and_lock(move || *won.borrow_mut() = Some(hook.claim(300).unwrap()));
    let late = t.claim(200).unwrap();
    let winner = rival.borrow_mut().take().unwrap().unwrap();
    assert_eq!(winner.input_id, only);
    assert!(
        late.is_none(),
        "the second poller finds the input in flight"
    );
    assert_eq!(t.attempts(&only), 1, "claimed exactly once");
}

#[test]
fn a_cancel_of_the_only_input_between_the_check_and_the_lock_sends_nothing() {
    let t = Setup::new();
    let only = t.queue(100);
    let hook = t.clone();
    let cancelled = only.clone();
    between_check_and_lock(move || hook.cancel(&cancelled, 101));
    assert!(t.claim(200).unwrap().is_none());
    assert_eq!(t.attempts(&only), 0);
}

#[test]
fn an_input_queued_after_a_check_is_claimed_by_the_next_poll() {
    let t = Setup::new();
    assert!(t.claim(200).unwrap().is_none());
    let input = t.queue(100);
    let prepared = t.claim(201).unwrap().unwrap();
    assert_eq!(prepared.input_id, input);
    assert!(t.claim(202).unwrap().is_none(), "one in flight at a time");
    // Exact replay of the saved claim still returns it, through the lock.
    let replay = t.claim(201).unwrap().unwrap();
    assert_eq!(replay, prepared);
    assert_eq!(t.attempts(&input), 1);
}

#[test]
fn nothing_to_send_and_refusals_never_wait_for_the_session_lock() {
    let t = Setup::new();
    let (release, holder) = t.hold_lock();
    let started = Instant::now();
    assert!(t.claim(200).unwrap().is_none());
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "{:?}",
        started.elapsed()
    );
    release.send(()).unwrap();
    holder.join().unwrap();

    // A refusal is a function of the snapshot too: answered without the lock.
    t.store()
        .transact(
            &id(2),
            &ReceiptActorScope::Owner {},
            &id(400),
            &serde_json::json!({"pause": true}),
            |session| {
                let binding = session.bindings.0.get_mut(&id(3)).unwrap();
                binding.owner_paused = true;
                binding.dispatch_state = DispatchState::Paused;
                Ok::<_, ()>(SavedReceiptData::BindingState {
                    binding_id: id(3),
                    generation: binding.generation.clone(),
                    dispatch_state: binding.dispatch_state.clone(),
                    owner_paused: true,
                    pause_reason: binding.pause_reason.clone(),
                    connection_state: binding.connection_state.clone(),
                })
            },
        )
        .unwrap();
    let (release, holder) = t.hold_lock();
    let started = Instant::now();
    let refused = t.claim(201).unwrap_err();
    assert!(started.elapsed() < Duration::from_secs(1));
    release.send(()).unwrap();
    holder.join().unwrap();
    assert_eq!(code(refused), CoreErrorCode::InvalidTransition);
}

#[test]
fn work_to_send_always_takes_the_session_lock() {
    let t = Setup::new();
    let input = t.queue(100);
    let (release, holder) = t.hold_lock();
    // The snapshot shows work, so the claim must wait for the lock and, when
    // the lock stays held, report busy rather than claim from the snapshot.
    let busy = t.claim(200).unwrap_err();
    release.send(()).unwrap();
    holder.join().unwrap();
    assert_eq!(code(busy), CoreErrorCode::StoreBusy);
    assert_eq!(t.attempts(&input), 0);
    assert_eq!(t.claim(201).unwrap().unwrap().input_id, input);
}
