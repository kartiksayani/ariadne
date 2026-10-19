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
/// tauri.conf.json's 1100x760 content minimum plus a 28px title bar.
const APP: MinimumSize = MinimumSize {
    width: 1100.0,
    height: 788.0,
};
const CHROME: MinimumSize = MinimumSize {
    width: 0.0,
    height: 28.0,
};
const CONFIGURED: MinimumSize = MinimumSize {
    width: 1100.0,
    height: 760.0,
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
        window(820.0, 292.0, 1100.0, 788.0, Some("primary"))
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
fn a_work_area_smaller_than_the_minimum_caps_the_window_at_the_area() {
    // Narrower than the minimum, in width only.
    let saved = window(300.0, 400.0, 1600.0, 960.0, Some("small"));
    let restored =
        clamp_geometry(&saved, &[area("small", 10.0, 25.0, 1000.0, 875.0)], APP).unwrap();
    assert_eq!(restored, window(10.0, 25.0, 1000.0, 875.0, Some("small")));
    // Shorter than the minimum, in height only.
    let restored =
        clamp_geometry(&saved, &[area("small", 10.0, 25.0, 1412.0, 700.0)], APP).unwrap();
    assert_eq!(restored, window(10.0, 25.0, 1412.0, 700.0, Some("small")));
    // Both, and a tiny saved size: still no larger than the area, at its corner.
    let tiny = window(5000.0, 5000.0, 100.0, 100.0, Some("small"));
    let restored = clamp_geometry(&tiny, &[area("small", 10.0, 25.0, 1000.0, 700.0)], APP).unwrap();
    assert_eq!(restored, window(10.0, 25.0, 1000.0, 700.0, Some("small")));
}

#[test]
fn a_lowered_live_minimum_is_honoured_and_a_roomy_area_keeps_the_configured_one() {
    let small = area("small", 0.0, 25.0, 1000.0, 700.0);
    let live = live_content_minimum(CONFIGURED, &small, CHROME);
    assert_eq!(
        live,
        MinimumSize {
            width: 1000.0,
            height: 672.0
        }
    );
    let frame = MinimumSize {
        width: live.width + CHROME.width,
        height: live.height + CHROME.height,
    };
    let tiny = window(0.0, 25.0, 300.0, 200.0, Some("small"));
    let restored = clamp_geometry(&tiny, &[small], frame).unwrap();
    assert_eq!(restored, window(0.0, 25.0, 1000.0, 700.0, Some("small")));
    // A roomy area leaves the configured minimum as it was.
    let roomy = area("roomy", 0.0, 25.0, 1920.0, 1055.0);
    assert_eq!(live_content_minimum(CONFIGURED, &roomy, CHROME), CONFIGURED);
    // A lowered minimum below the area is used as given, not raised to the configured one.
    let lowered = MinimumSize {
        width: 900.0,
        height: 600.0,
    };
    let restored = clamp_geometry(&tiny, &[roomy], lowered).unwrap();
    assert_eq!(restored.width, 900.0);
    assert_eq!(restored.height, 600.0);
}

#[test]
fn first_launch_default_frame_is_fitted_to_the_screen() {
    // The owner's case: a 1600x960 default on a ~1412 pt wide screen.
    let default = window(0.0, 0.0, 1600.0, 960.0, Some("laptop"));
    let laptop = area("laptop", 0.0, 25.0, 1412.0, 887.0);
    let live = live_content_minimum(CONFIGURED, &laptop, CHROME);
    let frame = MinimumSize {
        width: live.width + CHROME.width,
        height: live.height + CHROME.height,
    };
    assert!(needs_fit(
        &default,
        std::slice::from_ref(&laptop),
        CHROME.height
    ));
    let fitted = clamp_geometry(&default, &[laptop], frame).unwrap();
    assert_eq!(fitted, window(0.0, 25.0, 1412.0, 887.0, Some("laptop")));
    // A big screen keeps the default size and only moves it inside.
    let big = area("big", 0.0, 25.0, 2560.0, 1415.0);
    let kept = clamp_geometry(&default, &[big], APP).unwrap();
    assert_eq!(kept, window(0.0, 25.0, 1600.0, 960.0, Some("big")));
}

#[test]
fn needs_fit_is_true_for_an_oversized_frame_or_an_unreachable_title_bar() {
    let primary = area("primary", 0.0, 25.0, 1440.0, 875.0);
    let areas = [primary];
    let fit = |frame: WindowGeometry| needs_fit(&frame, &areas, 28.0);
    // Larger than the work area, in each axis.
    assert!(fit(window(0.0, 25.0, 1600.0, 800.0, Some("primary"))));
    assert!(fit(window(0.0, 25.0, 1200.0, 900.0, Some("primary"))));
    // Rounding slack is not oversize.
    assert!(!fit(window(0.0, 25.0, 1440.5, 875.0, Some("primary"))));
    // Title bar under the menu bar, below the screen, or with under 100 pt in view.
    assert!(fit(window(100.0, 0.0, 800.0, 600.0, Some("primary"))));
    assert!(fit(window(100.0, 890.0, 800.0, 600.0, Some("primary"))));
    assert!(fit(window(1400.0, 100.0, 800.0, 600.0, Some("primary"))));
    assert!(fit(window(-750.0, 100.0, 800.0, 600.0, Some("primary"))));
    assert!(fit(window(3000.0, 100.0, 800.0, 600.0, Some("primary"))));
}

#[test]
fn needs_fit_leaves_a_partly_off_screen_window_that_can_still_be_grabbed() {
    let areas = [area("primary", 0.0, 25.0, 1440.0, 875.0)];
    // 400 pt hanging off the right edge, title bar fully inside vertically.
    let right = window(1000.0, 100.0, 840.0, 600.0, Some("primary"));
    assert!(!needs_fit(&right, &areas, 28.0));
    // Mostly off the left edge, exactly 100 pt of title bar showing.
    let left = window(-700.0, 100.0, 800.0, 600.0, Some("primary"));
    assert!(!needs_fit(&left, &areas, 28.0));
    // Body hanging below the screen with the title bar inside.
    let below = window(100.0, 600.0, 800.0, 600.0, Some("primary"));
    assert!(!needs_fit(&below, &areas, 28.0));
}

#[test]
fn needs_fit_counts_any_monitor_for_reachability_and_ignores_bad_evidence() {
    let areas = [
        area("primary", 0.0, 25.0, 1440.0, 875.0),
        area("right", 1440.0, 25.0, 1920.0, 1055.0),
    ];
    // Entirely on the second monitor.
    let on_right = window(1600.0, 100.0, 1000.0, 700.0, Some("right"));
    assert!(!needs_fit(&on_right, &areas, 28.0));
    // Straddling the join is reachable on either side.
    let straddle = window(1000.0, 100.0, 900.0, 700.0, Some("primary"));
    assert!(!needs_fit(&straddle, &areas, 28.0));
    // No monitors, a bad frame, or a bad title height never asks for a fit.
    assert!(!needs_fit(&on_right, &[], 28.0));
    assert!(!needs_fit(
        &window(f64::NAN, 0.0, 100.0, 100.0, None),
        &areas,
        28.0
    ));
    assert!(!needs_fit(&on_right, &areas, f64::NAN));
}

#[test]
fn wake_and_scale_refit_only_what_needs_it_and_leave_a_reachable_window_where_it_is() {
    let areas = [area("primary", 0.0, 25.0, 1440.0, 875.0)];
    // The owner dragged the window partly off the right edge: unchanged.
    let dragged = window(1000.0, 100.0, 1200.0, 800.0, Some("primary"));
    let plan = plan_fit(&dragged, &areas, CHROME, CONFIGURED, true).unwrap();
    assert_eq!(plan.frame, None);
    assert_eq!(plan.content_minimum, CONFIGURED);
    // A frame wider than the screen is brought inside at a size that fits.
    let wide = window(0.0, 25.0, 1600.0, 960.0, Some("primary"));
    let plan = plan_fit(&wide, &areas, CHROME, CONFIGURED, true).unwrap();
    assert_eq!(
        plan.frame,
        Some(window(0.0, 25.0, 1440.0, 875.0, Some("primary")))
    );
    // An unreachable title bar is moved inside without resizing.
    let lost = window(3000.0, 100.0, 1200.0, 800.0, Some("primary"));
    let plan = plan_fit(&lost, &areas, CHROME, CONFIGURED, true).unwrap();
    assert_eq!(
        plan.frame,
        Some(window(240.0, 100.0, 1200.0, 800.0, Some("primary")))
    );
    // Launch mode always places the frame, inside the screen.
    let plan = plan_fit(&dragged, &areas, CHROME, CONFIGURED, false).unwrap();
    assert_eq!(
        plan.frame,
        Some(window(240.0, 100.0, 1200.0, 800.0, Some("primary")))
    );
    // The minimum still follows a small screen when the window is left alone.
    let small = [area("small", 0.0, 25.0, 1000.0, 700.0)];
    let plan = plan_fit(
        &window(0.0, 25.0, 1000.0, 700.0, Some("small")),
        &small,
        CHROME,
        CONFIGURED,
        true,
    )
    .unwrap();
    assert_eq!(plan.frame, None);
    assert_eq!(
        plan.content_minimum,
        MinimumSize {
            width: 1000.0,
            height: 672.0
        }
    );
    // No screens: an error, never a guessed frame.
    assert_eq!(
        plan_fit(&dragged, &[], CHROME, CONFIGURED, true)
            .unwrap_err()
            .code,
        CoreErrorCode::IoError
    );
}

#[test]
fn select_area_prefers_the_saved_monitor_then_the_largest_overlap() {
    let areas = [
        area("primary", 0.0, 25.0, 1440.0, 875.0),
        area("left", -1200.0, 0.0, 1200.0, 800.0),
    ];
    let by_id = window(100.0, 100.0, 500.0, 500.0, Some("left"));
    assert_eq!(select_area(&by_id, &areas).unwrap().monitor_id, "left");
    let by_overlap = window(-950.0, 50.0, 600.0, 500.0, Some("gone"));
    assert_eq!(select_area(&by_overlap, &areas).unwrap().monitor_id, "left");
    assert!(select_area(&by_id, &[]).is_none());
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
