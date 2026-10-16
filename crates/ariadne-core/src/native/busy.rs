//! Read-only callers ride out a briefly busy store instead of failing.
//!
//! A session lock is held only for short local writes, but pollers, reports and
//! agent writes can keep it taken for a few seconds together. A read changes
//! nothing, so it is always safe to try again. Writes never use this: they
//! return `store_busy` (retryable) and the caller resends the same operation.
use crate::{CoreError, CoreErrorCode};
use std::time::{Duration, Instant};

/// How long a read keeps retrying. Each try may itself wait up to the store's
/// 2 s lock deadline, so a read that stays busy gives up after 3 to 5 s with
/// the plain `store_busy` error.
pub const READ_RETRY_WINDOW: Duration = Duration::from_secs(3);
const FIRST_DELAY: Duration = Duration::from_millis(50);
const MAX_DELAY: Duration = Duration::from_millis(400);

/// Run a read-only call, retrying `store_busy` with a doubling backoff for
/// `READ_RETRY_WINDOW`. Any other result returns at once.
pub fn retry_busy_read<T>(read: impl FnMut() -> Result<T, CoreError>) -> Result<T, CoreError> {
    retry_busy_within(READ_RETRY_WINDOW, read)
}

/// `retry_busy_read` with an explicit window.
pub fn retry_busy_within<T>(
    window: Duration,
    mut read: impl FnMut() -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    let deadline = Instant::now() + window;
    let mut delay = FIRST_DELAY;
    loop {
        match read() {
            Err(error) if error.code == CoreErrorCode::StoreBusy => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(error);
                }
                std::thread::sleep(delay.min(remaining));
                delay = (delay * 2).min(MAX_DELAY);
            }
            other => return other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn busy() -> CoreError {
        super::super::errors::store(ariadne_store::session::StoreError::Busy)
    }

    #[test]
    fn a_read_that_clears_returns_its_value() {
        let mut calls = 0;
        let value = retry_busy_within(Duration::from_secs(2), || {
            calls += 1;
            if calls < 3 {
                Err(busy())
            } else {
                Ok(calls)
            }
        });
        assert_eq!(value.unwrap(), 3);
    }

    #[test]
    fn a_read_that_stays_busy_ends_with_the_plain_busy_error_after_the_window() {
        let started = Instant::now();
        let mut calls = 0;
        let error = retry_busy_within(Duration::from_millis(300), || {
            calls += 1;
            Err::<(), _>(busy())
        })
        .unwrap_err();
        let waited = started.elapsed();
        assert!(waited >= Duration::from_millis(300), "{waited:?}");
        assert!(waited < Duration::from_secs(2), "bounded: {waited:?}");
        assert!(calls >= 3, "backs off and tries again: {calls}");
        assert_eq!(error.code, CoreErrorCode::StoreBusy);
        assert!(error.retryable);
        assert_eq!(error.hint, "Ariadne is busy for a moment; try again.");
    }

    #[test]
    fn other_errors_are_not_retried() {
        let mut calls = 0;
        let error = retry_busy_within(Duration::from_secs(2), || {
            calls += 1;
            Err::<(), _>(CoreError::new(CoreErrorCode::NotFound, "Gone.", "Reload."))
        })
        .unwrap_err();
        assert_eq!(calls, 1);
        assert_eq!(error.code, CoreErrorCode::NotFound);
    }
}
