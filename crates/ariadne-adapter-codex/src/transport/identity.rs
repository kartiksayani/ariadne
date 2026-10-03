use super::error;
use ariadne_agent_protocol::{AdapterError, AdapterErrorCode as Code, EndpointFingerprint};
use std::{
    fs,
    io::{ErrorKind, Read},
    os::unix::ffi::OsStrExt,
    os::unix::{
        fs::{FileTypeExt, MetadataExt},
        io::{AsRawFd, FromRawFd, OwnedFd},
        net::UnixStream,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct SocketIdentity {
    pub path: PathBuf,
    device: u64,
    inode: u64,
    uid: u32,
}
impl SocketIdentity {
    pub fn read(path: &Path) -> Result<Self, AdapterError> {
        let path = fs::canonicalize(path).map_err(|_| {
            error(
                Code::HostUnreachable,
                "Codex socket is unavailable; open the existing Codex host.",
            )
        })?;
        let metadata = fs::metadata(&path)
            .map_err(|_| error(Code::HostUnreachable, "Cannot inspect Codex socket."))?;
        // SAFETY: geteuid takes no arguments and does not access Rust memory.
        let current_uid = unsafe { libc::geteuid() };
        if !metadata.file_type().is_socket() || metadata.uid() != current_uid {
            return Err(error(
                Code::PermissionDenied,
                "Codex endpoint must be a Unix socket owned by the current user.",
            ));
        }
        Ok(Self {
            path,
            device: metadata.dev(),
            inode: metadata.ino(),
            uid: metadata.uid(),
        })
    }
    pub fn connect(&self, deadline: Instant) -> Result<UnixStream, AdapterError> {
        // SAFETY: socket returns a fresh owned fd or -1; no pointers are passed.
        let raw_fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
        if raw_fd < 0 {
            return Err(error(
                Code::HostUnreachable,
                "Cannot create Codex observer socket.",
            ));
        }
        // SAFETY: raw_fd is newly owned and valid; OwnedFd closes it on every error path.
        let fd = unsafe { OwnedFd::from_raw_fd(raw_fd) };
        let stream = UnixStream::from(fd);
        stream
            .set_nonblocking(true)
            .map_err(|_| error(Code::HostUnreachable, "Cannot bound Codex socket connect."))?;
        // SAFETY: all-zero sockaddr_un is valid before setting family/path.
        let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        address.sun_family = libc::AF_UNIX as libc::sa_family_t;
        let bytes = self.path.as_os_str().as_bytes();
        if bytes.len() >= address.sun_path.len() {
            return Err(error(
                Code::InvalidArgument,
                "Resolved Codex socket path is too long; use a shorter CODEX_HOME endpoint.",
            ));
        }
        for (destination, byte) in address.sun_path.iter_mut().zip(bytes) {
            *destination = *byte as libc::c_char;
        }
        let length = (std::mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1)
            as libc::socklen_t;
        #[cfg(any(target_os = "macos", target_os = "freebsd"))]
        {
            address.sun_len = length as u8;
        }
        // SAFETY: address has the exact Unix sockaddr layout and length, fd is live.
        let connected = unsafe {
            libc::connect(
                stream.as_raw_fd(),
                (&address as *const libc::sockaddr_un).cast(),
                length,
            )
        };
        if connected != 0 {
            let pending = std::io::Error::last_os_error().raw_os_error();
            if !matches!(pending, Some(libc::EINPROGRESS) | Some(libc::EAGAIN)) {
                return Err(error(
                    Code::HostUnreachable,
                    "Existing Codex daemon socket is unavailable.",
                ));
            }
            let mut descriptor = libc::pollfd {
                fd: stream.as_raw_fd(),
                events: libc::POLLOUT,
                revents: 0,
            };
            loop {
                let remaining =
                    deadline
                        .checked_duration_since(Instant::now())
                        .ok_or_else(|| {
                            error(Code::HostUnreachable, "Codex socket connect timed out.")
                        })?;
                let timeout = remaining.as_millis().max(1).min(i32::MAX as u128) as i32;
                // SAFETY: one valid writable pollfd with a live socket fd.
                let ready = unsafe { libc::poll(&mut descriptor, 1, timeout) };
                if ready > 0 {
                    break;
                }
                if ready < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR)
                {
                    continue;
                }
                return Err(error(
                    Code::HostUnreachable,
                    "Codex socket connect timed out or failed.",
                ));
            }
            if stream
                .take_error()
                .map_err(|_| error(Code::HostUnreachable, "Cannot verify Codex socket connect."))?
                .is_some()
            {
                return Err(error(
                    Code::HostUnreachable,
                    "Existing Codex daemon socket is unavailable.",
                ));
            }
        }
        stream.set_nonblocking(false).map_err(|_| {
            error(
                Code::HostUnreachable,
                "Cannot configure Codex observer socket.",
            )
        })?;
        Ok(stream)
    }
    pub fn fingerprint(&self) -> EndpointFingerprint {
        // Paths are deliberately not printed; inode/device/uid establish local endpoint identity.
        EndpointFingerprint(format!(
            "codex-unix:{}:{}:{}",
            self.device, self.inode, self.uid
        ))
    }
    pub fn verify_peer(&self, stream: &UnixStream) -> Result<(), AdapterError> {
        #[cfg(any(target_os = "macos", target_os = "freebsd"))]
        let peer_uid = {
            let mut uid = 0;
            let mut gid = 0;
            // SAFETY: live socket fd and valid writable uid/gid pointers.
            if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
                return Err(error(
                    Code::PermissionDenied,
                    "Cannot verify Codex peer ownership.",
                ));
            }
            uid
        };
        #[cfg(target_os = "linux")]
        let peer_uid = {
            let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
            let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
            // SAFETY: live fd and correctly sized writable ucred and length pointers.
            if unsafe {
                libc::getsockopt(
                    stream.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_PEERCRED,
                    (&mut credentials as *mut libc::ucred).cast(),
                    &mut length,
                )
            } != 0
            {
                return Err(error(
                    Code::PermissionDenied,
                    "Cannot verify Codex peer ownership.",
                ));
            }
            credentials.uid
        };
        #[cfg(not(any(target_os = "macos", target_os = "freebsd", target_os = "linux")))]
        return Err(error(
            Code::Unsupported,
            "Codex peer verification is unavailable on this platform.",
        ));
        #[cfg(any(target_os = "macos", target_os = "freebsd", target_os = "linux"))]
        if peer_uid != self.uid {
            return Err(error(
                Code::PermissionDenied,
                "Codex peer is owned by another user.",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ExecutableIdentity {
    path: PathBuf,
    device: u64,
    inode: u64,
    modified_seconds: i64,
    modified_nanos: i64,
    length: u64,
}
impl ExecutableIdentity {
    pub fn read(path: &Path) -> Result<Self, AdapterError> {
        let path = fs::canonicalize(path).map_err(|_| {
            error(
                Code::UnsupportedHostVersion,
                "Configured Codex executable is unavailable.",
            )
        })?;
        let m = fs::metadata(&path).map_err(|_| {
            error(
                Code::UnsupportedHostVersion,
                "Cannot inspect Codex executable.",
            )
        })?;
        if !m.is_file() || m.mode() & 0o111 == 0 {
            return Err(error(
                Code::UnsupportedHostVersion,
                "Configured Codex path is not executable.",
            ));
        }
        Ok(Self {
            path,
            device: m.dev(),
            inode: m.ino(),
            modified_seconds: m.mtime(),
            modified_nanos: m.mtime_nsec(),
            length: m.len(),
        })
    }
    pub fn unchanged(&self) -> bool {
        Self::read(&self.path).is_ok_and(|identity| identity == *self)
    }
    pub fn version(&self) -> Result<(), AdapterError> {
        let mut child = Command::new(&self.path)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| {
                error(
                    Code::UnsupportedHostVersion,
                    "Cannot run Codex version probe.",
                )
            })?;
        let result = (|| {
            let mut stdout = child.stdout.take().ok_or_else(|| {
                error(
                    Code::UnsupportedHostVersion,
                    "Codex version output is unavailable.",
                )
            })?;
            // SAFETY: F_GETFL/F_SETFL operate on this owned, live pipe fd.
            let flags = unsafe { libc::fcntl(stdout.as_raw_fd(), libc::F_GETFL) };
            if flags < 0
                || unsafe {
                    libc::fcntl(stdout.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK)
                } < 0
            {
                return Err(error(
                    Code::UnsupportedHostVersion,
                    "Cannot bound Codex version probe.",
                ));
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut bytes = Vec::new();
            let mut buffer = [0; 1024];
            let mut status = None;
            let mut eof = false;
            loop {
                match stdout.read(&mut buffer) {
                    Ok(0) => eof = true,
                    Ok(n) => {
                        bytes.extend_from_slice(&buffer[..n]);
                        if bytes.len() > 4096 {
                            return Err(error(
                                Code::UnsupportedHostVersion,
                                "Codex version output exceeds its bound.",
                            ));
                        }
                    }
                    Err(e) if e.kind() == ErrorKind::WouldBlock => {}
                    Err(_) => {
                        return Err(error(
                            Code::UnsupportedHostVersion,
                            "Cannot read Codex version output.",
                        ))
                    }
                }
                if status.is_none() {
                    status = child.try_wait().map_err(|_| {
                        error(
                            Code::UnsupportedHostVersion,
                            "Cannot inspect Codex version probe.",
                        )
                    })?;
                }
                if eof && status.is_some() {
                    break;
                }
                if Instant::now() >= deadline {
                    return Err(error(
                        Code::UnsupportedHostVersion,
                        "Codex version probe timed out.",
                    ));
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            if !status.is_some_and(|s| s.success())
                || bytes != b"codex-cli 0.160.0\n"
                || !self.unchanged()
            {
                return Err(error(
                    Code::UnsupportedHostVersion,
                    "Codex CLI must match the supported 0.160.0 daemon pair.",
                ));
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = child.kill();
        }
        let _ = child.wait();
        result
    }
}
