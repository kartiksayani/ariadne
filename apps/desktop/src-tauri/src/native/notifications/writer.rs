use super::capture::WaitingCapture;
use super::policy::{evaluate, NotificationPlan};
use ariadne_core::*;
use ariadne_domain::models::{SchemaVersion, UtcMillis, UuidV4};

#[derive(Default)]
pub(crate) struct PreferenceWriter {
    pending: Option<(OwnerMutationRequest, NotificationPlan)>,
}

impl PreferenceWriter {
    pub(crate) fn pending(&self) -> bool {
        self.pending.is_some()
    }

    pub(crate) fn observe(
        &mut self,
        snapshot: PreferencesSnapshot,
        capture: &WaitingCapture,
        now: UtcMillis,
        allocate: impl FnOnce() -> UuidV4,
    ) -> Result<Option<NotificationPlan>, CoreError> {
        if self.pending() {
            return Ok(None);
        }
        let plan = evaluate(&snapshot.global, capture, now);
        self.prepare(snapshot, plan, allocate)
    }

    pub(crate) fn pin(
        &mut self,
        snapshot: PreferencesSnapshot,
        allocate: impl FnOnce() -> UuidV4,
    ) -> Result<(), CoreError> {
        if self.pending() {
            return Ok(());
        }
        let mut preferences = snapshot.global.clone();
        preferences.pinned = !preferences.pinned;
        self.prepare(
            snapshot,
            NotificationPlan {
                preferences,
                arrivals: vec![],
                diagnostic: None,
            },
            allocate,
        )?;
        Ok(())
    }

    fn prepare(
        &mut self,
        snapshot: PreferencesSnapshot,
        plan: NotificationPlan,
        allocate: impl FnOnce() -> UuidV4,
    ) -> Result<Option<NotificationPlan>, CoreError> {
        if plan.preferences == snapshot.global {
            return Ok(Some(plan));
        }
        let request = OwnerMutationRequest {
            session: None,
            command: OwnerCommand::PreferencesPatch {
                api_version: SchemaVersion::new(1).expect("literal"),
                op_id: allocate(),
                params: PreferencesPatch {
                    expected_preferences_revision: snapshot.revision,
                    entries: vec![PreferencesPatchEntry::SetGlobal {
                        preferences: plan.preferences.clone(),
                    }],
                },
            },
        };
        request.validate_wire()?;
        self.pending = Some((request, plan));
        Ok(None)
    }

    /// A lost receipt retries the exact frozen operation. No fresh revision or
    /// operation ID is substituted, and arrivals leave only after confirmation.
    pub(crate) fn confirm(
        &mut self,
        execute: impl FnOnce(&OwnerMutationRequest) -> Result<PreferencesPatchedReceipt, CoreError>,
    ) -> Result<Option<NotificationPlan>, CoreError> {
        let Some((request, _)) = &self.pending else {
            return Ok(None);
        };
        match execute(request) {
            Ok(receipt) if &receipt.operation_id == request.command.operation_id() => {
                Ok(self.pending.take().map(|(_, plan)| plan))
            }
            Ok(_) => Err(CoreError::new(
                CoreErrorCode::ProtocolConflict,
                "Notification preferences received a different operation receipt.",
                "Reconcile the original operation before observing more notifications.",
            )),
            Err(error) => {
                if !matches!(
                    error.code,
                    CoreErrorCode::CommitUncertain | CoreErrorCode::ProtocolConflict
                ) {
                    self.pending = None;
                }
                Err(error)
            }
        }
    }
}
