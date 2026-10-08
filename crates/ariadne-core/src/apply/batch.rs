use super::{
    error::{core, history, transition},
    scope,
};
use crate::*;
use ariadne_domain::{
    history::{self as history_api, AgentHistoryContext, ReplyDraft},
    models::*,
    transitions::{transition_item, ItemChange, TransitionContext},
};
use std::collections::BTreeSet;

pub(super) fn execute(
    session: &mut Session,
    context: &AgentContext,
    request: &ApplyRequest,
    allocate: &mut impl FnMut() -> UuidV4,
    at: &UtcMillis,
) -> Result<SavedReceiptData, CoreError> {
    scope::authorize(session, context, request)?;
    let original_items = session.items.0.keys().cloned().collect();
    let occupied = session
        .inputs
        .0
        .keys()
        .chain(session.rounds.0.keys())
        .chain(session.bindings.0.keys())
        .chain(session.topics.0.keys())
        .chain(session.operation_receipts.0.keys())
        .cloned()
        .chain(session.messages.iter().map(|m| m.id.clone()))
        .chain(session.answers.iter().map(|a| a.id.clone()))
        .chain(
            session
                .inputs
                .0
                .values()
                .flat_map(|i| i.attempts.iter().map(|a| a.id.clone())),
        )
        .chain([session.id.clone(), session.project_id.clone()])
        .collect();
    let mut batch = Batch {
        context,
        request,
        allocate,
        at,
        original_items,
        occupied,
        refs: UniqueMap(Default::default()),
        touched: BTreeSet::new(),
        topics: BTreeSet::new(),
        activity: None,
    };
    if !request.summary.trim().is_empty()
        || !request.operations.is_empty()
        || request.input_result.is_some()
    {
        let body = if request.summary.trim().is_empty() {
            "Agent applied domain changes.".into()
        } else {
            request.summary.clone()
        };
        batch.activity = Some(batch.message(session, MessageKind::Activity, body)?);
    }
    for operation in &request.operations {
        batch.operation(session, operation)?;
    }
    if request.input_result.is_some() {
        super::result::commit(session, &batch)?;
    }
    // Batch activity is shared provenance, never a targeted conversation reply.
    if let Some(id) = &batch.activity {
        session
            .messages
            .iter_mut()
            .find(|m| &m.id == id)
            .unwrap()
            .items_touched = batch.touched.iter().cloned().collect();
        for id in &batch.touched {
            let item = session.items.0.get_mut(id).unwrap();
            if !item
                .updated_message_ids
                .contains(batch.activity.as_ref().unwrap())
            {
                item.updated_message_ids
                    .push(batch.activity.clone().unwrap());
            }
        }
    }
    ariadne_domain::validation::validate_session_items(session).map_err(|e| {
        core(
            CoreErrorCode::InvalidArgument,
            format!("Invalid candidate item/tree: {e}"),
        )
    })?;
    history_api::validate_session_history(session).map_err(history)?;
    session.updated_at = at.clone();
    let messages = session
        .messages
        .iter()
        .filter(|m| {
            batch.activity.as_ref() == Some(&m.id)
                || batch
                    .refs
                    .0
                    .values()
                    .any(|r| matches!(r, AllocatedRef::Message { id } if id == &m.id))
        })
        .map(|m| MessageIdentity {
            id: m.id.clone(),
            number: m.number,
        })
        .collect();
    let result_state = request
        .input_result
        .as_ref()
        .map(|_| ResultState::Committed);
    let join_state = request
        .source_input_id
        .as_ref()
        .map(|id| session.inputs.0[id].state.clone());
    Ok(SavedReceiptData::Apply {
        allocated_refs: batch.refs,
        messages,
        item_revisions: UniqueMap(
            batch
                .touched
                .into_iter()
                .map(|id| {
                    let revision = session.items.0[&id].revision;
                    (id, revision)
                })
                .collect(),
        ),
        topic_revisions: UniqueMap(
            batch
                .topics
                .into_iter()
                .map(|id| {
                    let revision = session.topics.0[&id].revision;
                    (id, revision)
                })
                .collect(),
        ),
        input_result_state: result_state,
        queue_join_state: join_state,
    })
}

