//! Brief native route publication; a receipt never creates a route.
use super::*;
use std::sync::Mutex;

type Route = (BindingLease, ClaimGate);
#[derive(Clone, Default)]
pub struct ControlRoutes(Arc<Mutex<HashMap<String, Route>>>);
impl ControlRoutes {
    pub fn new() -> Self {
        Self::default()
    }
    pub(crate) fn from_bindings(bindings: Vec<Route>) -> Result<Self, CoreError> {
        let routes = Self::new();
        for route in bindings {
            let mut map = routes.lock()?;
            if map
                .insert(route.0.binding_id().as_str().to_owned(), route)
                .is_some()
            {
                return Err(error(
                    CoreErrorCode::BindingConflict,
                    "Duplicate binding supplied to the desktop control server.",
                ));
            }
        }
        Ok(routes)
    }
    /// Called only after the supervisor reports reconciled and registration has
    /// been re-read. All map locks end before gate or Core/provider IO.
    pub(crate) fn install(&self, lease: BindingLease, gate: ClaimGate) -> Result<(), CoreError> {
        let replaced = self
            .lock()?
            .insert(lease.binding_id().as_str().to_owned(), (lease, gate));
        if let Some((_, gate)) = replaced {
            gate.stop();
        }
        Ok(())
    }
    pub(crate) fn get(
        &self,
        id: &ariadne_domain::models::UuidV4,
    ) -> Result<Option<Route>, CoreError> {
        Ok(self.lock()?.get(id.as_str()).cloned())
    }
    /// Stale shutdown must not remove a newer binding generation.
    pub fn remove_current(
        &self,
        id: &ariadne_domain::models::UuidV4,
        generation: &ariadne_domain::models::UuidV4,
    ) -> Result<bool, CoreError> {
        let removed = {
            let mut map = self.lock()?;
            if map
                .get(id.as_str())
                .is_some_and(|(lease, _)| lease.generation() == generation)
            {
                map.remove(id.as_str())
            } else {
                None
            }
        };
        if let Some((_, gate)) = removed {
            gate.stop();
            return Ok(true);
        }
        Ok(false)
    }
    pub fn close(&self) -> Result<(), CoreError> {
        let routes = std::mem::take(&mut *self.lock()?);
        for (_, (_, gate)) in routes {
            gate.stop();
        }
        Ok(())
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, Route>>, CoreError> {
        self.0.lock().map_err(|_| {
            error(
                CoreErrorCode::HostUnreachable,
                "Native control route map is unavailable; dispatch remains fenced.",
            )
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use ariadne_core::RegisteredSession;
    use ariadne_domain::models::UuidV4;
    fn id(n: u64) -> UuidV4 {
        UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
    }
    #[test]
    fn conditional_removal_preserves_new_generation_and_close_fences_claims() {
        let home = tempfile::tempdir().unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let owner = DesktopOwner::acquire(home.path()).unwrap();
        let session = RegisteredSession::from_trusted_entrypoint(id(1), id(2));
        let routes = ControlRoutes::new();
        let gate = ClaimGate::new();
        gate.reconciled_from_trusted_native().unwrap();
        routes
            .install(
                owner.binding_lease(session.clone(), id(3), id(4)).unwrap(),
                gate.clone(),
            )
            .unwrap();
        assert!(routes.remove_current(&id(3), &id(4)).unwrap());
        assert!(gate.admit(|| ()).is_err());
        let current = ClaimGate::new();
        current.reconciled_from_trusted_native().unwrap();
        routes
            .install(
                owner.binding_lease(session, id(3), id(5)).unwrap(),
                current.clone(),
            )
            .unwrap();
        assert!(!routes.remove_current(&id(3), &id(4)).unwrap());
        assert_eq!(routes.get(&id(3)).unwrap().unwrap().0.generation(), &id(5));
        current.admit(|| ()).unwrap();
        routes.close().unwrap();
        assert!(routes.get(&id(3)).unwrap().is_none());
        assert!(current.admit(|| ()).is_err());
    }
}
