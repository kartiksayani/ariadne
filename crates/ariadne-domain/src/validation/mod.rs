//! Pure item-tree and content checks over canonical DTOs.
//!
//! Store/core compose these with history, delivery, actor and transaction checks;
//! this module does not implement those state machines.
mod delivery;
pub use delivery::{validate_prepared_payload, validate_session_delivery};
pub(crate) mod items;
pub(crate) mod session;

use crate::models::*;
use std::collections::BTreeSet;
use std::fmt;

pub use items::validate_item;
pub use session::validate_session_items;

fn validate_removal(
    session: &Session,
    at: &Option<UtcMillis>,
    source: &Option<AgentRemovalSource>,
    path: &str,
) -> Result<(), ValidationError> {
    require(
        at.is_some() == source.is_some(),
        path,
        ValidationErrorKind::InvalidState,
    )?;
    if let Some(source) = source {
        require(
            session.bindings.0.contains_key(&source.binding_id),
            path,
            ValidationErrorKind::MissingReference,
        )?;
        require(
            session.messages.iter().any(|message| {
                message.id == source.message_id
                    && message.kind == MessageKind::Lifecycle
                    && message.author == MessageAuthor::System
                    && message.binding_id.as_ref() == Some(&source.binding_id)
                    && Some(&message.created_at) == at.as_ref()
            }),
            path,
            ValidationErrorKind::MissingReference,
        )?;
    }
    Ok(())
}

/// Whether a record saved under `binding_id` may name `input`. A rebind
/// carries pending inputs to the new binding; messages and receipts saved
/// while an input belonged to a retired binding of the session keep that one.
pub(crate) fn input_route(session: &Session, input: &Input, binding_id: &UuidV4) -> bool {
    binding_id == &input.binding_id
        || (session.bindings.0.contains_key(binding_id)
            && session.active_binding_id.as_ref() != Some(binding_id))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError {
    pub path: String,
    pub kind: ValidationErrorKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationErrorKind {
    Blank,
    Nul,
    TooLong { maximum_bytes: usize },
    TooManyChars { maximum_chars: usize },
    Multiline,
    TooMany { maximum: usize },
    Duplicate,
    MissingReference,
    IdentityMismatch,
    HierarchyMismatch,
    Cycle,
    CounterNotAhead,
    InvalidState,
}

impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {:?}", self.path, self.kind)
    }
}
impl std::error::Error for ValidationError {}

pub(crate) fn require(
    condition: bool,
    path: impl Into<String>,
    kind: ValidationErrorKind,
) -> Result<(), ValidationError> {
    if condition {
        Ok(())
    } else {
        Err(ValidationError {
            path: path.into(),
            kind,
        })
    }
}

pub(crate) fn text(
    value: &str,
    path: &str,
    required: bool,
    limit: Option<usize>,
) -> Result<(), ValidationError> {
    require(!value.contains('\0'), path, ValidationErrorKind::Nul)?;
    require(
        !required || !value.trim().is_empty(),
        path,
        ValidationErrorKind::Blank,
    )?;
    if let Some(maximum_bytes) = limit {
        require(
            value.len() <= maximum_bytes,
            path,
            ValidationErrorKind::TooLong { maximum_bytes },
        )?;
    }
    Ok(())
}

pub(crate) fn optional_text(
    value: &Option<String>,
    path: &str,
    required_when_present: bool,
    limit: Option<usize>,
) -> Result<(), ValidationError> {
    if let Some(value) = value {
        text(value, path, required_when_present, limit)?;
    }
    Ok(())
}

/// Most Unicode characters an item or topic short label may hold (ADR-0084).
pub const SHORT_LABEL_MAX_CHARS: usize = 40;

/// Trim a proposed short label and check it; returns the form to store.
/// A label that is blank after trimming, spans lines or exceeds
/// [`SHORT_LABEL_MAX_CHARS`] is rejected.
pub fn normalize_short_label(value: &str, path: &str) -> Result<String, ValidationError> {
    let trimmed = value.trim();
    short_label(trimmed, path)?;
    Ok(trimmed.to_owned())
}

/// A stored short label is already trimmed, nonblank, one line and bounded.
pub(crate) fn short_label(value: &str, path: &str) -> Result<(), ValidationError> {
    text(value, path, true, None)?;
    require(
        !value.contains(['\n', '\r']),
        path,
        ValidationErrorKind::Multiline,
    )?;
    require(
        value.trim() == value,
        path,
        ValidationErrorKind::InvalidState,
    )?;
    require(
        value.chars().count() <= SHORT_LABEL_MAX_CHARS,
        path,
        ValidationErrorKind::TooManyChars {
            maximum_chars: SHORT_LABEL_MAX_CHARS,
        },
    )
}

