use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::model::{Attention, OpencodeMode, OpencodeState, OpencodeStatus};

#[derive(Serialize, Deserialize)]
struct ModeFile {
    opencode: OpencodeMode,
}

pub fn read_mode(path: &Path) -> OpencodeMode {
    let Ok(text) = std::fs::read_to_string(path) else {
        return OpencodeMode::Embed;
    };
    match serde_json::from_str::<ModeFile>(&text) {
        Ok(file) => file.opencode,
        Err(_) => OpencodeMode::Embed,
    }
}

#[cfg(test)]
pub fn write_mode(path: &Path, mode: OpencodeMode) -> std::io::Result<()> {
    let json = serde_json::to_string(&ModeFile { opencode: mode })
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, json)
}

pub fn write_status(
    path: &Path,
    mode: OpencodeMode,
    state: OpencodeState,
    url: Option<&str>,
    creds: Option<(&str, &str)>,
) -> std::io::Result<()> {
    write_status_asking(path, mode, state, url, creds, None)
}

pub fn write_status_asking(
    path: &Path,
    mode: OpencodeMode,
    state: OpencodeState,
    url: Option<&str>,
    creds: Option<(&str, &str)>,
    attention: Option<Attention>,
) -> std::io::Result<()> {
    let status = OpencodeStatus {
        mode,
        state,
        url: url.map(str::to_string),
        username: creds.map(|(username, _)| username.to_string()),
        password: creds.map(|(_, password)| password.to_string()),
        attention,
    };
    let json = serde_json::to_string(&status)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, json)?;
    owner_only(path);
    Ok(())
}

pub fn read_status(path: &Path) -> Option<OpencodeStatus> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn read_desktop_bin(path: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let bin = value.get("opencodeBin")?.as_str()?.trim();
    if bin.is_empty() {
        None
    } else {
        Some(PathBuf::from(bin))
    }
}

/// Preserve unrelated fields when changing the chosen binary.
pub fn write_desktop_bin(path: &Path, bin: Option<&str>) -> std::io::Result<()> {
    let mut value: serde_json::Value = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !value.is_object() {
        value = serde_json::json!({});
    }
    {
        let object = value.as_object_mut().expect("checked above");
        match bin.map(str::trim).filter(|value| !value.is_empty()) {
            Some(chosen) => {
                object.insert("opencodeBin".into(), serde_json::json!(chosen));
            }
            None => {
                object.remove("opencodeBin");
            }
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, format!("{json}\n"))?;
    owner_only(path);
    Ok(())
}

pub(crate) const PID_FILE_VERSION: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct PidRecord {
    pub(crate) version: u8,
    pub(crate) pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) started: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) command: Option<String>,
}

pub(crate) fn read_pid_record(path: &Path) -> Option<PidRecord> {
    let text = std::fs::read_to_string(path).ok()?;
    let text = text.trim();
    if let Ok(pid) = text.parse() {
        return Some(PidRecord {
            version: 0,
            pid,
            started: None,
            command: None,
        });
    }
    let record: PidRecord = serde_json::from_str(text).ok()?;
    (record.version == PID_FILE_VERSION).then_some(record)
}

pub(crate) fn write_pid_record(path: &Path, record: &PidRecord) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string(record)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, format!("{json}\n"))?;
    owner_only(path);
    Ok(())
}

