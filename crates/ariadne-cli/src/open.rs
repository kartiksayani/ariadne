//! Explicit native navigation through the package-owned install descriptor.
use ariadne_core::{
    native::{AgentResolver, NativeCoreService},
    CoreError, CoreErrorCode, OpenRoute, RegisteredSession, SessionRef,
};
use ariadne_domain::models::{ItemRef, UtcMillis, UuidV4};
use serde::Deserialize;
use std::ffi::{CString, OsString};
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

const MANIFEST_LIMIT: u64 = 512 * 1024;

fn invalid(message: &str) -> CoreError {
    CoreError::new(
        CoreErrorCode::InvalidArgument,
        message,
        "Use an explicit registered route and reinstall the matching Ariadne package if its install descriptor is invalid.",
    )
}
fn io(error: std::io::Error) -> CoreError {
    CoreError::new(
        if error.kind() == std::io::ErrorKind::PermissionDenied {
            CoreErrorCode::PermissionDenied
        } else {
            CoreErrorCode::IoError
        },
        "The installed Ariadne application could not be read or opened.",
        "Check the package installation and access permissions; no application path was guessed.",
    )
}

pub fn parse(args: &[&str]) -> Result<OpenRoute, CoreError> {
    let Some(("open", rest)) = args.split_first().map(|(first, rest)| (*first, rest)) else {
        return Err(invalid(
            "Expected ariadne open with explicit project and session IDs.",
        ));
    };
    let (mut project, mut session, mut item) = (None, None, None);
    for pair in rest.chunks(2) {
        let [name, value] = pair else {
            return Err(invalid("Every open argument requires a value."));
        };
        match *name {
            "--project" if project.is_none() => {
                project = Some(UuidV4::new(*value).map_err(|_| invalid("Invalid project UUID."))?);
            }
            "--session" if session.is_none() => {
                session = Some(UuidV4::new(*value).map_err(|_| invalid("Invalid session UUID."))?);
            }
            "--item" if item.is_none() => {
                item = Some(ItemRef::new(*value).map_err(|_| invalid("Invalid item reference."))?);
            }
            _ => return Err(invalid("Unknown or repeated open argument.")),
        }
    }
    Ok(OpenRoute {
        project_id: project.ok_or_else(|| invalid("An explicit project UUID is required."))?,
        session_id: session.ok_or_else(|| invalid("An explicit session UUID is required."))?,
        item_id: item,
    })
}

// Package metadata may add non-routing inventory fields within version 1.
// Serde still rejects duplicate known fields and missing required fields.
#[derive(Deserialize)]
struct InstallManifest {
    schema_version: u32,
    version: String,
    app_path: PathBuf,
}

fn version_component(version: &str) -> bool {
    !version.is_empty()
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-_".contains(&byte))
        && matches!(
            Path::new(version).components().next(),
            Some(Component::Normal(_))
        )
        && Path::new(version).components().count() == 1
}

/// Exact package paths validated from the current version descriptor.
pub struct InstalledPackage {
    pub version_root: PathBuf,
    pub application: PathBuf,
}

/// Read only the exact version selected by `current`, anchored before decoding.
pub fn installed_package(
    package_root: &Path,
    helper_version: &str,
) -> Result<InstalledPackage, CoreError> {
    if !version_component(helper_version) {
        return Err(invalid("Invalid installed helper version."));
    }
    let root = std::fs::canonicalize(package_root).map_err(io)?;
    let versions = root.join("versions");
    if std::fs::canonicalize(&versions).map_err(io)? != versions {
        return Err(invalid(
            "The package versions directory must not redirect elsewhere.",
        ));
    }
    let expected = versions.join(helper_version);
    if std::fs::canonicalize(&expected).map_err(io)? != expected
        || std::fs::canonicalize(root.join("current")).map_err(io)? != expected
    {
        return Err(invalid(
            "The current package does not match this helper version.",
        ));
    }
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(root.join("current"))
        .map_err(io)?;
    let opened = directory.metadata().map_err(io)?;
    let selected = std::fs::metadata(&expected).map_err(io)?;
    if opened.dev() != selected.dev() || opened.ino() != selected.ino() {
        return Err(invalid(
            "The current package changed while it was being read.",
        ));
    }
    let name = CString::new("install.json").expect("literal");
    // The descriptor cannot redirect the anchored directory to a symlink/FIFO.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        return Err(io(std::io::Error::last_os_error()));
    }
    // openat returned a fresh descriptor owned by this scope.
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file.metadata().map_err(io)?;
    if !metadata.is_file() || metadata.len() > MANIFEST_LIMIT {
        return Err(invalid(
            "The package install descriptor is not a bounded regular file.",
        ));
    }
    let mut bytes = Vec::new();
    file.take(MANIFEST_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() as u64 > MANIFEST_LIMIT {
        return Err(invalid(
            "The package install descriptor exceeds its size limit.",
        ));
    }
    let manifest: InstallManifest = serde_json::from_slice(&bytes)
        .map_err(|_| invalid("The package install descriptor is invalid."))?;
    if manifest.schema_version != 1
        || manifest.version != helper_version
        || !version_component(&manifest.version)
        || !manifest.app_path.is_absolute()
    {
        return Err(invalid(
            "The package install descriptor has an unsupported or mismatched version/path.",
        ));
    }
    let application = std::fs::canonicalize(&manifest.app_path).map_err(io)?;
    if !application.is_dir() || std::fs::canonicalize(root.join("current")).map_err(io)? != expected
    {
        return Err(invalid(
            "The installed application is unavailable or the current package changed.",
        ));
    }
    Ok(InstalledPackage {
        version_root: expected,
        application,
    })
}

