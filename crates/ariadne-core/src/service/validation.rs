//! Contract bounds and scope checks, without persistence or domain transitions.
use crate::service::*;
use ariadne_agent_protocol::NormalizedEvent;
use ariadne_domain::models::*;
use serde::Serialize;

fn invalid(message: &str) -> CoreError {
    CoreError::new(
        CoreErrorCode::InvalidArgument,
        message,
        "Correct the request and retry the same operation ID.",
    )
}
fn scope_error() -> CoreError {
    CoreError::new(
        CoreErrorCode::BindingMismatch,
        "Request does not match its trusted scope",
        "Resolve registered routing IDs again.",
    )
}

impl PresenceChangedHint {
    pub fn validate_wire(&self) -> Result<(), CoreError> {
        if self.generation != self.observation.generation {
            return Err(scope_error());
        }
        Ok(())
    }
}

impl OpenRoute {
    /// Non-null item routes reuse the canonical reveal record.
    pub fn item_route(&self) -> Option<ItemRoute> {
        self.item_id.as_ref().map(|item_id| ItemRoute {
            project_id: self.project_id.clone(),
            session_id: self.session_id.clone(),
            item_id: item_id.clone(),
        })
    }
}

macro_rules! agent_read_wire {
    ($($ty:ty),+ $(,)?) => { $(impl $ty {
        pub fn validate_wire(&self) -> Result<(), CoreError> {
            if self.source_input_id.is_some() != self.attempt_id.is_some() {
                return Err(invalid("Source input and attempt must be present together"));
            }
            size(self, 512 * 1024)
        }
    })+ };
}
agent_read_wire!(
    AgentReadToolRequest,
    AgentMessagesToolRequest,
    AgentRoundsToolRequest
);
impl AgentApplyToolRequest {
    pub fn validate_wire(&self) -> Result<(), CoreError> {
        self.request.validate_wire()?;
        size(self, 512 * 1024)
    }
}
impl OwnerQueryRequest {
    pub fn validate_wire(&self) -> Result<(), CoreError> {
        let needs_session = matches!(
            self.request,
            QueryRequest::SessionGet {}
                | QueryRequest::SessionRead(_)
                | QueryRequest::ItemMessages(_)
                | QueryRequest::ItemRounds(_)
                | QueryRequest::RevealItem { .. }
        );
        if needs_session != self.session.is_some() {
            return Err(invalid(
                "Owner query requires exactly its declared registered session route",
            ));
        }
        self.request.validate_owner_wire()?;
        size(self, 512 * 1024)
    }
}
impl OwnerMutationRequest {
    pub fn validate_wire(&self) -> Result<(), CoreError> {
        let needs_session = !matches!(
            self.command,
            OwnerCommand::ProjectRegister { .. }
                | OwnerCommand::BindingConnect { .. }
                | OwnerCommand::PreferencesPatch { .. }
                | OwnerCommand::SessionRemove { .. }
                | OwnerCommand::ProjectRemove { .. }
        );
        if needs_session != self.session.is_some() {
            return Err(invalid(
                "Owner command requires exactly its declared registered session route",
            ));
        }
        if let OwnerCommand::TopicContinue { params, .. } = &self.command {
            if self.session.as_ref() != Some(&params.target) {
                return Err(scope_error());
            }
        }
        self.command.validate_wire()?;
        size(self, 512 * 1024)
    }
}
fn text(value: &str, max: usize, required: bool) -> Result<(), CoreError> {
    if value.len() > max || value.contains('\0') || (required && value.trim().is_empty()) {
        Err(invalid(
            "Text violates its UTF-8 byte, NUL or required-content bound",
        ))
    } else {
        Ok(())
    }
}
/// The wire accepts surrounding whitespace (it is trimmed on write) but not a
/// label that is blank, spans lines or exceeds 40 characters after trimming.
fn short_label(value: Option<&str>) -> Result<(), CoreError> {
    match value {
        Some(value) => ariadne_domain::validation::normalize_short_label(value, "short")
            .map(|_| ())
            .map_err(|_| invalid("Short label must be 1-40 characters on one line after trimming")),
        None => Ok(()),
    }
}
fn size(value: &impl Serialize, max: usize) -> Result<(), CoreError> {
    if serde_json::to_vec(value)
        .map_err(|_| invalid("Cannot serialize contract value"))?
        .len()
        > max
    {
        Err(CoreError::new(
            CoreErrorCode::CapacityExceeded,
            "Serialized contract value exceeds its byte bound",
            "Request a smaller page; complete content must not be truncated.",
        ))
    } else {
        Ok(())
    }
}
fn options(values: &[ItemOption]) -> Result<(), CoreError> {
    if values.len() > 12 {
        return Err(invalid("At most 12 options are allowed"));
    }
    for option in values {
        text(&option.id, 4096, true)?;
        text(&option.label, 1024, true)?;
        text(&option.consequence, 1024, true)?;
    }
    Ok(())
}
fn links(values: &[ItemLinkTarget]) -> Result<(), CoreError> {
    if values.len() > 32 {
        return Err(invalid("At most 32 links are allowed"));
    }
    for link in values {
        text(&link.target, 4096, true)?;
        if link.kind == LinkKind::Item && ItemRef::new(link.target.clone()).is_err() {
            return Err(invalid("Item link target must be a raw item id"));
        }
    }
    Ok(())
}

