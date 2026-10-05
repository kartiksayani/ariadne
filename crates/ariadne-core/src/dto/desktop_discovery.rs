//! Advisory desktop projection; native qualification and clocks stay private.
use crate::{CoreError, SessionRef};
use ariadne_agent_protocol::{Availability, Compatibility};
use ariadne_domain::models::{EndpointRef, Freshness, UtcMillis, UuidV4};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct DesktopDiscoveryCandidate {
    pub adapter_id: String,
    pub endpoint: EndpointRef,
    pub external_session_id: String,
    pub cwd: String,
    pub title: Option<String>,
    pub host_version: String,
    pub observed_at: UtcMillis,
    pub freshness: Freshness,
    pub compatibility: Compatibility,
    pub availability: Availability,
    pub loaded: bool,
    pub binding_id: Option<UuidV4>,
    pub session: Option<SessionRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct DesktopDiscoverySnapshot {
    pub candidates: Vec<DesktopDiscoveryCandidate>,
    pub error: Option<CoreError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct DiscoveryUiOpenRequest {
    pub open: bool,
}
