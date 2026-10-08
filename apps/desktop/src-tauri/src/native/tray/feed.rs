use super::{
    capture,
    coalescing::Coalesced,
    diagnostics::{Diagnostics, LifecycleNote},
    menu, TrayProjection,
};
use crate::{
    commands::DesktopService,
    native::notifications::{
        burst::{announcements, Burst},
        writer::PreferenceWriter,
    },
};
use ariadne_core::{CoreError, CoreErrorCode};
use ariadne_domain::models::{Completeness, UtcMillis, UuidV4};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

enum Message {
    Refresh,
    Pin,
    Permission(tokio::sync::oneshot::Sender<Result<bool, CoreError>>),
    Stop(SyncSender<Result<(), CoreError>>),
}

#[derive(Clone)]
pub struct NativeTray {
    sender: SyncSender<Message>,
    dirty: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    callbacks_active: Arc<AtomicBool>,
    teardown: Arc<dyn Fn() -> Result<(), CoreError> + Send + Sync>,
    worker: Arc<Mutex<Option<JoinHandle<()>>>>,
    diagnostics: Arc<Mutex<Diagnostics>>,
}

pub(crate) fn unavailable() -> CoreError {
    CoreError::new(
        CoreErrorCode::IoError,
        "The native Waiting feed is unavailable.",
        "Keep using the in-app Waiting queue and reconcile the native feed.",
    )
}
fn op_id() -> UuidV4 {
    UuidV4::new(uuid::Uuid::new_v4().to_string()).expect("generated v4")
}
fn now() -> Result<UtcMillis, CoreError> {
    // Reuse the canonical millisecond UTC formatter; no locale-dependent time.
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| unavailable())?
        .as_millis();
    UtcMillis::new(
        chrono::DateTime::from_timestamp_millis(i64::try_from(millis).map_err(|_| unavailable())?)
            .ok_or_else(unavailable)?
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    )
    .map_err(|_| unavailable())
}

impl NativeTray {
    pub fn install<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Self, CoreError> {
        if app.try_state::<Self>().is_some() {
            return Err(unavailable());
        }
        menu::install(app)?;
        let callbacks_active = Arc::new(AtomicBool::new(true));
        #[cfg(target_os = "macos")]
        {
            let foreground = app.clone();
            let routing = app.clone();
            crate::native::notifications::Platform::install(
                callbacks_active.clone(),
                move || {
                    foreground.get_webview_window("main").is_some_and(|window| {
                        window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
                    })
                },
                move |route| menu::open(routing.clone(), route),
            )?;
        }
        let teardown_app = app.clone();
        let teardown: Arc<dyn Fn() -> Result<(), CoreError> + Send + Sync> = Arc::new(move || {
            #[cfg(target_os = "macos")]
            {
                teardown_app
                    .run_on_main_thread(crate::native::notifications::Platform::uninstall)
                    .map_err(|_| unavailable())
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = &teardown_app;
                Ok(())
            }
        });
        let (sender, receiver) = mpsc::sync_channel(16);
        let tray = Self {
            sender,
            dirty: Arc::new(AtomicBool::new(true)),
            stopped: Arc::new(AtomicBool::new(false)),
            worker: Arc::new(Mutex::new(None)),
            diagnostics: Arc::new(Mutex::new(Diagnostics::default())),
            callbacks_active: callbacks_active.clone(),
            teardown,
        };
        let handle = app.clone();
        let dirty = tray.dirty.clone();
        let diagnostics = tray.diagnostics.clone();
        let stopped = tray.stopped.clone();
        let worker = std::thread::Builder::new()
            .name("ariadne-native-waiting".into())
            .spawn(move || {
                run(
                    handle,
                    receiver,
                    dirty,
                    diagnostics,
                    stopped,
                    callbacks_active,
                )
            })
            .map_err(|_| {
                tray.callbacks_active.store(false, Ordering::Release);
                #[cfg(target_os = "macos")]
                crate::native::notifications::Platform::uninstall();
                unavailable()
            })?;
        *tray.worker.lock().map_err(|_| unavailable())? = Some(worker);
        Ok(tray)
    }
    /// Existing registered watcher/fallback/focus hints share one pending bit.
    pub fn refresh(&self) {
        if !self.stopped.load(Ordering::Acquire) && !self.dirty.swap(true, Ordering::AcqRel) {
            let _ = self.sender.try_send(Message::Refresh);
        }
    }
    /// Pure producer/delegate fence at accepted Quit, before off-UI drains.
    pub fn begin_stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.callbacks_active.store(false, Ordering::Release);
    }
    pub fn diagnostics(&self, rows: Vec<LifecycleNote>) {
        if let Ok(mut snapshot) = self.diagnostics.lock() {
            snapshot.replace(rows, self.stopped.load(Ordering::Acquire));
        }
        self.refresh();
    }
    pub(crate) fn pin(&self) {
        if !self.stopped.load(Ordering::Acquire) {
            let _ = self.sender.try_send(Message::Pin);
        }
    }
    pub(crate) async fn permission(&self) -> Result<bool, CoreError> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(unavailable());
        }
        let (send, receive) = tokio::sync::oneshot::channel();
        self.sender
            .try_send(Message::Permission(send))
            .map_err(|_| unavailable())?;
        receive.await.map_err(|_| unavailable())?
    }
    /// Must run off the UI thread before the composition executor shuts down.
    /// Unconfirmed preference writes refuse Quit and retain the exact operation.
    pub fn stop(&self) -> Result<(), CoreError> {
        self.begin_stop();
        let mut worker = self.worker.lock().map_err(|_| unavailable())?;
        if worker.is_none() {
            return (self.teardown)();
        }
        let (send, receive) = mpsc::sync_channel(1);
        let result = self
            .sender
            .send(Message::Stop(send))
            .map_err(|_| unavailable())
            .and_then(|()| receive.recv().map_err(|_| unavailable())?);
        result?;
        let result = worker
            .take()
            .expect("checked")
            .join()
            .map_err(|_| unavailable());
        let teardown = (self.teardown)();
        result.and(teardown)
    }
}

