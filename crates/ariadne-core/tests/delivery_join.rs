use ariadne_agent_protocol::{
    claude_session_end_event_id, EventPayload, NormalizedEvent, TurnFinishedStatus,
};
use ariadne_core::{
    apply::ApplyService,
    delivery::{DeliveryError, DeliveryService},
    history_actions::HistoryActionService,
    inputs::InputService,
    recovery::RecoveryService,
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
    root: TempDir,
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
            root,
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
        self.try_result(p, n).unwrap();
    }
    fn resolve(&self, p: &PreparedAttempt, decision: ResolutionKind, n: u64) {
        let command = OwnerCommand::InputResolve {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(n),
            params: InputResolveParams {
                input_id: p.input_id.clone(),
                attempt_id: p.attempt_id.clone(),
                decision,
                reason: String::new(),
                expected_revision: self.saved().revision,
                evidence: Some(OwnerResolutionEvidence {
                    source: OwnerEvidenceSource::OwnerAttestation,
                    turn_state: TurnState::Unknown,
                    host_turn_id: None,
                    owner_attested_idle: true,
                    at: at("04"),
                }),
            },
        };
        RecoveryService::new(&self.registry)
            .execute(
                &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(route())),
                &command,
                None,
                at("05"),
            )
            .unwrap();
    }
    /// Reports a fact Core must answer with no effect and no saved receipt.
    fn ignored(&self, e: &NormalizedEvent) {
        let bytes = self.bytes();
        let receipt = DeliveryService::new(&self.registry)
            .report(&self.context(), e, || panic!("no allocation"))
            .unwrap_or_else(|error| panic!("{} was refused: {error:?}", e.event_id));
        assert!(!receipt.durable_effect, "{}", e.event_id);
        assert_eq!(bytes, self.bytes(), "{}", e.event_id);
    }
    fn try_result(
        &self,
        p: &PreparedAttempt,
        n: u64,
    ) -> Result<ApplyReceipt, ariadne_core::apply::ApplyError> {
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
        let request = ApplyRequest {
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
            input_result: Some(ResultDraft {
                outcome: ResultOutcome::Deferred,
                explanation: "Explicit result with its complete durable reply.".into(),
                reply_refs: vec![UuidRef::Local(LocalRef {
                    r#ref: RequestRef::new("result_reply").unwrap(),
                })],
                followup_item_refs: vec![],
                handled_through_message_number: owner.number,
            }),
        };
        ApplyService::new(&self.registry).execute(&context, &request, || self.uuid(), at("06"))
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
fn code(e: DeliveryError) -> CoreErrorCode {
    match e {
        DeliveryError::Core(e) => e.code,
        other => panic!("{other:?}"),
    }
}

#[test]
fn claim_persists_fifo_exact_payload_and_replays_before_generation_pause_guards() {
    let t = Setup::new();
    let first = t.queue(100);
    let second = t.queue(101);
    let request = t.request(200);
    let p = t.claim(200);
    assert_eq!(p.input_id, first);
    p.validate_for(&request).unwrap();
    let s = t.saved();
    assert_eq!(s.inputs.0[&first].state, InputState::InFlight);
    assert_eq!(s.inputs.0[&second].state, InputState::Queued);
    assert_eq!(
        s.inputs.0[&first].attempts[0].formatted_payload,
        p.formatted_payload
    );
    assert!(p.formatted_payload.contains("Exact owner text 100"));
    assert!(!p.formatted_payload.contains("Exact owner text 101"));
    assert_eq!(
        s.bindings.0[&id(3)].issued_through_message_number.value(),
        2
    );
    t.write(|s| {
        let b = s.bindings.0.get_mut(&id(3)).unwrap();
        b.generation = id(444);
        b.owner_paused = true;
        b.dispatch_state = DispatchState::Paused;
    });
    let bytes = t.bytes();
    let replay = DeliveryService::new(&t.registry)
        .claim(
            &t.lease(),
            &request,
            || panic!("replay allocates"),
            at("09"),
        )
        .unwrap()
        .unwrap();
    assert_eq!(replay, p);
    assert_eq!(bytes, t.bytes());
    assert_eq!(
        code(
            DeliveryService::new(&t.registry)
                .claim(&t.lease(), &t.request(201), || panic!(), at("09"))
                .unwrap_err()
        ),
        CoreErrorCode::InvalidTransition
    );
}
#[test]
fn healthy_no_work_and_active_claim_do_not_allocate_or_write() {
    let t = Setup::new();
    let bytes = t.bytes();
    assert!(DeliveryService::new(&t.registry)
        .claim(&t.lease(), &t.request(200), || panic!(), at("00"))
        .unwrap()
        .is_none());
    assert_eq!(bytes, t.bytes());
    t.queue(100);
    t.claim(201);
    let bytes = t.bytes();
    assert!(DeliveryService::new(&t.registry)
        .claim(&t.lease(), &t.request(202), || panic!(), at("01"))
        .unwrap()
        .is_none());
    assert_eq!(bytes, t.bytes());
}
#[test]
fn either_order_joins_once_without_item_status_changes_or_duplicate_next_claim() {
    for result_first in [true, false] {
        let t = Setup::new();
        t.queue(100);
        let next = t.queue(101);
        let p = t.claim(200);
        let items = t
            .saved()
            .items
            .0
            .into_iter()
            .map(|(id, i)| (id, i.status))
            .collect::<std::collections::BTreeMap<_, _>>();
        let e = t.event(&p, "completed", completed());
        if result_first {
            t.result(&p, 300);
            assert_eq!(t.saved().inputs.0[&p.input_id].state, InputState::InFlight);
            t.report(&e).unwrap();
        } else {
            t.report(&e).unwrap();
            assert_eq!(t.saved().inputs.0[&p.input_id].state, InputState::InFlight);
            t.result(&p, 300);
        }
        let saved = t.saved();
        let a = &saved.inputs.0[&p.input_id].attempts[0];
        assert!(a.sealed_at.is_some());
        assert_eq!(saved.inputs.0[&p.input_id].state, InputState::Handled);
        assert_eq!(
            saved
                .items
                .0
                .iter()
                .map(|(id, i)| (id.clone(), i.status.clone()))
                .collect::<std::collections::BTreeMap<_, _>>(),
            items
        );
        let bytes = t.bytes();
        assert!(t.report(&e).unwrap().replayed);
        assert_eq!(bytes, t.bytes());
        assert_eq!(t.claim(201).input_id, next);
    }
}
#[test]
fn late_acceptance_and_start_cannot_regress_completed_progress() {
    let t = Setup::new();
    t.queue(100);
    let p = t.claim(200);
    let e = t.event(&p, "completed", completed());
    t.report(&e).unwrap();
    let late = t.event(
        &p,
        "accepted-late",
        EventPayload::Accepted {
            receipt: Some(HostReceipt {
                provider_reference: "opaque/reference✓".into(),
                observed_at: at("02"),
            }),
        },
    );
    t.report(&late).unwrap();
    let started = t.event(&p, "started-late", EventPayload::TurnStarted {});
    let before = t.bytes();
    assert!(!t.report(&started).unwrap().durable_effect);
    assert_eq!(before, t.bytes());
    let s = t.saved();
    assert_eq!(
        s.inputs.0[&p.input_id].attempts[0].turn_state,
        TurnState::Completed
    );
    assert_eq!(
        s.inputs.0[&p.input_id].attempts[0].turn_observed_at,
        Some(at("01"))
    );
}
#[test]
fn observation_time_only_replays_original_receipt_and_saved_times() {
    let t = Setup::new();
    t.queue(100);
    let p = t.claim(200);
    let mut e = t.event(
        &p,
        "opaque:事实:accepted",
        EventPayload::Accepted {
            receipt: Some(HostReceipt {
                provider_reference: "native/✓".into(),
                observed_at: at("01"),
            }),
        },
    );
    let original = t.report(&e).unwrap();
    let bytes = t.bytes();
    e.observed_at = at("09");
    let EventPayload::Accepted {
        receipt: Some(ref mut r),
    } = e.event
    else {
        panic!()
    };
    r.observed_at = at("08");
    let replay = DeliveryService::new(&t.registry)
        .report(&t.context(), &e, || panic!("replay UUID"))
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(original.revision, replay.revision);
    assert_eq!(bytes, t.bytes());
}
#[test]
fn same_id_and_fresh_id_contradictions_are_atomic_and_replays_preserve_original() {
    for same in [true, false] {
        let t = Setup::new();
        t.queue(100);
        let p = t.claim(200);
        let good = t.event(&p, "turn-fact", completed());
        let original = t.report(&good).unwrap();
        let mut bad = good.clone();
        if !same {
            bad.event_id = "different-fact".into();
        }
        bad.event = EventPayload::TurnFinished {
            status: TurnFinishedStatus::Failed,
            reason: Some("conflicting terminal evidence".into()),
            diagnostic_text: None,
            truncated: false,
        };
        assert_eq!(
            code(t.report(&bad).unwrap_err()),
            CoreErrorCode::ProtocolConflict
        );
        let s = t.saved();
        assert_eq!(
            s.inputs.0[&p.input_id].attempts[0].turn_state,
            TurnState::Completed
        );
        assert_eq!(s.inputs.0[&p.input_id].state, InputState::NeedsAttention);
        assert_eq!(
            s.bindings.0[&id(3)].dispatch_state,
            DispatchState::RecoveryRequired
        );
        assert!(s
            .operation_receipts
            .0
            .values()
            .flatten()
            .any(|r| matches!(r.result.data, SavedReceiptData::EventConflict { .. })));
        let bytes = t.bytes();
        assert_eq!(
            code(
                DeliveryService::new(&t.registry)
                    .report(&t.context(), &bad, || panic!())
                    .unwrap_err()
            ),
            CoreErrorCode::ProtocolConflict
        );
        assert_eq!(t.bytes(), bytes);
        let replay = t.report(&good).unwrap();
        assert_eq!(replay.revision, original.revision);
        assert!(replay.replayed);
        assert_eq!(t.bytes(), bytes);
    }
}
#[test]
fn changed_incoming_ids_never_retarget_the_original_event_barrier() {
    let t = Setup::new();
    t.queue(100);
    let other = t.queue(101);
    let p = t.claim(200);
    let good = t.event(&p, "accepted", EventPayload::Accepted { receipt: None });
    t.report(&good).unwrap();
    let mut bad = good.clone();
    bad.input_id = Some(other.clone());
    bad.attempt_id = Some(id(909));
    assert_eq!(
        code(t.report(&bad).unwrap_err()),
        CoreErrorCode::ProtocolConflict
    );
    let s = t.saved();
    assert_eq!(s.inputs.0[&other].state, InputState::Queued);
    assert_eq!(s.inputs.0[&p.input_id].state, InputState::NeedsAttention);
}
#[test]
fn committed_result_wins_over_later_failure_interruption_or_doubt() {
    // Owner rule: a committed input_result handles the input whatever the host
    // reports about its turn afterwards; no barrier, dispatch carries on.
    for payload in [
        EventPayload::TurnFinished {
            status: TurnFinishedStatus::Failed,
            reason: Some("failed".into()),
            diagnostic_text: None,
            truncated: false,
        },
        EventPayload::TurnFinished {
            status: TurnFinishedStatus::Interrupted,
            reason: None,
            diagnostic_text: None,
            truncated: false,
        },
        EventPayload::Uncertain {
            reason: "maybe delivered".into(),
        },
    ] {
        let t = Setup::new();
        t.queue(100);
        let p = t.claim(200);
        t.result(&p, 300);
        assert_eq!(t.saved().inputs.0[&p.input_id].state, InputState::InFlight);
        t.report(&t.event(&p, "failure", payload)).unwrap();
        let s = t.saved();
        let input = &s.inputs.0[&p.input_id];
        assert_eq!(input.state, InputState::Handled);
        assert!(input.attempts[0].domain_result.is_some());
        assert!(input.attempts[0].sealed_at.is_some());
        let binding = &s.bindings.0[&id(3)];
        assert_eq!(binding.dispatch_state, DispatchState::Enabled);
        assert_eq!(binding.pause_reason, None);
        assert_eq!(binding.active_input_id, None);
        // A later contradiction about the handled input is ignored, never a barrier.
        t.ignored(&t.event(
            &p,
            "late",
            EventPayload::Uncertain {
                reason: "late doubt".into(),
            },
        ));
        assert_eq!(t.saved().inputs.0[&p.input_id].state, InputState::Handled);
        assert_eq!(t.saved().bindings.0[&id(3)].pause_reason, None);
        assert!(DeliveryService::new(&t.registry)
            .claim(&t.lease(), &t.request(201), || panic!(), at("09"))
            .unwrap()
            .is_none());
    }
}
#[test]
fn committed_result_after_failure_heals_the_needs_attention_input() {
    // Owner rule: the result wins even when the failure was reported first.
    let t = Setup::new();
    t.queue(100);
    let p = t.claim(200);
    let failed = EventPayload::TurnFinished {
        status: TurnFinishedStatus::Interrupted,
        reason: None,
        diagnostic_text: None,
        truncated: false,
    };
    t.report(&t.event(&p, "interrupted", failed)).unwrap();
    let s = t.saved();
    assert_eq!(s.inputs.0[&p.input_id].state, InputState::NeedsAttention);
    assert_eq!(
        s.bindings.0[&id(3)].dispatch_state,
        DispatchState::RecoveryRequired
    );
    t.result(&p, 300);
    let s = t.saved();
    let input = &s.inputs.0[&p.input_id];
    assert_eq!(input.state, InputState::Handled);
    assert!(input.attempts[0].sealed_at.is_some());
    let binding = &s.bindings.0[&id(3)];
    assert_eq!(binding.pause_reason, None);
    assert_eq!(binding.dispatch_state, DispatchState::Enabled);
}
#[test]
fn grace_is_five_seconds_from_saved_completion_and_late_result_keeps_warning_owner_pause() {
    for owner_paused in [false, true] {
        let t = Setup::new();
        t.queue(100);
        let p = t.claim(200);
        t.report(&t.event(&p, "completed", completed())).unwrap();
        if owner_paused {
            t.write(|s| {
                let b = s.bindings.0.get_mut(&id(3)).unwrap();
                b.owner_paused = true;
                b.dispatch_state = DispatchState::Paused;
            });
        }
        let bytes = t.bytes();
        assert!(t.expire(&p, 400, at("00")).unwrap().is_none());
        assert!(t.expire(&p, 400, at("05")).unwrap().is_none());
        assert_eq!(bytes, t.bytes());
        let receipt = t.expire(&p, 400, at("06")).unwrap().unwrap();
        assert!(matches!(
            receipt.data,
            SavedReceiptData::DeliveryExpiry { .. }
        ));
        let bytes = t.bytes();
        assert!(t.expire(&p, 401, at("09")).unwrap().is_none());
        assert_eq!(bytes, t.bytes());
        assert_eq!(t.expire(&p, 400, at("09")).unwrap().unwrap(), receipt);
        t.result(&p, 300);
        let s = t.saved();
        let a = &s.inputs.0[&p.input_id].attempts[0];
        assert_eq!(a.result_state, ResultState::Committed);
        assert!(a.sealed_at.is_some());
        assert_eq!(a.error.as_ref().unwrap().code, "result_missing");
        let b = &s.bindings.0[&id(3)];
        assert_eq!(b.owner_paused, owner_paused);
        assert_eq!(b.pause_reason, None);
        assert_eq!(
            b.dispatch_state,
            if owner_paused {
                DispatchState::Paused
            } else {
                DispatchState::Enabled
            }
        );
    }
}
#[test]
fn late_result_clears_the_barrier_of_a_missing_result_conflict() {
    // Owner rule: a committed result wins over an earlier contradiction too.
    let t = Setup::new();
    t.queue(100);
    let p = t.claim(200);
    t.report(&t.event(&p, "completed", completed())).unwrap();
    t.expire(&p, 400, at("06")).unwrap().unwrap();
    let warning = t.saved().inputs.0[&p.input_id].attempts[0].error.clone();
    let contradiction = t.event(
        &p,
        "contradiction",
        EventPayload::TurnFinished {
            status: TurnFinishedStatus::Failed,
            reason: Some("contradictory terminal observation".into()),
            diagnostic_text: None,
            truncated: false,
        },
    );
    assert!(t.report(&contradiction).is_err());
    assert_eq!(
        t.saved().inputs.0[&p.input_id].state,
        InputState::NeedsAttention
    );
    t.result(&p, 300);
    let s = t.saved();
    let input = &s.inputs.0[&p.input_id];
    assert_eq!(input.state, InputState::Handled);
    assert_eq!(input.attempts[0].result_state, ResultState::Committed);
    assert_eq!(input.attempts[0].error, warning);
    assert!(input.attempts[0].sealed_at.is_some());
    assert_eq!(s.bindings.0[&id(3)].pause_reason, None);
    assert_eq!(s.bindings.0[&id(3)].dispatch_state, DispatchState::Enabled);
    let bytes = t.bytes();
    assert!(t.report(&contradiction).is_err());
    assert_eq!(t.bytes(), bytes);
}

#[test]
fn expiry_preserves_other_barriers_and_handles_cross_day_negative_time() {
    let t = Setup::new();
    t.queue(100);
    let p = t.claim(200);
    let mut e = t.event(&p, "completed", completed());
    e.observed_at = UtcMillis::new("2026-10-03T23:59:58.000Z").unwrap();
    t.report(&e).unwrap();
    t.write(|s| {
        let b = s.bindings.0.get_mut(&id(3)).unwrap();
        b.pause_reason = Some(PauseReason::StoreError);
        b.dispatch_state = DispatchState::RecoveryRequired;
    });
    let future = UtcMillis::new("2026-10-04T00:00:03.000Z").unwrap();
    t.expire(&p, 400, future).unwrap().unwrap();
    t.result(&p, 300);
    let s = t.saved();
    assert_eq!(
        s.bindings.0[&id(3)].pause_reason,
        Some(PauseReason::StoreError)
    );
    assert_eq!(
        s.bindings.0[&id(3)].dispatch_state,
        DispatchState::RecoveryRequired
    );
}
#[test]
fn trusted_historical_scope_records_old_facts_but_current_claim_cannot_repeat_old_attempt() {
    let t = Setup::new();
    t.queue(100);
    let p = t.claim(200);
    t.write(|s| {
        let b = s.bindings.0.get_mut(&id(3)).unwrap();
        b.generation = id(777);
        b.dispatch_state = DispatchState::RecoveryRequired;
    });
    let e = t.event(&p, "historical-completion", completed());
    let bytes = t.bytes();
    assert_eq!(
        code(t.report(&e).unwrap_err()),
        CoreErrorCode::StaleGeneration
    );
    assert_eq!(bytes, t.bytes());
    let context = AdapterContext::from_trusted_entrypoint(
        route(),
        id(3),
        id(777),
        Some(VerifiedHistoricalScope::from_trusted_reconciliation(
            p.binding_generation.clone(),
            p.input_id.clone(),
            p.attempt_id.clone(),
            t.saved().bindings.0[&id(3)].endpoint_fingerprint.clone(),
        )),
    );
    DeliveryService::new(&t.registry)
        .report(&context, &e, || t.uuid())
        .unwrap();
    let s = t.saved();
    assert_eq!(
        s.inputs.0[&p.input_id].attempts[0].binding_generation,
        p.binding_generation
    );
    assert_eq!(
        s.inputs.0[&p.input_id].attempts[0].turn_state,
        TurnState::Completed
    );
    assert!(DeliveryService::new(&t.registry)
        .claim(&t.lease(), &t.request(201), || panic!(), at("09"))
        .is_err());
}
#[test]
fn native_clock_expires_saved_prior_generation_completion_without_historical_report_authority() {
    let t = Setup::new();
    t.queue(100);
    let p = t.claim(200);
    t.report(&t.event(&p, "completed-before-reconnect", completed()))
        .unwrap();
    t.write(|session| {
        let binding = session.bindings.0.get_mut(&id(3)).unwrap();
        binding.generation = id(777);
        binding.dispatch_state = DispatchState::RecoveryRequired;
    });
    let context = t.context();
    assert!(context.historical_scope().is_none());
    let before = t.bytes();
    assert_eq!(
        code(t.expire(&p, 400, at("06")).unwrap_err()),
        CoreErrorCode::StaleGeneration
    );
    assert_eq!(t.bytes(), before);
    let service = DeliveryService::new(&t.registry);
    assert!(service
        .expire_missing_result_native(&context, &p.input_id, &p.attempt_id, &id(401), at("05"))
        .unwrap()
        .is_none());
    assert_eq!(t.bytes(), before);
    let receipt = service
        .expire_missing_result_native(&context, &p.input_id, &p.attempt_id, &id(401), at("06"))
        .unwrap()
        .unwrap();
    let saved = t.saved();
    assert_eq!(
        saved.inputs.0[&p.input_id].state,
        InputState::NeedsAttention
    );
    assert_eq!(
        saved.inputs.0[&p.input_id].attempts[0].result_state,
        ResultState::Missing
    );
    assert_eq!(
        saved.inputs.0[&p.input_id].attempts[0].binding_generation,
        p.binding_generation
    );
    assert!(saved.inputs.0[&p.input_id].attempts[0].sealed_at.is_none());
    let expired = t.bytes();
    assert_eq!(
        service
            .expire_missing_result_native(&context, &p.input_id, &p.attempt_id, &id(401), at("09"))
            .unwrap(),
        Some(receipt)
    );
    assert!(service
        .expire_missing_result_native(&context, &p.input_id, &p.attempt_id, &id(402), at("09"))
        .unwrap()
        .is_none());
    assert_eq!(t.bytes(), expired);
    assert_eq!(
        code(
            t.report(&t.event(
                &p,
                "unauthorized-old-generation-start",
                EventPayload::TurnStarted {}
            ))
            .unwrap_err()
        ),
        CoreErrorCode::StaleGeneration
    );
    assert_eq!(t.bytes(), expired);
}

#[test]
fn native_clock_rejects_stale_selection_generation_and_cross_binding_without_writes() {
    for changed in ["generation", "selection", "binding"] {
        let t = Setup::new();
        t.queue(100);
        let p = t.claim(200);
        t.report(&t.event(&p, "completed", completed())).unwrap();
        let context = t.context();
        t.write(|session| {
            let mut other = session.bindings.0[&id(3)].clone();
            other.id = id(888);
            other.active_input_id = None;
            other.owner_paused = true;
            other.dispatch_state = DispatchState::Paused;
            session.bindings.0.insert(id(888), other);
            match changed {
                "generation" => session.bindings.0.get_mut(&id(3)).unwrap().generation = id(777),
                "selection" => session.active_binding_id = Some(id(888)),
                "binding" => {
                    session.active_binding_id = Some(id(888));
                }
                _ => unreachable!(),
            }
        });
        let context = if changed == "binding" {
            AdapterContext::from_trusted_entrypoint(
                route(),
                id(888),
                context.current_generation().clone(),
                None,
            )
        } else {
            context
        };
        let before = t.bytes();
        let error = DeliveryService::new(&t.registry)
            .expire_missing_result_native(&context, &p.input_id, &p.attempt_id, &id(400), at("06"))
            .unwrap_err();
        // A binding no longer selected was replaced by a rebind: stale.
        assert_eq!(
            code(error),
            if changed == "binding" {
                CoreErrorCode::BindingMismatch
            } else {
                CoreErrorCode::StaleGeneration
            }
        );
        assert_eq!(t.bytes(), before);
    }
}

#[test]
fn stale_scope_and_malformed_facts_have_no_effects_or_uuid_allocations() {
    let t = Setup::new();
    t.queue(100);
    let p = t.claim(200);
    let mut e = t.event(&p, "bad-scope", completed());
    e.generation = id(123);
    let bytes = t.bytes();
    assert_eq!(
        code(
            DeliveryService::new(&t.registry)
                .report(&t.context(), &e, || panic!())
                .unwrap_err()
        ),
        CoreErrorCode::BindingMismatch
    );
    assert_eq!(bytes, t.bytes());
    e = t.event(&p, "bad-envelope", completed());
    e.host_turn_id = None;
    assert_eq!(
        code(
            DeliveryService::new(&t.registry)
                .report(&t.context(), &e, || panic!())
                .unwrap_err()
        ),
        CoreErrorCode::InvalidArgument
    );
    assert_eq!(bytes, t.bytes());
}
fn owner_cancel(t: &Setup, input: &UuidV4, op: u64) {
    let command = OwnerCommand::InputCancel {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(op),
        params: InputCancelParams {
            input_id: input.clone(),
            expected_revision: t.saved().revision,
            purpose: None,
        },
    };
    InputService::new(&t.registry)
        .execute(
            &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(route())),
            &command,
            || t.uuid(),
            at("07"),
        )
        .unwrap();
}

