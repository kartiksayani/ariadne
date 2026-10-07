use super::{core, preview, HistoryActionError, HistoryActionService};
use crate::*;
use ariadne_domain::models::*;
use ariadne_store::session::Store;
use std::collections::{BTreeMap, BTreeSet};

#[cfg(test)]
#[path = "tests/continuation.rs"]
mod tests;

impl HistoryActionService<'_> {
    /// Replay the target before reading the source. The source lock is released
    /// before the sole target transaction; no source bytes are ever published.
    pub fn continue_topic(
        &self,
        context: &OwnerContext,
        command: &OwnerCommand,
        mut allocate: impl FnMut() -> UuidV4,
        at: UtcMillis,
    ) -> Result<MutationReceipt, HistoryActionError> {
        let OwnerCommand::TopicContinue {
            params,
            api_version,
            ..
        } = command
        else {
            return Err(core(CoreErrorCode::InvalidArgument, "Expected topic_continue").into());
        };
        if api_version.value() != 1 {
            return Err(core(CoreErrorCode::Unsupported, "Unsupported owner API version").into());
        }
        preview::owner_target(context, &params.target)?;
        command.validate_wire()?;
        let normalized = crate::receipts::normalized("topic_continue", params)?;
        let project = self.registry.resolve_project(&params.target.project_id)?;
        let store = Store::open_registered(
            &self.registry.project_dir(&project.project_id),
            project.project_id,
        )?;
        if let Some(saved) = store.replay(
            &params.target.session_id,
            &ReceiptActorScope::Owner {},
            command.operation_id(),
            &normalized,
        )? {
            return Ok(MutationReceipt::Session(Box::new(saved)));
        }
        if params.source == params.target {
            return Err(core(
                CoreErrorCode::InvalidArgument,
                "Continue requires a different target session; the source remains unchanged",
            )
            .into());
        }
        let source = self.snapshot(&params.source)?;
        if !source.topics.0.contains_key(&params.source_topic_id) {
            return Err(core(CoreErrorCode::NotFound, "The source topic does not exist").into());
        }
        let saved = commit_snapshot(&store, &source, command, &normalized, &mut allocate, &at)?;
        Ok(MutationReceipt::Session(Box::new(saved)))
    }
}

// The initial replay is a fast path before source IO. A competing identical
// operation may save after that miss, so the locked replay must also precede
// freshness rejection. Source IO/hash failures keep their existing semantics.
fn commit_snapshot(
    store: &Store,
    source: &Session,
    command: &OwnerCommand,
    normalized: &serde_json::Value,
    allocate: &mut impl FnMut() -> UuidV4,
    at: &UtcMillis,
) -> Result<SavedReceipt, HistoryActionError> {
    let OwnerCommand::TopicContinue { params, .. } = command else {
        unreachable!("validated continuation command")
    };
    Ok(store.transact(
        &params.target.session_id,
        &ReceiptActorScope::Owner {},
        command.operation_id(),
        normalized,
        |target| {
            if source.revision != params.source_revision
                || preview::hash(source, &params.source_topic_id)? != params.source_sha256
            {
                return Err(core(
                    CoreErrorCode::PreviewStale,
                    "The source snapshot changed since the continuation preview",
                ));
            }
            copy(target, source, params, command.operation_id(), allocate, at)
        },
    )?)
}

