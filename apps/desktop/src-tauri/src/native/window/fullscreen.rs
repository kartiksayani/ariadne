//! Leaves macOS full screen before the window hides or the app exits. Hiding
//! or quitting a full-screen window leaves its Space behind, solid black.
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

/// The longest wait for the exit animation before continuing anyway.
const EXIT_TIMEOUT: Duration = Duration::from_secs(2);

type Continuation = Box<dyn FnOnce() + Send>;

/// A continuation that runs at most once, whichever path reaches it first.
#[derive(Clone)]
pub(crate) struct Once(Arc<Mutex<Option<Continuation>>>);
impl Once {
    pub(crate) fn new(then: impl FnOnce() + Send + 'static) -> Self {
        Self(Arc::new(Mutex::new(Some(Box::new(then)))))
    }
    pub(crate) fn run(&self) {
        let then = self
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(then) = then {
            then();
        }
    }
}

/// Call on the UI thread. Runs `then` on the UI thread: at once for a windowed
/// window, otherwise after macOS has left full screen, or after
/// `EXIT_TIMEOUT` if it never reports that.
pub(crate) fn leave_then<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    then: impl FnOnce() + Send + 'static,
) {
    if !window.is_fullscreen().unwrap_or(false) {
        then();
        return;
    }
    let once = Once::new(then);
    #[cfg(target_os = "macos")]
    let observed = window
        .ns_window()
        .is_ok_and(|ns_window| mac::observe(ns_window, once.clone()));
    #[cfg(not(target_os = "macos"))]
    let observed = false;
    if window.set_fullscreen(false).is_err() || !observed {
        once.run();
        return;
    }
    let app = tauri::Manager::app_handle(window).clone();
    let spawned = std::thread::Builder::new()
        .name("ariadne-fullscreen-exit".into())
        .spawn({
            let once = once.clone();
            move || {
                std::thread::sleep(EXIT_TIMEOUT);
                let _ = app.run_on_main_thread(move || once.run());
            }
        });
    if spawned.is_err() {
        eprintln!("Ariadne could not time its full-screen exit.");
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::Once;
    use block2::RcBlock;
    use objc2::{
        rc::Retained,
        runtime::{AnyObject, ProtocolObject},
    };
    use objc2_app_kit::NSWindowDidExitFullScreenNotification;
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol};
    use std::{cell::RefCell, ffi::c_void, ptr::NonNull};

    struct ExitObserver {
        center: Retained<NSNotificationCenter>,
        token: Retained<ProtocolObject<dyn NSObjectProtocol>>,
    }
    impl Drop for ExitObserver {
        fn drop(&mut self) {
            // The opaque token this center returned, removed on the UI thread.
            unsafe {
                self.center
                    .removeObserver(AsRef::<AnyObject>::as_ref(&*self.token))
            };
        }
    }

    thread_local! {
        // Observer ownership stays on the UI thread that installed it.
        static EXITING: RefCell<Option<ExitObserver>> = const { RefCell::new(None) };
    }

    /// Runs `done` when this NSWindow posts did-exit-full-screen. False when
    /// there is no window to observe.
    pub(super) fn observe(ns_window: *mut c_void, done: Once) -> bool {
        // tao's live NSWindow for this Tauri window, used on the UI thread.
        let Some(window) = (unsafe { ns_window.cast::<AnyObject>().as_ref() }) else {
            return false;
        };
        let center = NSNotificationCenter::defaultCenter();
        let block = RcBlock::new(move |_: NonNull<NSNotification>| done.run());
        // AppKit's own notification name, filtered to this window, delivered
        // on the posting (UI) thread.
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSWindowDidExitFullScreenNotification),
                Some(window),
                None,
                &block,
            )
        };
        // The observer stays registered after it fires: removing it inside
        // its own callback could free the running block. `Once` makes later
        // posts no-ops, and the next exit replaces (and removes) it here,
        // outside any callback. An older pending continuation still runs
        // from its timeout.
        let previous =
            EXITING.with(|slot| slot.borrow_mut().replace(ExitObserver { center, token }));
        drop(previous);
        true
    }
}

#[cfg(test)]
#[path = "tests/fullscreen.rs"]
mod tests;