#[test]
fn owner_cancel_abandons_an_in_flight_input_and_late_reports_are_ignored() {
    // Owner rule: cancel works in flight; the agent's late facts change nothing.
    let t = Setup::new();
    t.queue(100);
    let next = t.queue(101);
    let p = t.claim(200);
    owner_cancel(&t, &p.input_id, 300);
    let s = t.saved();
    let input = &s.inputs.0[&p.input_id];
    assert_eq!(input.state, InputState::Cancelled);
    assert!(input.attempts[0].sealed_at.is_some());
    assert_eq!(s.bindings.0[&id(3)].active_input_id, None);
    let failed = EventPayload::TurnFinished {
        status: TurnFinishedStatus::Failed,
        reason: Some("stopped".into()),
        diagnostic_text: None,
        truncated: false,
    };
    t.report(&t.event(&p, "late-failure", failed)).unwrap();
    let error = match t.try_result(&p, 301).unwrap_err() {
        ariadne_core::apply::ApplyError::Core(error) => error,
        other => panic!("core error, got {other:?}"),
    };
    assert_eq!(error.code, CoreErrorCode::AttemptSealed);
    assert_eq!(
        error.details.unwrap().reason,
        Some(BarrierReason::InputCancelled)
    );
    let s = t.saved();
    assert_eq!(s.inputs.0[&p.input_id].state, InputState::Cancelled);
    let binding = &s.bindings.0[&id(3)];
    assert_eq!(binding.pause_reason, None);
    assert_eq!(binding.dispatch_state, DispatchState::Enabled);
    assert_eq!(t.claim(201).input_id, next);
}

