use ariadne_agent_protocol::{EventPayload, NormalizedEvent, TurnFinishedStatus};
use ariadne_core::{
    apply::ApplyService,
    bindings::BindingService,
    delivery::{DeliveryError, DeliveryService, AGENT_QUERY_TOOLS},
    inputs::InputService,
    recovery::{RecoveryError, RecoveryObservation, RecoveryService},
    *,
};
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
use std::{
    fs,
    sync::atomic::{AtomicU64, Ordering},
};
use tempfile::TempDir;
/// Project store directory under a data-root home, as `Registry::project_dir` derives it.
fn store_dir(home: &std::path::Path, project: u64) -> std::path::PathBuf {
    home.join(".ariadne/projects").join(id(project).as_str())
}
fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn at(s: &str) -> UtcMillis {
    UtcMillis::new(format!("2026-10-04T12:00:{s}.000Z")).unwrap()
}
fn route() -> RegisteredSession {
    RegisteredSession::from_trusted_entrypoint(id(1), id(2))
}
struct Setup {
    _home: TempDir,
    _root: TempDir,
    registry: Registry,
    next: AtomicU64,
}
impl Setup {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        registry.register(root.path(), &id(99), || id(1)).unwrap();
        let s: Session =
            serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json"))
                .unwrap();
        Store::open_registered(&store_dir(home.path(), 1), id(1))
            .unwrap()
            .create(&s)
            .unwrap();
        Self {
            _home: home,
            _root: root,
            registry,
            next: AtomicU64::new(10000),
        }
    }
    fn uuid(&self) -> UuidV4 {
        id(self.next.fetch_add(1, Ordering::SeqCst))
    }
    fn store(&self) -> Store {
        Store::open_registered(&store_dir(self._home.path(), 1), id(1)).unwrap()
    }
    fn saved(&self) -> Session {
        self.store().read(&id(2)).unwrap()
    }
    fn bytes(&self) -> Vec<u8> {
        fs::read(
            store_dir(self._home.path(), 1)
                .join("sessions")
                .join(format!("{}.json", id(2).as_str())),
        )
        .unwrap()
    }
    fn context(&self) -> AdapterContext {
        AdapterContext::from_trusted_entrypoint(
            route(),
            id(3),
            self.saved().bindings.0[&id(3)].generation.clone(),
            None,
        )
    }
    fn lease(&self) -> ValidatedDispatchContext {
        ValidatedDispatchContext::from_trusted_current_lease(
            route(),
            id(3),
            self.saved().bindings.0[&id(3)].generation.clone(),
        )
    }
    fn queue(&self, n: u64) -> UuidV4 {
        self.queue_text(n, &format!("Exact owner text {n} \n"))
    }
    fn queue_text(&self, n: u64, text: &str) -> UuidV4 {
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
                text: text.into(),
                selected_option_id: None,
                expected_question_revision: None,
                supersedes_answer_id: None,
            },
        };
        let receipt = InputService::new(&self.registry)
            .execute(
                &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(route())),
                &command,
                || self.uuid(),
                at("00"),
            )
            .unwrap();
        let MutationReceipt::Session(receipt) = receipt else {
            panic!()
        };
        let SavedReceiptData::InputSubmit { input_id, .. } = receipt.data else {
            panic!()
        };
        input_id
    }
    fn request(&self, n: u64) -> ClaimRequest {
        ClaimRequest {
            binding_id: id(3),
            generation: self.saved().bindings.0[&id(3)].generation.clone(),
            request_id: id(n),
        }
    }
    fn claim(&self, n: u64) -> PreparedAttempt {
        DeliveryService::new(&self.registry)
            .claim(&self.lease(), &self.request(n), || self.uuid(), at("00"))
            .unwrap()
            .unwrap()
    }
    fn event(&self, p: &PreparedAttempt, name: &str, payload: EventPayload) -> NormalizedEvent {
        NormalizedEvent {
            event_id: name.into(),
            binding_id: id(3),
            generation: p.binding_generation.clone(),
            input_id: Some(p.input_id.clone()),
            attempt_id: Some(p.attempt_id.clone()),
            host_turn_id: matches!(
                payload,
                EventPayload::TurnStarted {}
                    | EventPayload::TurnFinished { .. }
                    | EventPayload::VisibleOutput { .. }
            )
            .then(|| "opaque/turn✓".into()),
            observed_at: at("01"),
            event: payload,
        }
    }
    fn report(&self, e: &NormalizedEvent) -> Result<EventReceipt, DeliveryError> {
        DeliveryService::new(&self.registry).report(&self.context(), e, || self.uuid())
    }
    fn write(&self, work: impl FnOnce(&mut Session)) {
        let op = self.uuid();
        self.store()
            .transact(
                &id(2),
                &ReceiptActorScope::Owner {},
                &op,
                &serde_json::json!({"test":op}),
                |s| {
                    work(s);
                    Ok::<_, ()>(SavedReceiptData::BindingState {
                        binding_id: id(3),
                        generation: s.bindings.0[&id(3)].generation.clone(),
                        dispatch_state: s.bindings.0[&id(3)].dispatch_state.clone(),
                        owner_paused: s.bindings.0[&id(3)].owner_paused,
                        pause_reason: s.bindings.0[&id(3)].pause_reason.clone(),
                        connection_state: s.bindings.0[&id(3)].connection_state.clone(),
                    })
                },
            )
            .unwrap();
    }
    fn result(&self, p: &PreparedAttempt, n: u64) {
        self.publish(p, n, true);
    }
    fn publish(&self, p: &PreparedAttempt, n: u64, with_result: bool) {
        self.publish_effects(p, n, with_result, false);
    }
    fn publish_effects(&self, p: &PreparedAttempt, n: u64, with_result: bool, child: bool) {
        let s = self.saved();
        let owner = s
            .messages
            .iter()
            .find(|m| m.id == s.inputs.0[&p.input_id].message_id)
            .unwrap();
        let context = AgentContext::from_trusted_entrypoint(
            route(),
            id(3),
            p.binding_generation.clone(),
            AgentReadScope::Dispatched {
                source_input_id: p.input_id.clone(),
                attempt_id: p.attempt_id.clone(),
                issued_through_message_number: NonnegativeSafeInteger::new(owner.number.value())
                    .unwrap(),
            },
        );
        let mut request = ApplyRequest {
            op_id: id(n),
            source_input_id: Some(p.input_id.clone()),
            attempt_id: Some(p.attempt_id.clone()),
            expected_item_revisions: UniqueMap(std::collections::BTreeMap::from([(
                ItemRef::new("1").unwrap(),
                s.items.0[&ItemRef::new("1").unwrap()].revision,
            )])),
            expected_topic_revisions: UniqueMap(Default::default()),
            summary: String::new(),
            operations: vec![Operation::Reply {
                r#ref: RequestRef::new("result_reply").unwrap(),
                item: EntityRef::Existing(ExistingRef {
                    id: ItemRef::new("1").unwrap(),
                }),
                text: "Explicit result explanation.".into(),
                round_id: None,
            }],
            input_result: with_result.then(|| ResultDraft {
                outcome: ResultOutcome::Deferred,
                explanation: "Explicit result with its complete durable reply.".into(),
                reply_refs: vec![UuidRef::Local(LocalRef {
                    r#ref: RequestRef::new("result_reply").unwrap(),
                })],
                followup_item_refs: vec![],
                handled_through_message_number: owner.number,
            }),
        };
        if child {
            request
                .operations
                .push(Operation::ItemAdd(Box::new(ItemAddOperation {
                    r#ref: RequestRef::new("followup").unwrap(),
                    topic: UuidRef::Existing(ExistingUuidRef { id: id(5) }),
                    parent: Some(EntityRef::Existing(ExistingRef {
                        id: ItemRef::new("1").unwrap(),
                    })),
                    question: "Review original durable child?".into(),
                    item_type: ItemType::Question,
                    status: ItemStatus::Open,
                    owner: ItemOwner::Agent { binding_id: id(3) },
                    ask: None,
                    options: Some(vec![]),
                    note: None,
                    links: None,
                    outcome: None,
                    why: None,
                    replaced_by: None,
                    source_round_id: None,
                })));
        }
        ApplyService::new(&self.registry)
            .execute(&context, &request, || self.uuid(), at("06"))
            .unwrap();
    }
    fn expire(
        &self,
        p: &PreparedAttempt,
        n: u64,
        time: UtcMillis,
    ) -> Result<Option<SavedReceipt>, DeliveryError> {
        DeliveryService::new(&self.registry).expire_missing_result(
            &self.context(),
            &p.input_id,
            &p.attempt_id,
            &id(n),
            time,
        )
    }
}
fn completed() -> EventPayload {
    EventPayload::TurnFinished {
        status: TurnFinishedStatus::Completed,
        reason: None,
        diagnostic_text: None,
        truncated: false,
    }
}
fn owner() -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Session(route()))
}
fn evidence() -> OwnerResolutionEvidence {
    OwnerResolutionEvidence {
        source: OwnerEvidenceSource::OwnerAttestation,
        turn_state: TurnState::Unknown,
        host_turn_id: None,
        owner_attested_idle: true,
        at: at("07"),
    }
}
fn command(
    s: &Setup,
    p: &PreparedAttempt,
    n: u64,
    decision: ResolutionKind,
    attest: bool,
) -> OwnerCommand {
    OwnerCommand::InputResolve {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(n),
        params: InputResolveParams {
            input_id: p.input_id.clone(),
            attempt_id: p.attempt_id.clone(),
            decision,
            reason: "Deliberate recovery after reviewing original effects.".into(),
            expected_revision: s.saved().revision,
            evidence: attest.then(evidence),
        },
    }
}
fn execute(
    s: &Setup,
    c: &OwnerCommand,
    presence: Option<&RecoveryObservation>,
) -> Result<MutationReceipt, RecoveryError> {
    RecoveryService::new(&s.registry).execute(&owner(), c, presence, at("08"))
}
fn code(e: RecoveryError) -> CoreErrorCode {
    let RecoveryError::Core(e) = e else {
        panic!("unexpected native cause {e:?}")
    };
    e.code
}
fn presence(s: &Setup, state: ExecutionState) -> RecoveryObservation {
    RecoveryObservation {
        binding_id: id(3),
        instance_id: id(800),
        observation: PresenceObservation {
            instance_id: id(800),
            generation: s.saved().bindings.0[&id(3)].generation.clone(),
            connection_state: ConnectionState::Connected,
            execution_state: state,
            last_seen_at: Some(at("07")),
            source: Some(PresenceSource::HostPoll),
            process_identity: None,
            freshness: Freshness::Fresh,
        },
    }
}
fn resume(s: &Setup, n: u64) {
    let c = OwnerCommand::BindingResume {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(n),
        params: BindingStateParams {
            binding_id: id(3),
            expected_generation: s.saved().bindings.0[&id(3)].generation.clone(),
        },
    };
    BindingService::new(&s.registry)
        .state(&owner(), &c, at("09"))
        .unwrap();
}

