use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attention {
    pub kind: AttentionKind,
    /// The line that asked, as the child printed it, with terminal escapes removed.
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttentionKind {
    Login,
    Upgrade,
    Unknown,
}

impl AttentionKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            AttentionKind::Login => "login",
            AttentionKind::Upgrade => "upgrade",
            AttentionKind::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpencodeMode {
    Embed,
    External,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OpencodeState {
    Starting,
    Running,
    Missing,
    Restarting,
    Stopped,
    External,
    AuthRequired,
    AuthFailed,
    NeedsInput,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpencodePlan {
    pub mode: OpencodeMode,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub url: String,
    pub service_port: u16,
    pub api_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpencodeStatus {
    pub mode: OpencodeMode,
    pub state: OpencodeState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attention: Option<Attention>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeSource {
    Setting,
    Env,
    Path,
    Missing,
    External,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum RuntimeError {
    AuthParked,
    NeedsInput { attention: Attention },
    NotRunnable { detail: String },
    VersionExited { detail: String },
    VersionEmpty,
    VersionTimeout { seconds: u64 },
    NotFound,
}

impl RuntimeError {
    pub fn to_stored(&self) -> String {
        match self {
            RuntimeError::AuthParked => "authParked".into(),
            RuntimeError::NeedsInput { attention } => {
                format!(
                    "needsInput:{}:{}",
                    attention.kind.as_str(),
                    attention.message
                )
            }
            RuntimeError::NotRunnable { detail } => format!("notRunnable:{detail}"),
            RuntimeError::VersionExited { detail } => format!("versionExited:{detail}"),
            RuntimeError::VersionEmpty => "versionEmpty".into(),
            RuntimeError::VersionTimeout { seconds } => format!("versionTimeout:{seconds}"),
            RuntimeError::NotFound => "notFound".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpencodeRuntime {
    pub source: RuntimeSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub checked_at: u64,
}

pub fn resolve_mode(env_embed: Option<&str>, file_mode: Option<&str>) -> OpencodeMode {
    match env_embed {
        Some("0") => OpencodeMode::External,
        Some("1") => OpencodeMode::Embed,
        _ => match file_mode {
            Some("external") => OpencodeMode::External,
            Some("embed") => OpencodeMode::Embed,
            _ => OpencodeMode::Embed,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_mode_unset_defaults_to_embed() {
        assert_eq!(resolve_mode(None, None), OpencodeMode::Embed);
    }

    #[test]
    fn resolve_mode_env_zero_is_external() {
        assert_eq!(resolve_mode(Some("0"), None), OpencodeMode::External);
        assert_eq!(
            resolve_mode(Some("0"), Some("embed")),
            OpencodeMode::External
        );
    }

    #[test]
    fn resolve_mode_env_one_is_embed() {
        assert_eq!(resolve_mode(Some("1"), None), OpencodeMode::Embed);
        assert_eq!(
            resolve_mode(Some("1"), Some("external")),
            OpencodeMode::Embed
        );
    }

    #[test]
    fn resolve_mode_uses_file_when_env_absent() {
        assert_eq!(resolve_mode(None, Some("embed")), OpencodeMode::Embed);
        assert_eq!(resolve_mode(None, Some("external")), OpencodeMode::External);
    }

    #[test]
    fn resolve_mode_garbage_falls_back_to_file_then_embed() {
        assert_eq!(
            resolve_mode(Some("garbage"), Some("external")),
            OpencodeMode::External
        );
        assert_eq!(
            resolve_mode(Some("garbage"), Some("embed")),
            OpencodeMode::Embed
        );
        assert_eq!(resolve_mode(Some("garbage"), None), OpencodeMode::Embed);
        assert_eq!(resolve_mode(None, Some("garbage")), OpencodeMode::Embed);
    }

    #[test]
    fn a_stored_error_is_a_code_and_an_optional_detail() {
        assert_eq!(RuntimeError::AuthParked.to_stored(), "authParked");
        assert_eq!(RuntimeError::NotFound.to_stored(), "notFound");
        assert_eq!(RuntimeError::VersionEmpty.to_stored(), "versionEmpty");
        assert_eq!(
            RuntimeError::VersionTimeout { seconds: 10 }.to_stored(),
            "versionTimeout:10"
        );
        assert_eq!(
            RuntimeError::VersionExited {
                detail: "boom".into()
            }
            .to_stored(),
            "versionExited:boom"
        );
    }

    #[test]
    fn a_question_stores_the_kind_and_the_sentence() {
        let error = RuntimeError::NeedsInput {
            attention: Attention {
                kind: AttentionKind::Upgrade,
                message: "请下载新版本".into(),
            },
        };
        assert_eq!(error.to_stored(), "needsInput:upgrade:请下载新版本");
    }

    #[test]
    fn auth_states_serialise_the_way_the_service_reads_them() {
        assert_eq!(
            serde_json::to_string(&OpencodeState::AuthRequired).unwrap(),
            "\"authRequired\""
        );
        assert_eq!(
            serde_json::to_string(&OpencodeState::AuthFailed).unwrap(),
            "\"authFailed\""
        );
        assert_eq!(
            serde_json::to_string(&OpencodeState::Running).unwrap(),
            "\"running\""
        );
    }
}
