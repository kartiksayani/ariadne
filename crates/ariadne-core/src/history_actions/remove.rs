//! Owner removal of items, topics, sessions and projects. Removal is permanent
//! inside Ariadne; a `pre-remove-…` backup is written before every hard delete.
//! Conversations and files outside Ariadne's own store are never changed.
use super::{core, preview, HistoryActionError, HistoryActionService};
use crate::*;
use ariadne_domain::models::*;
use ariadne_store::session::Store;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// Longest item question or topic name quoted in a notice once the full notice
/// would not fit the delivery budget.
const SHORT: usize = 200;

/// Topic family members keyed by (project, session): the session and every
/// family topic it holds (a topic continued twice into one session, or back
/// into its source session, puts two family topics in one session).
type Family = BTreeMap<(UuidV4, UuidV4), (Session, BTreeSet<UuidV4>)>;

impl HistoryActionService<'_> {
    pub fn remove(
        &self,
        context: &OwnerContext,
        command: &OwnerCommand,
        mut allocate: impl FnMut() -> UuidV4,
        at: UtcMillis,
    ) -> Result<MutationReceipt, HistoryActionError> {
        let version = match command {
            OwnerCommand::ItemRemove { api_version, .. }
            | OwnerCommand::TopicRemove { api_version, .. }
            | OwnerCommand::SessionRemove { api_version, .. }
            | OwnerCommand::ProjectRemove { api_version, .. } => api_version,
            _ => {
                return Err(
                    core(CoreErrorCode::InvalidArgument, "Expected a remove command").into(),
                )
            }
        };
        if version.value() != 1 {
            return Err(core(CoreErrorCode::Unsupported, "Unsupported owner API version").into());
        }
        command.validate_wire()?;
        let stamp = stamp(&at);
        match command {
            OwnerCommand::ItemRemove { params, .. } => {
                let route = session_route(context)?;
                let normalized = crate::receipts::normalized("item_remove", params)?;
                let store = self.open_store(route.project_id())?;
                let saved = store.transact_removal(
                    route.session_id(),
                    &ReceiptActorScope::Owner {},
                    command.operation_id(),
                    &normalized,
                    &stamp,
                    |session, backup| {
                        let item = session.items.0.get(&params.item_id).ok_or_else(|| {
                            core(CoreErrorCode::NotFound, "The item does not exist")
                        })?;
                        revision(params.expected_revision, item.revision)?;
                        let scope = subtree(session, &params.item_id);
                        let purged = purge(session, scope, BTreeSet::new())?;
                        let notice = match told_binding(session) {
                            Some(binding) => {
                                let id = fresh(session, &mut allocate)?;
                                let topic = purged.item_topic.clone().expect("item scope");
                                enqueue(
                                    session,
                                    &binding,
                                    &id,
                                    topic,
                                    &purged,
                                    &mut allocate,
                                    &at,
                                )?;
                                Some(RemovalTarget {
                                    session_id: session.id.clone(),
                                    id,
                                })
                            }
                            None => None,
                        };
                        finish(session, &at)?;
                        Ok::<_, CoreError>(purged.data(vec![], notice, backup))
                    },
                )?;
                Ok(MutationReceipt::Session(Box::new(saved)))
            }
            OwnerCommand::TopicRemove { params, .. } => {
                let route = session_route(context)?;
                let normalized = crate::receipts::normalized("topic_remove", params)?;
                self.remove_topic(
                    route,
                    params,
                    command.operation_id(),
                    &normalized,
                    &stamp,
                    &mut allocate,
                    &at,
                )
            }
            OwnerCommand::SessionRemove { params, .. } => {
                registry_route(context)?;
                let store = self.open_store(&params.project_id)?;
                let backup = store
                    .remove_session(&params.session_id, command.operation_id(), &stamp, |live| {
                        revision(params.expected_revision, live.revision)?;
                        in_flight(std::slice::from_ref(live))
                    })?
                    .ok_or_else(|| core(CoreErrorCode::NotFound, "The session does not exist"))?;
                // Retire the session's binding route; the removal itself is durable.
                self.registry.rebuild()?;
                Ok(MutationReceipt::Removed(RemovedReceipt {
                    operation_id: command.operation_id().clone(),
                    scope: RemovedScope::Session,
                    project_id: params.project_id.clone(),
                    session_ids: vec![params.session_id.clone()],
                    backup: path_text(&backup),
                }))
            }
            OwnerCommand::ProjectRemove { params, .. } => {
                registry_route(context)?;
                let removal = self.registry.remove_project(
                    &params.project_id,
                    command.operation_id(),
                    &stamp,
                    |sessions| in_flight(sessions).map_err(HistoryActionError::from),
                )?;
                Ok(MutationReceipt::Removed(RemovedReceipt {
                    operation_id: removal.operation_id,
                    scope: RemovedScope::Project,
                    project_id: removal.project_id,
                    session_ids: removal.session_ids,
                    backup: path_text(&removal.backup),
                }))
            }
            _ => unreachable!("matched remove command"),
        }
    }

    /// The route session commits first, removing every family topic it holds,
    /// and records the whole topic family. Other members then commit under the
    /// same operation ID, so a retry replays the route and finishes any member
    /// that is still left. Every member is read before the route commits; one
    /// that cannot be read refuses the whole removal.
    #[allow(clippy::too_many_arguments)]
    fn remove_topic(
        &self,
        route: &RegisteredSession,
        params: &TopicLifecycleParams,
        operation_id: &UuidV4,
        normalized: &serde_json::Value,
        stamp: &str,
        allocate: &mut impl FnMut() -> UuidV4,
        at: &UtcMillis,
    ) -> Result<MutationReceipt, HistoryActionError> {
        let store = self.open_store(route.project_id())?;
        let owner = ReceiptActorScope::Owner {};
        let saved = match store.replay(route.session_id(), &owner, operation_id, normalized)? {
            Some(saved) => saved,
            None => {
                let members = self.family(route, &params.topic_id)?;
                for (session, topics) in members.values() {
                    blocking(session, &subtree_of_topics(session, topics), topics)?;
                }
                // Tell only the copy most recently continued into, else the original.
                let told = members
                    .values()
                    .flat_map(|(session, topics)| topics.iter().map(move |t| (session, t)))
                    .max_by_key(|(session, topic)| continued_at(session, topic))
                    .map(|(session, _)| session)
                    .filter(|session| told_binding(session).is_some());
                let notice = match told {
                    Some(session) => Some(RemovalTarget {
                        id: fresh(session, allocate)?,
                        session_id: session.id.clone(),
                    }),
                    None => None,
                };
                let family: Vec<_> = members
                    .values()
                    .flat_map(|(session, topics)| {
                        topics.iter().map(|topic| RemovalTarget {
                            session_id: session.id.clone(),
                            id: topic.clone(),
                        })
                    })
                    .collect();
                store.transact_removal(
                    route.session_id(),
                    &owner,
                    operation_id,
                    normalized,
                    stamp,
                    |session, backup| {
                        let topic = session.topics.0.get(&params.topic_id).ok_or_else(|| {
                            core(CoreErrorCode::NotFound, "The topic does not exist")
                        })?;
                        revision(params.expected_revision, topic.revision)?;
                        let topics = held(session, &family);
                        remove_member(session, &topics, family, notice, backup, allocate, at)
                    },
                )?
            }
        };
        let SavedReceiptData::Removal { family, notice, .. } = &saved.data else {
            return Err(core(
                CoreErrorCode::ProtocolConflict,
                "Saved removal receipt has another shape",
            )
            .into());
        };
        let members: BTreeSet<&UuidV4> = family
            .iter()
            .map(|m| &m.session_id)
            .filter(|id| *id != route.session_id())
            .collect();
        let mut done = vec![route.session_id().clone()];
        let mut left = vec![];
        for member in members {
            let result = self.member_store(member).and_then(|store| {
                // A member session removed since is already done.
                let Some(store) = store else { return Ok(()) };
                let result = store.transact_removal(
                    member,
                    &owner,
                    operation_id,
                    normalized,
                    stamp,
                    |session, backup| {
                        let topics = held(session, family);
                        if topics.is_empty() {
                            return Err(core(CoreErrorCode::NotFound, "Already removed"));
                        }
                        remove_member(
                            session,
                            &topics,
                            family.clone(),
                            notice.clone(),
                            backup,
                            allocate,
                            at,
                        )
                    },
                );
                match result {
                    Ok(_) => Ok(()),
                    Err(ariadne_store::session::TransactionError::Command(error))
                        if error.code == CoreErrorCode::NotFound =>
                    {
                        Ok(())
                    }
                    Err(error) => Err(error.into()),
                }
            });
            match result {
                Ok(()) => done.push(member.clone()),
                Err(error) => left.push((
                    member.clone(),
                    match error {
                        HistoryActionError::Core(error) => error,
                        HistoryActionError::Registry(error) => error.into(),
                        HistoryActionError::Store(error) => error.into(),
                    },
                )),
            }
        }
        if let Some((_, first)) = left.first() {
            let names = |ids: &mut dyn Iterator<Item = &UuidV4>| {
                ids.map(UuidV4::as_str).collect::<Vec<_>>().join(", ")
            };
            let mut error = CoreError::new(
                first.code,
                format!(
                    "The topic was removed from session(s) {} but is still in session(s) {}: {}",
                    names(&mut done.iter()),
                    names(&mut left.iter().map(|(id, _)| id)),
                    first.message,
                ),
                format!(
                    "Fix the cause, then retry operation {} to finish removing the topic.",
                    operation_id.as_str()
                ),
            );
            let mut details = first
                .details
                .clone()
                .unwrap_or_else(|| details(None, vec![], vec![]).expect("details"));
            details.partial_removal = Some(PartialRemoval {
                removed: done.clone(),
                remaining: left.iter().map(|(id, _)| id.clone()).collect(),
            });
            error.details = Some(details);
            return Err(error.into());
        }
        Ok(MutationReceipt::Session(Box::new(saved)))
    }

    /// The store holding a family member session, searched across registered
    /// projects. `None` when no project holds it any more. A project whose
    /// store, or the member file itself, cannot be read is an error.
    fn member_store(&self, session_id: &UuidV4) -> Result<Option<Store>, HistoryActionError> {
        for project in self.registry.registered_projects()? {
            let Some(store) = self.family_store(&project)? else {
                continue;
            };
            match store.read(session_id) {
                Ok(_) => return Ok(Some(store)),
                Err(ariadne_store::session::StoreError::Io {
                    kind: std::io::ErrorKind::NotFound,
                    ..
                }) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(None)
    }

    /// A registered project's store for family reads, under the data root.
    /// `None` when the project has no store there and no legacy store left to
    /// migrate. The project folder itself need not be reachable.
    fn family_store(
        &self,
        project: &ariadne_store::registry::RegisteredProject,
    ) -> Result<Option<Store>, HistoryActionError> {
        let dir = self.registry.project_dir(&project.project_id);
        match Store::open_registered(&dir, project.project_id.clone()) {
            Ok(store) => Ok(Some(store)),
            Err(ariadne_store::session::StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
                ..
            }) if !dir.exists()
                && ariadne_store::registry::legacy_store_path(&project.root).is_none() =>
            {
                Ok(None)
            }
            Err(error) => Err(error.into()),
        }
    }

    /// Every (session, topics) in the continuation family of the route topic,
    /// across registered projects, keyed by (project, session). Copies link to
    /// their source through `origin`; a removed source still joins its copies.
    /// Any project whose sessions cannot be read refuses: it may hold a copy.
    fn family(
        &self,
        route: &RegisteredSession,
        topic_id: &UuidV4,
    ) -> Result<Family, HistoryActionError> {
        let mut sessions = vec![];
        for project in self.registry.registered_projects()? {
            let store = if &project.project_id == route.project_id() {
                Some(self.open_store(&project.project_id)?)
            } else {
                self.family_store(&project)?
            };
            if let Some(store) = store {
                sessions.extend(store.sessions()?);
            }
        }
        let route_session = sessions
            .iter()
            .find(|s| &s.id == route.session_id())
            .ok_or_else(|| core(CoreErrorCode::NotFound, "The session does not exist"))?;
        if !route_session.topics.0.contains_key(topic_id) {
            return Err(core(CoreErrorCode::NotFound, "The topic does not exist").into());
        }
        // Undirected links between (session, topic) keys, including dangling sources.
        let mut links: BTreeMap<(UuidV4, UuidV4), Vec<(UuidV4, UuidV4)>> = BTreeMap::new();
        for session in &sessions {
            for topic in session.topics.0.values() {
                let key = (session.id.clone(), topic.id.clone());
                links.entry(key.clone()).or_default();
                if let Some(origin) = &topic.origin {
                    let source = (origin.session_id.clone(), origin.topic_id.clone());
                    links.entry(key.clone()).or_default().push(source.clone());
                    links.entry(source).or_default().push(key);
                }
            }
        }
        let mut seen = BTreeSet::new();
        let mut pending = vec![(route.session_id().clone(), topic_id.clone())];
        while let Some(key) = pending.pop() {
            if seen.insert(key.clone()) {
                pending.extend(links.get(&key).into_iter().flatten().cloned());
            }
        }
        Ok(sessions
            .into_iter()
            .filter_map(|session| {
                let topics: BTreeSet<_> = session
                    .topics
                    .0
                    .keys()
                    .filter(|t| seen.contains(&(session.id.clone(), (*t).clone())))
                    .cloned()
                    .collect();
                if topics.is_empty() {
                    return None;
                }
                Some((
                    (session.project_id.clone(), session.id.clone()),
                    (session, topics),
                ))
            })
            .collect())
    }

    /// Resolve the project (finishing any pending store migration) and open
    /// its store under the data root.
    fn open_store(&self, project_id: &UuidV4) -> Result<Store, HistoryActionError> {
        let project = self.registry.resolve_project(project_id)?;
        Ok(Store::open_registered(
            &self.registry.project_dir(&project.project_id),
            project.project_id,
        )?)
    }
}

