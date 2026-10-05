use super::burst::Announcement;
use ariadne_core::{CoreError, CoreErrorCode, OpenRoute};
use block2::{DynBlock, RcBlock};
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{Bool, ProtocolObject},
    DefinedClass, MainThreadMarker,
};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::*;
use std::{
    cell::RefCell,
    ptr::NonNull,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        Arc, Mutex,
    },
};

struct DelegateState {
    active: Arc<AtomicBool>,
    foreground: Box<dyn Fn() -> bool + Send + Sync>,
    open: Box<dyn Fn(OpenRoute) + Send + Sync>,
}

impl DelegateState {
    /// The OS supplies an action and payload; Ariadne owns admission and routing.
    fn clicked(
        &self,
        default_action: impl FnOnce() -> bool,
        payload: impl FnOnce() -> Option<String>,
        completion: impl FnOnce(),
    ) {
        if self.active.load(Ordering::Acquire) && default_action() {
            if let Some(value) = payload().filter(|value| value.len() <= 1024) {
                if let Ok(route) = serde_json::from_str::<OpenRoute>(&value) {
                    (self.open)(route);
                }
            }
        }
        completion();
    }
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "AriadneNotificationDelegate"]
    #[ivars = DelegateState]
    struct Delegate;
    unsafe impl NSObjectProtocol for Delegate {}
    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            let state = self.ivars();
            let options = if state.active.load(Ordering::Acquire) && !(state.foreground)() {
                UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List
            } else {
                UNNotificationPresentationOptions(0)
            };
            completion.call((options,));
        }
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn clicked(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &DynBlock<dyn Fn()>,
        ) {
            self.ivars().clicked(
                || {
                    &*response.actionIdentifier()
                        == unsafe { UNNotificationDefaultActionIdentifier }
                },
                || {
                    let dictionary = response.notification().request().content().userInfo();
                    let key = NSString::from_str("ariadne_route");
                    dictionary
                        .objectForKey(key.as_ref())
                        .and_then(|value| value.downcast::<NSString>().ok())
                        .map(|value| value.to_string())
                },
                || completion.call(()),
            );
        }
    }
);

thread_local! {
    // The center's delegate property is weak. Retention stays entirely on the
    // setup/main thread; no Objective-C object or unsafe Send crosses threads.
    static DELEGATE: RefCell<Option<Retained<Delegate>>> = const { RefCell::new(None) };
}

pub(crate) struct Platform {
    center: Retained<UNUserNotificationCenter>,
    active: Arc<AtomicBool>,
    permission: Arc<AtomicU8>,
    reconciliation: Arc<AtomicU64>,
}

impl Platform {
    /// Install synchronously during setup so cold-launch clicks have a delegate
    /// before launch callbacks. Its Rust ivars contain only thread-safe values.
    pub(crate) fn install(
        active: Arc<AtomicBool>,
        foreground: impl Fn() -> bool + Send + Sync + 'static,
        open: impl Fn(OpenRoute) + Send + Sync + 'static,
    ) -> Result<(), CoreError> {
        MainThreadMarker::new().ok_or_else(super::unavailable)?;
        let center = UNUserNotificationCenter::currentNotificationCenter();
        if center.delegate().is_some() || DELEGATE.with(|slot| slot.borrow().is_some()) {
            return Err(CoreError::new(
                CoreErrorCode::ProtocolConflict,
                "A native notification delegate is already installed.",
                "Keep the existing owner and avoid installing a second delegate.",
            ));
        }
        let allocated = <Delegate as objc2::AnyThread>::alloc().set_ivars(DelegateState {
            active: active.clone(),
            foreground: Box::new(foreground),
            open: Box::new(open),
        });
        // NSObject initialization is the superclass's designated initializer.
        let delegate: Retained<Delegate> = unsafe { msg_send![super(allocated), init] };
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        DELEGATE.with(|slot| *slot.borrow_mut() = Some(delegate));
        Ok(())
    }

    pub(crate) fn uninstall() {
        if MainThreadMarker::new().is_none() {
            return;
        }
        DELEGATE.with(|slot| {
            if slot.borrow().is_some() {
                UNUserNotificationCenter::currentNotificationCenter().setDelegate(None);
                slot.borrow_mut().take();
            }
        });
    }

