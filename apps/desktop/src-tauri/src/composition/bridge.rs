use super::NativeRuntime;
use crate::commands::DesktopService;
use ariadne_core::{native::NativeCoreService, *};
use std::sync::{Arc, Weak};

/// The renderer retains real Core reads after runtime shutdown, but never retains
/// native dispatch ownership. New setup must use the one current runtime.
#[derive(Clone)]
pub struct CoreBridge {
    core: Arc<NativeCoreService>,
    runtime: Weak<NativeRuntime>,
}
impl CoreBridge {
    pub(super) fn new(core: Arc<NativeCoreService>, runtime: Weak<NativeRuntime>) -> Self {
        Self { core, runtime }
    }
    pub fn core(&self) -> &Arc<NativeCoreService> {
        &self.core
    }
    pub fn desktop_service(&self) -> DesktopService {
        let resolver = self.core.clone();
        let runtime = self.runtime.clone();
        DesktopService::from_trusted_startup_with_connect(
            self.core.clone(),
            move |route| resolver.resolve_session(route),
            move |request, deadline| {
                runtime
                    .upgrade()
                    .ok_or_else(super::runtime::unavailable)?
                    .connect_before(request, deadline)
            },
        )
    }
}