fn session_route(context: &OwnerContext) -> Result<&RegisteredSession, CoreError> {
    match context.scope() {
        OwnerScope::Session(route) => Ok(route),
        _ => Err(core(
            CoreErrorCode::PermissionDenied,
            "Item and topic removal require an owner session route",
        )),
    }
}
fn registry_route(context: &OwnerContext) -> Result<(), CoreError> {
    match context.scope() {
        OwnerScope::Registry => Ok(()),
        _ => Err(core(
            CoreErrorCode::PermissionDenied,
            "Session and project removal use session:null",
        )),
    }
}

/// Backup name stamp: the UTC time with only its letters and digits.
fn stamp(at: &UtcMillis) -> String {
    at.as_str()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect()
}
fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn revision(expected: PositiveSafeInteger, current: PositiveSafeInteger) -> Result<(), CoreError> {
    if expected == current {
        return Ok(());
    }
    let mut error = core(CoreErrorCode::RevisionConflict, "The revision changed");
    error.current_revision = Some(current);
    Err(error)
}

fn details(
    session: Option<&Session>,
    blocking_item_ids: Vec<ItemRef>,
    blocking_input_ids: Vec<UuidV4>,
) -> Option<Box<ErrorDetails>> {
    Some(Box::new(ErrorDetails {
        reason: None,
        binding_id: session.and_then(|s| s.active_binding_id.clone()),
        input_id: None,
        attempt_id: None,
        blocking_item_ids,
        blocking_input_ids,
        dispatch_must_pause: false,
        partial_removal: None,
    }))
}

