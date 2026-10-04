use super::capture::{WaitingCapture, WaitingRow};
use ariadne_core::{GlobalPreferences, NOTIFICATION_LEDGER_CAPACITY};
use ariadne_domain::models::{Completeness, UtcMillis};

pub struct NotificationPlan {
    pub preferences: GlobalPreferences,
    pub arrivals: Vec<WaitingRow>,
    pub diagnostic: Option<&'static str>,
}

/// Plan observation, not durable notification delivery. The owning feed must
/// confirm the canonical preferences patch before scheduling these arrivals.
pub fn evaluate(
    global: &GlobalPreferences,
    capture: &WaitingCapture,
    now: UtcMillis,
) -> NotificationPlan {
    let complete = capture.counts.completeness == Completeness::Complete;
    let mut preferences = global.clone();
    let mut arrivals = Vec::new();
    if global.notification_watermark.is_none() && !complete {
        return NotificationPlan {
            preferences,
            arrivals,
            diagnostic: Some("Notifications await a complete registered queue baseline."),
        };
    }
    let watermark = global.notification_watermark.clone();
    let eligible: Vec<_> = capture
        .rows
        .iter()
        .filter(|row| {
            watermark
                .as_ref()
                .is_none_or(|watermark| &row.waiting_since >= watermark)
        })
        .collect();
    if watermark.is_some() {
        arrivals = eligible
            .iter()
            .filter(|row| !global.notification_ledger.contains(&row.episode))
            .map(|row| (*row).clone())
            .collect();
    }
    if complete {
        let next = eligible
            .iter()
            .map(|row| row.waiting_since.clone())
            .max()
            .or(watermark.clone())
            .unwrap_or(now);
        preferences.notification_ledger = eligible
            .iter()
            .filter(|row| row.waiting_since == next)
            .map(|row| row.episode.clone())
            .collect();
        preferences.notification_watermark = Some(next);
    } else {
        preferences
            .notification_ledger
            .extend(arrivals.iter().map(|row| row.episode.clone()));
    }
    if preferences.notification_ledger.len() > NOTIFICATION_LEDGER_CAPACITY {
        return NotificationPlan { preferences: global.clone(), arrivals: vec![],
            diagnostic: Some("Notification history is full; a complete queue capture is required before more notifications.") };
    }
    NotificationPlan {
        preferences,
        arrivals,
        diagnostic: None,
    }
}
