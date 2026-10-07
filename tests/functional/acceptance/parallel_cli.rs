//! P7.1 process-boundary proof: real installed CLI, Core and atomic Store.
//! Only normalized host lifecycle facts are fabricated. This does not prove
//! native WebView acceptance, provider transport or supervisor scheduling.
use ariadne_agent_protocol::{EventPayload, NormalizedEvent, TurnFinishedStatus};
use ariadne_core::{delivery::DeliveryService, inputs::InputService, *};
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Barrier,
    thread,
};

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn at() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
}
struct Lane {
    root: PathBuf,
    project: UuidV4,
    session: UuidV4,
    binding: UuidV4,
    generation: UuidV4,
    topic: UuidV4,
    name: String,
}
impl Lane {
    fn route(&self) -> RegisteredSession {
        RegisteredSession::from_trusted_entrypoint(self.project.clone(), self.session.clone())
    }
    fn store(&self) -> Store {
        Store::open_registered(&self.root, self.project.clone()).unwrap()
    }
    fn saved(&self) -> Session {
        self.store().read(&self.session).unwrap()
    }
    fn bytes(&self) -> Vec<u8> {
        fs::read(
            self.root
                .join(format!("sessions/{}.json", self.session.as_str())),
        )
        .unwrap()
    }
    fn claim(&self, registry: &Registry, request: u64) -> Option<PreparedAttempt> {
        DeliveryService::new(registry)
            .claim(
                &ValidatedDispatchContext::from_trusted_current_lease(
                    self.route(),
                    self.binding.clone(),
                    self.generation.clone(),
                ),
                &ClaimRequest {
                    binding_id: self.binding.clone(),
                    generation: self.generation.clone(),
                    request_id: id(request),
                },
                || UuidV4::new(uuid::Uuid::new_v4().to_string()).unwrap(),
                at(),
            )
            .unwrap()
    }
    fn event(&self, attempt: &PreparedAttempt, finished: bool) -> NormalizedEvent {
        NormalizedEvent {
            // Deliberately identical event IDs across all three binding scopes.
            event_id: if finished {
                "shared-finished"
            } else {
                "shared-started"
            }
            .into(),
            binding_id: self.binding.clone(),
            generation: self.generation.clone(),
            input_id: Some(attempt.input_id.clone()),
            attempt_id: Some(attempt.attempt_id.clone()),
            host_turn_id: Some(format!("{}-turn", self.name)),
            observed_at: at(),
            event: if finished {
                EventPayload::TurnFinished {
                    status: TurnFinishedStatus::Completed,
                    reason: None,
                    diagnostic_text: Some("Host output cannot publish a domain reply".into()),
                    truncated: false,
                }
            } else {
                EventPayload::TurnStarted {}
            },
        }
    }
    fn result(&self, attempt: &PreparedAttempt) -> Value {
        let saved = self.saved();
        let input = &saved.inputs.0[&attempt.input_id];
        let message = saved
            .messages
            .iter()
            .find(|m| m.id == input.message_id)
            .unwrap();
        json!({
            // The same operation UUID must be independent in each binding scope.
            "op_id": id(900),
            "source_input_id": attempt.input_id,
            "attempt_id": attempt.attempt_id,
            "expected_item_revisions": {"1": saved.items.0[&ItemRef::new("1").unwrap()].revision},
            "expected_topic_revisions": {},
            "summary": "",
            "operations": [{"op":"reply", "ref":"reply", "item":{"id":"1"},
                "text":format!("{} explicit result", self.name), "round_id":null}],
            "input_result": {"outcome":"deferred", "explanation":format!("{} result", self.name),
                "reply_refs":[{"ref":"reply"}], "followup_item_refs":[],
                "handled_through_message_number":message.number}
        })
    }
    fn pending(&self, attempt: &PreparedAttempt) {
        let saved = self.saved();
        let active = &saved.inputs.0[&attempt.input_id];
        assert_eq!(active.state, InputState::InFlight, "{}", self.name);
        assert_eq!(active.attempts.len(), 1);
        assert!(active.attempts[0].sealed_at.is_none());
        assert_eq!(
            saved.bindings.0[&self.binding].active_input_id,
            Some(attempt.input_id.clone())
        );
        assert_eq!(
            saved
                .inputs
                .0
                .values()
                .filter(|i| i.active_attempt_id.is_some())
                .count(),
            1
        );
        let successor = saved
            .inputs
            .0
            .values()
            .find(|i| i.id != attempt.input_id)
            .unwrap();
        assert_eq!(successor.state, InputState::Queued);
        assert!(successor.attempts.is_empty());
    }
    fn handled(&self, attempt: &PreparedAttempt) {
        let saved = self.saved();
        let input = &saved.inputs.0[&attempt.input_id];
        assert_eq!(input.state, InputState::Handled);
        assert_eq!(input.attempts.len(), 1);
        let done = &input.attempts[0];
        assert_eq!(done.binding_generation, self.generation);
        assert_eq!(done.result_state, ResultState::Committed);
        assert_eq!(done.turn_state, TurnState::Completed);
        assert!(done.sealed_at.is_some());
        let replies: Vec<_> = saved
            .messages
            .iter()
            .filter(|m| m.kind == MessageKind::Reply)
            .collect();
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0].body, format!("{} explicit result", self.name));
        assert_eq!(replies[0].binding_id, Some(self.binding.clone()));
        assert_eq!(replies[0].input_id, Some(attempt.input_id.clone()));
        assert_eq!(replies[0].attempt_id, Some(attempt.attempt_id.clone()));
    }
}