impl CoreError {
    pub fn validate(&self) -> Result<(), CoreError> {
        text(&self.message, 4096, true)?;
        text(&self.hint, 4096, true)?;
        for field in &self.field_errors {
            text(&field.field, 4096, true)?;
            text(&field.message, 4096, true)?;
        }
        if self.code == CoreErrorCode::DeliveryUncertain && self.retryable {
            return Err(invalid("Uncertain delivery is never retryable"));
        }
        size(self, 512 * 1024)
    }
}

impl ApplyRequest {
    /// Wire checks only. Persisted replay must precede revision/result/state guards.
    pub fn validate_wire(&self) -> Result<(), CoreError> {
        if self.source_input_id.is_some() != self.attempt_id.is_some() {
            return Err(invalid("Source input and attempt must be present together"));
        }
        if self.operations.len() > 100 {
            return Err(invalid("At most 100 operations are allowed"));
        }
        text(&self.summary, 4096, false)?;
        for operation in &self.operations {
            match operation {
                Operation::TopicAdd { name, short, .. } => {
                    text(name, 4096, true)?;
                    short_label(short.as_deref())?;
                }
                Operation::ItemAdd(value) => {
                    let ItemAddOperation {
                        question,
                        short,
                        ask,
                        options: opts,
                        note,
                        links: refs,
                        outcome,
                        why,
                        ..
                    } = &**value;
                    if matches!(
                        value.status,
                        ItemStatus::Decided
                            | ItemStatus::Done
                            | ItemStatus::Dropped
                            | ItemStatus::Replaced
                    ) {
                        return Err(invalid("New items must start open, waiting_on_me, or in_progress; propose decided, done, or dropped with ack_to"));
                    }
                    if ask.is_some() && value.status != ItemStatus::WaitingOnMe {
                        return Err(invalid("A new item with an ask must be waiting_on_me so the owner can answer it"));
                    }
                    if value.item_type.is_read_only_material(ask.as_deref())
                        && value.ack_to.is_none()
                    {
                        return Err(invalid(
                            "choose ack_to: open, in_progress, decided, done or dropped",
                        ));
                    }
                    if matches!(value.status, ItemStatus::Open | ItemStatus::InProgress)
                        && value.ack_to.is_none()
                        && (outcome.is_some() || why.is_some())
                    {
                        return Err(invalid(
                            "item.add outcome and why require an explicit ack_to",
                        ));
                    }
                    text(question, 4096, true)?;
                    short_label(short.as_deref())?;
                    for value in [ask, outcome, why].into_iter().flatten() {
                        text(value, 4096, true)?;
                    }
                    if let Some(value) = note {
                        text(value, 4096, false)?;
                    }
                    if let Some(values) = opts {
                        options(values)?;
                    }
                    if let Some(values) = refs {
                        links(values)?;
                    }
                }
                Operation::ItemEdit { patch, .. } => {
                    if let Some(value) = &patch.question {
                        text(value, 4096, true)?;
                    }
                    if let Some(Some(value)) = &patch.note {
                        text(value, 4096, false)?;
                    }
                    if let Some(value) = &patch.short {
                        short_label(value.as_deref())?;
                    }
                    if let Some(values) = &patch.links {
                        links(values)?;
                    }
                }
                Operation::ItemAsk {
                    ask,
                    options: values,
                    ..
                } => {
                    text(ask, 4096, true)?;
                    options(values)?;
                }
                Operation::ItemStatus {
                    status,
                    ack_to,
                    outcome,
                    why,
                    reason,
                    ..
                } => {
                    if ack_to.is_some()
                        && !matches!(status, ItemStatus::Open | ItemStatus::InProgress)
                    {
                        return Err(invalid(
                            "item.status ack_to is allowed only with open or in_progress",
                        ));
                    }
                    for value in [outcome, why, reason].into_iter().flatten() {
                        text(value, 4096, true)?;
                    }
                }
                Operation::ItemReplace { outcome, why, .. } => {
                    text(outcome, 4096, true)?;
                    text(why, 4096, true)?;
                }
                Operation::Reply { text: value, .. } => text(value, 64 * 1024, true)?,
                Operation::RoundClose { .. }
                | Operation::ItemDelete { .. }
                | Operation::TopicDelete { .. } => {}
            }
        }
        if let Some(result) = &self.input_result {
            if self.source_input_id.is_none() {
                return Err(invalid(
                    "A terminal-originated apply cannot commit an input result",
                ));
            }
            text(&result.explanation, 4096, true)?;
            if result.reply_refs.len() + result.followup_item_refs.len() > 100 {
                return Err(invalid("At most 100 result references are allowed"));
            }
        }
        size(self, 512 * 1024)
    }
}

