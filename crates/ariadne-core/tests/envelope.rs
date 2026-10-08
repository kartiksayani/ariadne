//! The slim per-input envelope and the hold on inputs whose question changed.
use ariadne_core::{
    delivery::{held_for_review, DeliveryService},
    inputs::InputService,
    *,
};
use ariadne_domain::history::open_ask_round;
use ariadne_domain::models::*;
use ariadne_domain::transitions::{transition_item, ItemChange, TransitionContext};
use ariadne_store::{registry::Registry, session::Store};
use std::sync::atomic::{AtomicU64, Ordering};
use tempfile::TempDir;

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn p(n: u64) -> PositiveSafeInteger {
    PositiveSafeInteger::new(n).unwrap()
}
fn item(n: &str) -> ItemRef {
    ItemRef::new(n).unwrap()
}
fn at() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
}
fn seed() -> Session {
    serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json")).unwrap()
}

/// Item 1 asked by the agent with one option, waiting on the owner.
fn asked() -> Session {
    let mut session = seed();
    let mut activity = session.messages[0].clone();
    activity.id = id(101);
    activity.number = session.counters.next_message;
    activity.created_at = at();
    activity.body = "A long agent activity the envelope must not repeat".into();
    activity.items_touched = vec![item("1")];
    session.counters.next_message = p(3);
    session.messages.push(activity);
    let candidate = transition_item(
        &session,
        &item("1"),
        &ItemChange::Ask {
            ask: "Which cache should the SDK use? Full ask with context.".into(),
            options: vec![ItemOption {
                id: "lru".into(),
                label: "LRU cache".into(),
                consequence: "A long consequence the envelope must not repeat.".into(),
                recommended: true,
            }],
            recipient_binding_id: id(3),
            round_id: id(201),
        },
        &TransitionContext {
            binding_id: id(3),
            generation: id(4),
            cause_message_id: id(101),
            at: at(),
            handled_through_message_number: NonnegativeSafeInteger::new(0).unwrap(),
            expected_revision: p(1),
            expected_question_revision: None,
        },
    )
    .unwrap();
    open_ask_round(&session, candidate, &id(101), at()).unwrap()
}

struct Setup {
    home: TempDir,
    _root: TempDir,
    registry: Registry,
    next: AtomicU64,
}
impl Setup {
    fn new(session: &Session) -> Self {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        registry.register(root.path(), &id(99), || id(1)).unwrap();
        Store::open_registered(&Self::dir(&home), id(1))
            .unwrap()
            .create(session)
            .unwrap();
        Self {
            home,
            _root: root,
            registry,
            next: AtomicU64::new(10000),
        }
    }
    fn dir(home: &TempDir) -> std::path::PathBuf {
        home.path().join(".ariadne/projects").join(id(1).as_str())
    }
    fn store(&self) -> Store {
        Store::open_registered(&Self::dir(&self.home), id(1)).unwrap()
    }
    fn saved(&self) -> Session {
        self.store().read(&id(2)).unwrap()
    }
    fn uuid(&self) -> UuidV4 {
        id(self.next.fetch_add(1, Ordering::SeqCst))
    }
    fn submit(&self, op: u64, kind: InputKind, text: &str, option: Option<&str>) -> UuidV4 {
        let session = self.saved();
        let command = OwnerCommand::InputSubmit {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(op),
            params: InputSubmitParams {
                binding_id: id(3),
                target: InputTarget {
                    topic_id: session.items.0[&item("1")].topic_id.clone(),
                    item_id: Some(item("1")),
                },
                kind,
                text: text.into(),
                selected_option_id: option.map(Into::into),
                expected_question_revision: Some(session.items.0[&item("1")].question_revision),
                supersedes_answer_id: None,
            },
        };
        let receipt = InputService::new(&self.registry)
            .execute(
                &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
                    RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
                )),
                &command,
                || self.uuid(),
                at(),
            )
            .unwrap();
        let MutationReceipt::Session(receipt) = receipt else {
            panic!("session receipt")
        };
        let SavedReceiptData::InputSubmit { input_id, .. } = receipt.data else {
            panic!("input receipt")
        };
        input_id
    }
    fn claim(&self, n: u64) -> Option<PreparedAttempt> {
        let generation = self.saved().bindings.0[&id(3)].generation.clone();
        DeliveryService::new(&self.registry)
            .claim(
                &ValidatedDispatchContext::from_trusted_current_lease(
                    RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
                    id(3),
                    generation.clone(),
                ),
                &ClaimRequest {
                    binding_id: id(3),
                    generation,
                    request_id: id(n),
                },
                || self.uuid(),
                at(),
            )
            .unwrap()
    }
    /// The agent asks again: the item's question moves past what the owner saw.
    fn reask(&self, op: u64) {
        self.store()
            .transact(
                &id(2),
                &ReceiptActorScope::Owner {},
                &id(op),
                &serde_json::json!({"test":op}),
                |session| {
                    let target = session.items.0.get_mut(&item("1")).unwrap();
                    target.question = "A changed question".into();
                    target.question_revision = p(target.question_revision.value() + 1);
                    Ok::<_, ()>(SavedReceiptData::InputCancel {
                        input_id: id(999),
                        state: InputState::Cancelled,
                    })
                },
            )
            .unwrap();
    }
}

