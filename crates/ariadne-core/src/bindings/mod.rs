//! Explicit native owner setup over the real registry and session store.
//! The synchronous CoreService contract is unchanged; composition delegates its
//! binding commands here. Runtime owns active provider connect/report/lease wiring.
mod error;
mod register_path;
mod verified;
pub use error::BindingError;
pub use verified::VerifiedHost;

use crate::*;
use ariadne_domain::models::*;
use ariadne_store::registry::{BindingSetup, HostIdentity, LocatedSession, Registry};
use ariadne_store::session::{Store, StoreError};
use serde_json::Value;
use std::collections::BTreeSet;

pub struct BindingService<'a> {
    registry: &'a Registry,
}
impl<'a> BindingService<'a> {
    pub fn new(registry: &'a Registry) -> Self {
        Self { registry }
    }
    /// Registry derives the first display name from the canonical root while
    /// locked; existing metadata names are preserved.
    pub fn register(
        &self,
        context: &OwnerContext,
        command: &OwnerCommand,
        allocate: impl FnOnce() -> UuidV4,
    ) -> Result<MutationReceipt, BindingError> {
        require_registry(context)?;
        command.validate_wire()?;
        let OwnerCommand::ProjectRegister { op_id, params, .. } = command else {
            return Err(invalid("Expected project registration"));
        };
        let root = register_path::resolve(&params.canonical_root)?;
        let saved = self.registry.register(&root, op_id, allocate)?;
        Ok(MutationReceipt::ProjectRegistered(
            ProjectRegisteredReceipt {
                operation_id: saved.operation_id,
                project_id: saved.project_id,
                registry_revision: saved.registry_revision,
            },
        ))
    }

    /// Recover an exact saved connect without host verification or ID allocation.
    /// Refresh the rebuildable index through the same authoritative replay path.
    pub fn replay_connect(
        &self,
        context: &OwnerContext,
        command: &OwnerCommand,
    ) -> Result<Option<MutationReceipt>, BindingError> {
        require_registry(context)?;
        command.validate_wire()?;
        let OwnerCommand::BindingConnect { op_id, params, .. } = command else {
            return Err(invalid("Expected binding connect"));
        };
        let normalized = normalized("binding_connect", params)?;
        self.registry.with_binding_setup(|setup| {
            let saved = replay(setup, params, op_id, &normalized)?;
            if saved.is_some() {
                setup.synchronize(op_id)?;
            }
            Ok(saved.map(|saved| MutationReceipt::Session(Box::new(saved))))
        })
    }

    /// Exact saved replay precedes the read-only verifier and is checked again
    /// after reacquiring locks. IDs are allocated only inside locked persistence.
    pub fn connect(
        &self,
        context: &OwnerContext,
        command: &OwnerCommand,
        verify: impl FnOnce(&BindingConnectParams) -> Result<VerifiedHost, CoreError>,
        allocate: impl FnMut() -> UuidV4,
        at: UtcMillis,
    ) -> Result<MutationReceipt, BindingError> {
        self.connect_guarded(context, command, verify, allocate, at, || Ok(()))
    }