fn run<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    receiver: Receiver<Message>,
    dirty: Arc<AtomicBool>,
    lifecycle: Arc<Mutex<Diagnostics>>,
    stopped: Arc<AtomicBool>,
    callbacks_active: Arc<AtomicBool>,
) {
    let service = app.state::<DesktopService>().inner().clone();
    let mut writer = PreferenceWriter::default();
    let mut pending = Coalesced::default();
    let mut burst = Burst::default();
    let mut last_projection: Option<TrayProjection> = None;
    let mut last_pinned = false;
    #[cfg(target_os = "macos")]
    let platform = crate::native::notifications::Platform::new(callbacks_active);
    #[cfg(not(target_os = "macos"))]
    let _ = callbacks_active;
    // No scan timer: timeouts exist only while a hint or burst is pending.
    loop {
        let instant = Instant::now();
        if dirty.swap(false, Ordering::AcqRel) {
            pending.replace(());
        }
        if pending.take_due(instant).is_some() && !stopped.load(Ordering::Acquire) {
            let result = (|| {
                let captured = capture(|request| service.native_query(request))?;
                let mut diagnostics = lifecycle
                    .lock()
                    .map_err(|_| unavailable())?
                    .render(&captured.labels);
                let observation = (|| {
                    let mut plans = Vec::new();
                    if let Some(plan) =
                        writer.confirm(|request| service.native_preferences_write(request))?
                    {
                        plans.push(plan);
                    }
                    let snapshot = service.native_preferences()?;
                    if !stopped.load(Ordering::Acquire) {
                        if let Some(plan) = writer.observe(snapshot, &captured, now()?, op_id)? {
                            plans.push(plan);
                        }
                    }
                    if let Some(plan) =
                        writer.confirm(|request| service.native_preferences_write(request))?
                    {
                        plans.push(plan);
                    }
                    Ok::<_, CoreError>(plans)
                })();
                match observation {
                    Ok(plans) => {
                        for plan in plans {
                            if let Some(diagnostic) = plan.diagnostic {
                                diagnostics.push(diagnostic.into());
                            }
                            burst.push(plan.arrivals, Instant::now());
                        }
                    }
                    Err(_) => diagnostics.push(
                        "Notifications are catching up; answer questions in Ariadne meanwhile."
                            .into(),
                    ),
                }
                burst.retain(
                    &captured.rows,
                    captured.counts.completeness == Completeness::Complete,
                );
                #[cfg(target_os = "macos")]
                {
                    if let Some(diagnostic) = platform.diagnostic() {
                        diagnostics.push(diagnostic.into());
                    }
                    if captured.counts.completeness == Completeness::Complete {
                        platform
                            .reconcile(captured.rows.iter().map(|row| row.identifier()).collect());
                    }
                }
                if let Ok(latest) = service.native_preferences() {
                    last_pinned = latest.global.pinned;
                }
                let projection = TrayProjection::from_capture(&captured, &diagnostics);
                last_projection = Some(projection.clone());
                menu::update(&app, projection, last_pinned, stopped.clone());
                Ok::<(), CoreError>(())
            })();
            if result.is_err() {
                if let Some(mut projection) = last_projection.clone() {
                    projection
                        .diagnostics
                        .push("Could not refresh; showing the last list.".into());
                    menu::update(&app, projection, last_pinned, stopped.clone());
                }
                eprintln!(
                    "Ariadne retained its last native queue while observation was unavailable."
                );
            }
        }
        if let Some(rows) = burst.take_due(Instant::now()) {
            // A privacy preference may have changed during the 500ms window.
            // Failed reconciliation safely falls back to the generic body.
            let preview = service
                .native_preferences()
                .is_ok_and(|snapshot| snapshot.global.notification_preview);
            #[cfg(target_os = "macos")]
            if !stopped.load(Ordering::Acquire) {
                for announcement in announcements(&rows, preview) {
                    let _ = platform.schedule(&announcement);
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = announcements(&rows, preview);
        }
        let timeout = [pending.deadline(Instant::now()), burst.deadline()]
            .into_iter()
            .flatten()
            .min()
            .map(|deadline| deadline.saturating_duration_since(Instant::now()));
        let message = match timeout {
            Some(timeout) => match receiver.recv_timeout(timeout.max(Duration::from_millis(1))) {
                Ok(message) => message,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            },
            None => match receiver.recv() {
                Ok(message) => message,
                Err(_) => break,
            },
        };
        match message {
            Message::Refresh => pending.replace(()),
            Message::Permission(reply) => {
                #[cfg(target_os = "macos")]
                if !stopped.load(Ordering::Acquire) {
                    platform.permission(reply);
                } else {
                    let _ = reply.send(Err(unavailable()));
                }
                #[cfg(not(target_os = "macos"))]
                {
                    let _ = reply.send(Err(unavailable()));
                }
            }
            Message::Pin => {
                // These explicit intents were queued before the UI producer
                // fence. No new Pin can enter afterward; finish their owned save.
                let result = (|| {
                    if writer.pending() {
                        if let Some(plan) =
                            writer.confirm(|request| service.native_preferences_write(request))?
                        {
                            burst.push(plan.arrivals, Instant::now());
                        }
                        // This click reconciles a frozen prior operation. It
                        // does not apply another toggle under a new ID.
                        return Ok(());
                    }
                    writer.pin(service.native_preferences()?, op_id)?;
                    writer.confirm(|request| service.native_preferences_write(request))?;
                    if let Some(window) = app.try_state::<crate::native::window::NativeWindow>() {
                        window.reconcile(app.clone(), false);
                    }
                    Ok::<(), CoreError>(())
                })();
                if result.is_err() {
                    eprintln!("Ariadne could not confirm its native pin preference.");
                }
                pending.replace(());
            }
            Message::Stop(reply) => {
                let result = writer
                    .confirm(|request| service.native_preferences_write(request))
                    .map(|_| ());
                let can_stop = result.is_ok();
                let _ = reply.send(result);
                if can_stop {
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "tests/feed.rs"]
mod tests;
