//! Native invalidation only. Authoritative registered Store reads supply every
//! emitted revision; filesystem events never become session data or authority.
use ariadne_core::{SessionChangedHint, SessionRef};
use ariadne_store::registry::Registry;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

mod scan;
const FALLBACK: Duration = Duration::from_secs(2);
const DEBOUNCE: Duration = Duration::from_millis(100);
type Emit = dyn Fn(SessionChangedHint) -> bool + Send + Sync;

/// Created only by trusted Rust startup with the actual registration handle
/// and application data directory. No renderer path or file content is accepted.
pub struct RegisteredWatcher {
    signal: mpsc::SyncSender<()>,
    stop: Arc<AtomicBool>,
    selected: Arc<Mutex<Option<SessionRef>>>,
    worker: Option<JoinHandle<()>>,
}
impl RegisteredWatcher {
    pub fn start(
        registry: Registry,
        data_directory: PathBuf,
        emit: impl Fn(SessionChangedHint) -> bool + Send + Sync + 'static,
    ) -> std::io::Result<Self> {
        Self::start_with_fallback(registry, data_directory, emit, FALLBACK)
    }
    fn start_with_fallback(
        registry: Registry,
        data_directory: PathBuf,
        emit: impl Fn(SessionChangedHint) -> bool + Send + Sync + 'static,
        fallback: Duration,
    ) -> std::io::Result<Self> {
        Self::start_observer(registry, data_directory, emit, fallback, Arc::new(|| {}))
    }
    pub(crate) fn start_with_reconciled(
        registry: Registry,
        data_directory: PathBuf,
        emit: impl Fn(SessionChangedHint) -> bool + Send + Sync + 'static,
        reconciled: Arc<dyn Fn() + Send + Sync>,
    ) -> std::io::Result<Self> {
        Self::start_observer(registry, data_directory, emit, FALLBACK, reconciled)
    }
    fn start_observer(
        registry: Registry,
        data_directory: PathBuf,
        emit: impl Fn(SessionChangedHint) -> bool + Send + Sync + 'static,
        fallback: Duration,
        reconciled: Arc<dyn Fn() + Send + Sync>,
    ) -> std::io::Result<Self> {
        // A one-slot wake channel coalesces storms without retaining file events.
        let (signal, wake) = mpsc::sync_channel(1);
        let (ready, installed) = mpsc::sync_channel(1);
        let stop = Arc::new(AtomicBool::new(false));
        let selected = Arc::new(Mutex::new(None));
        let thread_stop = stop.clone();
        let thread_selected = selected.clone();
        let callback_signal = signal.clone();
        let worker = thread::Builder::new()
            .name("ariadne-registered-watch".into())
            .spawn(move || {
                work(
                    registry,
                    data_directory,
                    Arc::new(emit),
                    callback_signal,
                    wake,
                    thread_stop,
                    thread_selected,
                    fallback,
                    ready,
                    reconciled,
                );
            })?;
        // Startup runs before the Tauri event loop. Wait for the initial watch
        // attempts so no native command can load before parent subscription.
        installed
            .recv()
            .map_err(|_| std::io::Error::other("Registered watcher startup failed"))?;
        Ok(Self {
            signal,
            stop,
            selected,
            worker: Some(worker),
        })
    }
    /// Focus/wake and trusted command completion can request reconciliation.
    /// Reads, validation and event publication remain on the owned worker.
    pub fn reconcile(&self) {
        let _ = self.signal.try_send(());
    }
    /// Selection changes scheduling priority, never registered membership.
    pub fn select(&self, session: Option<SessionRef>) {
        if let Ok(mut selected) = self.selected.lock() {
            *selected = session;
        }
        self.reconcile();
    }
}
impl Drop for RegisteredWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.reconcile();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct Parents {
    watcher: Option<RecommendedWatcher>,
    installed: BTreeSet<PathBuf>,
    renew: Arc<AtomicBool>,
    signal: mpsc::SyncSender<()>,
}
impl Parents {
    fn refresh(&mut self, desired: BTreeSet<PathBuf>) {
        if self.renew.swap(false, Ordering::AcqRel) {
            if let Some(watcher) = &mut self.watcher {
                for path in &self.installed {
                    let _ = watcher.unwatch(path);
                }
            }
            self.installed.clear();
        }
        if self.watcher.is_none() {
            let signal = self.signal.clone();
            let renew = self.renew.clone();
            self.watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
                if matches!(&result, Ok(event) if matches!(event.kind, EventKind::Access(_))) {
                    return;
                }
                if result.is_err()
                    || matches!(&result, Ok(event) if matches!(event.kind, EventKind::Remove(_)))
                {
                    renew.store(true, Ordering::Release);
                }
                let _ = signal.try_send(());
            })
            .ok();
        }
        let Some(watcher) = &mut self.watcher else {
            return; // Validated fallback reads still work when OS watch fails.
        };
        for removed in self.installed.difference(&desired) {
            let _ = watcher.unwatch(removed);
        }
        self.installed.retain(|path| desired.contains(path));
        for path in desired {
            if !self.installed.contains(&path)
                && watcher.watch(&path, RecursiveMode::NonRecursive).is_ok()
            {
                self.installed.insert(path);
            }
        }
    }
}
#[allow(clippy::too_many_arguments)]
fn work(
    registry: Registry,
    data_directory: PathBuf,
    emit: Arc<Emit>,
    signal: mpsc::SyncSender<()>,
    wake: mpsc::Receiver<()>,
    stop: Arc<AtomicBool>,
    selected: Arc<Mutex<Option<SessionRef>>>,
    fallback: Duration,
    ready: mpsc::SyncSender<()>,
    reconciled: Arc<dyn Fn() + Send + Sync>,
) {
    let mut parents = Parents {
        watcher: None,
        installed: BTreeSet::new(),
        renew: Arc::new(AtomicBool::new(false)),
        signal,
    };
    let mut scan = scan::Scan::default();
    let mut ready = Some(ready);
    while !stop.load(Ordering::Acquire) {
        // Registration lookup precedes installing all trusted parents, and all
        // watches precede snapshot reconciliation, including the initial scan.
        if let Ok(projects) = registry.registered_projects() {
            let mut desired = BTreeSet::from([data_directory.clone()]);
            for project in &projects {
                desired.insert(project.root.clone());
                desired.insert(project.root.join(".ariadne"));
                desired.insert(project.root.join(".ariadne/sessions"));
            }
            parents.refresh(desired);
            if let Some(ready) = ready.take() {
                let _ = ready.send(());
            }
            let route = selected.lock().ok().and_then(|value| value.clone());
            scan.reconcile(&projects, route.as_ref(), &*emit);
        } else {
            // Preserve the registry parent subscription even while the index is
            // unavailable, and let the bounded fallback retry registration.
            parents.refresh(BTreeSet::from([data_directory.clone()]));
            if let Some(ready) = ready.take() {
                let _ = ready.send(());
            }
        }
        // Native consumers reuse this exact scan's fallback/focus completion;
        // no extra scanner or timer is created for the tray.
        reconciled();
        match wake.recv_timeout(fallback) {
            Ok(()) => {
                // Fixed deadline prevents a continuous change stream from
                // indefinitely postponing the authoritative read.
                let deadline = Instant::now() + DEBOUNCE;
                while !stop.load(Ordering::Acquire) {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() || wake.recv_timeout(remaining).is_err() {
                        break;
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    // Dropping RecommendedWatcher stops its native observation resources before
    // the owning RegisteredWatcher::drop returns from joining this worker.
}

#[cfg(test)]
mod tests;
