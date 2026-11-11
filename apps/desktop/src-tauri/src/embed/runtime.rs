use std::env;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::model::{
    Attention, AttentionKind, OpencodeMode, OpencodeRuntime, RuntimeError, RuntimeSource,
};
use super::output::{classify, last_meaningful_line};
use super::process::{command_for, kill_tree};
use super::store::{owner_only, read_desktop_bin};

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

/// Directories worth checking after PATH.
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

pub fn version_of(bin: &Path) -> Result<String, RuntimeError> {
    const DEADLINE: Duration = Duration::from_secs(10);
    /// Output that has stopped changing for this long belongs to a waiting child.
    const QUIET_AFTER: Duration = Duration::from_millis(1_500);
    let mut child = command_for(bin)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| RuntimeError::NotRunnable {
            detail: format!("{}: {e}", bin.display()),
        })?;
    fn drain_into<R: Read + Send + 'static>(
        mut stream: R,
        slot: Arc<Mutex<Vec<u8>>>,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Ok(mut slot) = slot.lock() {
                            slot.extend_from_slice(&buf[..n]);
                        }
                    }
                }
            }
        })
    }
    let stdout: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let mut readers = Vec::new();
    if let Some(stream) = child.stdout.take() {
        readers.push(drain_into(stream, Arc::clone(&stdout)));
    }
    if let Some(stream) = child.stderr.take() {
        readers.push(drain_into(stream, Arc::clone(&stderr)));
    }
    let seen = |stdout: &Arc<Mutex<Vec<u8>>>, stderr: &Arc<Mutex<Vec<u8>>>| -> String {
        let stdout = stdout.lock().map(|v| v.clone()).unwrap_or_default();
        let stderr = stderr.lock().map(|v| v.clone()).unwrap_or_default();
        let mut both = String::from_utf8_lossy(&stdout).into_owned();
        both.push_str(&String::from_utf8_lossy(&stderr));
        both
    };
    let start = Instant::now();
    let mut last_len = 0usize;
    let mut quiet_since: Option<Instant> = None;
    let status = loop {
        let output = seen(&stdout, &stderr);
        if let Some(attention) = classify(&output) {
            break match attention.kind {
                AttentionKind::Login => Err(RuntimeError::AuthParked),
                _ => Err(RuntimeError::NeedsInput { attention }),
            };
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {}
            Err(e) => {
                return Err(RuntimeError::NotRunnable {
                    detail: format!("{}: {e}", bin.display()),
                })
            }
        }
        if output.len() != last_len {
            last_len = output.len();
            quiet_since = None;
        } else if quiet_since.is_none() {
            quiet_since = Some(Instant::now());
        }
        if let Some(since) = quiet_since {
            if since.elapsed() >= QUIET_AFTER {
                if let Some(message) = last_meaningful_line(&output) {
                    break Err(RuntimeError::NeedsInput {
                        attention: Attention {
                            kind: AttentionKind::Unknown,
                            message,
                        },
                    });
                }
            }
        }
        if start.elapsed() >= DEADLINE {
            break Err(RuntimeError::VersionTimeout {
                seconds: DEADLINE.as_secs(),
            });
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let status = match status {
        Ok(status) => status,
        Err(reason) => {
            kill_tree(child.id());
            let _ = child.wait();
            for reader in readers {
                let _ = reader.join();
            }
            return Err(reason);
        }
    };
    for reader in readers {
        let _ = reader.join();
    }
    let stderr = stderr.lock().map(|v| v.clone()).unwrap_or_default();
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr);
        let line = detail
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("");
        return Err(RuntimeError::VersionExited {
            detail: if line.is_empty() {
                format!("exit {status}")
            } else {
                line.to_string()
            },
        });
    }
    let stdout = stdout.lock().map(|v| v.clone()).unwrap_or_default();
    let text = String::from_utf8_lossy(&stdout);
    let version = text
        .lines()
        .map(str::trim)
        .find_map(version_token)
        .unwrap_or("");
    if version.is_empty() {
        Err(RuntimeError::VersionEmpty)
    } else {
        Ok(version.to_string())
    }
}

/// The version token on a line, including any build suffix.
fn version_token(line: &str) -> Option<&str> {
    let text = line
        .strip_prefix("opencode ")
        .or_else(|| line.strip_prefix("OpenCode "))
        .unwrap_or(line)
        .trim();
    let text = text.strip_prefix('v').unwrap_or(text);
    let token = text.split([' ', '\t']).next()?;
    if token.is_empty() {
        return None;
    }
    let core = token.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let first = parts.next()?;
    if first.is_empty() || !first.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let rest: Vec<&str> = parts.collect();
    if rest.is_empty() {
        return None;
    }
    let numeric = rest
        .iter()
        .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()));
    numeric.then_some(token)
}

fn runtime_for(bin: PathBuf, source: RuntimeSource, checked_at: u64) -> OpencodeRuntime {
    if !bin.is_file() {
        return OpencodeRuntime {
            source,
            bin: Some(bin.to_string_lossy().into_owned()),
            version: None,
            error: Some(
                RuntimeError::NotRunnable {
                    detail: format!("not a file: {}", bin.display()),
                }
                .to_stored(),
            ),
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
            error: Some(error.to_stored()),
            checked_at,
        },
    }
}

/// Inspect the binary without starting anything. `env_bin` is explicit for tests.
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
        error: Some(RuntimeError::NotFound.to_stored()),
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

/// Resolve the binary embed mode would use, without running it.
pub fn resolve_bin(dir: &Path) -> Option<PathBuf> {
    if let Some(chosen) = read_desktop_bin(&dir.join("desktop.json")) {
        return Some(chosen);
    }
    if let Some(from_env) = env::var_os("STRATA_OPENCODE_BIN")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
    {
        return Some(from_env);
    }
    find_in(
        env::split_paths(&env::var_os("PATH").unwrap_or_default())
            .chain(fallback_dirs().into_iter()),
    )
}

pub fn write_runtime(path: &Path, runtime: &OpencodeRuntime) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(runtime)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, format!("{json}\n"))?;
    owner_only(path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::store::write_desktop_bin;
    use super::super::test_support::temp_path;
    use super::*;
    use std::fs;

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

    #[test]
    fn a_banner_before_the_version_is_skipped() {
        assert_eq!(version_token("欢迎使用研发工具|xOpenCode"), None);
        assert_eq!(version_token(""), None);
        assert_eq!(version_token("1.18.29-h3"), Some("1.18.29-h3"));
        assert_eq!(version_token("1.19.3"), Some("1.19.3"));
        assert_eq!(version_token("v1.19.3"), Some("1.19.3"));
        assert_eq!(version_token("opencode 1.19.3"), Some("1.19.3"));
    }

    #[test]
    fn a_version_suffix_is_kept_whole() {
        assert_eq!(version_token("1.18.29-h3"), Some("1.18.29-h3"));
        assert_eq!(version_token("0.6.0-beta.2"), Some("0.6.0-beta.2"));
    }

    #[test]
    fn a_bare_number_is_not_a_version() {
        assert_eq!(version_token("1"), None);
        assert_eq!(version_token("2026"), None);
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
}