#[test]
fn owner_cancel_of_the_input_needing_attention_lifts_the_barrier() {
    let t = Setup::new();
    t.queue(100);
    let p = t.claim(200);
    let interrupted = EventPayload::TurnFinished {
        status: TurnFinishedStatus::Interrupted,
        reason: None,
        diagnostic_text: None,
        truncated: false,
    };
    t.report(&t.event(&p, "interrupted", interrupted)).unwrap();
    assert_eq!(
        t.saved().bindings.0[&id(3)].dispatch_state,
        DispatchState::RecoveryRequired
    );
    owner_cancel(&t, &p.input_id, 300);
    let s = t.saved();
    assert_eq!(s.inputs.0[&p.input_id].state, InputState::Cancelled);
    let binding = &s.bindings.0[&id(3)];
    assert_eq!(binding.pause_reason, None);
    assert_eq!(binding.dispatch_state, DispatchState::Enabled);
}

#[test]
fn rejected_before_delivery_remains_recovery_and_later_start_is_conflict() {
    let t = Setup::new();
    t.queue(100);
    let p = t.claim(200);
    t.report(&t.event(
        &p,
        "rejected",
        EventPayload::Rejected {
            reason: "known not queued".into(),
        },
    ))
    .unwrap();
    let saved = t.saved();
    assert_eq!(
        saved.inputs.0[&p.input_id].attempts[0].acceptance,
        AcceptanceState::Rejected
    );
    assert_eq!(
        saved.inputs.0[&p.input_id].state,
        InputState::NeedsAttention
    );
    assert_eq!(
        code(
            t.report(&t.event(&p, "contradiction", EventPayload::TurnStarted {}))
                .unwrap_err()
        ),
        CoreErrorCode::ProtocolConflict
    );
}
#[test]
fn presence_visible_output_and_connected_duplicates_are_non_durable_noops() {
    let t = Setup::new();
    t.queue(100);
    let p = t.claim(200);
    let e = t.event(
        &p,
        "live-output",
        EventPayload::VisibleOutput {
            host_message_id: None,
            phase: ariadne_agent_protocol::OutputPhase::Commentary,
            operation: ariadne_agent_protocol::OutputOperation::Append,
            text: "bounded runtime observation".into(),
            truncated: false,
            gap_before: false,
        },
    );
    let before = t.bytes();
    let receipt = DeliveryService::new(&t.registry)
        .report(&t.context(), &e, || panic!())
        .unwrap();
    assert!(!receipt.durable_effect);
    assert!(receipt.revision.is_none());
    assert_eq!(before, t.bytes());
}

