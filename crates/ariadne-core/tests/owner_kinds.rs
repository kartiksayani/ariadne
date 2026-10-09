//! Topic replies and "Mark as handled" (accept_result) end to end.
use ariadne_agent_protocol::{EventPayload, NormalizedEvent, TurnFinishedStatus};
use ariadne_core::{
    apply::ApplyService,
    delivery::DeliveryService,
    inputs::InputService,
    recovery::{RecoveryError, RecoveryService},
    *,
};
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
use std::sync::atomic::{AtomicU64, Ordering};
use tempfile::TempDir;

fn store_dir(home: &std::path::Path) -> std::path::PathBuf {
    home.join(".ariadne/projects").join(id(1).as_str())
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
fn owner() -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Session(route()))
}
fn one() -> SchemaVersion {
    SchemaVersion::new(1).unwrap()
}

struct Setup {
    home: TempDir,
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
        let seed: Session =
            serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json"))
                .unwrap();
        Store::open_registered(&store_dir(home.path()), id(1))
            .unwrap()
            .create(&seed)
            .unwrap();
        Self {
            home,
            _root: root,
            registry,
            next: AtomicU64::new(10000),
        }
    }
    fn uuid(&self) -> UuidV4 {
        id(self.next.fetch_add(1, Ordering::SeqCst))
    }
    fn store(&self) -> Store {
        Store::open_registered(&store_dir(self.home.path()), id(1)).unwrap()
    }
    fn saved(&self) -> Session {
        self.store().read(&id(2)).unwrap()
    }
    fn generation(&self) -> UuidV4 {
        self.saved().bindings.0[&id(3)].generation.clone()
    }
    fn submit(
        &self,
        n: u64,
        kind: InputKind,
        item: Option<&str>,
    ) -> Result<UuidV4, ariadne_core::inputs::InputError> {
        let command = OwnerCommand::InputSubmit {
            api_version: one(),
            op_id: id(n),
            params: InputSubmitParams {
                binding_id: id(3),
                target: InputTarget {
                    topic_id: id(5),
                    item_id: item.map(|i| ItemRef::new(i).unwrap()),
                },
                kind,
                text: format!("Owner instruction {n}\n"),
                selected_option_id: None,
                expected_question_revision: None,
                supersedes_answer_id: None,
            },
        };
        let MutationReceipt::Session(receipt) = InputService::new(&self.registry).execute(
            &owner(),
            &command,
            || self.uuid(),
            at("00"),
        )?
        else {
            panic!()
        };
        let SavedReceiptData::InputSubmit { input_id, .. } = receipt.data else {
            panic!()
        };
        Ok(input_id)
    }
    fn claim(&self, n: u64) -> PreparedAttempt {
        let generation = self.generation();
        DeliveryService::new(&self.registry)
            .claim(
                &ValidatedDispatchContext::from_trusted_current_lease(
                    route(),
                    id(3),
                    generation.clone(),
                ),
                &ClaimRequest {
                    binding_id: id(3),
                    generation,
                    request_id: id(n),
                },
                || self.uuid(),
                at("01"),
            )
            .unwrap()
            .unwrap()
    }
    /// The agent commits a result. `reply` adds a reply to item 1 first.
    fn result(&self, p: &PreparedAttempt, n: u64, reply: bool) {
        let s = self.saved();
        let owner_message = s
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
                issued_through_message_number: NonnegativeSafeInteger::new(
                    owner_message.number.value(),
                )
                .unwrap(),
            },
        );
        let item = ItemRef::new("1").unwrap();
        let (revisions, operations, reply_refs) = if reply {
            (
                std::collections::BTreeMap::from([(item.clone(), s.items.0[&item].revision)]),
                vec![Operation::Reply {
                    r#ref: RequestRef::new("result_reply").unwrap(),
                    item: EntityRef::Existing(ExistingRef { id: item }),
                    text: "Explicit result explanation.".into(),
                    round_id: None,
                }],
                vec![UuidRef::Local(LocalRef {
                    r#ref: RequestRef::new("result_reply").unwrap(),
                })],
            )
        } else {
            Default::default()
        };
        let request = ApplyRequest {
            op_id: id(n),
            source_input_id: Some(p.input_id.clone()),
            attempt_id: Some(p.attempt_id.clone()),
            expected_item_revisions: UniqueMap(revisions),
            expected_topic_revisions: UniqueMap(Default::default()),
            summary: String::new(),
            operations,
            input_result: Some(ResultDraft {
                outcome: ResultOutcome::Answered,
                explanation: "Approved the pull request outside Ariadne.".into(),
                reply_refs,
                followup_item_refs: vec![],
                handled_through_message_number: owner_message.number,
            }),
        };
        ApplyService::new(&self.registry)
            .execute(&context, &request, || self.uuid(), at("02"))
            .unwrap();
    }
    fn finish(&self, p: &PreparedAttempt) {
        let event = NormalizedEvent {
            event_id: "finish".into(),
            binding_id: id(3),
            generation: p.binding_generation.clone(),
            input_id: Some(p.input_id.clone()),
            attempt_id: Some(p.attempt_id.clone()),
            host_turn_id: Some("turn".into()),
            observed_at: at("03"),
            event: EventPayload::TurnFinished {
                status: TurnFinishedStatus::Completed,
                reason: None,
                diagnostic_text: None,
                truncated: false,
            },
        };
        let context =
            AdapterContext::from_trusted_entrypoint(route(), id(3), self.generation(), None);
        DeliveryService::new(&self.registry)
            .report(&context, &event, || self.uuid())
            .unwrap();
    }
    fn accept(&self, p: &PreparedAttempt, n: u64) -> Result<MutationReceipt, RecoveryError> {
        let command = OwnerCommand::InputResolve {
            api_version: one(),
            op_id: id(n),
            params: InputResolveParams {
                input_id: p.input_id.clone(),
                attempt_id: p.attempt_id.clone(),
                decision: ResolutionKind::AcceptResult,
                reason: String::new(),
                // Marking as handled needs no fresh snapshot review.
                expected_revision: PositiveSafeInteger::new(1).unwrap(),
                evidence: None,
            },
        };
        RecoveryService::new(&self.registry).execute(&owner(), &command, None, at("05"))
    }
}

