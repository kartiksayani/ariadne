//! Pure item-tree and content checks over canonical DTOs.
//!
//! Store/core compose these with history, delivery, actor and transaction checks;
//! this module does not implement those state machines.
pub(crate) mod items;
pub(crate) mod session;

use crate::models::*;
use std::collections::BTreeSet;
use std::fmt;

pub use items::validate_item;
pub use session::validate_session_items;

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
