use super::*;
use std::collections::BTreeMap;

pub(super) struct ItemValidationIndex<'a> {
    max_child_ordinal: BTreeMap<&'a ItemRef, PositiveSafeInteger>,
    message_ids: BTreeSet<&'a UuidV4>,
}

impl<'a> ItemValidationIndex<'a> {
    pub(super) fn new(session: &'a Session) -> Self {
        let mut max_child_ordinal = BTreeMap::new();
        // Index every stored value, including malformed identities. Validation
        // still reports errors in its existing order, using actual parent links.
        for child in session.items.0.values() {
            if let Some(parent) = &child.parent {
                let maximum = max_child_ordinal.entry(parent).or_insert(child.ordinal);
                *maximum = (*maximum).max(child.ordinal);
            }
        }
        Self {
            max_child_ordinal,
            message_ids: session.messages.iter().map(|message| &message.id).collect(),
        }
    }
}

/// Validate a stored or assembled candidate item against its session.
/// All referenced messages/rounds/bindings must already be present. Item identity,
/// parent and topic immutability across edits are enforced by `transition_item`.
pub fn validate_item(session: &Session, item: &Item) -> Result<(), ValidationError> {
    validate_candidate(session, item, true)
}

pub(crate) fn validate_candidate(
    session: &Session,
    item: &Item,
    assembled_round: bool,
) -> Result<(), ValidationError> {
    validate_candidate_indexed(
        session,
        item,
        assembled_round,
        &ItemValidationIndex::new(session),
    )
}

