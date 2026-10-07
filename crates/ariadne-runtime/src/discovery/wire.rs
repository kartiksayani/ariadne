use super::{bounded, invalid};
use crate::control::BindingScope;
use ariadne_core::CoreError;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoadedPlugin {
    pub name: String,
    pub root: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ModDescriptor {
    pub helper_path: String,
    pub app_version: String,
    pub api_version: u32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionAnnouncement {
    pub adapter_id: String,
    pub external_session_id: String,
    pub cwd: String,
    pub host_version: String,
    pub plugin: LoadedPlugin,
    pub descriptor: ModDescriptor,
    #[serde(deserialize_with = "nullable_scope")]
    pub binding_scope: Option<BindingScope>,
    /// Where the agent's terminal runs. `ariadne bridge announce` fills it from
    /// its own environment (inherited from Claude Code); intake normalizes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_location: Option<String>,
}
fn nullable_scope<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<BindingScope>, D::Error> {
    Option::deserialize(deserializer)
}
impl SessionAnnouncement {
    pub fn validate(&self) -> Result<(), CoreError> {
        if self.adapter_id != "claude_code_mod"
            || self.plugin.name != "ariadne"
            || self.descriptor.api_version != 1
            || [
                &self.external_session_id,
                &self.cwd,
                &self.host_version,
                &self.plugin.root,
                &self.descriptor.helper_path,
                &self.descriptor.app_version,
            ]
            .iter()
            .any(|value| !bounded(value))
            || [&self.cwd, &self.plugin.root, &self.descriptor.helper_path]
                .iter()
                .any(|value| {
                    let path = std::path::Path::new(value);
                    !path.is_absolute() || value.split('/').any(|part| matches!(part, "." | ".."))
                })
        {
            return Err(invalid("Mod announcement has invalid provider, SDK identity, descriptor or bounded absolute paths."));
        }
        Ok(())
    }
    pub fn acknowledgement(&self) -> AnnouncementAck {
        AnnouncementAck {
            adapter_id: self.adapter_id.clone(),
            external_session_id: self.external_session_id.clone(),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnnouncementAck {
    pub adapter_id: String,
    pub external_session_id: String,
}
