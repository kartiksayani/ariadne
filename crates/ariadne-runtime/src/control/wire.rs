//! Private control framing DTOs, shared with the installed bridge client.
use super::error;
use ariadne_core::{ClaimRequest, CoreError, CoreErrorCode, PreparedAttempt};
use ariadne_domain::models::{BindingSummary, UuidV4};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BindingScope {
    pub binding_id: UuidV4,
    pub generation: UuidV4,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RequestKind {
    Request,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ResponseKind {
    Response,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "method",
    content = "params",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ControlMethod {
    Ping(BindingScope),
    Claim(ClaimRequest),
    ConnectionStatus(BindingScope),
}
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ControlRequest {
    v: u8,
    kind: RequestKind,
    pub id: UuidV4,
    #[serde(flatten)]
    pub method: ControlMethod,
}
impl<'de> Deserialize<'de> for ControlRequest {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Params {
            Claim(ClaimRequest),
            Scope(BindingScope),
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Raw {
            v: u8,
            kind: RequestKind,
            id: UuidV4,
            method: String,
            params: Params,
        }
        let raw = Raw::deserialize(deserializer)?;
        let method = match (raw.method.as_str(), raw.params) {
            ("ping", Params::Scope(scope)) => ControlMethod::Ping(scope),
            ("claim", Params::Claim(request)) => ControlMethod::Claim(request),
            ("connection_status", Params::Scope(scope)) => ControlMethod::ConnectionStatus(scope),
            _ => {
                return Err(serde::de::Error::custom(
                    "Unknown private control method or mismatched params",
                ))
            }
        };
        Ok(Self {
            v: raw.v,
            kind: raw.kind,
            id: raw.id,
            method,
        })
    }
}
impl ControlRequest {
    pub fn new(id: UuidV4, method: ControlMethod) -> Result<Self, CoreError> {
        let request = Self {
            v: 1,
            kind: RequestKind::Request,
            id,
            method,
        };
        request.validate()?;
        Ok(request)
    }
    pub fn validate(&self) -> Result<(), CoreError> {
        if self.v != 1 {
            return Err(error(
                CoreErrorCode::Unsupported,
                "Control protocol version must be 1.",
            ));
        }
        if let ControlMethod::Claim(request) = &self.method {
            if request.request_id != self.id {
                return Err(error(
                    CoreErrorCode::InvalidArgument,
                    "Control claim id must equal its canonical request_id; retain it on retry.",
                ));
            }
        }
        Ok(())
    }
    pub fn scope(&self) -> BindingScope {
        match &self.method {
            ControlMethod::Ping(scope) | ControlMethod::ConnectionStatus(scope) => scope.clone(),
            ControlMethod::Claim(request) => BindingScope {
                binding_id: request.binding_id.clone(),
                generation: request.generation.clone(),
            },
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ControlResult {
    Status(BindingSummary),
    Ping(BindingScope),
    Claim(Option<PreparedAttempt>),
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SuccessResponse {
    v: u8,
    kind: ResponseKind,
    id: UuidV4,
    result: ControlResult,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ErrorResponse {
    v: u8,
    kind: ResponseKind,
    id: UuidV4,
    error: CoreError,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ControlResponse {
    Success(SuccessResponse),
    Error(ErrorResponse),
}
impl ControlResponse {
    pub(crate) fn from_result(id: UuidV4, result: Result<ControlResult, CoreError>) -> Self {
        match result {
            Ok(result) => Self::Success(SuccessResponse {
                v: 1,
                kind: ResponseKind::Response,
                id,
                result,
            }),
            Err(error) => Self::Error(ErrorResponse {
                v: 1,
                kind: ResponseKind::Response,
                id,
                error,
            }),
        }
    }
    pub fn into_result(self, request: &ControlRequest) -> Result<ControlResult, CoreError> {
        let (v, id) = match &self {
            Self::Success(response) => (response.v, &response.id),
            Self::Error(response) => (response.v, &response.id),
        };
        if v != 1 || id != &request.id {
            return Err(error(
                CoreErrorCode::ProtocolConflict,
                "Control response version or request ID differs.",
            ));
        }
        let response = match self {
            Self::Success(response) => response,
            Self::Error(response) => return Err(response.error),
        };
        match (&request.method, &response.result) {
            (ControlMethod::Ping(scope), ControlResult::Ping(result)) if scope == result => {}
            (ControlMethod::ConnectionStatus(scope), ControlResult::Status(result))
                if scope.binding_id == result.id && scope.generation == result.generation => {}
            (ControlMethod::Claim(request), ControlResult::Claim(result)) => {
                if let Some(result) = result {
                    result.validate_for(request)?;
                }
            }
            _ => {
                return Err(error(
                    CoreErrorCode::ProtocolConflict,
                    "Control response kind or binding scope differs from its request.",
                ))
            }
        }
        Ok(response.result)
    }
}
