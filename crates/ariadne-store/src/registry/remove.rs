//! Owner project removal: back up, delete only the project's own store, unregister.
use super::*;
use crate::session::removal_stamp;

/// Saved as `removal.json` inside the backup directory once the project is gone.
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
    /// `project.json`, the store's earlier backups and every session file are
    /// copied to `<data>/backups/pre-remove-<stamp>-<op>/`, then the project's
    /// store `<data>/projects/<id>` is deleted and the project and its
    /// registration receipts leave `projects.json`. The project folder itself is
    /// never touched. `guard` sees every session first and may refuse.
    /// An exact retry with the same operation ID returns the saved record.
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
            let earlier = backups
                .names()?
                .into_iter()
                .find(|name| name.starts_with("pre-remove-") && name.ends_with(&suffix));
            if let Some(name) = &earlier {
                let backup = backups.child(name, false)?;
                if backup.verify_target(RECORD)? {
                    let saved: ProjectRemoval = read_data(&backup, RECORD)?;
                    if &saved.project_id != project_id {
                        return Err(StoreError::OperationReused.into());
                    }
                    let _ = self.publish_routes();
                    return Ok(Ok(saved));
                }
            }
            let mut projects = self.projects()?;
            let project = projects
                .projects
                .iter()
                .find(|entry| &entry.project_id == project_id)
                .cloned()
                .ok_or(RegistryError::NotRegistered)?;
            let name =
                earlier.unwrap_or_else(|| format!("pre-remove-{stamp}-{}", operation_id.as_str()));
            let backup = backups.child(&name, true)?;
            let session_ids = match self.store_directory(&project)? {
                // No store left under the data root: nothing to delete; the
                // owner still asked for the project to leave Ariadne.
                None => vec![],
                Some(store_dir) => {
                    match lock::with_lock::<_, RegistryError>(&store_dir, "project.lock", || {
                        let store = Store::open_registered(&store_dir.path, project_id.clone())?;
                        let sessions = store.sessions()?;
                        if let Err(refused) = guard(&sessions) {
                            return Ok(Err(refused));
                        }
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
                        let ids = store.evict_all(&backup.child("sessions", true)?)?;
                        drop(store);
                        self.delete_store(project_id)?;
                        Ok(Ok(ids))
                    })? {
                        Ok(ids) => ids,
                        Err(refused) => return Ok(Err(refused)),
                    }
                }
            };
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
            let record = ProjectRemoval {
                operation_id: operation_id.clone(),
                project_id: project_id.clone(),
                session_ids,
                backup: backup.path.clone(),
            };
            backup.temp(RECORD, &encode(&record)?)?.create(RECORD)?;
            backup.sync()?;
            self.publish_routes()
                .map_err(|source| RegistryError::CommitUncertain {
                    operation_id: operation_id.clone(),
                    source: Box::new(source),
                })?;
            Ok(Ok(record))
        })
        .map_err(E::from)?
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
    /// following links. The project folder and any parked legacy copy stay.
    fn delete_store(&self, project_id: &UuidV4) -> Result<(), RegistryError> {
        let projects = self.data.child("projects", false)?;
        projects.remove_tree(project_id.as_str())?;
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