/// Session and project removal refuse while any input is in flight. Uses the
/// session-close code and details so the UI shows the same blockers.
fn in_flight(sessions: &[Session]) -> Result<(), CoreError> {
    let ids: Vec<_> = sessions
        .iter()
        .flat_map(|s| s.inputs.0.values())
        .filter(|input| input.state == InputState::InFlight)
        .map(|input| input.id.clone())
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    let mut error = core(
        CoreErrorCode::SessionNotClosable,
        "An input is in flight; wait for it to finish or resolve it before removing",
    );
    error.details = details(
        sessions.first().filter(|_| sessions.len() == 1),
        vec![],
        ids,
    );
    Err(error)
}

/// The item and every item below it, following actual parent links.
fn subtree(session: &Session, root: &ItemRef) -> BTreeSet<ItemRef> {
    let mut scope = BTreeSet::from([root.clone()]);
    loop {
        let before = scope.len();
        for item in session.items.0.values() {
            if item.parent.as_ref().is_some_and(|p| scope.contains(p)) {
                scope.insert(item.id.clone());
            }
        }
        if scope.len() == before {
            return scope;
        }
    }
}
fn subtree_of_topics(session: &Session, topics: &BTreeSet<UuidV4>) -> BTreeSet<ItemRef> {
    session
        .items
        .0
        .values()
        .filter(|item| topics.contains(&item.topic_id))
        .map(|item| item.id.clone())
        .collect()
}