fn increment(value: PositiveSafeInteger) -> Result<PositiveSafeInteger, CoreError> {
    value
        .value()
        .checked_add(1)
        .and_then(|n| PositiveSafeInteger::new(n).ok())
        .ok_or_else(|| {
            core(
                CoreErrorCode::CapacityExceeded,
                "A continuation counter reached its safe integer limit",
            )
        })
}
fn occupied(session: &Session) -> BTreeSet<UuidV4> {
    let mut ids: BTreeSet<_> = session
        .topics
        .0
        .keys()
        .chain(session.rounds.0.keys())
        .chain(session.inputs.0.keys())
        .chain(session.bindings.0.keys())
        .chain(session.operation_receipts.0.keys())
        .cloned()
        .collect();
    ids.extend(session.messages.iter().map(|m| m.id.clone()));
    ids.extend(session.answers.iter().map(|a| a.id.clone()));
    ids.extend(
        session
            .inputs
            .0
            .values()
            .flat_map(|i| i.attempts.iter().map(|a| a.id.clone())),
    );
    ids.insert(session.id.clone());
    ids.insert(session.project_id.clone());
    ids
}
fn fresh(
    ids: &mut BTreeSet<UuidV4>,
    allocate: &mut impl FnMut() -> UuidV4,
) -> Result<UuidV4, CoreError> {
    let id = allocate();
    if !ids.insert(id.clone()) {
        return Err(core(
            CoreErrorCode::InvalidArgument,
            "The native allocator returned an existing continuation entity ID",
        ));
    }
    Ok(id)
}
fn copy(
    target: &mut Session,
    source: &Session,
    params: &TopicContinueParams,
    operation_id: &UuidV4,
    allocate: &mut impl FnMut() -> UuidV4,
    at: &UtcMillis,
) -> Result<SavedReceiptData, CoreError> {
    if target.state != SessionState::Active {
        return Err(core(
            CoreErrorCode::InvalidTransition,
            "Explicitly reopen the target session before continuing a topic",
        ));
    }
    let binding = preview::selected(target)
        .filter(|b| b.id == params.target_binding_id)
        .ok_or_else(|| {
            core(
                CoreErrorCode::BindingMismatch,
                "Continue requires this target's explicitly selected binding",
            )
        })?;
    if binding.pause_reason == Some(PauseReason::Incompatible) {
        return Err(core(
            CoreErrorCode::IncompatibleAdapter,
            "The selected target binding is incompatible",
        ));
    }
    if target
        .inputs
        .0
        .values()
        .filter(|i| {
            matches!(
                i.state,
                InputState::Queued | InputState::InFlight | InputState::NeedsAttention
            )
        })
        .count()
        >= 100
    {
        return Err(core(
            CoreErrorCode::QueueFull,
            "The target already has 100 pending inputs",
        ));
    }
    let mut ids = occupied(target);
    ids.extend(occupied(source));
    ids.insert(operation_id.clone());
    let topic_id = fresh(&mut ids, allocate)?;
    let input_id = fresh(&mut ids, allocate)?;
    let handoff_message_id = fresh(&mut ids, allocate)?;
    let mut topic = source.topics.0[&params.source_topic_id].clone();
    topic.id = topic_id.clone();
    topic.order = target.counters.next_topic_order;
    target.counters.next_topic_order = increment(target.counters.next_topic_order)?;
    topic.revision = PositiveSafeInteger::new(1).unwrap();
    topic.archived_at = None;
    topic.origin = Some(TopicOrigin {
        project_id: source.project_id.clone(),
        session_id: source.id.clone(),
        topic_id: params.source_topic_id.clone(),
        source_revision: source.revision,
        continued_at: at.clone(),
    });
    let mut item_map = BTreeMap::<ItemRef, ItemRef>::new();
    let mut ordered: Vec<_> = source
        .items
        .0
        .values()
        .filter(|i| i.topic_id == params.source_topic_id)
        .collect();
    ordered.sort_by_key(|i| (i.id.as_str().split('.').count(), i.id.clone()));
    for item in &ordered {
        let ordinal = if item.parent.is_none() {
            let n = target.counters.next_root;
            target.counters.next_root = increment(n)?;
            n
        } else {
            item.ordinal
        };
        let id = ItemRef::new(match &item.parent {
            Some(parent) => format!(
                "{}.{}",
                item_map
                    .get(parent)
                    .ok_or_else(|| core(
                        CoreErrorCode::InvalidRef,
                        "Source parent is outside the copied topic"
                    ))?
                    .as_str(),
                ordinal.value()
            ),
            None => ordinal.value().to_string(),
        })
        .map_err(|_| {
            core(
                CoreErrorCode::CapacityExceeded,
                "The copied item reference exceeds canonical bounds",
            )
        })?;
        if target.items.0.contains_key(&id) || item_map.values().any(|prior| prior == &id) {
            return Err(core(
                CoreErrorCode::InvalidRef,
                "The target item allocator encountered an occupied reference",
            ));
        }
        item_map.insert(item.id.clone(), id);
    }
    let messages = preview::messages(source, &params.source_topic_id);
    let mut message_map = BTreeMap::new();
    for m in &messages {
        message_map.insert(m.id.clone(), fresh(&mut ids, allocate)?);
    }
    let rounds: Vec<_> = source
        .rounds
        .0
        .values()
        .filter(|r| item_map.contains_key(&r.item_id))
        .collect();
    let mut round_map = BTreeMap::new();
    for r in &rounds {
        round_map.insert(r.id.clone(), fresh(&mut ids, allocate)?);
    }
    let answers: Vec<_> = source
        .answers
        .iter()
        .filter(|a| item_map.contains_key(&a.item_id))
        .collect();
    let mut answer_map = BTreeMap::new();
    for a in &answers {
        answer_map.insert(a.id.clone(), fresh(&mut ids, allocate)?);
    }
    let transforms = preview::actions(source, &params.source_topic_id);
    let drops: Vec<_> = transforms
        .iter()
        .filter(|a| matches!(a.action, ContinueCopyAction::ImportedDrop { .. }))
        .collect();
    let import_message_id = if drops.is_empty() {
        None
    } else {
        Some(fresh(&mut ids, allocate)?)
    };
    for old in messages {
        let mut m = old.clone();
        m.id = message_map[&old.id].clone();
        m.number = target.counters.next_message;
        target.counters.next_message = increment(m.number)?;
        m.topic_id = Some(topic_id.clone());
        m.item_id = old
            .item_id
            .as_ref()
            .and_then(|id| item_map.get(id))
            .cloned();
        m.items_touched = old
            .items_touched
            .iter()
            .filter_map(|id| item_map.get(id).cloned())
            .collect();
        m.round_id = old
            .round_id
            .as_ref()
            .and_then(|id| round_map.get(id))
            .cloned();
        if m.kind == MessageKind::Reply && m.item_id.is_none() {
            m.topic_id = None;
            m.round_id = None;
        }
        let source_target = if old.kind == MessageKind::Reply && old.item_id.is_none() {
            old.origin
                .as_ref()
                .ok_or_else(|| {
                    core(
                        CoreErrorCode::CorruptSession,
                        "Copied Reply has no source provenance",
                    )
                })?
                .source_target
                .clone()
        } else {
            MessageSourceTarget {
                project_id: source.project_id.clone(),
                session_id: source.id.clone(),
                topic_id: old.topic_id.clone(),
                item_id: old.item_id.clone(),
                round_id: old.round_id.clone(),
            }
        };
        let identity = old
            .binding_id
            .as_ref()
            .and_then(|id| source.bindings.0.get(id));
        m.origin = Some(MessageOrigin {
            source_target,
            project_id: source.project_id.clone(),
            session_id: source.id.clone(),
            topic_id: params.source_topic_id.clone(),
            entity_id: old.id.clone(),
            source_revision: source.revision,
            author: old.author.clone(),
            binding_id: old.binding_id.clone(),
            adapter_id: old
                .origin
                .as_ref()
                .and_then(|o| o.adapter_id.clone())
                .or_else(|| identity.map(|b| b.adapter_id.clone())),
            external_session_id: old
                .origin
                .as_ref()
                .and_then(|o| o.external_session_id.clone())
                .or_else(|| identity.map(|b| b.external_session_id.clone())),
        });
        target.messages.push(m);
    }
    for old in rounds {
        let mut r = old.clone();
        r.id = round_map[&old.id].clone();
        r.item_id = item_map[&old.item_id].clone();
        r.opened_message_id = message_map[&old.opened_message_id].clone();
        r.owner_message_ids = old
            .owner_message_ids
            .iter()
            .map(|id| message_map[id].clone())
            .collect();
        r.agent_message_ids = old
            .agent_message_ids
            .iter()
            .map(|id| message_map[id].clone())
            .collect();
        r.fork_item_ids = old
            .fork_item_ids
            .iter()
            .map(|id| item_map[id].clone())
            .collect();
        r.origin = Some(RoundOrigin {
            project_id: source.project_id.clone(),
            session_id: source.id.clone(),
            topic_id: params.source_topic_id.clone(),
            entity_id: old.id.clone(),
            source_revision: source.revision,
        });
        target.rounds.0.insert(r.id.clone(), r);
    }
    for old in answers {
        let mut a = old.clone();
        a.id = answer_map[&old.id].clone();
        a.seq = target.counters.next_answer;
        target.counters.next_answer = increment(a.seq)?;
        a.item_id = item_map[&old.item_id].clone();
        a.message_id = message_map[&old.message_id].clone();
        a.supersedes_answer_id = old
            .supersedes_answer_id
            .as_ref()
            .map(|id| answer_map[id].clone());
        target.answers.push(a);
    }
    for old in ordered {
        let mut item = old.clone();
        item.id = item_map[&old.id].clone();
        item.topic_id = topic_id.clone();
        item.parent = old.parent.as_ref().map(|id| item_map[id].clone());
        if item.parent.is_none() {
            item.ordinal =
                PositiveSafeInteger::new(item.id.as_str().parse().expect("allocated root"))
                    .unwrap();
        }
        item.created_message_id = message_map[&old.created_message_id].clone();
        item.updated_message_ids = old
            .updated_message_ids
            .iter()
            .map(|id| message_map[id].clone())
            .collect();
        item.current_round_id = old
            .current_round_id
            .as_ref()
            .map(|id| round_map[id].clone());
        item.source_round_id = old.source_round_id.as_ref().map(|id| round_map[id].clone());
        item.replaced_by = old
            .replaced_by
            .as_ref()
            .and_then(|id| item_map.get(id))
            .cloned();
        if matches!(item.owner, ItemOwner::Agent { .. }) {
            item.owner = ItemOwner::Agent {
                binding_id: params.target_binding_id.clone(),
            };
        }
        if item.recipient_binding_id.is_some() {
            item.recipient_binding_id = Some(params.target_binding_id.clone());
        }
        for h in &mut item.status_history {
            h.cause_message_id = message_map[&h.cause_message_id].clone();
            h.previous_replaced_by = h
                .previous_replaced_by
                .as_ref()
                .map(|id| item_map.get(id).unwrap_or(id).clone());
        }
        if let ContinueCopyAction::ImportedDrop { outcome, why, .. } = &transforms
            .iter()
            .find(|a| a.source_item_id == old.id)
            .expect("all items")
            .action
        {
            item.status_history.push(StatusHistoryEntry {
                old_status: old.status.clone(),
                new_status: ItemStatus::Dropped,
                previous_outcome: old.outcome.clone(),
                previous_why: old.why.clone(),
                previous_replaced_by: old.replaced_by.clone(),
                cause_message_id: import_message_id.clone().expect("transformation message"),
                at: at.clone(),
                binding_id: None,
                handled_through_message_number: NonnegativeSafeInteger::new(0).unwrap(),
                reason: Some(why.clone()),
            });
            item.status = ItemStatus::Dropped;
            item.outcome = Some(outcome.clone());
            item.why = Some(why.clone());
            item.replaced_by = None;
        }
        item.origin = Some(ItemOrigin {
            project_id: source.project_id.clone(),
            session_id: source.id.clone(),
            topic_id: params.source_topic_id.clone(),
            entity_id: old.id.clone(),
            source_revision: source.revision,
        });
        target.items.0.insert(item.id.clone(), item);
    }
    if let Some(id) = import_message_id {
        let number = target.counters.next_message;
        target.counters.next_message = increment(number)?;
        target.messages.push(Message{id,number,author:MessageAuthor::System,kind:MessageKind::Lifecycle,body:"Imported external replacements as Dropped; original replacement links and outcomes remain in source-qualified status history.".into(),created_at:at.clone(),item_id:None,topic_id:Some(topic_id.clone()),items_touched:drops.iter().map(|a|item_map[&a.source_item_id].clone()).collect(),binding_id:None,input_id:None,attempt_id:None,host_turn_id:None,round_id:None,origin:None});
    }
    let continuation = ContinuationReceipt {
        operation_id: operation_id.clone(),
        source_project_id: source.project_id.clone(),
        source_session_id: source.id.clone(),
        source_topic_id: params.source_topic_id.clone(),
        source_revision: source.revision,
        source_sha256: params.source_sha256.clone(),
        target_topic_id: topic_id.clone(),
        target_input_id: input_id.clone(),
        item_id_map: UniqueMap(item_map),
        message_id_map: UniqueMap(message_map),
        round_id_map: UniqueMap(round_map),
        answer_id_map: UniqueMap(answer_map),
        summary: params.summary.clone(),
        confirmed_at: at.clone(),
    };
    let input = Input {
        id: input_id.clone(),
        seq: target.counters.next_input,
        binding_id: params.target_binding_id.clone(),
        kind: InputKind::Continue,
        target: InputTarget {
            topic_id: topic_id.clone(),
            item_id: None,
        },
        message_id: handoff_message_id.clone(),
        answer_id: None,
        created_at: at.clone(),
        expected_question_revision: None,
        payload: InputPayload {
            text: params.summary.clone(),
            intent: InputKind::Continue,
            target_snapshot: InputTargetSnapshot {
                topic_name: topic.name.clone(),
                item_question: None,
                question_revision: None,
                ask: None,
                options: vec![],
            },
            selected_option_id: None,
            context: InputContext {
                message_ids: vec![],
                item_ids: vec![],
                round_id: None,
                continuation_operation_id: Some(operation_id.clone()),
            },
            removed: None,
        },
        state: InputState::Queued,
        attempts: vec![],
        active_attempt_id: None,
        resolution_history: vec![],
    };
    target.counters.next_input = increment(input.seq)?;
    let number = target.counters.next_message;
    target.counters.next_message = increment(number)?;
    target.messages.push(Message {
        id: handoff_message_id,
        number,
        author: MessageAuthor::Owner,
        kind: MessageKind::OwnerInput,
        body: params.summary.clone(),
        created_at: at.clone(),
        item_id: None,
        topic_id: Some(topic_id.clone()),
        items_touched: vec![],
        binding_id: Some(params.target_binding_id.clone()),
        input_id: Some(input_id.clone()),
        attempt_id: None,
        host_turn_id: None,
        round_id: None,
        origin: None,
    });
    target.topics.0.insert(topic_id, topic);
    target.inputs.0.insert(input_id.clone(), input);
    target
        .continuations
        .0
        .insert(operation_id.clone(), continuation.clone());
    target.updated_at = at.clone();
    // Capacity check only: a UUID-length stand-in sizes the future attempt id.
    crate::delivery::format::body(target, &target.inputs.0[&input_id], &input_id)?;
    Ok(SavedReceiptData::Continuation { continuation })
}