#[test]
fn fresh_facts_about_a_sealed_attempt_are_ignored_and_a_changed_known_fact_raises_no_barrier() {
    let t = Setup::new();
    t.queue(100);
    let p = t.claim(200);
    let good = t.event(&p, "completed", completed());
    t.report(&good).unwrap();
    t.result(&p, 300);
    let before = t.saved().inputs.clone();
    let mut redundant = good.clone();
    redundant.event_id = "fresh-redundant-completion".into();
    t.ignored(&redundant);
    t.ignored(&t.event(
        &p,
        "new-provider-receipt-after-seal",
        EventPayload::Accepted {
            receipt: Some(HostReceipt {
                provider_reference: "new-reference".into(),
                observed_at: at("08"),
            }),
        },
    ));
    let mut bad = good.clone();
    bad.event_id = "fresh-contradiction".into();
    bad.event = EventPayload::TurnFinished {
        status: TurnFinishedStatus::Failed,
        reason: Some("late contradiction".into()),
        diagnostic_text: None,
        truncated: false,
    };
    // Owner rule: the committed result wins; a later contradiction is ignored.
    t.ignored(&bad);
    let saved = t.saved();
    assert_eq!(saved.inputs, before);
    assert_eq!(
        saved.bindings.0[&id(3)].dispatch_state,
        DispatchState::Enabled
    );
    assert_eq!(saved.bindings.0[&id(3)].pause_reason, None);
    // A changed fact under a known event ID is retained, without a barrier.
    let mut known = good;
    known.host_turn_id = Some("wrong-host-turn".into());
    assert_eq!(
        code(t.report(&known).unwrap_err()),
        CoreErrorCode::ProtocolConflict
    );
    let saved = t.saved();
    assert_eq!(saved.inputs, before);
    assert_eq!(
        saved.bindings.0[&id(3)].dispatch_state,
        DispatchState::Enabled
    );
    assert!(saved
        .operation_receipts
        .0
        .values()
        .flatten()
        .any(|r| matches!(r.result.data, SavedReceiptData::EventConflict { .. })));
}

#[test]
fn late_history_after_doubt_and_a_committed_result_is_ignored_and_the_queue_moves_on() {
    // A submit that timed out is uncertain; the agent still commits its result,
    // so the attempt seals with an unknown turn. History reports the turn later.
    let t = Setup::new();
    t.queue(100);
    let next = t.queue(101);
    let p = t.claim(200);
    t.report(&t.event(
        &p,
        "submit-timed-out",
        EventPayload::Uncertain {
            reason: "timed out".into(),
        },
    ))
    .unwrap();
    t.result(&p, 300);
    let s = t.saved();
    let input = &s.inputs.0[&p.input_id];
    assert_eq!(input.state, InputState::Handled);
    assert_eq!(input.attempts[0].turn_state, TurnState::Unknown);
    assert!(input.attempts[0].sealed_at.is_some());
    let before = s.inputs.clone();
    t.ignored(&t.event(
        &p,
        "history-accepted",
        EventPayload::Accepted { receipt: None },
    ));
    t.ignored(&t.event(&p, "history-started", EventPayload::TurnStarted {}));
    t.ignored(&t.event(&p, "history-completed", completed()));
    t.ignored(&t.event(
        &p,
        "history-failed",
        EventPayload::TurnFinished {
            status: TurnFinishedStatus::Failed,
            reason: None,
            diagnostic_text: None,
            truncated: false,
        },
    ));
    let s = t.saved();
    assert_eq!(s.inputs, before);
    assert_eq!(s.bindings.0[&id(3)].dispatch_state, DispatchState::Enabled);
    assert_eq!(t.claim(201).input_id, next);
}

#[test]
fn late_facts_about_an_attempt_the_owner_resent_or_skipped_are_ignored() {
    for decision in [ResolutionKind::Resend, ResolutionKind::Skip] {
        let t = Setup::new();
        t.queue(100);
        let p = t.claim(200);
        let interrupted = EventPayload::TurnFinished {
            status: TurnFinishedStatus::Interrupted,
            reason: None,
            diagnostic_text: None,
            truncated: false,
        };
        t.report(&t.event(&p, "interrupted", interrupted)).unwrap();
        t.resolve(&p, decision.clone(), 300);
        let s = t.saved();
        assert!(s.inputs.0[&p.input_id].attempts[0].sealed_at.is_some());
        let binding = s.bindings.0[&id(3)].clone();
        assert_ne!(binding.dispatch_state, DispatchState::RecoveryRequired);
        t.ignored(&t.event(&p, "late-start", EventPayload::TurnStarted {}));
        t.ignored(&t.event(&p, "late-completed", completed()));
        t.ignored(&t.event(
            &p,
            "late-rejected",
            EventPayload::Rejected {
                reason: "late".into(),
            },
        ));
        t.ignored(&t.event(
            &p,
            "late-uncertain",
            EventPayload::Uncertain {
                reason: "late".into(),
            },
        ));
        let s = t.saved();
        assert_eq!(s.bindings.0[&id(3)], binding, "{decision:?}");
    }
}

#[test]
fn cancel_and_close_hand_an_in_flight_input_whose_result_committed() {
    // Owner rule: a committed result always wins, even over a cancel or close.
    for close in [false, true] {
        let t = Setup::new();
        t.queue(100);
        let p = t.claim(200);
        t.report(&t.event(&p, "started", EventPayload::TurnStarted {}))
            .unwrap();
        t.result(&p, 300);
        assert_eq!(t.saved().inputs.0[&p.input_id].state, InputState::InFlight);
        if close {
            let MutationReceipt::Session(receipt) = HistoryActionService::new(&t.registry)
                .execute(
                    &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(route())),
                    &OwnerCommand::SessionClose {
                        api_version: SchemaVersion::new(1).unwrap(),
                        op_id: id(301),
                        params: SessionLifecycleParams {
                            expected_revision: t.saved().revision,
                        },
                    },
                    at("07"),
                )
                .unwrap()
            else {
                panic!("session receipt")
            };
            let SavedReceiptData::SessionLifecycle {
                cancelled_input_ids,
                ..
            } = receipt.data
            else {
                panic!("lifecycle receipt")
            };
            assert!(!cancelled_input_ids.contains(&p.input_id));
        } else {
            let MutationReceipt::Session(receipt) = InputService::new(&t.registry)
                .execute(
                    &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(route())),
                    &OwnerCommand::InputCancel {
                        api_version: SchemaVersion::new(1).unwrap(),
                        op_id: id(301),
                        params: InputCancelParams {
                            input_id: p.input_id.clone(),
                            expected_revision: t.saved().revision,
                            purpose: None,
                        },
                    },
                    || t.uuid(),
                    at("07"),
                )
                .unwrap()
            else {
                panic!("session receipt")
            };
            assert_eq!(
                receipt.data,
                SavedReceiptData::InputCancel {
                    input_id: p.input_id.clone(),
                    state: InputState::Handled,
                }
            );
        }
        let s = t.saved();
        let input = &s.inputs.0[&p.input_id];
        assert_eq!(input.state, InputState::Handled, "close={close}");
        assert!(input.attempts[0].domain_result.is_some());
        assert!(input.attempts[0].sealed_at.is_some());
        assert_eq!(s.bindings.0[&id(3)].active_input_id, None);
    }
}