/// The family topics this session still holds.
fn held(session: &Session, family: &[RemovalTarget]) -> BTreeSet<UuidV4> {
    family
        .iter()
        .filter(|m| m.session_id == session.id && session.topics.0.contains_key(&m.id))
        .map(|m| m.id.clone())
        .collect()
}

/// When the topic was continued into its session; `None` for an original.
fn continued_at(session: &Session, topic: &UuidV4) -> Option<UtcMillis> {
    session
        .topics
        .0
        .get(topic)
        .and_then(|topic| topic.origin.as_ref())
        .map(|origin| origin.continued_at.clone())
}

fn targeted(input: &Input, items: &BTreeSet<ItemRef>, topics: &BTreeSet<UuidV4>) -> bool {
    input
        .target
        .item_id
        .as_ref()
        .is_some_and(|id| items.contains(id))
        || topics.contains(&input.target.topic_id)
}

/// Refuse while work on the scope is in flight or awaiting recovery, or while a
/// remaining item names a removed item as its replacement.
fn blocking(
    session: &Session,
    items: &BTreeSet<ItemRef>,
    topics: &BTreeSet<UuidV4>,
) -> Result<(), CoreError> {
    let blocking_input_ids: Vec<_> = session
        .inputs
        .0
        .values()
        .filter(|input| {
            targeted(input, items, topics)
                && matches!(
                    input.state,
                    InputState::InFlight | InputState::NeedsAttention
                )
        })
        .map(|input| input.id.clone())
        .collect();
    let blocking_item_ids: Vec<_> = session
        .items
        .0
        .values()
        .filter(|item| {
            !items.contains(&item.id)
                && item.replaced_by.as_ref().is_some_and(|r| items.contains(r))
        })
        .map(|item| item.id.clone())
        .collect();
    if blocking_input_ids.is_empty() && blocking_item_ids.is_empty() {
        return Ok(());
    }
    let mut error = core(
        CoreErrorCode::InvalidTransition,
        "An input on this work is in flight or needs attention, or a remaining item was replaced by it",
    );
    error.details = details(Some(session), blocking_item_ids, blocking_input_ids);
    Err(error)
}

