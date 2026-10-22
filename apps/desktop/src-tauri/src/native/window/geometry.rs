use ariadne_core::{CoreError, CoreErrorCode, WindowGeometry};
use std::time::{Duration, Instant};

/// Trusted native monitor work area in logical pixels, excluding system UI.
#[derive(Clone, Debug)]
pub struct WorkArea {
    pub monitor_id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn valid_rectangle(x: f64, y: f64, width: f64, height: f64) -> bool {
    [x, y, width, height, x + width, y + height]
        .into_iter()
        .all(f64::is_finite)
        && width > 0.0
        && height > 0.0
}

fn overlap(window: &WindowGeometry, area: &WorkArea) -> f64 {
    let width =
        ((window.x + window.width).min(area.x + area.width) - window.x.max(area.x)).max(0.0);
    let height =
        ((window.y + window.height).min(area.y + area.height) - window.y.max(area.y)).max(0.0);
    // Comparison remains meaningful for valid but extremely large dimensions.
    width.min(f64::MAX.sqrt()) * height.min(f64::MAX.sqrt())
}

/// The smallest whole-frame size the window may take, in logical pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MinimumSize {
    pub width: f64,
    pub height: f64,
}

/// The work area a frame belongs to: its own monitor when that still exists,
/// else the one it overlaps most. The native caller orders the primary monitor
/// first; ties preserve that order.
pub fn select_area<'a>(frame: &WindowGeometry, areas: &'a [WorkArea]) -> Option<&'a WorkArea> {
    let first = areas.first()?;
    Some(
        areas
            .iter()
            .find(|area| frame.monitor_id.as_ref() == Some(&area.monitor_id))
            .unwrap_or_else(|| {
                areas.iter().fold(first, |best, candidate| {
                    if overlap(frame, candidate) > overlap(frame, best) {
                        candidate
                    } else {
                        best
                    }
                })
            }),
    )
}

/// The content minimum the window can really keep on `area`: the configured
/// minimum, but never more than the work area leaves after the window chrome
/// (title bar). Used for `set_min_size`; add `chrome` back for the whole-frame
/// minimum that `clamp_geometry` takes.
pub fn live_content_minimum(
    configured: MinimumSize,
    area: &WorkArea,
    chrome: MinimumSize,
) -> MinimumSize {
    MinimumSize {
        width: configured.width.min((area.width - chrome.width).max(0.0)),
        height: configured
            .height
            .min((area.height - chrome.height).max(0.0)),
    }
}

/// Slack for physical-to-logical rounding when comparing a frame to a work area.
const FIT_TOLERANCE: f64 = 1.0;
/// How much of the title bar's width must stay on a screen to grab it.
const REACHABLE_TITLE_WIDTH: f64 = 100.0;

/// Whether a window the owner has not asked to move still needs fitting: its
/// frame is larger than its work area, or its title bar cannot be grabbed (less
/// than 100 pt of its width, or not its full height, inside any monitor's work
/// area). A window dragged partly off-screen but still reachable is left alone.
/// Invalid evidence never asks for a fit.
pub fn needs_fit(frame: &WindowGeometry, areas: &[WorkArea], title_height: f64) -> bool {
    if !valid_rectangle(frame.x, frame.y, frame.width, frame.height)
        || !title_height.is_finite()
        || title_height < 0.0
        || areas
            .iter()
            .any(|area| !valid_rectangle(area.x, area.y, area.width, area.height))
    {
        return false;
    }
    let Some(area) = select_area(frame, areas) else {
        return false;
    };
    if frame.width > area.width + FIT_TOLERANCE || frame.height > area.height + FIT_TOLERANCE {
        return true;
    }
    let reachable = areas.iter().any(|area| {
        let shown = ((frame.x + frame.width).min(area.x + area.width) - frame.x.max(area.x))
            .min(frame.width);
        shown >= REACHABLE_TITLE_WIDTH.min(frame.width) - FIT_TOLERANCE
            && frame.y >= area.y - FIT_TOLERANCE
            && frame.y + title_height <= area.y + area.height + FIT_TOLERANCE
    });
    !reachable
}

