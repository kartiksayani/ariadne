//! One-way migration of a legacy `<project>/.ariadne/` store into the data root.
//!
//! Every path into a registered project (registration, resolution, catalogue,
//! binding setup) reaches this through `Registry`, so the desktop, CLI and MCP
//! all migrate through the store and never separately. The legacy directory is
//! never deleted: after every copied file has been re-read and compared byte for
//! byte it is renamed to `projects/<id>.legacy-<unix-ts>` for the owner to
//! delete; any failure leaves it in place. The old build's lock files are held
//! for the whole move so a running old process is never raced.
use crate::session::fs::Directory;
use crate::session::{decode, StoreError};
use ariadne_domain::models::{Project, UuidV4};
use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;
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
    files.sort();
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
    Ok(differing(legacy, current, files)? == 0)
}

/// Number of planned legacy files missing from `current` or holding other bytes.
fn differing(
    legacy: &Directory,
    current: &Directory,
    files: &[(Option<&'static str>, String)],
) -> Result<usize, StoreError> {
    let mut differ = 0;
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
                None => {
                    differ += 1;
                    continue;
                }
            },
        };
        match target.read(name) {
            Ok(bytes) if bytes == source => {}
            Ok(_) => differ += 1,
            Err(StoreError::Io {
                kind: io::ErrorKind::NotFound,
                ..
            }) => differ += 1,
            Err(error) => return Err(error),
        }
    }
    Ok(differ)
}

/// Number of files of a parked legacy copy that are missing from, or differ
/// from, the migrated `store`.
pub fn parked_copy_differences(parked: &Path, store: &Path) -> Result<usize, StoreError> {
    let parked = Directory::root(parked)?;
    let store = Directory::root(store)?;
    let files = plan(&parked, &store.path)?;
    differing(&parked, &store, &files)
}

/// True when every file of a parked legacy copy exists in `store` with equal
/// bytes, so the parked copy holds nothing the store lacks.
pub fn parked_copy_matches(parked: &Path, store: &Path) -> Result<bool, StoreError> {
    Ok(parked_copy_differences(parked, store)? == 0)
}

/// Non-blocking exclusive `flock` on one legacy lock file. A missing file means
/// nothing can hold it. The returned `File` keeps the lock until dropped.
fn try_hold(
    directory: &Directory,
    name: &str,
    project_path: &Path,
    held: &mut Vec<File>,
) -> Result<(), StoreError> {
    let file = match directory.open(name, false) {
        Ok(file) => file,
        Err(StoreError::Io {
            kind: io::ErrorKind::NotFound,
            ..
        }) => return Ok(()),
        Err(error) => return Err(error),
    };
    // SAFETY: file owns a live regular descriptor; flock only borrows it.
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        held.push(file);
        return Ok(());
    }
    let error = io::Error::last_os_error();
    let path = directory.path.join(name);
    if error.kind() == io::ErrorKind::WouldBlock {
        Err(failure(
            &path,
            project_path,
            "legacy store is in use: this lock is held by a running process; quit the Ariadne app and agent sessions, then retry",
        ))
    } else {
        Err(StoreError::io("lock", &path, error))
    }
}

/// Hold the lock files an older build took (`project.lock` and every
/// `locks/*.lock`) so a running old process is never raced. Fails fast when any
/// is held; the returned files release the locks when dropped.
fn hold_legacy_locks(legacy: &Directory, project_path: &Path) -> Result<Vec<File>, StoreError> {
    let mut held = Vec::new();
    try_hold(legacy, "project.lock", project_path, &mut held)?;
    match legacy.child("locks", false) {
        Ok(locks) => {
            for name in locks.names()? {
                if name.ends_with(".lock") && !name.starts_with('.') {
                    try_hold(&locks, &name, project_path, &mut held)?;
                }
            }
        }
        Err(StoreError::Io {
            kind: io::ErrorKind::NotFound,
            ..
        }) => {}
        Err(error) => return Err(error),
    }
    Ok(held)
}

