use ariadne_core::*;
use ariadne_domain::models::*;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone)]
pub struct WaitingRow {
    pub episode: NotificationEpisode,
    pub waiting_since: UtcMillis,
    pub project_label: String,
    pub session_label: String,
    pub question: String,
}
impl WaitingRow {
    pub fn route(&self) -> OpenRoute {
        OpenRoute {
            project_id: self.episode.session.project_id.clone(),
            session_id: self.episode.session.session_id.clone(),
            item_id: Some(self.episode.item_id.clone()),
        }
    }
    pub fn identifier(&self) -> String {
        format!(
            "ariadne:{}:{}:{}",
            self.episode.session.session_id.as_str(),
            self.episode.item_id.as_str(),
            self.episode.question_revision.value()
        )
    }
}

#[derive(Debug, Clone)]
pub struct WaitingCapture {
    pub counts: SummaryCounts,
    pub rows: Vec<WaitingRow>,
    pub diagnostics: Vec<String>,
}

pub(crate) fn inconsistent() -> CoreError {
    CoreError::new(
        CoreErrorCode::RevisionConflict,
        "The registered native queue changed during its capture.",
        "Keep the last valid tray and refresh the registered queue.",
    )
}

/// Reads the same registered, unfiltered catalogue and snapshots as global Waiting.
/// The caller executes this synchronous IO off the UI/executor thread.
pub fn capture(
    query: impl Fn(OwnerQueryRequest) -> Result<QueryResult, CoreError>,
) -> Result<WaitingCapture, CoreError> {
    let mut projects = BTreeMap::new();
    let mut cursor = None;
    let mut project_revision = None;
    let mut seen = BTreeSet::new();
    let mut counts = None;
    loop {
        let QueryResult::ProjectList(result) = query(OwnerQueryRequest {
            session: None,
            request: QueryRequest::ProjectList(ProjectListRequest {
                cursor,
                limit: PageLimit::new(100).expect("literal"),
            }),
        })?
        else {
            return Err(inconsistent());
        };
        check_page(&result.projects, &mut project_revision, &mut seen)?;
        if counts
            .as_ref()
            .is_some_and(|counts| counts != &result.counts)
        {
            return Err(inconsistent());
        }
        counts = Some(result.counts);
        for project in result.projects.items {
            if projects
                .insert(project.project_id.clone(), project)
                .is_some()
            {
                return Err(inconsistent());
            }
        }
        cursor = result.projects.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    let counts = counts.ok_or_else(inconsistent)?;
    let mut summaries = Vec::new();
    let mut cursor = None;
    let mut session_revision = None;
    let mut seen = BTreeSet::new();
    let mut sessions = BTreeSet::new();
    loop {
        let QueryResult::SessionList(result) = query(OwnerQueryRequest {
            session: None,
            request: QueryRequest::SessionList(SessionListRequest {
                project_id: None,
                state: None,
                cursor,
                limit: PageLimit::new(100).expect("literal"),
            }),
        })?
        else {
            return Err(inconsistent());
        };
        check_page(&result.sessions, &mut session_revision, &mut seen)?;
        if counts != result.counts {
            return Err(inconsistent());
        }
        for summary in result.sessions.items {
            if !sessions.insert((summary.project_id.clone(), summary.session_id.clone())) {
                return Err(inconsistent());
            }
            summaries.push(summary);
        }
        cursor = result.sessions.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    if project_revision != session_revision {
        return Err(inconsistent());
    }
    let mut rows = Vec::new();
    let mut diagnostics = Vec::new();
    if counts.completeness == Completeness::Partial {
        diagnostics.push(
            "Some registered roots or sessions are unavailable; Waiting count is incomplete."
                .into(),
        );
    }
    for summary in summaries {
        let project = projects.get(&summary.project_id).ok_or_else(inconsistent)?;
        let route = SessionRef {
            project_id: summary.project_id.clone(),
            session_id: summary.session_id.clone(),
        };
        let QueryResult::SessionGet(snapshot) = query(OwnerQueryRequest {
            session: Some(route.clone()),
            request: QueryRequest::SessionGet {},
        })?
        else {
            return Err(inconsistent());
        };
        let session = snapshot.session;
        if session.id != summary.session_id
            || session.project_id != summary.project_id
            || session.revision != summary.revision
        {
            return Err(inconsistent());
        }
        if let Some(binding) = &summary.active_binding {
            if binding.owner_paused
                || binding.pause_reason.is_some()
                || binding.connection_state != ConnectionState::Connected
            {
                diagnostics.push(format!(
                    "{}: binding {:?}",
                    summary.title, binding.connection_state
                ));
            }
        }
        for item in session.items.0.values() {
            if session
                .topics
                .0
                .get(&item.topic_id)
                .is_none_or(|topic| topic.archived_at.is_some())
                || !ariadne_core::queries::waiting_unanswered(&session, item)
            {
                continue;
            }
            let waiting_since = item.waiting_since.clone().ok_or_else(inconsistent)?;
            rows.push(WaitingRow {
                episode: NotificationEpisode {
                    session: route.clone(),
                    item_id: item.id.clone(),
                    question_revision: item.question_revision,
                },
                waiting_since,
                project_label: project
                    .project
                    .as_ref()
                    .map_or("Unavailable project", |project| &project.display_name)
                    .into(),
                session_label: summary.title.clone(),
                question: item.question.clone(),
            });
        }
    }
    rows.sort_by(|a, b| {
        a.waiting_since
            .cmp(&b.waiting_since)
            .then_with(|| {
                a.episode
                    .session
                    .project_id
                    .cmp(&b.episode.session.project_id)
            })
            .then_with(|| {
                a.episode
                    .session
                    .session_id
                    .cmp(&b.episode.session.session_id)
            })
            .then_with(|| item_order(&a.episode.item_id, &b.episode.item_id))
    });
    if rows.len() as u64 != counts.waiting_unanswered.value() {
        return Err(inconsistent());
    }
    Ok(WaitingCapture {
        counts,
        rows,
        diagnostics,
    })
}

fn check_page<T>(
    page: &Page<T>,
    revision: &mut Option<PositiveSafeInteger>,
    seen: &mut BTreeSet<String>,
) -> Result<(), CoreError> {
    if revision.is_some_and(|revision| revision != page.snapshot_revision) {
        return Err(inconsistent());
    }
    *revision = Some(page.snapshot_revision);
    if let Some(cursor) = &page.next_cursor {
        if page.items.is_empty()
            || cursor.revision != page.snapshot_revision
            || !seen.insert(serde_json::to_string(cursor).map_err(|_| inconsistent())?)
        {
            return Err(inconsistent());
        }
    }
    Ok(())
}
fn item_order(a: &ItemRef, b: &ItemRef) -> std::cmp::Ordering {
    a.as_str()
        .split('.')
        .map(|part| part.parse::<u64>().expect("validated item ordinal"))
        .cmp(
            b.as_str()
                .split('.')
                .map(|part| part.parse::<u64>().expect("validated item ordinal")),
        )
}
