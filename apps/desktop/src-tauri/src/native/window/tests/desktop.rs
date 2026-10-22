use super::*;

fn saved() -> WindowGeometry {
    WindowGeometry {
        x: 10.0,
        y: 20.0,
        width: 1200.0,
        height: 800.0,
        monitor_id: Some("primary".into()),
    }
}

#[test]
fn launch_fits_the_current_frame_until_the_saved_one_arrives() {
    // Before the read returns (or when it fails or is stale) there is no saved
    // frame: the window's own frame is fitted, so a slow read never shows it
    // unfitted. The saved frame replaces that once it arrives.
    assert_eq!(
        fit_frame(Fit::Launch, None),
        Some(FitFrame::Current {
            only_if_needed: false
        })
    );
    let frame = saved();
    assert_eq!(
        fit_frame(Fit::Launch, Some(&frame)),
        Some(FitFrame::Saved(&frame))
    );
}

fn secs(base: Instant, seconds: f64) -> Instant {
    base + Duration::from_secs_f64(seconds)
}
fn laptop() -> MonitorPrint {
    MonitorPrint {
        id: "Built-in@0,0".into(),
        width: 3024,
        height: 1964,
        scale_milli: 2000,
    }
}
fn external() -> MonitorPrint {
    MonitorPrint {
        id: "Studio@3024,0".into(),
        width: 5120,
        height: 2880,
        scale_milli: 2000,
    }
}
/// The displays as a window event sees them, with the window on `current`.
fn display(monitors: Vec<MonitorPrint>, current: &MonitorPrint) -> Option<DisplayState> {
    Some(DisplayState {
        monitors,
        current: Some(current.id.clone()),
    })
}
/// A window whose displays were seeded at launch (laptop and external).
fn launched(base: Instant) -> NativeWindow {
    let window = NativeWindow::default();
    window.lock_gate().monitors(base, &[laptop(), external()]);
    window
}
fn allows(window: &NativeWindow, now: Instant) -> bool {
    window.lock_gate().allows(now)
}

#[test]
fn a_fit_hushes_before_its_first_setter_and_again_after_the_last() {
    use std::cell::{Cell, RefCell};
    let base = Instant::now();
    let gate = Mutex::new(SaveGate::default());
    let clock = Cell::new(base);
    let log = RefCell::new(Vec::new());
    let step = |name: &'static str| {
        // Every setter runs inside a quiet window, and takes 100 ms.
        log.borrow_mut()
            .push((name, gate.lock().unwrap().allows(clock.get())));
        clock.set(clock.get() + Duration::from_millis(100));
        Ok(())
    };
    run_fit(
        &gate,
        || clock.get(),
        true,
        || step("min"),
        || step("size"),
        || step("position"),
    )
    .unwrap();
    assert_eq!(
        *log.borrow(),
        vec![("min", false), ("size", false), ("position", false)]
    );
    // One second after the last setter finished, saving opens again.
    let done = clock.get();
    assert!(!gate.lock().unwrap().allows(secs(done, 0.999)));
    assert!(gate.lock().unwrap().allows(secs(done, 1.0)));
}

#[test]
fn a_fit_that_fails_or_only_sets_the_minimum_still_hushes_before_and_after() {
    let base = Instant::now();
    for (moves_frame, fail) in [(false, false), (true, true), (false, true)] {
        let gate = Mutex::new(SaveGate::default());
        let seen = Mutex::new(Vec::new());
        let result = run_fit(
            &gate,
            || base,
            moves_frame,
            || {
                seen.lock().unwrap().push(gate.lock().unwrap().allows(base));
                if fail {
                    Err(unavailable())
                } else {
                    Ok(())
                }
            },
            || Ok(()),
            || Ok(()),
        );
        assert_eq!(result.is_err(), fail);
        assert_eq!(*seen.lock().unwrap(), vec![false]);
        assert!(!gate.lock().unwrap().allows(secs(base, 0.5)));
    }
}

#[test]
fn the_launch_fits_late_events_stay_hushed_and_the_saved_frame_is_restored() {
    // Launch without the external display: the fit, then the first show.
    let base = Instant::now();
    let window = launched(base);
    let captured = window.owner_movement.load(Ordering::Acquire);
    window.hush(base, FIT_QUIET);
    window.hush(secs(base, 0.02), FIT_QUIET);
    let on_laptop = || display(vec![laptop(), external()], &laptop());
    // macOS delivers the fit's Resized and Moved after the show: not saved,
    // and they do not fence the restore.
    assert!(!window.admit_move(secs(base, 0.05), on_laptop()));
    assert!(!window.admit_move(secs(base, 0.4), on_laptop()));
    assert!(!window.owner_moved_since(captured));
}

#[test]
fn a_preference_read_slower_than_the_show_fallback_still_restores_the_saved_frame() {
    let base = Instant::now();
    let window = launched(base);
    let captured = window.owner_movement.load(Ordering::Acquire);
    window.hush(base, FIT_QUIET);
    // The 3 s fallback shows the window, which hushes again; the fit's late
    // events arrive inside that quiet window.
    window.hush(secs(base, 3.0), FIT_QUIET);
    let on_laptop = || display(vec![laptop(), external()], &laptop());
    assert!(!window.admit_move(secs(base, 3.1), on_laptop()));
    assert!(!window.admit_move(secs(base, 3.8), on_laptop()));
    // The read lands: nothing fenced it, so the saved frame is applied.
    assert!(!window.owner_moved_since(captured));
}

