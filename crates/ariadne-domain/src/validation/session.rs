use super::*;

/// Validate canonical item-tree identity, links, counters and individual content
/// bounds, including the messages and frozen question snapshots they reference.
/// This is one component of final commit validation. It does not establish
/// immutable history, delivery/receipt consistency, lifecycle guards or actor scope.
pub fn validate_session_items(session: &Session) -> Result<(), ValidationError> {
    text(&session.title, "title", true, None)?;
    optional_owner_label(&session.name, "name", SESSION_NAME_MAX_CHARS)?;
    optional_owner_label(
        &session.description,
        "description",
        SESSION_DESCRIPTION_MAX_CHARS,
    )?;
    distinct(
        session.topics.0.values().map(|topic| topic.order),
        "topics.order",
    )?;
    ahead(
        session.counters.next_topic_order,
        session.topics.0.values().map(|topic| topic.order),
        "counters.next_topic_order",
    )?;
    for (id, topic) in &session.topics.0 {
        require(
            id == &topic.id,
            "topics.id",
            ValidationErrorKind::IdentityMismatch,
        )?;
        text(&topic.name, "topics.name", true, None)?;
        optional_short_label(&topic.short, "topics.short")?;
    }
    for (id, binding) in &session.bindings.0 {
        require(
            id == &binding.id,
            "bindings.id",
            ValidationErrorKind::IdentityMismatch,
        )?;
        text(
            &binding.endpoint_fingerprint.0,
            "bindings.endpoint_fingerprint",
            true,
            Some(4096),
        )?;
        optional_host_location(&binding.host_location, "bindings.host_location")?;
    }
    if let Some(id) = &session.active_binding_id {
        require(
            session.bindings.0.contains_key(id),
            "active_binding_id",
            ValidationErrorKind::MissingReference,
        )?;
    }
    distinct(
        session.messages.iter().map(|message| &message.id),
        "messages.id",
    )?;
    distinct(
        session.messages.iter().map(|message| message.number),
        "messages.number",
    )?;
    ahead(
        session.counters.next_message,
        session.messages.iter().map(|message| message.number),
        "counters.next_message",
    )?;
    for message in &session.messages {
        let limit = match (&message.author, &message.kind) {
            (MessageAuthor::Owner, _) => Some(16 * 1024),
            (MessageAuthor::Agent, MessageKind::Reply) => Some(64 * 1024),
            (_, MessageKind::Activity) => Some(4096),
            _ => None,
        };
        let selected_answer = message.author == MessageAuthor::Owner
            && message.kind == MessageKind::OwnerInput
            && session.answers.iter().any(|answer| {
                answer.message_id == message.id
                    && message.input_id.as_ref() == Some(&answer.input_id)
                    && message.item_id.as_ref() == Some(&answer.item_id)
                    && answer.selected_option_id.as_ref().is_some_and(|selected| {
                        answer
                            .options_snapshot
                            .iter()
                            .any(|option| &option.id == selected)
                    })
            });
        text(&message.body, "messages.body", !selected_answer, limit)?;
        if message.author == MessageAuthor::Owner
            && message.kind == MessageKind::OwnerInput
            && message.origin.is_none()
        {
            owner_input(session, message)?;
        }
        if let Some(item_id) = &message.item_id {
            require(
                session
                    .items
                    .0
                    .get(item_id)
                    .is_some_and(|item| message.topic_id.as_ref() == Some(&item.topic_id)),
                "messages.item_id/topic_id",
                ValidationErrorKind::MissingReference,
            )?;
        }
        if let Some(topic_id) = &message.topic_id {
            require(
                session.topics.0.contains_key(topic_id),
                "messages.topic_id",
                ValidationErrorKind::MissingReference,
            )?;
        }
        distinct(&message.items_touched, "messages.items_touched")?;
        for id in &message.items_touched {
            require(
                session.items.0.contains_key(id),
                "messages.items_touched",
                ValidationErrorKind::MissingReference,
            )?;
        }
        // Copied messages retain source identity, which may not be a live binding
        // in this session. Provenance semantics are owned by history/continuation.
        if message.origin.is_none() {
            if let Some(id) = &message.binding_id {
                require(
                    session.bindings.0.contains_key(id),
                    "messages.binding_id",
                    ValidationErrorKind::MissingReference,
                )?;
            }
        }
        if let Some(id) = &message.round_id {
            require(
                session.rounds.0.get(id).is_some_and(|round| {
                    message
                        .item_id
                        .as_ref()
                        .is_none_or(|item_id| item_id == &round.item_id)
                }),
                "messages.round_id",
                ValidationErrorKind::MissingReference,
            )?;
        }
        require(
            message.kind != MessageKind::Reply
                || message.item_id.is_some()
                || message.origin.as_ref().is_some_and(|origin| {
                    crate::history::copied_message(session, message, origin).is_ok()
                }),
            "messages.reply.item_id",
            ValidationErrorKind::MissingReference,
        )?;
    }
    for (id, round) in &session.rounds.0 {
        require(
            id == &round.id,
            "rounds.id",
            ValidationErrorKind::IdentityMismatch,
        )?;
        require(
            session.items.0.contains_key(&round.item_id),
            "rounds.item_id",
            ValidationErrorKind::MissingReference,
        )?;
        snapshot(
            &round.question_snapshot,
            &round.ask_snapshot,
            &round.options_snapshot,
            "rounds",
        )?;
    }
    let item_index = items::ItemValidationIndex::new(session);
    for (id, item) in &session.items.0 {
        require(
            id == &item.id,
            "items.id",
            ValidationErrorKind::IdentityMismatch,
        )?;
        items::validate_candidate_indexed(session, item, true, &item_index)?;
    }
    // These frozen bodies obey the same content bounds as live item/owner text.
    // Queue state, attempt linkage and accepted-answer semantics are not checked.
    for answer in &session.answers {
        snapshot(
            &answer.question_snapshot,
            &answer.ask_snapshot,
            &answer.options_snapshot,
            "answers",
        )?;
        text(
            &answer.text,
            "answers.text",
            answer.selected_option_id.is_none(),
            Some(16 * 1024),
        )?;
    }
    for input in session.inputs.0.values() {
        text(
            &input.payload.text,
            "inputs.payload.text",
            input.payload.selected_option_id.is_none(),
            Some(16 * 1024),
        )?;
        optional_text(
            &input.payload.target_snapshot.item_question,
            "inputs.snapshot.item_question",
            true,
            Some(4096),
        )?;
        optional_text(
            &input.payload.target_snapshot.ask,
            "inputs.snapshot.ask",
            true,
            Some(4096),
        )?;
        options(
            &input.payload.target_snapshot.options,
            "inputs.snapshot.options",
        )?;
    }
    Ok(())
}

