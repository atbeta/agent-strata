use std::env;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
    /// The child is parked at a login prompt: it is waiting for input, not
    /// unhealthy. A reader answers the prompt and it converges on its own.
    AuthRequired,
    /// The last credentials written to that prompt were refused.
    AuthFailed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpencodePlan {
    pub mode: OpencodeMode,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub url: String,
    /// The service this shell started. A plugin inside OpenCode reaches it here.
    pub service_port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpencodeStatus {
    pub mode: OpencodeMode,
    pub state: OpencodeState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The basic-auth pair the running server answers to. Written only while a
    /// supervised server is up, so a service that was not told the address at
    /// launch can still find its way back — connections.json already keeps
    /// secrets like this in the same directory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

/// Where the binary the app will run came from. The settings page shows this
/// because "we found one" and "you told us which one" fail in different ways.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeSource {
    /// `desktop.json` names a path, chosen in Settings.
    Setting,
    /// `STRATA_OPENCODE_BIN` names a path.
    Env,
    /// Found on PATH or in one of the platform directories.
    Path,
    /// Embed mode, and nothing was found.
    Missing,
    /// The app is using a server someone else started; there is no local binary
    /// to inspect.
    External,
}

/// What the shell knows about the OpenCode binary, written beside the status of
/// the process it started.
///
/// This is deliberately a separate file from `opencode-status.json`: the
/// supervisor rewrites that one on every start, stop and restart, and the
/// binary does not change without a restart. Merging them would make every
/// process transition re-run `--version`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpencodeRuntime {
    pub source: RuntimeSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Unix seconds. The UI formats it in the reader's zone.
    pub checked_at: u64,
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
pub fn plan_with_port(
    mode: OpencodeMode,
    preferred: Option<u16>,
    service_port: u16,
) -> std::io::Result<OpencodePlan> {
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
                service_port,
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
        // Where the service is. A plugin inside OpenCode uses it to hand a
        // long-running command to something that can supervise it, instead of
        // detaching it into a window nothing owns.
        (
            "STRATA_SERVICE_URL".into(),
            format!("http://127.0.0.1:{}", plan.service_port),
        ),
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
    creds: Option<(&str, &str)>,
) -> std::io::Result<()> {
    let status = OpencodeStatus {
        mode,
        state,
        url: url.map(str::to_string),
        username: creds.map(|(username, _)| username.to_string()),
        password: creds.map(|(_, password)| password.to_string()),
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
    /// 0 while serving, 1 parked at a login prompt, 2 after the prompt refused
    /// what it was fed. Forks that never prompt leave this `None` and behave
    /// exactly as before.
    pub auth_stage: Option<Arc<std::sync::atomic::AtomicU8>>,
}

pub fn supervise<S, H, W>(
    plan: OpencodePlan,
    status_path: &Path,
    spawn: S,
    healthy: H,
    wait: W,
    shutdown: Arc<AtomicBool>,
    restart: Arc<AtomicBool>,
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
                None,
            );
            return;
        }

        // A request made while the last child was being torn down is already
        // satisfied by the spawn below. Requests made against a live child are
        // consumed in its health loop.
        restart.store(false, Ordering::SeqCst);

        let _ = write_status(
            status_path,
            plan.mode,
            OpencodeState::Starting,
            Some(&plan.url),
            Some((plan.username.as_str(), plan.password.as_str())),
        );

        let spawned = match spawn(&plan) {
            Ok(child) => child,
            Err(_) => {
                let _ = write_status(
                    status_path,
                    plan.mode,
                    OpencodeState::Stopped,
                    Some(&plan.url),
                    None,
                );
                return;
            }
        };

        let mut reached_running = false;

        if !spawned.exited.load(Ordering::SeqCst) {
            let mut polls = 0u32;
            let mut auth_written: i8 = -1;
            while polls < 40 && !spawned.exited.load(Ordering::SeqCst) {
                // Health wins over the prompt flag: a successful login leaves
                // the stage marker stale while the server it unblocked comes
                // up, so probe first and let the prompt branch only hold when
                // the port really is still shut.
                if healthy(&plan) {
                    let _ = write_status(
                        status_path,
                        plan.mode,
                        OpencodeState::Running,
                        Some(&plan.url),
                        Some((plan.username.as_str(), plan.password.as_str())),
                    );
                    attempt = 0;
                    unsuccessful = 0;
                    reached_running = true;
                    break;
                }
                let stage = spawned
                    .auth_stage
                    .as_ref()
                    .map(|s| s.load(Ordering::SeqCst))
                    .unwrap_or(0);
                if stage > 0 {
                    // Parked at a login prompt: the child is waiting on input,
                    // not unwell. Surface the state once per change and hold —
                    // feeding the prompt is what moves it on, not more probing.
                    if auth_written != stage as i8 {
                        let _ = write_status(
                            status_path,
                            plan.mode,
                            if stage == 2 {
                                OpencodeState::AuthFailed
                            } else {
                                OpencodeState::AuthRequired
                            },
                            Some(&plan.url),
                            Some((plan.username.as_str(), plan.password.as_str())),
                        );
                        auth_written = stage as i8;
                    }
                    wait(Duration::from_millis(400));
                    if shutdown.load(Ordering::SeqCst) {
                        (spawned.kill)();
                        let _ = write_status(
                            status_path,
                            plan.mode,
                            OpencodeState::Stopped,
                            Some(&plan.url),
                            None,
                        );
                        return;
                    }
                    if restart.swap(false, Ordering::SeqCst) {
                        (spawned.kill)();
                        break;
                    }
                    continue;
                }
                wait(Duration::from_millis(200));
                polls += 1;
                if shutdown.load(Ordering::SeqCst) {
                    (spawned.kill)();
                    let _ = write_status(
                        status_path,
                        plan.mode,
                        OpencodeState::Stopped,
                        Some(&plan.url),
                        None,
                    );
                    return;
                }
                if restart.swap(false, Ordering::SeqCst) {
                    (spawned.kill)();
                    break;
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
                            None,
                        );
                        return;
                    }
                    if restart.swap(false, Ordering::SeqCst) {
                        (spawned.kill)();
                        break;
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
                    None,
                );
                return;
            }
        }

        let _ = write_status(
            status_path,
            plan.mode,
            OpencodeState::Restarting,
            Some(&plan.url),
            Some((plan.username.as_str(), plan.password.as_str())),
        );
        attempt += 1;
        wait(backoff(attempt));
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn home_dir() -> Option<PathBuf> {
    for key in ["HOME", "USERPROFILE"] {
        if let Ok(value) = env::var(key) {
            if !value.is_empty() {
                return Some(PathBuf::from(value));
            }
        }
    }
    None
}