/// What to do with a window frame on the current screens: the live content
/// minimum to set, and the fitted frame (None leaves the window where it is).
#[derive(Clone, Debug, PartialEq)]
pub struct FitPlan {
    pub content_minimum: MinimumSize,
    pub frame: Option<WindowGeometry>,
}

/// Plans a fit. `only_if_needed` is the wake and scale-change mode: a frame
/// that is on screen and reachable gets the live minimum but is never moved.
pub fn plan_fit(
    frame: &WindowGeometry,
    areas: &[WorkArea],
    chrome: MinimumSize,
    configured: MinimumSize,
    only_if_needed: bool,
) -> Result<FitPlan, CoreError> {
    let area = select_area(frame, areas).ok_or_else(|| {
        CoreError::new(
            CoreErrorCode::IoError,
            "No native monitor work area is available.",
            "Keep the existing window position and reconcile displays after wake.",
        )
    })?;
    let content_minimum = live_content_minimum(configured, area, chrome);
    let minimum = MinimumSize {
        width: content_minimum.width + chrome.width,
        height: content_minimum.height + chrome.height,
    };
    // A frame below the live minimum is grown from its origin by macOS once the
    // minimum is set, which can push it off the screen: fit it instead.
    let below_minimum = frame.width + FIT_TOLERANCE < minimum.width
        || frame.height + FIT_TOLERANCE < minimum.height;
    if only_if_needed && !below_minimum && !needs_fit(frame, areas, chrome.height) {
        return Ok(FitPlan {
            content_minimum,
            frame: None,
        });
    }
    Ok(FitPlan {
        content_minimum,
        frame: Some(clamp_geometry(frame, areas, minimum)?),
    })
}

/// Keep the whole saved window reachable after monitor removal or resize.
/// A saved size below `minimum` (one saved while minimized or mid-transition)
/// grows to it: macOS applies a restored size even under the window's minimum.
/// `minimum` is capped at the work area, so the window never outgrows its
/// screen; callers pass the live minimum (`live_content_minimum` plus chrome).
pub fn clamp_geometry(
    saved: &WindowGeometry,
    areas: &[WorkArea],
    minimum: MinimumSize,
) -> Result<WindowGeometry, CoreError> {
    if !valid_rectangle(saved.x, saved.y, saved.width, saved.height)
        || ![minimum.width, minimum.height]
            .into_iter()
            .all(|value| value.is_finite() && value >= 0.0)
        || areas.iter().any(|area| {
            !valid_rectangle(area.x, area.y, area.width, area.height) || area.monitor_id.is_empty()
        })
    {
        return Err(CoreError::new(
            CoreErrorCode::InvalidArgument,
            "Window and monitor geometry must be finite with positive dimensions, and the minimum size finite and non-negative.",
            "Read the current native monitor work areas before restoring the window.",
        ));
    }
    let area = select_area(saved, areas).ok_or_else(|| {
        CoreError::new(
            CoreErrorCode::IoError,
            "No native monitor work area is available.",
            "Keep the existing window position and reconcile displays after wake.",
        )
    })?;
    let width = saved
        .width
        .min(area.width)
        .max(minimum.width.min(area.width));
    let height = saved
        .height
        .min(area.height)
        .max(minimum.height.min(area.height));
    // `f64::clamp` panics when the window outgrows the area (min > max).
    let place = |saved: f64, start: f64, span: f64, size: f64| {
        if size >= span {
            start
        } else {
            saved.clamp(start, start + span - size)
        }
    };
    Ok(WindowGeometry {
        x: place(saved.x, area.x, area.width, width),
        y: place(saved.y, area.y, area.height, height),
        width,
        height,
        monitor_id: Some(area.monitor_id.clone()),
    })
}