fn snapshot(
    question: &str,
    ask: &Option<String>,
    values: &[ItemOption],
    path: &str,
) -> Result<(), ValidationError> {
    text(
        question,
        &format!("{path}.question_snapshot"),
        true,
        Some(4096),
    )?;
    optional_text(ask, &format!("{path}.ask_snapshot"), true, Some(4096))?;
    options(values, &format!("{path}.options_snapshot"))
}

pub(crate) fn owner_input<'a>(
    session: &'a Session,
    message: &Message,
) -> Result<&'a Input, ValidationError> {
    let input = message
        .input_id
        .as_ref()
        .and_then(|id| session.inputs.0.get(id))
        .ok_or_else(|| ValidationError {
            path: "messages.owner_input.input_id".into(),
            kind: ValidationErrorKind::MissingReference,
        })?;
    // A removal notice names a topic/items that no longer exist, so its owner
    // message carries no topic or item link.
    let topic_matches = if input.kind == InputKind::Removed {
        message.topic_id.is_none() && input.target.item_id.is_none()
    } else {
        message.topic_id.as_ref() == Some(&input.target.topic_id)
    };
    require(
        input.message_id == message.id && input.target.item_id == message.item_id && topic_matches,
        "messages.owner_input.target",
        ValidationErrorKind::IdentityMismatch,
    )?;
    require(
        (input.kind == InputKind::Removed) == input.payload.removed.is_some(),
        "inputs.payload.removed",
        ValidationErrorKind::InvalidState,
    )?;
    Ok(input)
}