fn archive(t: &Setup, op: u64) -> Vec<UuidV4> {
    let s = t.saved();
    let MutationReceipt::Session(receipt) = HistoryActionService::new(&t.registry)
        .execute(
            &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(route())),
            &OwnerCommand::TopicArchive {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: id(op),
                params: TopicLifecycleParams {
                    topic_id: id(5),
                    expected_revision: s.topics.0[&id(5)].revision,
                },
            },
            at("07"),
        )
        .unwrap()
    else {
        panic!("session receipt")
    };
    let SavedReceiptData::TopicLifecycle {
        cancelled_input_ids,
        ..
    } = receipt.data
    else {
        panic!("lifecycle receipt")
    };
    cancelled_input_ids
}

#[test]
fn archive_cancels_queued_and_in_flight_inputs_and_claim_delivers_none_of_them() {
    let t = Setup::new();
    let first = t.queue(100);
    let second = t.queue(101);
    let p = t.claim(200);
    assert_eq!(p.input_id, first);
    let mut cancelled = archive(&t, 300);
    cancelled.sort();
    let mut expected = vec![first.clone(), second.clone()];
    expected.sort();
    assert_eq!(cancelled, expected);
    let s = t.saved();
    for input in [&first, &second] {
        assert_eq!(s.inputs.0[input].state, InputState::Cancelled);
    }
    assert!(s.inputs.0[&first].attempts[0].sealed_at.is_some());
    let binding = &s.bindings.0[&id(3)];
    assert_eq!(binding.active_input_id, None);
    assert_eq!(binding.dispatch_state, DispatchState::Enabled);
    // The agent's late result for the cancelled attempt changes nothing.
    let error = match t.try_result(&p, 301).unwrap_err() {
        ariadne_core::apply::ApplyError::Core(error) => error,
        other => panic!("core error, got {other:?}"),
    };
    assert_eq!(error.code, CoreErrorCode::AttemptSealed);
    assert!(DeliveryService::new(&t.registry)
        .claim(&t.lease(), &t.request(201), || panic!(), at("08"))
        .unwrap()
        .is_none());
}

#[test]
fn archive_hands_an_in_flight_input_whose_result_committed_and_does_not_list_it() {
    let t = Setup::new();
    t.queue(100);
    let p = t.claim(200);
    t.result(&p, 300);
    assert!(archive(&t, 301).is_empty());
    let s = t.saved();
    assert_eq!(s.inputs.0[&p.input_id].state, InputState::Handled);
    assert_eq!(s.bindings.0[&id(3)].active_input_id, None);
}

#[test]
fn claim_never_delivers_a_queued_input_for_an_archived_topic() {
    // Defence in depth: archive cancels these, but a queued input that
    // targets an archived topic is skipped regardless.
    let t = Setup::new();
    t.queue(100);
    t.write(|s| s.topics.0.get_mut(&id(5)).unwrap().archived_at = Some(at("01")));
    let bytes = t.bytes();
    assert!(DeliveryService::new(&t.registry)
        .claim(&t.lease(), &t.request(200), || panic!(), at("02"))
        .unwrap()
        .is_none());
    assert_eq!(bytes, t.bytes());
}

#[test]
fn a_cancelled_queued_input_is_never_claimed_and_a_stale_cancel_after_claim_conflicts() {
    let t = Setup::new();
    let first = t.queue(100);
    let second = t.queue(101);
    owner_cancel(&t, &first, 300);
    let p = t.claim(200);
    assert_eq!(p.input_id, second);
    assert!(t.saved().inputs.0[&first].attempts.is_empty());
    // A cancel prepared before the claim committed carries a stale revision:
    // the claim won, the cancel is refused and nothing changes.
    let third = t.queue(102);
    let stale = t.saved().revision;
    owner_cancel(&t, &p.input_id, 301);
    let p = t.claim(201);
    assert_eq!(p.input_id, third);
    let bytes = t.bytes();
    let refused = InputService::new(&t.registry)
        .execute(
            &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(route())),
            &OwnerCommand::InputCancel {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: id(302),
                params: InputCancelParams {
                    input_id: third.clone(),
                    expected_revision: stale,
                    purpose: None,
                },
            },
            || t.uuid(),
            at("08"),
        )
        .unwrap_err();
    let ariadne_core::inputs::InputError::Core(refused) = refused else {
        panic!("core error")
    };
    assert_eq!(refused.code, CoreErrorCode::RevisionConflict);
    assert_eq!(bytes, t.bytes());
    assert_eq!(t.saved().inputs.0[&third].state, InputState::InFlight);
    // A refresh shows the truth; cancelling then abandons the in-flight input.
    owner_cancel(&t, &third, 303);
    assert_eq!(t.saved().inputs.0[&third].state, InputState::Cancelled);
}

#[test]
fn separate_cancel_and_claim_writers_agree_on_whichever_committed_first() {
    for round in 0..4 {
        let t = Setup::new();
        let input = t.queue(100);
        let mut a = writer(&t, "cancel", 10 + round);
        let mut b = writer(&t, "claim", round);
        assert!(a.wait().unwrap().success());
        assert!(b.wait().unwrap().success());
        let claimed: Option<PreparedAttempt> = serde_json::from_slice(
            &fs::read(t.root.path().join(format!("child-{round}.json"))).unwrap(),
        )
        .unwrap();
        let cancel =
            fs::read_to_string(t.root.path().join(format!("child-{}.json", 10 + round))).unwrap();
        let s = t.saved();
        let saved = &s.inputs.0[&input];
        match (claimed.is_some(), cancel.as_str()) {
            // Cancel first: the input never had an attempt.
            (false, "cancelled") => assert!(saved.attempts.is_empty()),
            // Claim first, cancel read the fresh revision: abandoned in flight.
            (true, "cancelled") => {
                assert_eq!(saved.attempts.len(), 1);
                assert!(saved.attempts[0].sealed_at.is_some());
            }
            // Claim first, cancel read a stale revision: refused, still in flight.
            (true, "conflict") => assert_eq!(saved.state, InputState::InFlight),
            other => panic!("inconsistent race outcome {other:?}"),
        }
        if cancel == "cancelled" {
            assert_eq!(saved.state, InputState::Cancelled);
            assert_eq!(s.bindings.0[&id(3)].active_input_id, None);
        }
    }
}

