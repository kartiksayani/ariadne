//! Rebind after /clear disconnects the old conversation first. Pending work
//! follows the session to the new binding.
use ariadne_agent_protocol::{
    Availability, Compatibility, EventPayload, NormalizedEvent, TurnFinishedStatus,
};
use ariadne_core::{
    apply::ApplyService,
    bindings::{BindingError, BindingService, VerifiedHost},
    delivery::DeliveryService,
    inputs::InputService,
    recovery::RecoveryService,
    *,
};
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
use std::sync::atomic::{AtomicU64, Ordering};
use tempfile::TempDir;

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
fn owner() -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Session(route()))
}
fn one() -> SchemaVersion {
    SchemaVersion::new(1).unwrap()
}
fn seed() -> Session {
    let mut session: Session =
        serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json")).unwrap();
    session.bindings.0.get_mut(&id(3)).unwrap().adapter_id = "claude_code_mod".into();
    session
}
/// The seeded binding 3 runs the Claude adapter with test-owned host facts.
fn facts(params: &BindingConnectParams) -> VerifiedHost {
    let b = seed().bindings.0[&id(3)].clone();
    VerifiedHost {
        adapter_id: params.adapter_id.clone(),
        adapter_version: b.adapter_version,
        protocol_major: b.protocol_major,
        config_version: b.config_version,
        external_session_id: params.external_session_id.clone(),
        endpoint: params.endpoint.clone(),
        endpoint_fingerprint: b.endpoint_fingerprint,
        configuration: params.configuration.clone(),
        capabilities: b.capabilities,
        compatibility: Compatibility::Compatible,
        availability: Availability::Available,
        connection_state: ConnectionState::Connected,
        cli_invocation: "ariadne".into(),
        host_location: None,
        setup_instruction: "Use the saved binding and generation.".into(),
    }
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
        Store::open_registered(&store_dir(home.path(), 1), id(1))
            .unwrap()
            .create(&seed())
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
        Store::open_registered(&store_dir(self.home.path(), 1), id(1)).unwrap()
    }
    fn saved(&self) -> Session {
        self.store().read(&id(2)).unwrap()
    }
    fn generation(&self, binding: &UuidV4) -> UuidV4 {
        self.saved().bindings.0[binding].generation.clone()
    }
    fn queue(&self, n: u64) -> UuidV4 {
        let command = OwnerCommand::InputSubmit {
            api_version: one(),
            op_id: id(n),
            params: InputSubmitParams {
                binding_id: id(3),
                target: InputTarget {
                    topic_id: id(5),
                    item_id: Some(ItemRef::new("1").unwrap()),
                },
                kind: InputKind::Reply,
                text: format!("Exact owner text {n}\n"),
                selected_option_id: None,
                expected_question_revision: None,
                supersedes_answer_id: None,
            },
        };
        let MutationReceipt::Session(receipt) = InputService::new(&self.registry)
            .execute(&owner(), &command, || self.uuid(), at("00"))
            .unwrap()
        else {
            panic!()
        };
        let SavedReceiptData::InputSubmit { input_id, .. } = receipt.data else {
            panic!()
        };
        input_id
    }
    fn try_claim(
        &self,
        binding: &UuidV4,
        n: u64,
    ) -> Result<Option<PreparedAttempt>, ariadne_core::delivery::DeliveryError> {
        let generation = self.generation(binding);
        DeliveryService::new(&self.registry).claim(
            &ValidatedDispatchContext::from_trusted_current_lease(
                route(),
                binding.clone(),
                generation.clone(),
            ),
            &ClaimRequest {
                binding_id: binding.clone(),
                generation,
                request_id: id(n),
            },
            || self.uuid(),
            at("01"),
        )
    }
    fn claim(&self, binding: &UuidV4, n: u64) -> PreparedAttempt {
        self.try_claim(binding, n).unwrap().unwrap()
    }
    /// The claim refuses with this reason; nothing is sent.
    fn blocked(&self, binding: &UuidV4, n: u64) -> Option<BarrierReason> {
        match self.try_claim(binding, n) {
            Err(ariadne_core::delivery::DeliveryError::Core(e)) => {
                e.details.and_then(|details| details.reason)
            }
            other => panic!("{other:?}"),
        }
    }
    /// The agent commits a result for the attempt; its turn has not ended.
    fn result(&self, p: &PreparedAttempt, n: u64) {
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
        let request = ApplyRequest {
            op_id: id(n),
            source_input_id: Some(p.input_id.clone()),
            attempt_id: Some(p.attempt_id.clone()),
            expected_item_revisions: UniqueMap(std::collections::BTreeMap::from([(
                item.clone(),
                s.items.0[&item].revision,
            )])),
            expected_topic_revisions: UniqueMap(Default::default()),
            summary: String::new(),
            operations: vec![Operation::Reply {
                r#ref: RequestRef::new("result_reply").unwrap(),
                item: EntityRef::Existing(ExistingRef { id: item }),
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
                handled_through_message_number: owner_message.number,
            }),
        };
        ApplyService::new(&self.registry)
            .execute(&context, &request, || self.uuid(), at("02"))
            .unwrap();
    }
    fn connect(&self, adapter: &str, host: &str, n: u64) -> Result<UuidV4, BindingError> {
        let command = OwnerCommand::BindingConnect {
            api_version: one(),
            op_id: id(n),
            params: BindingConnectParams {
                project_id: id(1),
                adapter_id: adapter.into(),
                external_session_id: host.into(),
                endpoint: EndpointRef::LocalBridge {
                    name: "fake".into(),
                },
                configuration: seed().bindings.0[&id(3)].adapter_config.clone(),
                existing_session_id: Some(id(2)),
            },
        };
        let receipt = BindingService::new(&self.registry).connect(
            &OwnerContext::from_trusted_entrypoint(OwnerScope::Registry),
            &command,
            |p| Ok(facts(p)),
            || self.uuid(),
            at("03"),
        )?;
        let MutationReceipt::Session(receipt) = receipt else {
            panic!()
        };
        let SavedReceiptData::BindingConnect { binding_id, .. } = receipt.data else {
            panic!()
        };
        Ok(binding_id)
    }
    /// /clear ends the old session before connecting the fresh conversation.
    fn clear(&self, n: u64) -> UuidV4 {
        self.binding_state("disconnect", &id(3), n + 1000);
        self.connect("claude_code_mod", "cleared-thread", n)
            .unwrap()
    }
    fn binding_state(&self, kind: &str, binding: &UuidV4, n: u64) {
        let params = BindingStateParams {
            binding_id: binding.clone(),
            expected_generation: self.generation(binding),
        };
        let command = match kind {
            "pause" => OwnerCommand::BindingPause {
                api_version: one(),
                op_id: id(n),
                params,
            },
            _ => OwnerCommand::BindingDisconnect {
                api_version: one(),
                op_id: id(n),
                params,
            },
        };
        BindingService::new(&self.registry)
            .state(&owner(), &command, at("02"))
            .unwrap();
    }
    fn resolve(&self, p: &PreparedAttempt, decision: ResolutionKind, n: u64) -> InputState {
        let command = OwnerCommand::InputResolve {
            api_version: one(),
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
            .execute(&owner(), &command, None, at("05"))
            .unwrap();
        self.saved().inputs.0[&p.input_id].state.clone()
    }
}

