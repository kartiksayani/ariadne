//! Small directory-relative helpers for Ariadne-owned control files.
use ariadne_core::{CoreError, CoreErrorCode};
use std::{
    ffi::CString,
    fs::{self, File, OpenOptions},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt},
        io::{AsRawFd, FromRawFd},
    },
    path::{Path, PathBuf},
};

pub(crate) fn error(code: CoreErrorCode, message: &str) -> CoreError {
    CoreError::new(
        code,
        message,
        "Check ARIADNE_HOME ownership, permissions and the desktop's current binding.",
    )
}
pub(crate) fn io_error(operation: &str, cause: std::io::Error) -> CoreError {
    let code = if cause.kind() == std::io::ErrorKind::PermissionDenied {
        CoreErrorCode::PermissionDenied
    } else {
        CoreErrorCode::HostUnreachable
    };
    error(code, &format!("{operation}: {cause}"))
}
pub(crate) fn uid() -> u32 {
    // SAFETY: geteuid has no pointer arguments or side effects.
    unsafe { libc::geteuid() }
}
pub(crate) struct Directory {
    pub file: File,
    pub path: PathBuf,
}
impl Directory {
    pub fn home(path: &Path, create: bool) -> Result<Self, CoreError> {
        if !path.is_absolute() || path.file_name().is_none() {
            return Err(error(
                CoreErrorCode::InvalidArgument,
                "ARIADNE_HOME must be an absolute directory path.",
            ));
        }
        if create {
            use std::os::unix::fs::DirBuilderExt;
            match fs::DirBuilder::new().mode(0o700).create(path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(io_error("Create ARIADNE_HOME", e)),
            }
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(|e| io_error("Open private ARIADNE_HOME without following links", e))?;
        check(&file, true)?;
        Ok(Self {
            file,
            path: path.to_owned(),
        })
    }
    pub fn child(&self, name: &str, create: bool) -> Result<Self, CoreError> {
        let name_c = CString::new(name).map_err(|_| {
            error(
                CoreErrorCode::InvalidArgument,
                "Invalid private directory name.",
            )
        })?;
        if create {
            // SAFETY: live parent fd, valid single-component name and mode.
            if unsafe { libc::mkdirat(self.file.as_raw_fd(), name_c.as_ptr(), 0o700) } < 0 {
                let e = std::io::Error::last_os_error();
                if e.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(io_error("Create private directory", e));
                }
            }
        }
        // SAFETY: valid directory fd and NUL-terminated name; successful fd is owned below.
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name_c.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io_error(
                "Open private directory without following links",
                std::io::Error::last_os_error(),
            ));
        }
        // SAFETY: successful openat returned a new owned descriptor.
        let file = unsafe { File::from_raw_fd(fd) };
        check(&file, true)?;
        Ok(Self {
            file,
            path: self.path.join(name),
        })
    }
    pub fn lock(&self, name: &str) -> Result<File, CoreError> {
        let name = CString::new(name)
            .map_err(|_| error(CoreErrorCode::InvalidArgument, "Invalid lease file name."))?;
        // SAFETY: valid parent fd/name; created files are private and no final link is followed.
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_NOFOLLOW
                    | libc::O_CLOEXEC
                    | libc::O_NONBLOCK,
                0o600,
            )
        };
        if fd < 0 {
            return Err(io_error(
                "Open stable lease file",
                std::io::Error::last_os_error(),
            ));
        }
        // SAFETY: successful openat returned a new owned descriptor.
        let file = unsafe { File::from_raw_fd(fd) };
        check(&file, false)?;
        // SAFETY: flock operates on our owned file descriptor and never waits.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } < 0 {
            let e = std::io::Error::last_os_error();
            if e.kind() == std::io::ErrorKind::WouldBlock {
                return Err(error(
                    CoreErrorCode::PermissionDenied,
                    "Another desktop or supervisor holds this nonblocking lease.",
                ));
            }
            return Err(io_error("Acquire nonblocking lease", e));
        }
        Ok(file)
    }
    pub fn validate_path(&self) -> Result<(), CoreError> {
        let current = fs::symlink_metadata(&self.path)
            .map_err(|e| io_error("Recheck private directory", e))?;
        let original = self
            .file
            .metadata()
            .map_err(|e| io_error("Read private directory identity", e))?;
        if !current.is_dir()
            || current.uid() != uid()
            || current.mode() & 0o777 != 0o700
            || current.dev() != original.dev()
            || current.ino() != original.ino()
        {
            return Err(error(
                CoreErrorCode::PermissionDenied,
                "Private directory identity or mode changed.",
            ));
        }
        Ok(())
    }
}
fn check(file: &File, directory: bool) -> Result<(), CoreError> {
    let metadata = file
        .metadata()
        .map_err(|e| io_error("Read private file metadata", e))?;
    let valid_type = if directory {
        metadata.is_dir()
    } else {
        metadata.is_file() && metadata.nlink() == 1
    };
    let mode = if directory { 0o700 } else { 0o600 };
    if !valid_type || metadata.uid() != uid() || metadata.mode() & 0o777 != mode {
        return Err(error(
            CoreErrorCode::PermissionDenied,
            "Private file has unexpected type, owner, links or permissions.",
        ));
    }
    Ok(())
}
