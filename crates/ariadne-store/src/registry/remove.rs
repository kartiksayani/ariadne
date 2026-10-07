//! Owner project removal: back up, delete only the project's own store, unregister.
use super::*;
use crate::session::{removal_stamp, removal_stamp_of};

/// Saved as `removal.json` inside the backup directory. It is the commit point:
/// once it exists, a retry finishes deleting the store and unregistering.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectRemoval {
    pub operation_id: UuidV4,
    pub project_id: UuidV4,
    pub session_ids: Vec<UuidV4>,
    pub backup: PathBuf,
}

const RECORD: &str = "removal.json";

impl Registry {
    /// Remove one registered project from Ariadne. Under the registry lock:
    /// `guard` sees every session first and may refuse, leaving nothing on disk.
    /// Then `project.json`, the store's earlier backups and every session file
    /// are copied to `<data>/backups/pre-remove-<stamp>-<op>/`, `removal.json`
    /// is written there, the project's store `<data>/projects/<id>` is deleted
    /// (`project.json` last) and the project and its registration receipts
    /// leave `projects.json`. The project folder itself is never touched.
    /// An exact retry with the same operation ID returns the saved record and
    /// finishes any step a crash left undone.
    pub fn remove_project<E: From<RegistryError>>(
        &self,
        project_id: &UuidV4,
        operation_id: &UuidV4,
        stamp: &str,
        guard: impl FnOnce(&[Session]) -> Result<(), E>,
    ) -> Result<ProjectRemoval, E> {
        removal_stamp(stamp).map_err(|e| E::from(e.into()))?;
        lock::with_lock::<_, RegistryError>(&self.data, "registry.lock", || {
            let backups = self.data.child("backups", true)?;
            let suffix = format!("-{}", operation_id.as_str());
            let earlier = match backups
                .names()?
                .into_iter()
                .find(|name| removal_stamp_of(name, &suffix).is_some())
            {
                Some(name) => Some(backups.child(&name, false)?),
                None => None,
            };
            if let Some(backup) = &earlier {
                if backup.verify_target(RECORD)? {
                    let saved: ProjectRemoval = read_data(backup, RECORD)?;
                    if &saved.project_id != project_id {
                        return Err(StoreError::OperationReused.into());
                    }
                    self.finish_removal(project_id, operation_id)?;
                    return Ok(Ok(saved));
                }
                // No record yet: the directory may be reused only if its
                // copied `project.json`, when present, names this project.
                if backup.verify_target("project.json")? {
                    let metadata: Project = read_data(backup, "project.json")?;
                    if &metadata.id != project_id {
                        return Err(StoreError::OperationReused.into());
                    }
                }
            }
            let Some(project) = self
                .projects()?
                .projects
                .into_iter()
                .find(|entry| &entry.project_id == project_id)
            else {
                // Unregistered with a backup but no record: rebuild the record
                // from the backup so the owner still gets its path.
                return match &earlier {
                    Some(backup) => {
                        let record = self.record(backup, project_id, operation_id, true)?;
                        self.finish_removal(project_id, operation_id)?;
                        Ok(Ok(record))
                    }
                    None => Err(RegistryError::NotRegistered),
                };
            };
            let name = format!("pre-remove-{stamp}-{}", operation_id.as_str());
            let open = |earlier: Option<Directory>| match earlier {
                Some(backup) => Ok::<_, RegistryError>(backup),
                None => Ok(backups.child(&name, true)?),
            };
            let record = match self.store_directory(&project)? {
                // No store left under the data root: nothing to back up; the
                // owner still asked for the project to leave Ariadne.
                None => {
                    let backup = open(earlier)?;
                    self.record(&backup, project_id, operation_id, false)?
                }
                Some(store_dir) => {
                    match lock::with_lock::<_, RegistryError>(&store_dir, "project.lock", || {
                        let store = Store::open_registered(&store_dir.path, project_id.clone())?;
                        let sessions = store.sessions()?;
                        if let Err(refused) = guard(&sessions) {
                            return Ok(Err(refused));
                        }
                        let backup = open(earlier)?;
                        let bytes = store_dir.read("project.json")?;
                        if backup.verify_target("project.json")? {
                            backup
                                .temp("project.json", &bytes)?
                                .replace("project.json")?;
                        } else {
                            backup
                                .temp("project.json", &bytes)?
                                .create("project.json")?;
                        }
                        backup.sync()?;
                        store.copy_backups(&backup.child("backups", true)?)?;
                        store.evict_all(&backup.child("sessions", true)?)?;
                        drop(store);
                        let record = self.record(&backup, project_id, operation_id, false)?;
                        self.delete_store(project_id)?;
                        Ok(Ok(record))
                    })? {
                        Ok(record) => record,
                        Err(refused) => return Ok(Err(refused)),
                    }
                }
            };
            self.finish_removal(project_id, operation_id)?;
            Ok(Ok(record))
        })
        .map_err(E::from)?
    }