struct Purged {
    item_ids: Vec<ItemRef>,
    topic_ids: Vec<UuidV4>,
    input_ids: Vec<UuidV4>,
    refs: Vec<RemovedRef>,
    /// Topic of the removed item (item removal only).
    item_topic: Option<UuidV4>,
    topic_name: String,
}
impl Purged {
    fn data(
        self,
        family: Vec<RemovalTarget>,
        notice: Option<RemovalTarget>,
        backup: &Path,
    ) -> SavedReceiptData {
        SavedReceiptData::Removal {
            item_ids: self.item_ids,
            topic_ids: self.topic_ids,
            input_ids: self.input_ids,
            family,
            notice,
            backup: path_text(backup),
        }
    }
}

/// Remove every family topic `topics` this session holds, and queue the
/// notice here when this is the told session.
fn remove_member(
    session: &mut Session,
    topics: &BTreeSet<UuidV4>,
    family: Vec<RemovalTarget>,
    notice: Option<RemovalTarget>,
    backup: &Path,
    allocate: &mut impl FnMut() -> UuidV4,
    at: &UtcMillis,
) -> Result<SavedReceiptData, CoreError> {
    // The notice names the copy most recently continued into this session.
    let told = topics
        .iter()
        .max_by_key(|topic| continued_at(session, topic))
        .cloned()
        .expect("a member holds at least one family topic");
    let told_name = session.topics.0[&told].name.clone();
    let scope = subtree_of_topics(session, topics);
    let mut purged = purge(session, scope, topics.clone())?;
    purged.topic_name = told_name;
    let mut notice = notice;
    if let Some(target) = notice.clone().filter(|n| n.session_id == session.id) {
        match told_binding(session) {
            Some(binding) => enqueue(session, &binding, &target.id, told, &purged, allocate, at)?,
            // The told session lost its binding or closed since the family read.
            None => notice = None,
        }
    }
    finish(session, at)?;
    // Every member keeps the op's notice target so a retry can finish the family.
    Ok(purged.data(family, notice, backup))
}