/// How long saving stays quiet after the app fits the window or shows it for
/// the first time: macOS delivers the fit's Resized and Moved events late.
pub const FIT_QUIET: Duration = Duration::from_secs(1);
/// How long saving stays quiet after the displays change.
pub const DISPLAY_QUIET: Duration = Duration::from_secs(2);

/// One monitor as the displays report it. The id is `name@x,y`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct MonitorPrint {
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub scale_milli: i64,
}

/// What the displays looked like at a window event.
#[derive(Clone, Debug)]
pub struct DisplayState {
    pub monitors: Vec<MonitorPrint>,
    /// The id of the monitor the window is on, when known.
    pub current: Option<String>,
}

/// Decides whether a window move or resize is the owner's, so it may be saved.
/// The app's own fits, the first show and display changes are never saved: the
/// gate stays closed for a while after each, and when the displays change.
#[derive(Debug, Default)]
pub struct SaveGate {
    quiet_until: Option<Instant>,
    fingerprint: Option<Vec<MonitorPrint>>,
    current: Option<String>,
}

impl SaveGate {
    /// Keeps saving quiet until `span` after `now`. A later hush extends an
    /// earlier one; it never shortens it.
    pub fn hush(&mut self, now: Instant, span: Duration) {
        let until = now + span;
        if self.quiet_until.is_none_or(|current| current < until) {
            self.quiet_until = Some(until);
        }
    }

    /// Records the monitors. The first call only seeds the fingerprint. Later,
    /// a different set (in any order) hushes for `DISPLAY_QUIET` and returns true.
    pub fn monitors(&mut self, now: Instant, monitors: &[MonitorPrint]) -> bool {
        let mut sorted = monitors.to_vec();
        sorted.sort();
        let changed = self
            .fingerprint
            .as_ref()
            .is_some_and(|known| *known != sorted);
        self.fingerprint = Some(sorted);
        if changed {
            self.hush(now, DISPLAY_QUIET);
        }
        changed
    }

    /// Records the monitor the window is on. When the one recorded before is no
    /// longer among `monitors`, hushes for `DISPLAY_QUIET` and returns true.
    pub fn current_monitor(
        &mut self,
        now: Instant,
        current: Option<String>,
        monitors: &[MonitorPrint],
    ) -> bool {
        let previous = std::mem::replace(&mut self.current, current);
        let gone = previous.is_some_and(|id| !monitors.iter().any(|monitor| monitor.id == id));
        if gone {
            self.hush(now, DISPLAY_QUIET);
        }
        gone
    }

    /// Whether the gate is open at `now`.
    pub fn allows(&self, now: Instant) -> bool {
        self.quiet_until.is_none_or(|until| now >= until)
    }

    /// Records the displays. When the set changed, or the monitor recorded
    /// before is gone, hushes for `DISPLAY_QUIET` and returns true.
    pub fn observe(&mut self, now: Instant, display: &DisplayState) -> bool {
        let changed = self.monitors(now, &display.monitors);
        let gone = self.current_monitor(now, display.current.clone(), &display.monitors);
        changed || gone
    }

    /// Records the displays without hushing: for a window that was hidden, so
    /// changes made meanwhile do not hush the owner's first move after it shows.
    pub fn refresh(&mut self, display: &DisplayState) {
        let mut sorted = display.monitors.clone();
        sorted.sort();
        self.fingerprint = Some(sorted);
        self.current = display.current.clone();
    }

    /// Whether a window event at `now` may be saved. Not when the displays could
    /// not be read, when they just changed, or while the gate is hushed.
    pub fn admit(&mut self, now: Instant, display: Option<DisplayState>) -> bool {
        let Some(display) = display else {
            return false;
        };
        let changed = self.observe(now, &display);
        !changed && self.allows(now)
    }
}

#[cfg(test)]
#[path = "tests/geometry.rs"]
mod tests;
