//! Owner rename: the routed session's name and description (ADR-0091).
use ariadne_domain::models::*;

use crate::*;

/// Stores the trimmed name and description; a blank or `null` field clears it.
/// Allowed for active and closed sessions; a removed session has no file, so
/// the transaction never reaches here for one.
pub(super) fn apply(
    session: &mut Session,
    command: &OwnerCommand,
) -> Result<SavedReceiptData, CoreError> {
    let OwnerCommand::SessionLabelSet { params, .. } = command else {
        unreachable!("validated session label command")
    };
    let (name, description) = params.normalized()?;
    session.name = name.clone();
    session.description = description.clone();
    Ok(SavedReceiptData::SessionLabel { name, description })
}