#[test]
fn writer_child() {
    if std::env::var("ARIADNE_DELIVERY_TEST_ROOT").is_err() {
        return;
    }
    let home = std::env::var("ARIADNE_DELIVERY_TEST_HOME").unwrap();
    let output = std::env::var("ARIADNE_DELIVERY_TEST_OUTPUT").unwrap();
    let action = std::env::var("ARIADNE_DELIVERY_TEST_ACTION").unwrap();
    let ordinal: u64 = std::env::var("ARIADNE_DELIVERY_TEST_ORDINAL")
        .unwrap()
        .parse()
        .unwrap();
    let registry = Registry::open(std::path::Path::new(&home)).unwrap();
    let store = Store::open_registered(&registry.project_dir(&id(1)), id(1)).unwrap();
    let s = store.read(&id(2)).unwrap();
    let generation = s.bindings.0[&id(3)].generation.clone();
    if action == "claim" {
        let request = ClaimRequest {
            binding_id: id(3),
            generation: generation.clone(),
            request_id: id(200 + ordinal),
        };
        let lease =
            ValidatedDispatchContext::from_trusted_current_lease(route(), id(3), generation);
        let p = DeliveryService::new(&registry)
            .claim(&lease, &request, || id(9000 + ordinal), at("00"))
            .unwrap();
        fs::write(output, serde_json::to_vec(&p).unwrap()).unwrap();
    } else if action == "cancel" {
        // The owner's cancel carries the revision it last saw.
        let input = s.inputs.0.keys().next().unwrap().clone();
        let outcome = InputService::new(&registry).execute(
            &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(route())),
            &OwnerCommand::InputCancel {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: id(400 + ordinal),
                params: InputCancelParams {
                    input_id: input,
                    expected_revision: s.revision,
                    purpose: None,
                },
            },
            || id(9300 + ordinal),
            at("07"),
        );
        let word = match outcome {
            Ok(_) => "cancelled",
            Err(ariadne_core::inputs::InputError::Core(e))
                if e.code == CoreErrorCode::RevisionConflict =>
            {
                "conflict"
            }
            Err(other) => panic!("{other:?}"),
        };
        fs::write(output, word).unwrap();
    } else {
        let input = s
            .inputs
            .0
            .values()
            .find(|i| i.state == InputState::InFlight)
            .unwrap();
        let attempt = input.attempts.last().unwrap();
        if action == "completion" {
            let e = NormalizedEvent {
                event_id: "concurrent-completion".into(),
                binding_id: id(3),
                generation: generation.clone(),
                input_id: Some(input.id.clone()),
                attempt_id: Some(attempt.id.clone()),
                host_turn_id: Some("concurrent-host-turn".into()),
                observed_at: at("01"),
                event: completed(),
            };
            DeliveryService::new(&registry)
                .report(
                    &AdapterContext::from_trusted_entrypoint(route(), id(3), generation, None),
                    &e,
                    || id(9100),
                )
                .unwrap();
        } else {
            let owner = s
                .messages
                .iter()
                .find(|m| m.id == input.message_id)
                .unwrap();
            let c = AgentContext::from_trusted_entrypoint(
                route(),
                id(3),
                generation,
                AgentReadScope::Dispatched {
                    source_input_id: input.id.clone(),
                    attempt_id: attempt.id.clone(),
                    issued_through_message_number: NonnegativeSafeInteger::new(
                        owner.number.value(),
                    )
                    .unwrap(),
                },
            );
            let r = ApplyRequest {
                op_id: id(300),
                source_input_id: Some(input.id.clone()),
                attempt_id: Some(attempt.id.clone()),
                expected_item_revisions: UniqueMap(std::collections::BTreeMap::from([(
                    ItemRef::new("1").unwrap(),
                    s.items.0[&ItemRef::new("1").unwrap()].revision,
                )])),
                expected_topic_revisions: UniqueMap(Default::default()),
                summary: String::new(),
                operations: vec![Operation::Reply {
                    r#ref: RequestRef::new("concurrent_reply").unwrap(),
                    item: EntityRef::Existing(ExistingRef {
                        id: ItemRef::new("1").unwrap(),
                    }),
                    text: "Complete concurrent result explanation.".into(),
                    round_id: None,
                }],
                input_result: Some(ResultDraft {
                    outcome: ResultOutcome::Answered,
                    explanation: "Concurrent explicit result.".into(),
                    reply_refs: vec![UuidRef::Local(LocalRef {
                        r#ref: RequestRef::new("concurrent_reply").unwrap(),
                    })],
                    followup_item_refs: vec![],
                    handled_through_message_number: owner.number,
                }),
            };
            let mut n = 9200;
            ApplyService::new(&registry)
                .execute(
                    &c,
                    &r,
                    || {
                        n += 1;
                        id(n)
                    },
                    at("06"),
                )
                .unwrap();
        }
        fs::write(output, b"committed").unwrap();
    }
}
fn writer(t: &Setup, action: &str, ordinal: u64) -> std::process::Child {
    std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "writer_child", "--nocapture"])
        .env("ARIADNE_DELIVERY_TEST_ROOT", t.root.path())
        .env("ARIADNE_DELIVERY_TEST_HOME", t._home.path())
        .env("ARIADNE_DELIVERY_TEST_ACTION", action)
        .env("ARIADNE_DELIVERY_TEST_ORDINAL", ordinal.to_string())
        .env(
            "ARIADNE_DELIVERY_TEST_OUTPUT",
            t.root.path().join(format!("child-{ordinal}.json")),
        )
        .spawn()
        .unwrap()
}
#[test]
fn separate_claim_writers_choose_one_input_and_exact_request_replay_has_one_attempt() {
    for same in [false, true] {
        let t = Setup::new();
        let first = t.queue(100);
        t.queue(101);
        let mut a = writer(&t, "claim", 0);
        let mut b = writer(&t, "claim", if same { 0 } else { 1 });
        assert!(a.wait().unwrap().success());
        assert!(b.wait().unwrap().success());
        let s = t.saved();
        assert_eq!(s.inputs.0[&first].attempts.len(), 1);
        assert_eq!(s.inputs.0[&first].state, InputState::InFlight);
        assert_eq!(
            s.inputs
                .0
                .values()
                .filter(|i| i.state == InputState::Queued)
                .count(),
            1
        );
        if !same {
            let one: Option<PreparedAttempt> =
                serde_json::from_slice(&fs::read(t.root.path().join("child-0.json")).unwrap())
                    .unwrap();
            let two: Option<PreparedAttempt> =
                serde_json::from_slice(&fs::read(t.root.path().join("child-1.json")).unwrap())
                    .unwrap();
            assert_eq!(usize::from(one.is_some()) + usize::from(two.is_some()), 1);
        }
    }
}
#[test]
fn separate_result_and_completion_writers_join_without_lost_receipts_or_reply() {
    let t = Setup::new();
    t.queue(100);
    let p = t.claim(200);
    let mut a = writer(&t, "completion", 0);
    let mut b = writer(&t, "result", 1);
    assert!(a.wait().unwrap().success());
    assert!(b.wait().unwrap().success());
    let s = t.saved();
    let input = &s.inputs.0[&p.input_id];
    assert_eq!(input.state, InputState::Handled);
    assert!(input.attempts[0].sealed_at.is_some());
    assert_eq!(input.attempts[0].turn_state, TurnState::Completed);
    assert_eq!(input.attempts[0].result_state, ResultState::Committed);
    assert_eq!(
        s.messages
            .iter()
            .filter(|m| m.body == "Complete concurrent result explanation.")
            .count(),
        1
    );
    assert!(s.operation_receipts.0.values().flatten().any(|r|matches!(r.result.data,SavedReceiptData::Event {ref event_id,..} if event_id=="concurrent-completion")));
    assert!(s.operation_receipts.0.contains_key(&id(300)));
}

#[test]
fn definite_commit_failure_and_stale_conflicting_context_never_claim_barrier_persisted() {
    let t = Setup::new();
    t.queue(100);
    let p = t.claim(200);
    let good = t.event(&p, "completion", completed());
    t.report(&good).unwrap();
    let mut bad = good.clone();
    bad.event = EventPayload::TurnFinished {
        status: TurnFinishedStatus::Failed,
        reason: None,
        diagnostic_text: None,
        truncated: false,
    };
    let stale = AdapterContext::from_trusted_entrypoint(route(), id(3), id(404), None);
    let before = t.bytes();
    assert_eq!(
        code(
            DeliveryService::new(&t.registry)
                .report(&stale, &bad, || panic!())
                .unwrap_err()
        ),
        CoreErrorCode::StaleGeneration
    );
    assert_eq!(before, t.bytes());
    let backup = store_dir(t._home.path(), 1)
        .join("backups")
        .join(format!("{}.previous.json", id(2).as_str()));
    fs::remove_file(&backup).unwrap();
    let outside = t.root.path().join("ordinary-outside-test-file");
    fs::write(&outside, b"unchanged").unwrap();
    std::os::unix::fs::symlink(&outside, &backup).unwrap();
    let failed = t.report(&bad);
    assert!(matches!(failed, Err(DeliveryError::Store(_))), "{failed:?}");
    assert_eq!(before, t.bytes());
    assert_eq!(fs::read(outside).unwrap(), b"unchanged");
    assert_eq!(t.saved().inputs.0[&p.input_id].state, InputState::InFlight);
}
#[test]
fn connection_reports_preserve_owner_pause_recovery_and_verified_identity() {
    let t = Setup::new();
    let binding = t.saved().bindings.0[&id(3)].clone();
    let mut e = NormalizedEvent {
        event_id: "disconnect".into(),
        binding_id: id(3),
        generation: binding.generation.clone(),
        input_id: None,
        attempt_id: None,
        host_turn_id: None,
        observed_at: at("01"),
        event: EventPayload::Disconnected {
            reason: Some("ordinary loss".into()),
        },
    };
    t.report(&e).unwrap();
    assert_eq!(
        t.saved().bindings.0[&id(3)].dispatch_state,
        DispatchState::Disconnected
    );
    let bytes = t.bytes();
    assert_eq!(
        code(
            DeliveryService::new(&t.registry)
                .claim(&t.lease(), &t.request(200), || panic!(), at("00"))
                .unwrap_err()
        ),
        CoreErrorCode::HostUnreachable
    );
    assert_eq!(bytes, t.bytes());
    t.write(|s| {
        let b = s.bindings.0.get_mut(&id(3)).unwrap();
        b.owner_paused = true;
        b.pause_reason = Some(PauseReason::StoreError);
    });
    e.event_id = "connected".into();
    e.event = EventPayload::Connected {
        external_session_id: binding.external_session_id.clone(),
        endpoint_fingerprint: binding.endpoint_fingerprint.clone(),
        capabilities: Box::new(binding.capabilities.clone()),
    };
    t.report(&e).unwrap();
    let s = t.saved();
    assert!(s.bindings.0[&id(3)].owner_paused);
    assert_eq!(
        s.bindings.0[&id(3)].pause_reason,
        Some(PauseReason::StoreError)
    );
    assert_eq!(
        s.bindings.0[&id(3)].dispatch_state,
        DispatchState::RecoveryRequired
    );
    let bytes = t.bytes();
    e.event_id = "wrong-host".into();
    let EventPayload::Connected {
        ref mut external_session_id,
        ..
    } = e.event
    else {
        panic!()
    };
    *external_session_id = "another-host".into();
    assert_eq!(
        code(
            DeliveryService::new(&t.registry)
                .report(&t.context(), &e, || panic!())
                .unwrap_err()
        ),
        CoreErrorCode::BindingMismatch
    );
    assert_eq!(bytes, t.bytes());
}

