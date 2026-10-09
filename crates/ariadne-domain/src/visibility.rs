//! Recoverable removal follows actual tree links, independently of status.
use crate::models::*;
use std::collections::BTreeSet;

pub fn topic_is_removed(_session: &Session, topic: &Topic) -> bool {
    topic.removed_at.is_some()
}

pub fn item_is_removed(session: &Session, item: &Item) -> bool {
    if session
        .topics
        .0
        .get(&item.topic_id)
        .is_some_and(|topic| topic_is_removed(session, topic))
    {
        return true;
    }
    let mut seen = BTreeSet::new();
    let mut current = item;
    loop {
        if current.removed_at.is_some() {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn seed() -> Session {
        serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json")).unwrap()
    }

    #[test]
    fn removal_inherits_actual_parent_links_and_topic_without_changing_status() {
        let mut session = seed();
        let root = session.items.0.values().next().unwrap().clone();
        let mut child = root.clone();
        child.id = ItemRef::new("1.1").unwrap();
        child.parent = Some(root.id.clone());
        assert!(!item_is_removed(&session, &child));
        session.items.0.get_mut(&root.id).unwrap().removed_at = Some(session.updated_at.clone());
        assert!(item_is_removed(&session, &child));
        session.items.0.get_mut(&root.id).unwrap().removed_at = None;
        session.topics.0.get_mut(&root.topic_id).unwrap().removed_at =
            Some(session.updated_at.clone());
        assert!(item_is_removed(&session, &child));
        assert!(topic_is_removed(
            &session,
            &session.topics.0[&root.topic_id]
        ));
        assert_eq!(session.items.0[&root.id].status, root.status);
    }

    #[test]
    fn malformed_parent_cycle_terminates_without_guessing_from_item_number() {
        let mut session = seed();
        let id = session.items.0.keys().next().unwrap().clone();
        session.items.0.get_mut(&id).unwrap().parent = Some(id.clone());
        assert!(!item_is_removed(&session, &session.items.0[&id]));
    }

    #[test]
    fn removal_requires_matching_saved_lifecycle_provenance() {
        let mut session = seed();
        let item = session.items.0.values_mut().next().unwrap();
        item.removed_at = Some(session.updated_at.clone());
        assert!(crate::validation::validate_session_items(&session).is_err());
        let item = session.items.0.values_mut().next().unwrap();
        item.removed_by = Some(AgentRemovalSource {
            binding_id: session.bindings.0.keys().next().unwrap().clone(),
            message_id: session.messages[0].id.clone(),
        });
        assert!(crate::validation::validate_session_items(&session).is_err());
    }
}
