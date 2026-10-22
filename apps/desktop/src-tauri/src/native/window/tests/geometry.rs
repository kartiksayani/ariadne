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

#[test]
fn wake_fits_a_frame_below_the_live_minimum_so_it_cannot_grow_off_screen() {
    let areas = [area("primary", 0.0, 25.0, 1440.0, 875.0)];
    // Reachable and on screen, but narrower than the 1100 minimum and near the
    // right edge: macOS would grow it from its origin past the edge.
    let narrow = window(1300.0, 100.0, 900.0, 800.0, Some("primary"));
    assert!(!needs_fit(&narrow, &areas, CHROME.height));
    let plan = plan_fit(&narrow, &areas, CHROME, CONFIGURED, true).unwrap();
    assert_eq!(plan.content_minimum, CONFIGURED);
    assert_eq!(
        plan.frame,
        Some(window(340.0, 100.0, 1100.0, 800.0, Some("primary")))
    );
    // A frame at or above the minimum is still left alone.
    let fine = window(300.0, 100.0, 1100.0, 788.0, Some("primary"));
    assert_eq!(
        plan_fit(&fine, &areas, CHROME, CONFIGURED, true)
            .unwrap()
            .frame,
        None
    );
}

fn print(id: &str, width: u32, height: u32, scale_milli: i64) -> MonitorPrint {
    MonitorPrint {
        id: id.into(),
        width,
        height,
        scale_milli,
    }
}
fn laptop() -> MonitorPrint {
    print("Built-in@0,0", 3024, 1964, 2000)
}
fn external() -> MonitorPrint {
    print("Studio@3024,0", 5120, 2880, 2000)
}
fn display(monitors: Vec<MonitorPrint>, current: &str) -> Option<DisplayState> {
    Some(DisplayState {
        monitors,
        current: Some(current.into()),
    })
}
fn secs(base: Instant, seconds: f64) -> Instant {
    base + Duration::from_secs_f64(seconds)
}

#[test]
fn save_gate_is_open_until_hushed_and_closed_until_the_deadline() {
    let base = Instant::now();
    let mut gate = SaveGate::default();
    assert!(gate.allows(base));
    gate.hush(base, FIT_QUIET);
    assert!(!gate.allows(base));
    assert!(!gate.allows(secs(base, 0.999)));
    assert!(gate.allows(secs(base, 1.0)));
    assert!(gate.allows(secs(base, 5.0)));
}

#[test]
fn a_second_hush_extends_the_quiet_window_and_never_shortens_it() {
    let base = Instant::now();
    let mut gate = SaveGate::default();
    gate.hush(base, FIT_QUIET);
    // Two fits in a row: the second one starts its own second.
    gate.hush(secs(base, 0.6), FIT_QUIET);
    assert!(!gate.allows(secs(base, 1.5)));
    assert!(gate.allows(secs(base, 1.6)));
    // A shorter hush inside a longer one changes nothing.
    gate.hush(base, DISPLAY_QUIET);
    gate.hush(secs(base, 0.1), FIT_QUIET);
    assert!(!gate.allows(secs(base, 1.9)));
    assert!(gate.allows(secs(base, 2.0)));
}

#[test]
fn the_first_fingerprint_only_seeds_and_an_unchanged_one_does_not_hush() {
    let base = Instant::now();
    let mut gate = SaveGate::default();
    assert!(!gate.monitors(base, &[laptop(), external()]));
    assert!(gate.allows(base));
    assert!(!gate.monitors(secs(base, 3.0), &[laptop(), external()]));
    assert!(gate.allows(secs(base, 3.0)));
}

