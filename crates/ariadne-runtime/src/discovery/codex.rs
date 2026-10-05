use super::{
    candidates::{CAP, LIFETIME},
    capacity, invalid, Candidate, Discovery,
};
use ariadne_adapter_codex::{CodexDiscovery, CodexOptions};
use ariadne_agent_protocol::{
    host_version::HostVersionStatus, Availability, Compatibility, EndpointRef,
};
use ariadne_core::{CoreError, CoreErrorCode};
use ariadne_domain::models::Freshness;
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};
use tokio::sync::{oneshot, watch};

/// Explicit native configuration; the renderer never supplies these paths.
pub struct CodexEndpoint {
    pub options: CodexOptions,
    pub endpoint: EndpointRef,
}
pub struct DiscoveryPoller {
    active: watch::Sender<bool>,
    wake: watch::Sender<u64>,
    stop: Option<oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
    discovery: Discovery,
}
impl DiscoveryPoller {
    pub fn start(discovery: Discovery, endpoints: Vec<CodexEndpoint>) -> Result<Self, CoreError> {
        if endpoints.len() > CAP {
            return Err(capacity());
        }
        let mut sources = Vec::new();
        let mut identities = HashSet::new();
        for configured in endpoints {
            let path = configured
                .options
                .endpoint_path(&configured.endpoint)
                .map_err(CoreError::from)?;
            let key = path
                .to_str()
                .filter(|path| super::bounded(path))
                .ok_or_else(|| {
                    invalid("Configured Codex discovery endpoint must be bounded UTF-8.")
                })?
                .to_owned();
            if !identities.insert(key.clone()) {
                return Err(invalid("Codex discovery endpoint is configured twice."));
            }
            sources.push((
                key,
                CodexDiscovery::new(configured.options, configured.endpoint)
                    .map_err(CoreError::from)?,
            ));
        }
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| invalid("Start discovery on the desktop's existing native runtime."))?;
        let (active, open) = watch::channel(false);
        let (wake, refresh) = watch::channel(0);
        let (stop, stopped) = oneshot::channel();
        let task = runtime.spawn(run(discovery.clone(), sources, open, refresh, stopped));
        Ok(Self {
            active,
            wake,
            stop: Some(stop),
            task: Some(task),
            discovery,
        })
    }
    pub fn set_connection_ui_open(&self, open: bool) {
        self.active.send_replace(open);
    }
    pub fn refresh_after_wake(&self) -> Result<(), CoreError> {
        self.discovery.refresh_after_wake()?;
        self.wake
            .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
        Ok(())
    }
    /// Stops new scans. A started blocking page retains its own transport until
    /// its original ten-second bound finishes; no external host is signalled.
    pub async fn stop(mut self) -> Result<(), CoreError> {
        self.request_stop();
        self.task
            .take()
            .expect("poller owns task")
            .await
            .map_err(|_| unavailable("Native discovery task stopped unexpectedly."))
    }
    fn request_stop(&mut self) {
        self.active.send_replace(false);
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}
impl Drop for DiscoveryPoller {
    fn drop(&mut self) {
        self.request_stop();
    }
}

