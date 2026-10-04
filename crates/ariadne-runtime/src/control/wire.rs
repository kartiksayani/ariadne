//! Private control framing DTOs, shared with the installed bridge client.
use super::{error, validated_error};
use crate::discovery::{AnnouncementAck, SessionAnnouncement};
use ariadne_core::{
    ClaimRequest, CoreError, CoreErrorCode, MutationReceipt, OwnerCommand, OwnerMutationRequest,
    PreparedAttempt,
};
use ariadne_domain::models::{BindingSummary, SavedReceiptData, UuidV4};
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
    BindingConnect(Box<OwnerMutationRequest>),
    SessionAnnouncement(SessionAnnouncement),
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
            Owner(Box<OwnerMutationRequest>),
            Claim(ClaimRequest),
            Scope(BindingScope),
            Announcement(SessionAnnouncement),
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
            ("binding_connect", Params::Owner(request)) => ControlMethod::BindingConnect(request),
            ("session_announcement", Params::Announcement(announcement)) => {
                ControlMethod::SessionAnnouncement(announcement)
            }
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
        if let ControlMethod::BindingConnect(request) = &self.method {
            request.validate_wire()?;
            if request.session.is_some()
                || !matches!(request.command, OwnerCommand::BindingConnect { .. })
                || request.command.operation_id() != &self.id
            {
                return Err(error(CoreErrorCode::InvalidArgument,
                    "Control binding_connect requires the canonical null-session BindingConnect request and id equal to op_id; retain the original operation."));
            }
        }
        if let ControlMethod::SessionAnnouncement(announcement) = &self.method {
            announcement.validate()?;
        }
        Ok(())
    }
    pub fn scope(&self) -> Option<BindingScope> {
        match &self.method {
            ControlMethod::Ping(scope) | ControlMethod::ConnectionStatus(scope) => {
                Some(scope.clone())
            }
            ControlMethod::Claim(request) => Some(BindingScope {
                binding_id: request.binding_id.clone(),
                generation: request.generation.clone(),
            }),
            ControlMethod::BindingConnect(_) => None,
            ControlMethod::SessionAnnouncement(_) => None,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ControlResult {
    Status(BindingSummary),
    Ping(BindingScope),
    Announcement(AnnouncementAck),
    Claim(Option<PreparedAttempt>),
    BindingConnect(MutationReceipt),
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
                error: validated_error(error),
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
            Self::Error(response) => return Err(validated_error(response.error)),
        };
        match (&request.method, &response.result) {
            (
                ControlMethod::SessionAnnouncement(announcement),
                ControlResult::Announcement(result),
            ) if announcement.acknowledgement() == *result => {}
            (ControlMethod::Ping(scope), ControlResult::Ping(result)) if scope == result => {}
            (ControlMethod::ConnectionStatus(scope), ControlResult::Status(result))
                if scope.binding_id == result.id && scope.generation == result.generation => {}
            (ControlMethod::Claim(request), ControlResult::Claim(result)) => {
                if let Some(result) = result {
                    result.validate_for(request)?;
                }
            }
            (ControlMethod::BindingConnect(request), ControlResult::BindingConnect(receipt)) => {
                validate_connect_receipt(request, receipt)?;
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

// A saved bootstrap receipt is not evidence of a live supervisor, lease or provider.
pub(crate) fn validate_connect_receipt(
    request: &OwnerMutationRequest,
    receipt: &MutationReceipt,
) -> Result<(), CoreError> {
    request.validate_wire()?;
    let (OwnerCommand::BindingConnect { op_id, params, .. }, MutationReceipt::Session(saved)) =
        (&request.command, receipt)
    else {
        return Err(connect_conflict());
    };
    let SavedReceiptData::BindingConnect {
        setup_instruction, ..
    } = &saved.data
    else {
        return Err(connect_conflict());
    };
    if request.session.is_some()
        || &saved.operation_id != op_id
        || params
            .existing_session_id
            .as_ref()
            .is_some_and(|id| id != &saved.session_id)
        || setup_instruction.trim().is_empty()
        || setup_instruction.contains('\0')
        || setup_instruction.len() > 64 * 1024
    {
        return Err(connect_conflict());
    }
    Ok(())
}
fn connect_conflict() -> CoreError {
    CoreError::new(CoreErrorCode::ProtocolConflict,
        "Binding connect returned a receipt with invalid kind, operation, selected session or setup instruction.",
        "Retain the original operation ID and parameters; effects may already exist. Look up the exact saved connect receipt before repeating that operation.")
}