#[test]
fn proven_retry_preserves_fifo_history_and_requires_resume_with_exact_old_replay() {
    let s = Setup::new();
    let first = s.queue(100);
    s.queue(101);
    let p = s.claim(102);
    s.report(&s.event(
        &p,
        "reject",
        EventPayload::Rejected {
            reason: "proven before delivery".into(),
        },
    ))
    .unwrap();
    let before = s.saved();
    let c = command(&s, &p, 103, ResolutionKind::RetryUnexecuted, true);
    let receipt = execute(&s, &c, None).unwrap();
    let queued = s.saved();
    let i = &queued.inputs.0[&first];
    assert_eq!(i.state, InputState::Queued);
    assert_eq!(i.seq, before.inputs.0[&first].seq);
    assert_eq!(i.payload, before.inputs.0[&first].payload);
    assert_eq!(queued.messages, before.messages);
    assert_eq!(queued.answers, before.answers);
    assert_eq!(queued.items, before.items);
    let mut old = before.inputs.0[&first].attempts[0].clone();
    old.sealed_at = Some(at("08"));
    assert_eq!(i.attempts[0], old);
    assert!(i.active_attempt_id.is_none());
    assert!(queued.bindings.0[&id(3)].owner_paused);
    assert_eq!(
        queued.bindings.0[&id(3)].dispatch_state,
        DispatchState::Paused
    );
    assert!(DeliveryService::new(&s.registry)
        .claim(&s.lease(), &s.request(104), || s.uuid(), at("09"))
        .is_err());
    let bytes = s.bytes();
    assert_eq!(
        execute(&s, &c, Some(&presence(&s, ExecutionState::Running))).unwrap(),
        receipt
    );
    assert_eq!(s.bytes(), bytes);
    assert_eq!(
        DeliveryService::new(&s.registry)
            .claim(
                &s.lease(),
                &s.request(102),
                || panic!("replay allocated"),
                at("09")
            )
            .unwrap()
            .unwrap(),
        p
    );
    resume(&s, 105);
    let next = s.claim(106);
    assert_eq!(next.input_id, first);
    assert_ne!(next.attempt_id, p.attempt_id);
    assert_eq!(
        s.saved().inputs.0[&first].attempts[1].purpose,
        AttemptPurpose::Work
    );
}

