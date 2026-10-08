//! Durable provider-neutral claims and facts; no provider or socket IO under locks.
mod claim;
mod error;
mod expiry;
pub(crate) mod format;
mod hold;
mod report;
use crate::*;
use ariadne_store::{registry::Registry, session::Store};
pub use error::DeliveryError;
pub use format::AGENT_QUERY_TOOLS;
pub use hold::held_for_review;

pub struct DeliveryService<'a> {
    registry: &'a Registry,
}
impl<'a> DeliveryService<'a> {
    pub fn new(registry: &'a Registry) -> Self {
        Self { registry }
    }
    fn store(&self, route: &RegisteredSession) -> Result<Store, DeliveryError> {
        let project = self.registry.resolve_project(route.project_id())?;
        Ok(Store::open_registered(
            &self.registry.project_dir(&project.project_id),
            project.project_id,
        )?)
    }
}
