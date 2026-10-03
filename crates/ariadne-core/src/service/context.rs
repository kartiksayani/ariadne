//! Trusted local routing values, deliberately absent from all wire schemas.
//! Constructors are assertions by entrypoints, not an OS-account security boundary.
use ariadne_domain::models::*;

#[derive(Debug, Clone, PartialEq)]
pub struct RegisteredSession {
    project_id: UuidV4,
    session_id: UuidV4,
}
impl RegisteredSession {
    /// The caller has resolved both IDs through the project registry.
    pub fn from_trusted_entrypoint(project_id: UuidV4, session_id: UuidV4) -> Self {
        Self {
            project_id,
            session_id,
        }
    }
    pub fn project_id(&self) -> &UuidV4 {
        &self.project_id
    }
    pub fn session_id(&self) -> &UuidV4 {
        &self.session_id
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum OwnerScope {
    Registry,
    Project(UuidV4),
    Session(RegisteredSession),
    Preferences,
}
#[derive(Debug, Clone, PartialEq)]
pub struct OwnerContext {
    scope: OwnerScope,
}
impl OwnerContext {
    /// Only explicit local owner/setup routes call this; models never choose a scope.
    pub fn from_trusted_entrypoint(scope: OwnerScope) -> Self {
        Self { scope }
    }
    pub fn scope(&self) -> &OwnerScope {
        &self.scope
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum AgentReadScope {
    Terminal {
        issued_through_message_number: NonnegativeSafeInteger,
    },
    Dispatched {
        source_input_id: UuidV4,
        attempt_id: UuidV4,
        issued_through_message_number: NonnegativeSafeInteger,
    },
}
impl AgentReadScope {
    pub fn issued_through_message_number(&self) -> NonnegativeSafeInteger {
        match self {
            Self::Terminal {
                issued_through_message_number,
            }
            | Self::Dispatched {
                issued_through_message_number,
                ..
            } => *issued_through_message_number,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentContext {
    session: RegisteredSession,
    binding_id: UuidV4,
    generation: UuidV4,
    read_scope: AgentReadScope,
}
impl AgentContext {
    /// The entrypoint resolves the binding and persisted issued watermark. Core
    /// rechecks binding, generation and attempt/watermark under its transaction.
    pub fn from_trusted_entrypoint(
        session: RegisteredSession,
        binding_id: UuidV4,
        generation: UuidV4,
        read_scope: AgentReadScope,
    ) -> Self {
        Self {
            session,
            binding_id,
            generation,
            read_scope,
        }
    }
    pub fn session(&self) -> &RegisteredSession {
        &self.session
    }
    pub fn binding_id(&self) -> &UuidV4 {
        &self.binding_id
    }
    pub fn generation(&self) -> &UuidV4 {
        &self.generation
    }
    pub fn read_scope(&self) -> &AgentReadScope {
        &self.read_scope
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum QueryVisibility {
    Owner(OwnerContext),
    Agent(AgentContext),
}
#[derive(Debug, Clone, PartialEq)]
pub struct QueryContext {
    visibility: QueryVisibility,
}
impl QueryContext {
    pub fn owner(context: OwnerContext) -> Self {
        Self {
            visibility: QueryVisibility::Owner(context),
        }
    }
    pub fn agent(context: AgentContext) -> Self {
        Self {
            visibility: QueryVisibility::Agent(context),
        }
    }
    pub fn visibility(&self) -> &QueryVisibility {
        &self.visibility
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedDispatchContext {
    session: RegisteredSession,
    binding_id: UuidV4,
    generation: UuidV4,
}
impl ValidatedDispatchContext {
    /// Runtime calls this only while holding the current binding OS lease.
    /// Core rechecks that lease and persisted scope/state under the transaction.
    pub fn from_trusted_current_lease(
        session: RegisteredSession,
        binding_id: UuidV4,
        generation: UuidV4,
    ) -> Self {
        Self {
            session,
            binding_id,
            generation,
        }
    }
    pub fn session(&self) -> &RegisteredSession {
        &self.session
    }
    pub fn binding_id(&self) -> &UuidV4 {
        &self.binding_id
    }
    pub fn generation(&self) -> &UuidV4 {
        &self.generation
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedHistoricalScope {
    originating_generation: UuidV4,
    input_id: UuidV4,
    attempt_id: UuidV4,
    endpoint_fingerprint: EndpointFingerprint,
}
impl VerifiedHistoricalScope {
    /// The adapter has verified exact host identity and requested attempt scope.
    /// Scope alone is never evidence that delivery or completion happened.
    pub fn from_trusted_reconciliation(
        originating_generation: UuidV4,
        input_id: UuidV4,
        attempt_id: UuidV4,
        endpoint_fingerprint: EndpointFingerprint,
    ) -> Self {
        Self {
            originating_generation,
            input_id,
            attempt_id,
            endpoint_fingerprint,
        }
    }
    pub fn originating_generation(&self) -> &UuidV4 {
        &self.originating_generation
    }
    pub fn input_id(&self) -> &UuidV4 {
        &self.input_id
    }
    pub fn attempt_id(&self) -> &UuidV4 {
        &self.attempt_id
    }
    pub fn endpoint_fingerprint(&self) -> &EndpointFingerprint {
        &self.endpoint_fingerprint
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AdapterContext {
    session: RegisteredSession,
    binding_id: UuidV4,
    current_generation: UuidV4,
    historical_scope: Option<VerifiedHistoricalScope>,
}
impl AdapterContext {
    /// Ordinary reports use no historical scope. Historical matched facts require
    /// verified reconciliation; core may record them but never reopen sealed work.
    pub fn from_trusted_entrypoint(
        session: RegisteredSession,
        binding_id: UuidV4,
        current_generation: UuidV4,
        historical_scope: Option<VerifiedHistoricalScope>,
    ) -> Self {
        Self {
            session,
            binding_id,
            current_generation,
            historical_scope,
        }
    }
    pub fn session(&self) -> &RegisteredSession {
        &self.session
    }
    pub fn binding_id(&self) -> &UuidV4 {
        &self.binding_id
    }
    pub fn current_generation(&self) -> &UuidV4 {
        &self.current_generation
    }
    pub fn historical_scope(&self) -> Option<&VerifiedHistoricalScope> {
        self.historical_scope.as_ref()
    }
}
