//! Recoverable agent deletion preserves history and abandons pending delivery.
use super::{
    batch::{increment, Batch},
    error::core,
    scope,
};
use crate::*;
use ariadne_domain::{
    models::*,
    visibility::{item_is_removed, topic_is_removed},
};
use std::collections::BTreeSet;

impl<F: FnMut() -> UuidV4> Batch<'_, F> {
    pub(super) fn delete_item(
        &mut self,
        session: &mut Session,
        reference: &EntityRef,
    ) -> Result<(), CoreError> {
        let id = self.item_ref(reference)?;
        let item = session
            .items
            .0
            .get(&id)
            .ok_or_else(|| core(CoreErrorCode::InvalidRef, "Item does not exist"))?;
        if session.topics.0[&item.topic_id].archived_at.is_some() {
            return Err(self.archived("Restore the archived topic before deleting its work."));
        }
        if self.original_items.contains(&id)
            && !self.request.expected_item_revisions.0.contains_key(&id)
        {
            return Err(scope::conflict(
                session,
                "Deleting an existing item requires its expected revision",
            ));
        }
        if item_is_removed(session, item) {
            return Ok(());
        }
        let topic_id = item.topic_id.clone();
        let item_ids = session
            .items
            .0
            .values()
            .filter(|item| descendant(session, item, &id))
            .map(|item| item.id.clone())
            .collect();
        let revision = increment(item.revision)?;
        let notice = self.removal_notice(session, topic_id, Some(id.clone()), item_ids)?;
        let item = session.items.0.get_mut(&id).unwrap();
        item.removed_at = Some(self.at.clone());
        item.removed_by = Some(AgentRemovalSource {
            binding_id: self.context.binding_id().clone(),
            message_id: notice,
        });
        item.revision = revision;
        item.updated_at = self.at.clone();
        self.touched.insert(id);
        Ok(())
    }

    pub(super) fn delete_topic(
        &mut self,
        session: &mut Session,
        reference: &UuidRef,
    ) -> Result<(), CoreError> {
        let id = self.uuid_ref(reference, true)?;
        let topic = session
            .topics
            .0
            .get(&id)
            .ok_or_else(|| core(CoreErrorCode::InvalidRef, "Topic does not exist"))?;
        if topic.archived_at.is_some() {
            return Err(self.archived("Restore the archived topic before deleting it."));
        }
        if !self.topics.contains(&id) && !self.request.expected_topic_revisions.0.contains_key(&id)
        {
            return Err(scope::conflict(
                session,
                "Deleting an existing topic requires its expected revision",
            ));
        }
        if topic_is_removed(session, topic) {
            return Ok(());
        }
        let revision = increment(topic.revision)?;
        let item_ids = session
            .items
            .0
            .values()
            .filter(|item| item.topic_id == id)
            .map(|item| item.id.clone())
            .collect();
        let notice = self.removal_notice(session, id.clone(), None, item_ids)?;
        let topic = session.topics.0.get_mut(&id).unwrap();
        topic.removed_at = Some(self.at.clone());
        topic.removed_by = Some(AgentRemovalSource {
            binding_id: self.context.binding_id().clone(),
            message_id: notice,
        });
        topic.revision = revision;
        self.topics.insert(id);
        Ok(())
    }

    fn removal_notice(
        &mut self,
        session: &mut Session,
        topic_id: UuidV4,
        item_id: Option<ItemRef>,
        item_ids: Vec<ItemRef>,
    ) -> Result<UuidV4, CoreError> {
        let waiting = item_ids
            .iter()
            .filter(|id| {
                let item = &session.items.0[*id];
                !item_is_removed(session, item)
                    && item.status == ItemStatus::WaitingOnMe
                    && crate::queries::question_unanswered(session, item)
            })
            .count();
        let message_id = self.message(
            session,
            MessageKind::Lifecycle,
            "Work moved to the bin.".into(),
        )?;
        let message = session
            .messages
            .iter_mut()
            .find(|m| m.id == message_id)
            .unwrap();
        message.author = MessageAuthor::System;
        message.topic_id = Some(topic_id.clone());
        message.item_id = item_id.clone();
        message.items_touched = item_ids.clone();
        self.agent_removals.push(AgentRemoval {
            topic_id,
            item_id,
            message_id: message_id.clone(),
            item_ids,
            waiting_questions: NonnegativeSafeInteger::new(waiting as u64)
                .expect("bounded item count"),
            cancelled_input_ids: vec![],
        });
        Ok(message_id)
    }

    // Operations and result linking run first. In particular, deleting the
    // dispatched source cannot seal its attempt before this batch saves its result.
    pub(super) fn cancel_removed_inputs(&mut self, session: &mut Session) {
        for removal in &mut self.agent_removals {
            let targets: Vec<_> = session
                .inputs
                .0
                .values()
                .filter(|input| {
                    if removal.item_id.is_none() {
                        input.target.topic_id == removal.topic_id
                    } else {
                        input
                            .target
                            .item_id
                            .as_ref()
                            .is_some_and(|id| removal.item_ids.contains(id))
                    }
                })
                .map(|input| (input.id.clone(), input.binding_id.clone()))
                .collect();
            let mut bindings = BTreeSet::new();
            for (id, binding) in targets {
                if crate::delivery_join::abandon(session, &id, CancelCause::AgentRemoved, self.at)
                    == Some(InputState::Cancelled)
                {
                    removal.cancelled_input_ids.push(id);
                }
                bindings.insert(binding);
            }
            for binding in bindings {
                crate::delivery_join::release_barrier(session, &binding);
            }
            let mut body = format!(
                "Agent removed {} {} from {}. Saved in the bin.",
                removal.item_ids.len(),
                if removal.item_ids.len() == 1 {
                    "item"
                } else {
                    "items"
                },
                session.topics.0[&removal.topic_id].name
            );
            if removal.waiting_questions.value() > 0 {
                body.push_str(&format!(
                    " {} waiting {} put away.",
                    removal.waiting_questions.value(),
                    if removal.waiting_questions.value() == 1 {
                        "question"
                    } else {
                        "questions"
                    }
                ));
            }
            if !removal.cancelled_input_ids.is_empty() {
                body.push_str(&format!(
                    " {} pending {} cancelled. Restore keeps cancelled messages cancelled.",
                    removal.cancelled_input_ids.len(),
                    if removal.cancelled_input_ids.len() == 1 {
                        "message"
                    } else {
                        "messages"
                    }
                ));
            }
            session
                .messages
                .iter_mut()
                .find(|m| m.id == removal.message_id)
                .unwrap()
                .body = body;
        }
    }
}

fn descendant(session: &Session, item: &Item, root: &ItemRef) -> bool {
    let mut current = item;
    let mut seen = BTreeSet::new();
    loop {
        if &current.id == root {
            return true;
        }
        if !seen.insert(&current.id) {
            return false;
        }
        let Some(parent) = current
            .parent
            .as_ref()
            .and_then(|id| session.items.0.get(id))
        else {
            return false;
        };
        current = parent;
    }
}
