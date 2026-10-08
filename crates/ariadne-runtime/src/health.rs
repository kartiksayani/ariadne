//! Desktop delivery-supervisor health: what the owner sees ("Not sending: …")
//! and what `ariadne doctor` reads back from `$ARIADNE_HOME/logs/`.
//!
//! Only push-delivery bindings (Codex) publish health. Pull-delivery bindings
//! (Claude Code, delivered by its Mod) never publish an entry, so the UI never
//! claims "Not sending" for them.
use ariadne_core::{BarrierReason, CoreError, CoreErrorCode};
use ariadne_domain::models::{UtcMillis, UuidV4};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime},
};

pub const HEALTH_FILE: &str = "supervisor-health.json";
/// The desktop rewrites the health file at least this often while it runs.
pub const HEARTBEAT: Duration = Duration::from_secs(15);
/// A health file older than this means the desktop is not running.
pub const STALE_AFTER: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SupervisorState {
    Running,
    BackingOff,
    Stopped,
}

/// Renderer contract: event `ariadne://supervisor_health`, command `supervisor_health`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SupervisorHealth {
    pub binding_id: UuidV4,
    pub generation: UuidV4,
    pub state: SupervisorState,
    /// Plain owner-facing words; `None` while running.
    pub reason: Option<String>,
    /// Only while backing off.
    pub retry_in_seconds: Option<u64>,
    pub updated_at: UtcMillis,
}
impl SupervisorHealth {
    pub fn running(binding_id: UuidV4, generation: UuidV4, at: UtcMillis) -> Self {
        Self {
            binding_id,
            generation,
            state: SupervisorState::Running,
            reason: None,
            retry_in_seconds: None,
            updated_at: at,
        }
    }
    pub fn backing_off(
        binding_id: UuidV4,
        generation: UuidV4,
        reason: String,
        retry: Duration,
        at: UtcMillis,
    ) -> Self {
        Self {
            binding_id,
            generation,
            state: SupervisorState::BackingOff,
            reason: Some(reason),
            retry_in_seconds: Some(retry.as_secs().max(1)),
            updated_at: at,
        }
    }
    pub fn stopped(binding_id: UuidV4, generation: UuidV4, reason: String, at: UtcMillis) -> Self {
        Self {
            binding_id,
            generation,
            state: SupervisorState::Stopped,
            reason: Some(reason),
            retry_in_seconds: None,
            updated_at: at,
        }
    }
    /// Same state and words, ignoring the timestamp.
    pub fn same_as(&self, other: &Self) -> bool {
        self.binding_id == other.binding_id
            && self.generation == other.generation
            && self.state == other.state
            && self.reason == other.reason
            && self.retry_in_seconds == other.retry_in_seconds
    }
}
pub type HealthObserver = dyn Fn(SupervisorHealth) + Send + Sync;

/// Owner-facing words for why the desktop is not sending. No IDs or jargon.
pub fn plain_reason(error: &CoreError) -> String {
    let message = error.message.to_ascii_lowercase();
    let reason = error.details.as_ref().and_then(|details| details.reason);
    if message.contains("thread is unavailable")
        || message.contains("thread is not available")
        || message.contains("not loaded")
    {
        return "Codex isn't sharing this conversation with Ariadne. Quit Codex in its terminal and start it again with the --remote option, then reopen this conversation.".into();
    }
    if reason == Some(BarrierReason::Disconnected) {
        return "Codex was disconnected. Reconnect it to send again.".into();
    }
    match error.code {
        CoreErrorCode::StaleGeneration
        | CoreErrorCode::BindingMismatch
        | CoreErrorCode::BindingConflict
        | CoreErrorCode::BindingAmbiguous => {
            "This connection was replaced. Reconnect to send again.".into()
        }
        CoreErrorCode::NotFound => "This session is no longer available.".into(),
        CoreErrorCode::UnsupportedHostVersion | CoreErrorCode::IncompatibleAdapter => {
            "This Codex version doesn't work with Ariadne. Update Codex.".into()
        }
        CoreErrorCode::StoreBusy | CoreErrorCode::IoError | CoreErrorCode::CommitUncertain => {
            "Ariadne couldn't save to its data folder. It will keep trying.".into()
        }
        CoreErrorCode::CorruptSession | CoreErrorCode::FutureSchema => {
            "Ariadne can't read this session's saved data.".into()
        }
        CoreErrorCode::PermissionDenied => "Ariadne isn't allowed to read its data folder.".into(),
        CoreErrorCode::ProtocolConflict => {
            "Codex answered in a way Ariadne didn't expect. It will check again.".into()
        }
        CoreErrorCode::SnapshotChanged | CoreErrorCode::RevisionConflict => {
            "The session changed while Ariadne was checking it. It will check again.".into()
        }
        _ => "Ariadne can't reach Codex right now.".into(),
    }
}

/// On-disk mirror for `ariadne doctor`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HealthFile {
    pub pid: u32,
    pub written_at: UtcMillis,
    pub bindings: Vec<SupervisorHealth>,
}

