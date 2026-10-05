const LIMIT: usize = 16;
const TEXT_LIMIT: usize = 256;

#[derive(Default)]
pub(crate) struct Diagnostics {
    rows: Vec<String>,
}
impl Diagnostics {
    /// A snapshot replaces earlier lifecycle diagnostics; this is never a log
    /// and never consumes canonical recovery evidence.
    pub(crate) fn replace(&mut self, rows: Vec<String>, stopped: bool) {
        if stopped {
            return;
        }
        let omitted = rows.len().saturating_sub(LIMIT);
        self.rows = rows
            .into_iter()
            .take(LIMIT)
            .map(|row| {
                let mut characters = row.chars();
                let mut bounded: String = characters.by_ref().take(TEXT_LIMIT).collect();
                if characters.next().is_some() {
                    bounded.push('…');
                }
                bounded
            })
            .collect();
        if omitted > 0 {
            self.rows.push(format!(
                "{omitted} additional lifecycle diagnostics; inspect the session recovery details."
            ));
        }
    }
    pub(crate) fn rows(&self) -> &[String] {
        &self.rows
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn latest_snapshot_replaces_and_stop_rejects_late_publication() {
        let mut state = Diagnostics::default();
        state.replace(vec!["Previous uncertain exit".into()], false);
        state.replace(vec!["Current retained uncertainty".into()], false);
        assert_eq!(state.rows(), &["Current retained uncertainty"]);
        state.replace(vec!["Late success".into()], true);
        assert_eq!(state.rows(), &["Current retained uncertainty"]);
        state.replace(vec![], false);
        assert!(state.rows().is_empty());
    }
    #[test]
    fn bounds_are_explicit_instead_of_silently_hiding_diagnostics() {
        let mut state = Diagnostics::default();
        state.replace(vec!["x".repeat(TEXT_LIMIT + 1); LIMIT + 2], false);
        assert_eq!(state.rows().len(), LIMIT + 1);
        assert!(state.rows()[0].ends_with('…'));
        assert!(state.rows()[LIMIT].starts_with("2 additional"));
    }
}
