use std::path::Path;
#[cfg(windows)]
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use super::store::{read_pid_record, write_pid_record, PidRecord, PID_FILE_VERSION};

/// Build every console subprocess through one Windows-windowless command.
pub(crate) fn command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcessIdentity {
    started: String,
    command: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ProcessLookup {
    Live(ProcessIdentity),
    Gone,
    Unavailable,
}

#[cfg(unix)]
fn lookup_process(pid: u32) -> ProcessLookup {
    let output = match command("ps")
        .args([
            "-p",
            &pid.to_string(),
            "-o",
            "lstart=",
            "-o",
            "stat=",
            "-o",
            "command=",
        ])
        .output()
    {
        Ok(output) => output,
        Err(_) => return ProcessLookup::Unavailable,
    };
    if !output.status.success() {
        return if output.stderr.iter().all(u8::is_ascii_whitespace) {
            ProcessLookup::Gone
        } else {
            ProcessLookup::Unavailable
        };
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let text = text.trim();
    // One fixed-width timestamp and command snapshot avoids a pid-reuse race.
    if text.len() <= 24 || !text.is_char_boundary(24) {
        return ProcessLookup::Unavailable;
    }
    let started = text[..24].trim();
    let rest = text[24..].trim_start();
    let Some(split) = rest.find(char::is_whitespace) else {
        return ProcessLookup::Unavailable;
    };
    let state = &rest[..split];
    let command = rest[split..].trim();
    if state.starts_with('Z') {
        return ProcessLookup::Gone;
    }
    if started.is_empty() || command.is_empty() {
        return ProcessLookup::Unavailable;
    }
    ProcessLookup::Live(ProcessIdentity {
        started: started.to_string(),
        command: command.to_string(),
    })
}

#[cfg(windows)]
fn lookup_process(pid: u32) -> ProcessLookup {
    // CIM supplies both creation time and the full command line that tasklist lacks.
    let script = r#"$p = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $args[0]); if ($null -eq $p) { exit 3 }; [pscustomobject]@{ started = $p.CreationDate.ToUniversalTime().ToString("o"); command = [string]$p.CommandLine } | ConvertTo-Json -Compress"#;
    let output = match command("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
            &pid.to_string(),
        ])
        .output()
    {
        Ok(output) => output,
        Err(_) => return ProcessLookup::Unavailable,
    };
    if output.status.code() == Some(3) {
        return ProcessLookup::Gone;
    }
    if !output.status.success() {
        return ProcessLookup::Unavailable;
    }
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
        return ProcessLookup::Unavailable;
    };
    let started = value.get("started").and_then(|v| v.as_str()).unwrap_or("");
    let command = value.get("command").and_then(|v| v.as_str()).unwrap_or("");
    if started.is_empty() || command.is_empty() {
        return ProcessLookup::Unavailable;
    }
    ProcessLookup::Live(ProcessIdentity {
        started: started.to_string(),
        command: command.to_string(),
    })
}

impl PidRecord {
    fn owns(&self, process: &ProcessIdentity) -> bool {
        self.version == PID_FILE_VERSION
            && self.started.as_deref() == Some(process.started.as_str())
            && self.command.as_deref() == Some(process.command.as_str())
    }
}

/// Version 1 is JSON. Decimal pids remain readable but never authorise a signal.
pub fn write_pid(path: &Path, pid: u32) -> std::io::Result<()> {
    let (started, command) = match lookup_process(pid) {
        ProcessLookup::Live(process) => (Some(process.started), Some(process.command)),
        ProcessLookup::Gone | ProcessLookup::Unavailable => (None, None),
    };
    let record = PidRecord {
        version: PID_FILE_VERSION,
        pid,
        started,
        command,
    };
    write_pid_record(path, &record)
}

#[cfg(test)]
pub fn read_pid(path: &Path) -> Option<u32> {
    Some(read_pid_record(path)?.pid)
}