pub(crate) fn optional_short_label(
    value: &Option<String>,
    path: &str,
) -> Result<(), ValidationError> {
    value
        .as_deref()
        .map_or(Ok(()), |value| short_label(value, path))
}

/// Most Unicode characters a binding's `host_location` may hold (ADR-0085).
pub const HOST_LOCATION_MAX_CHARS: usize = 60;

/// A stored host location is nonblank, trimmed, free of control characters
/// (so one line) and at most [`HOST_LOCATION_MAX_CHARS`] characters.
pub(crate) fn optional_host_location(
    value: &Option<String>,
    path: &str,
) -> Result<(), ValidationError> {
    let Some(value) = value.as_deref() else {
        return Ok(());
    };
    text(value, path, true, None)?;
    require(
        !value.contains(['\n', '\r']),
        path,
        ValidationErrorKind::Multiline,
    )?;
    require(
        value.trim() == value && !value.contains(char::is_control),
        path,
        ValidationErrorKind::InvalidState,
    )?;
    require(
        value.chars().count() <= HOST_LOCATION_MAX_CHARS,
        path,
        ValidationErrorKind::TooManyChars {
            maximum_chars: HOST_LOCATION_MAX_CHARS,
        },
    )
}

/// Most Unicode characters an owner-set session name may hold (ADR-0091).
pub const SESSION_NAME_MAX_CHARS: usize = 60;
/// Most Unicode characters an owner-set session description may hold (ADR-0091).
pub const SESSION_DESCRIPTION_MAX_CHARS: usize = 200;

/// Trim an owner-typed one-line label. Blank after trimming clears it (`None`).
/// A label with a control character (so more than one line) or more than
/// `maximum_chars` characters after trimming is rejected.
pub fn normalize_owner_label(
    value: Option<&str>,
    path: &str,
    maximum_chars: usize,
) -> Result<Option<String>, ValidationError> {
    let trimmed = value.map_or("", str::trim);
    if trimmed.is_empty() {
        return Ok(None);
    }
    owner_label(trimmed, path, maximum_chars)?;
    Ok(Some(trimmed.to_owned()))
}

/// A stored owner label is already trimmed, nonblank, one line and bounded.
fn owner_label(value: &str, path: &str, maximum_chars: usize) -> Result<(), ValidationError> {
    text(value, path, true, None)?;
    require(
        !value.contains(['\n', '\r']),
        path,
        ValidationErrorKind::Multiline,
    )?;
    require(
        value.trim() == value && !value.contains(char::is_control),
        path,
        ValidationErrorKind::InvalidState,
    )?;
    require(
        value.chars().count() <= maximum_chars,
        path,
        ValidationErrorKind::TooManyChars { maximum_chars },
    )
}

pub(crate) fn optional_owner_label(
    value: &Option<String>,
    path: &str,
    maximum_chars: usize,
) -> Result<(), ValidationError> {
    value
        .as_deref()
        .map_or(Ok(()), |value| owner_label(value, path, maximum_chars))
}

pub(crate) fn distinct<T: Ord>(
    values: impl IntoIterator<Item = T>,
    path: &str,
) -> Result<(), ValidationError> {
    let mut seen = BTreeSet::new();
    for value in values {
        require(seen.insert(value), path, ValidationErrorKind::Duplicate)?;
    }
    Ok(())
}

pub(crate) fn options(values: &[ItemOption], path: &str) -> Result<(), ValidationError> {
    require(
        values.len() <= 12,
        path,
        ValidationErrorKind::TooMany { maximum: 12 },
    )?;
    distinct(values.iter().map(|option| &option.id), path)?;
    require(
        values.iter().filter(|option| option.recommended).count() <= 1,
        path,
        ValidationErrorKind::InvalidState,
    )?;
    for (index, option) in values.iter().enumerate() {
        text(&option.id, &format!("{path}.{index}.id"), true, None)?;
        text(
            &option.label,
            &format!("{path}.{index}.label"),
            true,
            Some(1024),
        )?;
        text(
            &option.consequence,
            &format!("{path}.{index}.consequence"),
            true,
            Some(1024),
        )?;
    }
    Ok(())
}

pub(crate) fn terminal(status: &ItemStatus) -> bool {
    matches!(
        status,
        ItemStatus::Decided | ItemStatus::Done | ItemStatus::Dropped | ItemStatus::Replaced
    )
}

pub(crate) fn ahead(
    next: PositiveSafeInteger,
    used: impl Iterator<Item = PositiveSafeInteger>,
    path: &str,
) -> Result<(), ValidationError> {
    require(
        used.into_iter().all(|number| number < next),
        path,
        ValidationErrorKind::CounterNotAhead,
    )
}