#[test]
fn clear_rebind_moves_unsent_inputs_in_order_to_the_new_conversation() {
    let s = Setup::new();
    let first = s.queue(100);
    let second = s.queue(101);
    let before = s.saved();
    let new = s.clear(102);
    let saved = s.saved();
    assert_eq!(saved.active_binding_id, Some(new.clone()));
    for input in [&first, &second] {
        assert_eq!(saved.inputs.0[input].binding_id, new);
        assert_eq!(saved.inputs.0[input].state, InputState::Queued);
        assert_eq!(
            saved.inputs.0[input].message_id,
            before.inputs.0[input].message_id
        );
        assert_eq!(
            saved.inputs.0[input].payload,
            before.inputs.0[input].payload
        );
    }
    assert_eq!(saved.messages, before.messages);
    let binding = &saved.bindings.0[&new];
    assert_eq!(binding.dispatch_state, DispatchState::Enabled);
    assert_eq!(binding.pause_reason, None);
    let p = s.claim(&new, 103);
    assert_eq!(p.input_id, first);
    assert_eq!(p.binding_generation, s.generation(&new));
    // The retired binding no longer delivers anything.
    assert!(s.saved().inputs.0.values().all(|i| i.binding_id == new));
}

#[test]
fn clear_rebind_handles_an_in_flight_input_whose_result_is_committed() {
    let s = Setup::new();
    let input = s.queue(100);
    let next = s.queue(101);
    let p = s.claim(&id(3), 102);
    s.result(&p, 103);
    assert_eq!(s.saved().inputs.0[&input].state, InputState::InFlight);
    let new = s.clear(104);
    let saved = s.saved();
    let handled = &saved.inputs.0[&input];
    assert_eq!(handled.state, InputState::Handled);
    assert_eq!(handled.active_attempt_id, None);
    assert!(handled.attempts[0].sealed_at.is_some());
    assert_eq!(saved.bindings.0[&id(3)].active_input_id, None);
    let binding = &saved.bindings.0[&new];
    assert_eq!(binding.active_input_id, None);
    assert_eq!(binding.pause_reason, None);
    assert_eq!(binding.dispatch_state, DispatchState::Enabled);
    assert_eq!(s.claim(&new, 105).input_id, next);
}

