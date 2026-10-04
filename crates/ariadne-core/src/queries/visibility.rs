use super::page::{digest, invalid};
use crate::*;
use ariadne_domain::models::*;
use serde_json::{json, Value};

pub(super) fn route(context: &QueryContext) -> Result<&RegisteredSession, CoreError> {
    match context.visibility() {
        QueryVisibility::Owner(owner) => match owner.scope() {
            OwnerScope::Session(route) => Ok(route),
            _ => Err(invalid("This query requires a registered session route")),
        },
        QueryVisibility::Agent(agent) => Ok(agent.session()),
    }
}
pub(super) fn actor(context: &QueryContext) -> Value {
    match context.visibility() {
        QueryVisibility::Owner(owner) => match owner.scope() {
            OwnerScope::Registry => json!(["owner", "registry"]),
            OwnerScope::Project(id) => json!(["owner", "project", id]),
            OwnerScope::Session(route) => {
                json!(["owner", "session", route.project_id(), route.session_id()])
            }
            OwnerScope::Preferences => json!(["owner", "preferences"]),
        },
        QueryVisibility::Agent(agent) => {
            let scope = match agent.read_scope() {
                AgentReadScope::Terminal {
                    issued_through_message_number,
                } => json!(["terminal", issued_through_message_number]),
                AgentReadScope::Dispatched {
                    source_input_id,
                    attempt_id,
                    issued_through_message_number,
                } => json!([
                    "dispatched",
                    source_input_id,
                    attempt_id,
                    issued_through_message_number
                ]),
            };
            json!([
                "agent",
                agent.session().project_id(),
                agent.session().session_id(),
                agent.binding_id(),
                agent.generation(),
                scope
            ])
        }
    }
}
pub(super) fn scope(context: &QueryContext, filter: Value) -> Result<Sha256, CoreError> {
    digest(&json!([actor(context), filter]))
}
pub(super) fn check(session: &Session, context: &QueryContext) -> Result<(), CoreError> {
    let route = route(context)?;
    if &session.id != route.session_id() || &session.project_id != route.project_id() {
        return Err(invalid("Session route does not match the snapshot"));
    }
    let QueryVisibility::Agent(agent) = context.visibility() else {
        return Ok(());
    };
    if session.active_binding_id.as_ref() != Some(agent.binding_id()) {
        return Err(CoreError::new(
            CoreErrorCode::BindingMismatch,
            "Read scope is not the selected binding",
            "Resolve the current binding.",
        ));
    }
    let binding = session
        .bindings
        .0
        .get(agent.binding_id())
        .ok_or_else(|| invalid("Read binding is missing"))?;
    if &binding.generation != agent.generation() {
        return Err(CoreError::new(
            CoreErrorCode::StaleGeneration,
            "Read scope uses an old generation",
            "Resolve the current native generation.",
        ));
    }
    let grant = agent.read_scope().issued_through_message_number().value();
    if grant > binding.issued_through_message_number.value() {
        return Err(invalid("Read grant exceeds the persisted issued watermark"));
    }
    if let AgentReadScope::Dispatched {
        source_input_id,
        attempt_id,
        ..
    } = agent.read_scope()
    {
        let input = session
            .inputs
            .0
            .get(source_input_id)
            .filter(|input| &input.binding_id == agent.binding_id())
            .ok_or_else(|| invalid("Read source input is outside this binding"))?;
        if !input
            .attempts
            .iter()
            .any(|attempt| &attempt.id == attempt_id)
        {
            return Err(invalid("Read attempt does not belong to its source input"));
        }
        let source = session
            .messages
            .iter()
            .find(|message| message.id == input.message_id)
            .ok_or_else(|| invalid("Read source message is missing"))?;
        if grant > source.number.value() {
            return Err(invalid("Read grant exceeds its source input issuance"));
        }
    }
    Ok(())
}
pub(super) fn message(context: &QueryContext, message: &Message) -> bool {
    !matches!(context.visibility(), QueryVisibility::Agent(agent) if message.author == MessageAuthor::Owner && message.number.value() > agent.read_scope().issued_through_message_number().value())
}
pub(super) fn message_id(session: &Session, context: &QueryContext, id: &UuidV4) -> bool {
    session
        .messages
        .iter()
        .find(|message| &message.id == id)
        .is_some_and(|value| message(context, value))
}
