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
    use std::sync::OnceLock;
    static SCALE: OnceLock<u32> = OnceLock::new();
    let scale = *SCALE.get_or_init(|| {
        std::env::var(DEADLINE_SCALE_ENV)
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|scale| (1..=100).contains(scale))
            .unwrap_or(1)
    });
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

    #[test]
    fn an_unset_scale_leaves_the_budget_unchanged() {
        // The unit-test process never sets the variable, so the factor is 1.
        assert_eq!(scaled(Duration::from_secs(5)), Duration::from_secs(5));
    }
}
