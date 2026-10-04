use ariadne_core::*;
use ariadne_domain::models::{SchemaVersion, UuidV4};

/// The one native geometry writer retains an attempted mutation verbatim until
/// its completion is known. It never stores a second preferences document.
#[derive(Default)]
pub(crate) struct WindowPreferenceWrite {
    pending: Option<OwnerMutationRequest>,
}

impl WindowPreferenceWrite {
    pub(crate) fn ready_to_exit(&self) -> Result<(), CoreError> {
        if self.pending.is_some() {
            return Err(CoreError::new(CoreErrorCode::CommitUncertain,
                "The native preference operation is still unconfirmed.",
                "Keep the app running and reconcile the same operation; saved effects may already exist."));
        }
        Ok(())
    }
    /// `false` means only an older exact operation was reconciled; the current
    /// unsent geometry must be captured against a fresh snapshot afterward.
    pub(crate) fn save(
        &mut self,
        geometry: WindowGeometry,
        allocate: impl FnOnce() -> UuidV4,
        read: impl FnOnce() -> Result<PreferencesSnapshot, CoreError>,
        execute: impl FnOnce(&OwnerMutationRequest) -> Result<PreferencesPatchedReceipt, CoreError>,
    ) -> Result<bool, CoreError> {
        let new = self.pending.is_none();
        if new {
            let snapshot = read()?;
            if snapshot.global.window.as_ref() == Some(&geometry) {
                return Ok(true);
            }
            let mut global = snapshot.global;
            global.window = Some(geometry);
            let request = OwnerMutationRequest {
                session: None,
                command: OwnerCommand::PreferencesPatch {
                    api_version: SchemaVersion::new(1).expect("literal"),
                    op_id: allocate(),
                    params: PreferencesPatch {
                        expected_preferences_revision: snapshot.revision,
                        entries: vec![PreferencesPatchEntry::SetGlobal {
                            preferences: global,
                        }],
                    },
                },
            };
            request.validate_wire()?;
            self.pending = Some(request);
        }
        let request = self.pending.as_ref().expect("prepared above");
        match execute(request) {
            Ok(receipt) if &receipt.operation_id == request.command.operation_id() => {
                self.pending = None;
                Ok(new)
            }
            Ok(_) => Err(CoreError::new(
                CoreErrorCode::ProtocolConflict,
                "The native preferences writer received a different operation receipt.",
                "Reconcile the original operation before another geometry mutation; its effects may already exist.",
            )),
            Err(error) => {
                if !matches!(error.code, CoreErrorCode::CommitUncertain | CoreErrorCode::ProtocolConflict) {
                    self.pending = None;
                }
                Err(error)
            }
        }
    }
}

#[cfg(test)]
#[path = "tests/preferences.rs"]
mod tests;