/// The names a binary can have on this platform.
///
/// npm installs a Windows shim as `opencode.cmd` (and PowerShell users may have
/// `opencode.ps1`); looking only for `opencode` and `opencode.exe` reports a
/// working install as missing. The Unix installer has no extension.
pub fn candidate_names() -> Vec<&'static str> {
    #[cfg(windows)]
    {
        vec![
            "opencode",
            "opencode.exe",
            "opencode.cmd",
            "opencode.bat",
            "opencode.ps1",
        ]
    }
    #[cfg(not(windows))]
    {
        vec!["opencode"]
    }
}

/// Directories worth checking after PATH. The official installer writes to
/// `~/.opencode/bin`; Homebrew and bun are the two paths this project already
/// supported.
pub fn fallback_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = home_dir() {
        dirs.push(home.join(".opencode").join("bin"));
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".bun").join("bin"));
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    #[cfg(windows)]
    {
        if let Ok(local) = env::var("LOCALAPPDATA") {
            if !local.is_empty() {
                dirs.push(PathBuf::from(local).join("Programs").join("opencode"));
            }
        }
        if let Ok(appdata) = env::var("APPDATA") {
            if !appdata.is_empty() {
                dirs.push(PathBuf::from(appdata).join("npm"));
            }
        }
    }
    dirs
}

fn find_in(dirs: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    let names = candidate_names();
    for dir in dirs {
        for name in &names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
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

pub fn write_pid(path: &Path, pid: u32) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, pid.to_string())
}

pub fn read_pid(path: &Path) -> Option<u32> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// The command line of a live process, or `None` when it has gone.
#[cfg(unix)]
fn process_command(pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(windows)]
fn process_command(pid: u32) -> Option<String> {
    let output = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() || text.contains("No tasks") {
        None
    } else {
        Some(text)
    }
}

fn process_is_opencode(pid: u32) -> bool {
    process_command(pid)
        .map(|command| {
            let lower = command.to_ascii_lowercase();
            lower.contains("opencode") && lower.contains("serve")
        })
        .unwrap_or(false)
}

