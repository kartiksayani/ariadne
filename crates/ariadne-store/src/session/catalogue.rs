//! Read-only authoritative catalogue. Stable coordination locks may be created;
//! no registration, snapshot, index or backup content is written.
use super::*;

#[derive(Debug)]
pub struct SessionReadOutcome {
    pub session_id: Option<UuidV4>,
    pub path: PathBuf,
    pub result: Result<Session, StoreError>,
}
#[derive(Debug)]
pub struct ProjectCatalogue {
    pub project: Project,
    pub sessions: Result<Vec<SessionReadOutcome>, StoreError>,
}

impl Store {
    pub fn read_registered(
        root: &Path,
        project_id: &UuidV4,
        session_id: &UuidV4,
    ) -> Result<Session, StoreError> {
        with_project(root, project_id, |data, _| {
            let sessions = data.child("sessions", false)?;
            let locks = data.child("locks", true)?;
            lock::with_lock(&locks, &format!("{}.lock", session_id.as_str()), || {
                Self::read_validated(&sessions, session_id, project_id).map(|(session, _)| session)
            })
        })
    }
    /// Read current verified metadata and each generated session filename. Unlike
    /// setup's fail-fast uniqueness scan, one unreadable session retains its ID
    /// and cause while other sessions can contribute explicit partial counts.
    pub fn inspect_registered(
        root: &Path,
        project_id: &UuidV4,
    ) -> Result<ProjectCatalogue, StoreError> {
        with_project(root, project_id, |data, project| {
            let sessions = inspect_sessions(data, project_id);
            Ok(ProjectCatalogue { project, sessions })
        })
    }
}

fn with_project<T>(
    root: &Path,
    project_id: &UuidV4,
    work: impl FnOnce(&Directory, Project) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let opened = Directory::root(root)?;
    if opened.path != root {
        return Err(StoreError::UnsafePath { path: root.into() });
    }
    let data = opened.child(".ariadne", false)?;
    lock::with_lock(&data, "project.lock", || {
        let project: Project = decode(&data.read("project.json")?)?;
        if &project.id != project_id {
            return Err(StoreError::IdentityMismatch);
        }
        work(&data, project)
    })
}

fn inspect_sessions(
    data: &Directory,
    project_id: &UuidV4,
) -> Result<Vec<SessionReadOutcome>, StoreError> {
    let sessions = match data.child("sessions", false) {
        Ok(sessions) => sessions,
        Err(StoreError::Io {
            kind: io::ErrorKind::NotFound,
            ..
        }) => return Ok(vec![]),
        Err(error) => return Err(error),
    };
    let names = sessions.names()?;
    // Only coordination directories/files may be created by this read seam.
    let locks = data.child("locks", true)?;
    let mut results = Vec::new();
    for name in names {
        if name.starts_with('.') || !name.ends_with(".json") {
            continue;
        }
        let session_id = match UuidV4::new(name.strip_suffix(".json").expect("filtered suffix")) {
            Ok(id) => id,
            Err(_) => {
                results.push(SessionReadOutcome {
                    session_id: None,
                    path: sessions.path.join(&name),
                    result: Err(StoreError::UnsafePath {
                        path: sessions.path.join(&name),
                    }),
                });
                continue;
            }
        };
        let result = lock::with_lock(&locks, &format!("{}.lock", session_id.as_str()), || {
            Store::read_validated(&sessions, &session_id, project_id).map(|(session, _)| session)
        });
        results.push(SessionReadOutcome {
            session_id: Some(session_id),
            path: sessions.path.join(&name),
            result,
        });
    }
    Ok(results)
}
