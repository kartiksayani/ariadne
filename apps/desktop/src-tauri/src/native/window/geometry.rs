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

/// Keep the whole saved window reachable after monitor removal or resize.
/// The native caller orders the primary monitor first; ties preserve that order.
pub fn clamp_geometry(
    saved: &WindowGeometry,
    areas: &[WorkArea],
) -> Result<WindowGeometry, CoreError> {
    if !valid_rectangle(saved.x, saved.y, saved.width, saved.height)
        || areas.iter().any(|area| {
            !valid_rectangle(area.x, area.y, area.width, area.height) || area.monitor_id.is_empty()
        })
    {
        return Err(CoreError::new(
            CoreErrorCode::InvalidArgument,
            "Window and monitor geometry must be finite with positive dimensions.",
            "Read the current native monitor work areas before restoring the window.",
        ));
    }
    let first = areas.first().ok_or_else(|| {
        CoreError::new(
            CoreErrorCode::IoError,
            "No native monitor work area is available.",
            "Keep the existing window position and reconcile displays after wake.",
        )
    })?;
    let area = areas
        .iter()
        .find(|area| saved.monitor_id.as_ref() == Some(&area.monitor_id))
        .unwrap_or_else(|| {
            areas.iter().fold(first, |best, candidate| {
                if overlap(saved, candidate) > overlap(saved, best) {
                    candidate
                } else {
                    best
                }
            })
        });
    let width = saved.width.min(area.width);
    let height = saved.height.min(area.height);
    Ok(WindowGeometry {
        x: saved.x.clamp(area.x, area.x + area.width - width),
        y: saved.y.clamp(area.y, area.y + area.height - height),
        width,
        height,
        monitor_id: Some(area.monitor_id.clone()),
    })
}

#[cfg(test)]
#[path = "tests/geometry.rs"]
mod tests;
