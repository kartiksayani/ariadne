//! Directory-relative Unix IO. All descendant names are generated internally.
use super::StoreError;
use std::ffi::CString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) struct Directory {
    file: File,
    pub path: PathBuf,
}

fn c_name(value: &[u8], path: &Path) -> Result<CString, StoreError> {
    CString::new(value).map_err(|_| StoreError::UnsafePath { path: path.into() })
}

fn os_result(value: libc::c_int, action: &'static str, path: &Path) -> Result<(), StoreError> {
    if value == -1 {
        Err(StoreError::io(action, path, io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

fn checked_file(
    fd: libc::c_int,
    path: &Path,
    directory: bool,
    private: bool,
) -> Result<File, StoreError> {
    if fd == -1 {
        return Err(StoreError::io("open", path, io::Error::last_os_error()));
    }
    // SAFETY: successful open/openat returns a new owned descriptor.
    let file = unsafe { File::from_raw_fd(fd) };
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: the descriptor is live and stat points to writable storage.
    os_result(
        unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) },
        "stat",
        path,
    )?;
    // SAFETY: fstat initialized stat after returning success.
    let stat = unsafe { stat.assume_init() };
    let expected_type = if directory {
        libc::S_IFDIR
    } else {
        libc::S_IFREG
    };
    // SAFETY: geteuid has no preconditions.
    let owner = unsafe { libc::geteuid() };
    if stat.st_mode & libc::S_IFMT != expected_type
        || (private
            && (stat.st_uid != owner
                || stat.st_mode & 0o777 != if directory { 0o700 } else { 0o600 }))
        || (!directory && stat.st_nlink != 1)
    {
        return Err(StoreError::UnsafePath { path: path.into() });
    }
    Ok(file)
}

impl Directory {
    pub fn root(path: &Path) -> Result<Self, StoreError> {
        let path = path
            .canonicalize()
            .map_err(|error| StoreError::io("canonicalize", path, error))?;
        let name = c_name(path.as_os_str().as_bytes(), &path)?;
        // SAFETY: name is NUL terminated; open returns an owned descriptor.
        let fd = unsafe {
            libc::open(
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        Ok(Self {
            file: checked_file(fd, &path, true, false)?,
            path,
        })
    }

    pub fn child(&self, name: &str, create: bool) -> Result<Self, StoreError> {
        let path = self.path.join(name);
        let name = c_name(name.as_bytes(), &path)?;
        if create {
            // SAFETY: parent descriptor and relative single-component name are valid.
            let result = unsafe { libc::mkdirat(self.file.as_raw_fd(), name.as_ptr(), 0o700) };
            if result == -1 && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists {
                return Err(StoreError::io("mkdir", &path, io::Error::last_os_error()));
            }
            if result == 0 {
                self.sync()?;
            }
        }
        // SAFETY: parent descriptor is live; name is a generated single component.
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        Ok(Self {
            file: checked_file(fd, &path, true, true)?,
            path,
        })
    }

    pub fn open(&self, name: &str, create: bool) -> Result<File, StoreError> {
        let path = self.path.join(name);
        let name = c_name(name.as_bytes(), &path)?;
        let flags = libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | libc::O_NONBLOCK
            | if create {
                libc::O_RDWR | libc::O_CREAT
            } else {
                libc::O_RDONLY
            };
        // SAFETY: parent descriptor is live; name is a generated single component.
        let fd = unsafe { libc::openat(self.file.as_raw_fd(), name.as_ptr(), flags, 0o600) };
        checked_file(fd, &path, false, true)
    }

    pub fn read(&self, name: &str) -> Result<Vec<u8>, StoreError> {
        let mut file = self.open(name, false)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|error| StoreError::io("read", &self.path.join(name), error))?;
        Ok(bytes)
    }

    pub fn verify_target(&self, name: &str) -> Result<bool, StoreError> {
        match self.open(name, false) {
            Ok(_) => Ok(true),
            Err(StoreError::Io {
                kind: io::ErrorKind::NotFound,
                ..
            }) => Ok(false),
            Err(error) => Err(error),
        }
    }

    pub fn temp(&self, stem: &str, bytes: &[u8]) -> Result<Temporary<'_>, StoreError> {
        loop {
            let number = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let name = format!(".{stem}.tmp-{}-{number}", std::process::id());
            let path = self.path.join(&name);
            let c = c_name(name.as_bytes(), &path)?;
            // SAFETY: the valid parent descriptor anchors this exclusive creation.
            let fd = unsafe {
                libc::openat(
                    self.file.as_raw_fd(),
                    c.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC
                        | libc::O_NONBLOCK,
                    0o600,
                )
            };
            if fd == -1 && io::Error::last_os_error().kind() == io::ErrorKind::AlreadyExists {
                continue;
            }
            let mut file = checked_file(fd, &path, false, true)?;
            let temporary = Temporary {
                directory: self,
                name,
                present: true,
                identity: file
                    .metadata()
                    .map_err(|error| StoreError::io("stat", &path, error))?,
            };
            file.write_all(bytes)
                .map_err(|error| StoreError::io("write", &path, error))?;
            file.sync_all()
                .map_err(|error| StoreError::io("sync_file", &path, error))?;
            return Ok(temporary);
        }
    }

    pub fn names(&self) -> Result<Vec<String>, StoreError> {
        // A new file description keeps independent directory offsets; enumeration
        // and subsequent opens remain anchored to the same owned directory inode.
        let dot = CString::new(".").expect("literal");
        // SAFETY: the parent descriptor is live, and dot is a terminated component.
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                dot.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd == -1 {
            return Err(StoreError::io(
                "enumerate",
                &self.path,
                io::Error::last_os_error(),
            ));
        }
        // SAFETY: fdopendir takes ownership of this new directory descriptor.
        let directory = unsafe { libc::fdopendir(fd) };
        if directory.is_null() {
            let error = io::Error::last_os_error();
            // SAFETY: fdopendir failed, so we still own fd.
            unsafe {
                libc::close(fd);
            }
            return Err(StoreError::io("enumerate", &self.path, error));
        }
        struct Entries(*mut libc::DIR);
        impl Drop for Entries {
            fn drop(&mut self) {
                unsafe {
                    libc::closedir(self.0);
                }
            }
        }
        let entries = Entries(directory);
        let mut names = Vec::new();
        loop {
            // SAFETY: readdir borrows this live stream; errno distinguishes EOF.
            unsafe {
                *errno() = 0;
            }
            let entry = unsafe { libc::readdir(entries.0) };
            if entry.is_null() {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(0) {
                    return Err(StoreError::io("enumerate", &self.path, error));
                }
                break;
            }
            // SAFETY: readdir's name is terminated and valid until its next call.
            let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
            let name = name.to_str().map_err(|_| StoreError::UnsafePath {
                path: self.path.clone(),
            })?;
            if name != "." && name != ".." {
                names.push(name.to_owned());
            }
        }
        names.sort();
        Ok(names)
    }

    pub fn sync(&self) -> Result<(), StoreError> {
        self.file
            .sync_all()
            .map_err(|error| StoreError::io("sync_directory", &self.path, error))
    }
}

pub(crate) struct Temporary<'a> {
    directory: &'a Directory,
    name: String,
    present: bool,
    identity: std::fs::Metadata,
}

impl Temporary<'_> {
    fn verified_source(&self) -> Result<(CString, File), StoreError> {
        let source_file = self.directory.open(&self.name, false)?;
        let identity = source_file.metadata().map_err(|error| {
            StoreError::io("stat", &self.directory.path.join(&self.name), error)
        })?;
        if identity.dev() != self.identity.dev() || identity.ino() != self.identity.ino() {
            return Err(StoreError::UnsafePath {
                path: self.directory.path.join(&self.name),
            });
        }
        Ok((
            c_name(self.name.as_bytes(), &self.directory.path)?,
            source_file,
        ))
    }

    /// Atomically publish first creation without replacing any existing entry.
    pub fn create(mut self, target: &str) -> Result<(), StoreError> {
        let (source, _source_file) = self.verified_source()?;
        let destination = c_name(target.as_bytes(), &self.directory.path)?;
        // SAFETY: both single-component names are anchored to our live directory;
        // flags=0 links the verified source itself and never follows a symlink.
        let result = unsafe {
            libc::linkat(
                self.directory.file.as_raw_fd(),
                source.as_ptr(),
                self.directory.file.as_raw_fd(),
                destination.as_ptr(),
                0,
            )
        };
        if result == -1 {
            let error = io::Error::last_os_error();
            return Err(if error.kind() == io::ErrorKind::AlreadyExists {
                StoreError::AlreadyExists
            } else {
                StoreError::io("create", &self.directory.path.join(target), error)
            });
        }
        // Live is now published. Removing the temporary name leaves one private
        // authoritative file; any failure after publication is uncertain.
        // SAFETY: this is the exclusive temporary entry linked immediately above.
        if unsafe { libc::unlinkat(self.directory.file.as_raw_fd(), source.as_ptr(), 0) } == -1 {
            return Err(StoreError::CommitUncertain { operation_id: None });
        }
        self.present = false;
        Ok(())
    }

    pub fn replace(mut self, target: &str) -> Result<(), StoreError> {
        let (source, _source_file) = self.verified_source()?;
        self.directory.verify_target(target)?;
        let destination = c_name(target.as_bytes(), &self.directory.path)?;
        // SAFETY: both names belong to this live parent descriptor.
        os_result(
            unsafe {
                libc::renameat(
                    self.directory.file.as_raw_fd(),
                    source.as_ptr(),
                    self.directory.file.as_raw_fd(),
                    destination.as_ptr(),
                )
            },
            "rename",
            &self.directory.path.join(target),
        )?;
        self.present = false;
        Ok(())
    }
}