impl OwnerCommand {
    pub fn operation_id(&self) -> &UuidV4 {
        match self {
            Self::ProjectRegister { op_id, .. }
            | Self::BindingConnect { op_id, .. }
            | Self::BindingPause { op_id, .. }
            | Self::BindingResume { op_id, .. }
            | Self::BindingDisconnect { op_id, .. }
            | Self::InputSubmit { op_id, .. }
            | Self::InputCancel { op_id, .. }
            | Self::InputResolve { op_id, .. }
            | Self::TopicArchive { op_id, .. }
            | Self::TopicRestore { op_id, .. }
            | Self::TopicRemovedRestore { op_id, .. }
            | Self::ItemRestore { op_id, .. }
            | Self::SessionClose { op_id, .. }
            | Self::SessionReopen { op_id, .. }
            | Self::SessionArchive { op_id, .. }
            | Self::SessionRestore { op_id, .. }
            | Self::TopicContinue { op_id, .. }
            | Self::PreferencesPatch { op_id, .. }
            | Self::ItemRemove { op_id, .. }
            | Self::TopicRemove { op_id, .. }
            | Self::SessionRemove { op_id, .. }
            | Self::ProjectRemove { op_id, .. }
            | Self::SessionLabelSet { op_id, .. }
            | Self::Ack { op_id, .. } => op_id,
        }
    }
    pub fn validate_wire(&self) -> Result<(), CoreError> {
        match self {
            Self::ProjectRegister { params, .. } => text(&params.canonical_root, 512 * 1024, true)?,
            Self::BindingConnect { params, .. } => {
                text(&params.adapter_id, 4096, true)?;
                text(&params.external_session_id, 4096, true)?;
            }
            Self::InputSubmit { params, .. } => {
                let option_only = params.kind == InputKind::Answer
                    && params
                        .selected_option_id
                        .as_ref()
                        .is_some_and(|id| !id.trim().is_empty());
                text(&params.text, 16 * 1024, !option_only)?;
            }
            // The owner's reason is optional plain text.
            Self::InputResolve { params, .. } => text(&params.reason, 4096, false)?,
            Self::TopicContinue { params, .. } => {
                if params.summary.len() > 16 * 1024 {
                    return Err(CoreError::new(CoreErrorCode::CapacityExceeded, "The complete continuation summary exceeds the saved 16 KiB owner-input bound", "Use a concise complete summary; full history is copied separately."));
                }
                text(&params.summary, 16 * 1024, true)?;
            }
            Self::PreferencesPatch { params, .. } => {
                for entry in &params.entries {
                    match entry {
                        PreferencesPatchEntry::SetGlobal { preferences } => {
                            if preferences.session_archive_expanded_project_ids.len()
                                > SESSION_ARCHIVE_EXPANSION_CAPACITY
                            {
                                return Err(CoreError::new(
                                    CoreErrorCode::CapacityExceeded,
                                    "Expanded session archive groups exceed the 256 entry bound",
                                    "Fold archive groups before saving preferences.",
                                ));
                            }
                            let mut archive_projects = std::collections::BTreeSet::new();
                            if !preferences
                                .session_archive_expanded_project_ids
                                .iter()
                                .all(|id| archive_projects.insert(id))
                            {
                                return Err(invalid("Duplicate expanded session archive project"));
                            }
                            if preferences.notification_ledger.len() > NOTIFICATION_LEDGER_CAPACITY
                            {
                                return Err(CoreError::new(CoreErrorCode::CapacityExceeded,
                                    "Notification episode ledger exceeds its 256 entry bound",
                                    "Wait for a complete registered queue capture before compacting notification history."));
                            }
                            let mut episodes = std::collections::BTreeSet::new();
                            for episode in &preferences.notification_ledger {
                                if !episodes.insert((
                                    &episode.session.project_id,
                                    &episode.session.session_id,
                                    &episode.item_id,
                                    episode.question_revision.value(),
                                )) {
                                    return Err(invalid("Duplicate notification episode identity"));
                                }
                            }
                            if let Some(window) = &preferences.window {
                                if ![window.x, window.y, window.width, window.height]
                                    .into_iter()
                                    .all(f64::is_finite)
                                    || window.width <= 0.0
                                    || window.height <= 0.0
                                {
                                    return Err(invalid(
                                        "Window geometry must be finite with positive dimensions",
                                    ));
                                }
                            }
                        }
                        PreferencesPatchEntry::SetSessionView { preferences } => {
                            let mut hidden = std::collections::BTreeSet::new();
                            if !preferences
                                .hidden_item_ids
                                .iter()
                                .all(|item| hidden.insert(item))
                            {
                                return Err(invalid("Duplicate hidden item"));
                            }
                            for owner in &preferences.filters.owners {
                                if let ItemOwner::Other { name } = owner {
                                    text(name, usize::MAX, true)?;
                                }
                            }
                            if preferences
                                .scroll
                                .as_ref()
                                .is_some_and(|anchor| !anchor.offset.is_finite())
                            {
                                return Err(invalid("Scroll offset must be finite"));
                            }
                        }
                        PreferencesPatchEntry::UpsertDraft { draft } => {
                            text(&draft.text, 16 * 1024, false)?;
                            if draft.submission_attempted {
                                OwnerCommand::InputSubmit {
                                    api_version: SchemaVersion::new(1).expect("schema version"),
                                    op_id: draft.op_id.clone(),
                                    params: InputSubmitParams {
                                        binding_id: draft.binding_id.clone(),
                                        target: draft.target.clone(),
                                        kind: draft.intent.clone(),
                                        text: draft.text.clone(),
                                        selected_option_id: draft.selected_option_id.clone(),
                                        expected_question_revision: draft.question_revision,
                                        supersedes_answer_id: draft.supersedes_answer_id.clone(),
                                    },
                                }
                                .validate_wire()?;
                            }
                        }
                        PreferencesPatchEntry::SetLater { .. }
                        | PreferencesPatchEntry::DeleteDraft { .. } => {}
                    }
                }
            }
            Self::SessionLabelSet { params, .. } => {
                params.normalized()?;
            }
            _ => {}
        }
        size(self, 512 * 1024)
    }
}