fn connection_event(t: &Setup, name: &str, connected: bool) -> NormalizedEvent {
    let binding = t.saved().bindings.0[&id(3)].clone();
    NormalizedEvent {
        event_id: name.into(),
        binding_id: binding.id,
        generation: binding.generation,
        input_id: None,
        attempt_id: None,
        host_turn_id: None,
        observed_at: at("01"),
        event: if connected {
            EventPayload::Connected {
                external_session_id: binding.external_session_id,
                endpoint_fingerprint: binding.endpoint_fingerprint,
                capabilities: Box::new(binding.capabilities),
            }
        } else {
            EventPayload::Disconnected {
                reason: Some("Original Claude session ended.".into()),
            }
        },
    }
}

#[test]
fn claude_end_receipt_fences_fresh_connected_but_preserves_exact_connected_replay() {
    let t = Setup::new();
    t.write(|s| s.bindings.0.get_mut(&id(3)).unwrap().adapter_id = "claude_code_mod".into());
    let ordinary = connection_event(&t, "ordinary-loss", false);
    t.report(&ordinary).unwrap();
    let connected = connection_event(&t, "original-connected", true);
    let original = t.report(&connected).unwrap();
    // Diagnostic reason alone has no authority to fence reconnection.
    assert_eq!(
        t.saved().bindings.0[&id(3)].dispatch_state,
        DispatchState::Enabled
    );
    let mut ended = connection_event(&t, "", false);
    ended.event_id = claude_session_end_event_id(&ended.binding_id, &ended.generation);
    let receipt = t.report(&ended).unwrap();
    assert!(receipt.durable_effect);
    assert!(ariadne_core::lifecycle::claude_generation_ended(
        &t.saved(),
        &id(3),
        &ended.generation
    ));
    let bytes = t.bytes();
    let replay = DeliveryService::new(&t.registry)
        .report(&t.context(), &connected, || panic!("replay allocation"))
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.revision, original.revision);
    assert!(
        DeliveryService::new(&t.registry)
            .report(&t.context(), &ended, || panic!("end replay allocation"))
            .unwrap()
            .replayed
    );
    let mut late = connected;
    late.event_id = "fresh-delayed-connected".into();
    assert_eq!(
        code(
            DeliveryService::new(&t.registry)
                .report(&t.context(), &late, || panic!("rejected allocation"))
                .unwrap_err()
        ),
        CoreErrorCode::HostUnreachable
    );
    assert_eq!(bytes, t.bytes());
    assert_eq!(
        t.saved().bindings.0[&id(3)].connection_state,
        ConnectionState::Disconnected
    );
    assert_eq!(
        code(
            DeliveryService::new(&t.registry)
                .claim(&t.lease(), &t.request(200), || panic!(), at("02"))
                .unwrap_err()
        ),
        CoreErrorCode::HostUnreachable
    );
}

#[test]
fn already_disconnected_claude_end_commits_one_durable_fence() {
    let t = Setup::new();
    t.write(|s| s.bindings.0.get_mut(&id(3)).unwrap().adapter_id = "claude_code_mod".into());
    t.report(&connection_event(&t, "ordinary-disconnect", false))
        .unwrap();
    let mut ended = connection_event(&t, "", false);
    ended.event_id = claude_session_end_event_id(&ended.binding_id, &ended.generation);
    let before = t.saved();
    let receipt = t.report(&ended).unwrap();
    assert!(receipt.durable_effect && !receipt.replayed);
    assert_eq!(t.saved().revision.value(), before.revision.value() + 1);
    assert!(ariadne_core::lifecycle::claude_generation_ended(
        &t.saved(),
        &id(3),
        &ended.generation
    ));
    let bytes = t.bytes();
    let mut retry = ended.clone();
    retry.observed_at = at("03");
    assert!(t.report(&retry).unwrap().replayed);
    assert_eq!(bytes, t.bytes());
    assert_eq!(
        code(t.report(&connection_event(&t, "late", true)).unwrap_err()),
        CoreErrorCode::HostUnreachable
    );
}

#[test]
fn reserved_session_end_identity_rejects_wrong_scope_kind_and_provider_without_writes() {
    let t = Setup::new();
    let mut ended = connection_event(&t, "", false);
    ended.event_id = claude_session_end_event_id(&ended.binding_id, &ended.generation);
    let bytes = t.bytes();
    assert_eq!(
        code(
            DeliveryService::new(&t.registry)
                .report(&t.context(), &ended, || panic!())
                .unwrap_err()
        ),
        CoreErrorCode::BindingMismatch
    );
    for mutation in 0..4 {
        let mut invalid = ended.clone();
        match mutation {
            0 => invalid.event_id = claude_session_end_event_id(&id(999), &invalid.generation),
            1 => invalid.event_id = claude_session_end_event_id(&invalid.binding_id, &id(999)),
            2 => invalid.event = connection_event(&t, "", true).event,
            _ => invalid.event_id = "claude:session-ended:malformed".into(),
        }
        assert_eq!(
            code(
                DeliveryService::new(&t.registry)
                    .report(&t.context(), &invalid, || panic!())
                    .unwrap_err()
            ),
            CoreErrorCode::InvalidArgument
        );
    }
    assert_eq!(bytes, t.bytes());
}

#[test]
fn explicit_claude_reconnect_rotates_generation_past_the_prior_terminal_receipt() {
    use ariadne_agent_protocol::{Availability, Compatibility};
    use ariadne_core::bindings::{BindingService, VerifiedHost};
    let t = Setup::new();
    t.write(|s| s.bindings.0.get_mut(&id(3)).unwrap().adapter_id = "claude_code_mod".into());
    let original = t.saved().bindings.0[&id(3)].clone();
    let mut ended = connection_event(&t, "", false);
    ended.event_id = claude_session_end_event_id(&ended.binding_id, &ended.generation);
    t.report(&ended).unwrap();
    let command = OwnerCommand::BindingConnect {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(900),
        params: BindingConnectParams {
            project_id: id(1),
            adapter_id: original.adapter_id.clone(),
            external_session_id: original.external_session_id.clone(),
            endpoint: original.endpoint.clone(),
            configuration: original.adapter_config.clone(),
            existing_session_id: Some(id(2)),
        },
    };
    BindingService::new(&t.registry)
        .connect(
            &OwnerContext::from_trusted_entrypoint(OwnerScope::Registry),
            &command,
            |_| {
                Ok(VerifiedHost {
                    adapter_id: original.adapter_id.clone(),
                    adapter_version: original.adapter_version,
                    protocol_major: original.protocol_major,
                    config_version: original.config_version,
                    external_session_id: original.external_session_id,
                    endpoint: original.endpoint,
                    endpoint_fingerprint: original.endpoint_fingerprint,
                    configuration: original.adapter_config,
                    capabilities: original.capabilities,
                    compatibility: Compatibility::Compatible,
                    availability: Availability::Available,
                    connection_state: ConnectionState::Unknown,
                    cli_invocation: "ariadne".into(),
                    host_location: None,
                    setup_instruction: "Retain saved IDs.".into(),
                })
            },
            || t.uuid(),
            at("04"),
        )
        .unwrap();
    let saved = t.saved();
    assert_ne!(saved.bindings.0[&id(3)].generation, original.generation);
    assert!(!ariadne_core::lifecycle::claude_generation_ended(
        &saved,
        &id(3),
        &saved.bindings.0[&id(3)].generation
    ));
    assert!(ariadne_core::lifecycle::claude_generation_ended(
        &saved,
        &id(3),
        &original.generation
    ));
    t.report(&connection_event(&t, "new-generation-connected", true))
        .unwrap();
    assert_eq!(
        t.saved().bindings.0[&id(3)].dispatch_state,
        DispatchState::Enabled
    );
}
#[test]
fn claim_carries_exact_text_and_current_revisions_and_rejects_capacity_before_allocation() {
    let t = Setup::new();
    let input = t.queue(100);
    let frozen = t.saved().inputs.0[&input].payload.clone();
    t.write(|s| {
        let item = s.items.0.get_mut(&ItemRef::new("1").unwrap()).unwrap();
        item.revision = PositiveSafeInteger::new(item.revision.value() + 4).unwrap();
    });
    let p = t.claim(200);
    let (_, body) = p.formatted_payload.split_once('\n').unwrap();
    let body: serde_json::Value = serde_json::from_str(body).unwrap();
    let item = &t.saved().items.0[&ItemRef::new("1").unwrap()];
    assert_eq!(body["item_id"], "1");
    assert_eq!(body["item_revision"], item.revision.value());
    assert_eq!(body["question_revision"], item.question_revision.value());
    assert_eq!(body["text"], frozen.text);
    // The item body and the frozen snapshot are never shipped.
    assert!(body.get("current_item").is_none() && body.get("saved_input").is_none());
    assert_eq!(t.saved().inputs.0[&input].payload, frozen);
    // Owner text within its 16 KiB bound can still escape past the 64 KiB budget.
    let t = Setup::new();
    t.queue_text(100, &format!("x{}", "\u{1}".repeat(16 * 1024 - 1)));
    let before = t.bytes();
    assert_eq!(
        code(
            DeliveryService::new(&t.registry)
                .claim(
                    &t.lease(),
                    &t.request(200),
                    || panic!("capacity allocated"),
                    at("00")
                )
                .unwrap_err()
        ),
        CoreErrorCode::CapacityExceeded
    );
    assert_eq!(before, t.bytes());
}