/// Re-verify the legacy directory against `current` and move it aside to
/// `<data>/projects/<id>.legacy-<unix-ts>`, or to `<root>/.ariadne.legacy-<ts>`
/// when that rename fails (for example across volumes). Nothing is ever deleted:
/// when the legacy files changed since `files` was planned, the move is refused
/// with an error, and when both renames fail the legacy directory stays in place
/// (the doctor's `store.legacy` warning reports it).
fn park(
    projects: &Directory,
    top: &Directory,
    legacy: &Directory,
    current: &Directory,
    files: &[(Option<&'static str>, String)],
    final_path: &Path,
) -> Result<(), StoreError> {
    let again = plan(legacy, final_path)?;
    if again != files || !identical(legacy, current, &again)? {
        return Err(failure(
            &legacy.path,
            final_path,
            "legacy store changed while it was being migrated; nothing was removed, compare the two directories",
        ));
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let id = final_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let free = |parent: &Path, base: String| {
        let mut candidate = parent.join(&base);
        let mut attempt = 0;
        while candidate.symlink_metadata().is_ok() {
            attempt += 1;
            candidate = parent.join(format!("{base}-{attempt}"));
        }
        candidate
    };
    let in_data = free(&projects.path, format!("{id}.legacy-{stamp}"));
    #[cfg(test)]
    let data_rename = if tests::FAIL_DATA_RENAME.with(std::cell::Cell::get) {
        Err(io::Error::from_raw_os_error(libc::EXDEV))
    } else {
        std::fs::rename(&legacy.path, &in_data)
    };
    #[cfg(not(test))]
    let data_rename = std::fs::rename(&legacy.path, &in_data);
    if data_rename.is_ok() {
        let _ = projects.sync();
        let _ = top.sync();
        return Ok(());
    }
    // The data root may sit on another volume (EXDEV): park inside the project
    // root instead, which shares a volume with the legacy directory.
    let in_root = free(&top.path, format!("{LEGACY_NAME}.legacy-{stamp}"));
    if std::fs::rename(&legacy.path, &in_root).is_ok() {
        let _ = top.sync();
    }
    Ok(())
}

/// Parked copies left inside a project root (`<root>/.ariadne.legacy-*`) when
/// the data root is on another volume.
pub fn parked_legacy_paths_in_root(root: &Path) -> Vec<PathBuf> {
    let prefix = format!("{LEGACY_NAME}.legacy-");
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
        .map(|entry| entry.path())
        .collect();
    found.sort();
    found
}

/// Parked copies of a project's legacy store under the data root, as left by a
/// finished migration (`projects/<id>.legacy-<unix-ts>`).
pub fn parked_legacy_paths(data: &Path, project_id: &UuidV4) -> Vec<PathBuf> {
    let prefix = format!("{}.legacy-", project_id.as_str());
    let Ok(entries) = std::fs::read_dir(data.join(PROJECTS_NAME)) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
        .map(|entry| entry.path())
        .collect();
    found.sort();
    found
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
    // Held until the legacy directory is parked, so an old build cannot write.
    let _locks = hold_legacy_locks(&legacy, &final_path)?;
    let files = plan(&legacy, &final_path)?;
    match projects.child(project_id.as_str(), false) {
        Ok(current) => {
            // A previous run may have copied everything and died before parking.
            if identical(&legacy, &current, &files)? {
                park(&projects, &top, &legacy, &current, &files, &final_path)?;
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
    #[cfg(test)]
    if tests::APPEAR.with(std::cell::Cell::get) {
        let sessions = legacy.child("sessions", false)?;
        sessions.temp("late.json", b"late")?.create("late.json")?;
    }
    let current = projects.child(project_id.as_str(), false)?;
    park(&projects, &top, &legacy, &current, &files, &final_path)?;
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
        /// Writes a new legacy session file after the copy, before parking.
        pub(crate) static APPEAR: Cell<bool> = const { Cell::new(false) };
        /// Makes the rename into the data root fail as a cross-device move would.
        pub(crate) static FAIL_DATA_RENAME: Cell<bool> = const { Cell::new(false) };
    }

    #[test]
    fn cross_device_parking_falls_back_to_the_project_root() {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let legacy = legacy_store(root.path());
        let registry = Registry::open(home.path()).unwrap();
        FAIL_DATA_RENAME.with(|flag| flag.set(true));
        let result = registry.register(root.path(), &id(900), || id(77));
        FAIL_DATA_RENAME.with(|flag| flag.set(false));
        result.unwrap();
        assert!(!legacy.exists());
        assert!(parked(&registry, 1).is_empty());
        let kept = parked_legacy_paths_in_root(root.path());
        assert_eq!(kept.len(), 1);
        assert_eq!(
            fs::read(kept[0].join("sessions/a.json")).unwrap(),
            b"session-a"
        );
        // The in-root parked copy is not a legacy store: later opens leave it be.
        assert!(legacy_store_path(root.path()).is_none());
        registry.resolve_project(&id(1)).unwrap();
        assert_eq!(parked_legacy_paths_in_root(root.path()), kept);
    }

    fn parked(registry: &Registry, number: u64) -> Vec<PathBuf> {
        parked_legacy_paths(
            registry
                .project_dir(&id(number))
                .parent()
                .unwrap()
                .parent()
                .unwrap(),
            &id(number),
        )
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
    fn identical_leftover_legacy_store_is_parked_to_finish_an_interrupted_move() {
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
        let kept = parked(&registry, 1);
        assert_eq!(kept.len(), 1);
        assert_eq!(
            fs::read(kept[0].join("sessions/a.json")).unwrap(),
            b"session-a"
        );
    }

    #[test]
    fn successful_migration_parks_the_legacy_store_beside_the_new_one() {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let legacy = legacy_store(root.path());
        let registry = Registry::open(home.path()).unwrap();
        registry.register(root.path(), &id(900), || id(77)).unwrap();
        assert!(!legacy.exists());
        let kept = parked(&registry, 1);
        assert_eq!(kept.len(), 1);
        let name = kept[0].file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with(&format!("{}.legacy-", id(1).as_str())),
            "{name}"
        );
        assert_eq!(kept[0].parent(), registry.project_dir(&id(1)).parent());
        assert_eq!(
            fs::read(kept[0].join("sessions/a.json")).unwrap(),
            b"session-a"
        );
        assert_eq!(
            fs::read(kept[0].join("backups/a.previous.json")).unwrap(),
            b"backup-a"
        );
    }

    #[test]
    fn leftover_staging_from_a_crashed_copy_is_wiped_and_redone() {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let legacy = legacy_store(root.path());
        let registry = Registry::open(home.path()).unwrap();
        let staging = registry
            .project_dir(&id(1))
            .parent()
            .unwrap()
            .join(format!(".{}.migrating", id(1).as_str()));
        fs::create_dir_all(staging.join("sessions")).unwrap();
        for dir in [staging.parent().unwrap(), &staging] {
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::write(staging.join("sessions/stale.json"), b"stale").unwrap();
        registry.register(root.path(), &id(900), || id(77)).unwrap();
        let store = registry.project_dir(&id(1));
        assert!(!staging.exists());
        assert!(!store.join("sessions/stale.json").exists());
        assert_eq!(
            fs::read(store.join("sessions/a.json")).unwrap(),
            b"session-a"
        );
        assert!(!legacy.exists());
    }

    #[test]
    fn unrecognised_top_level_entry_is_an_error_and_changes_nothing() {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let legacy = legacy_store(root.path());
        private(&legacy.join("surprise.txt"), b"x", 0o600);
        let registry = Registry::open(home.path()).unwrap();
        let result = registry.register(root.path(), &id(900), || id(77));
        assert!(
            matches!(
                result,
                Err(crate::registry::RegistryError::Store(
                    StoreError::Migration { .. }
                ))
            ),
            "{result:?}"
        );
        assert!(legacy.join("surprise.txt").is_file());
        assert!(legacy.join("sessions/a.json").is_file());
        assert!(!registry.project_dir(&id(1)).exists());
        assert!(parked(&registry, 1).is_empty());
    }

    #[test]
    fn legacy_store_of_another_project_is_left_alone() {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let legacy = legacy_store(root.path());
        let registry = Registry::open(home.path()).unwrap();
        let top_data = registry
            .project_dir(&id(2))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        let directory = Directory::root(&top_data).unwrap();
        assert!(!migrate_legacy(&directory, root.path(), &id(2)).unwrap());
        assert!(legacy.join("project.json").is_file());
        assert!(parked_legacy_paths(&top_data, &id(2)).is_empty());
    }

    #[test]
    fn catalogue_and_registered_projects_trigger_migration() {
        for use_catalogue in [true, false] {
            let home = tempfile::tempdir().unwrap();
            let root = tempfile::tempdir().unwrap();
            let registry = Registry::open(home.path()).unwrap();
            registry.register(root.path(), &id(900), || id(1)).unwrap();
            let store = registry.project_dir(&id(1));
            let legacy = root.path().canonicalize().unwrap().join(".ariadne");
            fs::rename(&store, &legacy).unwrap();
            if use_catalogue {
                let catalogue = registry.catalogue().unwrap();
                assert!(catalogue.projects[0].result.is_ok());
            } else {
                registry.registered_projects().unwrap();
            }
            assert!(store.join("project.json").is_file());
            assert!(!legacy.exists());
            assert_eq!(parked(&registry, 1).len(), 1);
        }
    }

    #[test]
    fn a_file_appearing_in_the_legacy_store_aborts_without_deleting_anything() {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let legacy = legacy_store(root.path());
        let registry = Registry::open(home.path()).unwrap();
        APPEAR.with(|flag| flag.set(true));
        let result = registry.register(root.path(), &id(900), || id(77));
        APPEAR.with(|flag| flag.set(false));
        assert!(
            matches!(
                result,
                Err(crate::registry::RegistryError::Store(
                    StoreError::Migration { .. }
                ))
            ),
            "{result:?}"
        );
        assert_eq!(
            fs::read(legacy.join("sessions/late.json")).unwrap(),
            b"late"
        );
        assert_eq!(
            fs::read(legacy.join("sessions/a.json")).unwrap(),
            b"session-a"
        );
        let store = registry.project_dir(&id(1));
        assert_eq!(
            fs::read(store.join("sessions/a.json")).unwrap(),
            b"session-a"
        );
        assert!(parked(&registry, 1).is_empty());
        // The next open takes the both-present path, which re-verifies and refuses.
        let error = registry
            .register(root.path(), &id(901), || id(77))
            .unwrap_err();
        assert!(
            matches!(
                error,
                crate::registry::RegistryError::Store(StoreError::Migration { .. })
            ),
            "{error:?}"
        );
        assert!(legacy.join("sessions/late.json").is_file());
        assert!(parked(&registry, 1).is_empty());
    }

    #[test]
    fn a_held_legacy_lock_aborts_with_no_changes() {
        use std::os::fd::AsRawFd;
        for lock in ["project.lock", "locks/a.lock"] {
            let home = tempfile::tempdir().unwrap();
            let root = tempfile::tempdir().unwrap();
            let legacy = legacy_store(root.path());
            private(&legacy.join("project.lock"), b"", 0o600);
            let holder = fs::File::open(legacy.join(lock)).unwrap();
            // SAFETY: the test owns a live descriptor.
            assert_eq!(
                unsafe { libc::flock(holder.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
                0
            );
            let registry = Registry::open(home.path()).unwrap();
            let result = registry.register(root.path(), &id(900), || id(77));
            let Err(crate::registry::RegistryError::Store(StoreError::Migration {
                legacy: named,
                ..
            })) = result
            else {
                panic!("expected a migration error, got {result:?}");
            };
            assert!(named.ends_with(lock), "{named:?}");
            assert!(legacy.join("sessions/a.json").is_file());
            assert!(!registry.project_dir(&id(1)).exists());
            assert!(parked(&registry, 1).is_empty());
            drop(holder);
            registry.register(root.path(), &id(901), || id(77)).unwrap();
            assert!(!legacy.exists());
        }
    }
}
