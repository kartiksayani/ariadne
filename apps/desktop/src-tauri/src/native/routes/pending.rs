use ariadne_core::{CoreError, CoreErrorCode, OpenRoute};

/// A single validated navigation intent, ordered by request arrival rather than
/// filesystem lookup completion. Only the trusted registered resolver may call
/// `validated`; failed validation leaves the previous intent intact.
#[derive(Default)]
pub(crate) struct PendingRoute {
    next: u64,
    latest_valid: u64,
    ready: bool,
    pending: Option<(u64, OpenRoute)>,
}
impl PendingRoute {
    pub(crate) fn begin(&mut self) -> Result<u64, CoreError> {
        self.next = self.next.checked_add(1).ok_or_else(|| {
            CoreError::new(
                CoreErrorCode::CapacityExceeded,
                "Native navigation sequence is exhausted.",
                "Restart Ariadne before opening another registered route.",
            )
        })?;
        Ok(self.next)
    }
    pub(crate) fn validated(&mut self, ticket: u64, route: OpenRoute) {
        if ticket > self.latest_valid && ticket <= self.next {
            self.latest_valid = ticket;
            self.pending = Some((ticket, route));
        }
    }
    pub(crate) fn set_ready(&mut self, ready: bool) {
        self.ready = ready;
    }
    pub(crate) fn current(&self) -> Option<(u64, OpenRoute)> {
        self.ready.then(|| self.pending.clone()).flatten()
    }
    pub(crate) fn delivered(&mut self, ticket: u64) {
        if self.pending.as_ref().is_some_and(|(id, _)| *id == ticket) {
            self.pending = None;
        }
    }
}

#[cfg(test)]
#[path = "tests/pending.rs"]
mod tests;