async fn run(
    discovery: Discovery,
    mut sources: Vec<(String, CodexDiscovery)>,
    mut open: watch::Receiver<bool>,
    mut wake: watch::Receiver<u64>,
    mut stop: oneshot::Receiver<()>,
) {
    loop {
        if !*open.borrow_and_update() {
            tokio::select! { biased; _ = &mut stop => return, result = open.changed() => { if result.is_err() { return; } }, result = wake.changed() => { if result.is_err() { return; } } }
            continue;
        }
        let epoch = *wake.borrow_and_update();
        let mut remaining = std::mem::take(&mut sources).into_iter();
        while let Some((key, mut source)) = remaining.next() {
            if stop.try_recv().is_ok() {
                return;
            }
            if !*open.borrow() || *wake.borrow() != epoch {
                sources.push((key, source));
                sources.extend(remaining);
                break;
            }
            let mut candidates = Vec::new();
            let mut ids = HashSet::new();
            let mut cursors = HashSet::new();
            let mut cursor = None;
            let mut complete = false;
            let mut error = None;
            for _ in 0..50 {
                let deadline = Instant::now() + Duration::from_secs(10);
                let page = tokio::task::spawn_blocking(move || {
                    let result = source.page(cursor, deadline).map_err(CoreError::from).and_then(|mut page| {
                        for candidate in &mut page.candidates {
                            if !super::bounded(&candidate.external_session_id) || candidate.title.as_ref().is_some_and(|title| !super::bounded(title)) {
                                return Err(invalid("Codex discovery metadata exceeds its UTF-8 bound."));
                            }
                            candidate.cwd = match std::fs::canonicalize(&candidate.cwd) {
                                Ok(path) if path.is_dir() && path.to_str().is_some_and(super::bounded) => path,
                                _ => return Err(unavailable("Loaded Codex project directory is inaccessible; use manual binding or refresh.")),
                            };
                        }
                        Ok(page)
                    });
                    let result = result.map(|page| (page, source.host_version()));
                    (source, result)
                }).await;
                let Ok((returned, page)) = page else {
                    let _ = discovery.codex_failed(
                        &key,
                        unavailable(
                            "Native discovery IO worker failed; refresh the explicit endpoint.",
                        ),
                    );
                    return;
                };
                source = returned;
                if !*open.borrow() || *wake.borrow() != epoch {
                    break;
                }
                if stop.try_recv().is_ok() {
                    return;
                }
                match page {
                    Err(cause) => {
                        error = Some(cause);
                        break;
                    }
                    Ok((page, observed)) => {
                        // Rejected versions never open a reader, so only accepted
                        // versions reach here: a newer patch is surfaced as
                        // `Untested`; the baseline keeps the unqualified `Unknown`.
                        let (observed_version, compatibility) = match observed {
                            Some((version, HostVersionStatus::Untested)) => {
                                (Some(version), Compatibility::Untested)
                            }
                            Some((version, HostVersionStatus::Qualified)) => {
                                (Some(version), Compatibility::Unknown)
                            }
                            None => (None, Compatibility::Unknown),
                        };
                        for candidate in page.candidates {
                            if !ids.insert(candidate.external_session_id.clone()) {
                                error = Some(invalid("Loaded discovery repeated a host session identity across pages."));
                                break;
                            }
                            if candidates.len() >= CAP {
                                error = Some(capacity());
                                break;
                            }
                            candidates.push(Candidate {
                                adapter_id: "codex".into(),
                                endpoint: EndpointRef::UnixSocket { path: key.clone() },
                                external_session_id: candidate.external_session_id,
                                cwd: candidate.cwd,
                                title: candidate.title,
                                host_version: observed_version.clone().unwrap_or_default(),
                                observed_at: (discovery.now)(),
                                freshness: Freshness::Fresh,
                                compatibility,
                                availability: Availability::Unknown,
                                binding: None,
                                loaded: true,
                                announcement: None,
                                received: Instant::now(),
                            });
                        }
                        if error.is_some() {
                            break;
                        }
                        cursor = page.next_cursor;
                        if cursor.is_none() {
                            complete = true;
                            break;
                        }
                        if !cursors.insert(cursor.clone()) {
                            error = Some(invalid("Codex discovery cursor did not advance."));
                            break;
                        }
                    }
                }
            }
            if *open.borrow() && *wake.borrow() == epoch {
                if complete
                    && !candidates
                        .iter()
                        .any(|candidate| candidate.received.elapsed() >= LIFETIME)
                {
                    if let Err(cause) = discovery.codex_complete(&key, candidates) {
                        error = Some(cause);
                    }
                } else if error.is_none() {
                    error = Some(capacity());
                }
                if let Some(cause) = error {
                    let _ = discovery.codex_failed(&key, cause);
                }
            }
            sources.push((key, source));
        }
        tokio::select! { biased; _ = &mut stop => return, result = open.changed() => { if result.is_err() { return; } }, result = wake.changed() => { if result.is_err() { return; } }, _ = tokio::time::sleep(Duration::from_secs(30)) => {} }
    }
}
fn unavailable(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::HostUnreachable, message, "Refresh the configured host endpoint; missing discovery never proves Idle, delivery absence or authority to resend.")
}
