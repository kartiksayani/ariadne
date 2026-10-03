//! Shared typed cases for producer and transport consumers. No domain execution.
use ariadne_agent_protocol::NormalizedEvent;
use ariadne_core::*;
use ariadne_domain::models::*;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Corpus {
    pub routing: Routing,
    pub cases: Vec<Case>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Routing {
    pub project_id: UuidV4,
    pub session_id: UuidV4,
    pub binding_id: UuidV4,
    pub generation: UuidV4,
    pub source_input_id: UuidV4,
    pub attempt_id: UuidV4,
    pub issued_through_message_number: NonnegativeSafeInteger,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Case {
    pub name: String,
    pub steps: Vec<CaseStep>,
}
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Audience {
    Owner,
    Agent,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
pub enum CaseStep {
    Query {
        audience: Audience,
        request: Box<QueryRequest>,
        response: Box<QueryEnvelope>,
    },
    Owner {
        request: Box<OwnerCommand>,
        response: Box<MutationEnvelope>,
    },
    Apply {
        request: Box<ApplyRequest>,
        response: Box<ApplyEnvelope>,
    },
    Claim {
        current_generation: UuidV4,
        request: ClaimRequest,
        response: Box<ClaimEnvelope>,
    },
    Report {
        historical: bool,
        event: Box<NormalizedEvent>,
        response: Box<ReportEnvelope>,
    },
    Checkpoint {
        checkpoint: Checkpoint,
    },
}
pub fn load(root: &Path) -> Corpus {
    serde_json::from_slice(&std::fs::read(root.join("fixtures/contracts/core/cases.json")).unwrap())
        .unwrap()
}
pub fn result<T: Clone>(envelope: &ApplicationEnvelope<T>) -> Result<T, CoreError> {
    match envelope {
        ApplicationEnvelope::Success(value) => Ok(value.data.clone()),
        ApplicationEnvelope::Failure(value) => Err(value.error.clone()),
    }
}
pub fn envelope<T>(value: Result<T, CoreError>) -> ApplicationEnvelope<T> {
    match value {
        Ok(data) => ApplicationEnvelope::Success(SuccessEnvelope {
            api_version: SchemaVersion::new(1).unwrap(),
            ok: SuccessFlag,
            data,
        }),
        Err(error) => ApplicationEnvelope::Failure(FailureEnvelope {
            api_version: SchemaVersion::new(1).unwrap(),
            ok: FailureFlag,
            error,
        }),
    }
}
impl Routing {
    pub fn session(&self) -> RegisteredSession {
        RegisteredSession::from_trusted_entrypoint(self.project_id.clone(), self.session_id.clone())
    }
    pub fn owner(&self) -> OwnerContext {
        OwnerContext::from_trusted_entrypoint(OwnerScope::Session(self.session()))
    }
    pub fn agent(&self) -> AgentContext {
        AgentContext::from_trusted_entrypoint(
            self.session(),
            self.binding_id.clone(),
            self.generation.clone(),
            AgentReadScope::Dispatched {
                source_input_id: self.source_input_id.clone(),
                attempt_id: self.attempt_id.clone(),
                issued_through_message_number: self.issued_through_message_number,
            },
        )
    }
    pub fn query(&self, audience: Audience) -> QueryContext {
        match audience {
            Audience::Owner => QueryContext::owner(self.owner()),
            Audience::Agent => QueryContext::agent(self.agent()),
        }
    }
    pub fn dispatch(&self, generation: UuidV4) -> ValidatedDispatchContext {
        ValidatedDispatchContext::from_trusted_current_lease(
            self.session(),
            self.binding_id.clone(),
            generation,
        )
    }
    pub fn adapter(&self, historical: bool, event: &NormalizedEvent) -> AdapterContext {
        let scope = historical.then(|| {
            VerifiedHistoricalScope::from_trusted_reconciliation(
                event.generation.clone(),
                event.input_id.clone().unwrap(),
                event.attempt_id.clone().unwrap(),
                EndpointFingerprint("verified test host".into()),
            )
        });
        AdapterContext::from_trusted_entrypoint(
            self.session(),
            self.binding_id.clone(),
            self.generation.clone(),
            scope,
        )
    }
}

// Accept any production CoreService here. The contract task supplies a script;
// later producer tests must seed real stores and exercise semantic effects.
pub fn run(service: &dyn CoreService, routing: &Routing, case: &Case) -> Option<Checkpoint> {
    let mut checkpoint = None;
    let mut persistence_failed = false;
    let mut reported = 0;
    fn equal<T: Serialize>(actual: ApplicationEnvelope<T>, expected: &ApplicationEnvelope<T>) {
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
    }
    for step in &case.steps {
        match step {
            CaseStep::Query {
                audience,
                request,
                response,
            } => equal(
                envelope(service.query(routing.query(*audience), *request.clone())),
                response,
            ),
            CaseStep::Owner { request, response } => equal(
                envelope(service.execute_owner(routing.owner(), *request.clone())),
                response,
            ),
            CaseStep::Apply { request, response } => equal(
                envelope(service.apply(routing.agent(), *request.clone())),
                response,
            ),
            CaseStep::Claim {
                current_generation,
                request,
                response,
            } => equal(
                envelope(service.claim(
                    routing.dispatch(current_generation.clone()),
                    request.clone(),
                )),
                response,
            ),
            CaseStep::Report {
                historical,
                event,
                response,
            } => {
                let value = service.report(routing.adapter(*historical, event), *event.clone());
                persistence_failed |= value.is_err();
                reported += 1;
                equal(envelope(value), response);
            }
            CaseStep::Checkpoint { checkpoint: next } => {
                assert!(
                    reported > 0 && !persistence_failed,
                    "checkpoint cannot advance before every batch effect persists"
                );
                checkpoint = Some(next.clone());
            }
        }
    }
    checkpoint
}
