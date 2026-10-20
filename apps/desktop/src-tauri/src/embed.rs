use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpencodeMode {
    Embed,
    External,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpencodeState {
    Starting,
    Running,
    Missing,
    Restarting,
    Stopped,
    External,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpencodePlan {
    pub mode: OpencodeMode,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpencodeStatus {
    pub mode: OpencodeMode,
    pub state: OpencodeState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct ModeFile {
    opencode: OpencodeMode,
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

pub fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// Whether this port can still be taken on the loopback.
pub fn port_is_free(port: u16) -> bool {
    port > 0 && TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// The port the last run used, as the status file still names it.
///
/// The embedded server belongs to one run of the app, but its address does not
/// have to change every time. Reusing the port keeps the remembered connection
/// the same entry instead of a new one on every launch.
pub fn previous_port(path: &Path) -> Option<u16> {
    let url = read_status(path)?.url?;
    let rest = url.strip_prefix("http://")?;
    let host = rest.split('/').next()?;
    let (_, port) = host.rsplit_once(':')?;
    port.parse().ok()
}

pub fn random_password() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("CSPRNG should provide 32 bytes");
    encode_base64url_nopad(&bytes)
}

fn encode_base64url_nopad(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((bytes.len() * 4 + 2) / 3);
    let mut chunks = bytes.chunks_exact(3);
    for chunk in chunks.by_ref() {
        let n = ((chunk[0] as u32) << 16) | ((chunk[1] as u32) << 8) | (chunk[2] as u32);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push(TABLE[(n & 63) as usize] as char);
    }
    let rem = chunks.remainder();
    if rem.len() == 1 {
        let n = (rem[0] as u32) << 16;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
    } else if rem.len() == 2 {
        let n = ((rem[0] as u32) << 16) | ((rem[1] as u32) << 8);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
    }
    out
}

fn encode_base64_std(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    let mut chunks = bytes.chunks_exact(3);
    for chunk in chunks.by_ref() {
        let n = ((chunk[0] as u32) << 16) | ((chunk[1] as u32) << 8) | (chunk[2] as u32);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push(TABLE[(n & 63) as usize] as char);
    }
    let rem = chunks.remainder();
    if rem.len() == 1 {
        let n = (rem[0] as u32) << 16;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem.len() == 2 {
        let n = ((rem[0] as u32) << 16) | ((rem[1] as u32) << 8);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}

fn http_host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("http://")?;
    let host = rest.split('/').next().unwrap_or(rest);
    if host.is_empty() {
        return None;
    }
    Some(host.to_string())
}

pub fn health_ok(url: &str, username: &str, password: &str) -> bool {
    let Some(host) = http_host(url) else {
        return false;
    };
    let addr_text = if host.contains(':') {
        host.clone()
    } else {
        format!("{host}:80")
    };
    let Ok(addr) = addr_text.parse::<SocketAddr>() else {
        return false;
    };
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    if stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .is_err()
    {
        return false;
    }
    let credential = format!("{username}:{password}");
    let request = format!(
        "GET /global/health HTTP/1.1\r\nHost: {host}\r\nAuthorization: Basic {}\r\nConnection: close\r\n\r\n",
        encode_base64_std(credential.as_bytes())
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let _ = stream.flush();
    let mut buf = [0u8; 1024];
    let n = match stream.read(&mut buf) {
        Ok(0) | Err(_) => return false,
        Ok(n) => n,
    };
    let text = String::from_utf8_lossy(&buf[..n]);
    let status_line = text.lines().next().unwrap_or("");
    status_line.contains(" 200 ")
}

/// Plan the embedded server, preferring a port that is still free.
///
/// A preferred port is only a preference: anything else already on the
/// loopback — a second app, an `opencode serve` of the user's own — wins over
/// it, and the server takes a free port instead.
pub fn plan_with_port(mode: OpencodeMode, preferred: Option<u16>) -> std::io::Result<OpencodePlan> {
    match mode {
        OpencodeMode::External => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "plan() only supports embed mode",
        )),
        OpencodeMode::Embed => {
            let port = match preferred {
                Some(port) if port_is_free(port) => port,
                _ => free_port()?,
            };
            let password = random_password();
            Ok(OpencodePlan {
                mode,
                port,
                username: "opencode".into(),
                password,
                url: format!("http://127.0.0.1:{port}"),
            })
        }
    }
}

pub fn serve_args(port: u16) -> Vec<String> {
    vec![
        "serve".into(),
        "--hostname".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
    ]
}

pub fn child_env(plan: &OpencodePlan) -> Vec<(String, String)> {
    vec![
        ("OPENCODE_SERVER_USERNAME".into(), plan.username.clone()),
        ("OPENCODE_SERVER_PASSWORD".into(), plan.password.clone()),
    ]
}

pub fn service_env(plan: &OpencodePlan) -> Vec<(String, String)> {
    vec![
        ("STRATA_OPENCODE_URL".into(), plan.url.clone()),
        ("STRATA_OPENCODE_USERNAME".into(), plan.username.clone()),
        ("STRATA_OPENCODE_PASSWORD".into(), plan.password.clone()),
    ]
}

pub fn backoff(attempt: u32) -> Duration {
    match attempt {
        1 => Duration::from_secs(1),
        2 => Duration::from_secs(2),
        3 => Duration::from_secs(4),
        4 => Duration::from_secs(8),
        _ => Duration::from_secs(30),
    }
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
) -> std::io::Result<()> {
    let status = OpencodeStatus {
        mode,
        state,
        url: url.map(str::to_string),
    };
    let json = serde_json::to_string(&status)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, json)
}

pub fn read_status(path: &Path) -> Option<OpencodeStatus> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub struct Spawned {
    pub exited: Arc<AtomicBool>,
    pub kill: Box<dyn Fn() + Send>,
}

pub fn supervise<S, H, W>(
    plan: OpencodePlan,
    status_path: &Path,
    spawn: S,
    healthy: H,
    wait: W,
    shutdown: Arc<AtomicBool>,
) where
    S: Fn(&OpencodePlan) -> std::io::Result<Spawned>,
    H: Fn(&OpencodePlan) -> bool,
    W: Fn(Duration),
{
    let mut attempt: u32 = 0;
    let mut unsuccessful: u32 = 0;

    loop {
        if shutdown.load(Ordering::SeqCst) {
            let _ = write_status(
                status_path,
                plan.mode,
                OpencodeState::Stopped,
                Some(&plan.url),
            );
            return;
        }

        let _ = write_status(
            status_path,
            plan.mode,
            OpencodeState::Starting,
            Some(&plan.url),
        );

        let spawned = match spawn(&plan) {
            Ok(child) => child,
            Err(_) => {
                let _ = write_status(
                    status_path,
                    plan.mode,
                    OpencodeState::Stopped,
                    Some(&plan.url),
                );
                return;
            }
        };

        let mut reached_running = false;

        if !spawned.exited.load(Ordering::SeqCst) {
            for _ in 0..40 {
                if healthy(&plan) {
                    let _ = write_status(
                        status_path,
                        plan.mode,
                        OpencodeState::Running,
                        Some(&plan.url),
                    );
                    attempt = 0;
                    unsuccessful = 0;
                    reached_running = true;
                    break;
                }
                wait(Duration::from_millis(200));
                if shutdown.load(Ordering::SeqCst) {
                    (spawned.kill)();
                    let _ = write_status(
                        status_path,
                        plan.mode,
                        OpencodeState::Stopped,
                        Some(&plan.url),
                    );
                    return;
                }
            }

            if reached_running {
                let mut unhealthy_streak = 0u32;
                loop {
                    wait(Duration::from_secs(5));
                    if shutdown.load(Ordering::SeqCst) {
                        (spawned.kill)();
                        let _ = write_status(
                            status_path,
                            plan.mode,
                            OpencodeState::Stopped,
                            Some(&plan.url),
                        );
                        return;
                    }
                    if spawned.exited.load(Ordering::SeqCst) {
                        break;
                    }
                    if healthy(&plan) {
                        unhealthy_streak = 0;
                    } else {
                        unhealthy_streak += 1;
                        if unhealthy_streak >= 3 {
                            (spawned.kill)();
                            break;
                        }
                    }
                }
            } else {
                (spawned.kill)();
            }
        }

        if !reached_running {
            unsuccessful += 1;
            if unsuccessful > 8 {
                let _ = write_status(
                    status_path,
                    plan.mode,
                    OpencodeState::Stopped,
                    Some(&plan.url),
                );
                return;
            }
        }

        let _ = write_status(
            status_path,
            plan.mode,
            OpencodeState::Restarting,
            Some(&plan.url),
        );
        attempt += 1;
        wait(backoff(attempt));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "strata-embed-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            name
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    fn sample_plan() -> OpencodePlan {
        OpencodePlan {
            mode: OpencodeMode::Embed,
            port: 43123,
            username: "opencode".into(),
            password: "unit-test-password-value".into(),
            url: "http://127.0.0.1:43123".into(),
        }
    }

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
    fn serve_args_include_loopback_and_port() {
        assert_eq!(
            serve_args(43123),
            vec!["serve", "--hostname", "127.0.0.1", "--port", "43123"]
        );
    }

    #[test]
    fn child_env_sets_opencode_server_credentials() {
        let plan = sample_plan();
        let env = child_env(&plan);
        assert_eq!(
            env,
            vec![
                (
                    "OPENCODE_SERVER_USERNAME".to_string(),
                    "opencode".to_string()
                ),
                (
                    "OPENCODE_SERVER_PASSWORD".to_string(),
                    "unit-test-password-value".to_string()
                ),
            ]
        );
    }

    #[test]
    fn service_env_sets_strata_opencode_variables() {
        let plan = sample_plan();
        let env = service_env(&plan);
        assert_eq!(
            env,
            vec![
                (
                    "STRATA_OPENCODE_URL".to_string(),
                    "http://127.0.0.1:43123".to_string()
                ),
                (
                    "STRATA_OPENCODE_USERNAME".to_string(),
                    "opencode".to_string()
                ),
                (
                    "STRATA_OPENCODE_PASSWORD".to_string(),
                    "unit-test-password-value".to_string()
                ),
            ]
        );
    }

    #[test]
    fn backoff_doubles_then_caps_at_thirty_seconds() {
        assert_eq!(backoff(1), Duration::from_secs(1));
        assert_eq!(backoff(2), Duration::from_secs(2));
        assert_eq!(backoff(3), Duration::from_secs(4));
        assert_eq!(backoff(4), Duration::from_secs(8));
        assert_eq!(backoff(5), Duration::from_secs(30));
        assert_eq!(backoff(6), Duration::from_secs(30));
    }

    #[test]
    fn free_port_returns_a_port_that_accepts_a_bind() {
        let port = free_port().expect("free port");
        let listener = TcpListener::bind(("127.0.0.1", port));
        assert!(
            listener.is_ok(),
            "free_port {port} should accept a bind on 127.0.0.1"
        );
    }

    #[test]
    fn random_password_is_url_safe_base64_without_padding() {
        let password = random_password();
        assert_eq!(password.len(), 43);
        assert!(
            password
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "password {password} should match [A-Za-z0-9_-]+"
        );
    }

    #[test]
    fn plan_embed_fills_loopback_url_and_username() {
        let planned = plan_with_port(OpencodeMode::Embed, None).expect("embed plan");
        assert_eq!(planned.mode, OpencodeMode::Embed);
        assert_eq!(planned.username, "opencode");
        assert_eq!(planned.url, format!("http://127.0.0.1:{}", planned.port));
        assert_eq!(planned.password.len(), 43);
    }

    #[test]
    fn plan_external_is_invalid_input() {
        let err = plan_with_port(OpencodeMode::External, None).expect_err("external plan");
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[test]
    fn plan_with_port_keeps_a_port_that_is_still_free() {
        let port = free_port().expect("free port");
        let planned = plan_with_port(OpencodeMode::Embed, Some(port)).expect("embed plan");
        assert_eq!(planned.port, port);
        assert_eq!(planned.url, format!("http://127.0.0.1:{port}"));
    }

    #[test]
    fn plan_with_port_gives_up_a_port_that_is_taken() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let taken = listener.local_addr().expect("addr").port();
        let planned = plan_with_port(OpencodeMode::Embed, Some(taken)).expect("embed plan");
        assert_ne!(planned.port, taken);
        assert!(port_is_free(planned.port));
    }

    #[test]
    fn previous_port_reads_the_port_the_last_run_used() {
        let status_path = temp_path("status.json");
        write_status(
            &status_path,
            OpencodeMode::Embed,
            OpencodeState::Running,
            Some("http://127.0.0.1:43123"),
        )
        .expect("write running status");
        assert_eq!(previous_port(&status_path), Some(43123));
    }

    #[test]
    fn previous_port_is_none_without_a_status_file_or_a_url() {
        let status_path = temp_path("status.json");
        assert_eq!(previous_port(&status_path), None);
        write_status(
            &status_path,
            OpencodeMode::External,
            OpencodeState::External,
            None,
        )
        .expect("write external status");
        assert_eq!(previous_port(&status_path), None);
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
    fn status_json_does_not_contain_the_password() {
        let plan = sample_plan();
        let path = temp_path("status.json");
        write_status(&path, plan.mode, OpencodeState::Starting, Some(&plan.url))
            .expect("write status");
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

    #[test]
    fn supervise_healthy_first_poll_writes_running_and_respawns_same_plan() {
        let plan = sample_plan();
        let status_path = temp_path("status.json");
        let shutdown = Arc::new(AtomicBool::new(false));
        let spawn_plans = Arc::new(Mutex::new(Vec::new()));
        let saw_running = Arc::new(AtomicBool::new(false));
        let first_exited = Arc::new(AtomicBool::new(false));
        let running_waits = Arc::new(AtomicUsize::new(0));

        supervise(
            plan.clone(),
            &status_path,
            {
                let spawn_plans = spawn_plans.clone();
                let first_exited = first_exited.clone();
                move |p| {
                    spawn_plans.lock().unwrap().push(p.clone());
                    let is_first = spawn_plans.lock().unwrap().len() == 1;
                    Ok(Spawned {
                        exited: if is_first {
                            first_exited.clone()
                        } else {
                            Arc::new(AtomicBool::new(false))
                        },
                        kill: Box::new(|| {}),
                    })
                }
            },
            |_| true,
            {
                let shutdown = shutdown.clone();
                let first_exited = first_exited.clone();
                let saw_running = saw_running.clone();
                let running_waits = running_waits.clone();
                let status_path = status_path.clone();
                move |d| {
                    if let Some(status) = read_status(&status_path) {
                        if status.state == OpencodeState::Running {
                            saw_running.store(true, Ordering::SeqCst);
                        }
                    }
                    if d == Duration::from_secs(5) {
                        let n = running_waits.fetch_add(1, Ordering::SeqCst);
                        if n == 0 {
                            first_exited.store(true, Ordering::SeqCst);
                        } else {
                            shutdown.store(true, Ordering::SeqCst);
                        }
                    }
                }
            },
            shutdown.clone(),
        );

        assert!(
            saw_running.load(Ordering::SeqCst),
            "first healthy poll should write running"
        );
        let spawned = spawn_plans.lock().unwrap();
        assert!(
            spawned.len() >= 2,
            "expected a second spawn after the first child exited, got {}",
            spawned.len()
        );
        assert_eq!(spawned[1].port, plan.port);
        assert_eq!(spawned[1].password, plan.password);
        assert_eq!(spawned[0].port, plan.port);
        assert_eq!(spawned[0].password, plan.password);
    }

    #[test]
    fn supervise_shutdown_during_first_health_wait_stops_without_respawn() {
        let plan = sample_plan();
        let status_path = temp_path("status.json");
        let shutdown = Arc::new(AtomicBool::new(false));
        let kills = Arc::new(AtomicUsize::new(0));
        let spawns = Arc::new(AtomicUsize::new(0));

        supervise(
            plan,
            &status_path,
            {
                let spawns = spawns.clone();
                let kills = kills.clone();
                move |_| {
                    spawns.fetch_add(1, Ordering::SeqCst);
                    let kills = kills.clone();
                    Ok(Spawned {
                        exited: Arc::new(AtomicBool::new(false)),
                        kill: Box::new(move || {
                            kills.fetch_add(1, Ordering::SeqCst);
                        }),
                    })
                }
            },
            |_| false,
            {
                let shutdown = shutdown.clone();
                move |_| {
                    shutdown.store(true, Ordering::SeqCst);
                }
            },
            shutdown.clone(),
        );

        assert_eq!(spawns.load(Ordering::SeqCst), 1);
        assert_eq!(kills.load(Ordering::SeqCst), 1);
        let status = read_status(&status_path).expect("status");
        assert_eq!(status.state, OpencodeState::Stopped);
    }

    #[test]
    fn supervise_unhealthy_streak_kills_before_restart() {
        let plan = sample_plan();
        let status_path = temp_path("status.json");
        let shutdown = Arc::new(AtomicBool::new(false));
        let spawns = Arc::new(AtomicUsize::new(0));
        let first_kills = Arc::new(AtomicUsize::new(0));
        let health_calls = Arc::new(AtomicUsize::new(0));

        supervise(
            plan,
            &status_path,
            {
                let spawns = spawns.clone();
                let first_kills = first_kills.clone();
                move |_| {
                    let n = spawns.fetch_add(1, Ordering::SeqCst);
                    let first_kills = first_kills.clone();
                    Ok(Spawned {
                        exited: Arc::new(AtomicBool::new(false)),
                        kill: Box::new(move || {
                            if n == 0 {
                                first_kills.fetch_add(1, Ordering::SeqCst);
                            }
                        }),
                    })
                }
            },
            {
                let health_calls = health_calls.clone();
                move |_| health_calls.fetch_add(1, Ordering::SeqCst) == 0
            },
            {
                let shutdown = shutdown.clone();
                let spawns = spawns.clone();
                move |_| {
                    if spawns.load(Ordering::SeqCst) >= 2 {
                        shutdown.store(true, Ordering::SeqCst);
                    }
                }
            },
            shutdown,
        );

        assert_eq!(first_kills.load(Ordering::SeqCst), 1);
        assert!(spawns.load(Ordering::SeqCst) >= 2);
    }

    #[test]
    fn health_ok_is_false_on_a_closed_port() {
        assert!(!health_ok("http://127.0.0.1:1", "opencode", "x"));
    }

    #[test]
    fn supervise_eight_immediate_exits_stop_with_backoff_schedule() {
        let plan = sample_plan();
        let status_path = temp_path("status.json");
        let shutdown = Arc::new(AtomicBool::new(false));
        let spawns = Arc::new(AtomicUsize::new(0));
        let waits = Arc::new(Mutex::new(Vec::new()));

        supervise(
            plan,
            &status_path,
            {
                let spawns = spawns.clone();
                move |_| {
                    spawns.fetch_add(1, Ordering::SeqCst);
                    Ok(Spawned {
                        exited: Arc::new(AtomicBool::new(true)),
                        kill: Box::new(|| {}),
                    })
                }
            },
            |_| panic!("health should not be polled for an already-exited child"),
            {
                let waits = waits.clone();
                move |d| {
                    waits.lock().unwrap().push(d);
                }
            },
            shutdown,
        );

        assert_eq!(spawns.load(Ordering::SeqCst), 9);
        assert_eq!(
            *waits.lock().unwrap(),
            vec![
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(4),
                Duration::from_secs(8),
                Duration::from_secs(30),
                Duration::from_secs(30),
                Duration::from_secs(30),
                Duration::from_secs(30),
            ]
        );
        let status = read_status(&status_path).expect("status");
        assert_eq!(status.state, OpencodeState::Stopped);
    }
}
