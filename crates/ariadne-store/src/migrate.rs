//! One-way migration of a legacy `<project>/.ariadne/` store into the data root.
//!
//! Every path into a registered project (registration, resolution, catalogue,
//! binding setup) reaches this through `Registry`, so the desktop, CLI and MCP
//! all migrate through the store and never separately. The legacy directory is
//! removed only after every copied file has been re-read and compared byte for
//! byte; any failure leaves the legacy directory in place.
use crate::session::fs::Directory;
use crate::session::{decode, StoreError};
use ariadne_domain::models::{Project, UuidV4};
use std::io;
use std::path::{Path, PathBuf};

const LEGACY_NAME: &str = ".ariadne";
const PROJECTS_NAME: &str = "projects";
/// Directories whose regular files are carried over; `locks` is recreated.
const DATA_DIRECTORIES: [&str; 2] = ["sessions", "backups"];

/// Path of a legacy in-project store when something exists there.
pub fn legacy_store_path(root: &Path) -> Option<PathBuf> {
    let path = root.join(LEGACY_NAME);
    path.symlink_metadata().ok().map(|_| path)
}

/// Metadata of a legacy in-project store, when `top` holds one.
pub(crate) fn legacy_metadata(top: &Directory) -> Result<Option<Project>, StoreError> {
    let legacy = match top.child(LEGACY_NAME, false) {
        Ok(legacy) => legacy,
        Err(StoreError::Io {
            kind: io::ErrorKind::NotFound,
            ..
        }) => return Ok(None),
        Err(error) => return Err(error),
    };
    match legacy.read("project.json") {
        Ok(bytes) => Ok(Some(decode(&bytes)?)),
        Err(StoreError::Io {
            kind: io::ErrorKind::NotFound,
            ..
        }) => Ok(None),
        Err(error) => Err(error),
    }
}

fn failure(legacy: &Path, project: &Path, detail: &'static str) -> StoreError {
    StoreError::Migration {
        legacy: legacy.into(),
        project: project.into(),
        detail,
    }
}

fn skipped(name: &str) -> bool {
    name.starts_with('.') || name.ends_with(".lock")
}

/// Files to carry over as `(directory, name)`; `None` is the store top level.
fn plan(
    legacy: &Directory,
    project_path: &Path,
) -> Result<Vec<(Option<&'static str>, String)>, StoreError> {
    let mut files = Vec::new();
    for name in legacy.names()? {
        if skipped(&name) || name == "locks" {
            continue;
        }
        if name == "project.json" {
            files.push((None, name));
        } else if let Some(directory) = DATA_DIRECTORIES.iter().find(|d| **d == name) {
            let child = legacy.child(directory, false)?;
            for file in child.names()? {
                if !skipped(&file) {
                    files.push((Some(*directory), file));
                }
            }
        } else {
            return Err(failure(
                &legacy.path,
                project_path,
                "legacy store holds an unrecognized entry",
            ));
        }
    }
    Ok(files)
}

fn locate<'a>(
    top: &'a Directory,
    directory: Option<&str>,
    cache: &'a [(&'static str, Directory)],
) -> Result<&'a Directory, StoreError> {
    match directory {
        None => Ok(top),
        Some(name) => Ok(&cache
            .iter()
            .find(|(candidate, _)| *candidate == name)
            .expect("created before copy")
            .1),
    }
}

