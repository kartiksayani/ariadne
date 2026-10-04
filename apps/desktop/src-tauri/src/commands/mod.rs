//! Owner desktop entrypoints. Only trusted Rust startup supplies composition.
#[cfg(test)]
use ariadne_core::validate_owner_receipt as validate_receipt;
use ariadne_core::*;
#[cfg(test)]
use ariadne_domain::models::SavedReceiptData;
use ariadne_domain::models::SchemaVersion;
use std::sync::Arc;
use tauri::{Emitter, Manager};

type ResolveSession = dyn Fn(&SessionRef) -> Result<RegisteredSession, CoreError> + Send + Sync;

#[derive(Clone, Default)]
pub struct DesktopService {
    composition: Option<Composition>,
}
#[derive(Clone)]
struct Composition {
    core: Arc<dyn CoreService>,
    resolve: Arc<ResolveSession>,
}
impl DesktopService {
    pub(crate) fn native_preferences(&self) -> Result<PreferencesSnapshot, CoreError> {
        match self
            .query(
                OwnerQueryRequest {
                    session: None,
                    request: QueryRequest::PreferencesGet {},
                },
                true,
            )
            .0
        {
            ApplicationEnvelope::Success(SuccessEnvelope {
                data: QueryResult::PreferencesGet(snapshot),
                ..
            }) => Ok(snapshot),
            ApplicationEnvelope::Failure(FailureEnvelope { error, .. }) => Err(error),
            _ => Err(mismatched_command()),
        }
    }
    pub(crate) fn native_preferences_write(
        &self,
        request: &OwnerMutationRequest,
    ) -> Result<PreferencesPatchedReceipt, CoreError> {
        match self
            .owner(
                request.clone(),
                matches!(request.command, OwnerCommand::PreferencesPatch { .. }),
            )
            .0
        {
            ApplicationEnvelope::Success(SuccessEnvelope {
                data: MutationReceipt::PreferencesPatched(receipt),
                ..
            }) => Ok(receipt),
            ApplicationEnvelope::Failure(FailureEnvelope { error, .. }) => Err(error),
            _ => Err(mismatched_command()),
        }
    }
    pub(crate) fn resolve_open_route(&self, route: &OpenRoute) -> Result<(), CoreError> {
        self.composition()?.session(&SessionRef {
            project_id: route.project_id.clone(),
            session_id: route.session_id.clone(),
        })?;
        // Item existence remains the shared renderer reveal's responsibility,
        // including its validated session fallback for a concurrently deleted item.
        Ok(())
    }
    /// The Rust startup caller resolves IDs through actual registered project and
    /// session membership. This installer is never exposed as a Tauri command.
    pub fn from_trusted_startup(
        core: Arc<dyn CoreService>,
        resolve: impl Fn(&SessionRef) -> Result<RegisteredSession, CoreError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            composition: Some(Composition {
                core,
                resolve: Arc::new(resolve),
            }),
        }
    }
    fn composition(&self) -> Result<&Composition, CoreError> {
        self.composition.as_ref().ok_or_else(|| {
            unsupported("Desktop CoreService and registered session lookup are not composed yet.")
        })
    }
    fn query(&self, request: OwnerQueryRequest, command_matches: bool) -> QueryEnvelope {
        QueryEnvelope(envelope((|| {
            if !command_matches {
                return Err(mismatched_command());
            }
            request.validate_wire()?;
            let composition = self.composition()?;
            let owner = match &request.session {
                Some(route) => OwnerScope::Session(composition.session(route)?),
                None if matches!(request.request, QueryRequest::PreferencesGet {}) => {
                    OwnerScope::Preferences
                }
                None => OwnerScope::Registry,
            };
            if let QueryRequest::TopicContinuePreview(params) = &request.request {
                composition.session(&params.source)?;
                composition.session(&params.target)?;
            }
            let context = QueryContext::owner(OwnerContext::from_trusted_entrypoint(owner));
            let result = composition
                .core
                .query(context.clone(), request.request.clone())?;
            result.validate_for(&context, &request.request)?;
            if let QueryResult::SessionGet(snapshot) = &result {
                if ariadne_domain::validation::validate_session_items(&snapshot.session).is_err()
                    || ariadne_domain::history::validate_session_history(&snapshot.session).is_err()
                {
                    return Err(CoreError::new(
                        CoreErrorCode::CorruptSession,
                        "Registered session snapshot failed canonical validation.",
                        "Keep the last valid snapshot and inspect the registered session.",
                    ));
                }
            }
            Ok(result)
        })()))
    }
    fn owner(&self, request: OwnerMutationRequest, command_matches: bool) -> MutationEnvelope {
        MutationEnvelope(envelope((|| {
            if !command_matches {
                return Err(mismatched_command());
            }
            request.validate_wire()?;
            let composition = self.composition()?;
            let scope = match &request.session {
                Some(route) => OwnerScope::Session(composition.session(route)?),
                None if matches!(request.command, OwnerCommand::PreferencesPatch { .. }) => {
                    OwnerScope::Preferences
                }
                // Core owns actual root/project trust and bootstrap checks.
                None => OwnerScope::Registry,
            };
            if let OwnerCommand::TopicContinue { params, .. } = &request.command {
                composition.session(&params.source)?;
            }
            let result = composition.core.execute_owner(
                OwnerContext::from_trusted_entrypoint(scope),
                request.command.clone(),
            )?;
            validate_owner_receipt(&request, &result)?;
            Ok(result)
        })()))
    }
}
impl Composition {
    fn session(&self, route: &SessionRef) -> Result<RegisteredSession, CoreError> {
        let registered = (self.resolve)(route)?;
        if registered.project_id() != &route.project_id
            || registered.session_id() != &route.session_id
        {
            return Err(CoreError::new(
                CoreErrorCode::BindingMismatch,
                "Registered session lookup returned a different route.",
                "Resolve the registered project and session again.",
            ));
        }
        Ok(registered)
    }
}
fn unsupported(message: &str) -> CoreError {
    CoreError::new(
        CoreErrorCode::Unsupported,
        message,
        "This desktop feature requires the real core/store startup composition.",
    )
}
fn mismatched_command() -> CoreError {
    CoreError::new(
        CoreErrorCode::InvalidArgument,
        "Tauri command does not match the canonical request kind.",
        "Use the command name declared by the generated request.",
    )
}
fn envelope<T>(result: Result<T, CoreError>) -> ApplicationEnvelope<T> {
    match result {
        Ok(data) => ApplicationEnvelope::Success(SuccessEnvelope {
            api_version: SchemaVersion::new(1).unwrap(),
            ok: SuccessFlag,
            data,
        }),
        Err(error) => {
            let error = error
                .validate()
                .map(|()| error.clone())
                .unwrap_or_else(|_| {
                    CoreError::new(
                        CoreErrorCode::ProtocolConflict,
                        "CoreService returned an invalid error envelope.",
                        "Reload and inspect the local service before retrying.",
                    )
                });
            ApplicationEnvelope::Failure(FailureEnvelope {
                api_version: SchemaVersion::new(1).unwrap(),
                ok: FailureFlag,
                error,
            })
        }
    }
}
// Tauri schedules async commands on its executor. Move the entire synchronous
// operation, including trusted registration lookup, off that executor as well.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, ()> {
    #[cfg(test)]
    let executor_thread = std::thread::current().id();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(test)]
        assert_ne!(std::thread::current().id(), executor_thread);
        work()
    })
    .await
    .map_err(|_| ())
}
macro_rules! queries {
    ($($name:ident => $pattern:pat),+ $(,)?) => { $(
        #[tauri::command]
        pub async fn $name<R: tauri::Runtime>(request: OwnerQueryRequest, app: tauri::AppHandle<R>) -> QueryEnvelope {
            let matches = matches!(&request.request, $pattern);
            let service = app.state::<DesktopService>().inner().clone();
            blocking(move || service.query(request, matches)).await.unwrap_or_else(|()| {
                QueryEnvelope(envelope(Err(CoreError::new(
                    CoreErrorCode::IoError,
                    "Desktop query worker terminated before returning a result.",
                    "Keep the last valid snapshot and reload the registered session.",
                ))))
            })
        }
    )+ };
}
queries! {
    project_list => QueryRequest::ProjectList(_),
    session_list => QueryRequest::SessionList(_),
    session_get => QueryRequest::SessionGet {},
    session_read => QueryRequest::SessionRead(_),
    item_messages => QueryRequest::ItemMessages(_),
    item_rounds => QueryRequest::ItemRounds(_),
    topic_continue_preview => QueryRequest::TopicContinuePreview(_),
    preferences_get => QueryRequest::PreferencesGet {},
    reveal_item => QueryRequest::RevealItem { .. },
}
macro_rules! mutations {
    ($($name:ident => $variant:ident),+ $(,)?) => { $(
        #[tauri::command]
        pub async fn $name<R: tauri::Runtime>(request: OwnerMutationRequest, app: tauri::AppHandle<R>) -> MutationEnvelope {
            let matches = matches!(&request.command, OwnerCommand::$variant { .. });
            let service = app.state::<DesktopService>().inner().clone();
            let operation_id = request.command.operation_id().clone();
            blocking(move || {
            let envelope = service.owner(request, matches);
            if let ApplicationEnvelope::Success(SuccessEnvelope { data: MutationReceipt::Session(receipt), .. }) = &envelope.0 {
                // Revision hints are best effort. A failed event publication must
                // never turn an already durable receipt into a failed mutation.
                let _ = app.emit("ariadne://session_changed", SessionChangedHint {
                    session_id: receipt.session_id.clone(), revision: receipt.revision,
                });
            }
            if matches!(&envelope.0, ApplicationEnvelope::Success(SuccessEnvelope {data:MutationReceipt::PreferencesPatched(_),..})) {
                // OS reconciliation cannot change an already saved receipt.
                if let Some(window) = app.try_state::<crate::native::window::NativeWindow>() {
                    window.reconcile(app.clone(), false);
                }
            }
            envelope
            }).await.unwrap_or_else(|()| {
                MutationEnvelope(envelope(Err(CoreError::new(
                    CoreErrorCode::CommitUncertain,
                    "Desktop mutation worker terminated before returning a receipt.",
                    format!("Reconcile original operation {} before retrying it; do not allocate a new operation ID.", operation_id.as_str()),
                ))))
            })
        }
    )+ };
}
mutations! {
    project_register => ProjectRegister, binding_connect => BindingConnect,
    binding_pause => BindingPause, binding_resume => BindingResume, binding_disconnect => BindingDisconnect,
    input_submit => InputSubmit, input_cancel => InputCancel, input_resolve => InputResolve,
    topic_archive => TopicArchive, topic_restore => TopicRestore, session_close => SessionClose,
    session_reopen => SessionReopen, topic_continue => TopicContinue, preferences_patch => PreferencesPatch,
}

#[cfg(test)]
mod tests;
