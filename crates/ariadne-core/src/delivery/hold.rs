use ariadne_domain::models::*;

/// A queued item input written against an older question than the item now has.
/// Claim never delivers it (no snapshot is shipped to the agent); it stays queued
/// for the owner to review and send again, and later inputs are not blocked.
pub fn held_for_review(session: &Session, input: &Input) -> bool {
    if input.state != InputState::Queued {
        return false;
    }
    let (Some(item_id), Some(seen)) = (
        input.target.item_id.as_ref(),
        input.payload.target_snapshot.question_revision,
    ) else {
        return false;
    };
    session
        .items
        .0
        .get(item_id)
        .is_some_and(|item| seen < item.question_revision)
}