#[test]
fn topic_reply_targets_the_topic_alone_and_a_result_without_replies_handles_it() {
    let s = Setup::new();
    let Err(ariadne_core::inputs::InputError::Core(error)) =
        s.submit(99, InputKind::TopicReply, Some("1"))
    else {
        panic!("a topic reply naming an item must be refused")
    };
    assert_eq!(error.code, CoreErrorCode::InvalidArgument);
    let input_id = s.submit(100, InputKind::TopicReply, None).unwrap();
    let saved = s.saved();
    let input = &saved.inputs.0[&input_id];
    assert_eq!(input.kind, InputKind::TopicReply);
    assert_eq!(input.target.item_id, None);
    assert_eq!(input.target.topic_id, id(5));
    let message = saved
        .messages
        .iter()
        .find(|m| m.id == input.message_id)
        .unwrap();
    assert_eq!(message.topic_id, Some(id(5)));
    assert_eq!(message.item_id, None);
    let p = s.claim(101);
    assert_eq!(p.input_id, input_id);
    assert!(p.formatted_payload.contains("Owner instruction 100"));
    s.result(&p, 102, false);
    s.finish(&p);
    let saved = s.saved();
    assert_eq!(saved.inputs.0[&input_id].state, InputState::Handled);
    assert_eq!(
        saved.bindings.0[&id(3)].dispatch_state,
        DispatchState::Enabled
    );
}

#[test]
fn accept_result_marks_a_legacy_stuck_input_handled_without_attestation_or_revision() {
    let s = Setup::new();
    let input_id = s.submit(100, InputKind::Reply, Some("1")).unwrap();
    let p = s.claim(101);
    // Without a committed result there is nothing to accept.
    let Err(RecoveryError::Core(error)) = s.accept(&p, 102) else {
        panic!("accept without a result must be refused")
    };
    assert_eq!(error.code, CoreErrorCode::InvalidTransition);
    s.result(&p, 103, true);
    // An earlier version left the input stuck behind a barrier.
    let op = s.uuid();
    s.store()
        .transact(
            &id(2),
            &ReceiptActorScope::Owner {},
            &op,
            &serde_json::json!({"test": op}),
            |session| {
                session.inputs.0.get_mut(&input_id).unwrap().state = InputState::NeedsAttention;
                let binding = session.bindings.0.get_mut(&id(3)).unwrap();
                binding.pause_reason = Some(PauseReason::Uncertain);
                binding.dispatch_state = DispatchState::RecoveryRequired;
                Ok::<_, ()>(SavedReceiptData::SessionLifecycle {
                    state: session.state.clone(),
                    closed_at: None,
                    archived_at: None,
                    cancelled_input_ids: vec![],
                })
            },
        )
        .unwrap();
    s.accept(&p, 104).unwrap();
    let saved = s.saved();
    let input = &saved.inputs.0[&input_id];
    assert_eq!(input.state, InputState::Handled);
    assert_eq!(input.active_attempt_id, None);
    assert!(input.attempts[0].sealed_at.is_some());
    assert_eq!(
        input.resolution_history.last().unwrap().kind,
        ResolutionKind::AcceptResult
    );
    let binding = &saved.bindings.0[&id(3)];
    assert_eq!(binding.active_input_id, None);
    assert_eq!(binding.pause_reason, None);
    assert_eq!(binding.dispatch_state, DispatchState::Enabled);
    // A second mark finds the input settled.
    let Err(RecoveryError::Core(error)) = s.accept(&p, 105) else {
        panic!("a settled input cannot be marked again")
    };
    assert_eq!(error.code, CoreErrorCode::InvalidTransition);
}
