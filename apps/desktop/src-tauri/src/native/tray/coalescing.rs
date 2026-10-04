use std::time::{Duration, Instant};

pub(crate) const REBUILD_INTERVAL: Duration = Duration::from_millis(250);

/// A pending refresh retains the newest complete capture. The first build is
/// immediate; later changes share a deadline without extending it on every hint.
#[derive(Default)]
pub(crate) struct Coalesced<T> {
    latest: Option<T>,
    last: Option<Instant>,
}

impl<T> Coalesced<T> {
    pub(crate) fn replace(&mut self, latest: T) {
        self.latest = Some(latest);
    }

    pub(crate) fn take_due(&mut self, now: Instant) -> Option<T> {
        if self
            .last
            .is_some_and(|last| now.saturating_duration_since(last) < REBUILD_INTERVAL)
        {
            return None;
        }
        let next = self.latest.take()?;
        self.last = Some(now);
        Some(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newest_capture_is_built_once_without_starvation() {
        let now = Instant::now();
        let mut pending = Coalesced::default();
        pending.replace(1);
        assert_eq!(pending.take_due(now), Some(1));
        pending.replace(2);
        assert_eq!(pending.take_due(now + Duration::from_millis(249)), None);
        pending.replace(3);
        assert_eq!(pending.take_due(now + REBUILD_INTERVAL), Some(3));
        assert_eq!(pending.take_due(now + REBUILD_INTERVAL * 2), None);
        pending.replace(4);
        assert_eq!(pending.take_due(now + REBUILD_INTERVAL * 2), Some(4));
    }
}
