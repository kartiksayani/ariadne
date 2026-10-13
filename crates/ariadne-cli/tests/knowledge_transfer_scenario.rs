//! A complete fictional agent session, filed through the actual CLI from empty
//! session contents. Registration and owner-input delivery are test setup: apply
//! cannot create a binding or impersonate an owner's answer. No host is contacted.
use ariadne_agent_protocol::{EventPayload, NormalizedEvent, TurnFinishedStatus};
use ariadne_core::{delivery::DeliveryService, inputs::InputService, *};
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Command, Stdio},
};

#[derive(Deserialize)]
struct Scenario {
    description: String,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
struct Step {
    name: String,
    owner_answer: Option<OwnerAnswer>,
    request: Value,
}

#[derive(Deserialize)]
struct OwnerAnswer {
    item: String,
    selected_option_id: String,
    text: String,
}

fn id(number: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{number:012x}")).unwrap()
}

fn item(number: &str) -> ItemRef {
    ItemRef::new(number).unwrap()
}

struct Setup {
    home: tempfile::TempDir,
    _root: tempfile::TempDir,
    registry: Registry,
}

impl Setup {
    fn empty() -> Self {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        registry.register(root.path(), &id(99), || id(1)).unwrap();
        // Reuse the canonical registered fake binding, without its work items.
        let mut session: Session =
            serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json"))
                .unwrap();
        session.title = "Fictional notes sync review".into();
        session.topics.0.clear();
        session.items.0.clear();
        session.messages.clear();
        session.counters.next_root = PositiveSafeInteger::new(1).unwrap();
        session.counters.next_topic_order = PositiveSafeInteger::new(1).unwrap();
        session.counters.next_message = PositiveSafeInteger::new(1).unwrap();
        Store::open_registered(&registry.project_dir(&id(1)), id(1))
            .unwrap()
            .create(&session)
            .unwrap();
        Self {
            home,
            _root: root,
            registry,
        }
    }

    fn session(&self) -> Session {
        Store::open_registered(&self.registry.project_dir(&id(1)), id(1))
            .unwrap()
            .read(&id(2))
            .unwrap()
    }

    fn route(&self) -> RegisteredSession {
        RegisteredSession::from_trusted_entrypoint(id(1), id(2))
    }

    /// Explicit fixture revisions must match the prior receipts. Only topic
    /// identity placeholders become the UUIDs allocated by earlier apply calls.
    fn bind_guards(&self, request: &mut Value) {
        let session = self.session();
        if let Some(guards) = request
            .get_mut("expected_item_revisions")
            .and_then(Value::as_object_mut)
        {
            for (number, revision) in guards {
                assert_eq!(
                    *revision,
                    json!(session.items.0[&item(number)].revision),
                    "fixture guard for item {number} must match its prior receipt"
                );
            }
        }
        if let Some(guards) = request
            .get_mut("expected_topic_revisions")
            .and_then(Value::as_object_mut)
        {
            let resolved = guards
                .iter()
                .map(|(number, revision)| {
                    let topic = session
                        .topics
                        .0
                        .values()
                        .find(|topic| topic.order.value().to_string() == *number)
                        .unwrap();
                    assert_eq!(*revision, json!(topic.revision));
                    (topic.id.as_str().to_owned(), revision.clone())
                })
                .collect();
            *guards = resolved;
        }
        for operation in request["operations"].as_array_mut().unwrap() {
            if operation["topic"] == "$launch_topic" {
                let topic = session
                    .topics
                    .0
                    .values()
                    .find(|topic| topic.order.value() == 2)
                    .unwrap();
                operation["topic"] = json!({"id": topic.id});
            }
        }
    }

    fn apply(&self, step: &str, request: &Value) -> Value {
        let mut child = Command::new(env!("CARGO_BIN_EXE_ariadne"))
            .args([
                "apply",
                "--binding",
                id(3).as_str(),
                "--generation",
                id(4).as_str(),
                "--json-stdin",
                "--json",
            ])
            .env("ARIADNE_HOME", self.home.path().join(".ariadne"))
            .env("HOME", self.home.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(request).unwrap())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{step}: {output:?}");
        assert!(output.stderr.is_empty(), "{step}: {output:?}");
        let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(envelope["ok"], true, "{step}: {envelope}");
        let data = envelope["data"].clone();
        assert_ne!(data["replayed"], true, "{step}: {data}");
        assert_eq!(data["warnings"], json!([]), "{step}: {data}");
        assert!(
            data["repairs"].is_null() || data["repairs"] == json!([]),
            "{step}: {data}"
        );
        data
    }