impl SessionLabelParams {
    /// The name and description as they are stored: trimmed, blank cleared to
    /// `None`. A name over 60 characters, a description over 200, or either
    /// spanning lines is refused in plain words.
    pub fn normalized(&self) -> Result<(Option<String>, Option<String>), CoreError> {
        use ariadne_domain::validation::{
            normalize_owner_label, ValidationErrorKind, SESSION_DESCRIPTION_MAX_CHARS,
            SESSION_NAME_MAX_CHARS,
        };
        let one = |value: &Option<String>, field: &str, noun: &str, maximum: usize| {
            normalize_owner_label(value.as_deref(), field, maximum).map_err(|error| {
                let message = match error.kind {
                    ValidationErrorKind::TooManyChars { maximum_chars } => {
                        format!("The session {noun} can be up to {maximum_chars} characters.")
                    }
                    ValidationErrorKind::Multiline => {
                        format!("The session {noun} must be on one line.")
                    }
                    _ => format!("The session {noun} has a character Ariadne cannot save."),
                };
                let mut refused = invalid(&message);
                refused.field_errors = vec![FieldError {
                    field: field.to_owned(),
                    message: message.clone(),
                }];
                refused
            })
        };
        Ok((
            one(&self.name, "name", "name", SESSION_NAME_MAX_CHARS)?,
            one(
                &self.description,
                "description",
                "description",
                SESSION_DESCRIPTION_MAX_CHARS,
            )?,
        ))
    }
}

impl PreparedAttempt {
    pub fn validate_for(&self, request: &ClaimRequest) -> Result<(), CoreError> {
        if self.binding_generation != request.generation {
            return Err(scope_error());
        }
        ariadne_domain::validation::validate_prepared_payload(
            &self.input_id,
            &self.attempt_id,
            &self.formatted_payload,
            &self.payload_sha256,
            &self.wire_marker,
        )
        .map_err(|_| invalid("Prepared marker or digest does not match persisted payload"))?;
        Ok(())
    }
}
impl EventReceipt {
    pub fn validate_for(
        &self,
        context: &AdapterContext,
        event: &NormalizedEvent,
    ) -> Result<(), CoreError> {
        if self.event_id != event.event_id || &self.session_id != context.session().session_id() {
            return Err(scope_error());
        }
        if self.durable_effect && self.revision.is_none() {
            return Err(invalid(
                "Durable event effect requires a persisted revision",
            ));
        }
        Ok(())
    }
}

pub fn validate_apply_receipt(
    receipt: &ApplyReceipt,
    context: &AgentContext,
    request: &ApplyRequest,
) -> Result<(), CoreError> {
    if receipt.operation_id != request.op_id
        || &receipt.session_id != context.session().session_id()
    {
        return Err(scope_error());
    }
    if !matches!(receipt.data, SavedReceiptData::Apply { .. }) {
        return Err(invalid(
            "Apply must return the canonical saved apply receipt",
        ));
    }
    Ok(())
}

fn page<T: Serialize>(value: &Page<T>, limit: usize) -> Result<(), CoreError> {
    if value.items.len() > limit {
        return Err(invalid("Page contains more entities than requested"));
    }
    size(value, 1024 * 1024)?;
    for item in &value.items {
        size(item, 768 * 1024)?;
    }
    if value
        .next_cursor
        .as_ref()
        .is_some_and(|cursor| cursor.revision != value.snapshot_revision)
    {
        return Err(invalid("Page cursor must retain the snapshot revision"));
    }
    Ok(())
}

fn continued_page<T>(
    value: &Page<T>,
    requested: &Option<QueryCursor>,
    view: QueryView,
) -> Result<(), CoreError> {
    cursor(requested, view.clone())?;
    cursor(&value.next_cursor, view)?;
    if let Some(requested) = requested {
        if requested.revision != value.snapshot_revision {
            return Err(CoreError::new(
                CoreErrorCode::SnapshotChanged,
                "Page revision changed since the continuation cursor",
                "Restart this history query from its first page.",
            ));
        }
        if value
            .next_cursor
            .as_ref()
            .is_some_and(|next| next.filter_digest != requested.filter_digest)
        {
            return Err(invalid("Continuation cursor changed its filter scope"));
        }
    }
    Ok(())
}

