use crate::{CoreError, CoreErrorCode};
use ariadne_domain::models::*;
use serde::Serialize;
use sha2::{Digest, Sha256 as Hasher};

pub(super) const PAGE_BYTES: usize = 1024 * 1024;
pub(super) const ENTITY_BYTES: usize = 768 * 1024;
// Reserve the tagged response envelope and route fields outside each Page.
pub(super) fn payload_budget(fixed_bytes: usize) -> usize {
    PAGE_BYTES.saturating_sub(1024).saturating_sub(fixed_bytes)
}

pub(super) fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(
        CoreErrorCode::InvalidArgument,
        message,
        "Correct the query or restart from its first page.",
    )
}
pub(super) fn capacity() -> CoreError {
    CoreError::new(
        CoreErrorCode::CapacityExceeded,
        "A complete projection exceeds the query byte budget",
        "Request one historical collection at a time or a smaller page.",
    )
}
pub(super) fn bytes(value: &impl Serialize) -> Result<usize, CoreError> {
    serde_json::to_vec(value)
        .map(|value| value.len())
        .map_err(|_| invalid("Query serialization failed"))
}
pub(super) fn digest(value: &impl Serialize) -> Result<Sha256, CoreError> {
    let bytes =
        serde_json::to_vec(value).map_err(|_| invalid("Query scope serialization failed"))?;
    Ok(Sha256::new(format!("{:x}", Hasher::digest(bytes))).expect("SHA-256 encoding"))
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum Key {
    Sequence(u64, UuidV4),
    Topic(u64, UuidV4),
    Item(Vec<u64>, ItemRef),
    Round(u64, UuidV4),
    Project(String, UuidV4),
    Session(UtcMillis, UuidV4, UuidV4),
    History(u64),
    Result(u64, u64, UuidV4, UuidV4),
}
fn key(position: &CursorPosition) -> Key {
    match position {
        CursorPosition::Sequence { number, id } => Key::Sequence(number.value(), id.clone()),
        CursorPosition::Topic { order, id } => Key::Topic(order.value(), id.clone()),
        CursorPosition::Item { ordinals, id } => {
            Key::Item(ordinals.iter().map(|n| n.value()).collect(), id.clone())
        }
        CursorPosition::Round { ordinal, id } => Key::Round(ordinal.value(), id.clone()),
        CursorPosition::Project { canonical_root, id } => {
            Key::Project(canonical_root.clone(), id.clone())
        }
        CursorPosition::Session {
            updated_at,
            project_id,
            id,
        } => Key::Session(updated_at.clone(), project_id.clone(), id.clone()),
        CursorPosition::History { index } => Key::History(index.value()),
        CursorPosition::Result {
            input_seq,
            attempt_ordinal,
            input_id,
            attempt_id,
        } => Key::Result(
            input_seq.value(),
            attempt_ordinal.value(),
            input_id.clone(),
            attempt_id.clone(),
        ),
    }
}
fn shape(position: &CursorPosition, view: &QueryView) -> bool {
    match view {
        QueryView::Projects => matches!(position, CursorPosition::Project { .. }),
        QueryView::Sessions => matches!(position, CursorPosition::Session { .. }),
        QueryView::Topics => matches!(position, CursorPosition::Topic { .. }),
        QueryView::Items | QueryView::RoundForks => {
            matches!(position, CursorPosition::Item { ordinals, .. } if !ordinals.is_empty())
        }
        QueryView::ItemRounds => matches!(position, CursorPosition::Round { .. }),
        QueryView::ItemStatusHistory => matches!(position, CursorPosition::History { .. }),
        QueryView::RoundResults => matches!(position, CursorPosition::Result { .. }),
        _ => matches!(position, CursorPosition::Sequence { .. }),
    }
}

/// The digest contains the complete captured inventory for aggregate queries;
/// session queries separately retain their canonical revision guard.
pub(super) struct Scope {
    pub view: QueryView,
    pub digest: Sha256,
    pub revision: PositiveSafeInteger,
    pub aggregate: bool,
}
impl Scope {
    fn cursor(&self, after: Option<CursorPosition>) -> QueryCursor {
        QueryCursor {
            schema: SchemaVersion::new(1).expect("schema"),
            view: self.view.clone(),
            filter_digest: self.digest.clone(),
            after,
            revision: self.revision,
        }
    }
    pub fn validate(&self, cursor: &Option<QueryCursor>) -> Result<(), CoreError> {
        let Some(cursor) = cursor else {
            return Ok(());
        };
        if cursor.view != self.view
            || cursor
                .after
                .as_ref()
                .is_some_and(|after| !shape(after, &self.view))
        {
            return Err(invalid(
                "Cursor view or position does not match this collection",
            ));
        }
        if cursor.revision != self.revision
            || (self.aggregate && cursor.filter_digest != self.digest)
        {
            let mut error = CoreError::new(
                CoreErrorCode::SnapshotChanged,
                "The captured query snapshot changed",
                "Restart from the first page.",
            );
            error.current_revision = Some(self.revision);
            return Err(error);
        }
        if cursor.filter_digest != self.digest {
            return Err(invalid("Cursor belongs to another actor, route or filter"));
        }
        Ok(())
    }
}

pub(super) fn page<T: Serialize>(
    entries: Vec<(CursorPosition, T)>,
    scope: &Scope,
    cursor: &Option<QueryCursor>,
    limit: usize,
    budget: usize,
    allow_empty: bool,
) -> Result<Page<T>, CoreError> {
    mapped_page(entries, scope, cursor, limit, budget, allow_empty, Ok)
}

pub(super) fn mapped_page<T, U: Serialize>(
    mut entries: Vec<(CursorPosition, T)>,
    scope: &Scope,
    cursor: &Option<QueryCursor>,
    limit: usize,
    budget: usize,
    allow_empty: bool,
    mut project: impl FnMut(T) -> Result<U, CoreError>,
) -> Result<Page<U>, CoreError> {
    scope.validate(cursor)?;
    entries.sort_by_key(|entry| key(&entry.0));
    let after = cursor.as_ref().and_then(|cursor| cursor.after.as_ref());
    let mut entries = entries
        .into_iter()
        .filter(|(position, _)| after.is_none_or(|after| key(position) > key(after)))
        .peekable();
    let mut result = Page {
        items: Vec::new(),
        next_cursor: None,
        snapshot_revision: scope.revision,
    };
    let mut last = after.cloned();
    while let Some((position, value)) = entries.next() {
        let value = project(value)?;
        if bytes(&value)? > ENTITY_BYTES {
            return Err(capacity());
        }
        result.items.push(value);
        result.next_cursor = entries.peek().map(|_| scope.cursor(Some(position.clone())));
        if bytes(&result)? > budget.min(PAGE_BYTES) {
            result.items.pop();
            result.next_cursor = Some(scope.cursor(last));
            if result.items.is_empty() && !allow_empty {
                return Err(capacity());
            }
            return Ok(result);
        }
        last = Some(position);
        if result.items.len() == limit {
            result.next_cursor = entries.peek().map(|_| scope.cursor(last));
            return Ok(result);
        }
    }
    result.next_cursor = None;
    Ok(result)
}
