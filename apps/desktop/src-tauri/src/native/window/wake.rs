//! One UI-thread-owned workspace observer; no dispatch or durable state.
use ariadne_core::{CoreError, CoreErrorCode};
use block2::RcBlock;
use objc2::{rc::Retained, runtime::ProtocolObject};
use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol};
use std::{
    cell::RefCell,
    ptr::NonNull,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

struct WakeObserver {
    center: Retained<NSNotificationCenter>,
    token: Retained<ProtocolObject<dyn NSObjectProtocol>>,
    active: Arc<AtomicBool>,
}
impl WakeObserver {
    fn with_center(
        center: Retained<NSNotificationCenter>,
        callback: impl Fn() + Send + Sync + 'static,
    ) -> Self {
        let active = Arc::new(AtomicBool::new(true));
        let listening = active.clone();
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            if listening.load(Ordering::Acquire) {
                callback();
            }
        });
        // The immutable system notification name is provided by AppKit. No
        // object filter or operation queue is supplied. Captures are Send+Sync;
        // the observer only schedules trusted work, never accesses UI here.
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidWakeNotification),
                None,
                None,
                &block,
            )
        };
        Self {
            center,
            token,
            active,
        }
    }
}
impl Drop for WakeObserver {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        // This is exactly the opaque block-observer token returned by center.
        // Removal and token release occur on the same owning UI thread.
        unsafe { self.center.removeObserver(&self.token) };
    }
}

thread_local! {
    // Objective-C observer ownership never crosses threads or enters Tauri
    // Send+Sync state. Setup and RunEvent::Exit execute on the native UI thread.
    static OBSERVER: RefCell<Option<WakeObserver>> = const { RefCell::new(None) };
}

pub(crate) fn install(callback: impl Fn() + Send + Sync + 'static) -> Result<(), CoreError> {
    OBSERVER.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_some() {
            return Err(CoreError::new(
                CoreErrorCode::ProtocolConflict,
                "The native workspace wake observer is already installed.",
                "Keep the original owning startup; do not install a second observer.",
            ));
        }
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        *slot = Some(WakeObserver::with_center(center, callback));
        Ok(())
    })
}

pub(crate) fn remove() {
    OBSERVER.with(|slot| {
        slot.borrow_mut().take();
    });
}

#[cfg(test)]
#[path = "tests/wake.rs"]
mod tests;