    pub(crate) fn connect_guarded(
        &self,
        context: &OwnerContext,
        command: &OwnerCommand,
        verify: impl FnOnce(&BindingConnectParams) -> Result<VerifiedHost, CoreError>,
        mut allocate: impl FnMut() -> UuidV4,
        at: UtcMillis,
        before_commit: impl Fn() -> Result<(), CoreError>,
    ) -> Result<MutationReceipt, BindingError> {
        require_registry(context)?;
        command.validate_wire()?;
        let OwnerCommand::BindingConnect { op_id, params, .. } = command else {
            return Err(invalid("Expected binding connect"));
        };
        let normalized = normalized("binding_connect", params)?;
        if let Some(saved) = self.replay_connect(context, command)? {
            return Ok(saved);
        }
        // No registry, metadata or session lock survives this provider callback.
        let verified = verify(params);
        self.registry.with_binding_setup(|setup| {
            if let Some(saved) = replay(setup, params, op_id, &normalized)? {
                setup.synchronize(op_id)?;
                return Ok(MutationReceipt::Session(Box::new(saved)));
            }
            let verified = verified?;
            verified.validate(params)?;
            let sessions = setup.sessions()?;
            let identity = HostIdentity {
                adapter_id: verified.adapter_id.clone(),
                endpoint_fingerprint: verified.endpoint_fingerprint.clone(),
                external_session_id: verified.external_session_id.clone(),
            };
            let selected = sessions.iter().find(|located| {
                located
                    .session
                    .active_binding_id
                    .as_ref()
                    .is_some_and(|id| {
                        located
                            .session
                            .bindings
                            .0
                            .get(id)
                            .is_some_and(|binding| HostIdentity::of(binding) == identity)
                    })
            });
            if selected.is_some_and(|located| {
                located.project.project_id != params.project_id
                    || params
                        .existing_session_id
                        .as_ref()
                        .is_some_and(|id| id != &located.session.id)
            }) {
                return Err(conflict(
                    "The selected host route belongs to another registered session",
                ));
            }
            let target = match &params.existing_session_id {
                Some(id) => Some(
                    sessions
                        .iter()
                        .find(|located| {
                            located.project.project_id == params.project_id
                                && &located.session.id == id
                        })
                        .ok_or_else(|| {
                            core(
                                CoreErrorCode::NotFound,
                                "The explicitly selected Ariadne session does not exist",
                                "Select a registered session.",
                            )
                        })?,
                ),
                None => selected,
            };
            if target.is_some_and(|located| located.session.archived_at.is_some()) {
                return Err(core(
                    CoreErrorCode::InvalidTransition,
                    "The selected host route belongs to an archived session",
                    "Restore and reopen that session before reconnecting it.",
                ));
            }
            let mut occupied = occupied_ids(&sessions);
            let saved = setup.with_store(&params.project_id, |store| {
                if let Some(located) = target {
                    // Digest mismatch is an error only in the intended session.
                    // Store also rechecks this before all callback state guards.
                    store
                        .transact(
                            &located.session.id,
                            &ReceiptActorScope::Owner {},
                            op_id,
                            &normalized,
                            |session| {
                                // The final session lock and exact replay precede
                                // fresh mutation or allocation in this callback.
                                before_commit()?;
                                connect_existing(
                                    session,
                                    &verified,
                                    &identity,
                                    &mut occupied,
                                    &mut allocate,
                                    &at,
                                    op_id,
                                )
                            },
                        )
                        .map_err(BindingError::from)
                } else {
                    // Registration scans and project Store admission can wait.
                    // Recheck before allocating even speculative new IDs.
                    before_commit()?;
                    let session_id = fresh(&mut occupied, &mut allocate)?;
                    let binding_id = fresh(&mut occupied, &mut allocate)?;
                    let generation = fresh(&mut occupied, &mut allocate)?;
                    let binding =
                        new_binding(binding_id.clone(), generation.clone(), &verified, &at);
                    let session = new_session(session_id, params.project_id.clone(), binding, &at);
                    store
                        .create_with_receipt_guarded(
                            &session,
                            &ReceiptActorScope::Owner {},
                            op_id,
                            &normalized,
                            connect_receipt(
                                &verified,
                                binding_id,
                                generation,
                                &session.id,
                                op_id,
                                session.revision,
                            )?,
                            || before_commit().map_err(BindingError::from),
                        )
                        .map_err(BindingError::from)
                }
            })?;
            setup.synchronize(op_id)?;
            Ok(MutationReceipt::Session(Box::new(saved)))
        })
    }
}