fn call(binary: &str, home: &Path, lane: &Lane, report: bool, payload: &Value) -> Value {
    let mut command = Command::new(binary);
    if report {
        command.args(["bridge", "report"]);
    } else {
        command.arg("apply").arg("--json");
    }
    let mut child = command
        .args([
            "--binding",
            lane.binding.as_str(),
            "--generation",
            lane.generation.as_str(),
            "--json-stdin",
        ])
        .env("ARIADNE_HOME", home.join(".ariadne"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(payload).unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.stderr.is_empty(), "{output:?}");
    let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        output.status.success(),
        envelope["ok"] == true,
        "{envelope}"
    );
    assert_eq!(envelope["api_version"], 1);
    envelope
}
fn ok(envelope: Value) -> Value {
    assert_eq!(envelope["ok"], true, "{envelope}");
    envelope["data"].clone()
}

pub fn parallel_queued_isolation(binary: &str) {
    let home = tempfile::tempdir_in("/tmp").unwrap();
    let projects = [tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap()];
    let registry = Registry::open(home.path()).unwrap();
    for (index, root) in projects.iter().enumerate() {
        registry
            .register(root.path(), &id(800 + index as u64), || {
                id(1 + index as u64 * 100)
            })
            .unwrap();
    }
    let lanes: Vec<_> = (0..3)
        .map(|index| {
            let offset = index * 10;
            let project = if index == 2 { id(101) } else { id(1) };
            let lane = Lane {
                root: registry.project_dir(&project),
                project: project.clone(),
                session: id(2 + offset),
                binding: id(3 + offset),
                generation: id(4 + offset),
                topic: id(5 + offset),
                name: format!("lane_{index}"),
            };
            let mut source = include_str!("../../../fixtures/domain/history/seed.json").to_owned();
            for original in 2..=6 {
                source = source.replace(id(original).as_str(), id(original + offset).as_str());
            }
            source = source.replace(id(1).as_str(), project.as_str());
            let mut session: Session = serde_json::from_str(&source).unwrap();
            session
                .bindings
                .0
                .get_mut(&lane.binding)
                .unwrap()
                .external_session_id = lane.name.clone();
            lane.store().create(&session).unwrap();
            for number in 0..2 {
                InputService::new(&registry)
                    .execute(
                        &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(lane.route())),
                        &OwnerCommand::InputSubmit {
                            api_version: SchemaVersion::new(1).unwrap(),
                            op_id: id(1000 + offset + number),
                            params: InputSubmitParams {
                                binding_id: lane.binding.clone(),
                                target: InputTarget {
                                    topic_id: lane.topic.clone(),
                                    item_id: Some(ItemRef::new("1").unwrap()),
                                },
                                kind: InputKind::Reply,
                                text: format!("{} input {number}", lane.name),
                                selected_option_id: None,
                                expected_question_revision: None,
                                supersedes_answer_id: None,
                            },
                        },
                        || UuidV4::new(uuid::Uuid::new_v4().to_string()).unwrap(),
                        at(),
                    )
                    .unwrap();
            }
            lane
        })
        .collect();
    let attempts: Vec<_> = lanes
        .iter()
        .enumerate()
        .map(|(index, lane)| {
            let attempt = lane.claim(&registry, 2000 + index as u64).unwrap();
            assert_eq!(attempt.binding_generation, lane.generation);
            lane.pending(&attempt);
            assert!(lane.claim(&registry, 2100 + index as u64).is_none());
            attempt
        })
        .collect();
    let results: Vec<_> = lanes
        .iter()
        .zip(&attempts)
        .map(|(lane, attempt)| lane.result(attempt))
        .collect();

    // Every real CLI resolver rejects the other lane's input/attempt before any
    // write, even for the sibling in the same registered project.
    let unchanged: Vec<_> = lanes.iter().map(Lane::bytes).collect();
    for recipient in 0..3 {
        let foreign = (recipient + 1) % 3;
        let rejected = call(
            binary,
            home.path(),
            &lanes[recipient],
            false,
            &results[foreign],
        );
        assert_eq!(rejected["error"]["code"], "invalid_argument", "{rejected}");
        let mut event = lanes[foreign].event(&attempts[foreign], true);
        event.binding_id = lanes[recipient].binding.clone();
        event.generation = lanes[recipient].generation.clone();
        let rejected = call(
            binary,
            home.path(),
            &lanes[recipient],
            true,
            &serde_json::to_value(event).unwrap(),
        );
        assert_eq!(rejected["error"]["code"], "invalid_ref", "{rejected}");
        assert_eq!(lanes.iter().map(Lane::bytes).collect::<Vec<_>>(), unchanged);
    }

    // Lane 1 observes completion before its result. All queues still block.
    let completion = lanes[1].event(&attempts[1], true);
    ok(call(
        binary,
        home.path(),
        &lanes[1],
        true,
        &serde_json::to_value(&completion).unwrap(),
    ));
    for (index, lane) in lanes.iter().enumerate() {
        lane.pending(&attempts[index]);
        assert!(lane.claim(&registry, 2200 + index as u64).is_none());
    }
    // Three separate installed processes compete through the real Store locks.
    let barrier = Barrier::new(3);
    let receipts: Vec<_> = thread::scope(|scope| {
        let handles: Vec<_> = lanes
            .iter()
            .zip(&results)
            .map(|(lane, result)| {
                let barrier = &barrier;
                let home = home.path();
                scope.spawn(move || {
                    barrier.wait();
                    ok(call(binary, home, lane, false, result))
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect()
    });
    for (lane, receipt) in lanes.iter().zip(&receipts) {
        assert_eq!(receipt["session_id"], json!(lane.session));
        assert_eq!(receipt["operation_id"], json!(id(900)));
    }
    lanes[1].handled(&attempts[1]);
    for index in [0, 2] {
        lanes[index].pending(&attempts[index]);
        assert!(lanes[index].claim(&registry, 2300 + index as u64).is_none());
        assert_eq!(
            lanes[index].saved().inputs.0[&attempts[index].input_id].attempts[0].result_state,
            ResultState::Committed
        );
    }
    for (index, lane) in lanes.iter().enumerate() {
        let bytes = lane.bytes();
        assert_eq!(
            ok(call(binary, home.path(), lane, false, &results[index])),
            receipts[index]
        );
        assert_eq!(lane.bytes(), bytes, "result retry must not duplicate reply");
    }
    // Finish only lane 0: the cross-project lane remains blocked independently.
    ok(call(
        binary,
        home.path(),
        &lanes[0],
        true,
        &serde_json::to_value(lanes[0].event(&attempts[0], true)).unwrap(),
    ));
    lanes[0].handled(&attempts[0]);
    lanes[2].pending(&attempts[2]);
    assert!(lanes[2].claim(&registry, 2400).is_none());
    ok(call(
        binary,
        home.path(),
        &lanes[2],
        true,
        &serde_json::to_value(lanes[2].event(&attempts[2], true)).unwrap(),
    ));

    for (index, lane) in lanes.iter().enumerate() {
        lane.handled(&attempts[index]);
        let finished = serde_json::to_value(lane.event(&attempts[index], true)).unwrap();
        let bytes = lane.bytes();
        let replay = ok(call(binary, home.path(), lane, true, &finished));
        assert_eq!(replay["replayed"], true);
        assert_eq!(replay["session_id"], json!(lane.session));
        assert_eq!(replay["event_id"], "shared-finished");
        assert_eq!(lane.bytes(), bytes);
        // Late start facts are accepted as redundant, never regress completion.
        let late = ok(call(
            binary,
            home.path(),
            lane,
            true,
            &serde_json::to_value(lane.event(&attempts[index], false)).unwrap(),
        ));
        assert_eq!(late["durable_effect"], false);
        lane.handled(&attempts[index]);
        let next = lane.claim(&registry, 2500 + index as u64).unwrap();
        assert_ne!(next.input_id, attempts[index].input_id);
        assert_eq!(next.binding_generation, lane.generation);
        let saved = lane.saved();
        assert_eq!(saved.inputs.0[&next.input_id].seq.value(), 2);
        assert_eq!(
            saved
                .inputs
                .0
                .values()
                .filter(|i| i.active_attempt_id.is_some())
                .count(),
            1
        );
        assert!(lane.claim(&registry, 2600 + index as u64).is_none());
    }
}

fn owner_call(binary: &str, home: &Path, lane: &Lane, command: &OwnerCommand) -> Value {
    let (noun, verb) = match command {
        OwnerCommand::InputResolve { .. } => ("input", "resolve"),
        OwnerCommand::BindingResume { .. } => ("binding", "resume"),
        _ => unreachable!("this fixture only resolves and resumes"),
    };
    let mut child = Command::new(binary)
        .args([noun, verb, "--json-stdin"])
        .env("ARIADNE_HOME", home.join(".ariadne"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let request = OwnerMutationRequest {
        session: Some(SessionRef {
            project_id: lane.project.clone(),
            session_id: lane.session.clone(),
        }),
        command: command.clone(),
    };
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&request).unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.stderr.is_empty(), "{output:?}");
    let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        output.status.success(),
        envelope["ok"] == true,
        "{envelope}"
    );
    envelope
}

#[test]
fn installed_cli_repairs_a_missing_result_without_repeating_original_work() {
    let binary = env!("CARGO_BIN_EXE_ariadne");
    let home = tempfile::tempdir_in("/tmp").unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    registry.register(root.path(), &id(800), || id(1)).unwrap();
    let lane = Lane {
        root: registry.project_dir(&id(1)),
        project: id(1),
        session: id(2),
        binding: id(3),
        generation: id(4),
        topic: id(5),
        name: "repair_lane".into(),
    };
    let seed: Session =
        serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json")).unwrap();
    lane.store().create(&seed).unwrap();
    let blocked_claim = |request| {
        let before = lane.bytes();
        let result = DeliveryService::new(&registry).claim(
            &ValidatedDispatchContext::from_trusted_current_lease(
                lane.route(),
                lane.binding.clone(),
                lane.generation.clone(),
            ),
            &ClaimRequest {
                binding_id: lane.binding.clone(),
                generation: lane.generation.clone(),
                request_id: id(request),
            },
            || panic!("blocked claim must not allocate an attempt"),
            at(),
        );
        assert!(
            matches!(result, Err(ariadne_core::delivery::DeliveryError::Core(error))
            if error.code == CoreErrorCode::InvalidTransition)
        );
        assert_eq!(lane.bytes(), before);
    };
    for number in 0..2 {
        InputService::new(&registry)
            .execute(
                &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(lane.route())),
                &OwnerCommand::InputSubmit {
                    api_version: SchemaVersion::new(1).unwrap(),
                    op_id: id(1000 + number),
                    params: InputSubmitParams {
                        binding_id: lane.binding.clone(),
                        target: InputTarget {
                            topic_id: lane.topic.clone(),
                            item_id: Some(ItemRef::new("1").unwrap()),
                        },
                        kind: InputKind::Reply,
                        text: format!("ORIGINAL OWNER ACTION {number}"),
                        selected_option_id: None,
                        expected_question_revision: None,
                        supersedes_answer_id: None,
                    },
                },
                || UuidV4::new(uuid::Uuid::new_v4().to_string()).unwrap(),
                at(),
            )
            .unwrap();
    }
    let work = lane.claim(&registry, 2000).unwrap();
    let original_input = lane.saved().inputs.0[&work.input_id].clone();
    // The original agent explicitly published a reply but omitted input_result.
    let mut effects = lane.result(&work);
    effects["input_result"] = Value::Null;
    ok(call(binary, home.path(), &lane, false, &effects));
    let original_reply = lane
        .saved()
        .messages
        .iter()
        .find(|message| message.kind == MessageKind::Reply)
        .unwrap()
        .clone();
    ok(call(
        binary,
        home.path(),
        &lane,
        true,
        &serde_json::to_value(lane.event(&work, true)).unwrap(),
    ));
    DeliveryService::new(&registry)
        .expire_missing_result(
            &AdapterContext::from_trusted_entrypoint(
                lane.route(),
                lane.binding.clone(),
                lane.generation.clone(),
                None,
            ),
            &work.input_id,
            &work.attempt_id,
            &id(2001),
            UtcMillis::new("2026-10-04T12:00:06.000Z").unwrap(),
        )
        .unwrap()
        .unwrap();
    let missing = lane.saved();
    assert_eq!(
        missing.inputs.0[&work.input_id].state,
        InputState::NeedsAttention
    );
    assert_eq!(
        missing.inputs.0[&work.input_id].attempts[0].result_state,
        ResultState::Missing
    );
    assert_eq!(
        missing.bindings.0[&lane.binding].pause_reason,
        Some(PauseReason::ResultMissing)
    );
    blocked_claim(2002);

    let mut resolve = OwnerCommand::InputResolve {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(2003),
        params: InputResolveParams {
            input_id: work.input_id.clone(),
            attempt_id: work.attempt_id.clone(),
            decision: ResolutionKind::RequestResultRepair,
            reason: "Original work completed; request only its missing structured result.".into(),
            expected_revision: missing.revision,
            evidence: None,
        },
    };
    // Successful old work is not proof that the host is currently idle.
    let before = lane.bytes();
    assert_eq!(
        owner_call(binary, home.path(), &lane, &resolve)["error"]["code"],
        "delivery_uncertain"
    );
    assert_eq!(lane.bytes(), before);
    let OwnerCommand::InputResolve { params, .. } = &mut resolve else {
        unreachable!()
    };
    params.evidence = Some(OwnerResolutionEvidence {
        source: OwnerEvidenceSource::OwnerAttestation,
        turn_state: TurnState::Unknown,
        host_turn_id: None,
        owner_attested_idle: true,
        at: at(),
    });
    let evidence = params.evidence.clone();
    let receipt = ok(owner_call(binary, home.path(), &lane, &resolve));
    let prepared = lane.saved();
    let input = &prepared.inputs.0[&work.input_id];
    assert_eq!(input.payload, original_input.payload);
    assert_eq!(input.seq, original_input.seq);
    assert_eq!(input.state, InputState::Queued);
    assert_eq!(input.resolution_history.len(), 1);
    assert_eq!(
        input.resolution_history[0].kind,
        ResolutionKind::RequestResultRepair
    );
    assert_eq!(input.resolution_history[0].evidence, evidence);
    assert!(input.attempts[0].sealed_at.is_some());
    assert!(prepared.bindings.0[&lane.binding].owner_paused);
    blocked_claim(2004);
    let before = lane.bytes();
    assert_eq!(
        ok(owner_call(binary, home.path(), &lane, &resolve)),
        receipt
    );
    assert_eq!(lane.bytes(), before);

    ok(owner_call(
        binary,
        home.path(),
        &lane,
        &OwnerCommand::BindingResume {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(2005),
            params: BindingStateParams {
                binding_id: lane.binding.clone(),
                expected_generation: lane.generation.clone(),
            },
        },
    ));
    let repair = lane.claim(&registry, 2006).unwrap();
    assert_eq!(repair.input_id, work.input_id);
    assert_ne!(repair.attempt_id, work.attempt_id);
    let repairing = lane.saved();
    let repair_attempt = &repairing.inputs.0[&work.input_id].attempts[1];
    assert_eq!(repair_attempt.purpose, AttemptPurpose::ResultRepair);
    assert_eq!(
        repair_attempt.repair_for_attempt_id,
        Some(work.attempt_id.clone())
    );
    assert!(repair.formatted_payload.contains("result-only"));
    assert!(repair
        .formatted_payload
        .contains(original_reply.id.as_str()));
    assert!(!repair
        .formatted_payload
        .contains(&original_input.payload.text));
    assert!(lane.claim(&registry, 2007).is_none());
    // Return only the structured result referencing the already committed reply.
    let mut result = lane.result(&repair);
    result["op_id"] = json!(id(901));
    result["operations"] = json!([]);
    result["expected_item_revisions"] = json!({});
    result["input_result"]["reply_refs"] = json!([{"id": original_reply.id}]);
    let result_receipt = ok(call(binary, home.path(), &lane, false, &result));
    assert_eq!(
        lane.saved().inputs.0[&work.input_id].state,
        InputState::InFlight
    );
    assert!(lane.claim(&registry, 2008).is_none());
    let before = lane.bytes();
    assert_eq!(
        ok(call(binary, home.path(), &lane, false, &result)),
        result_receipt
    );
    assert_eq!(lane.bytes(), before);
    let mut completion = lane.event(&repair, true);
    completion.event_id = "repair-completed".into();
    completion.host_turn_id = Some("repair-host-turn".into());
    ok(call(
        binary,
        home.path(),
        &lane,
        true,
        &serde_json::to_value(&completion).unwrap(),
    ));
    let done = lane.saved();
    let input = &done.inputs.0[&work.input_id];
    assert_eq!(input.state, InputState::Handled);
    assert_eq!(input.attempts.len(), 2);
    assert_eq!(input.attempts[0].result_state, ResultState::Missing);
    assert_eq!(input.attempts[1].result_state, ResultState::Committed);
    assert_eq!(input.attempts[1].turn_state, TurnState::Completed);
    assert!(input.attempts[1].sealed_at.is_some());
    let replies: Vec<_> = done
        .messages
        .iter()
        .filter(|m| m.kind == MessageKind::Reply)
        .collect();
    assert_eq!(
        replies,
        vec![&original_reply],
        "repair must retain exactly the original explicit reply"
    );
    let successor = lane.claim(&registry, 2009).unwrap();
    assert_ne!(successor.input_id, work.input_id);
    assert_eq!(lane.saved().inputs.0[&successor.input_id].seq.value(), 2);
    assert!(lane.claim(&registry, 2010).is_none());
}
