use super::capture::{WaitingCapture, WaitingRow};
use ariadne_domain::models::Completeness;

#[derive(Debug, Clone)]
pub struct TrayProjection {
    pub title: String,
    pub oldest: Vec<WaitingRow>,
    pub diagnostics: Vec<String>,
}

impl TrayProjection {
    /// Counts are authoritative even when rows or local filters differ. Binding
    /// and owning lifecycle diagnostics never increment the unanswered count.
    pub fn from_capture(capture: &WaitingCapture, lifecycle_diagnostics: &[String]) -> Self {
        let count = capture.counts.waiting_unanswered.value();
        let mut title = if count == 0 {
            String::new()
        } else {
            count.to_string()
        };
        if capture.counts.completeness == Completeness::Partial {
            title.push('*');
        }
        let mut diagnostics = capture.diagnostics.clone();
        diagnostics.extend_from_slice(lifecycle_diagnostics);
        Self {
            title,
            oldest: capture.rows.iter().take(10).cloned().collect(),
            diagnostics,
        }
    }
}
