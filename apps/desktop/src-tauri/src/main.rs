// Release builds are GUI programs. Without this, Windows opens a console
// beside the window and keeps it until the process exits.
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

// Agent Strata desktop shell.
//
// Spawns the strata service next to the webview and kills it when the app
// exits. A release build uses the bundled sidecar. `tauri dev` still runs
// the TypeScript entry with bun. Embedded `opencode serve` is supervised
// only when this shell owns the service and the mode is embed; otherwise
// the service attaches to a pre-set STRATA_OPENCODE_URL, or the UI
// connects later.

mod embed;

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use embed::{
    child_env, health_ok, plan, read_mode, resolve_mode, serve_args, service_env, supervise,
    write_status, OpencodeMode, OpencodeState, Spawned,
};

use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

enum Proc {
    Std(Child),
    Bundled(CommandChild),
}

struct Sidecars {
    children: Vec<Proc>,
    shutdown: Arc<AtomicBool>,
    opencode: Arc<Mutex<Option<Child>>>,
}

impl Drop for Sidecars {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Ok(mut slot) = self.opencode.lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        for proc in self.children.drain(..) {
            match proc {
                Proc::Std(mut child) => {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                Proc::Bundled(child) => {
                    let _ = child.kill();
                }
            }
        }
    }
}

fn repo_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    fs::canonicalize(manifest.join("../../..")).unwrap_or(manifest.join("../../.."))
}

fn home_dir() -> PathBuf {
    for key in ["HOME", "USERPROFILE"] {
        if let Ok(value) = std::env::var(key) {
            if !value.is_empty() {
                return PathBuf::from(value);
            }
        }
    }
    PathBuf::from(".")
}

fn which(name: &str) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        vec![name.to_string(), format!("{name}.exe")]
    } else {
        vec![name.to_string()]
    };
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in &names {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    let home = home_dir();
    for name in &names {
        for fallback in [
            PathBuf::from(format!("/opt/homebrew/bin/{name}")),
            PathBuf::from(format!("/usr/local/bin/{name}")),
            home.join(".bun").join("bin").join(name),
        ] {
            if fallback.is_file() {
                return Some(fallback);
            }
        }
    }
    None
}

