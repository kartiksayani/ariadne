//! Bounded read-only version and exact SDK-root resource inspection.
use crate::{
    evidence::{absolute, fresh, LoadedModIdentity, ModEvidence, QualifiedClaudeHost},
    normalization::error,
};
use ariadne_agent_protocol::{
    host_version::{accepted_range, classify_host_version},
    AdapterError, AdapterErrorCode, EndpointFingerprint, UtcMillis,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Read,
    os::fd::{AsRawFd, FromRawFd},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

pub const SUPPORTED_HOST_VERSION: &str = "2.1.287";
type FileIdentity = (u64, u64, u64, i64, i64, i64, i64);
const RESOURCES: [&str; 16] = [
    ".claude-plugin/plugin.json",
    "hooks/hooks.json",
    "hooks/register.js",
    "hooks/contracts.js",
    "hooks/setup.js",
    "hooks/claims.js",
    "hooks/discovery.js",
    "hooks/installed.js",
    "skills/ariadne/SKILL.md",
    "skills/ariadne/inputs.md",
    "skills/ariadne/errors.md",
    "skills/ariadne/reconnect.md",
    "skills/ariadne/report.md",
    "skills/ariadne/review.md",
    "skills/ariadne/checklist.md",
    "skills/ariadne/follow-up.md",
];

/// Explicit installed paths supplied by native composition, never discovered from PATH/cache.
#[derive(Debug, Clone)]
pub struct ClaudeOptions {
    pub installed_plugin: PathBuf,
    pub helper: PathBuf,
    pub project_root: PathBuf,
    pub app_version: String,
}

/// Read only an explicitly selected CLI's version (doctor's `--claude-bin`). The
/// adapter itself never runs a Claude executable: it trusts the loaded Mod's report.
pub fn read_cli_version(executable: &Path, deadline: Instant) -> Result<String, AdapterError> {
    absolute(executable)?;
    cli_version(
        executable,
        deadline.min(Instant::now() + Duration::from_secs(5)),
    )
}

impl ClaudeOptions {
    /// Blocking trusted native qualification of a UID-checked SDK announcement.
    /// Offload outside Registry/Store locks, then recheck candidate/association before
    /// publishing. The original receipt time is retained; this creates no heartbeat.
    pub fn qualify_identity(
        &self,
        identity: LoadedModIdentity,
        observed_at: UtcMillis,
        received: Instant,
        deadline: Instant,
    ) -> Result<ModEvidence, AdapterError> {
        self.qualify_parts(identity, observed_at, received, deadline)
            .map(|(evidence, _)| evidence)
    }
    /// Blocking native pre-ID qualification. Reuses the installed version/resource
    /// checks and retains the original receipt age under the caller's total deadline.
    pub fn qualify_host_identity(
        &self,
        identity: LoadedModIdentity,
        observed_at: UtcMillis,
        received: Instant,
        deadline: Instant,
    ) -> Result<QualifiedClaudeHost, AdapterError> {
        let (evidence, fingerprint) =
            self.qualify_parts(identity, observed_at, received, deadline)?;
        Ok(QualifiedClaudeHost {
            evidence: Arc::new(evidence),
            fingerprint,
        })
    }
    fn qualify_parts(
        &self,
        identity: LoadedModIdentity,
        observed_at: UtcMillis,
        received: Instant,
        deadline: Instant,
    ) -> Result<(ModEvidence, EndpointFingerprint), AdapterError> {
        let deadline = deadline.min(Instant::now() + Duration::from_secs(5));
        check_deadline(deadline)?;
        self.validate()?;
        let evidence = ModEvidence::received_at(identity, observed_at, received)?;
        let fingerprint = qualify(self, &evidence, deadline)?;
        Ok((evidence, fingerprint))
    }
    pub(crate) fn validate(&self) -> Result<(), AdapterError> {
        for path in [&self.installed_plugin, &self.helper, &self.project_root] {
            absolute(path)?;
        }
        if self.app_version.trim().is_empty() || self.app_version.len() > 4096 {
            return Err(error(
                AdapterErrorCode::InvalidArgument,
                "Installed app version is missing or oversized",
            ));
        }
        Ok(())
    }
}

pub(crate) fn qualify(
    options: &ClaudeOptions,
    evidence: &ModEvidence,
    deadline: Instant,
) -> Result<EndpointFingerprint, AdapterError> {
    if !fresh(evidence) {
        return Err(error(
            AdapterErrorCode::HostUnreachable,
            "The original native Mod announcement is stale; qualification cannot refresh its age",
        ));
    }
    // The loaded Mod's announcement is the version source; the installed resources
    // checked below are the trust anchor, not a `claude --version` run.
    let reported = &evidence.identity.engine_version;
    if classify_host_version(SUPPORTED_HOST_VERSION, reported).is_none() {
        return Err(error(
            AdapterErrorCode::UnsupportedHostVersion,
            &format!(
                "Ariadne requires Claude Code {}; the loaded Mod reports {reported}",
                accepted_range(SUPPORTED_HOST_VERSION),
            ),
        ));
    }
    let fingerprint = resource_identity(options, evidence, deadline)?;
    check_deadline(deadline)?;
    if !fresh(evidence) {
        return Err(error(AdapterErrorCode::HostUnreachable, "The original Mod announcement expired during qualification; refresh its actual heartbeat"));
    }
    Ok(EndpointFingerprint(fingerprint))
}

fn cli_version(executable: &Path, deadline: Instant) -> Result<String, AdapterError> {
    let output = version_output(executable, deadline)?;
    let version = output.strip_suffix(" (Claude Code)").ok_or_else(|| {
        error(
            AdapterErrorCode::UnsupportedHostVersion,
            "Claude version output is not the canonical Claude Code record",
        )
    })?;
    if version.is_empty()
        || version.len() > 64
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
    {
        return Err(error(
            AdapterErrorCode::UnsupportedHostVersion,
            "Claude version output is not a known version record",
        ));
    }
    Ok(version.to_owned())
}
fn version_output(path: &Path, deadline: Instant) -> Result<String, AdapterError> {
    check_deadline(deadline)?;
    let executable = canonical(path)?;
    let identity = file_identity(&executable, true)?;
    let child = Command::new(&executable)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| {
            error(
                AdapterErrorCode::HostUnreachable,
                "Cannot inspect selected executable version",
            )
        })?;
    let mut child = OwnedChild(child);
    let mut stdout = child.0.stdout.take().ok_or_else(io_error)?;
    let mut stderr = child.0.stderr.take().ok_or_else(io_error)?;
    nonblocking(stdout.as_raw_fd())?;
    nonblocking(stderr.as_raw_fd())?;
    let mut output = Vec::new();
    let mut diagnostic_bytes = 0;
    loop {
        check_deadline(deadline)?;
        read_pipe(&mut stdout, Some(&mut output), &mut diagnostic_bytes)?;
        read_pipe(&mut stderr, None, &mut diagnostic_bytes)?;
        if let Some(status) = child.0.try_wait().map_err(|_| io_error())? {
            read_pipe(&mut stdout, Some(&mut output), &mut diagnostic_bytes)?;
            read_pipe(&mut stderr, None, &mut diagnostic_bytes)?;
            if !status.success() {
                return Err(error(
                    AdapterErrorCode::HostUnreachable,
                    "Selected version command failed",
                ));
            }
            break;
        }
        std::thread::sleep(
            Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
    if identity != file_identity(&executable, true)? || canonical(path)? != executable {
        return Err(error(
            AdapterErrorCode::BindingMismatch,
            "Selected executable changed during version inspection",
        ));
    }
    let output = String::from_utf8(output).map_err(|_| {
        error(
            AdapterErrorCode::UnsupportedHostVersion,
            "Executable version output is not a known version record",
        )
    })?;
    Ok(output.trim().to_owned())
}
struct OwnedChild(std::process::Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}
fn nonblocking(fd: i32) -> Result<(), AdapterError> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io_error());
    }
    Ok(())
}
fn read_pipe(
    pipe: &mut impl Read,
    mut output: Option<&mut Vec<u8>>,
    total: &mut usize,
) -> Result<(), AdapterError> {
    let mut buffer = [0; 1024];
    loop {
        match pipe.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(size) => {
                *total += size;
                if *total > 4096 {
                    return Err(error(
                        AdapterErrorCode::UnsupportedHostVersion,
                        "Claude version output exceeds its 4KiB bound",
                    ));
                }
                if let Some(output) = output.as_mut() {
                    output.extend_from_slice(&buffer[..size]);
                }
            }
            Err(cause) if cause.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
            Err(cause) if cause.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(io_error()),
        }
    }
}