#[cfg(unix)]
pub(crate) fn kill_tree(pid: u32) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    let group = unsafe { kill(-(pid as i32), 9) };
    if group != 0 {
        unsafe {
            kill(pid as i32, 9);
        }
    }
}

#[cfg(windows)]
pub(crate) fn kill_tree(pid: u32) {
    let _ = command("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
}

/// Without a recovery record, a port and command line cannot prove ownership.
pub fn reap_opencode_on_port(_port: u16) -> Option<u32> {
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StalePidAction {
    Kill,
    Remove,
    Preserve,
}

fn stale_pid_action(record: &PidRecord, process: &ProcessLookup) -> StalePidAction {
    match process {
        ProcessLookup::Gone => StalePidAction::Remove,
        ProcessLookup::Unavailable => StalePidAction::Preserve,
        ProcessLookup::Live(identity) if record.owns(identity) => StalePidAction::Kill,
        ProcessLookup::Live(_) => StalePidAction::Preserve,
    }
}

fn cleanup_stale(path: &Path) -> Option<u32> {
    let record = read_pid_record(path)?;
    let pid = record.pid;
    match stale_pid_action(&record, &lookup_process(pid)) {
        StalePidAction::Remove => {
            let _ = std::fs::remove_file(path);
            return None;
        }
        StalePidAction::Preserve => return None,
        StalePidAction::Kill => {}
    }

    kill_tree(pid);
    for _ in 0..40 {
        match lookup_process(pid) {
            ProcessLookup::Live(identity) if record.owns(&identity) => {
                std::thread::sleep(Duration::from_millis(50));
            }
            ProcessLookup::Live(_) | ProcessLookup::Gone => {
                let _ = std::fs::remove_file(path);
                break;
            }
            ProcessLookup::Unavailable => break,
        }
    }
    Some(pid)
}

pub fn cleanup_stale_opencode(path: &Path) -> Option<u32> {
    cleanup_stale(path)
}

pub fn cleanup_stale_service(path: &Path) -> Option<u32> {
    cleanup_stale(path)
}

#[cfg(windows)]
fn exe_behind_shim(bin: &Path) -> Option<PathBuf> {
    let ext = bin.extension()?.to_str()?.to_ascii_lowercase();
    if ext != "cmd" && ext != "bat" && ext != "ps1" {
        return None;
    }
    let dir = bin.parent()?;
    if let Some(stem) = bin.file_stem() {
        let sibling = dir.join(stem).with_extension("exe");
        if sibling.is_file() {
            return Some(sibling);
        }
    }
    let text = std::fs::read_to_string(bin).ok()?;
    for token in text.split(|c: char| c == '"' || c.is_whitespace()) {
        let token = token.trim_matches('\'');
        if !token.to_ascii_lowercase().ends_with(".exe") {
            continue;
        }
        let expanded = token.replace("%~dp0", &dir.to_string_lossy().replace('\\', "/"));
        let candidate = PathBuf::from(&expanded);
        let candidate = if candidate.is_absolute() {
            candidate
        } else {
            dir.join(candidate)
        };
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

pub fn command_for(bin: &Path) -> Command {
    #[cfg(windows)]
    {
        if let Some(exe) = exe_behind_shim(bin) {
            return command(exe);
        }
        let ext = bin
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if ext == "cmd" || ext == "bat" {
            let mut command = command("cmd");
            command.arg("/C").arg(bin);
            return command;
        }
        if ext == "ps1" {
            let mut command = command("powershell");
            command
                .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(bin);
            return command;
        }
    }
    command(bin)
}

#[cfg(test)]
mod tests {
    use super::super::test_support::temp_path;
    use super::*;
    use std::fs;

    #[cfg(windows)]
    #[test]
    fn every_command_starts_without_a_console() {
        let src = include_str!("process.rs");
        let body = &src[..src.find("mod tests {").unwrap_or(src.len())];
        assert_eq!(
            body.matches("Command::new(").count(),
            1,
            "a command is built outside command():\n{body}"
        );
        let helper = &body[body.find("fn command<").expect("command()")..];
        assert!(helper.contains("creation_flags(0x08000000)"));
    }

    #[test]
    fn pid_file_round_trips() {
        let path = temp_path("opencode.pid");
        write_pid(&path, 4321).unwrap();
        assert_eq!(read_pid(&path), Some(4321));
        let record = read_pid_record(&path).unwrap();
        assert_eq!(record.version, PID_FILE_VERSION);
        assert_eq!(read_pid(&path.with_extension("missing")), None);
    }

    #[test]
    fn an_old_pid_record_never_authorises_a_signal() {
        let identity = ProcessIdentity {
            started: "Wed Nov 12 10:11:12 2026".into(),
            command: "opencode serve --port 43123".into(),
        };
        let legacy = PidRecord {
            version: 0,
            pid: 4321,
            started: None,
            command: None,
        };
        assert_eq!(
            stale_pid_action(&legacy, &ProcessLookup::Live(identity)),
            StalePidAction::Preserve
        );
    }

    #[test]
    fn identification_failure_preserves_the_recovery_record() {
        let record = PidRecord {
            version: PID_FILE_VERSION,
            pid: 4321,
            started: Some("start".into()),
            command: Some("opencode serve".into()),
        };
        assert_eq!(
            stale_pid_action(&record, &ProcessLookup::Unavailable),
            StalePidAction::Preserve
        );
        assert_eq!(
            stale_pid_action(&record, &ProcessLookup::Gone),
            StalePidAction::Remove
        );
    }

    #[test]
    fn a_pid_reuse_or_command_change_does_not_match_the_recorded_process() {
        let record = PidRecord {
            version: PID_FILE_VERSION,
            pid: 4321,
            started: Some("start".into()),
            command: Some("opencode serve".into()),
        };
        for identity in [
            ProcessIdentity {
                started: "different-start".into(),
                command: "opencode serve".into(),
            },
            ProcessIdentity {
                started: "start".into(),
                command: "somebody-elses-process".into(),
            },
        ] {
            assert_eq!(
                stale_pid_action(&record, &ProcessLookup::Live(identity)),
                StalePidAction::Preserve
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_legacy_pid_file_does_not_kill_an_external_process() {
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
        fs::write(&path, pid.to_string()).unwrap();
        assert_eq!(read_pid(&path), Some(pid));

        assert_eq!(cleanup_stale_opencode(&path), None);
        assert_eq!(read_pid(&path), Some(pid));
        assert_eq!(unsafe { kill(pid as i32, 0) }, 0);
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(unix)]
    #[test]
    fn a_reused_pid_does_not_kill_the_replacement_process() {
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
        let mut record = read_pid_record(&path).unwrap();
        record.started = Some("a-different-process-start".into());
        fs::write(&path, serde_json::to_string(&record).unwrap()).unwrap();

        assert_eq!(cleanup_stale_opencode(&path), None);
        assert_eq!(read_pid(&path), Some(pid));
        assert_eq!(unsafe { kill(pid as i32, 0) }, 0);
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(unix)]
    #[test]
    fn an_external_opencode_serve_on_a_port_is_not_killed() {
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::process::CommandExt;
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        let script = temp_path("opencode");
        fs::write(&script, "#!/bin/sh\nsleep 30\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let mut child = Command::new(&script)
            .args(["serve", "--hostname", "127.0.0.1", "--port", "45678"])
            .process_group(0)
            .spawn()
            .expect("fake opencode");
        let pid = child.id();

        assert_eq!(reap_opencode_on_port(45678), None);
        assert_eq!(unsafe { kill(pid as i32, 0) }, 0);
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(unix)]
    #[test]
    fn a_stale_opencode_process_with_matching_identity_is_reaped() {
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
        let record = read_pid_record(&path).unwrap();
        assert!(record.started.is_some());
        assert!(record.command.is_some());

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
}