    /// The feed reacquires its own center handle; the delegate remains retained
    /// on the main thread until shutdown has joined this feed.
    pub(crate) fn new(active: Arc<AtomicBool>) -> Self {
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let permission = Arc::new(AtomicU8::new(0));
        let status = permission.clone();
        let completion = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            // UserNotifications owns this nonnull callback argument for this call.
            let observed = unsafe { settings.as_ref() }.authorizationStatus();
            status.store(
                if observed == UNAuthorizationStatus::Denied {
                    1
                } else if observed == UNAuthorizationStatus::NotDetermined {
                    2
                } else {
                    3
                },
                Ordering::Release,
            );
        });
        center.getNotificationSettingsWithCompletionHandler(&completion);
        Self {
            center,
            active,
            permission,
            reconciliation: Arc::new(AtomicU64::new(0)),
        }
    }

    pub(crate) fn diagnostic(&self) -> Option<&'static str> {
        permission_diagnostic(&self.permission)
    }

    pub(crate) fn permission(&self, reply: tokio::sync::oneshot::Sender<Result<bool, CoreError>>) {
        let completion =
            authorization_completion(self.active.clone(), self.permission.clone(), reply);
        self.center
            .requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert,
                &completion,
            );
    }

    pub(crate) fn schedule(&self, announcement: &Announcement) -> Result<(), CoreError> {
        self.reconciliation.fetch_add(1, Ordering::AcqRel);
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&announcement.title));
        content.setBody(&NSString::from_str(&announcement.body));
        let route = serde_json::to_string(&announcement.route).map_err(|_| super::unavailable())?;
        let key = NSString::from_str("ariadne_route");
        let value = NSString::from_str(&route);
        let dictionary: Retained<NSDictionary<NSString, NSString>> =
            NSDictionary::from_slices(&[&*key], &[&*value]);
        // Erase the static generics only after constructing a property-list
        // dictionary. NSDictionary's Objective-C representation is unchanged.
        let dictionary: Retained<NSDictionary> = unsafe { Retained::cast_unchecked(dictionary) };
        // Dictionary keys/values are property-list strings with canonical IDs.
        unsafe { content.setUserInfo(dictionary.as_ref()) };
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&announcement.identifier),
            &content,
            None,
        );
        let completion = RcBlock::new(|error: *mut NSError| {
            if !error.is_null() {
                eprintln!("Ariadne could not schedule a native notification.");
            }
        });
        self.center
            .addNotificationRequest_withCompletionHandler(&request, Some(&completion));
        Ok(())
    }

    pub(crate) fn reconcile(&self, valid: Vec<String>) {
        let ticket = self.reconciliation.fetch_add(1, Ordering::AcqRel) + 1;
        let pending_ticket = self.reconciliation.clone();
        let delivered_ticket = self.reconciliation.clone();
        let pending_active = self.active.clone();
        let delivered_active = self.active.clone();
        let pending_valid = valid.clone();
        let completion = RcBlock::new(move |requests: NonNull<NSArray<UNNotificationRequest>>| {
            let requests = unsafe { requests.as_ref() };
            let mut removed = Vec::new();
            for index in 0..requests.count() {
                let identifier = requests.objectAtIndex(index).identifier();
                if obsolete(&identifier.to_string(), &pending_valid) {
                    removed.push(identifier);
                }
            }
            if pending_active.load(Ordering::Acquire)
                && pending_ticket.load(Ordering::Acquire) == ticket
            {
                UNUserNotificationCenter::currentNotificationCenter()
                    .removePendingNotificationRequestsWithIdentifiers(
                        &NSArray::from_retained_slice(&removed),
                    );
            }
        });
        self.center
            .getPendingNotificationRequestsWithCompletionHandler(&completion);
        let completion = RcBlock::new(move |notifications: NonNull<NSArray<UNNotification>>| {
            let notifications = unsafe { notifications.as_ref() };
            let mut removed = Vec::new();
            for index in 0..notifications.count() {
                let identifier = notifications.objectAtIndex(index).request().identifier();
                if obsolete(&identifier.to_string(), &valid) {
                    removed.push(identifier);
                }
            }
            if delivered_active.load(Ordering::Acquire)
                && delivered_ticket.load(Ordering::Acquire) == ticket
            {
                UNUserNotificationCenter::currentNotificationCenter()
                    .removeDeliveredNotificationsWithIdentifiers(&NSArray::from_retained_slice(
                        &removed,
                    ));
            }
        });
        self.center
            .getDeliveredNotificationsWithCompletionHandler(&completion);
    }
}

fn permission_diagnostic(permission: &AtomicU8) -> Option<&'static str> {
    match permission.load(Ordering::Acquire) {
        1 => Some("Notifications are denied; answer questions in the Waiting queue."),
        2 => Some("Notifications require the explicit Enable notifications action."),
        _ => None,
    }
}

/// Keep our completion/result handling separate from the OS authorization call.
fn authorization_completion(
    active: Arc<AtomicBool>,
    permission: Arc<AtomicU8>,
    reply: tokio::sync::oneshot::Sender<Result<bool, CoreError>>,
) -> RcBlock<dyn Fn(Bool, *mut NSError)> {
    let reply = Mutex::new(Some(reply));
    RcBlock::new(move |granted: Bool, error: *mut NSError| {
        if let Some(reply) = reply.lock().ok().and_then(|mut reply| reply.take()) {
            let result = if !active.load(Ordering::Acquire) || !error.is_null() {
                Err(super::unavailable())
            } else {
                permission.store(if granted.as_bool() { 3 } else { 1 }, Ordering::Release);
                Ok(granted.as_bool())
            };
            let _ = reply.send(result);
        }
    })
}

fn obsolete(identifier: &str, valid: &[String]) -> bool {
    let episode = identifier.strip_suffix(":burst").unwrap_or(identifier);
    identifier.starts_with("ariadne:") && !valid.iter().any(|valid| valid == episode)
}

impl Drop for Platform {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}

#[cfg(test)]
#[path = "tests/permission.rs"]
mod tests;

#[cfg(test)]
#[path = "tests/click.rs"]
mod click_tests;