struct NestedSelection<'a> {
    parent: &'a str,
    cursor: &'a Option<QueryCursor>,
    limit: usize,
    view: QueryView,
}
fn item_selection(value: &ItemPageRequest) -> NestedSelection<'_> {
    match value {
        ItemPageRequest::ItemUpdatedMessages {
            item_id,
            cursor,
            limit,
        } => NestedSelection {
            parent: item_id.as_str(),
            cursor,
            limit: limit.value(),
            view: QueryView::ItemUpdatedMessages,
        },
        ItemPageRequest::ItemStatusHistory {
            item_id,
            cursor,
            limit,
        } => NestedSelection {
            parent: item_id.as_str(),
            cursor,
            limit: limit.value(),
            view: QueryView::ItemStatusHistory,
        },
    }
}
fn round_selection(value: &RoundPageRequest) -> NestedSelection<'_> {
    let (round_id, cursor, limit, view) = match value {
        RoundPageRequest::RoundAnswers {
            round_id,
            cursor,
            limit,
        } => (round_id, cursor, limit, QueryView::RoundAnswers),
        RoundPageRequest::RoundOwnerMessages {
            round_id,
            cursor,
            limit,
        } => (round_id, cursor, limit, QueryView::RoundOwnerMessages),
        RoundPageRequest::RoundAgentMessages {
            round_id,
            cursor,
            limit,
        } => (round_id, cursor, limit, QueryView::RoundAgentMessages),
        RoundPageRequest::RoundResults {
            round_id,
            cursor,
            limit,
        } => (round_id, cursor, limit, QueryView::RoundResults),
        RoundPageRequest::RoundForks {
            round_id,
            cursor,
            limit,
        } => (round_id, cursor, limit, QueryView::RoundForks),
    };
    NestedSelection {
        parent: round_id.as_str(),
        cursor,
        limit: limit.value(),
        view,
    }
}
fn fulfilled_selectors(
    selectors: &[NestedSelection<'_>],
    parents: &[&str],
) -> Result<(), CoreError> {
    for (index, selector) in selectors.iter().enumerate() {
        if !parents.contains(&selector.parent) {
            return Err(invalid("Nested page selector has no returned parent"));
        }
        if selectors[..index]
            .iter()
            .any(|prior| prior.parent == selector.parent && prior.view == selector.view)
        {
            return Err(invalid("Nested page selectors repeat a parent collection"));
        }
    }
    Ok(())
}
fn nested_page<T: Serialize>(
    value: &Page<T>,
    parent: &str,
    view: QueryView,
    selectors: &[NestedSelection<'_>],
    revision: PositiveSafeInteger,
) -> Result<usize, CoreError> {
    let selector = selectors
        .iter()
        .find(|selector| selector.parent == parent && selector.view == view);
    let limit = selector.map_or(100, |selector| selector.limit);
    page(value, limit)?;
    continued_page(
        value,
        selector.map_or(&None, |selector| selector.cursor),
        view,
    )?;
    if value.snapshot_revision != revision {
        return Err(CoreError::new(
            CoreErrorCode::SnapshotChanged,
            "Nested page revision differs from its outer snapshot",
            "Restart this history query from its first page.",
        ));
    }
    Ok(limit)
}
fn messages(value: &Page<Message>, limit: usize, context: &QueryContext) -> Result<(), CoreError> {
    page(value, limit)?;
    for message in &value.items {
        text(
            &message.body,
            if message.author == MessageAuthor::Owner {
                16 * 1024
            } else {
                64 * 1024
            },
            false,
        )?;
        if let QueryVisibility::Agent(agent) = context.visibility() {
            if message.author == MessageAuthor::Owner
                && message.number.value()
                    > agent.read_scope().issued_through_message_number().value()
            {
                return Err(CoreError::new(
                    CoreErrorCode::UnhandledOwnerMessage,
                    "Agent projection contains an unissued owner message",
                    "Use the binding's issued-watermark projection.",
                ));
            }
        }
    }
    Ok(())
}

impl QueryRequest {
    pub fn validate_wire(&self, context: &QueryContext) -> Result<(), CoreError> {
        if matches!(context.visibility(), QueryVisibility::Agent(_))
            && !matches!(
                self,
                Self::SessionRead(_) | Self::ItemMessages(_) | Self::ItemRounds(_)
            )
        {
            return Err(CoreError::new(
                CoreErrorCode::PermissionDenied,
                "Query is available only to a local owner",
                "Use the bounded bound-agent query tools.",
            ));
        }
        self.validate_owner_wire()
    }
    fn validate_owner_wire(&self) -> Result<(), CoreError> {
        match self {
            Self::ProjectList(value) => cursor(&value.cursor, QueryView::Projects)?,
            Self::SessionList(value) => cursor(&value.cursor, QueryView::Sessions)?,
            Self::SessionRead(value) => {
                let view = match value.selection {
                    ReadView::Topics { .. } => QueryView::Topics,
                    ReadView::Items { .. } => QueryView::Items,
                    ReadView::Messages { .. } => QueryView::Messages,
                    ReadView::Inputs { .. } => QueryView::Inputs,
                };
                cursor(&value.cursor, view)?;
                if !value.item_pages.is_empty()
                    && !matches!(value.selection, ReadView::Items { .. })
                {
                    return Err(invalid("Item history continuations require the items view"));
                }
                for nested in &value.item_pages {
                    match nested {
                        ItemPageRequest::ItemUpdatedMessages { cursor: value, .. } => {
                            cursor(value, QueryView::ItemUpdatedMessages)?
                        }
                        ItemPageRequest::ItemStatusHistory { cursor: value, .. } => {
                            cursor(value, QueryView::ItemStatusHistory)?
                        }
                    }
                }
            }
            Self::ItemMessages(value) => cursor(&value.cursor, QueryView::ItemMessages)?,
            Self::ItemRounds(value) => {
                cursor(&value.cursor, QueryView::ItemRounds)?;
                for nested in &value.round_pages {
                    match nested {
                        RoundPageRequest::RoundAnswers { cursor: value, .. } => {
                            cursor(value, QueryView::RoundAnswers)?
                        }
                        RoundPageRequest::RoundOwnerMessages { cursor: value, .. } => {
                            cursor(value, QueryView::RoundOwnerMessages)?
                        }
                        RoundPageRequest::RoundAgentMessages { cursor: value, .. } => {
                            cursor(value, QueryView::RoundAgentMessages)?
                        }
                        RoundPageRequest::RoundResults { cursor: value, .. } => {
                            cursor(value, QueryView::RoundResults)?
                        }
                        RoundPageRequest::RoundForks { cursor: value, .. } => {
                            cursor(value, QueryView::RoundForks)?
                        }
                    }
                }
            }
            _ => {}
        }
        size(self, 512 * 1024)
    }
}

fn cursor(value: &Option<QueryCursor>, view: QueryView) -> Result<(), CoreError> {
    let Some(value) = value else { return Ok(()) };
    if value.view != view {
        return Err(invalid(
            "Cursor view does not match the requested collection",
        ));
    }
    let position_matches = matches!(
        (&view, &value.after),
        (_, None)
            | (QueryView::Projects, Some(CursorPosition::Project { .. }))
            | (QueryView::Sessions, Some(CursorPosition::Session { .. }))
            | (QueryView::Topics, Some(CursorPosition::Topic { .. }))
            | (
                QueryView::Items | QueryView::RoundForks,
                Some(CursorPosition::Item { .. })
            )
            | (QueryView::ItemRounds, Some(CursorPosition::Round { .. }))
            | (
                QueryView::ItemStatusHistory,
                Some(CursorPosition::History { .. })
            )
            | (QueryView::RoundResults, Some(CursorPosition::Result { .. }))
            | (
                QueryView::Messages
                    | QueryView::Inputs
                    | QueryView::ItemMessages
                    | QueryView::RoundAnswers
                    | QueryView::RoundOwnerMessages
                    | QueryView::RoundAgentMessages
                    | QueryView::ItemUpdatedMessages,
                Some(CursorPosition::Sequence { .. })
            )
    );
    if position_matches {
        Ok(())
    } else {
        Err(invalid("Cursor sort position does not match its view"))
    }
}

impl QueryResult {
    pub fn validate_for(
        &self,
        context: &QueryContext,
        request: &QueryRequest,
    ) -> Result<(), CoreError> {
        match (self, request) {
            (Self::ProjectList(result), QueryRequest::ProjectList(request)) => {
                page(&result.projects, request.limit.value())?;
                continued_page(&result.projects, &request.cursor, QueryView::Projects)?;
                for summary in &result.projects.items {
                    if summary
                        .project
                        .as_ref()
                        .is_some_and(|project| project.id != summary.project_id)
                        || (summary.availability == ProjectAvailability::Available
                            && summary.project.is_none())
                        || (summary.availability == ProjectAvailability::Unavailable
                            && summary.counts.completeness != Completeness::Partial)
                    {
                        return Err(invalid(
                            "Project summary contradicts registered identity or availability",
                        ));
                    }
                }
            }
            (Self::SessionList(result), QueryRequest::SessionList(request)) => {
                page(&result.sessions, request.limit.value())?;
                continued_page(&result.sessions, &request.cursor, QueryView::Sessions)?;
            }
            (Self::SessionGet(result), QueryRequest::SessionGet {}) => {
                let QueryVisibility::Owner(owner) = context.visibility() else {
                    return Err(scope_error());
                };
                let OwnerScope::Session(session) = owner.scope() else {
                    return Err(scope_error());
                };
                if &result.session.id != session.session_id()
                    || &result.session.project_id != session.project_id()
                {
                    return Err(scope_error());
                }
            }
            (Self::SessionRead(result), QueryRequest::SessionRead(request)) => {
                let limit = request.limit.value();
                match (result, &request.selection, context.visibility()) {
                    (SessionReadResult::Topics(value), ReadView::Topics { .. }, _) => {
                        page(value, limit)?;
                        continued_page(value, &request.cursor, QueryView::Topics)?;
                    }
                    (SessionReadResult::Items(value), ReadView::Items { .. }, _) => {
                        page(value, limit)?;
                        continued_page(value, &request.cursor, QueryView::Items)?;
                        let selectors: Vec<_> =
                            request.item_pages.iter().map(item_selection).collect();
                        fulfilled_selectors(
                            &selectors,
                            &value
                                .items
                                .iter()
                                .map(|item| item.item.id.as_str())
                                .collect::<Vec<_>>(),
                        )?;
                        for item in &value.items {
                            let nested_limit = nested_page(
                                &item.updated_messages,
                                item.item.id.as_str(),
                                QueryView::ItemUpdatedMessages,
                                &selectors,
                                value.snapshot_revision,
                            )?;
                            messages(&item.updated_messages, nested_limit, context)?;
                            nested_page(
                                &item.status_history,
                                item.item.id.as_str(),
                                QueryView::ItemStatusHistory,
                                &selectors,
                                value.snapshot_revision,
                            )?;
                        }
                    }
                    (SessionReadResult::Messages(value), ReadView::Messages { .. }, _) => {
                        messages(value, limit, context)?;
                        continued_page(value, &request.cursor, QueryView::Messages)?;
                    }
                    (
                        SessionReadResult::Inputs(value),
                        ReadView::Inputs { .. },
                        QueryVisibility::Owner(_),
                    ) => {
                        page(value, limit)?;
                        continued_page(value, &request.cursor, QueryView::Inputs)?;
                    }
                    (
                        SessionReadResult::InputsQueue(value),
                        ReadView::Inputs { .. },
                        QueryVisibility::Agent(_),
                    ) => {
                        page(value, limit)?;
                        continued_page(value, &request.cursor, QueryView::Inputs)?;
                    }
                    _ => return Err(scope_error()),
                }
            }
            (Self::ItemMessages(result), QueryRequest::ItemMessages(request)) => {
                if result.item_id != request.item_id {
                    return Err(scope_error());
                }
                messages(&result.messages, request.limit.value(), context)?;
                continued_page(&result.messages, &request.cursor, QueryView::ItemMessages)?;
                if let Some(created) = &result.timeline_context.created_message {
                    messages(
                        &Page {
                            items: vec![created.clone()],
                            next_cursor: None,
                            snapshot_revision: result.messages.snapshot_revision,
                        },
                        1,
                        context,
                    )?;
                }
            }
            (Self::ItemRounds(result), QueryRequest::ItemRounds(request)) => {
                if result.item_id != request.item_id {
                    return Err(scope_error());
                }
                page(&result.rounds, request.limit.value())?;
                continued_page(&result.rounds, &request.cursor, QueryView::ItemRounds)?;
                let selectors: Vec<_> = request.round_pages.iter().map(round_selection).collect();
                fulfilled_selectors(
                    &selectors,
                    &result
                        .rounds
                        .items
                        .iter()
                        .map(|round| round.round.id.as_str())
                        .collect::<Vec<_>>(),
                )?;
                for round in &result.rounds.items {
                    if round.round.item_id != request.item_id {
                        return Err(scope_error());
                    }
                    let parent = round.round.id.as_str();
                    let revision = result.rounds.snapshot_revision;
                    nested_page(
                        &round.answers,
                        parent,
                        QueryView::RoundAnswers,
                        &selectors,
                        revision,
                    )?;
                    let owner_limit = nested_page(
                        &round.owner_messages,
                        parent,
                        QueryView::RoundOwnerMessages,
                        &selectors,
                        revision,
                    )?;
                    messages(&round.owner_messages, owner_limit, context)?;
                    let agent_limit = nested_page(
                        &round.agent_messages,
                        parent,
                        QueryView::RoundAgentMessages,
                        &selectors,
                        revision,
                    )?;
                    messages(&round.agent_messages, agent_limit, context)?;
                    nested_page(
                        &round.results,
                        parent,
                        QueryView::RoundResults,
                        &selectors,
                        revision,
                    )?;
                    nested_page(
                        &round.forks,
                        parent,
                        QueryView::RoundForks,
                        &selectors,
                        revision,
                    )?;
                }
            }
            (Self::TopicContinuePreview(result), QueryRequest::TopicContinuePreview(request)) => {
                if result.source != request.source
                    || result.source_topic_id != request.source_topic_id
                    || result.target != request.target
                {
                    return Err(scope_error());
                }
                text(&result.summary, 1024 * 1024, true)?;
            }
            (Self::PreferencesGet(_), QueryRequest::PreferencesGet {}) => {}
            (Self::RevealItem(result), QueryRequest::RevealItem { item_id }) => {
                let QueryVisibility::Owner(owner) = context.visibility() else {
                    return Err(scope_error());
                };
                let OwnerScope::Session(session) = owner.scope() else {
                    return Err(scope_error());
                };
                if &result.project_id != session.project_id()
                    || &result.session_id != session.session_id()
                    || &result.item_id != item_id
                {
                    return Err(scope_error());
                }
            }
            _ => return Err(scope_error()),
        }
        // session_get is local full snapshot; bounded read responses retain caps.
        if !matches!(self, Self::SessionGet(_)) {
            size(self, 1024 * 1024)?;
        }
        Ok(())
    }
}

/// Validate the original owner request against its canonical saved receipt.
pub fn validate_owner_receipt(
    request: &OwnerMutationRequest,
    receipt: &MutationReceipt,
) -> Result<(), CoreError> {
    let matches = match receipt {
        MutationReceipt::PreferencesPatched(receipt) => {
            matches!(request.command, OwnerCommand::PreferencesPatch { .. })
                && receipt.operation_id == *request.command.operation_id()
        }
        MutationReceipt::ProjectRegistered(receipt) => {
            matches!(request.command, OwnerCommand::ProjectRegister { .. })
                && receipt.operation_id == *request.command.operation_id()
        }
        MutationReceipt::Session(receipt) => {
            receipt.operation_id == *request.command.operation_id()
                && match (&request.session, &request.command) {
                    (Some(route), _) => route.session_id == receipt.session_id,
                    (None, OwnerCommand::BindingConnect { params, .. }) => params
                        .existing_session_id
                        .as_ref()
                        .is_none_or(|id| id == &receipt.session_id),
                    _ => false,
                }
                && match (&request.command, &receipt.data) {
                    (
                        OwnerCommand::ItemRestore { params, .. },
                        SavedReceiptData::BinRestore { item_id, .. },
                    ) => item_id.as_ref() == Some(&params.item_id),
                    (
                        OwnerCommand::TopicRemovedRestore { params, .. },
                        SavedReceiptData::BinRestore { topic_id, item_id },
                    ) => topic_id == &params.topic_id && item_id.is_none(),
                    (
                        OwnerCommand::Ack { params, .. },
                        SavedReceiptData::ItemAck {
                            item_id,
                            item_revision,
                            status,
                            ..
                        },
                    ) => {
                        item_id == &params.item_id
                            && item_revision.value()
                                == params.expected_revision.value().saturating_add(1)
                            && matches!(
                                status,
                                ItemStatus::Open
                                    | ItemStatus::InProgress
                                    | ItemStatus::Decided
                                    | ItemStatus::Done
                                    | ItemStatus::Dropped
                            )
                    }
                    _ => true,
                }
                && matches!(
                    (&request.command, &receipt.data),
                    (
                        OwnerCommand::BindingConnect { .. },
                        SavedReceiptData::BindingConnect { .. }
                    ) | (
                        OwnerCommand::InputSubmit { .. },
                        SavedReceiptData::InputSubmit { .. }
                    ) | (
                        OwnerCommand::InputCancel { .. },
                        SavedReceiptData::InputCancel { .. }
                    ) | (
                        OwnerCommand::InputResolve { .. },
                        SavedReceiptData::InputResolve { .. }
                    ) | (
                        OwnerCommand::TopicArchive { .. } | OwnerCommand::TopicRestore { .. },
                        SavedReceiptData::TopicLifecycle { .. }
                    ) | (
                        OwnerCommand::SessionClose { .. }
                            | OwnerCommand::SessionReopen { .. }
                            | OwnerCommand::SessionArchive { .. }
                            | OwnerCommand::SessionRestore { .. },
                        SavedReceiptData::SessionLifecycle { .. }
                    ) | (OwnerCommand::Ack { .. }, SavedReceiptData::ItemAck { .. })
                        | (
                            OwnerCommand::ItemRestore { .. }
                                | OwnerCommand::TopicRemovedRestore { .. },
                            SavedReceiptData::BinRestore { .. }
                        )
                        | (
                            OwnerCommand::SessionLabelSet { .. },
                            SavedReceiptData::SessionLabel { .. }
                        )
                        | (
                            OwnerCommand::BindingPause { .. }
                                | OwnerCommand::BindingResume { .. }
                                | OwnerCommand::BindingDisconnect { .. },
                            SavedReceiptData::BindingState { .. }
                        )
                        | (
                            OwnerCommand::TopicContinue { .. },
                            SavedReceiptData::Continuation { .. }
                        )
                        | (
                            OwnerCommand::ItemRemove { .. } | OwnerCommand::TopicRemove { .. },
                            SavedReceiptData::Removal { .. }
                        )
                )
        }
        MutationReceipt::Removed(receipt) => {
            receipt.operation_id == *request.command.operation_id()
                && match &request.command {
                    OwnerCommand::SessionRemove { params, .. } => {
                        receipt.scope == RemovedScope::Session
                            && receipt.project_id == params.project_id
                            && receipt.session_ids == [params.session_id.clone()]
                    }
                    OwnerCommand::ProjectRemove { params, .. } => {
                        receipt.scope == RemovedScope::Project
                            && receipt.project_id == params.project_id
                    }
                    _ => false,
                }
                && !receipt.backup.trim().is_empty()
        }
    };
    if matches {
        Ok(())
    } else {
        Err(CoreError::new(
            CoreErrorCode::ProtocolConflict,
            "CoreService returned a receipt for a different operation or route.",
            "Keep the original operation ID and reconcile the local service.",
        ))
    }
}
