use ariadne_core::{CoreError, CoreErrorCode, WindowGeometry};

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
    if only_if_needed && !needs_fit(frame, areas, chrome.height) {
        return Ok(FitPlan {
            content_minimum,
            frame: None,
        });
    }
    let minimum = MinimumSize {
        width: content_minimum.width + chrome.width,
        height: content_minimum.height + chrome.height,
    };
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

#[cfg(test)]
#[path = "tests/geometry.rs"]
mod tests;
