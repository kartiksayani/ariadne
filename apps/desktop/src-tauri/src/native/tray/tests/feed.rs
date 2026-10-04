use super::*;

#[test]
fn quit_fences_new_native_intents_and_retains_the_already_owned_queue() {
    let (sender, receiver) = mpsc::sync_channel(16);
    let tray = NativeTray {
        sender,
        dirty: Arc::new(AtomicBool::new(false)),
        stopped: Arc::new(AtomicBool::new(false)),
        callbacks_active: Arc::new(AtomicBool::new(true)),
        teardown: Arc::new(|| Ok(())),
        worker: Arc::new(Mutex::new(None)),
        diagnostics: Arc::new(Mutex::new(Diagnostics::default())),
    };
    tray.pin(); // Explicit intent accepted before the lifecycle fence.
    tray.begin_stop();
    assert!(!tray.callbacks_active.load(Ordering::Acquire));
    tray.pin();
    tray.refresh();
    assert!(matches!(receiver.try_recv(), Ok(Message::Pin)));
    assert!(matches!(
        receiver.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    tray.stop().unwrap();
    assert!(tray.stopped.load(Ordering::Acquire));
}
