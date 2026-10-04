use ariadne_agent_protocol::{EventPayload, NormalizedEvent};
use std::collections::VecDeque;

const TEXT_BYTES: usize = 64 * 1024;
const RING_BYTES: usize = 2 * 1024 * 1024;
const RECORDS: usize = 256;

#[derive(Debug, Clone, PartialEq)]
pub struct Diagnostic {
    pub event_id: String,
    pub text: String,
    pub truncated: bool,
    pub gap_before: bool,
}
#[derive(Default)]
pub(super) struct Diagnostics {
    records: VecDeque<Diagnostic>,
    bytes: usize,
}
impl Diagnostics {
    pub fn record(&mut self, event: &NormalizedEvent) {
        let (text, truncated, gap) = match &event.event {
            EventPayload::VisibleOutput {
                text,
                truncated,
                gap_before,
                ..
            } => (text, *truncated, *gap_before),
            EventPayload::TurnFinished {
                diagnostic_text: Some(text),
                truncated,
                ..
            } => (text, *truncated, false),
            _ => return,
        };
        // This display copy is defensive. Providers still own filtering private
        // reasoning/tool/auth data before the canonical event boundary.
        let mut redacted = String::new();
        for line in text.lines() {
            let lower = line.to_ascii_lowercase();
            let sensitive = [
                "authorization:",
                "bearer ",
                "api_key",
                "apikey",
                "password",
                "access_token",
                "secret=",
                "private reasoning",
                "tool arguments",
                "\"arguments\":",
                "environment=",
            ]
            .iter()
            .any(|key| lower.contains(key));
            if !redacted.is_empty() {
                redacted.push('\n');
            }
            redacted.push_str(if sensitive {
                "[redacted diagnostic]"
            } else {
                line
            });
        }
        let shortened = redacted.len() > TEXT_BYTES;
        if shortened {
            let mut end = TEXT_BYTES;
            while !redacted.is_char_boundary(end) {
                end -= 1;
            }
            redacted.truncate(end);
        }
        let mut gap_before = gap;
        while self.records.len() >= RECORDS || self.bytes + redacted.len() > RING_BYTES {
            let old = self
                .records
                .pop_front()
                .expect("ring budget requires a retained record");
            self.bytes -= old.text.len();
            gap_before = true;
        }
        if gap_before {
            if let Some(first) = self.records.front_mut() {
                first.gap_before = true;
            }
        }
        self.bytes += redacted.len();
        self.records.push_back(Diagnostic {
            event_id: event.event_id.clone(),
            text: redacted,
            truncated: truncated || shortened,
            gap_before,
        });
    }
    pub fn take(self) -> Vec<Diagnostic> {
        self.records.into_iter().collect()
    }
}
