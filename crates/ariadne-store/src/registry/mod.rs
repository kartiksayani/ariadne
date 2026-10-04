//! Native registered-root selection and rebuildable binding routing.
//! No discovery, provider I/O, remapping, or automatic data repair.
use crate::session::{decode, encode, fs::Directory, lock, Store, StoreError};
use ariadne_domain::models::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256 as Hasher};
use std::collections::BTreeMap;
use std::fmt;
use std::path::{Component, Path, PathBuf};

#[derive(Debug)]
pub enum RegistryError {
    Store(StoreError),
    InvalidRegistry,
    InvalidData {
        path: PathBuf,
        source: StoreError,
    },
    InvalidArgument,
    NotRegistered,
    NotFound,
    Conflict {
        paths: Vec<PathBuf>,
    },
    Unavailable {
        path: PathBuf,
        source: StoreError,
    },
    CommitUncertain {
        operation_id: UuidV4,
        source: Box<RegistryError>,
    },
}
impl From<StoreError> for RegistryError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}
impl fmt::Display for RegistryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}
impl std::error::Error for RegistryError {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisteredProject {
    pub project_id: UuidV4,
    pub root: PathBuf,
}
/// Native read catalogue; unavailable roots retain their trusted ID/path and
/// original cause. It neither publishes an index nor proves setup uniqueness.
#[derive(Debug)]
pub struct RegisteredProjectRead {
    pub registered: RegisteredProject,
    pub result: Result<crate::session::ProjectCatalogue, StoreError>,
}
#[derive(Debug)]
pub struct RegistryCatalogue {
    pub revision: NonnegativeSafeInteger,
    pub projects: Vec<RegisteredProjectRead>,
}
/// Native local-setup result; transport uses its canonical core DTO.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegistrationReceipt {
    pub operation_id: UuidV4,
    pub project_id: UuidV4,
    pub registry_revision: PositiveSafeInteger,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistrationOperation {
    operation_id: UuidV4,
    command_digest: Sha256,
    result: RegistrationReceipt,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Projects {
    schema_version: SchemaVersion,
    revision: NonnegativeSafeInteger,
    projects: Vec<RegisteredProject>,
    operations: Vec<RegistrationOperation>,
}
impl Projects {
    fn empty() -> Self {
        Self {
            schema_version: SchemaVersion::new(1).expect("literal"),
            revision: NonnegativeSafeInteger::new(0).expect("literal"),
            projects: Vec::new(),
            operations: Vec::new(),
        }
    }
    fn validate(&self) -> Result<(), RegistryError> {
        for (index, project) in self.projects.iter().enumerate() {
            if !project.root.is_absolute()
                || project
                    .root
                    .components()
                    .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
            {
                return Err(RegistryError::InvalidRegistry);
            }
            if let Some(prior) = self.projects[..index]
                .iter()
                .find(|prior| prior.project_id == project.project_id || prior.root == project.root)
            {
                return Err(RegistryError::Conflict {
                    paths: vec![prior.root.clone(), project.root.clone()],
                });
            }
        }
        for (index, operation) in self.operations.iter().enumerate() {
            if operation.operation_id != operation.result.operation_id
                || operation.result.registry_revision.value() > self.revision.value()
                || !self
                    .projects
                    .iter()
                    .any(|project| project.project_id == operation.result.project_id)
                || self.operations[..index]
                    .iter()
                    .any(|prior| prior.operation_id == operation.operation_id)
            {
                return Err(RegistryError::InvalidRegistry);
            }
        }
        Ok(())
    }
}

/// Host identity remains a tuple; opaque values can contain any delimiters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostIdentity {
    pub adapter_id: String,
    pub endpoint_fingerprint: EndpointFingerprint,
    pub external_session_id: String,
}
impl HostIdentity {
    pub fn of(binding: &Binding) -> Self {
        Self {
            adapter_id: binding.adapter_id.clone(),
            endpoint_fingerprint: binding.endpoint_fingerprint.clone(),
            external_session_id: binding.external_session_id.clone(),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BindingRoute {
    pub identity: HostIdentity,
    pub project_id: UuidV4,
    pub session_id: UuidV4,
    pub binding_id: UuidV4,
    pub generation: UuidV4,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BindingIndex {
    schema_version: SchemaVersion,
    bindings: Vec<BindingRoute>,
}
pub struct LocatedSession {
    pub project: RegisteredProject,
    pub session: Session,
}
pub struct Registry {
    data: Directory,
}

impl Registry {
    /// Owner preferences are global to this same trusted application data root.
    /// Core owns typed validation and replay; the fixed file guard owns only IO.
    pub fn with_ui_file<T, E: From<StoreError>>(
        &self,
        work: impl FnOnce(crate::ui::UiFile<'_>) -> Result<T, E>,
    ) -> Result<T, E> {
        crate::ui::with_file(&self.data, work)
    }

    /// Trusted native entry-point chooses the user home; tests inject owned homes.
    pub fn open(home: &Path) -> Result<Self, RegistryError> {
        let data = Directory::root(home)?.child(".ariadne", true)?;
        let registry = Self { data };
        lock::with_lock(&registry.data, "registry.lock", || {
            registry.projects().map(|_| ())
        })?;
        Ok(registry)
    }

    /// Exact local-setup replay precedes filesystem preflight and UUID allocation.
    pub fn register(
        &self,
        root: &Path,
        operation_id: &UuidV4,
        allocate_project_id: impl FnOnce() -> UuidV4,
    ) -> Result<RegistrationReceipt, RegistryError> {
        let root_text = root.to_str().ok_or(RegistryError::InvalidArgument)?;
        let digest = digest(&serde_json::json!({ "actor_scope": "local_setup",
            "command": { "kind": "project_register", "canonical_root": root_text } }))?;
        lock::with_lock(&self.data, "registry.lock", || {
            let mut projects = self.projects()?;
            let create_registry = projects.revision.value() == 0;
            if let Some(saved) = projects
                .operations
                .iter()
                .find(|entry| &entry.operation_id == operation_id)
            {
                return if saved.command_digest == digest {
                    Ok(saved.result.clone())
                } else {
                    Err(StoreError::OperationReused.into())
                };
            }
            let directory = Directory::root(root)?;
            let canonical = directory.path.clone();
            if canonical.to_str().is_none() {
                return Err(RegistryError::InvalidArgument);
            }
            let data = directory.child(".ariadne", true)?;
            lock::with_lock(&data, "project.lock", || {
                let create_project = !data.verify_target("project.json")?;
                let project = if !create_project {
                    read_data(&data, "project.json")?
                } else {
                    let display_name = canonical
                        .file_name()
                        .and_then(|name| name.to_str())
                        .filter(|name| !name.trim().is_empty() && name.len() <= 4096)
                        .ok_or(RegistryError::InvalidArgument)?;
                    Project {
                        schema_version: SchemaVersion::new(1).expect("literal"),
                        id: allocate_project_id(),
                        display_name: display_name.to_owned(),
                    }
                };
                for registered in &projects.projects {
                    if registered.root == canonical && registered.project_id != project.id
                        || registered.project_id == project.id && registered.root != canonical
                    {
                        return Err(RegistryError::Conflict {
                            paths: vec![registered.root.clone(), canonical.clone()],
                        });
                    }
                }
                // A missing/inaccessible registered root must not free its identity.
                if !projects
                    .projects
                    .iter()
                    .any(|entry| entry.root == canonical)
                {
                    for registered in &projects.projects {
                        validate_project(registered)?;
                    }
                }
                if create_project {
                    data.temp("project.json", &encode(&project)?)?
                        .create("project.json")?;
                    data.sync()?;
                }
                if !projects
                    .projects
                    .iter()
                    .any(|entry| entry.root == canonical)
                {
                    projects.projects.push(RegisteredProject {
                        project_id: project.id.clone(),
                        root: canonical,
                    });
                    projects.projects.sort_by(|a, b| a.root.cmp(&b.root));
                }
                let revision = PositiveSafeInteger::new(projects.revision.value() + 1)
                    .map_err(|_| StoreError::CounterOverflow)?;
                projects.revision =
                    NonnegativeSafeInteger::new(revision.value()).expect("positive safe");
                let receipt = RegistrationReceipt {
                    operation_id: operation_id.clone(),
                    project_id: project.id,
                    registry_revision: revision,
                };
                projects.operations.push(RegistrationOperation {
                    operation_id: operation_id.clone(),
                    command_digest: digest,
                    result: receipt.clone(),
                });
                projects.validate()?;
                self.write("projects.json", &projects, create_registry)
                    .map_err(|source| match source {
                        RegistryError::Store(StoreError::CommitUncertain { .. }) => {
                            RegistryError::CommitUncertain {
                                operation_id: operation_id.clone(),
                                source: Box::new(source),
                            }
                        }
                        other => other,
                    })?;
                Ok(receipt)
            })
        })
    }

    pub fn registered_projects(&self) -> Result<Vec<RegisteredProject>, RegistryError> {
        lock::with_lock(&self.data, "registry.lock", || {
            Ok(self.projects()?.projects)
        })
    }
    pub fn catalogue(&self) -> Result<RegistryCatalogue, RegistryError> {
        let projects = lock::with_lock(&self.data, "registry.lock", || self.projects())?;
        // Capture registration identity once, then release the registry lock.
        // Each project read obeys metadata -> session lock order; ordinary
        // mutations remain independently locked and all counts use these results.
        let outcomes = projects
            .projects
            .into_iter()
            .map(|registered| {
                let result = Store::inspect_registered(&registered.root, &registered.project_id);
                RegisteredProjectRead { registered, result }
            })
            .collect();
        Ok(RegistryCatalogue {
            revision: projects.revision,
            projects: outcomes,
        })
    }
    pub fn resolve_project(&self, project_id: &UuidV4) -> Result<RegisteredProject, RegistryError> {
        lock::with_lock(&self.data, "registry.lock", || {
            let project = self
                .projects()?
                .projects
                .into_iter()
                .find(|entry| &entry.project_id == project_id)
                .ok_or(RegistryError::NotRegistered)?;
            validate_project(&project)?;
            Ok(project)
        })
    }
    /// Resolve from authoritative registered snapshots, never trust stale index data.
    pub fn resolve_binding(&self, binding_id: &UuidV4) -> Result<BindingRoute, RegistryError> {
        self.with_binding_setup(|setup| {
            setup
                .routes()?
                .into_iter()
                .find(|route| &route.binding_id == binding_id)
                .ok_or(RegistryError::NotFound)
        })
    }
    pub fn rebuild(&self) -> Result<Vec<BindingRoute>, RegistryError> {
        self.with_binding_setup(|setup| {
            let routes = setup.routes()?;
            setup.publish(&routes)?;
            Ok(routes)
        })
    }
    /// Native setup only. Callback performs local persistence, never provider or
    /// lease I/O. Core releases this scope before its trusted verifier callback.
    pub fn with_binding_setup<T, E: From<RegistryError>>(
        &self,
        work: impl FnOnce(&BindingSetup<'_>) -> Result<T, E>,
    ) -> Result<T, E> {
        lock::with_lock::<_, RegistryError>(&self.data, "registry.lock", || {
            let projects = self.projects()?;
            Ok(work(&BindingSetup {
                registry: self,
                projects: projects.projects,
            }))
        })
        .map_err(E::from)?
    }
    fn projects(&self) -> Result<Projects, RegistryError> {
        if !self.data.verify_target("projects.json")? {
            return Ok(Projects::empty());
        }
        let projects: Projects = read_data(&self.data, "projects.json")?;
        if projects.revision.value() == 0 {
            return Err(RegistryError::InvalidData {
                path: self.data.path.join("projects.json"),
                source: StoreError::InvalidSnapshot,
            });
        }
        projects.validate().map_err(|error| match error {
            RegistryError::InvalidRegistry => RegistryError::InvalidData {
                path: self.data.path.join("projects.json"),
                source: StoreError::InvalidSnapshot,
            },
            other => other,
        })?;
        Ok(projects)
    }
    fn write(&self, name: &str, value: &impl Serialize, create: bool) -> Result<(), RegistryError> {
        let temporary = self.data.temp(name, &encode(value)?)?;
        if create {
            temporary.create(name)?;
        } else {
            temporary.replace(name)?;
        }
        self.data
            .sync()
            .map_err(|_| StoreError::CommitUncertain { operation_id: None })?;
        Ok(())
    }
}

/// Lifetime bounds a single global setup lock; stores never escape this scope.
pub struct BindingSetup<'a> {
    registry: &'a Registry,
    projects: Vec<RegisteredProject>,
}
impl BindingSetup<'_> {
    pub fn project_sessions(
        &self,
        project_id: &UuidV4,
    ) -> Result<Vec<LocatedSession>, RegistryError> {
        let project = self
            .projects
            .iter()
            .find(|entry| &entry.project_id == project_id)
            .ok_or(RegistryError::NotRegistered)?;
        self.with_store(project_id, |store| {
            Ok::<_, RegistryError>(
                store
                    .sessions()?
                    .into_iter()
                    .map(|session| LocatedSession {
                        project: project.clone(),
                        session,
                    })
                    .collect(),
            )
        })
    }
    pub fn sessions(&self) -> Result<Vec<LocatedSession>, RegistryError> {
        let mut sessions = Vec::new();
        for project in &self.projects {
            sessions.extend(self.project_sessions(&project.project_id)?);
        }
        // Validate all selected identities before a caller allocates a new one.
        selected_routes(&sessions)?;
        Ok(sessions)
    }
    pub fn routes(&self) -> Result<Vec<BindingRoute>, RegistryError> {
        selected_routes(&self.sessions()?)
    }
    pub fn with_store<T, E: From<RegistryError>>(
        &self,
        project_id: &UuidV4,
        work: impl FnOnce(&Store) -> Result<T, E>,
    ) -> Result<T, E> {
        let project = self
            .projects
            .iter()
            .find(|entry| &entry.project_id == project_id)
            .ok_or(RegistryError::NotRegistered)
            .map_err(E::from)?;
        let data = validate_project(project).map_err(E::from)?;
        lock::with_lock::<_, RegistryError>(&data, "project.lock", || {
            let metadata: Project = read_data(&data, "project.json")?;
            if metadata.id != project.project_id {
                return Err(RegistryError::Conflict {
                    paths: vec![project.root.clone()],
                });
            }
            let store = Store::open_registered(&project.root, project.project_id.clone()).map_err(
                |source| RegistryError::Unavailable {
                    path: project.root.clone(),
                    source,
                },
            )?;
            Ok(work(&store))
        })
        .map_err(E::from)?
    }
    /// Invoke only after session commit (including an exact replay). Index failure
    /// retains authoritative session+receipt and reports retryable operation identity.
    pub fn synchronize(&self, operation_id: &UuidV4) -> Result<(), RegistryError> {
        self.routes()
            .and_then(|routes| self.publish(&routes))
            .map_err(|source| RegistryError::CommitUncertain {
                operation_id: operation_id.clone(),
                source: Box::new(source),
            })
    }
    fn publish(&self, routes: &[BindingRoute]) -> Result<(), RegistryError> {
        let exists = self.registry.data.verify_target("bindings.json")?;
        if exists {
            let _: BindingIndex = read_data(&self.registry.data, "bindings.json")?;
        }
        self.registry.write(
            "bindings.json",
            &BindingIndex {
                schema_version: SchemaVersion::new(1).expect("literal"),
                bindings: routes.to_vec(),
            },
            !exists,
        )
    }
}

fn validate_project(project: &RegisteredProject) -> Result<Directory, RegistryError> {
    let opened = Directory::root(&project.root)
        .and_then(|root| {
            if root.path != project.root {
                return Err(StoreError::UnsafePath {
                    path: project.root.clone(),
                });
            }
            root.child(".ariadne", false)
        })
        .map_err(|source| RegistryError::Unavailable {
            path: project.root.clone(),
            source,
        })?;
    let metadata: Project = read_data(&opened, "project.json")?;
    if metadata.id != project.project_id {
        return Err(RegistryError::Conflict {
            paths: vec![project.root.clone()],
        });
    }
    Ok(opened)
}
fn selected_routes(sessions: &[LocatedSession]) -> Result<Vec<BindingRoute>, RegistryError> {
    let mut routes: Vec<BindingRoute> = Vec::new();
    let mut binding_ids = BTreeMap::new();
    for located in sessions {
        let path = located
            .project
            .root
            .join(".ariadne/sessions")
            .join(format!("{}.json", located.session.id.as_str()));
        for (id, binding) in &located.session.bindings.0 {
            if id != &binding.id {
                return Err(RegistryError::Conflict {
                    paths: vec![path.clone()],
                });
            }
            if let Some(prior) = binding_ids.insert(id.clone(), path.clone()) {
                return Err(RegistryError::Conflict {
                    paths: vec![prior, path.clone()],
                });
            }
        }
        if let Some(selected) = &located.session.active_binding_id {
            let binding = located.session.bindings.0.get(selected).ok_or_else(|| {
                RegistryError::Conflict {
                    paths: vec![path.clone()],
                }
            })?;
            let route = BindingRoute {
                identity: HostIdentity::of(binding),
                project_id: located.project.project_id.clone(),
                session_id: located.session.id.clone(),
                binding_id: binding.id.clone(),
                generation: binding.generation.clone(),
            };
            if let Some(prior) = routes.iter().find(|prior| prior.identity == route.identity) {
                let prior_root = sessions
                    .iter()
                    .find(|entry| {
                        entry.session.id == prior.session_id
                            && entry.project.project_id == prior.project_id
                    })
                    .expect("route source")
                    .project
                    .root
                    .clone();
                return Err(RegistryError::Conflict {
                    paths: vec![prior_root, path],
                });
            }
            routes.push(route);
        }
    }
    Ok(routes)
}
fn digest(value: &Value) -> Result<Sha256, RegistryError> {
    Sha256::new(format!("{:x}", Hasher::digest(encode(value)?)))
        .map_err(|_| RegistryError::InvalidRegistry)
}

fn read_data<T: serde::de::DeserializeOwned>(
    directory: &Directory,
    name: &str,
) -> Result<T, RegistryError> {
    directory
        .read(name)
        .and_then(|bytes| decode(&bytes))
        .map_err(|source| RegistryError::InvalidData {
            path: directory.path.join(name),
            source,
        })
}

#[cfg(test)]
mod publication_tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fn appeared_target_survives(name: &str) {
        let home = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        lock::with_lock(&registry.data, "registry.lock", || {
            // Capture absence, then model an ordinary external restore before
            // publication. The restored future bytes must survive unchanged.
            let create = !registry.data.verify_target(name)?;
            assert!(create);
            let restored = br#"{"schema_version":2,"restored":"external snapshot"}"#;
            let path = registry.data.path.join(name);
            fs::write(&path, restored).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            assert!(matches!(
                registry.write(name, &serde_json::json!({"schema_version":1}), create),
                Err(RegistryError::Store(StoreError::AlreadyExists))
            ));
            assert_eq!(fs::read(&path).unwrap(), restored);
            assert!(!registry
                .data
                .names()?
                .iter()
                .any(|name| name.starts_with('.')));
            Ok::<_, RegistryError>(())
        })
        .unwrap();
    }
    #[test]
    fn initial_project_registry_keeps_a_restored_target_and_cleans_the_temp() {
        appeared_target_survives("projects.json");
    }
    #[test]
    fn initial_binding_index_keeps_a_restored_target_and_cleans_the_temp() {
        appeared_target_survives("bindings.json");
    }
}
