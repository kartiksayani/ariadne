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
mod remove;
pub use remove::ProjectRemoval;

pub use crate::migrate::{
    legacy_store_path, parked_copy_differences, parked_copy_matches, parked_legacy_paths,
    parked_legacy_paths_in_root,
};

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
    /// Canonical data root the projects' stores live under.
    pub data: PathBuf,
    pub projects: Vec<RegisteredProjectRead>,
}
impl RegistryCatalogue {
    /// Complete timestamped diagnostic observations, never dispatch authority.
    pub fn diagnostic_routes(&self) -> Result<Option<Vec<BindingRoute>>, RegistryError> {
        let mut located = Vec::new();
        for project in &self.projects {
            let Ok(catalogue) = &project.result else {
                return Ok(None);
            };
            let Ok(sessions) = &catalogue.sessions else {
                return Ok(None);
            };
            for read in sessions {
                let Ok(session) = &read.result else {
                    return Ok(None);
                };
                located.push(LocatedSession {
                    project: project.registered.clone(),
                    session: session.clone(),
                });
            }
        }
        selected_routes(&self.data, &located).map(Some)
    }
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
        Self::from_directory(data)
    }
    /// Open the existing private application data root used by native entrypoints.
    /// Its final component is opened relative to its canonical parent without
    /// following links; no additional `.ariadne` directory or root is created.
    pub fn open_data_directory(path: &Path) -> Result<Self, RegistryError> {
        Self::data_directory(path, false)
    }
    /// Explicit owner setup may create only the private final component beneath
    /// an existing trusted parent. Existing paths are validated, never repaired.
    pub fn create_data_directory(path: &Path) -> Result<Self, RegistryError> {
        Self::data_directory(path, true)
    }
    fn data_directory(path: &Path, create: bool) -> Result<Self, RegistryError> {
        if !path.is_absolute()
            || path
                .components()
                .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
        {
            return Err(StoreError::UnsafePath { path: path.into() }.into());
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| StoreError::UnsafePath { path: path.into() })?;
        let parent = path
            .parent()
            .ok_or_else(|| StoreError::UnsafePath { path: path.into() })?;
        let data = Directory::root(parent)?.child(name, create)?;
        Self::from_directory(data)
    }
    fn from_directory(data: Directory) -> Result<Self, RegistryError> {
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
        self.register_inner(root, operation_id, None, allocate_project_id)
    }

    /// Native offline demo requires its fixed identity before any publication.
    /// Its semantic receipt key is distinct from ordinary registration.
    pub fn register_fixed(
        &self,
        root: &Path,
        operation_id: &UuidV4,
        expected_project_id: &UuidV4,
    ) -> Result<RegistrationReceipt, RegistryError> {
        self.register_inner(root, operation_id, Some(expected_project_id), || {
            expected_project_id.clone()
        })
    }

    fn register_inner(
        &self,
        root: &Path,
        operation_id: &UuidV4,
        expected_project_id: Option<&UuidV4>,
        allocate_project_id: impl FnOnce() -> UuidV4,
    ) -> Result<RegistrationReceipt, RegistryError> {
        let root_text = root.to_str().ok_or(RegistryError::InvalidArgument)?;
        let intent = if let Some(expected) = expected_project_id {
            serde_json::json!({ "actor_scope": "local_setup", "command": {
                "kind": "project_register_fixed", "canonical_root": root_text,
                "expected_project_id": expected } })
        } else {
            serde_json::json!({ "actor_scope": "local_setup",
                "command": { "kind": "project_register", "canonical_root": root_text } })
        };
        let digest = digest(&intent)?;
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
            // The store lives under the data root; nothing is created in `root`.
            // An id comes from this registry, else from a legacy in-project store
            // that is migrated here, else it is newly allocated.
            let legacy = crate::migrate::legacy_metadata(&directory)?;
            let known = projects
                .projects
                .iter()
                .find(|entry| entry.root == canonical)
                .map(|entry| entry.project_id.clone())
                .or_else(|| legacy.as_ref().map(|metadata| metadata.id.clone()));
            if let (Some(expected), Some(known)) = (expected_project_id, &known) {
                if expected != known {
                    // Refused before any migration or other write.
                    return Err(RegistryError::Conflict {
                        paths: vec![if legacy.is_some() {
                            canonical.join(".ariadne").join("project.json")
                        } else {
                            canonical.clone()
                        }],
                    });
                }
            }
            let store_parent = self.data.child("projects", true)?;
            let mut fresh = None;
            let data = if let Some(id) = &known {
                if legacy.is_some() {
                    crate::migrate::migrate_legacy(&self.data, &canonical, id)?;
                }
                store_parent.child(id.as_str(), false).map_err(|source| {
                    RegistryError::Unavailable {
                        path: canonical.clone(),
                        source,
                    }
                })?
            } else {
                let display_name = canonical
                    .file_name()
                    .and_then(|name| name.to_str())
                    .filter(|name| !name.trim().is_empty() && name.len() <= 4096)
                    .ok_or(RegistryError::InvalidArgument)?;
                let project = Project {
                    schema_version: SchemaVersion::new(1).expect("literal"),
                    id: allocate_project_id(),
                    display_name: display_name.to_owned(),
                };
                let data = store_parent.child(project.id.as_str(), true)?;
                fresh = Some(project);
                data
            };
            lock::with_lock(&data, "project.lock", || {
                let create_project = !data.verify_target("project.json")?;
                let project = match (create_project, fresh) {
                    (false, _) => read_data(&data, "project.json")?,
                    (true, Some(project)) => project,
                    (true, None) => {
                        return Err(RegistryError::InvalidData {
                            path: data.path.join("project.json"),
                            source: StoreError::InvalidSnapshot,
                        })
                    }
                };
                if data.path.file_name().and_then(|name| name.to_str()) != Some(project.id.as_str())
                {
                    // The directory name is the identity; metadata must agree.
                    return Err(RegistryError::Conflict {
                        paths: vec![data.path.join("project.json")],
                    });
                }
                if expected_project_id.is_some_and(|expected| expected != &project.id) {
                    return Err(RegistryError::Conflict {
                        paths: vec![data.path.join("project.json")],
                    });
                }
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
                        self.prepare_project(registered)?;
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

    /// Listing is the first touch of a project by long-running readers, so any
    /// pending legacy in-project store is migrated here (best effort: a failed
    /// migration leaves the legacy store intact and is reported by `catalogue`,
    /// `resolve_project` and the doctor's `store.legacy` check).
    pub fn registered_projects(&self) -> Result<Vec<RegisteredProject>, RegistryError> {
        lock::with_lock(&self.data, "registry.lock", || {
            let projects = self.projects()?.projects;
            for project in &projects {
                let _ =
                    crate::migrate::migrate_legacy(&self.data, &project.root, &project.project_id);
            }
            Ok(projects)
        })
    }
    pub fn catalogue(&self) -> Result<RegistryCatalogue, RegistryError> {
        // Legacy in-project stores migrate here, under the registry lock; a
        // failed migration is that project's read error, never a silent skip.
        let (projects, migrated) = lock::with_lock(&self.data, "registry.lock", || {
            let projects = self.projects()?;
            let migrated: Vec<Result<bool, StoreError>> = projects
                .projects
                .iter()
                .map(|registered| {
                    crate::migrate::migrate_legacy(
                        &self.data,
                        &registered.root,
                        &registered.project_id,
                    )
                })
                .collect();
            Ok::<_, RegistryError>((projects, migrated))
        })?;
        // Capture registration identity once, then release the registry lock.
        // Each project read obeys metadata -> session lock order; ordinary
        // mutations remain independently locked and all counts use these results.
        let outcomes = projects
            .projects
            .into_iter()
            .zip(migrated)
            .map(|(registered, migrated)| {
                let result = migrated.and_then(|_| {
                    // An unavailable project root stays a per-project error even
                    // though the store no longer lives inside it.
                    check_root(&registered).map_err(|error| match error {
                        RegistryError::Unavailable { source, .. } => source,
                        _ => StoreError::UnsafePath {
                            path: registered.root.clone(),
                        },
                    })?;
                    Store::inspect_registered(
                        &self.project_dir(&registered.project_id),
                        &registered.project_id,
                    )
                });
                RegisteredProjectRead { registered, result }
            })
            .collect();
        Ok(RegistryCatalogue {
            revision: projects.revision,
            data: self.data.path.clone(),
            projects: outcomes,
        })
    }

    /// Read existing coordination state only, without index reconciliation or repair.
    pub fn inspect_data_directory(path: &Path) -> Result<RegistryCatalogue, RegistryError> {
        let registry = Self::diagnostic_root(path)?;
        let projects = lock::with_lock_mode(&registry.data, "registry.lock", false, || {
            registry.projects()
        })?;
        Ok(RegistryCatalogue {
            revision: projects.revision,
            data: registry.data.path.clone(),
            projects: projects
                .projects
                .into_iter()
                .map(|registered| {
                    // Diagnosis never migrates; a pending legacy store reads as absent.
                    let result = Store::diagnose_registered(
                        &registry.project_dir(&registered.project_id),
                        &registered.project_id,
                    );
                    RegisteredProjectRead { registered, result }
                })
                .collect(),
        })
    }
    pub fn inspect_binding_index(path: &Path) -> Result<Option<Vec<BindingRoute>>, RegistryError> {
        let registry = Self::diagnostic_root(path)?;
        lock::with_lock_mode(&registry.data, "registry.lock", false, || {
            if !registry.data.verify_target("bindings.json")? {
                return Ok(None);
            }
            let index: BindingIndex = read_data(&registry.data, "bindings.json")?;
            Ok(Some(index.bindings))
        })
    }
    fn diagnostic_root(path: &Path) -> Result<Self, RegistryError> {
        if !path.is_absolute()
            || path
                .components()
                .any(|c| matches!(c, Component::CurDir | Component::ParentDir))
        {
            return Err(StoreError::UnsafePath { path: path.into() }.into());
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or(RegistryError::InvalidArgument)?;
        let parent = path.parent().ok_or(RegistryError::InvalidArgument)?;
        Ok(Self {
            data: Directory::root(parent)?.child(name, false)?,
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
            self.prepare_project(&project)?;
            Ok(project)
        })
    }
    /// Canonical store directory of a project: `<data root>/projects/<id>`.
    /// Pure path derivation; pass it to `Store::open_registered` and the
    /// catalogue readers after the project was resolved through this registry
    /// (resolution migrates any legacy in-project store).
    pub fn project_dir(&self, project_id: &UuidV4) -> PathBuf {
        self.data.path.join("projects").join(project_id.as_str())
    }
    /// Migrate a legacy `<root>/.ariadne` store if one is pending, then open the
    /// project directory and verify its identity. Caller holds the registry lock.
    fn prepare_project(&self, project: &RegisteredProject) -> Result<Directory, RegistryError> {
        check_root(project)?;
        crate::migrate::migrate_legacy(&self.data, &project.root, &project.project_id)?;
        let opened = self
            .data
            .child("projects", false)
            .and_then(|projects| projects.child(project.project_id.as_str(), false))
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
        selected_routes(&self.registry.data.path, &sessions)?;
        Ok(sessions)
    }
    pub fn routes(&self) -> Result<Vec<BindingRoute>, RegistryError> {
        selected_routes(&self.registry.data.path, &self.sessions()?)
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
        let data = self.registry.prepare_project(project).map_err(E::from)?;
        lock::with_lock::<_, RegistryError>(&data, "project.lock", || {
            let metadata: Project = read_data(&data, "project.json")?;
            if metadata.id != project.project_id {
                return Err(RegistryError::Conflict {
                    paths: vec![project.root.clone()],
                });
            }
            let store = Store::open_registered(&data.path, project.project_id.clone()).map_err(
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

/// The registered root must still be a canonical, reachable directory even
/// though the store no longer lives inside it.
fn check_root(project: &RegisteredProject) -> Result<(), RegistryError> {
    Directory::root(&project.root)
        .and_then(|root| {
            if root.path != project.root {
                return Err(StoreError::UnsafePath {
                    path: project.root.clone(),
                });
            }
            Ok(())
        })
        .map_err(|source| RegistryError::Unavailable {
            path: project.root.clone(),
            source,
        })
}
fn selected_routes(
    data: &Path,
    sessions: &[LocatedSession],
) -> Result<Vec<BindingRoute>, RegistryError> {
    let mut routes: Vec<BindingRoute> = Vec::new();
    let mut binding_ids = BTreeMap::new();
    for located in sessions {
        let path = data
            .join("projects")
            .join(located.project.project_id.as_str())
            .join("sessions")
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
