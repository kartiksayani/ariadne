//! Native-only facts supplied by the future UID-checked Mod announcement intake.
use crate::normalization::error;
use ariadne_agent_protocol::{AdapterError, AdapterErrorCode, UtcMillis, UuidV4};
use std::{
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};

/// Actual SDK fields and imported descriptor values, not a claimed parity boolean.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedModIdentity {
    pub plugin_name: String,
    pub plugin_root: PathBuf,
    pub helper_path: PathBuf,
    pub app_version: String,
    pub api_version: u32,
    pub engine_version: String,
    pub external_session_id: String,
    pub project_root: PathBuf,
    pub binding_scope: Option<(UuidV4, UuidV4)>,
}

#[derive(Debug)]
pub struct ModEvidence {
    pub(crate) identity: LoadedModIdentity,
    pub(crate) observed_at: UtcMillis,
    pub(crate) received: Instant,
}
impl ModEvidence {
    /// The caller is trusted native intake: authenticate UID, validate association and use its
    /// native observation time before publishing. This is not a renderer/wire constructor.
    pub fn received(
        identity: LoadedModIdentity,
        observed_at: UtcMillis,
    ) -> Result<Self, AdapterError> {
        for value in [
            &identity.plugin_name,
            &identity.app_version,
            &identity.engine_version,
            &identity.external_session_id,
        ] {
            if value.trim().is_empty() || value.len() > 4096 {
                return Err(error(
                    AdapterErrorCode::InvalidArgument,
                    "Mod identity contains missing or oversized metadata",
                ));
            }
        }
        for path in [
            &identity.plugin_root,
            &identity.helper_path,
            &identity.project_root,
        ] {
            absolute(path)?;
        }
        Ok(Self {
            identity,
            observed_at,
            received: Instant::now(),
        })
    }
}

/// One latest presence snapshot, no lifecycle broker or transcript cache.
#[derive(Clone, Default)]
pub struct ModEvidenceSlot(Arc<Mutex<Option<Arc<ModEvidence>>>>);
impl ModEvidenceSlot {
    pub fn publish(&self, evidence: ModEvidence) -> Result<(), AdapterError> {
        *self.0.lock().map_err(|_| poisoned())? = Some(Arc::new(evidence));
        Ok(())
    }
    pub fn clear(&self) -> Result<(), AdapterError> {
        *self.0.lock().map_err(|_| poisoned())? = None;
        Ok(())
    }
    pub(crate) fn snapshot(&self) -> Result<Option<Arc<ModEvidence>>, AdapterError> {
        Ok(self.0.lock().map_err(|_| poisoned())?.clone())
    }
}
fn poisoned() -> AdapterError {
    error(
        AdapterErrorCode::HostUnreachable,
        "Mod evidence intake is unavailable; requalify before connecting",
    )
}
pub(crate) fn absolute(path: &Path) -> Result<(), AdapterError> {
    if !path.is_absolute()
        || path.as_os_str().len() > 4096
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(error(
            AdapterErrorCode::InvalidArgument,
            "Claude native paths must be explicit absolute paths without traversal",
        ));
    }
    Ok(())
}
