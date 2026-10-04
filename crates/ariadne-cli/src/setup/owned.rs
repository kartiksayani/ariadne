use super::{invalid, resources};
use ariadne_core::{CoreError, CoreErrorCode};
use ariadne_store::{session::StoreError, OwnedDirectory};
use serde_json::{json, Value};
use std::{collections::BTreeSet, path::Path};

const LIMIT: usize = 1024 * 1024;

pub(crate) fn parent(
    root: &OwnedDirectory,
    name: &str,
    create: bool,
) -> Result<(OwnedDirectory, String), StoreError> {
    let (parents, leaf) = name.rsplit_once('/').unwrap_or(("", name));
    let mut dir = OwnedDirectory::root(&root.path)?;
    for part in parents.split('/').filter(|part| !part.is_empty()) {
        dir = dir.child(part, create)?;
    }
    Ok((dir, leaf.into()))
}

fn receipt(helper: &Path, owned: &BTreeSet<String>) -> Vec<u8> {
    serde_json::to_vec_pretty(&json!({"schema_version":1,"app_version":resources::VERSION,"helper_path":helper,"owned_files":owned})).expect("receipt JSON")
}

fn read_receipt(
    root: &OwnedDirectory,
    helper: &Path,
    bundle: &std::collections::BTreeMap<String, Vec<u8>>,
) -> Result<(BTreeSet<String>, Option<Vec<u8>>), CoreError> {
    if !root.verify_target(resources::RECEIPT)? {
        return Ok((BTreeSet::new(), None));
    }
    let bytes = root.read_bounded(resources::RECEIPT, LIMIT)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| invalid_receipt())?;
    let array = value["owned_files"]
        .as_array()
        .ok_or_else(invalid_receipt)?;
    let mut owned = BTreeSet::new();
    for value in array {
        let name = value.as_str().ok_or_else(invalid_receipt)?;
        if !bundle.contains_key(name) || !owned.insert(name.into()) {
            return Err(invalid_receipt());
        }
    }
    if receipt(helper, &owned) != bytes {
        return Err(invalid_receipt());
    }
    Ok((owned, Some(bytes)))
}

fn invalid_receipt() -> CoreError {
    CoreError::new(CoreErrorCode::IncompatibleAdapter, "Integration ownership receipt is edited, malformed or belongs to another version.", "Preserve it and all integration files. Inspect the printed installation path manually; use matching resources rather than replacing same-version bytes.")
}

/// Trusted installation wiring supplies the already validated immutable version root.
/// This touches only the fixed inventory, never host settings or project data.
pub fn apply(version_root: &Path, agent: &str, uninstall: bool) -> Result<Value, CoreError> {
    if !["claude", "codex", "both"].contains(&agent) {
        return Err(invalid("Unknown agent selection."));
    }
    let version = OwnedDirectory::root(version_root)?;
    let integrations = match version.child("integrations", !uninstall) {
        Ok(dir) => dir,
        Err(StoreError::Io {
            kind: std::io::ErrorKind::NotFound,
            ..
        }) if uninstall => return Ok(json!({"changes":[],"retained":[],"already_present":[]})),
        Err(e) => return Err(e.into()),
    };
    if uninstall && !integrations.verify_target(resources::RECEIPT)? {
        return Ok(
            json!({"changes":[],"retained":[{"path":integrations.path,"reason":"No ownership receipt; existing resources stay unowned."}],"already_present":[]}),
        );
    }
    integrations.with_lock("setup.lock", !uninstall, || {
        work(
            &integrations,
            &version.path.join("bin/ariadne"),
            agent,
            uninstall,
        )
    })
}