/// True when every planned legacy file exists in `current` with equal bytes.
fn identical(
    legacy: &Directory,
    current: &Directory,
    files: &[(Option<&'static str>, String)],
) -> Result<bool, StoreError> {
    let mut cache = Vec::new();
    for directory in DATA_DIRECTORIES {
        match current.child(directory, false) {
            Ok(child) => cache.push((directory, child)),
            Err(StoreError::Io {
                kind: io::ErrorKind::NotFound,
                ..
            }) => {}
            Err(error) => return Err(error),
        }
    }
    for (directory, name) in files {
        let source = match directory {
            None => legacy.read(name)?,
            Some(directory) => legacy.child(directory, false)?.read(name)?,
        };
        let target = match directory {
            None => current,
            Some(directory) => match cache.iter().find(|(candidate, _)| candidate == directory) {
                Some((_, child)) => child,
                None => return Ok(false),
            },
        };
        match target.read(name) {
            Ok(bytes) if bytes == source => {}
            Ok(_) => return Ok(false),
            Err(StoreError::Io {
                kind: io::ErrorKind::NotFound,
                ..
            }) => return Ok(false),
            Err(error) => return Err(error),
        }
    }
    Ok(true)
}

fn remove_legacy(legacy_path: &Path, project_path: &Path) -> Result<(), StoreError> {
    std::fs::remove_dir_all(legacy_path).map_err(|_| {
        failure(
            legacy_path,
            project_path,
            "copied and verified, but the legacy directory could not be removed; remove it manually",
        )
    })
}

/// Move `<root>/.ariadne` to `<data>/projects/<project_id>` when it is a legacy
/// store of this project and the new location does not exist yet. Returns true
/// when a legacy directory was dealt with. Caller holds the registry lock.
pub(crate) fn migrate_legacy(
    data: &Directory,
    root: &Path,
    project_id: &UuidV4,
) -> Result<bool, StoreError> {
    let top = match Directory::root(root) {
        Ok(top) => top,
        Err(StoreError::Io {
            kind: io::ErrorKind::NotFound,
            ..
        }) => return Ok(false),
        Err(error) => return Err(error),
    };
    let legacy = match top.child(LEGACY_NAME, false) {
        Ok(legacy) => legacy,
        Err(StoreError::Io {
            kind: io::ErrorKind::NotFound,
            ..
        }) => return Ok(false),
        Err(error) => return Err(error),
    };
    let metadata = match legacy.read("project.json") {
        Ok(bytes) => decode::<Project>(&bytes)?,
        Err(StoreError::Io {
            kind: io::ErrorKind::NotFound,
            ..
        }) => return Ok(false),
        Err(error) => return Err(error),
    };
    if &metadata.id != project_id {
        return Ok(false);
    }
    let projects = data.child(PROJECTS_NAME, true)?;
    let final_path = projects.path.join(project_id.as_str());
    let files = plan(&legacy, &final_path)?;
    match projects.child(project_id.as_str(), false) {
        Ok(current) => {
            // A previous run may have copied everything and died before removal.
            if identical(&legacy, &current, &files)? {
                remove_legacy(&legacy.path, &final_path)?;
                return Ok(true);
            }
            return Err(failure(
                &legacy.path,
                &final_path,
                "both the legacy and the new project store exist and differ; compare them and remove the legacy directory by hand",
            ));
        }
        Err(StoreError::Io {
            kind: io::ErrorKind::NotFound,
            ..
        }) => {}
        Err(error) => return Err(error),
    }

    let staging_name = format!(".{}.migrating", project_id.as_str());
    let staging_path = projects.path.join(&staging_name);
    if staging_path.symlink_metadata().is_ok() {
        std::fs::remove_dir_all(&staging_path)
            .map_err(|error| StoreError::io("remove_staging", &staging_path, error))?;
    }
    let staging = projects.child(&staging_name, true)?;
    let mut cache = Vec::new();
    for directory in DATA_DIRECTORIES {
        cache.push((directory, staging.child(directory, true)?));
    }
    for (directory, name) in &files {
        let bytes = match directory {
            None => legacy.read(name)?,
            Some(directory) => legacy.child(directory, false)?.read(name)?,
        };
        let target = locate(&staging, *directory, &cache)?;
        target.temp(name, &bytes)?.create(name)?;
        target.sync()?;
    }
    staging.sync()?;
    #[cfg(test)]
    if tests::TAMPER.with(std::cell::Cell::get) {
        staging
            .temp("project.json", b"tampered")?
            .replace("project.json")?;
    }
    if !identical(&legacy, &staging, &files)? {
        return Err(failure(
            &legacy.path,
            &final_path,
            "copied files did not verify byte for byte; legacy directory left in place",
        ));
    }
    std::fs::rename(&staging_path, &final_path)
        .map_err(|error| StoreError::io("rename", &final_path, error))?;
    projects.sync()?;
    remove_legacy(&legacy.path, &final_path)?;
    top.sync()?;
    Ok(true)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::registry::Registry;
    use std::cell::Cell;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    thread_local! {
        /// Corrupts the staged copy right before verification.
        pub(crate) static TAMPER: Cell<bool> = const { Cell::new(false) };
    }

    fn id(number: u64) -> UuidV4 {
        UuidV4::new(format!("00000000-0000-4000-8000-{number:012x}")).unwrap()
    }
    fn private(path: &Path, bytes: &[u8], mode: u32) {
        fs::write(path, bytes).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }
    fn legacy_store(root: &Path) -> PathBuf {
        let legacy = root.join(".ariadne");
        for directory in ["", "sessions", "backups", "locks"] {
            let path = legacy.join(directory);
            fs::create_dir_all(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let project = serde_json::json!({
            "schema_version": 1, "id": id(1), "display_name": "Legacy"
        });
        private(
            &legacy.join("project.json"),
            &serde_json::to_vec(&project).unwrap(),
            0o600,
        );
        private(&legacy.join("sessions/a.json"), b"session-a", 0o600);
        private(&legacy.join("backups/a.previous.json"), b"backup-a", 0o600);
        private(&legacy.join("locks/a.lock"), b"", 0o600);
        legacy
    }

    #[test]
    fn registering_a_legacy_root_moves_and_verifies_the_store() {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let legacy = legacy_store(root.path());
        let registry = Registry::open(home.path()).unwrap();
        let receipt = registry.register(root.path(), &id(900), || id(77)).unwrap();
        assert_eq!(receipt.project_id, id(1));
        let store = registry.project_dir(&id(1));
        assert_eq!(
            fs::read(store.join("sessions/a.json")).unwrap(),
            b"session-a"
        );
        assert_eq!(
            fs::read(store.join("backups/a.previous.json")).unwrap(),
            b"backup-a"
        );
        assert!(store.join("project.json").is_file());
        assert!(!store.join("locks/a.lock").exists());
        assert!(!legacy.exists());
        assert!(!store
            .parent()
            .unwrap()
            .join(format!(".{}.migrating", id(1).as_str()))
            .exists());
    }

    #[test]
    fn registered_legacy_store_migrates_when_the_project_is_resolved() {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        registry.register(root.path(), &id(900), || id(1)).unwrap();
        // Put the project back into the legacy shape as an older build left it.
        let store = registry.project_dir(&id(1));
        let legacy = root.path().canonicalize().unwrap().join(".ariadne");
        fs::rename(&store, &legacy).unwrap();
        registry.resolve_project(&id(1)).unwrap();
        assert!(store.join("project.json").is_file());
        assert!(!legacy.exists());
    }

    #[test]
    fn failed_verification_leaves_the_legacy_store_and_no_new_store() {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let legacy = legacy_store(root.path());
        let registry = Registry::open(home.path()).unwrap();
        TAMPER.with(|flag| flag.set(true));
        let result = registry.register(root.path(), &id(900), || id(77));
        TAMPER.with(|flag| flag.set(false));
        let Err(crate::registry::RegistryError::Store(StoreError::Migration {
            legacy: named, ..
        })) = result
        else {
            panic!("expected a migration error, got {result:?}");
        };
        assert_eq!(named, legacy.canonicalize().unwrap());
        assert_eq!(
            fs::read(legacy.join("sessions/a.json")).unwrap(),
            b"session-a"
        );
        assert!(!registry.project_dir(&id(1)).exists());
        assert!(registry.registered_projects().unwrap().is_empty());
        // A later attempt without the fault succeeds from the untouched legacy store.
        registry.register(root.path(), &id(901), || id(77)).unwrap();
        assert!(!legacy.exists());
    }

    #[test]
    fn both_locations_present_refuses_and_touches_nothing() {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        registry.register(root.path(), &id(900), || id(1)).unwrap();
        let store = registry.project_dir(&id(1));
        let legacy = legacy_store(&root.path().canonicalize().unwrap());
        let error = registry.resolve_project(&id(1)).unwrap_err();
        assert!(
            matches!(
                error,
                crate::registry::RegistryError::Store(StoreError::Migration { .. })
            ),
            "{error:?}"
        );
        assert_eq!(
            fs::read(legacy.join("sessions/a.json")).unwrap(),
            b"session-a"
        );
        assert!(!store.join("sessions/a.json").exists());
        let catalogue = registry.catalogue().unwrap();
        assert!(matches!(
            catalogue.projects[0].result,
            Err(StoreError::Migration { .. })
        ));
    }

    #[test]
    fn identical_leftover_legacy_store_is_removed_to_finish_an_interrupted_move() {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        registry.register(root.path(), &id(900), || id(1)).unwrap();
        let store = registry.project_dir(&id(1));
        let legacy = legacy_store(&root.path().canonicalize().unwrap());
        fs::copy(legacy.join("project.json"), store.join("project.json")).unwrap();
        fs::set_permissions(
            store.join("project.json"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        for (directory, name, bytes) in [
            ("sessions", "a.json", b"session-a".as_slice()),
            ("backups", "a.previous.json", b"backup-a".as_slice()),
        ] {
            fs::create_dir_all(store.join(directory)).unwrap();
            fs::set_permissions(store.join(directory), fs::Permissions::from_mode(0o700)).unwrap();
            private(&store.join(directory).join(name), bytes, 0o600);
        }
        registry.resolve_project(&id(1)).unwrap();
        assert!(!legacy.exists());
    }
}
