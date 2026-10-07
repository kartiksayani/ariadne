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

pub struct Directory {
    file: File,
    pub path: PathBuf,
}

fn component(value: &str, path: &Path) -> Result<(), StoreError> {
    if value.is_empty() || matches!(value, "." | "..") || value.contains(['/', '\\', '\0']) {
        return Err(StoreError::UnsafePath { path: path.into() });
    }
    Ok(())
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

fn open_created(create: bool, mut open: impl FnMut() -> libc::c_int) -> libc::c_int {
    let fd = open();
    // Concurrent first creation can return ENOENT on macOS even while the
    // anchored directory is live. Retry that create once with identical flags.
    if create && fd == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
        open()
    } else {
        fd
    }
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

    /// Open an existing directory whose final component must not be a link: the
    /// parent is canonicalized, the last name is opened relative to it with
    /// `O_NOFOLLOW`. Used for a project's store directory under the data root.
    pub fn existing(path: &Path) -> Result<Self, StoreError> {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| StoreError::UnsafePath { path: path.into() })?;
        let parent = path
            .parent()
            .ok_or_else(|| StoreError::UnsafePath { path: path.into() })?;
        Self::root(parent)?.child(name, false)
    }

    pub fn child(&self, name: &str, create: bool) -> Result<Self, StoreError> {
        let path = self.path.join(name);
        component(name, &path)?;
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

    pub(crate) fn open(&self, name: &str, create: bool) -> Result<File, StoreError> {
        let path = self.path.join(name);
        component(name, &path)?;
        let name = c_name(name.as_bytes(), &path)?;
        let flags = libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | libc::O_NONBLOCK
            | if create {
                libc::O_RDWR | libc::O_CREAT
            } else {
                libc::O_RDONLY
            };
        let fd = open_created(create, || {
            // SAFETY: parent descriptor is live; name is a generated single component.
            unsafe { libc::openat(self.file.as_raw_fd(), name.as_ptr(), flags, 0o600) }
        });
        checked_file(fd, &path, false, true)
    }

    pub(crate) fn read(&self, name: &str) -> Result<Vec<u8>, StoreError> {
        let mut file = self.open(name, false)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|error| StoreError::io("read", &self.path.join(name), error))?;
        Ok(bytes)
    }

    /// Limit applies to the stream, including growth after opening.
    pub fn read_bounded(&self, name: &str, maximum: usize) -> Result<Vec<u8>, StoreError> {
        let file = self.diagnostic_open(name)?;
        let mut bytes = Vec::new();
        file.take(maximum.saturating_add(1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| StoreError::io("read", &self.path.join(name), e))?;
        if bytes.len() > maximum {
            return Err(StoreError::InvalidSnapshot);
        }
        Ok(bytes)
    }

    fn diagnostic_open(&self, name: &str) -> Result<File, StoreError> {
        match self.open(name, false) {
            Ok(file) => Ok(file),
            Err(original) => {
                component(name, &self.path.join(name))?;
                let c = c_name(name.as_bytes(), &self.path.join(name))?;
                let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
                // SAFETY: live anchored directory, checked name and writable stat.
                let result = unsafe {
                    libc::fstatat(
                        self.file.as_raw_fd(),
                        c.as_ptr(),
                        stat.as_mut_ptr(),
                        libc::AT_SYMLINK_NOFOLLOW,
                    )
                };
                if result == 0 {
                    // SAFETY: fstatat succeeded and initialized stat.
                    let stat = unsafe { stat.assume_init() };
                    if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
                        return Err(StoreError::UnsafePath {
                            path: self.path.join(name),
                        });
                    }
                }
                Err(original)
            }
        }
    }

    pub(crate) fn read_diagnostic(&self, name: &str) -> Result<Vec<u8>, StoreError> {
        let mut file = self.diagnostic_open(name)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|e| StoreError::io("read", &self.path.join(name), e))?;
        Ok(bytes)
    }

    /// Existing-only diagnostics use `create=false`; setup uses its owned lock.
    pub fn with_lock<T, E: From<StoreError>>(
        &self,
        name: &str,
        create: bool,
        work: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, E> {
        component(name, &self.path.join(name))?;
        super::lock::with_lock_mode(self, name, create, work)
    }

    /// Call only while holding the owned-resource lock. Changed files survive.
    pub fn remove_if_unchanged(&self, name: &str, expected: &[u8]) -> Result<bool, StoreError> {
        let file = self.diagnostic_open(name)?;
        let before = file
            .metadata()
            .map_err(|e| StoreError::io("stat", &self.path.join(name), e))?;
        let mut actual = Vec::new();
        file.take(expected.len().saturating_add(1) as u64)
            .read_to_end(&mut actual)
            .map_err(|e| StoreError::io("read", &self.path.join(name), e))?;
        if actual != expected {
            return Ok(false);
        }
        let current = self
            .open(name, false)?
            .metadata()
            .map_err(|e| StoreError::io("stat", &self.path.join(name), e))?;
        if before.dev() != current.dev()
            || before.ino() != current.ino()
            || before.len() != current.len()
            || before.mtime() != current.mtime()
            || before.mtime_nsec() != current.mtime_nsec()
            || before.ctime() != current.ctime()
            || before.ctime_nsec() != current.ctime_nsec()
        {
            return Ok(false);
        }
        let path = self.path.join(name);
        let name = c_name(name.as_bytes(), &path)?;
        // SAFETY: checked single-component name is anchored to this live directory.
        os_result(
            unsafe { libc::unlinkat(self.file.as_raw_fd(), name.as_ptr(), 0) },
            "unlink",
            &path,
        )?;
        self.sync()?;
        Ok(true)
    }

    /// File type of one direct entry without following a final symlink.
    fn entry_type(&self, name: &str) -> Result<Option<libc::mode_t>, StoreError> {
        let path = self.path.join(name);
        component(name, &path)?;
        let c = c_name(name.as_bytes(), &path)?;
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: live anchored directory, checked name and writable stat.
        let result = unsafe {
            libc::fstatat(
                self.file.as_raw_fd(),
                c.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result == -1 {
            let error = io::Error::last_os_error();
            return if error.kind() == io::ErrorKind::NotFound {
                Ok(None)
            } else {
                Err(StoreError::io("stat", &path, error))
            };
        }
        // SAFETY: fstatat succeeded and initialized stat.
        Ok(Some(unsafe { stat.assume_init() }.st_mode & libc::S_IFMT))
    }

    /// Unlink one direct non-directory entry (a symlink itself, never its target).
    /// Missing entries are already removed.
    pub fn remove_entry(&self, name: &str) -> Result<(), StoreError> {
        let path = self.path.join(name);
        match self.entry_type(name)? {
            None => Ok(()),
            Some(libc::S_IFDIR) => Err(StoreError::UnsafePath { path }),
            Some(_) => {
                let c = c_name(name.as_bytes(), &path)?;
                // SAFETY: checked single-component name anchored to this live directory.
                os_result(
                    unsafe { libc::unlinkat(self.file.as_raw_fd(), c.as_ptr(), 0) },
                    "unlink",
                    &path,
                )
            }
        }
    }

    /// Remove one private child directory and everything below it. Every step is
    /// anchored to an opened descriptor; symlinks are unlinked, never followed, so
    /// the walk cannot leave this child. Missing children are already removed.
    pub fn remove_tree(&self, name: &str) -> Result<(), StoreError> {
        let path = self.path.join(name);
        match self.entry_type(name)? {
            None => return Ok(()),
            Some(libc::S_IFDIR) => {}
            Some(_) => return Err(StoreError::UnsafePath { path }),
        }
        let child = self.child(name, false)?;
        for entry in child.names()? {
            if child.entry_type(&entry)? == Some(libc::S_IFDIR) {
                child.remove_tree(&entry)?;
            } else {
                child.remove_entry(&entry)?;
            }
        }
        child.sync()?;
        drop(child);
        let c = c_name(name.as_bytes(), &path)?;
        // SAFETY: checked single-component name anchored to this live directory.
        os_result(
            unsafe { libc::unlinkat(self.file.as_raw_fd(), c.as_ptr(), libc::AT_REMOVEDIR) },
            "rmdir",
            &path,
        )?;
        self.sync()
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
        component(stem, &self.path.join(stem))?;
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

pub struct Temporary<'a> {
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
        component(target, &self.directory.path.join(target))?;
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
        component(target, &self.directory.path.join(target))?;
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
    fn only_create_enoent_retries_once_and_preserves_the_second_error() {
        for create in [false, true] {
            for code in [libc::ENOENT, libc::EACCES, libc::ELOOP, libc::EEXIST] {
                let mut calls = 0;
                let fd = open_created(create, || {
                    calls += 1;
                    if calls == 1 {
                        // SAFETY: errno is the calling thread's writable OS error slot.
                        unsafe { *errno() = code };
                        -1
                    } else {
                        17
                    }
                });
                let retry = create && code == libc::ENOENT;
                assert_eq!(calls, if retry { 2 } else { 1 });
                assert_eq!(fd, if retry { 17 } else { -1 });
                if !retry {
                    assert_eq!(io::Error::last_os_error().raw_os_error(), Some(code));
                }
            }
        }
        for second in [libc::ENOENT, libc::EACCES] {
            let mut calls = 0;
            let fd = open_created(true, || {
                calls += 1;
                // SAFETY: errno is the calling thread's writable OS error slot.
                unsafe { *errno() = if calls == 1 { libc::ENOENT } else { second } };
                -1
            });
            assert_eq!(fd, -1);
            assert_eq!(calls, 2);
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(second));
        }
    }

    #[test]
    fn concurrent_first_open_keeps_one_private_regular_file_identity() {
        for _ in 0..32 {
            let root = tempfile::tempdir().unwrap();
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let writers: Vec<_> = (0..2)
                .map(|_| {
                    let path = root.path().to_owned();
                    let barrier = barrier.clone();
                    std::thread::spawn(move || {
                        let directory = Directory::root(&path).unwrap();
                        barrier.wait();
                        directory.open("registry.lock", true).unwrap()
                    })
                })
                .collect();
            // Keep the directory and both successful descriptors alive together.
            let files: Vec<_> = writers
                .into_iter()
                .map(|writer| writer.join().unwrap())
                .collect();
            let metadata: Vec<_> = files.iter().map(|file| file.metadata().unwrap()).collect();
            assert_eq!(metadata[0].ino(), metadata[1].ino());
            for file in metadata {
                assert!(file.is_file());
                assert_eq!(file.mode() & 0o777, 0o600);
                assert_eq!(file.nlink(), 1);
            }
        }
    }

    #[test]
    fn retry_never_follows_a_link_or_reopens_a_replaced_directory_path() {
        let root = tempfile::tempdir().unwrap();
        let directory = Directory::root(root.path())
            .unwrap()
            .child("anchored", true)
            .unwrap();
        assert!(matches!(
            directory.open("missing", false),
            Err(StoreError::Io {
                kind: io::ErrorKind::NotFound,
                ..
            })
        ));
        let target = root.path().join("target");
        std::fs::write(&target, b"preserve").unwrap();
        symlink(&target, directory.path.join("link")).unwrap();
        assert!(directory.open("link", true).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"preserve");
        std::fs::remove_file(directory.path.join("link")).unwrap();
        std::fs::remove_dir(&directory.path).unwrap();
        std::fs::create_dir(&directory.path).unwrap();
        assert!(matches!(
            directory.open("registry.lock", true),
            Err(StoreError::Io {
                kind: io::ErrorKind::NotFound,
                ..
            })
        ));
        assert!(!directory.path.join("registry.lock").exists());
    }

    #[test]
    fn remove_tree_stays_inside_its_child_and_never_follows_links() {
        let root = tempfile::tempdir().unwrap();
        let outside = root.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("keep.txt"), b"keep").unwrap();
        let directory = Directory::root(root.path()).unwrap();
        let store = directory.child("store", true).unwrap();
        let nested = store.child("sessions", true).unwrap();
        nested
            .temp("a.json", b"{}")
            .unwrap()
            .create("a.json")
            .unwrap();
        symlink(&outside, nested.path.join("escape")).unwrap();
        symlink(outside.join("keep.txt"), store.path.join("file-link")).unwrap();
        drop((nested, store));
        directory.remove_tree("store").unwrap();
        assert!(!root.path().join("store").exists());
        assert_eq!(std::fs::read(outside.join("keep.txt")).unwrap(), b"keep");
        // Already removed is success; a file is never treated as a tree.
        directory.remove_tree("store").unwrap();
        std::fs::write(root.path().join("plain"), b"x").unwrap();
        assert!(matches!(
            directory.remove_tree("plain"),
            Err(StoreError::UnsafePath { .. })
        ));
        assert!(matches!(
            directory.remove_tree(".."),
            Err(StoreError::UnsafePath { .. })
        ));
    }

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
