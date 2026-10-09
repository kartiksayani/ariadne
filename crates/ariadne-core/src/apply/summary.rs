//! The compact apply receipt: what an agent needs to edit its work later without
//! re-reading. Built from the saved receipt plus the session's labels.
use super::error::core;
use crate::*;
use ariadne_domain::models::*;
use serde::Serialize;
use std::collections::BTreeSet;

/// Every topic and item the request created or changed. `revision` is the
/// value after the request; use it as the next `expected_*_revisions` entry.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ApplySummary {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub agent_removals: Vec<AgentRemoval>,
    pub op_id: UuidV4,
    pub session_revision: PositiveSafeInteger,
    pub topics: Vec<TopicChange>,
    pub items: Vec<ItemChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_result: Option<ResultState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue: Option<InputState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pruned_related: Option<UniqueMap<ItemRef, Vec<ItemRef>>>,
}

/// `number` is the topic's creation order in the session.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TopicChange {
    pub id: UuidV4,
    pub number: PositiveSafeInteger,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short: Option<String>,
    pub revision: PositiveSafeInteger,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub created: bool,
}

/// An item's `id` is its number, such as `3` or `3.2`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ItemChange {
    pub id: ItemRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short: Option<String>,
    pub revision: PositiveSafeInteger,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub created: bool,
}

/// Compact view of an apply receipt. `session` supplies labels and numbers; the
/// revisions come from the receipt, so a later edit does not rewrite them.
pub fn summarize(session: &Session, receipt: &SavedReceipt) -> Result<ApplySummary, CoreError> {
    let SavedReceiptData::Apply {
        agent_removals,
        allocated_refs,
        item_revisions,
        topic_revisions,
        input_result_state,
        queue_join_state,
        pruned_related,
        ..
    } = &receipt.data
    else {
        return Err(core(
            CoreErrorCode::InvalidArgument,
            "Only an apply receipt has a compact form",
        ));
    };
    let mut new_topics = BTreeSet::new();
    let mut new_items = BTreeSet::new();
    for allocated in allocated_refs.0.values() {
        match allocated {
            AllocatedRef::Topic { id } => {
                new_topics.insert(id.clone());
            }
            AllocatedRef::Item { id } => {
                new_items.insert(id.clone());
            }
            AllocatedRef::Message { .. } | AllocatedRef::Round { .. } => {}
        }
    }
    let missing = || {
        core(
            CoreErrorCode::NotFound,
            "A topic or item in the receipt is no longer in the session",
        )
    };
    let mut topics = topic_revisions
        .0
        .iter()
        .map(|(id, revision)| {
            let topic = session.topics.0.get(id).ok_or_else(missing)?;
            Ok(TopicChange {
                id: id.clone(),
                number: topic.order,
                short: topic.short.clone(),
                revision: *revision,
                created: new_topics.contains(id),
            })
        })
        .collect::<Result<Vec<_>, CoreError>>()?;
    topics.sort_by_key(|topic| topic.number);
    let mut items = item_revisions
        .0
        .iter()
        .map(|(id, revision)| {
            let item = session.items.0.get(id).ok_or_else(missing)?;
            Ok(ItemChange {
                id: id.clone(),
                short: item.short.clone(),
                revision: *revision,
                created: new_items.contains(id),
            })
        })
        .collect::<Result<Vec<_>, CoreError>>()?;
    items.sort_by_key(|item| number_path(&item.id));
    Ok(ApplySummary {
        agent_removals: agent_removals.clone(),
        op_id: receipt.operation_id.clone(),
        session_revision: receipt.revision,
        topics,
        items,
        input_result: input_result_state.clone(),
        queue: queue_join_state.clone(),
        pruned_related: pruned_related.clone(),
    })
}

/// `1.10` sorts after `1.2`.
fn number_path(id: &ItemRef) -> Vec<u64> {
    id.as_str()
        .split('.')
        .map(|part| part.parse().unwrap_or(u64::MAX))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_numbers_sort_numerically_not_as_text() {
        let mut ids: Vec<ItemRef> = ["1.10", "2", "1.2", "10", "1"]
            .iter()
            .map(|id| ItemRef::new(*id).unwrap())
            .collect();
        ids.sort_by_key(number_path);
        let sorted: Vec<_> = ids.iter().map(ItemRef::as_str).collect();
        assert_eq!(sorted, ["1", "1.2", "1.10", "2", "10"]);
    }
}