fn work(
    root: &OwnedDirectory,
    helper: &Path,
    agent: &str,
    uninstall: bool,
) -> Result<Value, CoreError> {
    let bundle = resources::bundle(helper);
    let (mut owned, before) = read_receipt(root, helper, &bundle)?;
    let mut changes = Vec::new();
    let mut retained = Vec::new();
    let mut already = Vec::new();
    // Preflight the whole selected inventory before creating any resource.
    if !uninstall {
        for (name, expected) in bundle.iter().filter(|(n, _)| resources::selected(n, agent)) {
            match parent(root, name, false) {
                Ok((dir, leaf)) if dir.verify_target(&leaf)? => {
                    if dir.read_bounded(&leaf, LIMIT)? != *expected {
                        return Err(CoreError::new(CoreErrorCode::IncompatibleAdapter, "Same-version integration bytes differ; existing files were preserved.", "Use a new matching release version and reload the host. Do not replace immutable same-version resources."));
                    }
                }
                Ok(_)
                | Err(StoreError::Io {
                    kind: std::io::ErrorKind::NotFound,
                    ..
                }) => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
    for (name, expected) in bundle.iter().filter(|(n, _)| resources::selected(n, agent)) {
        if uninstall {
            if !owned.contains(name) {
                continue;
            }
            let removal = parent(root, name, false)
                .and_then(|(dir, leaf)| dir.remove_if_unchanged(&leaf, expected));
            match removal {
                Ok(true) => { changes.push(json!({"action":"removed","path":root.path.join(name)})); owned.remove(name); }
                Err(StoreError::Io { kind: std::io::ErrorKind::NotFound, .. }) => { owned.remove(name); }
                Ok(false) | Err(StoreError::UnsafePath { .. }) => retained.push(json!({"path":root.path.join(name),"reason":"Edited or nonregular owned resource; remove manually if desired."})),
                Err(error) => return Err(error.into()),
            }
        } else {
            let (dir, leaf) = parent(root, name, true)?;
            if dir.verify_target(&leaf)? {
                already.push(json!({"path":dir.path.join(&leaf),"owned":owned.contains(name)}));
            } else {
                dir.temp(&leaf, expected)?.create(&leaf)?;
                dir.sync()?;
                owned.insert(name.clone());
                // Record every successful creation before the next resource.
                // A later failure is partial setup; no rollback is claimed.
                let bytes = receipt(helper, &owned);
                let temp = root.temp(resources::RECEIPT, &bytes)?;
                if root.verify_target(resources::RECEIPT)? {
                    temp.replace(resources::RECEIPT)?;
                } else {
                    temp.create(resources::RECEIPT)?;
                }
                root.sync()?;
                changes.push(json!({"action":"created","path":dir.path.join(&leaf)}));
            }
        }
    }
    if uninstall {
        if let Some(before) = before {
            if owned.is_empty() {
                root.remove_if_unchanged(resources::RECEIPT, &before)?;
            } else if receipt(helper, &owned) != before {
                root.temp(resources::RECEIPT, &receipt(helper, &owned))?
                    .replace(resources::RECEIPT)?;
                root.sync()?;
            }
        }
    }
    Ok(json!({"changes":changes,"retained":retained,"already_present":already}))
}

pub(crate) fn check(version_root: &Path) -> Result<Value, CoreError> {
    let version = OwnedDirectory::root(version_root)?;
    let root = version.child("integrations", false)?;
    let helper = version.path.join("bin/ariadne");
    root.with_lock("setup.lock", false, || check_locked(&root, &helper))
}

fn check_locked(root: &OwnedDirectory, helper: &Path) -> Result<Value, CoreError> {
    let bundle = resources::bundle(helper);
    let (owned, _) = read_receipt(root, helper, &bundle)?;
    let mut missing = Vec::new();
    let mut changed = Vec::new();
    for (name, expected) in &bundle {
        match parent(root, name, false).and_then(|(dir, leaf)| dir.read_bounded(&leaf, LIMIT)) {
            Ok(actual) if &actual == expected => {}
            Ok(_) => changed.push(name),
            Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
                ..
            }) => missing.push(name),
            Err(error) => return Err(error.into()),
        }
    }
    Ok(json!({"owned_file_count":owned.len(),"missing":missing,"changed":changed}))
}
