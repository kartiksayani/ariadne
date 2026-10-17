//! A test-only stretch for the wall-clock budgets adapters give to host calls.
//!
//! Release builds return the budget unchanged: the factor is not read and cannot be set.
//! Debug builds (the ones `cargo test` makes) stretch every budget by the whole number in
//! `ARIADNE_TEST_DEADLINE_SCALE` (1 to 100; anything else means 1). A test that starts real
//! processes sets it so a busy machine cannot turn a slow `--version` start into a failure.
//! Budgets that a test passes in as explicit deadlines are never touched.

use std::time::Duration;

/// Environment variable read by debug builds only.
pub const DEADLINE_SCALE_ENV: &str = "ARIADNE_TEST_DEADLINE_SCALE";

/// The budget a debug test run should allow for `budget`; exactly `budget` in a release build.
#[cfg(debug_assertions)]
pub fn scaled(budget: Duration) -> Duration {
    // Read on every call, not cached: a test binary sets the variable once, and a parallel test that
    // asked for a budget first must not pin the factor at 1 for the rest of the process.
    let scale = std::env::var(DEADLINE_SCALE_ENV)
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|scale| (1..=100).contains(scale))
        .unwrap_or(1);
    budget.saturating_mul(scale)
}

/// The budget a debug test run should allow for `budget`; exactly `budget` in a release build.
#[cfg(not(debug_assertions))]
pub const fn scaled(budget: Duration) -> Duration {
    budget
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One test, because it owns the variable for the whole process: the factor is read on every
    /// call, so a test binary may set it after other tests already asked for a budget.
    #[test]
    fn the_scale_is_read_on_every_call() {
        let five = Duration::from_secs(5);
        std::env::remove_var(DEADLINE_SCALE_ENV);
        assert_eq!(scaled(five), five, "unset means 1");
        std::env::set_var(DEADLINE_SCALE_ENV, "10");
        assert_eq!(
            scaled(five),
            Duration::from_secs(50),
            "set after the first call"
        );
        for refused in ["0", "101", "ten", ""] {
            std::env::set_var(DEADLINE_SCALE_ENV, refused);
            assert_eq!(scaled(five), five, "{refused:?} means 1");
        }
        std::env::remove_var(DEADLINE_SCALE_ENV);
        assert_eq!(scaled(five), five, "removed again");
    }
}
