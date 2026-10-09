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
// the TypeScript entry with bun. `opencode serve` is started only when
// STRATA_OPENCODE_EMBED=1; otherwise the service attaches to
// STRATA_OPENCODE_URL if that is set, or the UI connects later.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

enum Proc {
    Std(Child),
    Bundled(CommandChild),
}

struct Sidecars(Vec<Proc>);

impl Drop for Sidecars {
    fn drop(&mut self) {
        for proc in self.0.drain(..) {
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
        let mut children = Vec::new();
        let data = data_dir();
        let log_path = data.join("service.log");
        let Some(log) = open_log(&log_path) else {
            eprintln!("agent-strata: could not open {}", log_path.display());
            return Sidecars(children);
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

        let mut envs: Vec<(&str, String)> = vec![
            ("STRATA_DB", db),
            ("STRATA_PORT", port.to_string()),
            ("STRATA_POLICY", policy),
        ];
        if std::env::var("STRATA_OPENCODE_EMBED").as_deref() == Ok("1") {
            envs.push(("STRATA_OPENCODE_URL", "http://127.0.0.1:4096".into()));
        } else if let Ok(url) = std::env::var("STRATA_OPENCODE_URL") {
            if !url.is_empty() {
                envs.push(("STRATA_OPENCODE_URL", url));
            }
        }
        for key in ["STRATA_OPENCODE_USERNAME", "STRATA_OPENCODE_PASSWORD"] {
            if let Ok(value) = std::env::var(key) {
                if !value.is_empty() {
                    envs.push((key, value));
                }
            }
        }

        let root = repo_root();
        let embed = std::env::var("STRATA_OPENCODE_EMBED").as_deref() == Ok("1");
        if embed && !port_open(4096) {
            if let Some(opencode) = which("opencode") {
                if let Some(child) = spawn(
                    &opencode,
                    &[
                        "serve".into(),
                        "--hostname".into(),
                        "127.0.0.1".into(),
                        "--port".into(),
                        "4096".into(),
                    ],
                    &root,
                    &[],
                    &log,
                ) {
                    children.push(Proc::Std(child));
                }
            } else {
                eprintln!("agent-strata: opencode not found on PATH");
            }
        }

        let service = root.join("packages/service/src/index.ts");
        if port_open(port) {
            eprintln!(
                "agent-strata: port {port} is already open, leaving the existing service in place"
            );
        } else if !cfg!(debug_assertions) {
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

        Sidecars(children)
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