/// Latest health per binding, mirrored to disk on every change and heartbeat.
pub struct HealthBoard {
    entries: Mutex<BTreeMap<UuidV4, SupervisorHealth>>,
    file: Option<PathBuf>,
    /// One mirror write at a time: writers share one temp file, and the last
    /// rename must carry the newest board.
    writing: Mutex<()>,
}
impl HealthBoard {
    /// `home` is `$ARIADNE_HOME`; `None` keeps the board in memory only.
    pub fn new(home: Option<&Path>) -> Self {
        Self {
            entries: Mutex::new(BTreeMap::new()),
            file: home.map(|home| crate::logging::logs_dir(home).join(HEALTH_FILE)),
            writing: Mutex::new(()),
        }
    }
    /// Returns whether the entry changed state, words or generation.
    pub fn publish(&self, health: SupervisorHealth) -> bool {
        let changed = {
            let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            let changed = entries
                .get(&health.binding_id)
                .is_none_or(|prior| !prior.same_as(&health));
            entries.insert(health.binding_id.clone(), health);
            changed
        };
        if changed {
            self.heartbeat();
        }
        changed
    }
    /// Drops the entry of a supervisor that ended without a fault (disconnect,
    /// wake, quit). A newer generation's entry is never removed.
    pub fn forget(&self, binding_id: &UuidV4, generation: &UuidV4) -> bool {
        let removed = {
            let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            let current = entries
                .get(binding_id)
                .is_some_and(|entry| &entry.generation == generation);
            if current {
                entries.remove(binding_id);
            }
            current
        };
        if removed {
            self.heartbeat();
        }
        removed
    }
    pub fn snapshot(&self) -> Vec<SupervisorHealth> {
        self.entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .cloned()
            .collect()
    }
    /// Best-effort atomic rewrite of the health file.
    pub fn heartbeat(&self) {
        let Some(path) = &self.file else {
            return;
        };
        let _writing = self.writing.lock().unwrap_or_else(|p| p.into_inner());
        let Ok(written_at) = UtcMillis::new(crate::logging::utc(SystemTime::now())) else {
            return;
        };
        let file = HealthFile {
            pid: std::process::id(),
            written_at,
            bindings: self.snapshot(),
        };
        let _ = write_private(path, &file);
    }
}
fn write_private(path: &Path, file: &HealthFile) -> std::io::Result<()> {
    let directory = path
        .parent()
        .ok_or_else(|| std::io::Error::other("no parent"))?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)?;
    let temporary = directory.join(format!(".{HEALTH_FILE}.{}.tmp", std::process::id()));
    let mut out = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)?;
    // A heartbeat, not a durable record: no fsync on the 1-second timer path.
    out.write_all(&serde_json::to_vec(file).map_err(std::io::Error::other)?)?;
    fs::rename(&temporary, path)
}

