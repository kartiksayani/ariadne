use std::collections::BTreeMap;

const LIMIT: usize = 16;
const TEXT_LIMIT: usize = 256;

/// One owner-facing note about the runtime. A note about a binding names its
/// session by label when the tray shows it, never by ID.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LifecycleNote {
    pub binding_id: Option<String>,
    /// Plain words, without the session name: "could not connect".
    pub text: String,
}
impl LifecycleNote {
    pub fn binding(binding_id: &str, text: impl Into<String>) -> Self {
        Self {
            binding_id: Some(binding_id.to_owned()),
            text: text.into(),
        }
    }
    pub fn general(text: impl Into<String>) -> Self {
        Self {
            binding_id: None,
            text: text.into(),
        }
    }
    /// "claude-code · iTerm window 1: could not connect". A binding no session
    /// lists any more reads as "A session".
    pub fn render(&self, labels: &BTreeMap<String, String>) -> String {
        match &self.binding_id {
            Some(binding_id) => format!(
                "{}: {}",
                labels.get(binding_id).map_or("A session", String::as_str),
                self.text
            ),
            None => self.text.clone(),
        }
    }
}

#[derive(Default)]
pub(crate) struct Diagnostics {
    rows: Vec<LifecycleNote>,
}
impl Diagnostics {
    /// A snapshot replaces earlier lifecycle diagnostics; this is never a log
    /// and never consumes canonical recovery evidence.
    pub(crate) fn replace(&mut self, rows: Vec<LifecycleNote>, stopped: bool) {
        if stopped {
            return;
        }
        let omitted = rows.len().saturating_sub(LIMIT);
        self.rows = rows
            .into_iter()
            .take(LIMIT)
            .map(|mut row| {
                let mut characters = row.text.chars();
                let mut bounded: String = characters.by_ref().take(TEXT_LIMIT).collect();
                if characters.next().is_some() {
                    bounded.push('…');
                }
                row.text = bounded;
                row
            })
            .collect();
        if omitted > 0 {
            self.rows.push(LifecycleNote::general(format!(
                "{omitted} more connection notes not shown."
            )));
        }
    }
    #[cfg(test)]
    pub(crate) fn rows(&self) -> &[LifecycleNote] {
        &self.rows
    }
    /// The notes as menu lines, sessions named by `labels`.
    pub(crate) fn render(&self, labels: &BTreeMap<String, String>) -> Vec<String> {
        self.rows.iter().map(|row| row.render(labels)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn general(text: &str) -> LifecycleNote {
        LifecycleNote::general(text)
    }
    #[test]
    fn latest_snapshot_replaces_and_stop_rejects_late_publication() {
        let mut state = Diagnostics::default();
        state.replace(vec![general("Previous uncertain exit")], false);
        state.replace(vec![general("Current retained uncertainty")], false);
        assert_eq!(state.rows(), &[general("Current retained uncertainty")]);
        state.replace(vec![general("Late success")], true);
        assert_eq!(state.rows(), &[general("Current retained uncertainty")]);
        state.replace(vec![], false);
        assert!(state.rows().is_empty());
    }
    #[test]
    fn bounds_are_explicit_instead_of_silently_hiding_diagnostics() {
        let mut state = Diagnostics::default();
        state.replace(vec![general(&"x".repeat(TEXT_LIMIT + 1)); LIMIT + 2], false);
        assert_eq!(state.rows().len(), LIMIT + 1);
        assert!(state.rows()[0].text.ends_with('…'));
        assert_eq!(
            state.rows()[LIMIT].text,
            "2 more connection notes not shown."
        );
    }
    #[test]
    fn binding_notes_name_the_session_by_label_never_by_id() {
        let id = "6e5fdf82-0000-4000-8000-000000000001";
        let mut state = Diagnostics::default();
        state.replace(
            vec![
                LifecycleNote::binding(id, "could not connect"),
                LifecycleNote::binding("gone", "stopped unexpectedly"),
                general("Notifications are off."),
            ],
            false,
        );
        let labels = BTreeMap::from([(id.to_owned(), "claude-code · iTerm window 1".to_owned())]);
        let lines = state.render(&labels);
        assert_eq!(
            lines,
            [
                "claude-code · iTerm window 1: could not connect",
                "A session: stopped unexpectedly",
                "Notifications are off.",
            ]
        );
        assert!(lines.iter().all(|line| !line.contains("6e5fdf82")));
    }
}