#[cfg(unix)]
pub(crate) fn owner_only(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
pub(crate) fn owner_only(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::super::test_support::{sample_plan, temp_path};
    use super::*;
    use std::fs;

    #[test]
    fn desktop_bin_round_trips_and_keeps_other_fields() {
        let desktop = temp_path("desktop.json");
        fs::write(&desktop, r#"{"opencode":"external","other":1}"#).unwrap();
        write_desktop_bin(&desktop, Some("/opt/example/opencode")).unwrap();
        assert_eq!(
            read_desktop_bin(&desktop),
            Some(PathBuf::from("/opt/example/opencode"))
        );
        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&desktop).unwrap()).unwrap();
        assert_eq!(value["opencode"], "external");
        assert_eq!(value["other"], 1);

        write_desktop_bin(&desktop, None).unwrap();
        assert_eq!(read_desktop_bin(&desktop), None);
        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&desktop).unwrap()).unwrap();
        assert_eq!(value["opencode"], "external");
    }

    #[test]
    fn mode_and_status_files_round_trip_in_temp_dir() {
        let mode_path = temp_path("mode.json");
        write_mode(&mode_path, OpencodeMode::External).expect("write external mode");
        assert_eq!(read_mode(&mode_path), OpencodeMode::External);
        let mode_text = fs::read_to_string(&mode_path).unwrap();
        let mode_json: serde_json::Value = serde_json::from_str(&mode_text).unwrap();
        assert_eq!(mode_json["opencode"], "external");

        write_mode(&mode_path, OpencodeMode::Embed).expect("write embed mode");
        assert_eq!(read_mode(&mode_path), OpencodeMode::Embed);

        let status_path = temp_path("status.json");
        write_status(
            &status_path,
            OpencodeMode::Embed,
            OpencodeState::Running,
            Some("http://127.0.0.1:43123"),
            None,
        )
        .expect("write running status");
        let status = read_status(&status_path).expect("read status");
        assert_eq!(status.mode, OpencodeMode::Embed);
        assert_eq!(status.state, OpencodeState::Running);
        assert_eq!(status.url.as_deref(), Some("http://127.0.0.1:43123"));
        let status_text = fs::read_to_string(&status_path).unwrap();
        let status_json: serde_json::Value = serde_json::from_str(&status_text).unwrap();
        assert_eq!(status_json["mode"], "embed");
        assert_eq!(status_json["state"], "running");
        assert_eq!(status_json["url"], "http://127.0.0.1:43123");

        write_status(
            &status_path,
            OpencodeMode::External,
            OpencodeState::Stopped,
            None,
            None,
        )
        .expect("write stopped status");
        let stopped = read_status(&status_path).expect("read stopped status");
        assert_eq!(stopped.mode, OpencodeMode::External);
        assert_eq!(stopped.state, OpencodeState::Stopped);
        assert_eq!(stopped.url, None);
        let stopped_text = fs::read_to_string(&status_path).unwrap();
        let stopped_json: serde_json::Value = serde_json::from_str(&stopped_text).unwrap();
        assert!(stopped_json.get("url").is_none());
    }

    #[test]
    fn status_json_carries_the_pair_while_up_and_drops_it_when_stopped() {
        let plan = sample_plan();
        let path = temp_path("status.json");
        write_status(
            &path,
            plan.mode,
            OpencodeState::Running,
            Some(&plan.url),
            Some((plan.username.as_str(), plan.password.as_str())),
        )
        .expect("write running status");
        let running = read_status(&path).expect("read running status");
        assert_eq!(running.username.as_deref(), Some(plan.username.as_str()));
        assert_eq!(running.password.as_deref(), Some(plan.password.as_str()));

        write_status(
            &path,
            plan.mode,
            OpencodeState::Stopped,
            Some(&plan.url),
            None,
        )
        .expect("write stopped status");
        let text = fs::read_to_string(&path).unwrap();
        assert!(
            !text.contains(&plan.password),
            "status JSON must not contain the password: {text}"
        );
    }

    #[test]
    fn read_mode_defaults_to_embed_for_missing_unreadable_or_invalid() {
        let missing = temp_path("missing.json");
        fs::remove_file(&missing).ok();
        assert_eq!(read_mode(&missing), OpencodeMode::Embed);

        let garbage = temp_path("garbage.json");
        fs::write(&garbage, r#"{"opencode":"wat"}"#).unwrap();
        assert_eq!(read_mode(&garbage), OpencodeMode::Embed);

        let not_json = temp_path("plain.txt");
        fs::write(&not_json, "external").unwrap();
        assert_eq!(read_mode(&not_json), OpencodeMode::Embed);
    }

    #[test]
    fn read_status_returns_none_when_missing() {
        let missing = temp_path("missing-status.json");
        fs::remove_file(&missing).ok();
        assert!(read_status(&missing).is_none());
    }
}
