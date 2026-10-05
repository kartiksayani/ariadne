//! One native registered-binding resolver shared by installed agent transports.
use crate::{AgentContext, AgentReadScope, CoreError, CoreErrorCode, RegisteredSession};
use ariadne_domain::models::*;
use ariadne_store::registry::{Registry, RegistryCatalogue};
use std::path::Path;

/// Routing is reconstructed from authoritative retained snapshots.
/// This helper carries no provider lease, cached generation or mutable eligibility.
pub struct AgentResolver;
impl AgentResolver {
    pub fn open_data_directory(path: &Path) -> Result<Registry, CoreError> {
        Registry::open_data_directory(path).map_err(super::errors::registry)
    }
    pub fn resolve(
        registry: &Registry,
        binding_id: UuidV4,
        generation: UuidV4,
        source: Option<UuidV4>,
        attempt_id: Option<UuidV4>,
    ) -> Result<AgentContext, CoreError> {
        if source.is_some() != attempt_id.is_some() {
            return Err(invalid(
                "Source input and attempt must both be supplied or both absent.",
            ));
        }
        let catalogue = registry.catalogue().map_err(super::errors::registry)?;
        Self::resolve_from_catalogue(&catalogue, binding_id, generation, source, attempt_id)
    }
    /// Resolve a binding from one complete, freshly captured native catalogue.
    /// This does not prove current dispatch eligibility; callers must retain
    /// their authoritative session/transaction checks after resolving the route.
    pub fn resolve_from_catalogue(
        catalogue: &RegistryCatalogue,
        binding_id: UuidV4,
        generation: UuidV4,
        source: Option<UuidV4>,
        attempt_id: Option<UuidV4>,
    ) -> Result<AgentContext, CoreError> {
        if source.is_some() != attempt_id.is_some() {
            return Err(invalid(
                "Source input and attempt must both be supplied or both absent.",
            ));
        }
        let mut found = None;
        for project in &catalogue.projects {
            let project = project.result.as_ref().map_err(super::errors::store_ref)?;
            for outcome in project
                .sessions
                .as_ref()
                .map_err(super::errors::store_ref)?
            {
                let session = outcome.result.as_ref().map_err(super::errors::store_ref)?;
                if session.bindings.0.contains_key(&binding_id) && found.replace(session).is_some()
                {
                    return Err(CoreError::new(
                        CoreErrorCode::BindingAmbiguous,
                        "Binding ID occurs in more than one registered session.",
                        "Resolve the duplicate registered identities before retrying.",
                    ));
                }
            }
        }
        let session = found.ok_or_else(|| {
            CoreError::new(
                CoreErrorCode::NotFound,
                "Binding ID is not retained in any registered session.",
                "Use an explicitly registered binding ID.",
            )
        })?;
        let binding = &session.bindings.0[&binding_id];
        let issued = binding.issued_through_message_number;
        let scope = match (source, attempt_id) {
            (None, None) => AgentReadScope::Terminal {
                issued_through_message_number: issued,
            },
            (Some(source_input_id), Some(attempt_id)) => {
                let input = session
                    .inputs
                    .0
                    .get(&source_input_id)
                    .filter(|input| {
                        input.binding_id == binding_id
                            && input
                                .attempts
                                .iter()
                                .any(|attempt| attempt.id == attempt_id)
                    })
                    .ok_or_else(|| {
                        invalid("Source input/attempt is not retained in this binding.")
                    })?;
                let message = session
                    .messages
                    .iter()
                    .find(|message| {
                        message.id == input.message_id
                            && message.author == MessageAuthor::Owner
                            && message.input_id.as_ref() == Some(&source_input_id)
                    })
                    .ok_or_else(|| invalid("Source owner message is missing."))?;
                AgentReadScope::Dispatched {
                    source_input_id,
                    attempt_id,
                    issued_through_message_number: NonnegativeSafeInteger::new(
                        issued.value().min(message.number.value()),
                    )
                    .expect("validated counters"),
                }
            }
            _ => unreachable!("paired above"),
        };
        // Do not precheck selected route, generation, active attempt or seal: Apply's
        // locked exact receipt replay must remain available after rebind/reconciliation.
        Ok(AgentContext::from_trusted_entrypoint(
            RegisteredSession::from_trusted_entrypoint(
                session.project_id.clone(),
                session.id.clone(),
            ),
            binding_id,
            generation,
            scope,
        ))
    }
}
fn invalid(message: &str) -> CoreError {
    super::errors::local(CoreErrorCode::InvalidArgument, message)
}