    /// The owner API creates the answer; real delivery claim/report services
    /// establish its accepted attempt. The script only binds the resulting IDs.
    fn answer_and_dispatch(&self, answer: &OwnerAnswer, request: &mut Value) -> UuidV4 {
        let session = self.session();
        let target = &session.items.0[&item(&answer.item)];
        let at = session.updated_at.clone();
        let mut next = 10_000;
        let mut allocate = || {
            next += 1;
            id(next)
        };
        let receipt = InputService::new(&self.registry)
            .execute(
                &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(self.route())),
                &OwnerCommand::InputSubmit {
                    api_version: SchemaVersion::new(1).unwrap(),
                    op_id: id(700),
                    params: InputSubmitParams {
                        binding_id: id(3),
                        target: InputTarget {
                            topic_id: target.topic_id.clone(),
                            item_id: Some(target.id.clone()),
                        },
                        kind: InputKind::Answer,
                        text: answer.text.clone(),
                        selected_option_id: Some(answer.selected_option_id.clone()),
                        expected_question_revision: Some(target.question_revision),
                        supersedes_answer_id: None,
                    },
                },
                &mut allocate,
                at.clone(),
            )
            .unwrap();
        let MutationReceipt::Session(receipt) = receipt else {
            panic!("session receipt")
        };
        let SavedReceiptData::InputSubmit {
            input_id,
            message_number,
            ..
        } = receipt.data
        else {
            panic!("owner answer receipt")
        };
        let delivery = DeliveryService::new(&self.registry);
        let prepared = delivery
            .claim(
                &ValidatedDispatchContext::from_trusted_current_lease(self.route(), id(3), id(4)),
                &ClaimRequest {
                    binding_id: id(3),
                    generation: id(4),
                    request_id: id(701),
                },
                &mut allocate,
                at.clone(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(prepared.input_id, input_id);
        delivery
            .report(
                &AdapterContext::from_trusted_entrypoint(self.route(), id(3), id(4), None),
                &NormalizedEvent {
                    event_id: "scenario-owner-answer-accepted".into(),
                    binding_id: id(3),
                    generation: id(4),
                    input_id: Some(input_id.clone()),
                    attempt_id: Some(prepared.attempt_id.clone()),
                    host_turn_id: Some("scenario-owner-answer-turn".into()),
                    observed_at: at,
                    event: EventPayload::Accepted { receipt: None },
                },
                &mut allocate,
            )
            .unwrap();
        request["source_input_id"] = json!(input_id);
        request["attempt_id"] = json!(prepared.attempt_id);
        request["input_result"]["handled_through_message_number"] = json!(message_number);
        input_id
    }

    /// A committed agent result and a completed host turn are separate facts.
    /// Join both through the real delivery service after the answer apply.
    fn finish_dispatched_turn(&self, request: &Value) {
        DeliveryService::new(&self.registry)
            .report(
                &AdapterContext::from_trusted_entrypoint(self.route(), id(3), id(4), None),
                &NormalizedEvent {
                    event_id: "scenario-owner-answer-finished".into(),
                    binding_id: id(3),
                    generation: id(4),
                    input_id: Some(
                        serde_json::from_value(request["source_input_id"].clone()).unwrap(),
                    ),
                    attempt_id: Some(
                        serde_json::from_value(request["attempt_id"].clone()).unwrap(),
                    ),
                    host_turn_id: Some("scenario-owner-answer-turn".into()),
                    observed_at: self.session().updated_at,
                    event: EventPayload::TurnFinished {
                        status: TurnFinishedStatus::Completed,
                        reason: None,
                        diagnostic_text: None,
                        truncated: false,
                    },
                },
                || id(702),
            )
            .unwrap();
    }
}

fn changes(session: &Session, number: &str) -> Vec<ItemChangeRecord> {
    session.items.0[&item(number)]
        .changes
        .clone()
        .unwrap_or_default()
}

#[test]
fn realistic_knowledge_transfer_session_succeeds_without_warnings() {
    let scenario: Scenario =
        serde_json::from_str(include_str!("fixtures/knowledge-transfer-session.json")).unwrap();
    assert!(scenario.description.contains("Fictional"));
    let setup = Setup::empty();
    let empty = setup.session();
    assert!(empty.topics.0.is_empty() && empty.items.0.is_empty() && empty.messages.is_empty());
    let mut initial = None;
    let mut answered = None;
    let mut source_input = None;
    for (index, step) in scenario.steps.into_iter().enumerate() {
        let mut request = step.request;
        let dispatched = step.owner_answer.is_some();
        if let Some(answer) = step.owner_answer {
            source_input = Some(setup.answer_and_dispatch(&answer, &mut request));
        }
        setup.bind_guards(&mut request);
        setup.apply(&step.name, &request);
        if dispatched {
            setup.finish_dispatched_turn(&request);
        }
        let saved = setup.session();
        assert!(
            saved
                .items
                .0
                .values()
                .filter(|item| ariadne_core::queries::waiting_unanswered(&saved, item))
                .count()
                <= 3
        );
        if index == 0 {
            initial = Some(saved);
        } else if index == 1 {
            answered = Some(saved);
        }
    }
    let initial = initial.unwrap();
    assert_eq!(initial.topics.0.len(), 2);
    assert_eq!(initial.items.0.len(), 5);
    assert!(initial.topics.0.values().all(|topic| topic
        .brief
        .as_ref()
        .is_some_and(|brief| !brief.contains('\n') && brief.contains("(item:"))));
    assert!(
        initial.items.0.values().all(|item| item.parent.is_none()),
        "routine checklist steps stay inside one item"
    );
    assert_eq!(
        initial.items.0[&item("5")]
            .note
            .as_ref()
            .unwrap()
            .matches("- [ ]")
            .count(),
        2
    );
    assert_eq!(initial.items.0[&item("1")].item_type, ItemType::Decision);
    assert_eq!(initial.items.0[&item("3")].item_type, ItemType::Decision);
    assert!(
        initial
            .items
            .0
            .values()
            .all(|item| item.changes.as_ref().is_none_or(Vec::is_empty)),
        "creation and deferred connections are not edits in owner history"
    );
    for number in ["1", "3"] {
        let question = &initial.items.0[&item(number)];
        assert_eq!(question.status, ItemStatus::WaitingOnMe);
        let ask = question.ask.as_ref().unwrap();
        for phrase in [
            "Bottom line:",
            "What this means for you:",
            "I recommend",
            "because",
            "if that’s wrong",
            "If you don’t answer, I’ll",
            "keep sync off",
            "Details:",
        ] {
            assert!(ask.contains(phrase), "{number} lacks {phrase}: {ask}");
        }
        assert!((2..=3).contains(&question.options.len()));
        assert_eq!(
            question
                .options
                .iter()
                .filter(|option| option.recommended)
                .count(),
            1
        );
        assert!(question
            .options
            .iter()
            .all(|option| !option.consequence.trim().is_empty()));
        for affected in question.affects.as_ref().unwrap() {
            assert!(ask.contains(&format!("(item:{})", affected.as_str())));
        }
    }

    let answered = answered.unwrap();
    let source_input = source_input.unwrap();
    let input = &answered.inputs.0[&source_input];
    assert_eq!(input.state, InputState::Handled);
    assert_eq!(input.payload.selected_option_id.as_deref(), Some("three"));
    assert_eq!(answered.answers.len(), 1);
    assert!(answered.answers[0].text.contains("keep sync off"));
    let result = input
        .attempts
        .last()
        .unwrap()
        .domain_result
        .as_ref()
        .unwrap();
    assert_eq!(result.outcome, ResultOutcome::Answered);
    for number in ["1", "2", "4"] {
        assert!(result.explanation.contains(&format!("(item:{number})")));
        let records = changes(&answered, number);
        assert!(!records.is_empty());
        assert!(records
            .iter()
            .all(|change| change.reason.is_some() && !change.wording_only));
        let cause = answered
            .messages
            .iter()
            .find(|message| message.id == records[0].cause_message_id)
            .unwrap();
        assert_eq!(cause.input_id.as_ref(), Some(&source_input));
        assert!(records
            .iter()
            .all(|change| change.cause_message_id == cause.id));
    }
    assert_eq!(changes(&answered, "1").len(), 1);
    assert_eq!(changes(&answered, "2").len(), 2);
    assert_eq!(changes(&answered, "4").len(), 2);
    let pressure_before = &changes(&answered, "2")[0].before;
    assert_eq!(
        pressure_before.question,
        Some(Some(initial.items.0[&item("2")].question.clone()))
    );
    assert_eq!(pressure_before.affects, Some(Some(vec![item("4")])));
    assert_ne!(
        answered.items.0[&item("2")].topic_id,
        answered.items.0[&item("4")].topic_id
    );
    assert_eq!(
        answered.items.0[&item("1")].affects,
        Some(vec![item("2"), item("4")])
    );
    assert_eq!(
        answered.items.0[&item("2")].affects,
        Some(vec![item("4"), item("5")])
    );
    assert_eq!(answered.items.0[&item("4")].affects, Some(vec![item("5")]));
    assert_eq!(
        answered.items.0[&item("3")],
        initial.items.0[&item("3")],
        "the owner did not answer the launch choice"
    );

    let final_session = setup.session();
    let replaced = &final_session.items.0[&item("4")];
    assert_eq!(replaced.status, ItemStatus::Replaced);
    assert_eq!(replaced.replaced_by, Some(item("6")));
    let replacement_change = changes(&final_session, "4").pop().unwrap();
    assert_eq!(
        replacement_change.before.status,
        Some(Some(ItemStatus::Open))
    );
    assert!(replacement_change
        .reason
        .unwrap()
        .contains("Pause recovery now has evidence"));
    assert_eq!(
        final_session.items.0[&item("6")].affects,
        Some(vec![item("3")])
    );
    assert_eq!(
        final_session.items.0[&item("6")].depends_on,
        Some(vec![item("5")])
    );
    assert_eq!(
        final_session.items.0[&item("6")].related,
        Some(vec![item("2")])
    );
    assert!(changes(&final_session, "6").is_empty());
    for number in ["5", "6"] {
        let result = &final_session.items.0[&item(number)];
        assert_eq!(result.status, ItemStatus::Open);
        assert_eq!(result.ack_to, Some(AckTarget::Done));
        assert!(result.outcome.is_some() && result.why.is_some());
    }
    assert_eq!(
        final_session.items.0[&item("1")].ack_to,
        Some(AckTarget::Decided)
    );
    let checklist = final_session.items.0[&item("5")].outcome.as_ref().unwrap();
    assert_eq!(checklist.matches("- [x]").count(), 2);
    let wording = changes(&final_session, "2").pop().unwrap();
    assert!(wording.wording_only);
    assert_eq!(
        wording.before.question,
        Some(Some(answered.items.0[&item("2")].question.clone()))
    );
    assert_eq!(
        wording.before.short,
        Some(answered.items.0[&item("2")].short.clone())
    );
    let fields = serde_json::to_value(&wording.before).unwrap();
    assert_eq!(fields.as_object().unwrap().len(), 2);
    assert_eq!(
        final_session.items.0[&item("2")].affects,
        answered.items.0[&item("2")].affects
    );
    assert_eq!(
        final_session.items.0[&item("2")].outcome,
        answered.items.0[&item("2")].outcome
    );
    let launch = final_session
        .topics
        .0
        .values()
        .find(|topic| topic.order.value() == 2)
        .unwrap();
    assert!(launch
        .brief
        .as_ref()
        .unwrap()
        .contains("The pilot checks passed"));
    assert!(launch.brief_updated_at.is_some());
    assert_eq!(
        final_session.items.0[&item("3")].status,
        ItemStatus::WaitingOnMe
    );
    assert_eq!(
        final_session
            .items
            .0
            .values()
            .filter(|item| ariadne_core::queries::waiting_unanswered(&final_session, item))
            .count(),
        1
    );
}
