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
const NONE: MinimumSize = MinimumSize {
    width: 0.0,
    height: 0.0,
};
/// tauri.conf.json's 1300x760 content minimum plus a 28px title bar.
const APP: MinimumSize = MinimumSize {
    width: 1300.0,
    height: 788.0,
};

#[test]
fn display_removal_moves_unreachable_window_to_primary_work_area() {
    let saved = window(2400.0, -200.0, 900.0, 650.0, Some("removed"));
    let restored =
        clamp_geometry(&saved, &[area("primary", 0.0, 25.0, 1440.0, 875.0)], NONE).unwrap();
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
        NONE,
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
        NONE,
    )
    .unwrap();
    assert_eq!(restored, window(-950.0, 50.0, 600.0, 500.0, Some("left")));
}

#[test]
fn a_tiny_saved_size_grows_to_the_window_minimum_and_stays_on_screen() {
    // A "biscuit" saved while minimized or mid full-screen transition.
    let saved = window(1700.0, 700.0, 180.0, 120.0, Some("primary"));
    let restored =
        clamp_geometry(&saved, &[area("primary", 0.0, 25.0, 1920.0, 1055.0)], APP).unwrap();
    assert_eq!(
        restored,
        window(620.0, 292.0, 1300.0, 788.0, Some("primary"))
    );
    // Only one dimension below its minimum keeps the other as saved.
    let saved = window(100.0, 100.0, 1500.0, 300.0, Some("primary"));
    let restored =
        clamp_geometry(&saved, &[area("primary", 0.0, 25.0, 1920.0, 1055.0)], APP).unwrap();
    assert_eq!(
        restored,
        window(100.0, 100.0, 1500.0, 788.0, Some("primary"))
    );
}

#[test]
fn a_work_area_smaller_than_the_minimum_pins_the_window_to_its_corner() {
    let saved = window(300.0, 400.0, 1600.0, 960.0, Some("small"));
    let restored =
        clamp_geometry(&saved, &[area("small", 10.0, 25.0, 1280.0, 775.0)], APP).unwrap();
    assert_eq!(restored, window(10.0, 25.0, 1300.0, 788.0, Some("small")));
    // Exactly the area's size also sits at its corner.
    let fitted = MinimumSize {
        width: 1280.0,
        height: 775.0,
    };
    let restored =
        clamp_geometry(&saved, &[area("small", 10.0, 25.0, 1280.0, 775.0)], fitted).unwrap();
    assert_eq!(restored, window(10.0, 25.0, 1280.0, 775.0, Some("small")));
}

#[test]
fn unavailable_or_invalid_monitor_evidence_does_not_fabricate_geometry() {
    let saved = window(10.0, 20.0, 900.0, 650.0, None);
    assert_eq!(
        clamp_geometry(&saved, &[], NONE).unwrap_err().code,
        CoreErrorCode::IoError
    );
    for invalid in [
        area("main", f64::NAN, 0.0, 100.0, 100.0),
        area("main", 0.0, 0.0, 0.0, 100.0),
    ] {
        assert_eq!(
            clamp_geometry(&saved, &[invalid], NONE).unwrap_err().code,
            CoreErrorCode::InvalidArgument
        );
    }
    let invalid = window(f64::MAX, 0.0, f64::MAX, 100.0, None);
    assert!(clamp_geometry(&invalid, &[area("main", 0.0, 0.0, 100.0, 100.0)], NONE).is_err());
    for minimum in [
        MinimumSize {
            width: f64::NAN,
            height: 0.0,
        },
        MinimumSize {
            width: 0.0,
            height: -1.0,
        },
    ] {
        assert_eq!(
            clamp_geometry(&saved, &[area("main", 0.0, 0.0, 100.0, 100.0)], minimum)
                .unwrap_err()
                .code,
            CoreErrorCode::InvalidArgument
        );
    }
}
