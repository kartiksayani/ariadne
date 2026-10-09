//! Native bounded reads of current registered authoritative snapshots.
mod counts;
pub use counts::waiting_unanswered;
mod error;
mod items;
mod page;
mod visibility;
use crate::*;
use ariadne_domain::models::*;
use ariadne_store::{
    registry::{Registry, RegistryCatalogue},
    session::Store,
};
pub use error::QueryError;
use page::{invalid, Scope};
use serde_json::json;

pub struct QueryService<'a> {
    registry: &'a Registry,
}
impl<'a> QueryService<'a> {
    pub fn new(registry: &'a Registry) -> Self {
        Self { registry }
    }
    pub fn query(
        &self,
        context: &QueryContext,
        request: &QueryRequest,
    ) -> Result<QueryResult, QueryError> {
        request.validate_wire(context)?;
        let result = match request {
            QueryRequest::ProjectList(request) => self.projects(context, request)?,
            QueryRequest::SessionList(request) => self.sessions(context, request)?,
            QueryRequest::TopicContinuePreview(_) | QueryRequest::PreferencesGet {} => {
                return Err(CoreError::new(
                    CoreErrorCode::Unsupported,
                    "Query is owned by a later product task",
                    "Use an implemented query.",
                )
                .into())
            }
            _ => {
                let route = visibility::route(context)?;
                let project = self.registry.resolve_project(route.project_id())?;
                let session = Store::read_registered(
                    &self.registry.project_dir(&project.project_id),
                    route.project_id(),
                    route.session_id(),
                )?;
                visibility::check(&session, context)?;
                session_query(&session, context, request)?
            }
        };
        result.validate_for(context, request)?;
        Ok(result)
    }
    fn projects(
        &self,
        context: &QueryContext,
        request: &ProjectListRequest,
    ) -> Result<QueryResult, QueryError> {
        if !matches!(context.visibility(), QueryVisibility::Owner(owner) if matches!(owner.scope(), OwnerScope::Registry))
        {
            return Err(invalid("Project list requires the native registry owner scope").into());
        }
        let captured = self.registry.catalogue()?;
        let scope = aggregate_scope(&captured, context, QueryView::Projects, json!({}))?;
        let mut total = counts::empty();
        let mut entries = Vec::new();
        for project in &captured.projects {
            let counts = project_counts(project)?;
            counts::merge(&mut total, &counts)?;
            let metadata = project
                .result
                .as_ref()
                .ok()
                .map(|catalogue| catalogue.project.clone());
            let available = project.result.as_ref().is_ok_and(|catalogue| {
                catalogue
                    .sessions
                    .as_ref()
                    .is_ok_and(|sessions| sessions.iter().all(|session| session.result.is_ok()))
            });
            let root = project
                .registered
                .root
                .to_str()
                .ok_or_else(|| invalid("Registered root is not UTF-8"))?
                .to_owned();
            entries.push((
                CursorPosition::Project {
                    canonical_root: root.clone(),
                    id: project.registered.project_id.clone(),
                },
                ProjectSummary {
                    project_id: project.registered.project_id.clone(),
                    project: metadata,
                    canonical_root: root,
                    availability: if available {
                        ProjectAvailability::Available
                    } else {
                        ProjectAvailability::Unavailable
                    },
                    counts,
                },
            ));
        }
        Ok(QueryResult::ProjectList(ProjectListResult {
            projects: page::page(
                entries,
                &scope,
                &request.cursor,
                request.limit.value(),
                page::payload_budget(page::bytes(&total)?),
                false,
            )?,
            counts: total,
        }))
    }
    fn sessions(
        &self,
        context: &QueryContext,
        request: &SessionListRequest,
    ) -> Result<QueryResult, QueryError> {
        let project_filter = match context.visibility() {
            QueryVisibility::Owner(owner) => match owner.scope() {
                OwnerScope::Registry => request.project_id.as_ref(),
                OwnerScope::Project(id)
                    if request
                        .project_id
                        .as_ref()
                        .is_none_or(|selected| selected == id) =>
                {
                    Some(id)
                }
                _ => return Err(invalid("Session list route is outside its owner scope").into()),
            },
            _ => return Err(invalid("Session list requires an owner scope").into()),
        };
        let captured = self.registry.catalogue()?;
        if project_filter.is_some_and(|id| {
            !captured
                .projects
                .iter()
                .any(|project| &project.registered.project_id == id)
        }) {
            return Err(not_found("Registered project is missing").into());
        }
        let scope = aggregate_scope(
            &captured,
            context,
            QueryView::Sessions,
            json!([project_filter, request.state]),
        )?;
        let mut total = counts::empty();
        let mut entries = Vec::new();
        let mut active = 0;
        let mut closed = 0;
        let mut archived = 0;
        for project in captured
            .projects
            .iter()
            .filter(|project| project_filter.is_none_or(|id| &project.registered.project_id == id))
        {
            // Unreadable unknown sessions still make totals explicitly partial.
            let mut partial = counts::empty();
            match &project.result {
                Ok(catalogue) => match &catalogue.sessions {
                    Ok(outcomes) => {
                        for outcome in outcomes {
                            match &outcome.result {
                                Ok(session) => {
                                    if session.archived_at.is_some() {
                                        archived += 1;
                                    } else if session.state == SessionState::Active {
                                        active += 1;
                                    } else {
                                        closed += 1;
                                    }
                                    let counts = counts::session(session)?;
                                    if session.archived_at.is_none() {
                                        counts::merge(&mut total, &counts)?;
                                    }
                                    if request.state.as_ref().is_some_and(|state| {
                                        session.archived_at.is_some() || state != &session.state
                                    }) {
                                        continue;
                                    }
                                    entries.push((
                                        CursorPosition::Session {
                                            updated_at: session.updated_at.clone(),
                                            project_id: session.project_id.clone(),
                                            id: session.id.clone(),
                                        },
                                        summary(session, counts, counts::topics(session)?),
                                    ));
                                }
                                Err(_) => {
                                    partial.completeness = Completeness::Partial;
                                    partial
                                        .unavailable_session_ids
                                        .extend(outcome.session_id.clone());
                                }
                            }
                        }
                    }
                    Err(_) => partial.completeness = Completeness::Partial,
                },
                Err(_) => partial.completeness = Completeness::Partial,
            }
            counts::merge(&mut total, &partial)?;
        }
        Ok(QueryResult::SessionList(SessionListResult {
            sessions: page::page(
                entries,
                &scope,
                &request.cursor,
                request.limit.value(),
                page::payload_budget(page::bytes(&total)?),
                false,
            )?,
            active_total: NonnegativeSafeInteger::new(active).map_err(|_| page::capacity())?,
            closed_total: NonnegativeSafeInteger::new(closed).map_err(|_| page::capacity())?,
            archived_total: NonnegativeSafeInteger::new(archived).map_err(|_| page::capacity())?,
            counts: total,
        }))
    }
}
fn project_counts(
    project: &ariadne_store::registry::RegisteredProjectRead,
) -> Result<SummaryCounts, CoreError> {
    let mut result = counts::empty();
    match &project.result {
        Ok(project) => match &project.sessions {
            Ok(sessions) => {
                for session in sessions {
                    match &session.result {
                        Ok(session) if session.archived_at.is_none() => {
                            counts::merge(&mut result, &counts::session(session)?)?;
                        }
                        Ok(_) => {}
                        Err(_) => {
                            result.completeness = Completeness::Partial;
                            result
                                .unavailable_session_ids
                                .extend(session.session_id.clone());
                        }
                    }
                }
            }
            Err(_) => result.completeness = Completeness::Partial,
        },
        Err(_) => result.completeness = Completeness::Partial,
    }
    result.unavailable_session_ids.sort();
    result.unavailable_session_ids.dedup();
    Ok(result)
}
fn aggregate_scope(
    catalogue: &RegistryCatalogue,
    context: &QueryContext,
    view: QueryView,
    filters: serde_json::Value,
) -> Result<Scope, CoreError> {
    let mut inventory = Vec::new();
    for project in &catalogue.projects {
        let metadata = project.result.as_ref().ok().map(|project| &project.project);
        let sessions = project
            .result
            .as_ref()
            .ok()
            .and_then(|project| project.sessions.as_ref().ok());
        let outcomes: Vec<_> = sessions
            .into_iter()
            .flatten()
            .map(|session| {
                json!([
                    session.session_id,
                    session.result.as_ref().ok().map(|session| session.revision),
                    session.result.is_ok()
                ])
            })
            .collect();
        inventory.push(json!([
            project.registered.project_id,
            project.registered.root,
            metadata,
            sessions.is_some(),
            outcomes
        ]));
    }
    Ok(Scope {
        digest: visibility::scope(context, json!([view, filters, inventory]))?,
        view,
        revision: PositiveSafeInteger::new(catalogue.revision.value().max(1))
            .expect("positive registry revision"),
        aggregate: true,
    })
}
fn summary(
    session: &Session,
    counts: SummaryCounts,
    topic_count: NonnegativeSafeInteger,
) -> SessionSummary {
    SessionSummary {
        project_id: session.project_id.clone(),
        session_id: session.id.clone(),
        title: session.title.clone(),
        name: session.name.clone(),
        description: session.description.clone(),
        state: session.state.clone(),
        revision: session.revision,
        created_at: session.created_at.clone(),
        updated_at: session.updated_at.clone(),
        closed_at: session.closed_at.clone(),
        archived_at: session.archived_at.clone(),
        active_binding: session
            .active_binding_id
            .as_ref()
            .and_then(|id| session.bindings.0.get(id))
            .map(|binding| BindingSummary {
                id: binding.id.clone(),
                adapter_id: binding.adapter_id.clone(),
                external_session_id: binding.external_session_id.clone(),
                generation: binding.generation.clone(),
                dispatch_state: binding.dispatch_state.clone(),
                owner_paused: binding.owner_paused,
                pause_reason: binding.pause_reason.clone(),
                connection_state: binding.connection_state.clone(),
                presence: None,
                host_location: binding.host_location.clone(),
            }),
        counts,
        topic_count,
    }
}
fn not_found(message: &str) -> CoreError {
    CoreError::new(
        CoreErrorCode::NotFound,
        message,
        "Reload the current registered session.",
    )
}
fn item<'a>(session: &'a Session, id: &ItemRef) -> Result<&'a Item, CoreError> {
    session
        .items
        .0
        .get(id)
        .ok_or_else(|| not_found("Item is missing"))
}
fn session_query(
    session: &Session,
    context: &QueryContext,
    request: &QueryRequest,
) -> Result<QueryResult, CoreError> {
    match request {
        QueryRequest::SessionGet {} => Ok(QueryResult::SessionGet(SessionSnapshot {
            session: session.clone(),
            freshness: Freshness::Fresh,
        })),
        QueryRequest::RevealItem { item_id } => {
            item(session, item_id)?;
            Ok(QueryResult::RevealItem(ItemRoute {
                project_id: session.project_id.clone(),
                session_id: session.id.clone(),
                item_id: item_id.clone(),
            }))
        }
        QueryRequest::SessionRead(request) => read(session, context, request),
        QueryRequest::ItemMessages(request) => {
            let item = item(session, &request.item_id)?;
            let scope = Scope {
                view: QueryView::ItemMessages,
                digest: visibility::scope(context, json!(["item_messages", request.item_id]))?,
                revision: session.revision,
                aggregate: false,
            };
            let entries = session
                .messages
                .iter()
                .filter(|message| {
                    message.item_id.as_ref() == Some(&item.id)
                        && matches!(message.kind, MessageKind::OwnerInput | MessageKind::Reply)
                        && visibility::message(context, message)
                })
                .map(|message| (items::message_position(message), message.clone()))
                .collect();
            let timeline_context = TimelineContext {
                parent_item_id: item.parent.clone(),
                created_message: session
                    .messages
                    .iter()
                    .find(|message| {
                        message.id == item.created_message_id
                            && visibility::message(context, message)
                    })
                    .cloned(),
                source_round_id: item.source_round_id.clone(),
            };
            Ok(QueryResult::ItemMessages(Box::new(
                ItemMessagesProjection {
                    item_id: item.id.clone(),
                    messages: page::page(
                        entries,
                        &scope,
                        &request.cursor,
                        request.limit.value(),
                        page::payload_budget(page::bytes(&timeline_context)?),
                        false,
                    )?,
                    timeline_context,
                },
            )))
        }
        QueryRequest::ItemRounds(request) => {
            item(session, &request.item_id)?;
            let scope = Scope {
                view: QueryView::ItemRounds,
                digest: visibility::scope(context, json!(["item_rounds", request.item_id]))?,
                revision: session.revision,
                aggregate: false,
            };
            let entries = session
                .rounds
                .0
                .values()
                .filter(|round| round.item_id == request.item_id)
                .map(|round| {
                    (
                        CursorPosition::Round {
                            ordinal: round.ordinal,
                            id: round.id.clone(),
                        },
                        round,
                    )
                })
                .collect();
            Ok(QueryResult::ItemRounds(ItemRoundsProjection {
                item_id: request.item_id.clone(),
                rounds: page::mapped_page(
                    entries,
                    &scope,
                    &request.cursor,
                    request.limit.value(),
                    page::payload_budget(0),
                    false,
                    |round| items::round(session, context, round, &request.round_pages),
                )?,
            }))
        }
        _ => Err(invalid("Query requires another native scope")),
    }
}
fn read(
    session: &Session,
    context: &QueryContext,
    request: &SessionReadRequest,
) -> Result<QueryResult, CoreError> {
    let view = match request.selection {
        ReadView::Topics { .. } => QueryView::Topics,
        ReadView::Items { .. } => QueryView::Items,
        ReadView::Messages { .. } => QueryView::Messages,
        ReadView::Inputs { .. } => QueryView::Inputs,
    };
    let scope = Scope {
        digest: visibility::scope(context, json!(["session_read", request.selection]))?,
        view,
        revision: session.revision,
        aggregate: false,
    };
    let result = match &request.selection {
        ReadView::Topics { archived } => SessionReadResult::Topics(page::page(
            session
                .topics
                .0
                .values()
                .filter(|topic| archived.is_none_or(|value| value == topic.archived_at.is_some()))
                .map(|topic| {
                    (
                        CursorPosition::Topic {
                            order: topic.order,
                            id: topic.id.clone(),
                        },
                        topic.clone(),
                    )
                })
                .collect(),
            &scope,
            &request.cursor,
            request.limit.value(),
            page::payload_budget(0),
            false,
        )?),
        ReadView::Items {
            topic_id,
            item_id,
            parent_item_id,
            statuses,
            archived,
        } => {
            let entries = session
                .items
                .0
                .values()
                .filter(|item| {
                    topic_id.as_ref().is_none_or(|id| id == &item.topic_id)
                        && item_id.as_ref().is_none_or(|id| id == &item.id)
                        && parent_item_id
                            .as_ref()
                            .is_none_or(|id| item.parent.as_ref() == Some(id))
                        && (statuses.is_empty() || statuses.contains(&item.status))
                        && archived.is_none_or(|value| {
                            session
                                .topics
                                .0
                                .get(&item.topic_id)
                                .is_some_and(|topic| value == topic.archived_at.is_some())
                        })
                })
                .map(|item| Ok((items::position(session, item)?, item)))
                .collect::<Result<_, CoreError>>()?;
            SessionReadResult::Items(page::mapped_page(
                entries,
                &scope,
                &request.cursor,
                request.limit.value(),
                page::payload_budget(0),
                false,
                |item| items::item(session, context, item, &request.item_pages),
            )?)
        }
        ReadView::Messages { topic_id, item_id } => {
            let entries = session
                .messages
                .iter()
                .filter(|message| {
                    visibility::message(context, message)
                        && topic_id
                            .as_ref()
                            .is_none_or(|id| message.topic_id.as_ref() == Some(id))
                        && item_id
                            .as_ref()
                            .is_none_or(|id| message.item_id.as_ref() == Some(id))
                })
                .map(|message| (items::message_position(message), message.clone()))
                .collect();
            SessionReadResult::Messages(page::page(
                entries,
                &scope,
                &request.cursor,
                request.limit.value(),
                page::payload_budget(0),
                false,
            )?)
        }
        ReadView::Inputs {
            topic_id,
            item_id,
            states,
        } => {
            let inputs = session.inputs.0.values().filter(|input| {
                topic_id
                    .as_ref()
                    .is_none_or(|id| &input.target.topic_id == id)
                    && item_id
                        .as_ref()
                        .is_none_or(|id| input.target.item_id.as_ref() == Some(id))
                    && (states.is_empty() || states.contains(&input.state))
            });
            match context.visibility() {
                QueryVisibility::Owner(_) => SessionReadResult::Inputs(page::page(
                    inputs
                        .map(|input| {
                            (
                                CursorPosition::Sequence {
                                    number: input.seq,
                                    id: input.id.clone(),
                                },
                                input.clone(),
                            )
                        })
                        .collect(),
                    &scope,
                    &request.cursor,
                    request.limit.value(),
                    page::payload_budget(0),
                    false,
                )?),
                QueryVisibility::Agent(_) => SessionReadResult::InputsQueue(page::page(
                    inputs
                        .map(|input| {
                            (
                                CursorPosition::Sequence {
                                    number: input.seq,
                                    id: input.id.clone(),
                                },
                                InputQueueEntry {
                                    id: input.id.clone(),
                                    seq: input.seq,
                                    binding_id: input.binding_id.clone(),
                                    state: input.state.clone(),
                                },
                            )
                        })
                        .collect(),
                    &scope,
                    &request.cursor,
                    request.limit.value(),
                    page::payload_budget(0),
                    false,
                )?),
            }
        }
    };
    Ok(QueryResult::SessionRead(result))
}