#[test]
fn persisted_delivery_validation_retains_history_repair_and_rejects_bad_payload_links() {
    use ariadne_domain::validation::{validate_prepared_payload, validate_session_delivery};
    let demo: Session =
        serde_json::from_str(include_str!("../../../fixtures/domain/demo/session.json")).unwrap();
    validate_session_delivery(&demo).unwrap();
    let t = Setup::new();
    let input = t.queue(100);
    let p = t.claim(200);
    let good = t.saved();
    validate_session_delivery(&good).unwrap();
    let a = &good.inputs.0[&input].attempts[0];
    validate_prepared_payload(
        &input,
        &a.id,
        &a.formatted_payload,
        &a.payload_sha256,
        &a.wire_marker,
    )
    .unwrap();
    p.validate_for(&t.request(200)).unwrap();
    for mutation in 0..7 {
        let mut bad = good.clone();
        match mutation {
            0 => bad.inputs.0.get_mut(&input).unwrap().attempts[0]
                .formatted_payload
                .push('x'),
            1 => bad.inputs.0.get_mut(&input).unwrap().attempts[0].wire_marker = "[INPUT:1]".into(),
            2 => bad.inputs.0.get_mut(&input).unwrap().active_attempt_id = Some(id(404)),
            3 => bad.bindings.0.get_mut(&id(3)).unwrap().active_input_id = Some(id(404)),
            4 => bad
                .inputs
                .0
                .get_mut(&input)
                .unwrap()
                .attempts
                .push(a.clone()),
            5 => {
                let attempt = &mut bad.inputs.0.get_mut(&input).unwrap().attempts[0];
                attempt.purpose = AttemptPurpose::ResultRepair;
                attempt.repair_for_attempt_id = Some(id(404));
            }
            _ => {
                let r = bad.operation_receipts.0.get_mut(&id(200)).unwrap();
                r[0].actor_scope = ReceiptActorScope::Adapter {
                    binding_id: id(404),
                };
            }
        };
        assert!(
            validate_session_delivery(&bad).is_err(),
            "mutation {mutation}"
        );
    }
    let mut bad = p.clone();
    bad.formatted_payload.push('x');
    assert!(bad.validate_for(&t.request(200)).is_err());
    assert!(validate_prepared_payload(
        &bad.input_id,
        &bad.attempt_id,
        &bad.formatted_payload,
        &bad.payload_sha256,
        &bad.wire_marker
    )
    .is_err());
}
#[test]
fn invalid_persisted_attempt_is_never_overwritten_or_claimed_as_valid() {
    let t = Setup::new();
    let input = t.queue(100);
    t.claim(200);
    let mut bad = t.saved();
    bad.inputs.0.get_mut(&input).unwrap().attempts[0]
        .formatted_payload
        .push('x');
    let file = store_dir(t._home.path(), 1)
        .join("sessions")
        .join(format!("{}.json", id(2).as_str()));
    let bytes = serde_json::to_vec_pretty(&bad).unwrap();
    fs::write(&file, &bytes).unwrap();
    let lease = ValidatedDispatchContext::from_trusted_current_lease(route(), id(3), id(4));
    let r = ClaimRequest {
        binding_id: id(3),
        generation: id(4),
        request_id: id(200),
    };
    assert!(matches!(
        DeliveryService::new(&t.registry).claim(&lease, &r, || panic!(), at("09")),
        Err(DeliveryError::Store(
            ariadne_store::session::StoreError::Validation(_)
        ))
    ));
    assert_eq!(bytes, fs::read(file).unwrap());
}

fn session_archive(t: &Setup, op: u64) -> Vec<UuidV4> {
    let MutationReceipt::Session(receipt) = HistoryActionService::new(&t.registry)
        .execute(
            &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(route())),
            &OwnerCommand::SessionArchive {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: id(op),
                params: SessionLifecycleParams {
                    expected_revision: t.saved().revision,
                },
            },
            at("07"),
        )
        .unwrap()
    else {
        panic!("session receipt")
    };
    let SavedReceiptData::SessionLifecycle {
        cancelled_input_ids,
        ..
    } = receipt.data
    else {
        panic!("lifecycle receipt")
    };
    cancelled_input_ids
}

#[test]
fn session_archive_cancels_in_flight_and_needs_attention_and_seals_late_reports() {
    for needs_attention in [false, true] {
        let t = Setup::new();
        let first = t.queue(100);
        let second = t.queue(101);
        let p = t.claim(200);
        if needs_attention {
            t.report(&t.event(
                &p,
                "uncertain",
                EventPayload::Uncertain {
                    reason: "Host completion is unknown".into(),
                },
            ))
            .unwrap();
            assert_eq!(t.saved().inputs.0[&first].state, InputState::NeedsAttention);
        }
        let mut cancelled = session_archive(&t, 300);
        cancelled.sort();
        let mut expected = vec![first.clone(), second.clone()];
        expected.sort();
        assert_eq!(cancelled, expected);
        let archived = t.saved();
        assert_eq!(archived.state, SessionState::Closed);
        assert!(archived.archived_at.is_some());
        assert!(archived.bindings.0[&id(3)].owner_paused);
        assert_eq!(archived.bindings.0[&id(3)].active_input_id, None);
        assert!(archived.inputs.0[&first].attempts[0].sealed_at.is_some());
        for input in [&first, &second] {
            assert_eq!(archived.inputs.0[input].state, InputState::Cancelled);
            assert_eq!(
                archived.inputs.0[input].cancel_cause,
                Some(CancelCause::SessionClosed)
            );
        }
        let bytes = t.bytes();
        let refusal = t.try_result(&p, 301).unwrap_err();
        let ariadne_core::apply::ApplyError::Core(refusal) = refusal else {
            panic!("typed archive refusal")
        };
        assert_eq!(
            refusal.message,
            "The owner archived this session; it takes no changes until the owner restores and reopens it"
        );
        assert_eq!(
            refusal.hint,
            "Ask the owner to restore and reopen this session before sending changes."
        );
        assert_eq!(t.bytes(), bytes);
        let claim = DeliveryService::new(&t.registry)
            .claim(
                &t.lease(),
                &ClaimRequest {
                    binding_id: id(3),
                    generation: archived.bindings.0[&id(3)].generation.clone(),
                    request_id: id(302),
                },
                || t.uuid(),
                at("08"),
            )
            .unwrap_err();
        let ariadne_core::delivery::DeliveryError::Core(claim) = claim else {
            panic!("typed archive claim refusal")
        };
        assert_eq!(
            claim.message,
            "The owner archived this session; restore it, then reopen it to resume sending"
        );
        assert_eq!(t.bytes(), bytes);
    }
}

#[test]
fn session_archive_hands_committed_result_without_reporting_it_cancelled() {
    let t = Setup::new();
    t.queue(100);
    let p = t.claim(200);
    t.result(&p, 300);
    assert!(session_archive(&t, 301).is_empty());
    let archived = t.saved();
    assert_eq!(archived.inputs.0[&p.input_id].state, InputState::Handled);
    assert_eq!(archived.bindings.0[&id(3)].active_input_id, None);
    assert!(archived.bindings.0[&id(3)].owner_paused);
}
