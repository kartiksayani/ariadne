//! Read-only callers ride out a briefly busy store instead of failing.
//!
//! A session lock is held only for short local writes, but pollers, reports and
//! agent writes can keep it taken for a few seconds together. A read changes
//! nothing, so it is always safe to try again. Writes never use this: they
//! return `store_busy` (retryable) and the caller resends the same operation.
//!
//! Every try may itself wait the store's full lock wait (`LOCK_WAIT`, 2 s) on
//! each lock it touches before it reports Busy. So a new try starts only while
//! the backoff plus one full lock wait still fits in the budget: a read whose
//! tries each wait on one lock never runs past its budget. A try that waits on
//! `k` busy locks (the agent CLI's catalogue read touches every session) can
//! take `k * LOCK_WAIT`, so the worst case is `budget - LOCK_WAIT + k * LOCK_WAIT`.
use crate::{CoreError, CoreErrorCode};
use ariadne_store::session::LOCK_WAIT;
use std::time::{Duration, Instant};

/// Budget for reads whose callers have no tight timeout (agent CLI, owner
/// queries, MCP queries): room for a second try after one full lock wait. 5 s
/// leaves about 1 s of headroom for a first try's own work on top of its lock wait.
pub const READ_RETRY_WINDOW: Duration = Duration::from_millis(5_000);
/// Budget for reads the Claude plugin runs under its helper timeout (5 s, or
/// 8 s with quieter hook notices): `bridge connection-status` and the saved
/// connect lookup (`owner binding connect --replay-only`). Fits one try.
pub const PLUGIN_READ_BUDGET: Duration = Duration::from_millis(2_500);
const FIRST_DELAY: Duration = Duration::from_millis(50);
const MAX_DELAY: Duration = Duration::from_millis(400);

/// Run a read-only call, retrying `store_busy` with a doubling backoff within
/// `READ_RETRY_WINDOW`. Any other result returns at once.
pub fn retry_busy_read<T>(read: impl FnMut() -> Result<T, CoreError>) -> Result<T, CoreError> {
    retry_busy_within(READ_RETRY_WINDOW, read)
}

/// `retry_busy_read` with an explicit total budget.
pub fn retry_busy_within<T>(
    budget: Duration,
    read: impl FnMut() -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    retry_with_try_cost(budget, LOCK_WAIT, read)
}

/// Start a new try only if the backoff plus `try_cost` still fits in `budget`.
fn retry_with_try_cost<T>(
    budget: Duration,
    try_cost: Duration,
    mut read: impl FnMut() -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    let started = Instant::now();
    let mut delay = FIRST_DELAY;
    loop {
        match read() {
            Err(error) if error.code == CoreErrorCode::StoreBusy => {
                let left = budget.saturating_sub(started.elapsed());
                if left < delay + try_cost {
                    return Err(error);
                }
                std::thread::sleep(delay);
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
        let value = retry_busy_within(Duration::from_secs(4), || {
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
    fn a_read_that_stays_busy_starts_a_try_only_while_a_full_wait_fits() {
        // Each try costs its full lock wait, as a real busy try does.
        let cost = Duration::from_millis(150);
        let budget = Duration::from_millis(700);
        let started = Instant::now();
        let mut starts = Vec::new();
        let error = retry_with_try_cost(budget, cost, || {
            starts.push(started.elapsed());
            std::thread::sleep(cost);
            Err::<(), _>(busy())
        })
        .unwrap_err();
        let waited = started.elapsed();
        assert!(starts.len() >= 2, "backs off and tries again: {starts:?}");
        let slack = Duration::from_millis(100);
        for start in &starts {
            assert!(*start + cost <= budget + slack, "{start:?} of {starts:?}");
        }
        // It stops once the next try could not finish inside the budget.
        let last = *starts.last().unwrap() + cost;
        assert!(budget.saturating_sub(last) < MAX_DELAY + cost, "{starts:?}");
        assert!(waited < budget + Duration::from_millis(300), "{waited:?}");
        assert_eq!(error.code, CoreErrorCode::StoreBusy);
        assert!(error.retryable);
        assert_eq!(error.hint, "Ariadne is busy for a moment; try again.");
    }

    #[test]
    fn the_plugin_budget_fits_one_lock_wait_and_never_a_second() {
        let started = Instant::now();
        let mut calls = 0;
        // A try that already spent the full lock wait is never followed by
        // another: a second one could run past the plugin's helper timeout.
        retry_with_try_cost(PLUGIN_READ_BUDGET, LOCK_WAIT, || {
            calls += 1;
            Err::<(), _>(busy())
        })
        .unwrap_err();
        assert!(calls > 1, "an instant busy is still retried");
        assert!(started.elapsed() + LOCK_WAIT <= PLUGIN_READ_BUDGET + Duration::from_millis(200));
        const { assert!(PLUGIN_READ_BUDGET.as_millis() < 2 * LOCK_WAIT.as_millis()) };
        const { assert!(READ_RETRY_WINDOW.as_millis() >= 2 * LOCK_WAIT.as_millis() + 50) };
    }

    #[test]
    fn other_errors_are_not_retried() {
        let mut calls = 0;
        let error = retry_busy_within(Duration::from_secs(4), || {
            calls += 1;
            Err::<(), _>(CoreError::new(CoreErrorCode::NotFound, "Gone.", "Reload."))
        })
        .unwrap_err();
        assert_eq!(calls, 1);
        assert_eq!(error.code, CoreErrorCode::NotFound);
    }
}