impl Drop for Temporary<'_> {
    fn drop(&mut self) {
        if self.present {
            if let Ok(name) = CString::new(self.name.as_bytes()) {
                // SAFETY: this unlinks only this object's exclusive temporary entry.
                unsafe {
                    libc::unlinkat(self.directory.file.as_raw_fd(), name.as_ptr(), 0);
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
unsafe fn errno() -> *mut libc::c_int {
    unsafe { libc::__error() }
}
#[cfg(not(target_os = "macos"))]
unsafe fn errno() -> *mut libc::c_int {
    unsafe { libc::__errno_location() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn first_publication_preserves_a_restore_that_appeared_after_absence_check() {
        let root = tempfile::tempdir().unwrap();
        let directory = Directory::root(root.path()).unwrap();
        assert!(!directory.verify_target("live").unwrap());
        let candidate = directory.temp("live", b"new session").unwrap();
        let temporary_path = root.path().join(&candidate.name);
        // An ordinary restore publishes between create's initial absence check
        // and the candidate publication, without using the store lock.
        directory
            .temp("restore", b"restored session bytes")
            .unwrap()
            .replace("live")
            .unwrap();
        assert!(matches!(
            candidate.create("live"),
            Err(StoreError::AlreadyExists)
        ));
        assert_eq!(directory.read("live").unwrap(), b"restored session bytes");
        assert!(!temporary_path.exists());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn first_publication_unlinks_temporary_name_and_preserves_private_file_identity() {
        let root = tempfile::tempdir().unwrap();
        let directory = Directory::root(root.path()).unwrap();
        let candidate = directory.temp("live", b"first session").unwrap();
        let inode = candidate.identity.ino();
        let temporary_path = root.path().join(&candidate.name);
        candidate.create("live").unwrap();
        directory.sync().unwrap();
        assert_eq!(directory.read("live").unwrap(), b"first session");
        let metadata = std::fs::metadata(root.path().join("live")).unwrap();
        assert_eq!(metadata.ino(), inode);
        assert_eq!(metadata.nlink(), 1);
        assert_eq!(metadata.mode() & 0o777, 0o600);
        assert!(!temporary_path.exists());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn substituted_exclusive_temporary_entry_is_rejected_before_rename() {
        for symlink_source in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let directory = Directory::root(root.path()).unwrap();
            directory
                .temp("live", b"previous")
                .unwrap()
                .replace("live")
                .unwrap();
            let temporary = directory.temp("live", b"candidate").unwrap();
            let path = root.path().join(&temporary.name);
            let original = root.path().join("detached-original");
            std::fs::rename(&path, &original).unwrap();
            if symlink_source {
                symlink(&original, &path).unwrap();
            } else {
                directory
                    .temp("replacement", b"substitute")
                    .unwrap()
                    .replace(&temporary.name)
                    .unwrap();
            }
            assert!(temporary.replace("live").is_err());
            assert_eq!(directory.read("live").unwrap(), b"previous");
            assert_eq!(std::fs::read(original).unwrap(), b"candidate");
            assert!(!path.exists());
        }
    }
}