pub(super) fn validate_candidate_indexed(
    session: &Session,
    item: &Item,
    assembled_round: bool,
    validation_index: &ItemValidationIndex<'_>,
) -> Result<(), ValidationError> {
    let path = format!("items.{}", item.id.as_str());
    require(
        session.topics.0.contains_key(&item.topic_id),
        format!("{path}.topic_id"),
        ValidationErrorKind::MissingReference,
    )?;
    walk(session, item, false)?;
    let expected = if let Some(parent_id) = &item.parent {
        let parent = session
            .items
            .0
            .get(parent_id)
            .ok_or_else(|| ValidationError {
                path: format!("{path}.parent"),
                kind: ValidationErrorKind::MissingReference,
            })?;
        require(
            parent.topic_id == item.topic_id,
            format!("{path}.topic_id"),
            ValidationErrorKind::HierarchyMismatch,
        )?;
        require(
            item.ordinal < parent.next_child,
            format!("{path}.ordinal"),
            ValidationErrorKind::CounterNotAhead,
        )?;
        format!("{}.{}", parent.id.as_str(), item.ordinal.value())
    } else {
        require(
            item.ordinal < session.counters.next_root,
            format!("{path}.ordinal"),
            ValidationErrorKind::CounterNotAhead,
        )?;
        item.ordinal.value().to_string()
    };
    require(
        item.id.as_str() == expected,
        format!("{path}.id"),
        ValidationErrorKind::HierarchyMismatch,
    )?;
    ahead(
        item.next_child,
        validation_index
            .max_child_ordinal
            .get(&item.id)
            .copied()
            .into_iter(),
        &format!("{path}.next_child"),
    )?;

    text(
        &item.question,
        &format!("{path}.question"),
        true,
        Some(4096),
    )?;
    optional_short_label(&item.short, &format!("{path}.short"))?;
    optional_text(&item.ask, &format!("{path}.ask"), true, Some(4096))?;
    optional_text(&item.note, &format!("{path}.note"), false, Some(4096))?;
    optional_text(&item.outcome, &format!("{path}.outcome"), true, Some(4096))?;
    optional_text(&item.why, &format!("{path}.why"), true, Some(4096))?;
    options(&item.options, &format!("{path}.options"))?;
    require(
        item.links.len() <= 32,
        format!("{path}.links"),
        ValidationErrorKind::TooMany { maximum: 32 },
    )?;
    for (index, link) in item.links.iter().enumerate() {
        text(
            &link.label,
            &format!("{path}.links.{index}.label"),
            true,
            None,
        )?;
        text(
            &link.target,
            &format!("{path}.links.{index}.target"),
            true,
            Some(4096),
        )?;
    }
    if terminal(&item.status) {
        require(
            item.outcome.is_some() && item.why.is_some(),
            format!("{path}.outcome/why"),
            ValidationErrorKind::InvalidState,
        )?;
    } else {
        require(
            item.outcome.is_none() && item.why.is_none() && item.replaced_by.is_none(),
            format!("{path}.outcome/why/replaced_by"),
            ValidationErrorKind::InvalidState,
        )?;
    }
    if item.status == ItemStatus::Replaced {
        require(
            item.replaced_by.is_some(),
            format!("{path}.replaced_by"),
            ValidationErrorKind::MissingReference,
        )?;
        walk(session, item, true)?;
    } else {
        require(
            item.replaced_by.is_none(),
            format!("{path}.replaced_by"),
            ValidationErrorKind::InvalidState,
        )?;
    }
    if item.status == ItemStatus::WaitingOnMe {
        require(
            item.ask.is_some()
                && item.waiting_since.is_some()
                && item.recipient_binding_id.is_some(),
            format!("{path}.waiting"),
            ValidationErrorKind::InvalidState,
        )?;
    } else {
        require(
            item.waiting_since.is_none(),
            format!("{path}.waiting_since"),
            ValidationErrorKind::InvalidState,
        )?;
    }
    if let ItemOwner::Agent { binding_id } = &item.owner {
        require(
            session.bindings.0.contains_key(binding_id),
            format!("{path}.owner.binding_id"),
            ValidationErrorKind::MissingReference,
        )?;
    }
    if let ItemOwner::Other { name } = &item.owner {
        text(name, &format!("{path}.owner.name"), true, None)?;
    }
    if let Some(binding_id) = &item.recipient_binding_id {
        require(
            session.bindings.0.contains_key(binding_id),
            format!("{path}.recipient_binding_id"),
            ValidationErrorKind::MissingReference,
        )?;
    }
    require(
        validation_index
            .message_ids
            .contains(&item.created_message_id),
        format!("{path}.created_message_id"),
        ValidationErrorKind::MissingReference,
    )?;
    distinct(
        &item.updated_message_ids,
        &format!("{path}.updated_message_ids"),
    )?;
    for id in &item.updated_message_ids {
        require(
            validation_index.message_ids.contains(id),
            format!("{path}.updated_message_ids"),
            ValidationErrorKind::MissingReference,
        )?;
    }
    if assembled_round {
        if let Some(id) = &item.current_round_id {
            require(
                session
                    .rounds
                    .0
                    .get(id)
                    .is_some_and(|round| round.item_id == item.id),
                format!("{path}.current_round_id"),
                ValidationErrorKind::MissingReference,
            )?;
        }
    }
    if let Some(id) = &item.source_round_id {
        require(
            session
                .rounds
                .0
                .get(id)
                .is_some_and(|round| item.parent.as_ref() == Some(&round.item_id)),
            format!("{path}.source_round_id"),
            ValidationErrorKind::MissingReference,
        )?;
    }
    for (index, history) in item.status_history.iter().enumerate() {
        let path = format!("{path}.status_history.{index}");
        optional_text(
            &history.previous_outcome,
            &format!("{path}.previous_outcome"),
            true,
            Some(4096),
        )?;
        optional_text(
            &history.previous_why,
            &format!("{path}.previous_why"),
            true,
            Some(4096),
        )?;
        optional_text(&history.reason, &format!("{path}.reason"), true, None)?;
        require(
            validation_index
                .message_ids
                .contains(&history.cause_message_id),
            format!("{path}.cause_message_id"),
            ValidationErrorKind::MissingReference,
        )?;
        if let Some(binding) = &history.binding_id {
            require(
                item.origin.is_some() || session.bindings.0.contains_key(binding),
                format!("{path}.binding_id"),
                ValidationErrorKind::MissingReference,
            )?;
        }
    }
    Ok(())
}

// Walk actual links, substituting the candidate for its stored version. Never
// infer ancestry from ItemRef spelling; cycles terminate even for corrupt data.
fn walk(session: &Session, item: &Item, replacement: bool) -> Result<(), ValidationError> {
    let field = if replacement { "replaced_by" } else { "parent" };
    let path = format!("items.{}.{}", item.id.as_str(), field);
    let mut seen = BTreeSet::new();
    let mut current = item;
    loop {
        require(seen.insert(&current.id), &path, ValidationErrorKind::Cycle)?;
        let next = if replacement {
            &current.replaced_by
        } else {
            &current.parent
        };
        let Some(next) = next else {
            return Ok(());
        };
        current = if next == &item.id {
            item
        } else {
            session.items.0.get(next).ok_or_else(|| ValidationError {
                path: path.clone(),
                kind: ValidationErrorKind::MissingReference,
            })?
        };
    }
}