/// Hard-delete the scope and every record that exists only for it, then strip
/// references to deleted records from what remains.
fn purge(
    session: &mut Session,
    items: BTreeSet<ItemRef>,
    topics: BTreeSet<UuidV4>,
) -> Result<Purged, CoreError> {
    blocking(session, &items, &topics)?;
    let item_topic = if topics.is_empty() {
        items
            .iter()
            .next()
            .and_then(|id| session.items.0.get(id))
            .map(|item| item.topic_id.clone())
    } else {
        None
    };
    let topic_name = item_topic
        .as_ref()
        .or(topics.iter().next())
        .and_then(|id| session.topics.0.get(id))
        .map(|topic| topic.name.clone())
        .unwrap_or_default();
    let inputs: BTreeSet<UuidV4> = session
        .inputs
        .0
        .values()
        .filter(|input| targeted(input, &items, &topics))
        .map(|input| input.id.clone())
        .collect();
    let rounds: BTreeSet<UuidV4> = session
        .rounds
        .0
        .values()
        .filter(|round| items.contains(&round.item_id))
        .map(|round| round.id.clone())
        .collect();
    let continuations: BTreeSet<UuidV4> = session
        .continuations
        .0
        .iter()
        .filter(|(_, receipt)| topics.contains(&receipt.target_topic_id))
        .map(|(id, _)| id.clone())
        .collect();
    let copied: BTreeSet<UuidV4> = continuations
        .iter()
        .flat_map(|id| {
            session.continuations.0[id]
                .message_id_map
                .0
                .values()
                .cloned()
        })
        .collect();
    // Records that remaining items and rounds still point at must stay.
    let mut kept = BTreeSet::new();
    for item in session.items.0.values().filter(|i| !items.contains(&i.id)) {
        kept.insert(item.created_message_id.clone());
        kept.extend(item.updated_message_ids.iter().cloned());
        kept.extend(
            item.status_history
                .iter()
                .map(|h| h.cause_message_id.clone()),
        );
    }
    for round in session
        .rounds
        .0
        .values()
        .filter(|r| !rounds.contains(&r.id))
    {
        kept.insert(round.opened_message_id.clone());
    }
    let mut messages = BTreeSet::new();
    for message in &session.messages {
        let only_removed = message
            .item_id
            .as_ref()
            .is_some_and(|id| items.contains(id))
            || (message.kind == MessageKind::OwnerInput
                && message
                    .input_id
                    .as_ref()
                    .is_some_and(|id| inputs.contains(id)));
        let removable = only_removed
            || message
                .topic_id
                .as_ref()
                .is_some_and(|id| topics.contains(id))
            || copied.contains(&message.id)
            || (message.kind == MessageKind::Activity
                && message.item_id.is_none()
                && !message.items_touched.is_empty()
                && message.items_touched.iter().all(|id| items.contains(id)));
        if !removable {
            continue;
        }
        if kept.contains(&message.id) {
            if only_removed || message.kind == MessageKind::Reply {
                return Err(core(
                    CoreErrorCode::InvalidTransition,
                    "A remaining item depends on a message of the removed work",
                ));
            }
            continue;
        }
        messages.insert(message.id.clone());
    }

    let mut refs: Vec<RemovedRef> = topics
        .iter()
        .filter_map(|id| session.topics.0.get(id))
        .map(|topic| RemovedRef::Topic {
            topic_id: topic.id.clone(),
            name: topic.name.clone(),
        })
        .collect();
    refs.extend(
        items
            .iter()
            .filter_map(|id| session.items.0.get(id))
            .map(|item| RemovedRef::Item {
                r#ref: item.id.clone(),
                question: item.question.clone(),
            }),
    );

    session.items.0.retain(|id, _| !items.contains(id));
    session.topics.0.retain(|id, _| !topics.contains(id));
    session.rounds.0.retain(|id, _| !rounds.contains(id));
    session.inputs.0.retain(|id, _| !inputs.contains(id));
    session
        .continuations
        .0
        .retain(|id, _| !continuations.contains(id));
    session
        .answers
        .retain(|a| !items.contains(&a.item_id) && !inputs.contains(&a.input_id));
    session.messages.retain(|m| !messages.contains(&m.id));

    for message in &mut session.messages {
        message.items_touched.retain(|id| !items.contains(id));
        if message
            .topic_id
            .as_ref()
            .is_some_and(|id| topics.contains(id))
        {
            message.topic_id = None;
        }
        if message
            .round_id
            .as_ref()
            .is_some_and(|id| rounds.contains(id))
        {
            message.round_id = None;
        }
        if message
            .input_id
            .as_ref()
            .is_some_and(|id| inputs.contains(id))
        {
            message.input_id = None;
            message.attempt_id = None;
            message.host_turn_id = None;
        }
    }
    for item in session.items.0.values_mut() {
        item.updated_message_ids.retain(|id| !messages.contains(id));
    }
    for round in session.rounds.0.values_mut() {
        round.owner_message_ids.retain(|id| !messages.contains(id));
        round.agent_message_ids.retain(|id| !messages.contains(id));
        round.fork_item_ids.retain(|id| !items.contains(id));
        round.result_input_ids.retain(|id| !inputs.contains(id));
    }
    for input in session.inputs.0.values_mut() {
        input
            .payload
            .context
            .message_ids
            .retain(|id| !messages.contains(id));
        input
            .payload
            .context
            .item_ids
            .retain(|id| !items.contains(id));
        for attempt in &mut input.attempts {
            if let Some(result) = &mut attempt.domain_result {
                result.reply_message_ids.retain(|id| !messages.contains(id));
                result.followup_item_ids.retain(|id| !items.contains(id));
            }
        }
    }
    Ok(Purged {
        item_ids: items.into_iter().collect(),
        topic_ids: topics.into_iter().collect(),
        input_ids: inputs.into_iter().collect(),
        refs,
        item_topic,
        topic_name,
    })
}

