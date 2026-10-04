use super::*;

fn area(id: &str, x: f64, y: f64, width: f64, height: f64) -> WorkArea {
    WorkArea {
        monitor_id: id.into(),
        x,
        y,
        width,
        height,
    }
}
fn window(x: f64, y: f64, width: f64, height: f64, monitor: Option<&str>) -> WindowGeometry {
    WindowGeometry {
        x,
        y,
        width,
        height,
        monitor_id: monitor.map(str::to_owned),
    }
}

#[test]
fn display_removal_moves_unreachable_window_to_primary_work_area() {
    let saved = window(2400.0, -200.0, 900.0, 650.0, Some("removed"));
    let restored = clamp_geometry(&saved, &[area("primary", 0.0, 25.0, 1440.0, 875.0)]).unwrap();
    assert_eq!(restored, window(540.0, 25.0, 900.0, 650.0, Some("primary")));
}

#[test]
fn surviving_monitor_wins_and_smaller_work_area_clamps_dimensions() {
    let saved = window(-1500.0, -400.0, 1800.0, 1100.0, Some("left"));
    let restored = clamp_geometry(
        &saved,
        &[
            area("primary", 0.0, 25.0, 1440.0, 875.0),
            area("left", -1200.0, 0.0, 1200.0, 800.0),
        ],
    )
    .unwrap();
    assert_eq!(restored, window(-1200.0, 0.0, 1200.0, 800.0, Some("left")));
}

#[test]
fn missing_monitor_identity_uses_greatest_existing_intersection() {
    let saved = window(-950.0, 50.0, 600.0, 500.0, None);
    let restored = clamp_geometry(
        &saved,
        &[
            area("primary", 0.0, 25.0, 1440.0, 875.0),
            area("left", -1200.0, 0.0, 1200.0, 800.0),
        ],
    )
    .unwrap();
    assert_eq!(restored, window(-950.0, 50.0, 600.0, 500.0, Some("left")));
}

#[test]
fn unavailable_or_invalid_monitor_evidence_does_not_fabricate_geometry() {
    let saved = window(10.0, 20.0, 900.0, 650.0, None);
    assert_eq!(
        clamp_geometry(&saved, &[]).unwrap_err().code,
        CoreErrorCode::IoError
    );
    for invalid in [
        area("main", f64::NAN, 0.0, 100.0, 100.0),
        area("main", 0.0, 0.0, 0.0, 100.0),
    ] {
        assert_eq!(
            clamp_geometry(&saved, &[invalid]).unwrap_err().code,
            CoreErrorCode::InvalidArgument
        );
    }
    let invalid = window(f64::MAX, 0.0, f64::MAX, 100.0, None);
    assert!(clamp_geometry(&invalid, &[area("main", 0.0, 0.0, 100.0, 100.0)]).is_err());
}
