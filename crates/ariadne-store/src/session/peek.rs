//! Lock-free reads of the committed session file, for frequent pollers.
//!
//! Design (see ADR-0101):
//! - Every session write publishes a complete, synced temp file by rename
//!   (`commit`, `create`). Nothing writes a session file in place. So one
//!   `open` of `sessions/<id>.json` sees exactly one committed version: the
//!   latest one at the instant of the open. A writer committing later is simply
//!   ordered after this read; a writer that is mid-commit is ordered after it
//!   too. No lock is needed to get a whole, committed snapshot.
//! - A committed inode never changes. The cache keys each session file by its
//!   `(dev, ino)` and keeps that file open, so the inode cannot be freed and its
//!   number cannot be reused while it is cached. Equal identity therefore means
//!   the very same bytes: the cache re-parses only when a commit replaced the
//!   file, and a one-second poll of an unchanged session costs one open+fstat.
//! - The snapshot is decoded and fully validated before it is cached, exactly
//!   like a locked read. Any failure returns the error; callers fall back to
//!   their ordinary locked path, which reports it as before.
//! - This is read-only and adds no file, field or saved format. A caller that
//!   decides to write must still take the session lock and decide again on the
//!   locked reread: a peek is never the basis of a write.
use super::*;
use std::collections::HashMap;
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::sync::{Arc, Mutex, OnceLock};

/// Sessions kept parsed at once; the desktop polls only connected sessions.
const CAPACITY: usize = 32;

struct Cached {
    /// Held open so the inode, and so its identity, stays unique while cached.
    _file: std::fs::File,
    dev: u64,
    ino: u64,
    session: Arc<Session>,
}

type Key = (PathBuf, UuidV4);
static CACHE: OnceLock<Mutex<HashMap<Key, Cached>>> = OnceLock::new();

impl Store {
    /// The latest committed snapshot, validated, without taking the session
    /// lock. Read-only: never decide a write on it (see the module design).
    pub fn peek(&self, session_id: &UuidV4) -> Result<Arc<Session>, StoreError> {
        let name = format!("{}.json", session_id.as_str());
        let path = self.sessions.path.join(&name);
        let mut file = self.open_committed(&name)?;
        let stat = file
            .metadata()
            .map_err(|error| StoreError::io("stat", &path, error))?;
        let (dev, ino) = (stat.dev(), stat.ino());
        let key = (path.clone(), self.project_id.clone());
        let cache = CACHE.get_or_init(Mutex::default);
        if let Some(session) = cache
            .lock()
            .map_err(|_| StoreError::LockPoisoned)?
            .get(&key)
            .filter(|cached| cached.dev == dev && cached.ino == ino)
            .map(|cached| cached.session.clone())
        {
            return Ok(session);
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|error| StoreError::io("read", &path, error))?;
        let session = Arc::new(Self::decode_diagnostic_snapshot(
            &bytes,
            session_id,
            &self.project_id,
        )?);
        let mut cached = cache.lock().map_err(|_| StoreError::LockPoisoned)?;
        if cached.len() >= CAPACITY && !cached.contains_key(&key) {
            if let Some(evict) = cached.keys().next().cloned() {
                cached.remove(&evict);
            }
        }
        cached.insert(
            key,
            Cached {
                _file: file,
                dev,
                ino,
                session: session.clone(),
            },
        );
        Ok(session)
    }

    /// The safe open checks a single link. A commit renaming over the file just
    /// after our open leaves the opened inode with no link, which that check
    /// rejects; opening again reaches the newer committed file.
    fn open_committed(&self, name: &str) -> Result<std::fs::File, StoreError> {
        let mut tries = 0;
        loop {
            match self.sessions.open(name, false) {
                Err(StoreError::UnsafePath { .. }) if tries < 3 => tries += 1,
                opened => return opened,
            }
        }
    }
}