#[test]
fn clear_rebind_asks_the_owner_about_sent_work_without_a_result_on_the_new_binding() {
    for decision in [ResolutionKind::Resend, ResolutionKind::Skip] {
        let s = Setup::new();
        let input = s.queue(100);
        let p = s.claim(&id(3), 101);
        let new = s.clear(102);
        let saved = s.saved();
        let waiting = &saved.inputs.0[&input];
        assert_eq!(waiting.binding_id, new);
        assert_eq!(waiting.state, InputState::NeedsAttention);
        assert_eq!(waiting.active_attempt_id, Some(p.attempt_id.clone()));
        let binding = &saved.bindings.0[&new];
        assert_eq!(binding.active_input_id, Some(input.clone()));
        assert_eq!(binding.pause_reason, Some(PauseReason::Uncertain));
        assert_eq!(binding.dispatch_state, DispatchState::RecoveryRequired);
        let retired = &saved.bindings.0[&id(3)];
        assert_eq!(retired.active_input_id, None);
        assert_eq!(retired.pause_reason, None);
        // Nothing is sent to the new conversation until the owner answers.
        assert_eq!(s.blocked(&new, 103), Some(BarrierReason::RecoveryRequired));
        // A late report from the cleared conversation changes nothing.
        let before = s.saved();
        let late = NormalizedEvent {
            event_id: "late-finish".into(),
            binding_id: id(3),
            generation: p.binding_generation.clone(),
            input_id: Some(p.input_id.clone()),
            attempt_id: Some(p.attempt_id.clone()),
            host_turn_id: Some("turn".into()),
            observed_at: at("03"),
            event: EventPayload::TurnFinished {
                status: TurnFinishedStatus::Failed,
                reason: None,
                diagnostic_text: None,
                truncated: false,
            },
        };
        let old =
            AdapterContext::from_trusted_entrypoint(route(), id(3), s.generation(&id(3)), None);
        // stale_generation tells the old conversation's loop to drop the report.
        match DeliveryService::new(&s.registry).report(&old, &late, || s.uuid()) {
            Err(ariadne_core::delivery::DeliveryError::Core(e)) => {
                assert_eq!(e.code, CoreErrorCode::StaleGeneration)
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(s.saved(), before);
        let state = s.resolve(&p, decision.clone(), 104);
        let binding = &s.saved().bindings.0[&new];
        assert_eq!(binding.pause_reason, None);
        assert_eq!(binding.dispatch_state, DispatchState::Enabled);
        if decision == ResolutionKind::Resend {
            assert_eq!(state, InputState::Queued);
            let again = s.claim(&new, 105);
            assert_eq!(again.input_id, input);
            assert_ne!(again.attempt_id, p.attempt_id);
            assert_eq!(again.binding_generation, s.generation(&new));
        } else {
            assert_eq!(state, InputState::Skipped);
            assert!(s.try_claim(&new, 105).unwrap().is_none());
        }
    }
}

#[test]
fn clear_rebind_carries_the_owner_pause_unchanged() {
    for paused in [false, true] {
        let s = Setup::new();
        let input = s.queue(100);
        if paused {
            s.binding_state("pause", &id(3), 101);
        }
        let new = s.clear(102);
        let saved = s.saved();
        let binding = &saved.bindings.0[&new];
        assert_eq!(binding.owner_paused, paused);
        assert_eq!(saved.inputs.0[&input].binding_id, new);
        assert_eq!(saved.inputs.0[&input].state, InputState::Queued);
        if paused {
            assert_eq!(binding.dispatch_state, DispatchState::Paused);
            assert_eq!(s.blocked(&new, 103), Some(BarrierReason::OwnerPaused));
        } else {
            assert_eq!(binding.dispatch_state, DispatchState::Enabled);
            assert_eq!(s.claim(&new, 103).input_id, input);
        }
    }
}

#[test]
fn another_adapter_cannot_take_a_live_claude_conversation_but_disconnected_work_moves() {
    let s = Setup::new();
    s.queue(100);
    let before = s.saved();
    let error = s.connect("other.local", "other-thread", 101).unwrap_err();
    let BindingError::Core(error) = error else {
        panic!("{error:?}")
    };
    assert_eq!(error.code, CoreErrorCode::BindingConflict);
    assert_eq!(s.saved(), before);
    // Once that conversation is disconnected, it is replaced with its work.
    let p = s.claim(&id(3), 102);
    s.binding_state("disconnect", &id(3), 103);
    let new = s.connect("other.local", "other-thread", 104).unwrap();
    let saved = s.saved();
    assert_eq!(saved.active_binding_id, Some(new.clone()));
    assert_eq!(saved.inputs.0[&p.input_id].binding_id, new);
    assert_eq!(
        saved.inputs.0[&p.input_id].state,
        InputState::NeedsAttention
    );
}