#[test]
fn running_and_approval_block_every_resolution_even_with_owner_attestation() {
    for state in [ExecutionState::Running, ExecutionState::WaitingForApproval] {
        for decision in [
            ResolutionKind::RetryUnexecuted,
            ResolutionKind::Resend,
            ResolutionKind::Skip,
            ResolutionKind::RequestResultRepair,
            ResolutionKind::ConfirmEvidence,
        ] {
            let s = Setup::new();
            s.queue(110);
            let p = s.claim(111);
            let c = command(&s, &p, 112, decision, true);
            let bytes = s.bytes();
            assert_eq!(
                code(execute(&s, &c, Some(&presence(&s, state.clone()))).unwrap_err()),
                CoreErrorCode::InvalidTransition
            );
            assert_eq!(s.bytes(), bytes);
        }
    }
}

#[test]
fn only_qualified_current_fresh_idle_proves_liveness_and_prior_attestation_is_not_reused() {
    let s = Setup::new();
    s.queue(120);
    let p = s.claim(121);
    let c = command(&s, &p, 122, ResolutionKind::Resend, false);
    let bytes = s.bytes();
    assert_eq!(
        code(execute(&s, &c, None).unwrap_err()),
        CoreErrorCode::DeliveryUncertain
    );
    assert_eq!(s.bytes(), bytes);
    let idle = presence(&s, ExecutionState::Idle);
    for mutate in [0, 1, 2, 3, 4, 5, 6] {
        let mut observed = idle.clone();
        match mutate {
            0 => observed.binding_id = id(999),
            1 => observed.instance_id = id(999),
            2 => observed.observation.generation = id(999),
            3 => observed.observation.freshness = Freshness::Stale,
            4 => observed.observation.source = Some(PresenceSource::ProcessHint),
            5 => observed.observation.last_seen_at = None,
            _ => observed.observation.connection_state = ConnectionState::Unknown,
        }
        assert_eq!(
            code(execute(&s, &c, Some(&observed)).unwrap_err()),
            CoreErrorCode::DeliveryUncertain
        );
        assert_eq!(s.bytes(), bytes);
    }
    execute(&s, &c, Some(&idle)).unwrap();
    resume(&s, 123);
    let next = s.claim(124);
    let c = command(&s, &next, 125, ResolutionKind::Skip, false);
    assert_eq!(
        code(execute(&s, &c, None).unwrap_err()),
        CoreErrorCode::DeliveryUncertain
    );
}

