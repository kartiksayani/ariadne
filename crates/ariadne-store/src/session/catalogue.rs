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

struct CapturedSessionRead {
    session_id: Option<UuidV4>,
    path: PathBuf,
    result: Result<Vec<u8>, StoreError>,
}

/// Every function below takes the project's store directory
/// (`<data root>/projects/<id>`, canonical), named `root` for brevity.
impl Store {
    pub fn read_registered(
        root: &Path,
        project_id: &UuidV4,
        session_id: &UuidV4,
    ) -> Result<Session, StoreError> {
        let bytes = with_project(root, project_id, true, |data, _| {
            let sessions = data.child("sessions", false)?;
            let locks = data.child("locks", true)?;
            lock::with_lock(&locks, &format!("{}.lock", session_id.as_str()), || {
                sessions.read(&format!("{}.json", session_id.as_str()))
            })
        })?;
        Self::decode_diagnostic_snapshot(&bytes, session_id, project_id)
    }
    /// Read current verified metadata and each generated session filename. Unlike
    /// setup's fail-fast uniqueness scan, one unreadable session retains its ID
    /// and cause while other sessions can contribute explicit partial counts.
    pub fn inspect_registered(
        root: &Path,
        project_id: &UuidV4,
    ) -> Result<ProjectCatalogue, StoreError> {
        read_catalogue(root, project_id, true)
    }

    /// Strict diagnostic read: all coordination files/directories must exist.
    pub fn diagnose_registered(
        root: &Path,
        project_id: &UuidV4,
    ) -> Result<ProjectCatalogue, StoreError> {
        read_catalogue(root, project_id, false)
    }

    /// Canonical identity/schema/semantic checks for an explicitly selected backup.
    pub fn decode_diagnostic_snapshot(
        bytes: &[u8],
        session_id: &UuidV4,
        project_id: &UuidV4,
    ) -> Result<Session, StoreError> {
        #[cfg(test)]
        read_capture_tests::before_decode();
        let session = decode(bytes)?;
        Self::validate_in_project(&session, session_id, project_id)?;
        Ok(session)
    }
}

fn read_catalogue(
    root: &Path,
    project_id: &UuidV4,
    create_locks: bool,
) -> Result<ProjectCatalogue, StoreError> {
    let (project, captured) = with_project(root, project_id, create_locks, |data, project| {
        Ok((project, capture_sessions(data, create_locks)))
    })?;
    // Both the outer project guard and each individual session guard have ended.
    // Validation uses only captured bytes and the requested canonical identities.
    let sessions = captured.map(|sessions| {
        sessions
            .into_iter()
            .map(|captured| SessionReadOutcome {
                result: captured.result.and_then(|bytes| {
                    Store::decode_diagnostic_snapshot(
                        &bytes,
                        captured.session_id.as_ref().expect("captured generated ID"),
                        project_id,
                    )
                }),
                session_id: captured.session_id,
                path: captured.path,
            })
            .collect()
    });
    Ok(ProjectCatalogue { project, sessions })
}

fn with_project<T>(
    root: &Path,
    project_id: &UuidV4,
    create_locks: bool,
    work: impl FnOnce(&Directory, Project) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let data = Directory::existing(root)?;
    if data.path != root {
        return Err(StoreError::UnsafePath { path: root.into() });
    }
    lock::with_lock_mode(&data, "project.lock", create_locks, || {
        let project: Project = decode(&data.read("project.json")?)?;
        if &project.id != project_id {
            return Err(StoreError::IdentityMismatch);
        }
        work(&data, project)
    })
}

fn capture_sessions(
    data: &Directory,
    create_locks: bool,
) -> Result<Vec<CapturedSessionRead>, StoreError> {
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
    let locks = data.child("locks", create_locks)?;
    let mut results = Vec::new();
    for name in names {
        if name.starts_with('.') || !name.ends_with(".json") {
            continue;
        }
        let session_id = match UuidV4::new(name.strip_suffix(".json").expect("filtered suffix")) {
            Ok(id) => id,
            Err(_) => {
                results.push(CapturedSessionRead {
                    session_id: None,
                    path: sessions.path.join(&name),
                    result: Err(StoreError::UnsafePath {
                        path: sessions.path.join(&name),
                    }),
                });
                continue;
            }
        };
        let result = lock::with_lock_mode(
            &locks,
            &format!("{}.lock", session_id.as_str()),
            create_locks,
            || {
                if create_locks {
                    sessions.read(&name)
                } else {
                    sessions.read_diagnostic(&name)
                }
            },
        );
        results.push(CapturedSessionRead {
            session_id: Some(session_id),
            path: sessions.path.join(&name),
            result,
        });
    }
    Ok(results)
}
