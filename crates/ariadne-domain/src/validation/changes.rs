use super::*;

pub(super) fn validate_changes(item: &Item, item_path: &str) -> Result<(), ValidationError> {
    let Some(changes) = &item.changes else {
        return Ok(());
    };
    require(
        changes.len() <= 20,
        format!("{item_path}.changes"),
        ValidationErrorKind::TooMany { maximum: 20 },
    )?;
    let mut previous: Option<&ItemChangeRecord> = None;
    for (index, change) in changes.iter().enumerate() {
        let path = format!("{item_path}.changes.{index}");
        require(
            change.revision.value() > 1
                && change.revision <= item.revision
                && previous.is_none_or(|previous| previous.revision < change.revision),
            &path,
            ValidationErrorKind::InvalidState,
        )?;
        if let Some(reason) = &change.reason {
            bounded_trimmed_text(
                reason,
                &format!("{path}.reason"),
                CHANGE_REASON_MAX_CHARS,
                true,
            )?;
        }
        before(&change.before, &item.id, &format!("{path}.before"))?;
        if change.wording_only {
            let allowed = ItemChangeBefore {
                question: change.before.question.clone(),
                short: change.before.short.clone(),
                note: change.before.note.clone(),
                ..ItemChangeBefore::default()
            };
            require(
                change.before == allowed,
                format!("{path}.before"),
                ValidationErrorKind::InvalidState,
            )?;
        }
        // Cause messages can disappear without erasing readable change history.
        previous = Some(change);
    }
    Ok(())
}

fn before(before: &ItemChangeBefore, id: &ItemRef, path: &str) -> Result<(), ValidationError> {
    require(
        before != &ItemChangeBefore::default(),
        path,
        ValidationErrorKind::InvalidState,
    )?;
    for (name, field, required) in [
        ("question", &before.question, true),
        ("note", &before.note, false),
        ("ask", &before.ask, true),
        ("outcome", &before.outcome, true),
        ("why", &before.why, true),
    ] {
        if let Some(value) = field {
            require(
                value.as_ref().is_none_or(|value| !value.is_empty()),
                format!("{path}.{name}"),
                ValidationErrorKind::InvalidState,
            )?;
            if name == "question" {
                require(
                    value.is_some(),
                    format!("{path}.{name}"),
                    ValidationErrorKind::InvalidState,
                )?;
            }
            optional_text(value, &format!("{path}.{name}"), required, Some(4096))?;
        }
    }
    if let Some(short) = &before.short {
        optional_short_label(short, &format!("{path}.short"))?;
    }
    require(
        before.item_type != Some(None) && before.status != Some(None),
        path,
        ValidationErrorKind::InvalidState,
    )?;
    if let Some(Some(values)) = &before.options {
        require(
            !values.is_empty(),
            format!("{path}.options"),
            ValidationErrorKind::InvalidState,
        )?;
        options(values, &format!("{path}.options"))?;
    }
    if let Some(Some(links)) = &before.links {
        require(
            !links.is_empty() && links.len() <= 32,
            format!("{path}.links"),
            ValidationErrorKind::InvalidState,
        )?;
        for (index, link) in links.iter().enumerate() {
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
            require(
                link.kind != LinkKind::Item || ItemRef::new(link.target.clone()).is_ok(),
                format!("{path}.links.{index}.target"),
                ValidationErrorKind::InvalidState,
            )?;
        }
    }
    for (name, field) in [
        ("related", &before.related),
        ("affects", &before.affects),
        ("depends_on", &before.depends_on),
    ] {
        if let Some(Some(targets)) = field {
            require(
                !targets.is_empty(),
                format!("{path}.{name}"),
                ValidationErrorKind::InvalidState,
            )?;
        }
    }
    item_reference_lists(
        id,
        [
            ("related", before.related.as_ref().unwrap_or(&None)),
            ("affects", before.affects.as_ref().unwrap_or(&None)),
            ("depends_on", before.depends_on.as_ref().unwrap_or(&None)),
        ],
        path,
    )?;
    Ok(())
}