#[test]
fn an_owner_drag_before_the_preference_result_blocks_the_restore() {
    let base = Instant::now();
    let window = launched(base);
    let captured = window.owner_movement.load(Ordering::Acquire);
    window.hush(base, FIT_QUIET);
    let on_external = || display(vec![laptop(), external()], &external());
    // Inside the quiet window the drag is skipped and does not fence.
    assert!(!window.admit_move(secs(base, 0.5), on_external()));
    assert!(!window.owner_moved_since(captured));
    // Outside it the drag is saved and fences the restore.
    assert!(window.admit_move(secs(base, 1.2), on_external()));
    assert!(window.owner_moved_since(captured));
}

#[test]
fn the_reconcile_fence_counts_only_allowed_moves() {
    let base = Instant::now();
    let window = launched(base);
    let before = window.owner_movement.load(Ordering::Acquire);
    // Same displays, quiet window over: the first owner move is saved.
    assert!(window.admit_move(
        secs(base, 10.0),
        display(vec![laptop(), external()], &laptop())
    ));
    assert_eq!(window.owner_movement.load(Ordering::Acquire), before + 1);
    // A hushed event adds nothing.
    window.hush(secs(base, 11.0), FIT_QUIET);
    assert!(!window.admit_move(
        secs(base, 11.5),
        display(vec![laptop(), external()], &laptop())
    ));
    assert_eq!(window.owner_movement.load(Ordering::Acquire), before + 1);
    // An unreadable display set skips the event and does not fence either.
    assert!(!window.admit_move(secs(base, 20.0), None));
    assert_eq!(window.owner_movement.load(Ordering::Acquire), before + 1);
}

#[test]
fn unplugging_the_external_display_hushes_the_relocation_and_keeps_the_owners_frame() {
    let base = Instant::now();
    let window = launched(base);
    let on_external = display(vec![laptop(), external()], &external());
    assert!(window.admit_move(secs(base, 10.0), on_external));
    let fenced = window.owner_movement.load(Ordering::Acquire);
    // macOS moves the window to the laptop screen after the unplug.
    let relocated = || display(vec![laptop()], &laptop());
    assert!(!window.admit_move(secs(base, 20.0), relocated()));
    assert!(!window.admit_move(secs(base, 21.5), relocated()));
    assert_eq!(window.owner_movement.load(Ordering::Acquire), fenced);
    // Two seconds later the owner's next move saves again.
    assert!(window.admit_move(secs(base, 22.0), relocated()));
}

#[test]
fn reconnecting_the_display_while_running_is_hushed_too() {
    let base = Instant::now();
    let window = NativeWindow::default();
    window.lock_gate().monitors(base, &[laptop()]);
    let both = || display(vec![laptop(), external()], &laptop());
    assert!(!window.admit_move(secs(base, 10.0), both()));
    assert!(!window.admit_move(secs(base, 11.9), both()));
    assert!(window.admit_move(secs(base, 12.0), both()));
}

#[test]
fn an_owner_drag_to_a_monitor_that_is_still_connected_saves() {
    let base = Instant::now();
    let window = launched(base);
    let both = vec![laptop(), external()];
    assert!(window.admit_move(secs(base, 10.0), display(both.clone(), &laptop())));
    assert!(window.admit_move(secs(base, 10.2), display(both.clone(), &external())));
    assert!(window.admit_move(secs(base, 10.4), display(both, &laptop())));
}

#[test]
fn a_scale_change_hushes_for_the_display_quiet_window() {
    let window = NativeWindow::default();
    window.display_changed();
    let now = Instant::now();
    assert!(!allows(&window, now));
    assert!(!allows(
        &window,
        now + DISPLAY_QUIET - Duration::from_millis(500)
    ));
    assert!(allows(
        &window,
        now + DISPLAY_QUIET + Duration::from_millis(500)
    ));
}

#[test]
fn only_the_first_show_hushes_and_a_plain_present_does_not() {
    let app = tauri::test::mock_builder()
        .manage(NativeWindow::default())
        .manage(crate::native::routes::NativeRoutes::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let native = app.state::<NativeWindow>();
    // Tray Show and routes call `present`: the owner may drag at once.
    present(&window).unwrap();
    assert!(allows(&native, Instant::now()));
    // The first show hushes, so the fit's late events stay inside the window.
    let show = first_show();
    show(app.handle());
    let now = Instant::now();
    assert!(!allows(&native, now));
    assert!(!allows(&native, now + Duration::from_millis(500)));
    assert!(allows(
        &native,
        now + FIT_QUIET + Duration::from_millis(500)
    ));
}

#[test]
fn wake_fits_only_when_needed_and_a_pin_change_leaves_the_frame_alone() {
    let frame = saved();
    for saved in [None, Some(&frame)] {
        assert_eq!(
            fit_frame(Fit::IfNeeded, saved),
            Some(FitFrame::Current {
                only_if_needed: true
            })
        );
        assert_eq!(fit_frame(Fit::Keep, saved), None);
    }
}