impl BindingService<'_> {
    /// One ordinary session transaction; no provider waits or host termination.
    /// Healthy queued/in-flight work does not itself become a recovery barrier.
    pub fn state(
        &self,
        context: &OwnerContext,
        command: &OwnerCommand,
        at: UtcMillis,
    ) -> Result<MutationReceipt, BindingError> {
        let OwnerScope::Session(route) = context.scope() else {
            return Err(core(
                CoreErrorCode::PermissionDenied,
                "Binding state changes require a trusted registered session route",
                "Select the registered session owning this binding.",
            ));
        };
        command.validate_wire()?;
        let (kind, params) = match command {
            OwnerCommand::BindingPause { params, .. } => ("binding_pause", params),
            OwnerCommand::BindingResume { params, .. } => ("binding_resume", params),
            OwnerCommand::BindingDisconnect { params, .. } => ("binding_disconnect", params),
            _ => return Err(invalid("Expected binding pause, resume or disconnect")),
        };
        let normalized = normalized(kind, params)?;
        let project = self.registry.resolve_project(route.project_id())?;
        let store = Store::open_registered(
            &self.registry.project_dir(&project.project_id),
            project.project_id,
        )?;
        let saved = store.transact(route.session_id(), &ReceiptActorScope::Owner {},
            command.operation_id(), &normalized, |session| {
                if session.active_binding_id.as_ref() != Some(&params.binding_id) {
                    return Err(core(CoreErrorCode::BindingMismatch,
                        "State command does not target the selected binding",
                        "Use the session's current selected binding."));
                }
                let closed = session.state != SessionState::Active || session.archived_at.is_some();
                let needs_attention = session.inputs.0.values().any(|input| {
                    input.binding_id == params.binding_id && input.state == InputState::NeedsAttention
                });
                let binding = session.bindings.0.get_mut(&params.binding_id)
                    .ok_or_else(|| conflict("Selected binding metadata is missing"))?;
                if binding.generation != params.expected_generation {
                    return Err(core(CoreErrorCode::StaleGeneration,
                        "Binding generation changed before this state command",
                        "Reload the binding generation and begin a new deliberate action."));
                }
                match kind {
                    "binding_pause" => binding.owner_paused = true,
                    "binding_disconnect" => binding.connection_state = ConnectionState::Disconnected,
                    "binding_resume" => {
                        if closed || binding.pause_reason.is_some() || needs_attention {
                            return Err(core(CoreErrorCode::InvalidTransition,
                                "Resume requires an active session with recovery blockers resolved",
                                if session.archived_at.is_some() {
                                    "Restore the archived session, then reopen it before resuming."
                                } else {
                                    "Resolve the recovery blocker or explicitly reopen the session first."
                                }));
                        }
                        if binding.connection_state != ConnectionState::Connected {
                            return Err(core(CoreErrorCode::HostUnreachable,
                                "Resume requires a verified connected binding",
                                "Reconnect the selected host session before resuming."));
                        }
                        binding.owner_paused = false;
                    }
                    _ => unreachable!("checked command"),
                }
                binding.dispatch_state = dispatch(binding, needs_attention);
                session.updated_at = at;
                Ok(SavedReceiptData::BindingState {
                    binding_id: binding.id.clone(), generation: binding.generation.clone(),
                    dispatch_state: binding.dispatch_state.clone(), owner_paused: binding.owner_paused,
                    pause_reason: binding.pause_reason.clone(), connection_state: binding.connection_state.clone(),
                })
            }).map_err(BindingError::from)?;
        Ok(MutationReceipt::Session(Box::new(saved)))
    }
}