    /// Write `removal.json` from what the backup holds: every session file
    /// copied into `sessions/`, including any a crashed earlier attempt moved.
    /// `verify` checks the backup's `project.json` names this project.
    fn record(
        &self,
        backup: &Directory,
        project_id: &UuidV4,
        operation_id: &UuidV4,
        verify: bool,
    ) -> Result<ProjectRemoval, RegistryError> {
        if verify {
            if !backup.verify_target("project.json")? {
                return Err(RegistryError::NotRegistered);
            }
            let metadata: Project = read_data(backup, "project.json")?;
            if &metadata.id != project_id {
                return Err(StoreError::OperationReused.into());
            }
        }
        let names = match backup.child("sessions", false) {
            Ok(sessions) => sessions.names()?,
            Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
                ..
            }) => vec![],
            Err(error) => return Err(error.into()),
        };
        let mut session_ids: Vec<UuidV4> = names
            .iter()
            .filter(|name| !name.starts_with('.'))
            .filter_map(|name| name.strip_suffix(".json"))
            .filter_map(|id| UuidV4::new(id).ok())
            .collect();
        session_ids.sort();
        let record = ProjectRemoval {
            operation_id: operation_id.clone(),
            project_id: project_id.clone(),
            session_ids,
            backup: backup.path.clone(),
        };
        backup.temp(RECORD, &encode(&record)?)?.create(RECORD)?;
        backup.sync()?;
        Ok(record)
    }

    /// After the record is saved: delete what is left of the store, drop the
    /// project and its registration receipts from `projects.json`, republish.
    fn finish_removal(
        &self,
        project_id: &UuidV4,
        operation_id: &UuidV4,
    ) -> Result<(), RegistryError> {
        self.delete_store(project_id)?;
        let mut projects = self.projects()?;
        let listed = projects
            .projects
            .iter()
            .any(|entry| &entry.project_id == project_id)
            || projects
                .operations
                .iter()
                .any(|entry| &entry.result.project_id == project_id);
        if listed {
            projects
                .projects
                .retain(|entry| &entry.project_id != project_id);
            projects
                .operations
                .retain(|entry| &entry.result.project_id != project_id);
            let revision = PositiveSafeInteger::new(projects.revision.value() + 1)
                .map_err(|_| StoreError::CounterOverflow)?;
            projects.revision =
                NonnegativeSafeInteger::new(revision.value()).expect("positive safe");
            projects.validate()?;
            self.write("projects.json", &projects, false)?;
        }
        self.publish_routes()
            .map_err(|source| RegistryError::CommitUncertain {
                operation_id: operation_id.clone(),
                source: Box::new(source),
            })
    }

    /// The project's store `<data>/projects/<id>`, after any pending legacy
    /// migration. A missing or unreachable project folder does not stop the
    /// removal: its store under the data root may still be there. `None` when
    /// no store exists.
    fn store_directory(
        &self,
        project: &RegisteredProject,
    ) -> Result<Option<Directory>, RegistryError> {
        match self.prepare_project(project) {
            Ok(opened) => return Ok(Some(opened)),
            Err(RegistryError::Unavailable { .. }) => {}
            Err(other) => return Err(other),
        }
        let opened = self
            .data
            .child("projects", false)
            .and_then(|projects| projects.child(project.project_id.as_str(), false));
        let opened = match opened {
            Ok(opened) => opened,
            Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
                ..
            }) => return Ok(None),
            Err(source) => {
                return Err(RegistryError::Unavailable {
                    path: self.project_dir(&project.project_id),
                    source,
                })
            }
        };
        let metadata: Project = read_data(&opened, "project.json")?;
        if metadata.id != project.project_id {
            return Err(RegistryError::Conflict {
                paths: vec![opened.path.clone()],
            });
        }
        Ok(Some(opened))
    }

    /// Delete only `<data>/projects/<id>`, anchored to the data root and never
    /// following links, `project.json` last. The project folder and any parked
    /// legacy copy stay.
    fn delete_store(&self, project_id: &UuidV4) -> Result<(), RegistryError> {
        let projects = match self.data.child("projects", false) {
            Ok(projects) => projects,
            Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
                ..
            }) => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        projects.remove_tree_last(project_id.as_str(), "project.json")?;
        Ok(projects.sync()?)
    }

    /// Republish the binding index from the current registered projects.
    /// Call only while holding the registry lock.
    fn publish_routes(&self) -> Result<(), RegistryError> {
        let setup = BindingSetup {
            registry: self,
            projects: self.projects()?.projects,
        };
        let routes = setup.routes()?;
        setup.publish(&routes)
    }
}