#[derive(Debug, PartialEq)]
pub enum HealthRead {
    Missing,
    Unreadable,
    Present(HealthFile),
}
/// Reads the desktop's mirror under `$home/logs`; never creates anything.
pub fn read_health_file(home: &Path) -> HealthRead {
    let path = crate::logging::logs_dir(home).join(HEALTH_FILE);
    match fs::metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return HealthRead::Missing,
        Err(_) => return HealthRead::Unreadable,
        Ok(metadata) if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 => {
            return HealthRead::Unreadable
        }
        Ok(_) => {}
    }
    fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .map_or(HealthRead::Unreadable, HealthRead::Present)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ariadne_core::ErrorDetails;
    use std::os::unix::fs::PermissionsExt;

    fn id(n: u8) -> UuidV4 {
        UuidV4::new(format!("00000000-0000-4000-8000-0000000000{n:02}")).unwrap()
    }
    fn at() -> UtcMillis {
        UtcMillis::new("2026-10-07T18:41:00.000Z").unwrap()
    }

    #[test]
    fn wire_shape_matches_the_renderer_contract() {
        let health = SupervisorHealth::backing_off(
            id(1),
            id(2),
            "Ariadne can't reach Codex right now.".into(),
            Duration::from_secs(4),
            at(),
        );
        assert_eq!(
            serde_json::to_value(&health).unwrap(),
            serde_json::json!({
                "binding_id": id(1).as_str(), "generation": id(2).as_str(),
                "state": "backing_off", "reason": "Ariadne can't reach Codex right now.",
                "retry_in_seconds": 4, "updated_at": "2026-10-07T18:41:00.000Z"
            })
        );
        let running = serde_json::to_value(SupervisorHealth::running(id(1), id(2), at())).unwrap();
        assert_eq!(running["state"], "running");
        assert!(running["reason"].is_null() && running["retry_in_seconds"].is_null());
        let stopped =
            serde_json::to_value(SupervisorHealth::stopped(id(1), id(2), "x".into(), at()))
                .unwrap();
        assert_eq!(stopped["state"], "stopped");
    }

    #[test]
    fn reasons_are_plain_words_without_ids_or_internal_state_names() {
        let not_loaded = CoreError::new(
            CoreErrorCode::HostUnreachable,
            "Selected Codex thread is unavailable; sender was not spawned.",
            "",
        );
        assert!(plain_reason(&not_loaded).contains("--remote"));
        let mut disconnected = CoreError::new(
            CoreErrorCode::HostUnreachable,
            "Claim requires a verified connected binding",
            "",
        );
        disconnected.details = Some(Box::new(ErrorDetails {
            reason: Some(BarrierReason::Disconnected),
            binding_id: Some(id(1)),
            input_id: None,
            attempt_id: None,
            blocking_item_ids: vec![],
            blocking_input_ids: vec![],
            dispatch_must_pause: true,
            partial_removal: None,
        }));
        assert_eq!(
            plain_reason(&disconnected),
            "Codex was disconnected. Reconnect it to send again."
        );
        for code in [
            CoreErrorCode::HostUnreachable,
            CoreErrorCode::StaleGeneration,
            CoreErrorCode::ProtocolConflict,
            CoreErrorCode::IoError,
            CoreErrorCode::CorruptSession,
        ] {
            let text = plain_reason(&CoreError::new(code, "binding 00000000 generation", ""));
            for jargon in [
                "binding",
                "generation",
                "needs_attention",
                "reconcil",
                "0000",
            ] {
                assert!(!text.to_lowercase().contains(jargon), "{text}");
            }
        }
    }

    #[test]
    fn board_publishes_changes_and_mirrors_them_for_doctor() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(read_health_file(home.path()), HealthRead::Missing);
        let board = HealthBoard::new(Some(home.path()));
        assert!(board.publish(SupervisorHealth::running(id(1), id(2), at())));
        let later = UtcMillis::new("2026-10-07T18:42:00.000Z").unwrap();
        assert!(!board.publish(SupervisorHealth::running(id(1), id(2), later)));
        assert!(board.publish(SupervisorHealth::stopped(id(1), id(2), "x".into(), at())));
        assert!(board.publish(SupervisorHealth::running(id(3), id(4), at())));
        let HealthRead::Present(file) = read_health_file(home.path()) else {
            panic!("health file");
        };
        assert_eq!(file.pid, std::process::id());
        assert_eq!(file.bindings, board.snapshot());
        assert_eq!(file.bindings.len(), 2);
        assert_eq!(file.bindings[0].state, SupervisorState::Stopped);
        fs::write(home.path().join("logs").join(HEALTH_FILE), b"{").unwrap();
        assert_eq!(read_health_file(home.path()), HealthRead::Unreadable);
    }

    #[test]
    fn concurrent_publishes_and_heartbeats_never_corrupt_the_mirror() {
        let home = tempfile::tempdir().unwrap();
        let board = HealthBoard::new(Some(home.path()));
        board.publish(SupervisorHealth::running(id(1), id(2), at()));
        let stop = std::sync::atomic::AtomicBool::new(false);
        let torn = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    if read_health_file(home.path()) == HealthRead::Unreadable {
                        torn.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                }
            });
            let writers: Vec<_> = (0..4u8)
                .map(|writer| {
                    let board = &board;
                    scope.spawn(move || {
                        for round in 0..200usize {
                            // Entries of very different sizes make a torn write visible.
                            let reason = "x".repeat(if round % 2 == 0 { 4000 } else { 1 });
                            board.publish(SupervisorHealth::stopped(
                                id(10 + writer),
                                id(2),
                                format!("{reason}{round}"),
                                at(),
                            ));
                            board.heartbeat();
                        }
                    })
                })
                .collect();
            for writer in writers {
                writer.join().unwrap();
            }
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
        });
        assert_eq!(torn.load(std::sync::atomic::Ordering::Relaxed), 0);
        let HealthRead::Present(file) = read_health_file(home.path()) else {
            panic!("health file");
        };
        // The last write carries the latest board, and no temp file is left.
        assert_eq!(file.bindings, board.snapshot());
        let names: Vec<_> = fs::read_dir(home.path().join("logs"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, [HEALTH_FILE]);
    }

    #[test]
    fn forget_removes_only_the_exact_generation_and_updates_the_mirror() {
        let home = tempfile::tempdir().unwrap();
        let board = HealthBoard::new(Some(home.path()));
        board.publish(SupervisorHealth::running(id(1), id(5), at()));
        // A late clean stop of the replaced generation keeps the newer entry.
        assert!(!board.forget(&id(1), &id(2)));
        assert_eq!(board.snapshot().len(), 1);
        assert!(board.forget(&id(1), &id(5)));
        assert!(board.snapshot().is_empty());
        let HealthRead::Present(file) = read_health_file(home.path()) else {
            panic!("health file");
        };
        assert!(file.bindings.is_empty());
        let mode = fs::metadata(home.path().join("logs").join(HEALTH_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