/// Resource parity requires a fresh actual Mod announcement plus exact-root native reads.
/// Matching installed files by themselves cannot establish a loaded Mod.
pub(crate) fn resource_identity(
    options: &ClaudeOptions,
    evidence: &ModEvidence,
    deadline: Instant,
) -> Result<String, AdapterError> {
    let identity = &evidence.identity;
    if identity.plugin_name != "ariadne"
        || identity.app_version != options.app_version
        || identity.api_version != 1
    {
        return Err(reload());
    }
    let helper = canonical(&options.helper)?;
    if canonical(&identity.helper_path)? != helper {
        return Err(reload());
    }
    let helper_identity = file_identity(&helper, true)?;
    if version_output(&helper, deadline)? != format!("ariadne {}", options.app_version) {
        return Err(reload());
    }
    let project = canonical(&options.project_root)?;
    if !std::fs::metadata(&project)
        .map_err(|_| io_error())?
        .is_dir()
    {
        return Err(error(
            AdapterErrorCode::BindingMismatch,
            "Selected canonical project root must be a directory",
        ));
    }
    if canonical(&identity.project_root)? != project {
        return Err(error(
            AdapterErrorCode::BindingMismatch,
            "Mod announcement differs from the selected canonical project root",
        ));
    }
    let installed = canonical(&options.installed_plugin)?;
    let loaded = canonical(&identity.plugin_root)?;
    let installed_directory = directory(&installed)?;
    let loaded_directory = directory(&loaded)?;
    let mut records = Vec::new();
    for name in RESOURCES {
        check_deadline(deadline)?;
        let expected = read_resource(&installed_directory, name, deadline)?;
        let actual = read_resource(&loaded_directory, name, deadline)?;
        if expected != actual {
            return Err(reload());
        }
        if name == ".claude-plugin/plugin.json" {
            let manifest: Value = serde_json::from_slice(&actual).map_err(|_| reload())?;
            if manifest.get("name").and_then(Value::as_str) != Some("ariadne")
                || manifest.get("version").and_then(Value::as_str)
                    != Some(options.app_version.as_str())
            {
                return Err(reload());
            }
        }
        records.push((name, format!("{:x}", Sha256::digest(&actual))));
    }
    let tuple = (
        installed,
        loaded,
        project,
        helper,
        helper_identity,
        identity.external_session_id.as_str(),
        identity.engine_version.as_str(),
        records,
    );
    let bytes = serde_json::to_vec(&tuple).map_err(|_| io_error())?;
    Ok(format!("claude-mod-v2:{:x}", Sha256::digest(bytes)))
}
fn read_resource(root: &File, name: &str, deadline: Instant) -> Result<Vec<u8>, AdapterError> {
    let components: Vec<_> = name.split('/').collect();
    let mut directory = root.try_clone().map_err(|_| io_error())?;
    for (offset, part) in components.iter().enumerate() {
        check_deadline(deadline)?;
        let name = std::ffi::CString::new(*part).map_err(|_| io_error())?;
        let last = offset + 1 == components.len();
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if last { 0 } else { libc::O_DIRECTORY };
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(io_error());
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        let metadata = file.metadata().map_err(|_| io_error())?;
        trusted(&metadata)?;
        if !last {
            if !metadata.is_dir() {
                return Err(io_error());
            }
            directory = file;
            continue;
        }
        if !metadata.is_file() || metadata.len() > 1024 * 1024 {
            return Err(io_error());
        }
        let mut bytes = Vec::new();
        let mut buffer = [0; 8192];
        loop {
            check_deadline(deadline)?;
            let size = file.read(&mut buffer).map_err(|_| io_error())?;
            if size == 0 {
                break;
            }
            if bytes.len() + size > 1024 * 1024 {
                return Err(io_error());
            }
            bytes.extend_from_slice(&buffer[..size]);
        }
        let after = file.metadata().map_err(|_| io_error())?;
        if metadata_signature(&metadata) != metadata_signature(&after)
            || bytes.len() as u64 != after.len()
        {
            return Err(io_error());
        }
        return Ok(bytes);
    }
    Err(io_error())
}
fn directory(path: &Path) -> Result<File, AdapterError> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| io_error())?;
    let metadata = file.metadata().map_err(|_| io_error())?;
    trusted(&metadata)?;
    if !metadata.is_dir() {
        return Err(io_error());
    }
    Ok(file)
}
fn canonical(path: &Path) -> Result<PathBuf, AdapterError> {
    std::fs::canonicalize(path).map_err(|_| io_error())
}
fn metadata_signature(metadata: &std::fs::Metadata) -> FileIdentity {
    (
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec(),
    )
}
fn trusted(metadata: &std::fs::Metadata) -> Result<(), AdapterError> {
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o022 != 0 {
        return Err(error(AdapterErrorCode::PermissionDenied, "Claude integration resource/executable must be owned by this user and not writable by other users"));
    }
    Ok(())
}
fn file_identity(path: &Path, executable: bool) -> Result<FileIdentity, AdapterError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| io_error())?;
    trusted(&metadata)?;
    if !metadata.is_file() || executable && metadata.mode() & 0o111 == 0 {
        return Err(io_error());
    }
    Ok(metadata_signature(&metadata))
}
pub(crate) fn check_deadline(deadline: Instant) -> Result<(), AdapterError> {
    if Instant::now() >= deadline {
        Err(error(
            AdapterErrorCode::HostUnreachable,
            "Claude read-only inspection exceeded its bounded deadline",
        ))
    } else {
        Ok(())
    }
}
fn io_error() -> AdapterError {
    error(AdapterErrorCode::HostUnreachable, "Claude executable or exact loaded/installed resources could not be verified; check paths, install and reload the Mod")
}
fn reload() -> AdapterError {
    error(AdapterErrorCode::IncompatibleAdapter, "Claude loaded Mod/descriptor/resources differ from the installed version; update matching resources and reload plugins")
}