#[test]
fn confirm_is_attribution_only_and_historical_running_can_be_skipped_without_rewriting_turn() {
    let s = Setup::new();
    s.queue(130);
    let p = s.claim(131);
    s.report(&s.event(&p, "running", EventPayload::TurnStarted {}))
        .unwrap();
    let before = s.saved();
    let c = command(&s, &p, 132, ResolutionKind::ConfirmEvidence, true);
    execute(&s, &c, None).unwrap();
    let confirmed = s.saved();
    assert_eq!(
        confirmed.inputs.0[&p.input_id].attempts,
        before.inputs.0[&p.input_id].attempts
    );
    assert_eq!(confirmed.inputs.0[&p.input_id].state, InputState::InFlight);
    assert_eq!(confirmed.bindings, before.bindings);
    assert_eq!(confirmed.messages, before.messages);
    let repair = command(&s, &p, 133, ResolutionKind::RequestResultRepair, true);
    assert_eq!(
        code(execute(&s, &repair, None).unwrap_err()),
        CoreErrorCode::InvalidTransition
    );
    execute(&s, &command(&s, &p, 134, ResolutionKind::Skip, true), None).unwrap();
    let skipped = s.saved();
    let attempt = &skipped.inputs.0[&p.input_id].attempts[0];
    assert_eq!(attempt.turn_state, TurnState::Running);
    assert_eq!(skipped.inputs.0[&p.input_id].state, InputState::Skipped);
    assert!(attempt.sealed_at.is_some());
    assert_eq!(skipped.messages, before.messages);
}

#[test]
fn uncertain_is_not_proven_retry_and_unrelated_barriers_are_retained() {
    let s = Setup::new();
    s.queue(140);
    let p = s.claim(141);
    s.report(&s.event(
        &p,
        "uncertain",
        EventPayload::Uncertain {
            reason: "timeout may have submitted".into(),
        },
    ))
    .unwrap();
    let bytes = s.bytes();
    assert_eq!(
        code(
            execute(
                &s,
                &command(&s, &p, 142, ResolutionKind::RetryUnexecuted, true),
                None
            )
            .unwrap_err()
        ),
        CoreErrorCode::DeliveryUncertain
    );
    assert_eq!(s.bytes(), bytes);
    s.write(|session| {
        session.bindings.0.get_mut(&id(3)).unwrap().pause_reason = Some(PauseReason::StoreError);
    });
    execute(
        &s,
        &command(&s, &p, 143, ResolutionKind::Resend, true),
        None,
    )
    .unwrap();
    assert_eq!(
        s.saved().bindings.0[&id(3)].pause_reason,
        Some(PauseReason::StoreError)
    );
    let c = OwnerCommand::BindingResume {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(144),
        params: BindingStateParams {
            binding_id: id(3),
            expected_generation: p.binding_generation,
        },
    };
    assert!(BindingService::new(&s.registry)
        .state(&owner(), &c, at("09"))
        .is_err());
}

fn envelope(prepared: &PreparedAttempt) -> serde_json::Value {
    serde_json::from_str(prepared.formatted_payload.split_once('\n').unwrap().1).unwrap()
}

