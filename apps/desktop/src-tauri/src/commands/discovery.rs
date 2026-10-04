use super::*;
use ariadne_runtime::discovery::DiscoverySnapshot;
use std::collections::BTreeSet;

const MAX_BYTES: usize = 1024 * 1024;
fn invalid() -> CoreError {
    CoreError::new(
        CoreErrorCode::ProtocolConflict,
        "Native discovery returned an invalid snapshot.",
        "Keep the last complete snapshot; manual registration and connection remain available.",
    )
}
pub(crate) fn validate(snapshot: &DesktopDiscoverySnapshot) -> Result<(), CoreError> {
    if snapshot.candidates.len() > 256 {
        return Err(CoreError::new(
            CoreErrorCode::CapacityExceeded,
            "Discovery exceeds 256 candidates.",
            "Close unused host sessions; manual connection remains available.",
        ));
    }
    let mut identities = BTreeSet::new();
    let bounded =
        |value: &str| !value.trim().is_empty() && !value.contains('\0') && value.len() <= 4096;
    for candidate in &snapshot.candidates {
        let endpoint = match &candidate.endpoint {
            ariadne_domain::models::EndpointRef::UnixSocket { path } => path,
            ariadne_domain::models::EndpointRef::LocalBridge { name } => name,
        };
        if ![
            &candidate.adapter_id,
            &candidate.external_session_id,
            &candidate.cwd,
            &candidate.host_version,
            endpoint,
        ]
        .into_iter()
        .all(|value| bounded(value))
            || candidate
                .title
                .as_ref()
                .is_some_and(|title| title.contains('\0') || title.len() > 4096)
            || candidate.binding_id.is_some() != candidate.session.is_some()
            || !identities.insert((
                candidate.adapter_id.clone(),
                serde_json::to_string(&candidate.endpoint).map_err(|_| invalid())?,
                candidate.external_session_id.clone(),
            ))
        {
            return Err(invalid());
        }
    }
    if let Some(error) = &snapshot.error {
        error.validate()?;
    }
    if serde_json::to_vec(snapshot).map_err(|_| invalid())?.len() > MAX_BYTES {
        return Err(CoreError::new(
            CoreErrorCode::CapacityExceeded,
            "Discovery exceeds its 1 MiB response limit.",
            "Close unused host sessions; manual connection remains available.",
        ));
    }
    Ok(())
}
pub(crate) fn project(snapshot: DiscoverySnapshot) -> Result<DesktopDiscoverySnapshot, CoreError> {
    let candidates = snapshot
        .candidates
        .into_iter()
        .map(|candidate| {
            Ok(DesktopDiscoveryCandidate {
                adapter_id: candidate.adapter_id,
                endpoint: candidate.endpoint,
                external_session_id: candidate.external_session_id,
                cwd: candidate.cwd.to_str().ok_or_else(invalid)?.to_owned(),
                title: candidate.title,
                host_version: candidate.host_version,
                observed_at: candidate.observed_at,
                freshness: candidate.freshness,
                compatibility: candidate.compatibility,
                availability: candidate.availability,
                loaded: candidate.loaded,
                binding_id: candidate
                    .binding
                    .as_ref()
                    .map(|binding| binding.binding_id.clone()),
                session: candidate.binding.map(|binding| binding.session),
            })
        })
        .collect::<Result<Vec<_>, CoreError>>()?;
    let result = DesktopDiscoverySnapshot {
        candidates,
        error: snapshot.error,
    };
    validate(&result)?;
    Ok(result)
}

#[tauri::command]
pub async fn discovery_snapshot<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<DesktopDiscoverySnapshot, CoreError> {
    let service = app.state::<DesktopService>().inner().clone();
    blocking(move || service.discovery())
        .await
        .map_err(|()| invalid())?
}
#[tauri::command]
pub async fn discovery_ui_open<R: tauri::Runtime>(
    request: DiscoveryUiOpenRequest,
    app: tauri::AppHandle<R>,
) -> Result<(), CoreError> {
    let service = app.state::<DesktopService>().inner().clone();
    blocking(move || service.set_connection_ui_open(request.open))
        .await
        .map_err(|()| invalid())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn candidate() -> DesktopDiscoveryCandidate {
        serde_json::from_value(serde_json::json!({"adapter_id":"codex","endpoint":{"kind":"unix_socket","path":"/tmp/codex.sock"},"external_session_id":"thread","cwd":"/tmp","title":null,"host_version":"fixture","observed_at":"2026-10-01T00:00:00.000Z","freshness":"fresh","compatibility":"unknown","availability":"unknown","loaded":true,"binding_id":null,"session":null})).unwrap()
    }
    #[test]
    fn bounds_and_exact_identity_are_enforced_without_truncation() {
        let mut snapshot = DesktopDiscoverySnapshot {
            candidates: vec![candidate()],
            error: None,
        };
        validate(&snapshot).unwrap();
        snapshot.candidates.push(candidate());
        assert!(validate(&snapshot).is_err());
        snapshot.candidates[1].endpoint = ariadne_domain::models::EndpointRef::LocalBridge {
            name: "other".into(),
        };
        validate(&snapshot).unwrap();
        snapshot.candidates = (0..257)
            .map(|i| {
                let mut c = candidate();
                c.external_session_id = i.to_string();
                c
            })
            .collect();
        assert_eq!(
            validate(&snapshot).unwrap_err().code,
            CoreErrorCode::CapacityExceeded
        );
        snapshot.candidates.truncate(256);
        for c in &mut snapshot.candidates {
            c.title = Some("界".repeat(1365));
        }
        assert_eq!(
            validate(&snapshot).unwrap_err().code,
            CoreErrorCode::CapacityExceeded
        );
        snapshot.candidates.truncate(1);
        snapshot.candidates[0].cwd.clear();
        assert!(validate(&snapshot).is_err());
    }
    #[test]
    fn open_request_accepts_only_boolean_and_no_authority() {
        assert!(serde_json::from_str::<DiscoveryUiOpenRequest>(r#"{"open":true}"#).is_ok());
        for value in [
            r#"{"open":"true"}"#,
            r#"{"open":true,"root":"/tmp"}"#,
            r#"{}"#,
        ] {
            assert!(serde_json::from_str::<DiscoveryUiOpenRequest>(value).is_err());
        }
    }
}