/// The binding a notice is queued on: the selected binding of an active session.
fn told_binding(session: &Session) -> Option<UuidV4> {
    if session.state != SessionState::Active {
        return None;
    }
    preview::selected(session).map(|binding| binding.id.clone())
}

fn fresh(session: &Session, allocate: &mut impl FnMut() -> UuidV4) -> Result<UuidV4, CoreError> {
    let id = allocate();
    let taken = session.inputs.0.contains_key(&id)
        || session.messages.iter().any(|m| m.id == id)
        || session.topics.0.contains_key(&id)
        || session.rounds.0.contains_key(&id)
        || session.bindings.0.contains_key(&id)
        || session.answers.iter().any(|a| a.id == id)
        || session.operation_receipts.0.contains_key(&id)
        || session.id == id
        || session.project_id == id;
    if taken {
        return Err(core(
            CoreErrorCode::InvalidArgument,
            "The native allocator returned an existing entity ID",
        ));
    }
    Ok(id)
}

fn increment(value: PositiveSafeInteger) -> Result<PositiveSafeInteger, CoreError> {
    value
        .value()
        .checked_add(1)
        .and_then(|n| PositiveSafeInteger::new(n).ok())
        .ok_or_else(|| {
            core(
                CoreErrorCode::CapacityExceeded,
                "A counter reached its limit",
            )
        })
}

