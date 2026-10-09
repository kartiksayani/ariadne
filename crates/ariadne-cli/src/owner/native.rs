use super::parser::Request;
use ariadne_core::{bindings::BindingService, native::NativeCoreService, *};
use ariadne_domain::models::{UtcMillis, UuidV4};
use ariadne_store::registry::Registry;

pub(super) fn execute(request: Request) -> Result<serde_json::Value, CoreError> {
    let home = crate::bridge::command::home_from_environment()?;
    let registry = if matches!(&request, Request::Mutation(wrapper)
        if matches!(wrapper.command, OwnerCommand::ProjectRegister { .. }))
    {
        Registry::create_data_directory(&home)?
    } else {
        Registry::open_data_directory(&home)?
    };
    if let Request::ReplayConnect(wrapper) = &request {
        // A miss is terminal here: this route never relays a fresh connect.
        let owner = OwnerContext::from_trusted_entrypoint(OwnerScope::Registry);
        let receipt = BindingService::new(&registry).replay_connect(&owner, &wrapper.command)?;
        if let Some(receipt) = &receipt {
            validate_owner_receipt(wrapper, receipt)?;
        }
        return serde_json::to_value(receipt)
            .map_err(|_| super::parser::invalid("Cannot serialize the canonical owner receipt."));
    }
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
            CoreErrorCode::HostUnreachable,
            "New binding connect requires the matching desktop's qualified provider composition.",
            "Open the matching desktop. Retain the original operation ID and parameters; check its exact saved receipt before repeating that operation.",
        ))
        },
    );
    if let Request::Mutation(wrapper) = &request {
        if matches!(wrapper.command, OwnerCommand::BindingConnect { .. }) {
            let owner = OwnerContext::from_trusted_entrypoint(OwnerScope::Registry);
            // Saved replay, including operation reuse conflicts, precedes any
            // desktop/provider dependency. The original request stays exact.
            let receipt = match BindingService::new(core.registry())
                .replay_connect(&owner, &wrapper.command)?
            {
                Some(receipt) => receipt,
                None => crate::bridge::binding_connect(home, wrapper.clone())?,
            };
            validate_owner_receipt(wrapper, &receipt)?;
            return serde_json::to_value(receipt).map_err(|_| {
                super::parser::invalid("Cannot serialize the canonical owner receipt.")
            });
        }
    }
    super::execute(&core, &|route| core.resolve_session(route), request)
}