fn data_dir() -> PathBuf {
    let dir = home_dir().join(".agent-strata");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn port_open(port: u16) -> bool {
    let Ok(addr) = format!("127.0.0.1:{port}").parse::<SocketAddr>() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

fn wait_port(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if port_open(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

fn open_log(path: &Path) -> Option<File> {
    OpenOptions::new().create(true).append(true).open(path).ok()
}

fn spawn(
    bin: &Path,
    args: &[String],
    cwd: &Path,
    envs: &[(&str, String)],
    log: &File,
) -> Option<Child> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .current_dir(cwd)
        .envs(envs.iter().map(|(k, v)| (*k, v.as_str())));
    match (log.try_clone(), log.try_clone()) {
        (Ok(out), Ok(err)) => {
            cmd.stdout(Stdio::from(out)).stderr(Stdio::from(err));
        }
        _ => {
            cmd.stdout(Stdio::inherit()).stderr(Stdio::inherit());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    match cmd.spawn() {
        Ok(child) => Some(child),
        Err(e) => {
            eprintln!("spawn {} failed: {e}", bin.display());
            None
        }
    }
}

fn spawn_bundled(
    app: &tauri::AppHandle,
    envs: &[(&str, String)],
    cwd: &Path,
    log_path: &Path,
) -> Option<CommandChild> {
    let command = match app.shell().sidecar("strata-service") {
        Ok(command) => command,
        Err(e) => {
            eprintln!("agent-strata: bundled service is not available: {e}");
            return None;
        }
    };
    let (mut rx, child) = match command
        .current_dir(cwd)
        .envs(envs.iter().map(|(k, v)| (*k, v.as_str())))
        .spawn()
    {
        Ok(spawned) => spawned,
        Err(e) => {
            eprintln!("agent-strata: bundled service failed to start: {e}");
            return None;
        }
    };
    let log_path = log_path.to_path_buf();
    tauri::async_runtime::spawn(async move {
        let mut log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .ok();
        while let Some(event) = rx.recv().await {
            let line = match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    String::from_utf8_lossy(&bytes).into_owned()
                }
                CommandEvent::Error(err) => format!("sidecar error: {err}\n"),
                CommandEvent::Terminated(payload) => format!("sidecar exited: {payload:?}\n"),
                _ => continue,
            };
            if let Some(file) = log.as_mut() {
                let _ = write!(file, "{line}");
                let _ = file.flush();
            }
        }
    });
    Some(child)
}

impl Sidecars {
    fn start(app: &tauri::AppHandle) -> Self {
        let shutdown = Arc::new(AtomicBool::new(false));
        let opencode = Arc::new(Mutex::new(None));
        let mut children = Vec::new();
        let data = data_dir();
        let log_path = data.join("service.log");
        let Some(log) = open_log(&log_path) else {
            eprintln!("agent-strata: could not open {}", log_path.display());
            return Sidecars {
                children,
                shutdown,
                opencode,
            };
        };
        if let Ok(mut stamp) = log.try_clone() {
            let _ = writeln!(stamp, "\n--- agent-strata shell starting ---");
        }

        let db = std::env::var("STRATA_DB")
            .unwrap_or_else(|_| data.join("events.db").to_string_lossy().into_owned());
        if let Some(parent) = Path::new(&db).parent() {
            let _ = fs::create_dir_all(parent);
        }
        let port: u16 = std::env::var("STRATA_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(7700);
        let policy = std::env::var("STRATA_POLICY")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| data.join("policy.json").to_string_lossy().into_owned());

        let env_embed = std::env::var("STRATA_OPENCODE_EMBED").ok();
        let file_mode = match read_mode(&data.join("desktop.json")) {
            OpencodeMode::External => "external",
            OpencodeMode::Embed => "embed",
        };
        let mode = resolve_mode(env_embed.as_deref(), Some(file_mode));

        let mut extras: Vec<(String, String)> = Vec::new();

        if port_open(port) {
            eprintln!(
                "agent-strata: port {port} is already open, leaving the existing service in place"
            );
            return Sidecars {
                children,
                shutdown,
                opencode,
            };
        }

        let status_path = data.join("opencode-status.json");
        match mode {
            OpencodeMode::External => {
                let _ = write_status(&status_path, mode, OpencodeState::External, None);
                for key in [
                    "STRATA_OPENCODE_URL",
                    "STRATA_OPENCODE_USERNAME",
                    "STRATA_OPENCODE_PASSWORD",
                ] {
                    if let Ok(value) = std::env::var(key) {
                        if !value.is_empty() {
                            extras.push((key.to_string(), value));
                        }
                    }
                }
            }
            OpencodeMode::Embed => {
                if let Some(bin) = which("opencode") {
                    match plan(OpencodeMode::Embed) {
                        Ok(planned) => {
                            let supervise_log =
                                log.try_clone().ok().or_else(|| open_log(&log_path));
                            if let Some(supervise_log) = supervise_log {
                                extras.extend(service_env(&planned));
                                let home = home_dir();
                                let shutdown_flag = shutdown.clone();
                                let opencode_slot = opencode.clone();
                                let exited = Arc::new(AtomicBool::new(false));
                                std::thread::spawn(move || {
                                    let wait_shutdown = shutdown_flag.clone();
                                    let wait_slot = opencode_slot.clone();
                                    let wait_exited = exited.clone();
                                    supervise(
                                        planned,
                                        &status_path,
                                        {
                                            let shutdown_flag = shutdown_flag.clone();
                                            let opencode_slot = opencode_slot.clone();
                                            let exited = exited.clone();
                                            move |p| {
                                                if shutdown_flag.load(Ordering::SeqCst) {
                                                    return Err(std::io::Error::new(
                                                        std::io::ErrorKind::Interrupted,
                                                        "shutdown",
                                                    ));
                                                }
                                                let args = serve_args(p.port);
                                                let owned = child_env(p);
                                                let env_refs: Vec<(&str, String)> = owned
                                                    .iter()
                                                    .map(|(k, v)| (k.as_str(), v.clone()))
                                                    .collect();
                                                let mut child = spawn(
                                                    &bin,
                                                    &args,
                                                    &home,
                                                    &env_refs,
                                                    &supervise_log,
                                                )
                                                .ok_or_else(|| {
                                                    std::io::Error::new(
                                                        std::io::ErrorKind::Other,
                                                        "spawn opencode failed",
                                                    )
                                                })?;
                                                let mut slot = opencode_slot.lock().map_err(|_| {
                                                    std::io::Error::new(
                                                        std::io::ErrorKind::Other,
                                                        "opencode mutex poisoned",
                                                    )
                                                })?;
                                                if shutdown_flag.load(Ordering::SeqCst) {
                                                    let _ = child.kill();
                                                    let _ = child.wait();
                                                    return Err(std::io::Error::new(
                                                        std::io::ErrorKind::Interrupted,
                                                        "shutdown",
                                                    ));
                                                }
                                                if let Some(mut prev) = slot.take() {
                                                    let _ = prev.kill();
                                                    let _ = prev.wait();
                                                }
                                                *slot = Some(child);
                                                drop(slot);
                                                exited.store(false, Ordering::SeqCst);
                                                let kill_slot = opencode_slot.clone();
                                                Ok(Spawned {
                                                    exited: exited.clone(),
                                                    kill: Box::new(move || {
                                                        if let Ok(mut slot) = kill_slot.lock() {
                                                            if let Some(mut child) = slot.take() {
                                                                let _ = child.kill();
                                                                let _ = child.wait();
                                                            }
                                                        }
                                                    }),
                                                })
                                            }
                                        },
                                        |p| health_ok(&p.url, &p.username, &p.password),
                                        move |d| {
                                            let start = Instant::now();
                                            while start.elapsed() < d {
                                                if wait_shutdown.load(Ordering::SeqCst) {
                                                    return;
                                                }
                                                if let Ok(mut guard) = wait_slot.lock() {
                                                    if let Some(child) = guard.as_mut() {
                                                        if let Ok(Some(_)) = child.try_wait() {
                                                            wait_exited
                                                                .store(true, Ordering::SeqCst);
                                                        }
                                                    }
                                                }
                                                let remaining = d.saturating_sub(start.elapsed());
                                                if remaining.is_zero() {
                                                    break;
                                                }
                                                std::thread::sleep(
                                                    remaining.min(Duration::from_millis(50)),
                                                );
                                            }
                                        },
                                        shutdown_flag,
                                    );
                                });
                            } else {
                                eprintln!(
                                    "agent-strata: could not open opencode log at {}",
                                    log_path.display()
                                );
                            }
                        }
                        Err(e) => {
                            eprintln!("agent-strata: could not plan embedded opencode: {e}");
                        }
                    }
                } else {
                    let _ = write_status(&status_path, mode, OpencodeState::Missing, None);
                }
            }
        }

        let mut envs: Vec<(&str, String)> = vec![
            ("STRATA_DB", db),
            ("STRATA_PORT", port.to_string()),
            ("STRATA_POLICY", policy),
        ];
        for (key, value) in &extras {
            envs.push((key.as_str(), value.clone()));
        }

        let root = repo_root();
        let service = root.join("packages/service/src/index.ts");
        if !cfg!(debug_assertions) {
            if let Some(child) = spawn_bundled(app, &envs, &data, &log_path) {
                children.push(Proc::Bundled(child));
                if !wait_port(port, Duration::from_secs(8)) {
                    eprintln!(
                        "agent-strata: bundled service did not listen on {port}; see {}",
                        log_path.display()
                    );
                }
            }
        } else if !service.is_file() {
            eprintln!(
                "agent-strata: service entry not found at {}",
                service.display()
            );
        } else if let Some(bun) = which("bun") {
            if let Some(child) = spawn(
                &bun,
                &[service.to_string_lossy().into_owned()],
                &root,
                &envs,
                &log,
            ) {
                children.push(Proc::Std(child));
                if !wait_port(port, Duration::from_secs(8)) {
                    eprintln!(
                        "agent-strata: service did not listen on {port}; see {}",
                        log_path.display()
                    );
                }
            }
        } else {
            eprintln!("agent-strata: bun not found on PATH");
        }

        Sidecars {
            children,
            shutdown,
            opencode,
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // macOS keeps the overlay title bar and traffic lights. Windows
            // drops the native caption so the webview's drag strip and caption
            // buttons own the top edge. The thick frame stays, so the window
            // can still be resized from the edges.
            if cfg!(target_os = "windows") {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(err) = window.set_decorations(false) {
                        eprintln!("agent-strata: could not hide the Windows title bar: {err}");
                    }
                    if let Err(err) = window.set_shadow(true) {
                        eprintln!("agent-strata: could not set the Windows shadow: {err}");
                    }
                }
            }
            app.manage(Sidecars::start(app.handle()));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running agent-strata");
}