/// Application-only compatibility entrypoint for existing native route callers.
pub fn installed_application(
    package_root: &Path,
    helper_version: &str,
) -> Result<PathBuf, CoreError> {
    installed_package(package_root, helper_version).map(|package| package.application)
}

/// `-n` creates a short-lived second process for single-instance argv delivery.
pub fn launch_args(application: &Path, route: &OpenRoute) -> Result<Vec<OsString>, CoreError> {
    if !application.is_absolute() {
        return Err(invalid("The installed application path must be absolute."));
    }
    Ok(vec![
        "-n".into(),
        "-a".into(),
        application.as_os_str().to_owned(),
        "--args".into(),
        "--ariadne-route".into(),
        serde_json::to_string(route)
            .map_err(|_| invalid("The registered route cannot be encoded."))?
            .into(),
    ])
}

pub const HELP: &str = "Open a registered Ariadne route:\n  ariadne open --project UUID --session UUID [--item ItemRef]\nThe matching installed package supplies the app path; there is no cwd or app scan.\n";

/// Trusted native composition; the resolver must use authoritative membership.
/// Optional missing items remain the renderer's registered session fallback.
pub fn open_with(
    route: OpenRoute,
    package_root: &Path,
    version: &str,
    resolve: impl FnOnce(&SessionRef) -> Result<RegisteredSession, CoreError>,
    launch: impl FnOnce(&Path, &[OsString]) -> Result<(), CoreError>,
) -> Result<OpenRoute, CoreError> {
    let registered = resolve(&SessionRef {
        project_id: route.project_id.clone(),
        session_id: route.session_id.clone(),
    })?;
    if registered.project_id() != &route.project_id || registered.session_id() != &route.session_id
    {
        return Err(CoreError::new(
            CoreErrorCode::PermissionDenied,
            "The resolved registered session does not match the requested route.",
            "Use explicit IDs belonging to the same registered project/session.",
        ));
    }
    let application = installed_application(package_root, version)?;
    let args = launch_args(&application, &route)?;
    launch(Path::new("/usr/bin/open"), &args)?;
    Ok(route)
}

pub fn run(args: &[&str], output: &mut dyn std::io::Write, errors: &mut dyn std::io::Write) -> i32 {
    if matches!(args, ["open", "--help" | "-h"]) {
        return if output.write_all(HELP.as_bytes()).is_ok() {
            0
        } else {
            4
        };
    }
    let result = (|| {
        let route = parse(args)?;
        let data = crate::bridge::command::home_from_environment()?;
        let registry = AgentResolver::open_data_directory(&data)?;
        let core = NativeCoreService::new(
            registry,
            || UuidV4::new(uuid::Uuid::new_v4().to_string()).expect("UUIDv4 generator"),
            || {
                UtcMillis::new(
                    chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                )
                .expect("native UTC clock")
            },
            |_| {
                Err(CoreError::new(
                    CoreErrorCode::Unsupported,
                    "Open routing has no provider verifier.",
                    "Use native owner setup to connect an installed adapter.",
                ))
            },
        );
        let home = std::env::var_os("HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .ok_or_else(|| {
                invalid("An absolute native HOME is required for the installed package.")
            })?;
        let route = open_with(
            route,
            &home.join(".local/share/ariadne"),
            env!("CARGO_PKG_VERSION"),
            |route| core.resolve_session(route),
            |program, args| {
                let status = std::process::Command::new(program)
                    .args(args)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .map_err(io)?;
                if status.success() {
                    Ok(())
                } else {
                    Err(CoreError::new(CoreErrorCode::IoError,
                        "macOS could not open the installed Ariadne application.",
                        "Check the matching package and application permissions; no alternative application was launched."))
                }
            },
        )?;
        serde_json::to_value(route)
            .map_err(|_| invalid("The registered open route cannot be encoded."))
    })();
    crate::output::write(result, false, output, errors)
}