fn envelope(prepared: &PreparedAttempt) -> serde_json::Value {
    serde_json::from_str(prepared.formatted_payload.split_once('\n').unwrap().1).unwrap()
}

#[test]
fn answer_envelope_carries_only_echo_ids_target_revisions_option_and_text() {
    let t = Setup::new(&asked());
    let input = t.submit(10, InputKind::Answer, "Go with it.", Some("lru"));
    let p = t.claim(20).unwrap();
    let body = envelope(&p);
    let keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "attempt_id",
            "binding_id",
            "generation",
            "input_kind",
            "item_id",
            "item_revision",
            "owner_message_number",
            "question_revision",
            "selected_option_id",
            "selected_option_label",
            "source_input_id",
            "text"
        ]
    );
    // The skill, loaded once, explains every field the envelope carries.
    let rules = include_str!("../../../integrations/rules/source.md");
    for key in keys.iter().chain([&"topic_id".to_owned()]) {
        assert!(rules.contains(&format!("`{key}`")), "rules omit {key}");
    }
    let session = t.saved();
    let target = &session.items.0[&item("1")];
    let owner = session
        .messages
        .iter()
        .find(|m| m.id == session.inputs.0[&input].message_id)
        .unwrap();
    assert_eq!(body["source_input_id"], input.as_str());
    assert_eq!(body["attempt_id"], p.attempt_id.as_str());
    assert_eq!(body["binding_id"], id(3).as_str());
    assert_eq!(body["generation"], p.binding_generation.as_str());
    assert_eq!(body["owner_message_number"], owner.number.value());
    assert_eq!(body["input_kind"], "answer");
    assert_eq!(body["item_id"], "1");
    assert_eq!(body["item_revision"], target.revision.value());
    assert_eq!(body["question_revision"], target.question_revision.value());
    assert_eq!(body["selected_option_id"], "lru");
    assert_eq!(body["selected_option_label"], "LRU cache");
    assert_eq!(body["text"], "Go with it.");
    // No instruction, context, item body or snapshot rides along.
    for repeated in ["Which cache", "long consequence", "long agent activity"] {
        assert!(!p.formatted_payload.contains(repeated), "{repeated}");
    }
    // A one-line answer stays about 500 bytes, marker included (six UUIDs are
    // most of it), i.e. roughly 200 tokens instead of the old 4.5-14 KB.
    assert!(
        p.formatted_payload.len() <= 560,
        "{} bytes",
        p.formatted_payload.len()
    );
}

#[test]
fn input_without_an_option_omits_the_option_fields() {
    let t = Setup::new(&seed());
    t.submit(10, InputKind::Reply, "Exact owner text \n", None);
    let body = envelope(&t.claim(20).unwrap());
    assert!(body.get("selected_option_id").is_none());
    assert!(body.get("selected_option_label").is_none());
    assert!(body.get("topic_id").is_none());
    assert_eq!(body["text"], "Exact owner text \n");
}

#[test]
fn input_behind_the_current_question_is_held_and_later_inputs_still_deliver() {
    let t = Setup::new(&seed());
    let stale = t.submit(
        10,
        InputKind::Reply,
        "Written against the old question",
        None,
    );
    t.reask(11);
    let session = t.saved();
    assert!(held_for_review(&session, &session.inputs.0[&stale]));
    // Only the held input is queued: nothing is delivered and nothing is allocated.
    let before = t.saved();
    assert!(t.claim(20).is_none());
    assert_eq!(t.saved().inputs, before.inputs);

    let current = t.submit(
        12,
        InputKind::Reply,
        "Written against the new question",
        None,
    );
    let session = t.saved();
    assert!(!held_for_review(&session, &session.inputs.0[&current]));
    let p = t.claim(21).unwrap();
    assert_eq!(p.input_id, current);
    let session = t.saved();
    let held = &session.inputs.0[&stale];
    assert_eq!(held.state, InputState::Queued);
    assert!(held.attempts.is_empty());
    // The held input is not stuck behind or ahead of anything; it waits for the owner.
    assert!(held_for_review(&session, held));
    assert!(!held_for_review(&session, &session.inputs.0[&current]));
}