#[cfg(unix)]
fn kill_tree(pid: u32) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    let group = unsafe { kill(-(pid as i32), 9) };
    if group != 0 {
        // Not a process-group leader (an older or manually started server):
        // fall back to the process itself.
        unsafe {
            kill(pid as i32, 9);
        }
    }
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
}

/// The pid of an `opencode serve` whose command line names this exact port.
///
/// Used only for the address the status file says the app was running: a server
/// from before the pid file existed, or one whose pid file was lost. The command
/// line has to name both `opencode`/`serve` and `--port <port>`, so a listener
/// that merely happens to hold the port is not a candidate.
#[cfg(unix)]
fn opencode_pid_on_port(port: u16) -> Option<u32> {
    let output = Command::new("ps")
        .args(["-axo", "pid=,command="])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let wanted = port.to_string();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(pid_text) = parts.next() else {
            continue;
        };
        let Ok(pid) = pid_text.parse::<u32>() else {
            continue;
        };
        let args: Vec<&str> = parts.collect();
        let is_opencode = args
            .iter()
            .any(|arg| arg.to_ascii_lowercase().contains("opencode"));
        let serves = args.iter().any(|arg| *arg == "serve");
        let names_port = args
            .windows(2)
            .any(|pair| pair[0] == "--port" && pair[1] == wanted);
        if is_opencode && serves && names_port {
            return Some(pid);
        }
    }
    None
}