#[test]
fn work_envelope_carries_attempt_id_and_names_only_real_query_tools() {
    let s = Setup::new();
    let input = s.queue_text(170, "work");
    let p = s.claim(171);
    let body = envelope(&p);
    assert_eq!(body["attempt_id"], p.attempt_id.as_str());
    assert_eq!(body["source_input_id"], input.as_str());
    assert!(p
        .wire_marker
        .ends_with(&format!(":{}]", body["attempt_id"].as_str().unwrap())));
    let tools: Vec<&str> = body["tools"]["queries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|name| name.as_str().unwrap())
        .collect();
    assert_eq!(tools, AGENT_QUERY_TOOLS);
    let manifest: serde_json::Value = serde_json::from_str(include_str!(
        "../../../contracts/generated/core/mcp-tools.json"
    ))
    .unwrap();
    let real: Vec<&str> = manifest["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    for name in tools
        .iter()
        .chain([&body["tools"]["mutation"].as_str().unwrap()])
    {
        assert!(real.contains(name), "envelope names unknown tool {name}");
    }
}

#[test]
fn repair_claim_is_result_only_and_repeated_repair_keeps_original_effect_references() {
    let s = Setup::new();
    let text = "ORIGINAL ACTION MUST NOT BE RESENT";
    let input = s.queue_text(150, text);
    let p = s.claim(151);
    s.publish_effects(&p, 152, false, true);
    s.report(&s.event(&p, "complete-original", completed()))
        .unwrap();
    s.expire(&p, 153, at("07")).unwrap();
    execute(
        &s,
        &command(&s, &p, 154, ResolutionKind::RequestResultRepair, true),
        None,
    )
    .unwrap();
    resume(&s, 155);
    let repair = s.claim(156);
    let one = s.saved();
    let a = &one.inputs.0[&input].attempts[1];
    assert_eq!(a.purpose, AttemptPurpose::ResultRepair);
    assert_eq!(a.repair_for_attempt_id, Some(p.attempt_id.clone()));
    assert!(!repair.formatted_payload.contains(text));
    assert!(repair.formatted_payload.contains("result-only"));
    assert_eq!(
        envelope(&repair)["attempt_id"],
        repair.attempt_id.as_str(),
        "repair envelope carries its own attempt id"
    );
    let original_reply = one
        .messages
        .iter()
        .find(|m| m.attempt_id.as_ref() == Some(&p.attempt_id) && m.kind == MessageKind::Reply)
        .unwrap()
        .id
        .clone();
    assert!(repair.formatted_payload.contains(original_reply.as_str()));
    let original_child = ItemRef::new("1.1").unwrap();
    assert!(one.items.0.contains_key(&original_child));
    assert!(repair.formatted_payload.contains(original_child.as_str()));
    s.report(&s.event(&repair, "complete-repair", completed()))
        .unwrap();
    s.expire(&repair, 157, at("07")).unwrap();
    execute(
        &s,
        &command(&s, &repair, 158, ResolutionKind::RequestResultRepair, true),
        None,
    )
    .unwrap();
    resume(&s, 159);
    let repeat = s.claim(160);
    let saved = s.saved();
    let a = &saved.inputs.0[&input].attempts[2];
    assert_eq!(a.repair_for_attempt_id, Some(p.attempt_id.clone()));
    assert!(repeat.formatted_payload.contains(original_reply.as_str()));
    assert_eq!(saved.inputs.0[&input].payload.text, text);
    assert_eq!(
        DeliveryService::new(&s.registry)
            .claim(
                &s.lease(),
                &s.request(151),
                || panic!("replay allocated"),
                at("09")
            )
            .unwrap()
            .unwrap(),
        p
    );
    let message = saved
        .messages
        .iter()
        .find(|m| m.id == saved.inputs.0[&input].message_id)
        .unwrap();
    let actor = AgentContext::from_trusted_entrypoint(
        route(),
        id(3),
        repeat.binding_generation.clone(),
        AgentReadScope::Dispatched {
            source_input_id: input.clone(),
            attempt_id: repeat.attempt_id.clone(),
            issued_through_message_number: NonnegativeSafeInteger::new(message.number.value())
                .unwrap(),
        },
    );
    let request = ApplyRequest {
        op_id: id(161),
        source_input_id: Some(input.clone()),
        attempt_id: Some(repeat.attempt_id.clone()),
        expected_item_revisions: UniqueMap(Default::default()),
        expected_topic_revisions: UniqueMap(Default::default()),
        summary: String::new(),
        operations: vec![],
        input_result: Some(ResultDraft {
            outcome: ResultOutcome::Deferred,
            explanation: "Retained original effects, result only.".into(),
            reply_refs: vec![UuidRef::Existing(ExistingUuidRef { id: original_reply })],
            followup_item_refs: vec![EntityRef::Existing(ExistingRef { id: original_child })],
            handled_through_message_number: message.number,
        }),
    };
    ApplyService::new(&s.registry)
        .execute(&actor, &request, || s.uuid(), at("09"))
        .unwrap();
    assert_eq!(s.saved().inputs.0[&input].state, InputState::InFlight);
    s.report(&s.event(&repeat, "complete-repeat", completed()))
        .unwrap();
    assert_eq!(s.saved().inputs.0[&input].state, InputState::Handled);
}

#[test]
fn repair_reference_capacity_rejection_precedes_allocation_and_preserves_saved_input() {
    let s = Setup::new();
    let input = s.queue(270);
    let work = s.claim(271);
    s.publish(&work, 272, false);
    s.report(&s.event(&work, "reference-cap-completed", completed()))
        .unwrap();
    s.expire(&work, 273, at("07")).unwrap();
    s.write(|session| {
        let original = session
            .messages
            .iter()
            .find(|m| {
                m.kind == MessageKind::Activity && m.attempt_id.as_ref() == Some(&work.attempt_id)
            })
            .unwrap()
            .clone();
        for _ in 0..1800 {
            let mut m = original.clone();
            m.id = s.uuid();
            m.number = session.counters.next_message;
            session.counters.next_message = PositiveSafeInteger::new(m.number.value() + 1).unwrap();
            m.round_id = None;
            session.messages.push(m);
        }
    });
    execute(
        &s,
        &command(&s, &work, 274, ResolutionKind::RequestResultRepair, true),
        None,
    )
    .unwrap();
    resume(&s, 275);
    let before = s.bytes();
    let e = DeliveryService::new(&s.registry)
        .claim(
            &s.lease(),
            &s.request(276),
            || panic!("ordinary capacity failure allocated"),
            at("09"),
        )
        .unwrap_err();
    let DeliveryError::Core(e) = e else {
        panic!("wrong cause")
    };
    assert_eq!(e.code, CoreErrorCode::CapacityExceeded);
    assert_eq!(s.bytes(), before);
    assert_eq!(s.saved().inputs.0[&input].attempts.len(), 1);
}

#[test]
fn repair_requires_machine_completed_original_lineage_without_owner_fabrication() {
    let s = Setup::new();
    let input = s.queue(280);
    let work = s.claim(281);
    s.report(&s.event(&work, "lineage-original-completed", completed()))
        .unwrap();
    s.expire(&work, 282, at("07")).unwrap();
    execute(
        &s,
        &command(&s, &work, 283, ResolutionKind::RequestResultRepair, true),
        None,
    )
    .unwrap();
    resume(&s, 284);
    let repair = s.claim(285);
    s.report(&s.event(&repair, "lineage-repair-completed", completed()))
        .unwrap();
    s.expire(&repair, 286, at("07")).unwrap();
    // Structurally retained historical data may lack completed original work.
    // Recovery cannot replace that machine fact with an owner attestation.
    s.write(|session| {
        session.inputs.0.get_mut(&input).unwrap().attempts[0].turn_state = TurnState::Unknown
    });
    let bytes = s.bytes();
    assert_eq!(
        code(
            execute(
                &s,
                &command(&s, &repair, 287, ResolutionKind::RequestResultRepair, true),
                None
            )
            .unwrap_err()
        ),
        CoreErrorCode::InvalidTransition
    );
    assert_eq!(s.bytes(), bytes);
}

#[test]
fn rejected_and_uncertain_repair_preparations_never_repeat_the_original_action() {
    for (decision, event) in [
        (
            ResolutionKind::RetryUnexecuted,
            EventPayload::Rejected {
                reason: "not submitted".into(),
            },
        ),
        (
            ResolutionKind::Resend,
            EventPayload::Uncertain {
                reason: "call may have begun".into(),
            },
        ),
    ] {
        let s = Setup::new();
        let text = "ORIGINAL ACTION MUST NEVER BE REPEATED BY A REPAIR RETRY";
        let input = s.queue_text(260, text);
        let work = s.claim(261);
        s.report(&s.event(&work, "work-completed", completed()))
            .unwrap();
        s.expire(&work, 262, at("07")).unwrap();
        execute(
            &s,
            &command(&s, &work, 263, ResolutionKind::RequestResultRepair, true),
            None,
        )
        .unwrap();
        resume(&s, 264);
        let repair = s.claim(265);
        s.report(&s.event(&repair, "repair-not-delivered", event))
            .unwrap();
        let before = s.saved();
        let old = before.inputs.0[&input].attempts[1].clone();
        let c = command(&s, &repair, 266, decision, true);
        execute(&s, &c, None).unwrap();
        resume(&s, 267);
        let retry = s.claim(268);
        let saved = s.saved();
        let attempt = &saved.inputs.0[&input].attempts[2];
        assert_eq!(attempt.purpose, AttemptPurpose::ResultRepair);
        assert_eq!(attempt.repair_for_attempt_id, Some(work.attempt_id.clone()));
        assert!(retry.formatted_payload.contains("result-only"));
        assert!(!retry.formatted_payload.contains(text));
        let mut sealed = old;
        sealed.sealed_at = Some(at("08"));
        assert_eq!(saved.inputs.0[&input].attempts[1], sealed);
        assert_eq!(
            saved.inputs.0[&input].payload,
            before.inputs.0[&input].payload
        );
        assert_eq!(saved.inputs.0[&input].seq, before.inputs.0[&input].seq);
        let bytes = s.bytes();
        execute(&s, &c, Some(&presence(&s, ExecutionState::Running))).unwrap();
        assert_eq!(s.bytes(), bytes);
    }
}

#[test]
fn sealed_conflicts_require_each_exact_acknowledgement_and_new_conflicts_stay_blocked() {
    let s = Setup::new();
    s.queue(170);
    let p = s.claim(171);
    s.report(&s.event(&p, "first-complete", completed()))
        .unwrap();
    s.result(&p, 172);
    s.queue(173);
    let q = s.claim(174);
    s.report(&s.event(&q, "second-complete", completed()))
        .unwrap();
    s.result(&q, 175);
    let before = s.saved();
    let failed = || EventPayload::TurnFinished {
        status: TurnFinishedStatus::Failed,
        reason: Some("contradictory late failed fact".into()),
        diagnostic_text: None,
        truncated: false,
    };
    assert!(s.report(&s.event(&p, "late-first", failed())).is_err());
    assert!(s.report(&s.event(&q, "late-second", failed())).is_err());
    let first = command(&s, &p, 176, ResolutionKind::ConfirmEvidence, true);
    execute(&s, &first, None).unwrap();
    assert_eq!(
        s.saved().bindings.0[&id(3)].pause_reason,
        Some(PauseReason::Uncertain)
    );
    let second = command(&s, &q, 177, ResolutionKind::ConfirmEvidence, true);
    let receipt = execute(&s, &second, None).unwrap();
    let ack = s.saved();
    assert_eq!(ack.bindings.0[&id(3)].pause_reason, None);
    assert!(ack.bindings.0[&id(3)].owner_paused);
    assert_eq!(ack.bindings.0[&id(3)].dispatch_state, DispatchState::Paused);
    for id in [&p.input_id, &q.input_id] {
        assert_eq!(ack.inputs.0[id].attempts, before.inputs.0[id].attempts);
        assert_eq!(ack.inputs.0[id].state, InputState::Handled);
        assert_eq!(ack.inputs.0[id].payload, before.inputs.0[id].payload);
    }
    assert_eq!(ack.messages, before.messages);
    assert_eq!(ack.items, before.items);
    assert!(s.report(&s.event(&q, "new-after-ack", failed())).is_err());
    let bytes = s.bytes();
    assert_eq!(execute(&s, &second, None).unwrap(), receipt);
    assert_eq!(s.bytes(), bytes);
    assert_eq!(
        s.saved().bindings.0[&id(3)].pause_reason,
        Some(PauseReason::Uncertain)
    );
    let mut stale = second.clone();
    if let OwnerCommand::InputResolve { op_id, .. } = &mut stale {
        *op_id = id(178);
    }
    assert_eq!(
        code(execute(&s, &stale, None).unwrap_err()),
        CoreErrorCode::RevisionConflict
    );
    assert_eq!(s.bytes(), bytes);
}

#[test]
fn unscoped_conflict_cannot_be_acknowledged_by_an_input_and_sealed_skip_is_rejected() {
    let s = Setup::new();
    s.queue(180);
    let p = s.claim(181);
    s.report(&s.event(&p, "completed", completed())).unwrap();
    s.result(&p, 182);
    s.write(|session| {
        let b = session.bindings.0.get_mut(&id(3)).unwrap();
        b.connection_state = ConnectionState::Disconnected;
        b.dispatch_state = DispatchState::Disconnected;
    });
    let b = s.saved().bindings.0[&id(3)].clone();
    let event = NormalizedEvent {
        event_id: "binding-fact".into(),
        binding_id: id(3),
        generation: b.generation.clone(),
        input_id: None,
        attempt_id: None,
        host_turn_id: None,
        observed_at: at("07"),
        event: EventPayload::Connected {
            external_session_id: b.external_session_id,
            endpoint_fingerprint: b.endpoint_fingerprint,
            capabilities: Box::new(b.capabilities),
        },
    };
    s.report(&event).unwrap();
    let mut changed = event;
    changed.event = EventPayload::Disconnected {
        reason: Some("changed fact same ID".into()),
    };
    assert!(s.report(&changed).is_err());
    execute(
        &s,
        &command(&s, &p, 183, ResolutionKind::ConfirmEvidence, true),
        None,
    )
    .unwrap();
    assert_eq!(
        s.saved().bindings.0[&id(3)].pause_reason,
        Some(PauseReason::Uncertain)
    );
    let bytes = s.bytes();
    assert_eq!(
        code(execute(&s, &command(&s, &p, 184, ResolutionKind::Skip, true), None).unwrap_err()),
        CoreErrorCode::InvalidTransition
    );
    assert_eq!(s.bytes(), bytes);
}

#[test]
fn changed_operation_and_cross_attempt_scope_never_commit_effects() {
    let s = Setup::new();
    s.queue(190);
    let p = s.claim(191);
    let c = command(&s, &p, 192, ResolutionKind::Skip, true);
    execute(&s, &c, None).unwrap();
    let bytes = s.bytes();
    let mut changed = c.clone();
    if let OwnerCommand::InputResolve { params, .. } = &mut changed {
        params.reason.push_str(" changed");
    }
    assert!(matches!(
        execute(&s, &changed, None),
        Err(RecoveryError::Store(
            ariadne_store::session::StoreError::OperationReused
        ))
    ));
    assert_eq!(s.bytes(), bytes);
    let mut missing = command(&s, &p, 193, ResolutionKind::ConfirmEvidence, true);
    if let OwnerCommand::InputResolve { params, .. } = &mut missing {
        params.attempt_id = id(999);
    }
    assert_eq!(
        code(execute(&s, &missing, None).unwrap_err()),
        CoreErrorCode::InvalidRef
    );
    assert_eq!(s.bytes(), bytes);
}

#[test]
fn recovery_writer_subprocess() {
    let Ok(home) = std::env::var("ARIADNE_RECOVERY_TEST_HOME") else {
        return;
    };
    let registry = Registry::open(std::path::Path::new(&home)).unwrap();
    let command: OwnerCommand = serde_json::from_slice(
        &fs::read(std::env::var("ARIADNE_RECOVERY_TEST_COMMAND").unwrap()).unwrap(),
    )
    .unwrap();
    fs::write(
        std::env::var("ARIADNE_RECOVERY_TEST_READY").unwrap(),
        b"ready",
    )
    .unwrap();
    let start = std::env::var("ARIADNE_RECOVERY_TEST_START").unwrap();
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !std::path::Path::new(&start).exists() {
        assert!(std::time::Instant::now() < until, "start deadline");
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let result = RecoveryService::new(&registry).execute(&owner(), &command, None, at("08"));
    let value = match result {
        Ok(_) => "saved",
        Err(RecoveryError::Core(e)) if e.code == CoreErrorCode::RevisionConflict => {
            "revision_conflict"
        }
        other => panic!("unexpected child result {other:?}"),
    };
    fs::write(
        std::env::var("ARIADNE_RECOVERY_TEST_RESULT").unwrap(),
        value,
    )
    .unwrap();
}
struct Writer(std::process::Child);
impl Drop for Writer {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}
#[test]
fn separate_process_recovery_writers_share_one_snapshot_without_lost_history() {
    let s = Setup::new();
    s.queue(210);
    let p = s.claim(211);
    let before = s.saved();
    let dir = tempfile::tempdir().unwrap();
    let start = dir.path().join("start");
    let mut writers = vec![];
    for n in 0..2 {
        let path = dir.path().join(format!("command-{n}"));
        fs::write(
            &path,
            serde_json::to_vec(&command(&s, &p, 212 + n, ResolutionKind::Skip, true)).unwrap(),
        )
        .unwrap();
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "recovery_writer_subprocess", "--nocapture"])
            .env("ARIADNE_RECOVERY_TEST_HOME", s._home.path())
            .env("ARIADNE_RECOVERY_TEST_COMMAND", path)
            .env(
                "ARIADNE_RECOVERY_TEST_READY",
                dir.path().join(format!("ready-{n}")),
            )
            .env("ARIADNE_RECOVERY_TEST_START", &start)
            .env(
                "ARIADNE_RECOVERY_TEST_RESULT",
                dir.path().join(format!("result-{n}")),
            )
            .spawn()
            .unwrap();
        writers.push(Writer(child));
    }
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !(0..2).all(|n| dir.path().join(format!("ready-{n}")).exists()) {
        for writer in &mut writers {
            assert!(
                writer.0.try_wait().unwrap().is_none(),
                "writer exited before readiness"
            );
        }
        assert!(
            std::time::Instant::now() < until,
            "writer readiness deadline"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    fs::write(start, b"go").unwrap();
    while writers
        .iter_mut()
        .any(|w| w.0.try_wait().unwrap().is_none())
    {
        assert!(
            std::time::Instant::now() < until,
            "writer completion deadline"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    for writer in &mut writers {
        assert!(writer.0.wait().unwrap().success());
    }
    let mut results: Vec<_> = (0..2)
        .map(|n| fs::read_to_string(dir.path().join(format!("result-{n}"))).unwrap())
        .collect();
    results.sort();
    assert_eq!(results, ["revision_conflict", "saved"]);
    let saved = s.saved();
    assert_eq!(saved.revision.value(), before.revision.value() + 1);
    assert_eq!(saved.inputs.0[&p.input_id].resolution_history.len(), 1);
    assert_eq!(saved.inputs.0[&p.input_id].state, InputState::Skipped);
}

#[test]
fn native_delegate_defaults_to_unknown_and_owner_scope_is_required() {
    let s = Setup::new();
    s.queue(220);
    let p = s.claim(221);
    let native = ariadne_core::native::NativeCoreService::new(
        Registry::open(s._home.path()).unwrap(),
        || id(999),
        || at("08"),
        |_| panic!("recovery must not verify a host"),
    );
    let c = command(&s, &p, 222, ResolutionKind::Resend, false);
    let bytes = s.bytes();
    assert_eq!(
        native.execute_owner(owner(), c).unwrap_err().code,
        CoreErrorCode::DeliveryUncertain
    );
    assert_eq!(s.bytes(), bytes);
    let c = command(&s, &p, 223, ResolutionKind::Resend, true);
    native.execute_owner(owner(), c.clone()).unwrap();
    assert_eq!(s.saved().inputs.0[&p.input_id].state, InputState::Queued);
    let wrong = OwnerContext::from_trusted_entrypoint(OwnerScope::Preferences);
    assert_eq!(
        code(
            RecoveryService::new(&s.registry)
                .execute(&wrong, &c, None, at("09"))
                .unwrap_err()
        ),
        CoreErrorCode::PermissionDenied
    );
}