fn short(text: &str) -> String {
    if text.chars().count() <= SHORT {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(SHORT - 1).collect();
    cut.push('…');
    cut
}

fn note(purged: &Purged) -> String {
    let below = purged.item_ids.len().saturating_sub(1);
    let what = if !purged.topic_ids.is_empty() {
        format!("topic \"{}\" and all its items", short(&purged.topic_name))
    } else {
        let root = purged.refs.iter().find_map(|r| match r {
            RemovedRef::Item { r#ref, question }
                if r#ref.as_str().split('.').count() == min_depth(purged) =>
            {
                Some(format!("item {} \"{}\"", r#ref.as_str(), short(question)))
            }
            _ => None,
        });
        let root = root.unwrap_or_else(|| "an item".into());
        match below {
            0 => root,
            1 => format!("{root} and the 1 item below it"),
            n => format!("{root} and the {n} items below it"),
        }
    };
    format!("The owner removed {what} from Ariadne. Stop working on them and never bring them up again.")
}
fn min_depth(purged: &Purged) -> usize {
    purged
        .item_ids
        .iter()
        .map(|id| id.as_str().split('.').count())
        .min()
        .unwrap_or(1)
}

/// Queue the `removed` notice on `binding`. The full list of refs is tried
/// first, then shortened questions, then the topic/root refs alone.
fn enqueue(
    session: &mut Session,
    binding: &UuidV4,
    input_id: &UuidV4,
    topic_id: UuidV4,
    purged: &Purged,
    allocate: &mut impl FnMut() -> UuidV4,
    at: &UtcMillis,
) -> Result<(), CoreError> {
    let pending = session
        .inputs
        .0
        .values()
        .filter(|i| {
            matches!(
                i.state,
                InputState::Queued | InputState::InFlight | InputState::NeedsAttention
            )
        })
        .count();
    if pending >= 100 {
        return Err(core(
            CoreErrorCode::QueueFull,
            "The agent already has 100 pending inputs; the removal notice cannot be queued",
        ));
    }
    if session.inputs.0.contains_key(input_id) {
        return Err(core(
            CoreErrorCode::InvalidArgument,
            "The native allocator returned an existing entity ID",
        ));
    }
    let message_id = fresh(session, allocate)?;
    let text = note(purged);
    let depth = min_depth(purged);
    let shortened: Vec<_> = purged
        .refs
        .iter()
        .map(|r| match r {
            RemovedRef::Item { r#ref, question } => RemovedRef::Item {
                r#ref: r#ref.clone(),
                question: short(question),
            },
            RemovedRef::Topic { topic_id, name } => RemovedRef::Topic {
                topic_id: topic_id.clone(),
                name: short(name),
            },
        })
        .collect();
    let roots: Vec<_> = shortened
        .iter()
        .filter(|r| match r {
            RemovedRef::Topic { .. } => true,
            RemovedRef::Item { r#ref, .. } => {
                purged.topic_ids.is_empty() && r#ref.as_str().split('.').count() == depth
            }
        })
        .cloned()
        .collect();
    let number = session.counters.next_message;
    let seq = session.counters.next_input;
    session.counters.next_message = increment(number)?;
    session.counters.next_input = increment(seq)?;
    session.messages.push(Message {
        id: message_id.clone(),
        number,
        author: MessageAuthor::Owner,
        kind: MessageKind::OwnerInput,
        body: text.clone(),
        created_at: at.clone(),
        item_id: None,
        topic_id: None,
        items_touched: vec![],
        binding_id: Some(binding.clone()),
        input_id: Some(input_id.clone()),
        attempt_id: None,
        host_turn_id: None,
        round_id: None,
        origin: None,
    });
    let mut last = None;
    for refs in [purged.refs.clone(), shortened, roots] {
        let input = Input {
            id: input_id.clone(),
            seq,
            binding_id: binding.clone(),
            kind: InputKind::Removed,
            target: InputTarget {
                topic_id: topic_id.clone(),
                item_id: None,
            },
            message_id: message_id.clone(),
            answer_id: None,
            created_at: at.clone(),
            expected_question_revision: None,
            payload: InputPayload {
                text: text.clone(),
                intent: InputKind::Removed,
                target_snapshot: InputTargetSnapshot {
                    topic_name: purged.topic_name.clone(),
                    item_question: None,
                    question_revision: None,
                    ask: None,
                    options: vec![],
                },
                selected_option_id: None,
                context: InputContext {
                    message_ids: vec![],
                    item_ids: vec![],
                    round_id: None,
                    continuation_operation_id: None,
                },
                removed: Some(RemovedNotice {
                    refs,
                    note: text.clone(),
                }),
            },
            state: InputState::Queued,
            attempts: vec![],
            active_attempt_id: None,
            resolution_history: vec![],
        };
        // Capacity check only: a UUID-length stand-in sizes the future attempt id.
        match crate::delivery::format::body(session, &input, input_id) {
            Ok(_) => {
                session.inputs.0.insert(input_id.clone(), input);
                return Ok(());
            }
            Err(error) => last = Some(error),
        }
    }
    Err(last.expect("tried at least once"))
}

/// Validate the candidate here so a removal that would break history reports
/// a clear owner error instead of a corrupt-store failure at commit. Delivery
/// receipts are pruned by the store, which validates delivery at commit.
fn finish(session: &mut Session, at: &UtcMillis) -> Result<(), CoreError> {
    session.updated_at = at.clone();
    let invalid = |detail: String| {
        core(
            CoreErrorCode::InvalidTransition,
            &format!("Removal would leave inconsistent history: {detail}"),
        )
    };
    ariadne_domain::validation::validate_session_items(session)
        .map_err(|e| invalid(format!("{e:?}")))?;
    ariadne_domain::history::validate_session_history(session)
        .map_err(|e| invalid(format!("{e:?}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo() -> Session {
        serde_json::from_str(include_str!(
            "../../../../fixtures/domain/demo/session.json"
        ))
        .unwrap()
    }

    // No store-valid session is known to reach this through `purge`; the
    // check is defence in depth, so it is driven with a hand-made candidate.
    #[test]
    fn finish_refuses_a_candidate_with_inconsistent_history() {
        let at = UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap();
        let mut session = demo();
        finish(&mut session, &at).unwrap();
        // Item 7 still names item 4 as its replacement.
        session.items.0.remove(&ItemRef::new("4").unwrap());
        let error = finish(&mut session, &at).unwrap_err();
        assert_eq!(error.code, CoreErrorCode::InvalidTransition);
        assert!(error
            .message
            .starts_with("Removal would leave inconsistent history: "));
        // Round 0x42 left without its item 8.
        let mut session = demo();
        session.items.0.remove(&ItemRef::new("8").unwrap());
        let error = finish(&mut session, &at).unwrap_err();
        assert_eq!(error.code, CoreErrorCode::InvalidTransition);
        assert!(error
            .message
            .starts_with("Removal would leave inconsistent history: "));
    }
}
