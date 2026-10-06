//! `<ARIADNE_HOME>/providers.json`: the explicit host paths recorded by setup.
//! The app and doctor read this file; nothing is guessed through PATH at runtime.
use super::invalid;
use ariadne_core::{CoreError, CoreErrorCode};
use ariadne_store::{session::StoreError, OwnedDirectory};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

pub const FILE: &str = "providers.json";
const LIMIT: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodexEntry {
    pub executable: PathBuf,
    pub home: PathBuf,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderFile {
    schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<CodexEntry>,
}

/// Process facts setup consults. Tests supply a private PATH and home.
#[derive(Clone, Debug, Default)]
pub struct Environment {
    pub path: Option<OsString>,
    pub codex_home: Option<PathBuf>,
}

impl Environment {
    /// Setup runs in the user's shell, so its PATH is the only place a host is looked up.
    pub fn process() -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        Self {
            path: std::env::var_os("PATH"),
            codex_home: std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .or_else(|| home.map(|home| home.join(".codex")))
                .filter(|path| path.is_absolute()),
        }
    }
}

pub(crate) fn is_executable_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

/// First executable regular file named `name` in an absolute PATH entry. The
/// returned path is as found on PATH; a user-visible symlink is not resolved.
pub(crate) fn find_on_path(name: &str, path: Option<&OsString>) -> Option<PathBuf> {
    std::env::split_paths(path?)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable_file(candidate))
}

fn directory(data: &Path, create: bool) -> Result<OwnedDirectory, StoreError> {
    let (Some(parent), Some(name)) = (data.parent(), data.file_name().and_then(|n| n.to_str()))
    else {
        return Err(StoreError::UnsafePath { path: data.into() });
    };
    OwnedDirectory::root(parent)?.child(name, create)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Read {
    Missing,
    Present(ProviderFile),
    /// Unsafe permissions, a symlink, an oversize or malformed file. Never repaired here.
    Invalid,
}

/// Read-only: never creates the data directory.
pub fn read(data: &Path) -> Read {
    let bytes = match directory(data, false).and_then(|dir| {
        if dir.verify_target(FILE)? {
            dir.read_bounded(FILE, LIMIT).map(Some)
        } else {
            Ok(None)
        }
    }) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Read::Missing,
        Err(StoreError::Io {
            kind: std::io::ErrorKind::NotFound,
            ..
        }) => return Read::Missing,
        Err(_) => return Read::Invalid,
    };
    match serde_json::from_slice::<ProviderFile>(&bytes) {
        Ok(file) if file.schema_version == 1 && valid(&file) => Read::Present(file),
        _ => Read::Invalid,
    }
}

fn valid(file: &ProviderFile) -> bool {
    let absolute = |path: &Path| path.is_absolute();
    file.codex
        .as_ref()
        .is_none_or(|c| absolute(&c.executable) && absolute(&c.home))
}

fn failure(message: &str, hint: &str) -> CoreError {
    CoreError::new(CoreErrorCode::IoError, message, hint)
}

/// Merge `update` into the file: only the supplied agents change. Atomic, private,
/// never follows a symlink; an unsafe or malformed existing file is preserved and refused.
pub fn write(data: &Path, update: ProviderUpdate) -> Result<PathBuf, CoreError> {
    let path = data.join(FILE);
    let unsafe_file = || {
        failure(
            "The existing providers file is unsafe or malformed, so it was not changed.",
            &format!(
                "Inspect {} (it must be a private regular file); remove it yourself and run setup again.",
                path.display()
            ),
        )
    };
    let dir = directory(data, true).map_err(|_| {
        failure(
            "The Ariadne data directory is missing, not private or unsafe.",
            "Restore a private (0700) owned data directory, then run setup again.",
        )
    })?;
    let mut file = match read(data) {
        Read::Missing => ProviderFile::default(),
        Read::Present(file) => file,
        Read::Invalid => return Err(unsafe_file()),
    };
    file.schema_version = 1;
    if update.codex.is_some() {
        file.codex = update.codex;
    }
    let mut bytes = serde_json::to_vec_pretty(&file).expect("providers JSON");
    bytes.push(b'\n');
    dir.temp("providers", &bytes)
        .and_then(|temporary| temporary.replace(FILE))
        .and_then(|()| dir.sync())
        .map_err(|_| {
            failure(
                "The providers file could not be written.",
                "Restore write access to the private Ariadne data directory and run setup again.",
            )
        })?;
    Ok(path)
}

#[derive(Debug, Default)]
pub struct ProviderUpdate {
    pub codex: Option<CodexEntry>,
}

/// Explicit `--codex-bin` flag from the setup request. Claude needs no recorded path:
/// the app locates the installed Mod itself and trusts the Mod's version report.
#[derive(Debug, Default)]
pub struct Explicit {
    pub codex: Option<PathBuf>,
}

pub(crate) fn explicit_path(flag: &str, value: Option<&str>) -> Result<PathBuf, CoreError> {
    let path = PathBuf::from(value.ok_or_else(|| invalid(&format!("{flag} requires a path.")))?);
    if !path.is_absolute() || !is_executable_file(&path) {
        return Err(invalid(&format!(
            "{flag} requires an absolute path to an executable file."
        )));
    }
    Ok(path)
}

/// Resolve and record the Codex host. A missing host is reported, not fatal.
/// Returns null for `--agent claude`, which records nothing.
pub(crate) fn record(
    data: &Path,
    agent: &str,
    explicit: &Explicit,
    environment: &Environment,
) -> Result<Value, CoreError> {
    if agent == "claude" {
        return Ok(Value::Null);
    }
    let mut update = ProviderUpdate::default();
    let mut recorded = Vec::new();
    let mut not_recorded = Vec::new();
    let found = explicit
        .codex
        .clone()
        .or_else(|| find_on_path("codex", environment.path.as_ref()));
    match (found, &environment.codex_home) {
        (Some(executable), Some(home)) => {
            recorded.push(json!({"agent":"codex","executable":executable,"home":home}));
            update.codex = Some(CodexEntry {
                executable,
                home: home.clone(),
            });
        }
        (Some(_), None) => not_recorded.push(json!({"agent":"codex","reason":"No absolute CODEX_HOME or HOME to locate the Codex home; set one and run setup again"})),
        (None, _) => not_recorded.push(json!({"agent":"codex","reason":"No `codex` on PATH; run setup again with --codex-bin /absolute/path"})),
    }
    let file = if update.codex.is_some() {
        Some(write(data, update)?)
    } else {
        None
    };
    Ok(json!({
        "file": file.unwrap_or_else(|| data.join(FILE)),
        "written": !recorded.is_empty(),
        "recorded": recorded,
        "not_recorded": not_recorded,
        "restart": "Quit and reopen Ariadne if it is running; it reads these paths only when it starts.",
    }))
}