#[cfg(unix)]
pub fn reap_opencode_on_port(port: u16) -> Option<u32> {
    let pid = opencode_pid_on_port(port)?;
    kill_tree(pid);
    for _ in 0..40 {
        if port_is_free(port) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Some(pid)
}

#[cfg(windows)]
pub fn reap_opencode_on_port(_port: u16) -> Option<u32> {
    // Windows cleans up through the pid file; enumerating listeners and
    // matching command lines is a different, larger job.
    None
}

/// Stop an embedded server left behind by a previous run.
///
/// The shell supervises its server while it is alive, but a crash, a killed dev
/// process, or a rebuild can orphan one. The next launch then finds the old
/// port taken, picks a new one, and the remembered address points at a server
/// nobody supervises — which is exactly the "old port, then a new port" start.
/// The pid is checked against the process command line before it is signalled,
/// so a recycled pid is never enough to kill something else.
pub fn cleanup_stale_opencode(path: &Path) -> Option<u32> {
    let pid = read_pid(path)?;
    let killed = process_is_opencode(pid);
    if killed {
        kill_tree(pid);
        for _ in 0..40 {
            if !process_is_opencode(pid) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    let _ = std::fs::remove_file(path);
    if killed {
        Some(pid)
    } else {
        None
    }
}

/// Save or clear the chosen binary without dropping the mode or any field a
/// later version of the app may have written there.
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
    std::fs::write(path, format!("{json}\n"))
}

/// The command to run a binary, including the shims Windows needs.
///
/// `CreateProcess` cannot execute a `.cmd` or `.ps1` file directly. npm's
/// Windows install puts `opencode.cmd` in front of the real executable, so a
/// path found by name would otherwise fail with "not a valid Win32 application".
pub fn command_for(bin: &Path) -> Command {
    #[cfg(windows)]
    {
        let ext = bin
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if ext == "cmd" || ext == "bat" {
            let mut command = Command::new("cmd");
            command.arg("/C").arg(bin);
            return command;
        }
        if ext == "ps1" {
            let mut command = Command::new("powershell");
            command
                .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(bin);
            return command;
        }
    }
    Command::new(bin)
}

/// `opencode --version`, or the reason it could not be read.
pub fn version_of(bin: &Path) -> Result<String, String> {
    let output = command_for(bin)
        .arg("--version")
        .output()
        .map_err(|e| format!("could not run {}: {e}", bin.display()))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let line = detail
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("");
        return Err(if line.is_empty() {
            format!("{} --version exited with {}", bin.display(), output.status)
        } else {
            line.to_string()
        });
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let version = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    if version.is_empty() {
        Err(format!("{} --version printed nothing", bin.display()))
    } else {
        Ok(version.to_string())
    }
}

fn runtime_for(bin: PathBuf, source: RuntimeSource, checked_at: u64) -> OpencodeRuntime {
    if !bin.is_file() {
        return OpencodeRuntime {
            source,
            bin: Some(bin.to_string_lossy().into_owned()),
            version: None,
            error: Some(format!("not a file: {}", bin.display())),
            checked_at,
        };
    }
    match version_of(&bin) {
        Ok(version) => OpencodeRuntime {
            source,
            bin: Some(bin.to_string_lossy().into_owned()),
            version: Some(version),
            error: None,
            checked_at,
        },
        Err(error) => OpencodeRuntime {
            source,
            bin: Some(bin.to_string_lossy().into_owned()),
            version: None,
            error: Some(error),
            checked_at,
        },
    }
}

/// Inspect the binary without starting anything. `env_bin` is an argument so
/// tests do not have to mutate the process environment.
pub fn detect_runtime_with(
    dir: &Path,
    mode: OpencodeMode,
    env_bin: Option<PathBuf>,
) -> OpencodeRuntime {
    let checked_at = now_secs();
    if mode == OpencodeMode::External {
        return OpencodeRuntime {
            source: RuntimeSource::External,
            bin: None,
            version: None,
            error: None,
            checked_at,
        };
    }
    if let Some(chosen) = read_desktop_bin(&dir.join("desktop.json")) {
        return runtime_for(chosen, RuntimeSource::Setting, checked_at);
    }
    if let Some(from_env) = env_bin.filter(|path| !path.as_os_str().is_empty()) {
        return runtime_for(from_env, RuntimeSource::Env, checked_at);
    }
    if let Some(found) = find_in(
        env::split_paths(&env::var_os("PATH").unwrap_or_default())
            .chain(fallback_dirs().into_iter()),
    ) {
        return runtime_for(found, RuntimeSource::Path, checked_at);
    }
    OpencodeRuntime {
        source: RuntimeSource::Missing,
        bin: None,
        version: None,
        error: Some("opencode was not found on PATH".into()),
        checked_at,
    }
}

pub fn detect_runtime(dir: &Path, mode: OpencodeMode) -> OpencodeRuntime {
    detect_runtime_with(
        dir,
        mode,
        env::var_os("STRATA_OPENCODE_BIN").map(PathBuf::from),
    )
}

pub fn write_runtime(path: &Path, runtime: &OpencodeRuntime) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(runtime)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, format!("{json}\n"))
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

    /// The free-port tests bind real ephemeral ports; serialise them so one
    /// test cannot claim the port another just reserved.
    static FREE_PORT_TEST: Mutex<()> = Mutex::new(());

    fn temp_path(name: &str) -> PathBuf {
        // Two tests can ask for the same `name` in the same nanosecond on a
        // platform with a coarse clock; the counter keeps their directories
        // apart so one test's JSON cannot land in the other's file.
        static TEMP_SEQ: AtomicUsize = AtomicUsize::new(0);
        let seq = TEMP_SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "strata-embed-{}-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            seq,
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
            service_port: 7700,
        }
    }

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
    fn detect_runtime_reports_a_setting_that_is_not_a_file() {
        let desktop = temp_path("desktop.json");
        write_desktop_bin(&desktop, Some("/definitely/not/an/opencode")).unwrap();
        let runtime = detect_runtime_with(desktop.parent().unwrap(), OpencodeMode::Embed, None);
        assert_eq!(runtime.source, RuntimeSource::Setting);
        assert!(runtime.version.is_none());
        assert!(runtime.error.unwrap().contains("not a file"));
    }

    #[test]
    fn detect_runtime_external_does_not_look_for_a_binary() {
        let desktop = temp_path("desktop.json");
        let runtime = detect_runtime_with(
            desktop.parent().unwrap(),
            OpencodeMode::External,
            Some(PathBuf::from("/does/not/matter")),
        );
        assert_eq!(runtime.source, RuntimeSource::External);
        assert!(runtime.bin.is_none());
        assert!(runtime.version.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn detect_runtime_reads_the_version_from_the_chosen_binary() {
        use std::os::unix::fs::PermissionsExt;

        let desktop = temp_path("desktop.json");
        let bin = desktop.parent().unwrap().join("opencode");
        fs::write(&bin, "#!/bin/sh\necho 1.18.30\n").unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        write_desktop_bin(&desktop, Some(bin.to_str().unwrap())).unwrap();

        let runtime = detect_runtime_with(desktop.parent().unwrap(), OpencodeMode::Embed, None);
        assert_eq!(runtime.source, RuntimeSource::Setting);
        assert_eq!(runtime.version.as_deref(), Some("1.18.30"));
        assert!(runtime.error.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_saved_path_wins_over_the_environment() {
        use std::os::unix::fs::PermissionsExt;

        let desktop = temp_path("desktop.json");
        let dir = desktop.parent().unwrap();
        let chosen = dir.join("chosen");
        let from_env = dir.join("from-env");
        for (path, version) in [(&chosen, "1.18.30"), (&from_env, "9.9.9")] {
            fs::write(path, format!("#!/bin/sh\necho {version}\n")).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        write_desktop_bin(&desktop, Some(chosen.to_str().unwrap())).unwrap();

        let runtime = detect_runtime_with(dir, OpencodeMode::Embed, Some(from_env));
        assert_eq!(runtime.source, RuntimeSource::Setting);
        assert_eq!(runtime.version.as_deref(), Some("1.18.30"));
    }

    #[cfg(unix)]
    #[test]
    fn the_environment_is_used_when_no_path_is_saved() {
        use std::os::unix::fs::PermissionsExt;

        let desktop = temp_path("desktop.json");
        let dir = desktop.parent().unwrap();
        let from_env = dir.join("from-env");
        fs::write(&from_env, "#!/bin/sh\necho 1.19.3\n").unwrap();
        fs::set_permissions(&from_env, fs::Permissions::from_mode(0o755)).unwrap();

        let runtime = detect_runtime_with(dir, OpencodeMode::Embed, Some(from_env));
        assert_eq!(runtime.source, RuntimeSource::Env);
        assert_eq!(runtime.version.as_deref(), Some("1.19.3"));
    }

    #[test]
    fn pid_file_round_trips() {
        let path = temp_path("opencode.pid");
        write_pid(&path, 4321).unwrap();
        assert_eq!(read_pid(&path), Some(4321));
        assert_eq!(read_pid(&path.with_extension("missing")), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_stale_pid_that_is_not_opencode_is_not_killed() {
        use std::os::unix::process::CommandExt;

        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }

        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .expect("sleep");
        let pid = child.id();
        let path = temp_path("opencode.pid");
        write_pid(&path, pid).unwrap();

        assert_eq!(cleanup_stale_opencode(&path), None);
        assert_eq!(read_pid(&path), None);
        // Still alive: the command line did not look like `opencode serve`.
        assert_eq!(unsafe { kill(pid as i32, 0) }, 0);
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(unix)]
    #[test]
    fn an_opencode_serve_on_a_port_is_found_and_reaped() {
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::process::CommandExt;

        let script = temp_path("opencode");
        fs::write(&script, "#!/bin/sh\nsleep 30\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let mut child = Command::new(&script)
            .args(["serve", "--hostname", "127.0.0.1", "--port", "45678"])
            .process_group(0)
            .spawn()
            .expect("fake opencode");
        let pid = child.id();

        assert_eq!(opencode_pid_on_port(45678), Some(pid));
        assert_eq!(reap_opencode_on_port(45678), Some(pid));
        assert_eq!(opencode_pid_on_port(45678), None);
        let _ = child.wait();
    }

    #[cfg(unix)]
    #[test]
    fn a_stale_opencode_serve_process_is_reaped() {
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::process::CommandExt;

        let script = temp_path("opencode");
        fs::write(&script, "#!/bin/sh\nsleep 30\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let mut child = Command::new(&script)
            .arg("serve")
            .process_group(0)
            .spawn()
            .expect("fake opencode");
        let pid = child.id();
        let path = temp_path("opencode.pid");
        write_pid(&path, pid).unwrap();

        assert_eq!(cleanup_stale_opencode(&path), Some(pid));
        assert_eq!(read_pid(&path), None);
        let status = child.wait().expect("reaped");
        assert!(!status.success());
    }

    #[cfg(not(windows))]
    #[test]
    fn command_for_runs_a_unix_binary_directly() {
        let command = command_for(Path::new("/tmp/opencode"));
        assert_eq!(command.get_program(), std::ffi::OsStr::new("/tmp/opencode"));
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
                (
                    "STRATA_SERVICE_URL".to_string(),
                    "http://127.0.0.1:7700".to_string()
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
        let _guard = FREE_PORT_TEST.lock().unwrap_or_else(|e| e.into_inner());
        // A port obtained by binding :0 and dropping the listener can be
        // claimed by another test before this one rebinds it. Retry instead of
        // treating one lost race as a bug in free_port.
        for _ in 0..10 {
            let port = free_port().expect("free port");
            if TcpListener::bind(("127.0.0.1", port)).is_ok() {
                return;
            }
        }
        panic!("free_port did not produce a bindable port in ten attempts");
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
        let planned = plan_with_port(OpencodeMode::Embed, None, 7700).expect("embed plan");
        assert_eq!(planned.mode, OpencodeMode::Embed);
        assert_eq!(planned.username, "opencode");
        assert_eq!(planned.url, format!("http://127.0.0.1:{}", planned.port));
        assert_eq!(planned.password.len(), 43);
    }

    #[test]
    fn plan_external_is_invalid_input() {
        let err = plan_with_port(OpencodeMode::External, None, 7700).expect_err("external plan");
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[test]
    fn plan_with_port_keeps_a_port_that_is_still_free() {
        let _guard = FREE_PORT_TEST.lock().unwrap_or_else(|e| e.into_inner());
        for _ in 0..10 {
            let port = free_port().expect("free port");
            let planned = plan_with_port(OpencodeMode::Embed, Some(port), 7700).expect("embed plan");
            if planned.port == port {
                assert_eq!(planned.url, format!("http://127.0.0.1:{port}"));
                return;
            }
        }
        panic!("the free port was taken before plan_with_port could keep it");
    }

    #[test]
    fn plan_with_port_gives_up_a_port_that_is_taken() {
        let _guard = FREE_PORT_TEST.lock().unwrap_or_else(|e| e.into_inner());
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let taken = listener.local_addr().expect("addr").port();
        let planned = plan_with_port(OpencodeMode::Embed, Some(taken), 7700).expect("embed plan");
        assert_ne!(planned.port, taken);
        // Do not rebind `planned.port` here: another parallel test can claim it
        // after plan_with_port checked it, which tests the race, not the plan.
    }

    #[test]
    fn previous_port_reads_the_port_the_last_run_used() {
        let status_path = temp_path("status.json");
        write_status(
            &status_path,
            OpencodeMode::Embed,
            OpencodeState::Running,
            Some("http://127.0.0.1:43123"),
            None,
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

    /// The status file is the hand-off to a service that was not told the
    /// address at launch: while a supervised server is up it needs the pair to
    /// connect, and once the server is gone the pair goes with it.
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

        write_status(&path, plan.mode, OpencodeState::Stopped, Some(&plan.url), None)
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
                    auth_stage: None,
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
            Arc::new(AtomicBool::new(false)),
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
    fn supervise_restart_replaces_a_healthy_child_without_waiting_for_exit() {
        let plan = sample_plan();
        let status_path = temp_path("status.json");
        let shutdown = Arc::new(AtomicBool::new(false));
        let restart = Arc::new(AtomicBool::new(false));
        let spawns = Arc::new(AtomicUsize::new(0));
        let kills = Arc::new(AtomicUsize::new(0));
        let waits = Arc::new(AtomicUsize::new(0));

        supervise(
            plan,
            &status_path,
            {
                let spawns = spawns.clone();
                let kills = kills.clone();
                move |_| {
                    spawns.fetch_add(1, Ordering::SeqCst);
                    Ok(Spawned {
                        exited: Arc::new(AtomicBool::new(false)),
                        kill: Box::new({
                            let kills = kills.clone();
                            move || {
                                kills.fetch_add(1, Ordering::SeqCst);
                            }
                        }),
                        auth_stage: None,
                    })
                }
            },
            |_| true,
            {
                let spawns = spawns.clone();
                let restart = restart.clone();
                let shutdown = shutdown.clone();
                let waits = waits.clone();
                move |_| {
                    if waits.fetch_add(1, Ordering::SeqCst) == 0 {
                        restart.store(true, Ordering::SeqCst);
                    } else if spawns.load(Ordering::SeqCst) >= 2 {
                        shutdown.store(true, Ordering::SeqCst);
                    }
                }
            },
            shutdown,
            restart,
        );

        assert!(spawns.load(Ordering::SeqCst) >= 2);
        assert!(kills.load(Ordering::SeqCst) >= 1);
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
                        auth_stage: None,
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
            Arc::new(AtomicBool::new(false)),
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
                        auth_stage: None,
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
            Arc::new(AtomicBool::new(false)),
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
                    auth_stage: None,
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
            Arc::new(AtomicBool::new(false)),
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
