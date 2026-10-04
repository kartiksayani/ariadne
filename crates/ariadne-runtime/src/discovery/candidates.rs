use super::{bounded, capacity, invalid, AnnouncementAck, SessionAnnouncement};
use crate::control::BindingScope;
use ariadne_agent_protocol::{Availability, Compatibility, EndpointRef};
use ariadne_core::{CoreError, CoreErrorCode, SessionRef};
use ariadne_domain::models::{Freshness, UtcMillis};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
pub(crate) const CAP: usize = 256;
pub(crate) const LIFETIME: Duration = Duration::from_secs(90);

/// Owned facts resolved by native registration. Never a deserialized authority.
#[derive(Clone, Debug, PartialEq)]
pub struct AnnouncementBinding {
    pub binding_id: ariadne_domain::models::UuidV4,
    pub session: SessionRef,
    pub canonical_root: PathBuf,
    pub adapter_id: String,
    pub external_session_id: String,
    pub generation: ariadne_domain::models::UuidV4,
}
pub type BindingResolver =
    dyn Fn(&BindingScope) -> Result<AnnouncementBinding, CoreError> + Send + Sync;

/// Native read model, not a renderer or Core DTO. Presence never implies execution.
#[derive(Clone, Debug)]
pub struct Candidate {
    pub adapter_id: String,
    pub endpoint: EndpointRef,
    pub external_session_id: String,
    pub cwd: PathBuf,
    pub title: Option<String>,
    pub host_version: String,
    pub observed_at: UtcMillis,
    pub freshness: Freshness,
    pub compatibility: Compatibility,
    pub availability: Availability,
    pub binding: Option<AnnouncementBinding>,
    /// Actual loaded-daemon membership only; never terminal visibility or Idle.
    pub loaded: bool,
    pub(crate) announcement: Option<SessionAnnouncement>,
    pub(crate) received: Instant,
}
impl Candidate {
    /// Original SDK/resource claims for subsequent native qualification, never
    /// an assertion that installed files are loaded or a grant of dispatch.
    pub fn announcement(&self) -> Option<&SessionAnnouncement> {
        self.announcement.as_ref()
    }
}
#[derive(Clone, Debug)]
pub struct DiscoverySnapshot {
    pub candidates: Vec<Candidate>,
    pub error: Option<CoreError>,
}
struct State {
    candidates: BTreeMap<(String, String, String), Candidate>,
    errors: BTreeMap<String, CoreError>,
}
#[derive(Clone)]
pub struct Discovery {
    state: Arc<Mutex<State>>,
    pub(crate) now: Arc<dyn Fn() -> UtcMillis + Send + Sync>,
    resolver: Option<Arc<BindingResolver>>,
}
impl Discovery {
    pub fn new(
        now: Arc<dyn Fn() -> UtcMillis + Send + Sync>,
        resolver: Option<Arc<BindingResolver>>,
    ) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                candidates: BTreeMap::new(),
                errors: BTreeMap::new(),
            })),
            now,
            resolver,
        }
    }
    /// Blocking path checks run on the existing runtime IO offload, never under a store lock.
    /// This admits Unknown candidates only. Qualified evidence requires the native adapter.
    pub(crate) fn announce(
        &self,
        mut announcement: SessionAnnouncement,
        received: Instant,
        observed_at: UtcMillis,
        deadline: Instant,
    ) -> Result<AnnouncementAck, CoreError> {
        within(deadline)?;
        announcement.validate()?;
        let binding = self.resolve(&announcement)?;
        let canonical = |value: &str| {
            let path = std::fs::canonicalize(value).map_err(|_| invalid("SDK announcement directory is not accessible; refresh the original conversation."))?;
            if !path.is_dir() {
                return Err(invalid(
                    "SDK announcement directory must be an existing directory.",
                ));
            }
            let path = path
                .to_str()
                .filter(|path| bounded(path))
                .ok_or_else(|| invalid("Canonical SDK path exceeds the UTF-8 metadata bound."))?;
            Ok(path.to_owned())
        };
        announcement.cwd = canonical(&announcement.cwd)?;
        announcement.plugin.root = canonical(&announcement.plugin.root)?;
        if let Some(binding) = &binding {
            if binding.canonical_root != std::path::Path::new(&announcement.cwd) {
                return Err(CoreError::new(
                    CoreErrorCode::BindingMismatch,
                    "Announced project differs from the registered binding root.",
                    "Announce the original captured conversation in its registered project.",
                ));
            }
        }
        // The resolver has released any registry/store locks before path IO.
        // Re-resolve after that IO so a generation rotation cannot qualify old scope.
        if binding != self.resolve(&announcement)? {
            return Err(invalid(
                "Registered binding identity changed during announcement validation.",
            ));
        }
        within(deadline)?;
        let ack = announcement.acknowledgement();
        let candidate = Candidate {
            adapter_id: announcement.adapter_id.clone(),
            endpoint: EndpointRef::LocalBridge {
                name: "claude-mod".into(),
            },
            external_session_id: announcement.external_session_id.clone(),
            cwd: PathBuf::from(&announcement.cwd),
            title: None,
            host_version: announcement.host_version.clone(),
            observed_at,
            freshness: Freshness::Fresh,
            compatibility: Compatibility::Unknown,
            availability: Availability::Unknown,
            binding,
            loaded: false,
            announcement: Some(announcement),
            received,
        };
        self.admit("claude-mod", candidate)?;
        Ok(ack)
    }
    fn resolve(
        &self,
        announcement: &SessionAnnouncement,
    ) -> Result<Option<AnnouncementBinding>, CoreError> {
        let Some(scope) = &announcement.binding_scope else {
            return Ok(None);
        };
        let resolver = self.resolver.as_ref().ok_or_else(|| {
            invalid("Bound announcements require the native registered binding resolver.")
        })?;
        let actual = resolver(scope)?;
        if actual.binding_id != scope.binding_id {
            return Err(CoreError::new(
                CoreErrorCode::BindingMismatch,
                "Announcement binding differs from current registration.",
                "Keep the original captured scope; never retarget discovery facts.",
            ));
        }
        if actual.generation != scope.generation {
            return Err(CoreError::new(CoreErrorCode::StaleGeneration, "Announcement binding/generation differs from current registration.", "Keep the original captured scope; explicitly reconnect rather than retargeting old facts."));
        }
        if actual.adapter_id != announcement.adapter_id
            || actual.external_session_id != announcement.external_session_id
        {
            return Err(invalid(
                "Announcement provider/session differs from registered host identity.",
            ));
        }
        Ok(Some(actual))
    }
    pub(crate) fn admit(&self, endpoint: &str, candidate: Candidate) -> Result<(), CoreError> {
        let key = (
            candidate.adapter_id.clone(),
            endpoint.to_owned(),
            candidate.external_session_id.clone(),
        );
        let mut state = self.lock()?;
        expire(&mut state);
        if !state.candidates.contains_key(&key) && state.candidates.len() >= CAP {
            return Err(capacity());
        }
        state.candidates.insert(key, candidate);
        Ok(())
    }
    pub fn snapshot(&self) -> Result<DiscoverySnapshot, CoreError> {
        let mut state = self.lock()?;
        expire(&mut state);
        Ok(DiscoverySnapshot {
            candidates: state.candidates.values().cloned().collect(),
            error: state.errors.values().next().cloned(),
        })
    }
    pub(crate) fn codex_complete(
        &self,
        endpoint: &str,
        candidates: Vec<Candidate>,
    ) -> Result<(), CoreError> {
        let mut state = self.lock()?;
        expire(&mut state);
        let other = state
            .candidates
            .keys()
            .filter(|(provider, source, _)| provider != "codex" || source != endpoint)
            .count();
        if other + candidates.len() > CAP {
            return Err(capacity());
        }
        state
            .candidates
            .retain(|(provider, source, _), _| provider != "codex" || source != endpoint);
        for candidate in candidates {
            state.candidates.insert(
                (
                    "codex".into(),
                    endpoint.into(),
                    candidate.external_session_id.clone(),
                ),
                candidate,
            );
        }
        state.errors.remove(endpoint);
        Ok(())
    }
    pub(crate) fn codex_failed(&self, endpoint: &str, error: CoreError) -> Result<(), CoreError> {
        let mut state = self.lock()?;
        for ((provider, source, _), candidate) in &mut state.candidates {
            if provider == "codex" && source == endpoint {
                candidate.freshness = Freshness::Stale;
            }
        }
        state.errors.insert(endpoint.to_owned(), error);
        Ok(())
    }
    pub fn refresh_after_wake(&self) -> Result<(), CoreError> {
        let mut state = self.lock()?;
        for candidate in state.candidates.values_mut() {
            candidate.freshness = Freshness::Unknown;
        }
        Ok(())
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>, CoreError> {
        self.state.lock().map_err(|_| {
            CoreError::new(
                CoreErrorCode::HostUnreachable,
                "Native discovery cache is unavailable.",
                "Refresh discovery; retained candidates never authorize a send.",
            )
        })
    }
}
fn expire(state: &mut State) {
    state
        .candidates
        .retain(|_, candidate| candidate.received.elapsed() < LIFETIME);
}
fn within(deadline: Instant) -> Result<(), CoreError> {
    if Instant::now() >= deadline {
        return Err(CoreError::new(CoreErrorCode::HostUnreachable, "Announcement validation exceeded its original control deadline.", "Refresh the original conversation; a timed-out announcement never grants dispatch authority."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::{LoadedPlugin, ModDescriptor};
    use ariadne_domain::models::UuidV4;
    use std::sync::atomic::{AtomicUsize, Ordering};
    fn time() -> UtcMillis {
        UtcMillis::new("2026-10-04T00:00:00.000Z").unwrap()
    }
    fn id(n: u32) -> UuidV4 {
        UuidV4::new(format!("00000000-0000-4000-8000-{n:012}")).unwrap()
    }
    fn discovery() -> Discovery {
        Discovery::new(Arc::new(time), None)
    }
    fn announcement(root: &std::path::Path) -> SessionAnnouncement {
        SessionAnnouncement {
            adapter_id: "claude_code_mod".into(),
            external_session_id: "original-session".into(),
            cwd: root.to_str().unwrap().into(),
            host_version: "2.1.287".into(),
            plugin: LoadedPlugin {
                name: "ariadne".into(),
                root: root.to_str().unwrap().into(),
            },
            descriptor: ModDescriptor {
                helper_path: "/Applications/Ariadne/helper".into(),
                app_version: "0.1.0".into(),
                api_version: 1,
            },
            binding_scope: None,
        }
    }
    fn admit(d: &Discovery, a: SessionAnnouncement) -> Result<AnnouncementAck, CoreError> {
        d.announce(
            a,
            Instant::now(),
            time(),
            Instant::now() + Duration::from_secs(5),
        )
    }
    fn candidate(n: usize, received: Instant) -> Candidate {
        Candidate {
            adapter_id: "codex".into(),
            endpoint: EndpointRef::UnixSocket {
                path: "/tmp/configured.sock".into(),
            },
            external_session_id: format!("thread-{n}"),
            cwd: "/tmp".into(),
            title: None,
            host_version: "0.160.0".into(),
            observed_at: time(),
            freshness: Freshness::Fresh,
            compatibility: Compatibility::Unknown,
            availability: Availability::Unknown,
            binding: None,
            loaded: true,
            announcement: None,
            received,
        }
    }
    #[test]
    fn unbound_admission_uses_native_time_and_canonical_paths_without_qualification() {
        let root = tempfile::tempdir().unwrap();
        let d = discovery();
        let ack = admit(&d, announcement(root.path())).unwrap();
        assert_eq!(ack.external_session_id, "original-session");
        let snap = d.snapshot().unwrap();
        let c = &snap.candidates[0];
        assert_eq!(c.cwd, std::fs::canonicalize(root.path()).unwrap());
        assert_eq!(c.observed_at, time());
        assert_eq!(c.compatibility, Compatibility::Unknown);
        assert_eq!(c.availability, Availability::Unknown);
        assert!(c.binding.is_none());
        assert!(!c.loaded);
        assert_eq!(c.announcement().unwrap().plugin.name, "ariadne");
    }
    #[test]
    fn metadata_is_strict_bounded_and_never_truncated_or_caller_freshness() {
        let root = tempfile::tempdir().unwrap();
        let a = announcement(root.path());
        let d = discovery();
        let mut boundary = a.clone();
        boundary.external_session_id = "😀".repeat(1024);
        admit(&d, boundary.clone()).unwrap();
        boundary.external_session_id.push('a');
        assert_eq!(
            admit(&d, boundary).unwrap_err().code,
            CoreErrorCode::InvalidArgument
        );
        for key in ["client_timestamp", "compatibility", "unexpected"] {
            let mut value = serde_json::to_value(&a).unwrap();
            value[key] = serde_json::json!("fresh");
            assert!(serde_json::from_value::<SessionAnnouncement>(value).is_err());
        }
        let mut missing = serde_json::to_value(&a).unwrap();
        missing.as_object_mut().unwrap().remove("binding_scope");
        assert!(serde_json::from_value::<SessionAnnouncement>(missing).is_err());
        for path in ["relative", "/tmp/../other", "/tmp/./other"] {
            let mut bad = a.clone();
            bad.cwd = path.into();
            assert!(bad.validate().is_err());
        }
    }
    #[test]
    fn bound_scope_is_resolved_twice_and_rotation_never_admits_old_identity() {
        let root = tempfile::tempdir().unwrap();
        let canonical = std::fs::canonicalize(root.path()).unwrap();
        let facts = AnnouncementBinding {
            binding_id: id(1),
            session: SessionRef {
                project_id: id(2),
                session_id: id(3),
            },
            canonical_root: canonical,
            adapter_id: "claude_code_mod".into(),
            external_session_id: "original-session".into(),
            generation: id(4),
        };
        let mut a = announcement(root.path());
        a.binding_scope = Some(BindingScope {
            binding_id: id(1),
            generation: id(4),
        });
        assert!(admit(&discovery(), a.clone()).is_err());
        let captured = facts.clone();
        let d = Discovery::new(
            Arc::new(time),
            Some(Arc::new(move |_| Ok(captured.clone()))),
        );
        admit(&d, a.clone()).unwrap();
        assert_eq!(
            d.snapshot().unwrap().candidates[0].binding,
            Some(facts.clone())
        );
        let count = Arc::new(AtomicUsize::new(0));
        let calls = count.clone();
        let d = Discovery::new(
            Arc::new(time),
            Some(Arc::new(move |_| {
                let mut current = facts.clone();
                if calls.fetch_add(1, Ordering::SeqCst) > 0 {
                    current.generation = id(5);
                }
                Ok(current)
            })),
        );
        assert_eq!(
            admit(&d, a).unwrap_err().code,
            CoreErrorCode::StaleGeneration
        );
        assert_eq!(count.load(Ordering::SeqCst), 2);
        assert!(d.snapshot().unwrap().candidates.is_empty());
    }
    #[test]
    fn expired_admission_cannot_invoke_the_native_resolver() {
        let root = tempfile::tempdir().unwrap();
        let mut a = announcement(root.path());
        a.binding_scope = Some(BindingScope {
            binding_id: id(1),
            generation: id(2),
        });
        let d = Discovery::new(
            Arc::new(time),
            Some(Arc::new(|_| {
                panic!("expired work must not read registration")
            })),
        );
        assert_eq!(
            d.announce(
                a,
                Instant::now(),
                time(),
                Instant::now() - Duration::from_secs(1)
            )
            .unwrap_err()
            .code,
            CoreErrorCode::HostUnreachable
        );
    }
    #[test]
    fn cap_is_live_state_and_refresh_or_exact_expiry_does_not_evict_other_live_candidates() {
        let d = discovery();
        let now = Instant::now();
        for n in 0..CAP {
            d.admit("configured", candidate(n, now)).unwrap();
        }
        let oldest = d.snapshot().unwrap().candidates[0].clone();
        assert_eq!(
            d.admit("configured", candidate(CAP, now)).unwrap_err().code,
            CoreErrorCode::CapacityExceeded
        );
        let mut refreshed = candidate(0, now);
        refreshed.title = Some("refreshed".into());
        d.admit("configured", refreshed).unwrap();
        assert_eq!(d.snapshot().unwrap().candidates.len(), CAP);
        d.lock()
            .unwrap()
            .candidates
            .values_mut()
            .find(|c| c.external_session_id == oldest.external_session_id)
            .unwrap()
            .received = Instant::now() - LIFETIME;
        d.admit("configured", candidate(CAP, Instant::now()))
            .unwrap();
        assert_eq!(d.snapshot().unwrap().candidates.len(), CAP);
        assert!(!d
            .snapshot()
            .unwrap()
            .candidates
            .iter()
            .any(|c| c.external_session_id == oldest.external_session_id));
    }
    #[test]
    fn incomplete_scan_preserves_prior_snapshot_and_another_healthy_endpoint_cannot_clear_its_error(
    ) {
        let d = discovery();
        d.codex_complete("first", vec![candidate(1, Instant::now())])
            .unwrap();
        d.codex_failed("first", capacity()).unwrap();
        d.codex_complete("second", vec![candidate(2, Instant::now())])
            .unwrap();
        let snap = d.snapshot().unwrap();
        assert!(snap.error.is_some());
        assert_eq!(snap.candidates.len(), 2);
        assert_eq!(
            snap.candidates
                .iter()
                .find(|c| c.external_session_id == "thread-1")
                .unwrap()
                .freshness,
            Freshness::Stale
        );
        d.codex_complete("first", vec![]).unwrap();
        assert!(d.snapshot().unwrap().error.is_none());
        assert_eq!(d.snapshot().unwrap().candidates.len(), 1);
    }
    #[test]
    fn wake_invalidates_freshness_without_refreshing_original_observation() {
        let d = discovery();
        d.codex_complete("first", vec![candidate(1, Instant::now())])
            .unwrap();
        d.refresh_after_wake().unwrap();
        let snap = d.snapshot().unwrap();
        assert_eq!(snap.candidates[0].freshness, Freshness::Unknown);
        assert_eq!(snap.candidates[0].observed_at, time());
    }
}