#[test]
fn a_changed_fingerprint_hushes_and_reports_changed_whatever_the_order() {
    let base = Instant::now();
    let mut gate = SaveGate::default();
    gate.monitors(base, &[laptop(), external()]);
    // The same monitors in another order are not a change.
    assert!(!gate.monitors(secs(base, 1.0), &[external(), laptop()]));
    assert!(gate.allows(secs(base, 1.0)));
    // Unplugging the external display is.
    assert!(gate.monitors(secs(base, 2.0), &[laptop()]));
    assert!(!gate.allows(secs(base, 2.0)));
    assert!(!gate.allows(secs(base, 3.9)));
    assert!(gate.allows(secs(base, 4.0)));
    // The new set is the one that counts now.
    assert!(!gate.monitors(secs(base, 5.0), &[laptop()]));
    // So are a different size or scale of the same monitor.
    assert!(gate.monitors(secs(base, 6.0), &[print("Built-in@0,0", 1512, 982, 2000)]));
    assert!(gate.monitors(secs(base, 7.0), &[print("Built-in@0,0", 1512, 982, 1000)]));
    // And a monitor that moved in the arrangement.
    assert!(gate.monitors(secs(base, 8.0), &[print("Built-in@10,0", 1512, 982, 1000)]));
}

#[test]
fn a_current_monitor_that_is_gone_hushes_and_one_still_connected_does_not() {
    let base = Instant::now();
    let both = [laptop(), external()];
    let mut gate = SaveGate::default();
    assert!(!gate.current_monitor(base, Some(external().id), &both));
    // The owner drags to the laptop screen; both are still connected.
    assert!(!gate.current_monitor(secs(base, 1.0), Some(laptop().id), &both));
    assert!(gate.allows(secs(base, 1.0)));
    // Back on the external display, which is then unplugged.
    assert!(!gate.current_monitor(secs(base, 2.0), Some(external().id), &both));
    assert!(gate.current_monitor(secs(base, 3.0), Some(laptop().id), &[laptop()]));
    assert!(!gate.allows(secs(base, 4.9)));
    assert!(gate.allows(secs(base, 5.0)));
    // An event without a known monitor never counts as a change.
    assert!(!gate.current_monitor(secs(base, 6.0), None, &[laptop()]));
    assert!(!gate.current_monitor(secs(base, 7.0), Some(laptop().id), &[laptop()]));
}

#[test]
fn an_event_is_admitted_only_with_readable_displays_and_an_open_gate() {
    let base = Instant::now();
    let both = vec![laptop(), external()];
    let mut gate = SaveGate::default();
    // Seeded at launch.
    gate.monitors(base, &both);
    // First owner move, same displays: saved.
    assert!(gate.admit(secs(base, 10.0), display(both.clone(), &external().id)));
    // Enumeration failed: skipped, and the gate is untouched.
    assert!(!gate.admit(secs(base, 11.0), None));
    assert!(gate.admit(secs(base, 12.0), display(both.clone(), &external().id)));
    // A fit hushes: skipped until the quiet window ends.
    gate.hush(secs(base, 13.0), FIT_QUIET);
    assert!(!gate.admit(secs(base, 13.5), display(both.clone(), &external().id)));
    assert!(gate.admit(secs(base, 14.0), display(both.clone(), &external().id)));
}

#[test]
fn an_unplug_before_any_owner_move_is_hushed_by_the_seeded_fingerprint() {
    let base = Instant::now();
    let mut gate = SaveGate::default();
    gate.monitors(base, &[laptop(), external()]);
    // macOS relocated the window to the laptop screen: first event after unplug.
    assert!(!gate.admit(secs(base, 20.0), display(vec![laptop()], &laptop().id)));
    assert!(!gate.admit(secs(base, 21.9), display(vec![laptop()], &laptop().id)));
    assert!(gate.admit(secs(base, 22.0), display(vec![laptop()], &laptop().id)));
}

#[test]
fn a_monitor_that_vanished_from_the_list_hushes_even_with_the_same_fingerprint() {
    let base = Instant::now();
    let mut gate = SaveGate::default();
    gate.monitors(base, &[laptop()]);
    assert!(gate.admit(base, display(vec![laptop()], &external().id)));
    // The previous event's monitor is not in the list now, and the list did not
    // change since: still a display change.
    assert!(!gate.admit(secs(base, 1.0), display(vec![laptop()], &laptop().id)));
    assert!(!gate.admit(secs(base, 2.9), display(vec![laptop()], &laptop().id)));
    assert!(gate.admit(secs(base, 3.0), display(vec![laptop()], &laptop().id)));
}
