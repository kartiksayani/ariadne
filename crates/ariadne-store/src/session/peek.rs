//! Lock-free reads of the committed session file, for frequent pollers.
//!
//! Design (see ADR-0101):
//! - Every session write publishes a complete, synced temp file by rename
//!   (`commit`, `create`). Nothing in Ariadne writes a session file in place.
//!   So one `open` of `sessions/<id>.json` sees exactly one committed version:
//!   the latest one at the instant of the open. A writer committing later is
//!   simply ordered after this read; a writer that is mid-commit is ordered
//!   after it too. No lock is needed to get a whole, committed snapshot.
//! - The cache keys each session file by its identity: `(dev, ino)` plus size,
//!   mtime and ctime in nanoseconds, all from the one fstat. It keeps that file
//!   open, so the inode cannot be freed and its number cannot be reused while it
//!   is cached. A commit always changes `(dev, ino)`. A rewrite in place from
//!   outside Ariadne (`cp backup.json sessions/<id>.json` keeps the inode)
//!   changes ctime, and almost always size or mtime too, so it is re-parsed on
//!   the next peek. Equal identity is taken to mean unchanged bytes; only an
//!   outside rewrite within one timestamp tick could defeat it. A one-second
//!   poll of an unchanged session costs one open+fstat.
//! - The snapshot is decoded and fully validated before it is cached, exactly
//!   like a locked read. Any failure returns the error; callers fall back to
//!   their ordinary locked path, which reports it as before.
//! - A removed session releases its entry and its open file: at once when a
//!   peek finds the file gone, and otherwise when a later insert finds the
//!   cached file unlinked. When full, the least recently used entry goes.
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

/// What one fstat says about the file's content; equal means unchanged.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Identity {
    dev: u64,
    ino: u64,
    size: u64,
    mtime_ns: i128,
    ctime_ns: i128,
}

impl Identity {
    fn of(stat: &std::fs::Metadata) -> Self {
        let ns = |secs: i64, nsec: i64| i128::from(secs) * 1_000_000_000 + i128::from(nsec);
        Self {
            dev: stat.dev(),
            ino: stat.ino(),
            size: stat.size(),
            mtime_ns: ns(stat.mtime(), stat.mtime_nsec()),
            ctime_ns: ns(stat.ctime(), stat.ctime_nsec()),
        }
    }
}

struct Cached {
    /// Held open so the inode, and so its identity, stays unique while cached.
    file: std::fs::File,
    identity: Identity,
    session: Arc<Session>,
    /// Recency stamp from `PeekCache::clock`; the smallest is evicted first.
    used: u64,
}

type Key = (PathBuf, UuidV4);

/// Parsed sessions by file, least recently used evicted first.
struct PeekCache {
    capacity: usize,
    clock: u64,
    entries: HashMap<Key, Cached>,
}

impl PeekCache {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            clock: 0,
            entries: HashMap::new(),
        }
    }

    fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    /// The cached parse when the file still has this identity.
    fn get(&mut self, key: &Key, identity: Identity) -> Option<Arc<Session>> {
        let used = self.tick();
        let cached = self
            .entries
            .get_mut(key)
            .filter(|cached| cached.identity == identity)?;
        cached.used = used;
        Some(cached.session.clone())
    }

    fn forget(&mut self, key: &Key) {
        self.entries.remove(key);
    }

    fn insert(&mut self, key: Key, file: std::fs::File, identity: Identity, session: Arc<Session>) {
        // A cached file with no link left belongs to a removed session.
        self.entries
            .retain(|_, cached| cached.file.metadata().is_ok_and(|stat| stat.nlink() > 0));
        if self.entries.len() >= self.capacity && !self.entries.contains_key(&key) {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, cached)| cached.used)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                self.entries.remove(&oldest);
            }
        }
        let used = self.tick();
        self.entries.insert(
            key,
            Cached {
                file,
                identity,
                session,
                used,
            },
        );
    }
}

static CACHE: OnceLock<Mutex<PeekCache>> = OnceLock::new();

fn cache() -> Result<std::sync::MutexGuard<'static, PeekCache>, StoreError> {
    CACHE
        .get_or_init(|| Mutex::new(PeekCache::new(CAPACITY)))
        .lock()
        .map_err(|_| StoreError::LockPoisoned)
}