pub(super) struct Batch<'a, F> {
    pub context: &'a AgentContext,
    pub request: &'a ApplyRequest,
    allocate: &'a mut F,
    pub at: &'a UtcMillis,
    original_items: BTreeSet<ItemRef>,
    occupied: BTreeSet<UuidV4>,
    pub refs: UniqueMap<RequestRef, AllocatedRef>,
    touched: BTreeSet<ItemRef>,
    topics: BTreeSet<UuidV4>,
    activity: Option<UuidV4>,
}
impl<F: FnMut() -> UuidV4> Batch<'_, F> {
    /// Agent writes to an archived topic refuse with the stable reason
    /// `topic_archived`; the owner restores the topic to reopen it.
    fn archived(&self, message: &str) -> CoreError {
        let mut error = core(CoreErrorCode::InvalidTransition, message);
        error.details = Some(scope::reason(self.context, BarrierReason::TopicArchived));
        error
    }
    fn fresh(&mut self) -> Result<UuidV4, CoreError> {
        let id = (self.allocate)();
        if !self.occupied.insert(id.clone()) {
            return Err(core(
                CoreErrorCode::InvalidArgument,
                "Native allocator returned an occupied ID",
            ));
        }
        Ok(id)
    }
    fn save_ref(&mut self, key: &RequestRef, value: AllocatedRef) -> Result<(), CoreError> {
        if self.refs.0.insert(key.clone(), value).is_some() {
            return Err(core(
                CoreErrorCode::InvalidRef,
                "Request-local ref was already allocated",
            ));
        }
        Ok(())
    }
    pub fn item_ref(&self, reference: &EntityRef) -> Result<ItemRef, CoreError> {
        match reference {
            EntityRef::Existing(r) => Ok(r.id.clone()),
            EntityRef::Local(r) => match self.refs.0.get(&r.r#ref) {
                Some(AllocatedRef::Item { id }) => Ok(id.clone()),
                _ => Err(core(
                    CoreErrorCode::InvalidRef,
                    "Item ref must identify an earlier item allocation",
                )),
            },
        }
    }
    pub fn uuid_ref(&self, reference: &UuidRef, topic: bool) -> Result<UuidV4, CoreError> {
        match reference {
            UuidRef::Existing(r) => Ok(r.id.clone()),
            UuidRef::Local(r) => match self.refs.0.get(&r.r#ref) {
                Some(AllocatedRef::Topic { id }) if topic => Ok(id.clone()),
                Some(AllocatedRef::Message { id }) if !topic => Ok(id.clone()),
                _ => Err(core(
                    CoreErrorCode::InvalidRef,
                    "UUID ref has wrong kind or is not an earlier allocation",
                )),
            },
        }
    }
    fn target(&mut self, session: &Session, id: &ItemRef) -> Result<(), CoreError> {
        let item = session
            .items
            .0
            .get(id)
            .ok_or_else(|| core(CoreErrorCode::InvalidRef, "Item does not exist"))?;
        if session.topics.0[&item.topic_id].archived_at.is_some() {
            return Err(self.archived(
                "The owner archived this item's topic; leave it as it is unless they restore it",
            ));
        }
        if self.original_items.contains(id)
            && !self.request.expected_item_revisions.0.contains_key(id)
        {
            return Err(scope::conflict(
                session,
                "Every touched existing item requires its original expected revision",
            ));
        }
        self.touched.insert(id.clone());
        Ok(())
    }
    fn message(
        &mut self,
        session: &mut Session,
        kind: MessageKind,
        body: String,
    ) -> Result<UuidV4, CoreError> {
        let id = self.fresh()?;
        let host_turn_id = self
            .request
            .source_input_id
            .as_ref()
            .and_then(|input| {
                session.inputs.0[input]
                    .attempts
                    .iter()
                    .find(|a| Some(&a.id) == self.request.attempt_id.as_ref())
            })
            .and_then(|a| a.host_turn_id.clone());
        let message = Message {
            id: id.clone(),
            number: session.counters.next_message,
            author: MessageAuthor::Agent,
            kind,
            body,
            created_at: self.at.clone(),
            item_id: None,
            topic_id: None,
            items_touched: vec![],
            binding_id: Some(self.context.binding_id().clone()),
            input_id: self.request.source_input_id.clone(),
            attempt_id: self.request.attempt_id.clone(),
            host_turn_id,
            round_id: None,
            origin: None,
        };
        session.counters.next_message = increment(session.counters.next_message)?;
        session.messages.push(message);
        Ok(id)
    }
    fn cause(&self, session: &mut Session, id: &ItemRef) -> UuidV4 {
        let cause = self.activity.clone().expect("mutation has activity");
        let message = session.messages.iter_mut().find(|m| m.id == cause).unwrap();
        if !message.items_touched.contains(id) {
            message.items_touched.push(id.clone());
        }
        cause
    }
    fn change(
        &mut self,
        session: &mut Session,
        id: &ItemRef,
        change: ItemChange,
    ) -> Result<(), CoreError> {
        self.target(session, id)?;
        let cause = self.cause(session, id);
        let context = TransitionContext {
            binding_id: self.context.binding_id().clone(),
            generation: self.context.generation().clone(),
            cause_message_id: cause.clone(),
            at: self.at.clone(),
            handled_through_message_number: self
                .context
                .read_scope()
                .issued_through_message_number(),
            expected_revision: session.items.0[id].revision,
            expected_question_revision: None,
        };
        let candidate = transition_item(session, id, &change, &context).map_err(transition)?;
        if matches!(change, ItemChange::Ask { .. }) {
            *session = history_api::open_ask_round(session, candidate, &cause, self.at.clone())
                .map_err(history)?;
        } else {
            session.items.0.insert(id.clone(), candidate);
        }
        Ok(())
    }
    fn operation(&mut self, session: &mut Session, op: &Operation) -> Result<(), CoreError> {
        match op {
            Operation::TopicAdd { r#ref, name, short } => {
                let short = short_label(short.as_deref())?;
                let id = self.fresh()?;
                let order = session.counters.next_topic_order;
                session.counters.next_topic_order = increment(order)?;
                session.topics.0.insert(
                    id.clone(),
                    Topic {
                        id: id.clone(),
                        name: name.clone(),
                        short,
                        order,
                        revision: one(),
                        created_at: self.at.clone(),
                        archived_at: None,
                        origin: None,
                    },
                );
                self.topics.insert(id.clone());
                self.save_ref(r#ref, AllocatedRef::Topic { id })?;
            }
            Operation::ItemAdd(draft) => self.add(session, draft)?,
            Operation::ItemEdit { item, patch } => {
                let id = self.item_ref(item)?;
                self.change(
                    session,
                    &id,
                    ItemChange::Edit {
                        question: patch.question.clone(),
                        item_type: patch.item_type.clone(),
                        note: patch.note.clone(),
                        links: patch.links.clone(),
                        short: patch.short.clone(),
                    },
                )?;
            }
            Operation::ItemAsk {
                item,
                ask,
                options,
                recipient_binding_id,
            } => {
                let id = self.item_ref(item)?;
                let round_id = self.fresh()?;
                self.change(
                    session,
                    &id,
                    ItemChange::Ask {
                        ask: ask.clone(),
                        options: options.clone(),
                        recipient_binding_id: recipient_binding_id.clone(),
                        round_id,
                    },
                )?;
            }
            Operation::ItemStatus {
                item,
                status,
                outcome,
                why,
                reason,
            } => {
                let id = self.item_ref(item)?;
                self.change(
                    session,
                    &id,
                    ItemChange::Status {
                        status: status.clone(),
                        outcome: outcome.clone(),
                        why: why.clone(),
                        reason: reason.clone(),
                    },
                )?;
            }
            Operation::ItemReplace {
                item,
                replacement,
                outcome,
                why,
            } => {
                let id = self.item_ref(item)?;
                let replacement = self.item_ref(replacement)?;
                self.change(
                    session,
                    &id,
                    ItemChange::Replace {
                        replacement,
                        outcome: outcome.clone(),
                        why: why.clone(),
                    },
                )?;
            }
            Operation::Reply {
                r#ref,
                item,
                text,
                round_id,
            } => {
                let id = self.item_ref(item)?;
                self.target(session, &id)?;
                let message_id = self.fresh()?;
                *session = history_api::append_reply(
                    session,
                    &AgentHistoryContext {
                        binding_id: self.context.binding_id().clone(),
                        generation: self.context.generation().clone(),
                        source_input_id: self.request.source_input_id.clone(),
                        attempt_id: self.request.attempt_id.clone(),
                    },
                    ReplyDraft {
                        message_id: message_id.clone(),
                        item_id: id,
                        text: text.clone(),
                        round_id: round_id.clone(),
                        at: self.at.clone(),
                    },
                )
                .map_err(history)?;
                self.save_ref(r#ref, AllocatedRef::Message { id: message_id })?;
            }
            Operation::RoundClose { round_id } => {
                let id = session
                    .rounds
                    .0
                    .get(round_id)
                    .ok_or_else(|| core(CoreErrorCode::InvalidRef, "Round does not exist"))?
                    .item_id
                    .clone();
                self.target(session, &id)?;
                self.cause(session, &id);
                *session = history_api::close_round(session, round_id, self.at.clone())
                    .map_err(history)?;
            }
        }
        Ok(())
    }
    fn add(&mut self, session: &mut Session, draft: &ItemAddOperation) -> Result<(), CoreError> {
        let topic_id = self.uuid_ref(&draft.topic, true)?;
        let topic = session
            .topics
            .0
            .get(&topic_id)
            .ok_or_else(|| core(CoreErrorCode::InvalidRef, "Topic does not exist"))?;
        if topic.archived_at.is_some() {
            return Err(self.archived(
                "The owner archived this topic; add the item to an active topic instead",
            ));
        }
        let parent = draft
            .parent
            .as_ref()
            .map(|r| self.item_ref(r))
            .transpose()?;
        let ordinal = if let Some(id) = &parent {
            self.target(session, id)?;
            if session.items.0[id].topic_id != topic_id {
                return Err(core(
                    CoreErrorCode::InvalidRef,
                    "Parent belongs to a different topic",
                ));
            }
            let cause = self.cause(session, id);
            let item = session.items.0.get_mut(id).unwrap();
            let ordinal = item.next_child;
            item.next_child = increment(ordinal)?;
            item.revision = increment(item.revision)?;
            item.updated_at = self.at.clone();
            if !item.updated_message_ids.contains(&cause) {
                item.updated_message_ids.push(cause);
            }
            ordinal
        } else {
            let ordinal = session.counters.next_root;
            session.counters.next_root = increment(ordinal)?;
            ordinal
        };
        let id = ItemRef::new(parent.as_ref().map_or_else(
            || ordinal.value().to_string(),
            |p| format!("{}.{}", p.as_str(), ordinal.value()),
        ))
        .map_err(|_| {
            core(
                CoreErrorCode::CapacityExceeded,
                "New item identity exceeds the canonical bound",
            )
        })?;
        if session.items.0.contains_key(&id) {
            return Err(core(
                CoreErrorCode::InvalidRef,
                "Allocated item ID already exists",
            ));
        }
        let waiting = draft.status == ItemStatus::WaitingOnMe;
        if waiting && draft.owner != (ItemOwner::Me {}) {
            return Err(core(
                CoreErrorCode::InvalidArgument,
                "A waiting item must be owned by me",
            ));
        }
        let round_id = if waiting { Some(self.fresh()?) } else { None };
        let replaced_by = draft
            .replaced_by
            .as_ref()
            .map(|r| self.item_ref(r))
            .transpose()?;
        let source_round = draft.source_round_id.clone().or_else(|| {
            self.request.source_input_id.as_ref().and_then(|input_id| {
                let input = &session.inputs.0[input_id];
                if input.target.item_id == parent {
                    session
                        .messages
                        .iter()
                        .find(|m| m.id == input.message_id)
                        .and_then(|m| m.round_id.clone())
                } else {
                    None
                }
            })
        });
        let cause = self.cause(session, &id);
        let item = Item {
            id: id.clone(),
            ordinal,
            topic_id,
            parent,
            question: draft.question.clone(),
            short: short_label(draft.short.as_deref())?,
            item_type: draft.item_type.clone(),
            status: draft.status.clone(),
            owner: draft.owner.clone(),
            revision: one(),
            question_revision: one(),
            next_child: one(),
            ask: draft.ask.clone(),
            note: draft.note.clone(),
            options: draft.options.clone().unwrap_or_default(),
            links: draft.links.clone().unwrap_or_default(),
            outcome: draft.outcome.clone(),
            why: draft.why.clone(),
            replaced_by,
            created_at: self.at.clone(),
            updated_at: self.at.clone(),
            created_message_id: cause.clone(),
            updated_message_ids: vec![cause.clone()],
            status_history: vec![],
            waiting_since: waiting.then(|| self.at.clone()),
            recipient_binding_id: waiting.then(|| self.context.binding_id().clone()),
            current_round_id: round_id.clone(),
            source_round_id: source_round.clone(),
            origin: None,
        };
        if let Some(round_id) = round_id {
            session.rounds.0.insert(
                round_id.clone(),
                Round {
                    id: round_id,
                    item_id: id.clone(),
                    ordinal: one(),
                    opened_message_id: cause,
                    question_snapshot: item.question.clone(),
                    ask_snapshot: item.ask.clone(),
                    options_snapshot: item.options.clone(),
                    question_revision: one(),
                    owner_message_ids: vec![],
                    agent_message_ids: vec![],
                    result_input_ids: vec![],
                    fork_item_ids: vec![],
                    closed_at: None,
                    origin: None,
                },
            );
        }
        self.touched.insert(id.clone());
        session.items.0.insert(id.clone(), item);
        if let Some(round) = source_round {
            *session = history_api::link_round_fork(session, &round, &id, self.at.clone())
                .map_err(history)?;
        }
        self.save_ref(&draft.r#ref, AllocatedRef::Item { id })
    }
}
pub(super) fn increment(value: PositiveSafeInteger) -> Result<PositiveSafeInteger, CoreError> {
    value
        .value()
        .checked_add(1)
        .and_then(|v| PositiveSafeInteger::new(v).ok())
        .ok_or_else(|| {
            core(
                CoreErrorCode::CapacityExceeded,
                "Canonical counter reached its safe integer limit",
            )
        })
}
fn one() -> PositiveSafeInteger {
    PositiveSafeInteger::new(1).unwrap()
}
/// A new topic or item stores the trimmed label; `None` stores no label.
fn short_label(value: Option<&str>) -> Result<Option<String>, CoreError> {
    value
        .map(|value| {
            ariadne_domain::validation::normalize_short_label(value, "short").map_err(|e| {
                core(
                    CoreErrorCode::InvalidArgument,
                    format!("Invalid short label: {e}"),
                )
            })
        })
        .transpose()
}
