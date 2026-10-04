//! Durable reports use registered disk state independently of desktop lifetime.
use ariadne_agent_protocol::NormalizedEvent;
use ariadne_core::{
    native::{AgentResolver, NativeCoreService},
    AdapterContext, CoreError, CoreErrorCode, EventReceipt,
};
use ariadne_domain::models::{UtcMillis, UuidV4};
use std::path::PathBuf;

pub(super) fn report(
    home: PathBuf,
    binding: UuidV4,
    generation: UuidV4,
    event: NormalizedEvent,
) -> Result<EventReceipt, CoreError> {
    let registry = AgentResolver::open_data_directory(&home)?;
    // Resolve retained membership, not selected-route eligibility: exact saved
    // event replay must survive rebind. Core authorizes new facts under its lock.
    let agent = AgentResolver::resolve(&registry, binding.clone(), generation.clone(), None, None)?;
    let context =
        AdapterContext::from_trusted_entrypoint(agent.session().clone(), binding, generation, None);
    let core = NativeCoreService::new(
        registry,
        || UuidV4::new(uuid::Uuid::new_v4().to_string()).expect("native UUIDv4"),
        || {
            UtcMillis::new(
                chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            )
            .expect("native UTC clock")
        },
        |_| {
            Err(CoreError::new(
                CoreErrorCode::Unsupported,
                "No provider verifier is composed for bridge reports.",
                "Use the matching desktop for new binding qualification.",
            ))
        },
    );
    super::report(&core, context, event)
}