impl Store {
    /// The latest committed snapshot, validated, without taking the session
    /// lock. Read-only: never decide a write on it (see the module design).
    pub fn peek(&self, session_id: &UuidV4) -> Result<Arc<Session>, StoreError> {
        let name = format!("{}.json", session_id.as_str());
        let path = self.sessions.path.join(&name);
        let key = (path.clone(), self.project_id.clone());
        let mut file = match self.open_committed(&name) {
            Err(
                error @ StoreError::Io {
                    kind: io::ErrorKind::NotFound,
                    ..
                },
            ) => {
                // The session is gone: release its parse and its open file.
                cache()?.forget(&key);
                return Err(error);
            }
            opened => opened?,
        };
        let stat = file
            .metadata()
            .map_err(|error| StoreError::io("stat", &path, error))?;
        let identity = Identity::of(&stat);
        if let Some(session) = cache()?.get(&key, identity) {
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
        cache()?.insert(key, file, identity, session.clone());
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

/// Test view of the shared cache: is this session file's parse held?
#[cfg(test)]
pub(super) fn peek_cached(path: &Path, project_id: &UuidV4) -> bool {
    cache()
        .unwrap()
        .entries
        .contains_key(&(path.to_path_buf(), project_id.clone()))
}

#[cfg(test)]
mod lru_tests {
    use super::*;

    fn entry(dir: &Path, n: u64) -> (Key, std::fs::File, Identity) {
        let path = dir.join(format!("{n}.json"));
        std::fs::write(&path, b"{}").unwrap();
        let file = std::fs::File::open(&path).unwrap();
        let identity = Identity::of(&file.metadata().unwrap());
        let project = UuidV4::new("00000000-0000-4000-8000-000000000001").unwrap();
        ((path, project), file, identity)
    }

    #[test]
    fn a_full_cache_evicts_the_least_recently_used_entry() {
        let dir = tempfile::tempdir().unwrap();
        let session: Arc<Session> = Arc::new(
            serde_json::from_str(include_str!(
                "../../../../fixtures/domain/history/seed.json"
            ))
            .unwrap(),
        );
        let mut cache = PeekCache::new(3);
        let mut keys = Vec::new();
        for n in 0..3 {
            let (key, file, identity) = entry(dir.path(), n);
            cache.insert(key.clone(), file, identity, session.clone());
            keys.push((key, identity));
        }
        // Using the oldest makes the second one the least recently used.
        assert!(cache.get(&keys[0].0, keys[0].1).is_some());
        let (key, file, identity) = entry(dir.path(), 3);
        cache.insert(key.clone(), file, identity, session.clone());
        let held = |cache: &PeekCache, key: &Key| cache.entries.contains_key(key);
        assert!(held(&cache, &keys[0].0), "recently used stays");
        assert!(!held(&cache, &keys[1].0), "least recently used goes");
        assert!(held(&cache, &keys[2].0));
        assert!(held(&cache, &key));
        assert_eq!(cache.entries.len(), 3);

        // A miss on a changed identity does not refresh the entry.
        let mut changed = keys[2].1;
        changed.size += 1;
        assert!(cache.get(&keys[2].0, changed).is_none());
        assert!(cache.get(&keys[0].0, keys[0].1).is_some());
        assert!(cache.get(&key, identity).is_some());
        let (next, file, identity) = entry(dir.path(), 4);
        cache.insert(next.clone(), file, identity, session.clone());
        assert!(!held(&cache, &keys[2].0));
        assert!(held(&cache, &next));
    }

    #[test]
    fn an_insert_drops_cached_files_that_were_unlinked() {
        let dir = tempfile::tempdir().unwrap();
        let session: Arc<Session> = Arc::new(
            serde_json::from_str(include_str!(
                "../../../../fixtures/domain/history/seed.json"
            ))
            .unwrap(),
        );
        let mut cache = PeekCache::new(8);
        let (gone, file, identity) = entry(dir.path(), 0);
        cache.insert(gone.clone(), file, identity, session.clone());
        let (kept, file, identity) = entry(dir.path(), 1);
        cache.insert(kept.clone(), file, identity, session.clone());
        std::fs::remove_file(&gone.0).unwrap();
        let (next, file, identity) = entry(dir.path(), 2);
        cache.insert(next.clone(), file, identity, session);
        assert!(!cache.entries.contains_key(&gone));
        assert!(cache.entries.contains_key(&kept));
        assert!(cache.entries.contains_key(&next));
    }
}
