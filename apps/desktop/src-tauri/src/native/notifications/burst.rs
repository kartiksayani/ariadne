use super::capture::WaitingRow;
use std::time::{Duration, Instant};

pub(crate) const BURST_WINDOW: Duration = Duration::from_millis(500);

#[derive(Default)]
pub(crate) struct Burst {
    deadline: Option<Instant>,
    rows: Vec<WaitingRow>,
}

impl Burst {
    pub(crate) fn push(&mut self, rows: Vec<WaitingRow>, now: Instant) {
        for row in rows {
            if !self.rows.iter().any(|old| old.episode == row.episode) {
                self.deadline.get_or_insert(now + BURST_WINDOW);
                self.rows.push(row);
            }
        }
    }
    pub(crate) fn deadline(&self) -> Option<Instant> {
        self.deadline
    }
    /// A question resolved or replaced before scheduling no longer announces.
    /// Partial captures cannot prove absence in an unavailable registered root.
    pub(crate) fn retain(&mut self, rows: &[WaitingRow], complete: bool) {
        if complete {
            self.rows
                .retain(|old| rows.iter().any(|row| row.episode == old.episode));
        }
    }
    pub(crate) fn take_due(&mut self, now: Instant) -> Option<Vec<WaitingRow>> {
        if self.deadline.is_none_or(|deadline| now < deadline) {
            return None;
        }
        self.deadline = None;
        Some(std::mem::take(&mut self.rows))
    }
}

pub(crate) struct Announcement {
    pub identifier: String,
    pub title: String,
    pub body: String,
    pub route: ariadne_core::OpenRoute,
}

pub(crate) fn announcements(rows: &[WaitingRow], preview: bool) -> Vec<Announcement> {
    if rows.len() > 3 {
        let first = &rows[0];
        return vec![Announcement {
            identifier: format!("{}:burst", first.identifier()),
            title: "Ariadne".into(),
            body: format!("{} questions are waiting for your answer.", rows.len()),
            route: first.route(),
        }];
    }
    rows.iter()
        .map(|row| Announcement {
            identifier: row.identifier(),
            title: "Ariadne".into(),
            body: if preview {
                row.question.chars().take(240).collect()
            } else {
                "A question is waiting for your answer.".into()
            },
            route: row.route(),
        })
        .collect()
}