fn require_registry(context: &OwnerContext) -> Result<(), BindingError> {
    if context.scope() != &OwnerScope::Registry {
        return Err(core(
            CoreErrorCode::PermissionDenied,
            "Binding bootstrap requires the trusted local registry route",
            "Use the explicit local owner setup entry point.",
        ));
    }
    Ok(())
}
fn normalized(kind: &str, params: &impl serde::Serialize) -> Result<Value, BindingError> {
    serde_json::to_value(serde_json::json!({"command": kind, "params": params}))
        .map_err(|_| invalid("Cannot normalize the typed owner command"))
}
fn replay(
    setup: &BindingSetup<'_>,
    params: &BindingConnectParams,
    op_id: &UuidV4,
    normalized: &Value,
) -> Result<Option<SavedReceipt>, BindingError> {
    if let Some(id) = &params.existing_session_id {
        return setup.with_store(&params.project_id, |store| {
            store
                .replay(id, &ReceiptActorScope::Owner {}, op_id, normalized)
                .map_err(BindingError::from)
        });
    }
    let mut found = None;
    for located in setup.project_sessions(&params.project_id)? {
        let owner = located
            .session
            .operation_receipts
            .0
            .get(op_id)
            .and_then(|bucket| {
                bucket
                    .iter()
                    .find(|entry| entry.actor_scope == ReceiptActorScope::Owner {})
            });
        if !owner.is_some_and(|entry| {
            matches!(entry.result.data, SavedReceiptData::BindingConnect { .. })
        }) {
            continue;
        }
        let saved = setup.with_store(&params.project_id, |store| {
            store
                .replay(
                    &located.session.id,
                    &ReceiptActorScope::Owner {},
                    op_id,
                    normalized,
                )
                .map_err(BindingError::from)
        });
        match saved {
            Ok(Some(saved)) => {
                if found.is_some() {
                    return Err(core(
                        CoreErrorCode::BindingAmbiguous,
                        "More than one session contains this exact binding setup receipt",
                        "Select the intended registered session explicitly.",
                    ));
                }
                found = Some(saved);
            }
            Ok(None) | Err(BindingError::Store(StoreError::OperationReused)) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(found)
}
fn occupied_ids(sessions: &[LocatedSession]) -> BTreeSet<UuidV4> {
    let mut ids = BTreeSet::new();
    for located in sessions {
        ids.insert(located.session.id.clone());
        for binding in located.session.bindings.0.values() {
            ids.insert(binding.id.clone());
            ids.insert(binding.generation.clone());
        }
        for input in located.session.inputs.0.values() {
            for attempt in &input.attempts {
                ids.insert(attempt.binding_generation.clone());
            }
        }
    }
    ids
}
fn fresh(
    ids: &mut BTreeSet<UuidV4>,
    allocate: &mut impl FnMut() -> UuidV4,
) -> Result<UuidV4, BindingError> {
    let id = allocate();
    if !ids.insert(id.clone()) {
        return Err(conflict(
            "Native UUID allocation reused a persisted setup identity",
        ));
    }
    Ok(id)
}
fn connect_receipt(
    host: &VerifiedHost,
    binding_id: UuidV4,
    generation: UuidV4,
    session_id: &UuidV4,
    operation_id: &UuidV4,
    revision: PositiveSafeInteger,
) -> Result<SavedReceiptData, BindingError> {
    let setup_instruction = format!("{}\n\nUse these routing IDs for Ariadne commands: binding {}, generation {}.\nUse {cli} read --binding {} --generation {} --view items --json.\nPublish full item replies with {cli} apply --binding {} --generation {} --json-stdin. Use explicit item references; ordinary terminal prose does not update Ariadne.", host.setup_instruction, binding_id.as_str(), generation.as_str(), binding_id.as_str(), generation.as_str(), binding_id.as_str(), generation.as_str(), cli = host.cli_invocation);
    if setup_instruction.trim().is_empty()
        || setup_instruction.contains('\0')
        || setup_instruction.len() > 64 * 1024
    {
        return Err(core(
            CoreErrorCode::CapacityExceeded,
            "Saved setup instructions exceed the canonical 64KiB bound",
            "Shorten verified instruction content before retrying the same operation.",
        ));
    }
    let data = SavedReceiptData::BindingConnect {
        binding_id,
        generation,
        capabilities: host.capabilities.clone(),
        setup_instruction,
    };
    let response = SuccessEnvelope {
        api_version: SchemaVersion::new(1).expect("literal"),
        ok: SuccessFlag,
        data: MutationReceipt::Session(Box::new(SavedReceipt {
            operation_id: operation_id.clone(),
            session_id: session_id.clone(),
            revision,
            data: data.clone(),
        })),
    };
    let bytes = serde_json::to_vec(&response)
        .map_err(|_| invalid("Cannot serialize saved binding receipt"))?;
    if bytes.len() > 1024 * 1024 {
        return Err(core(
            CoreErrorCode::CapacityExceeded,
            "Binding receipt exceeds the canonical 1MiB response bound",
            "Shorten verified provider facts before retrying the same operation.",
        ));
    }
    Ok(data)
}
fn unresolved(session: &Session) -> bool {
    session.inputs.0.values().any(|input| {
        matches!(
            input.state,
            InputState::Queued | InputState::InFlight | InputState::NeedsAttention
        )
    })
}
/// Rebind: the session's pending inputs follow it to the new binding.
/// - Queued work never sent (or only sent by sealed attempts) waits there for
///   delivery to the new conversation.
/// - Work whose attempt committed its result is handled.
/// - Other sent work needs the owner's "Send again / Mark as done" on the new
///   binding, which then holds it as its active input.
fn carry_inputs(session: &mut Session, new_id: &UuidV4, at: &UtcMillis) {
    let pending: Vec<UuidV4> = session
        .inputs
        .0
        .values()
        .filter(|input| {
            &input.binding_id != new_id
                && matches!(
                    input.state,
                    InputState::Queued | InputState::InFlight | InputState::NeedsAttention
                )
        })
        .map(|input| input.id.clone())
        .collect();
    let mut retired = BTreeSet::new();
    let mut attention = false;
    for input_id in pending {
        let input = &session.inputs.0[&input_id];
        retired.insert(input.binding_id.clone());
        let unsealed = input
            .attempts
            .iter()
            .find(|attempt| attempt.sealed_at.is_none());
        if let Some(attempt) = unsealed.filter(|attempt| {
            attempt.result_state == ResultState::Committed && attempt.domain_result.is_some()
        }) {
            let attempt_id = attempt.id.clone();
            crate::delivery_join::handle_committed(session, &input_id, &attempt_id, at);
            continue;
        }
        let sent = unsealed.is_some() || input.state != InputState::Queued;
        let active = input.active_attempt_id.is_some();
        let old_id = input.binding_id.clone();
        if let Some(old) = session.bindings.0.get_mut(&old_id) {
            if old.active_input_id.as_ref() == Some(&input_id) {
                old.active_input_id = None;
            }
        }
        let input = session.inputs.0.get_mut(&input_id).expect("listed input");
        input.binding_id = new_id.clone();
        if sent {
            input.state = InputState::NeedsAttention;
            attention = true;
            let binding = session.bindings.0.get_mut(new_id).expect("new binding");
            if active && binding.active_input_id.is_none() {
                binding.active_input_id = Some(input_id);
            }
        }
    }
    for old_id in &retired {
        crate::delivery_join::release_barrier(session, old_id);
    }
    let binding = session.bindings.0.get_mut(new_id).expect("new binding");
    if attention && binding.pause_reason.is_none() {
        binding.pause_reason = Some(PauseReason::Uncertain);
    }
    binding.dispatch_state = dispatch(binding, attention);
}
pub(crate) fn dispatch(binding: &Binding, needs_recovery: bool) -> DispatchState {
    if binding.connection_state != ConnectionState::Connected {
        DispatchState::Disconnected
    } else if needs_recovery || binding.pause_reason.is_some() {
        DispatchState::RecoveryRequired
    } else if binding.owner_paused {
        DispatchState::Paused
    } else {
        DispatchState::Enabled
    }
}
fn new_binding(id: UuidV4, generation: UuidV4, host: &VerifiedHost, at: &UtcMillis) -> Binding {
    let mut binding = Binding {
        id,
        generation,
        adapter_id: host.adapter_id.clone(),
        adapter_version: host.adapter_version.clone(),
        protocol_major: host.protocol_major,
        config_version: host.config_version,
        external_session_id: host.external_session_id.clone(),
        endpoint: host.endpoint.clone(),
        endpoint_fingerprint: host.endpoint_fingerprint.clone(),
        created_at: at.clone(),
        dispatch_state: DispatchState::Disconnected,
        owner_paused: false,
        pause_reason: None,
        connection_state: host.connection_state.clone(),
        capabilities: host.capabilities.clone(),
        active_input_id: None,
        issued_through_message_number: NonnegativeSafeInteger::new(0).expect("literal"),
        adapter_config: host.configuration.clone(),
        host_location: host.host_location.clone(),
    };
    binding.dispatch_state = dispatch(&binding, false);
    binding
}
fn new_session(id: UuidV4, project_id: UuidV4, binding: Binding, at: &UtcMillis) -> Session {
    let one = PositiveSafeInteger::new(1).expect("literal");
    Session {
        schema_version: SchemaVersion::new(1).expect("literal"),
        id,
        project_id,
        title: binding.external_session_id.clone(),
        name: None,
        description: None,
        state: SessionState::Active,
        created_at: at.clone(),
        updated_at: at.clone(),
        revision: one,
        closed_at: None,
        archived_at: None,
        counters: SessionCounters {
            next_root: one,
            next_topic_order: one,
            next_message: one,
            next_input: one,
            next_answer: one,
        },
        active_binding_id: Some(binding.id.clone()),
        bindings: UniqueMap(std::collections::BTreeMap::from([(
            binding.id.clone(),
            binding,
        )])),
        topics: UniqueMap(Default::default()),
        items: UniqueMap(Default::default()),
        messages: Vec::new(),
        rounds: UniqueMap(Default::default()),
        answers: Vec::new(),
        inputs: UniqueMap(Default::default()),
        operation_receipts: UniqueMap(Default::default()),
        continuations: UniqueMap(Default::default()),
    }
}
fn connect_existing(
    session: &mut Session,
    host: &VerifiedHost,
    identity: &HostIdentity,
    occupied: &mut BTreeSet<UuidV4>,
    allocate: &mut impl FnMut() -> UuidV4,
    at: &UtcMillis,
    operation_id: &UuidV4,
) -> Result<SavedReceiptData, BindingError> {
    if session.state != SessionState::Active || session.archived_at.is_some() {
        return Err(core(
            CoreErrorCode::InvalidTransition,
            "A closed session cannot reconnect or rebind",
            "Explicitly reopen the session before connecting.",
        ));
    }
    let has_unresolved = unresolved(session);
    let selected = session.active_binding_id.clone();
    let existing = selected
        .as_ref()
        .map(|id| {
            session
                .bindings
                .0
                .get(id)
                .ok_or_else(|| conflict("Selected binding metadata is missing"))
        })
        .transpose()?;
    let same = existing.is_some_and(|binding| HostIdentity::of(binding) == *identity);
    // Only unresolved prepared work is uncertain on reconnect. Never-prepared
    // queued work and retained sealed attempts stay queued in their original FIFO.
    let needs_recovery = existing.is_some_and(|binding| {
        binding.active_input_id.is_some()
            || session.inputs.0.values().any(|input| {
                input.binding_id == binding.id
                    && (matches!(
                        input.state,
                        InputState::InFlight | InputState::NeedsAttention
                    ) || (input.state == InputState::Queued
                        && input
                            .attempts
                            .iter()
                            .any(|attempt| attempt.sealed_at.is_none())))
            })
    });
    // A different conversation cannot replace a Claude route until disconnected:
    // native preflight saves Unknown while a live conversation awaits its bound
    // announcement. /clear disconnects the old route before rebinding.
    // Other adapters retain their established rule:
    // same-adapter replacement, or another paused adapter with nothing pending.
    let same_conversation = existing.is_some_and(|old| {
        old.adapter_id == host.adapter_id && old.external_session_id == host.external_session_id
    });
    let live_elsewhere = existing.is_some_and(|old| {
        (old.adapter_id == "claude_code_mod"
            && !same_conversation
            && old.connection_state != ConnectionState::Disconnected)
            || (!same
                && old.connection_state == ConnectionState::Connected
                && old.adapter_id != host.adapter_id
                && (has_unresolved || old.dispatch_state != DispatchState::Paused))
    });
    if live_elsewhere {
        return Err(conflict(
            "This session is connected to another live conversation; disconnect it first",
        ));
    }
    let generation = fresh(occupied, allocate)?;
    let binding_id = if same {
        let binding_id = selected.expect("existing selected binding");
        let binding = session
            .bindings
            .0
            .get_mut(&binding_id)
            .expect("checked binding");
        binding.generation = generation.clone();
        binding.adapter_version = host.adapter_version.clone();
        binding.protocol_major = host.protocol_major;
        binding.config_version = host.config_version;
        binding.endpoint = host.endpoint.clone();
        binding.adapter_config = host.configuration.clone();
        binding.capabilities = host.capabilities.clone();
        binding.connection_state = host.connection_state.clone();
        binding.host_location = host.host_location.clone();
        if needs_recovery && binding.pause_reason.is_none() {
            binding.pause_reason = Some(PauseReason::Uncertain);
        }
        binding.dispatch_state = dispatch(binding, needs_recovery);
        binding_id
    } else {
        let binding_id = fresh(occupied, allocate)?;
        let mut binding = new_binding(binding_id.clone(), generation.clone(), host, at);
        // Explicit owner rebind issues only the locked structured-history snapshot.
        // This is read context, never delivery or authority for an old attempt.
        binding.issued_through_message_number = NonnegativeSafeInteger::new(
            session
                .messages
                .iter()
                .filter(|message| message.author == MessageAuthor::Owner)
                .map(|message| message.number.value())
                .max()
                .unwrap_or(0),
        )
        .expect("validated persisted message numbers");
        // The owner's pause belongs to the session, not to the conversation.
        binding.owner_paused = existing.is_some_and(|old| old.owner_paused);
        session.bindings.0.insert(binding_id.clone(), binding);
        session.active_binding_id = Some(binding_id.clone());
        carry_inputs(session, &binding_id, at);
        if let Some(retired) = &selected {
            for item in session.items.0.values_mut() {
                let owner_matches = matches!(&item.owner,
                    ItemOwner::Agent { binding_id } if binding_id == retired);
                let recipient_matches = item.recipient_binding_id.as_ref() == Some(retired);
                if owner_matches || recipient_matches {
                    if owner_matches {
                        item.owner = ItemOwner::Agent {
                            binding_id: binding_id.clone(),
                        };
                    }
                    if recipient_matches {
                        item.recipient_binding_id = Some(binding_id.clone());
                    }
                    item.revision = item
                        .revision
                        .value()
                        .checked_add(1)
                        .and_then(|n| PositiveSafeInteger::new(n).ok())
                        .ok_or(ariadne_store::session::StoreError::CounterOverflow)?;
                    item.updated_at = at.clone();
                }
            }
        }
        binding_id
    };
    session.updated_at = at.clone();
    let revision = session
        .revision
        .value()
        .checked_add(1)
        .and_then(|n| PositiveSafeInteger::new(n).ok())
        .ok_or(ariadne_store::session::StoreError::CounterOverflow)?;
    connect_receipt(
        host,
        binding_id,
        generation,
        &session.id,
        operation_id,
        revision,
    )
}
fn core(code: CoreErrorCode, message: &str, hint: &str) -> BindingError {
    CoreError::new(code, message, hint).into()
}
fn invalid(message: &str) -> BindingError {
    core(
        CoreErrorCode::InvalidArgument,
        message,
        "Correct the explicit binding setup request.",
    )
}
fn conflict(message: &str) -> BindingError {
    core(
        CoreErrorCode::BindingConflict,
        message,
        "Resolve the selected binding conflict before retrying.",
    )
}
