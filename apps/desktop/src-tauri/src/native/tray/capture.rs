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
    /// Session labels by active binding ID, for lifecycle notes about a binding.
    pub labels: BTreeMap<String, String>,
}

/// The owner-facing name of a session, as the session bar shows it: the name the
/// owner gave it when there is one, else "claude-code · iTerm window 1",
/// "claude-code", or "No agent". Never an ID.
pub fn session_label(owner_name: Option<&str>, binding: Option<&BindingSummary>) -> String {
    if let Some(name) = owner_name.map(str::trim).filter(|name| !name.is_empty()) {
        return name.into();
    }
    let Some(binding) = binding else {
        return "No agent".into();
    };
    let agent = match binding.adapter_id.as_str() {
        "claude_code_mod" => "claude-code",
        other => other,
    };
    match binding.host_location.as_deref() {
        Some(location) if !location.is_empty() => format!("{agent} · {location}"),
        _ => agent.into(),
    }
}

/// A plain word for a binding that is not simply connected, or None.
pub fn binding_status(binding: &BindingSummary) -> Option<&'static str> {
    if binding.owner_paused || binding.pause_reason.is_some() {
        return Some("paused");
    }
    match binding.connection_state {
        ConnectionState::Connected => None,
        ConnectionState::Disconnected => Some("not connected"),
        ConnectionState::Reconnecting => Some("reconnecting"),
        ConnectionState::Unknown => Some("connection not confirmed"),
    }
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
    let mut labels = BTreeMap::new();
    if counts.completeness == Completeness::Partial {
        diagnostics
            .push("Some projects or sessions could not be read, so the count may be low.".into());
    }
    let expected: BTreeMap<_, _> = summaries
        .iter()
        .map(|summary| {
            (
                (summary.project_id.clone(), summary.session_id.clone()),
                summary.revision,
            )
        })
        .collect();
    for summary in summaries {
        let project = projects.get(&summary.project_id).ok_or_else(inconsistent)?;
        let session_label = session_label(summary.name.as_deref(), summary.active_binding.as_ref());
        if let Some(binding) = &summary.active_binding {
            labels.insert(binding.id.as_str().to_owned(), session_label.clone());
            if let Some(status) = binding_status(binding) {
                diagnostics.push(format!("{session_label}: {status}"));
            }
        }
        // The authoritative summary already proves there are no Waiting rows.
        // Keep this session in the final inventory check so a concurrent change
        // still rejects the capture before publishing a notification baseline.
        if summary.counts.waiting_unanswered.value() == 0 {
            continue;
        }
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
                session_label: session_label.clone(),
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
    // The aggregate page revision is the registry revision. A session can
    // change without changing that revision or the total count, so validate the
    // complete session inventory again before committing a notification baseline.
    let mut final_inventory = BTreeMap::new();
    let mut cursor = None;
    let mut final_revision = None;
    let mut seen = BTreeSet::new();
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
        check_page(&result.sessions, &mut final_revision, &mut seen)?;
        if counts != result.counts {
            return Err(inconsistent());
        }
        for summary in result.sessions.items {
            if final_inventory
                .insert((summary.project_id, summary.session_id), summary.revision)
                .is_some()
            {
                return Err(inconsistent());
            }
        }
        cursor = result.sessions.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    if expected != final_inventory || final_revision != session_revision {
        return Err(inconsistent());
    }
    Ok(WaitingCapture {
        counts,
        rows,
        diagnostics,
        labels,
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

#[cfg(test)]
mod label_tests {
    use super::*;

    fn binding() -> BindingSummary {
        let page: Page<SessionSummary> = serde_json::from_str(include_str!(
            "../../../../../../fixtures/domain/projections/sessions.json"
        ))
        .unwrap();
        page.items[0].active_binding.clone().unwrap()
    }

    #[test]
    fn session_label_reads_like_the_session_bar_and_never_shows_an_id() {
        let mut binding = binding();
        binding.adapter_id = "claude_code_mod".into();
        assert_eq!(
            session_label(None, Some(&binding)),
            "claude-code · iTerm window 1"
        );
        binding.host_location = None;
        assert_eq!(session_label(None, Some(&binding)), "claude-code");
        binding.host_location = Some(String::new());
        assert_eq!(session_label(None, Some(&binding)), "claude-code");
        binding.adapter_id = "codex".into();
        binding.host_location = Some("Terminal window 2".into());
        assert_eq!(
            session_label(None, Some(&binding)),
            "codex · Terminal window 2"
        );
        assert_eq!(session_label(None, None), "No agent");
        let label = session_label(None, Some(&binding));
        assert!(
            !label.contains(binding.id.as_str()) && !label.contains(&binding.external_session_id)
        );
    }

    #[test]
    fn session_label_prefers_the_name_the_owner_set() {
        let binding = binding();
        assert_eq!(
            session_label(Some("  Notes sync "), Some(&binding)),
            "Notes sync"
        );
        assert_eq!(session_label(Some("Notes sync"), None), "Notes sync");
        // A blank name counts as none.
        assert_eq!(session_label(Some("   "), None), "No agent");
        assert_eq!(
            session_label(Some(""), Some(&binding)),
            session_label(None, Some(&binding))
        );
    }

    #[test]
    fn binding_status_uses_plain_words() {
        let mut binding = binding();
        assert_eq!(binding_status(&binding), None);
        for (state, word) in [
            (ConnectionState::Disconnected, "not connected"),
            (ConnectionState::Reconnecting, "reconnecting"),
            (ConnectionState::Unknown, "connection not confirmed"),
        ] {
            binding.connection_state = state;
            assert_eq!(binding_status(&binding), Some(word));
        }
        // Paused wins over the connection state.
        binding.owner_paused = true;
        assert_eq!(binding_status(&binding), Some("paused"));
    }
}
