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
