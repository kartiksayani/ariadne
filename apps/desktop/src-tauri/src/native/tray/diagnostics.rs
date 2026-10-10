use super::capture::binding_status;
use ariadne_domain::models::{BindingSummary, ConnectionState};
use std::collections::{BTreeMap, BTreeSet};

const LIMIT: usize = 16;
const TEXT_LIMIT: usize = 256;

/// One owner-facing note about the runtime. A note about a binding names its
/// session by label when the tray shows it, never by ID.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LifecycleNote {
    pub binding_id: Option<String>,
    /// Connection identity for launch outcomes; generic binding notes omit it.
    pub generation: Option<String>,
    /// Plain words, without the session name: "could not connect".
    pub text: String,
}
impl LifecycleNote {
    pub fn binding(binding_id: &str, text: impl Into<String>) -> Self {
        Self {
            binding_id: Some(binding_id.to_owned()),
            generation: None,
            text: text.into(),
        }
    }
    pub fn connection(binding_id: &str, generation: &str, text: impl Into<String>) -> Self {
        Self {
            binding_id: Some(binding_id.to_owned()),
            generation: Some(generation.to_owned()),
            text: text.into(),
        }
    }
    pub fn general(text: impl Into<String>) -> Self {
        Self {
            binding_id: None,
            generation: None,
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
        let mut seen = BTreeSet::new();
        self.rows = rows
            .into_iter()
            // Producers put the newest outcome first.
            .filter(|row| {
                row.binding_id
                    .as_ref()
                    .is_none_or(|id| seen.insert((id.clone(), row.generation.clone())))
            })
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
    }
    #[cfg(test)]
    pub(crate) fn rows(&self) -> &[LifecycleNote] {
        &self.rows
    }
    /// Combine launch outcomes with current open-session status before applying
    /// the menu bound. Unlisted and connected bindings have no launch note.
    pub(crate) fn render(
        &self,
        labels: &BTreeMap<String, String>,
        bindings: &[BindingSummary],
    ) -> Vec<String> {
        let current: BTreeMap<_, _> = bindings
            .iter()
            .map(|binding| (binding.id.as_str(), binding))
            .collect();
        let mut shown = BTreeSet::new();
        let mut lines: Vec<_> = self
            .rows
            .iter()
            .filter_map(|row| {
                if let Some(id) = &row.binding_id {
                    let binding = current.get(id.as_str())?;
                    if !labels.contains_key(id)
                        || binding.connection_state == ConnectionState::Connected
                        || row
                            .generation
                            .as_ref()
                            .is_some_and(|generation| generation != binding.generation.as_str())
                        || shown.contains(id.as_str())
                    {
                        return None;
                    }
                    shown.insert(id.as_str());
                }
                Some(row.render(labels))
            })
            .collect();
        lines.extend(bindings.iter().filter_map(|binding| {
            if shown.contains(binding.id.as_str()) {
                return None;
            }
            let label = labels.get(binding.id.as_str())?;
            binding_status(binding).map(|status| format!("{label}: {status}"))
        }));
        let omitted = lines.len().saturating_sub(LIMIT);
        lines.truncate(LIMIT);
        if omitted > 0 {
            lines.push(format!("{omitted} more connection notes not shown."));
        }
        lines
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn general(text: &str) -> LifecycleNote {
        LifecycleNote::general(text)
    }
    fn binding() -> BindingSummary {
        let page: ariadne_domain::models::Page<ariadne_domain::models::SessionSummary> =
            serde_json::from_str(include_str!(
                "../../../../../../fixtures/domain/projections/sessions.json"
            ))
            .unwrap();
        let mut binding = page.items[0].active_binding.clone().unwrap();
        binding.connection_state = ConnectionState::Disconnected;
        binding
    }

    fn labels(binding: &BindingSummary) -> BTreeMap<String, String> {
        BTreeMap::from([(binding.id.as_str().to_owned(), "Notes sync".to_owned())])
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
        assert!(state.rows()[0].text.ends_with('…'));
        let lines = state.render(&BTreeMap::new(), &[]);
        assert_eq!(lines.len(), LIMIT + 1);
        assert_eq!(lines[LIMIT], "2 more connection notes not shown.");
    }
    #[test]
    fn binding_notes_name_the_session_by_label_never_by_id() {
        let binding = binding();
        let id = binding.id.as_str();
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
        let lines = state.render(&labels, &[binding]);
        assert_eq!(
            lines,
            [
                "claude-code · iTerm window 1: could not connect",
                "Notifications are off.",
            ]
        );
        assert!(lines.iter().all(|line| !line.contains("0000-4000")));
    }

    #[test]
    fn failed_start_disappears_after_the_binding_connects() {
        let mut binding = binding();
        let labels = labels(&binding);
        let mut state = Diagnostics::default();
        state.replace(
            vec![LifecycleNote::binding(
                binding.id.as_str(),
                "could not start",
            )],
            false,
        );
        assert_eq!(
            state.render(&labels, std::slice::from_ref(&binding)),
            ["Notes sync: could not start"]
        );
        binding.connection_state = ConnectionState::Connected;
        assert!(state
            .render(&labels, std::slice::from_ref(&binding))
            .is_empty());
        binding.owner_paused = true;
        assert_eq!(state.render(&labels, &[binding]), ["Notes sync: paused"]);
    }

    #[test]
    fn newest_launch_outcome_replaces_older_outcomes_and_capture_status() {
        let binding = binding();
        let labels = labels(&binding);
        let mut state = Diagnostics::default();
        state.replace(
            vec![
                LifecycleNote::binding(binding.id.as_str(), "could not connect"),
                LifecycleNote::binding(binding.id.as_str(), "could not start"),
            ],
            false,
        );
        assert_eq!(
            state.render(&labels, &[binding]),
            ["Notes sync: could not connect"]
        );
    }

    #[test]
    fn previous_connection_note_gives_way_to_current_connection_status() {
        let mut binding = binding();
        let labels = labels(&binding);
        let previous_generation = binding.generation.clone();
        let mut state = Diagnostics::default();
        state.replace(
            vec![LifecycleNote::connection(
                binding.id.as_str(),
                previous_generation.as_str(),
                "could not start",
            )],
            false,
        );
        binding.generation =
            ariadne_domain::models::UuidV4::new("00000000-0000-4000-8000-000000000099").unwrap();
        binding.connection_state = ConnectionState::Reconnecting;
        assert_eq!(
            state.render(&labels, std::slice::from_ref(&binding)),
            ["Notes sync: reconnecting"]
        );
        // Hiding display text never consumes recovery evidence.
        assert_eq!(state.rows().len(), 1);
        binding.connection_state = ConnectionState::Disconnected;
        assert_eq!(
            state.render(&labels, &[binding]),
            ["Notes sync: not connected"]
        );
    }

    #[test]
    fn late_previous_connection_note_cannot_hide_current_failure() {
        let binding = binding();
        let labels = labels(&binding);
        let mut state = Diagnostics::default();
        state.replace(
            vec![
                LifecycleNote::connection(
                    binding.id.as_str(),
                    "00000000-0000-4000-8000-000000000099",
                    "disconnected unexpectedly",
                ),
                LifecycleNote::connection(
                    binding.id.as_str(),
                    binding.generation.as_str(),
                    "could not connect",
                ),
                LifecycleNote::connection(
                    binding.id.as_str(),
                    binding.generation.as_str(),
                    "could not start",
                ),
            ],
            false,
        );
        assert_eq!(state.rows().len(), 2);
        assert_eq!(
            state.render(&labels, &[binding]),
            ["Notes sync: could not connect"]
        );
    }

    #[test]
    fn hidden_launch_outcomes_do_not_use_the_visible_note_limit() {
        let binding = binding();
        let mut state = Diagnostics::default();
        let mut notes: Vec<_> = (0..LIMIT + 2)
            .map(|index| LifecycleNote::binding(&format!("gone-{index}"), "could not start"))
            .collect();
        notes.push(LifecycleNote::binding(
            binding.id.as_str(),
            "could not connect",
        ));
        notes.push(general("Notifications are off."));
        state.replace(notes, false);
        assert_eq!(
            state.render(&labels(&binding), &[binding]),
            ["Notes sync: could not connect", "Notifications are off.",]
        );
    }
}
