// Agent Strata desktop shell.
//
// Spawns the strata service next to the webview and kills it when the app
// exits. `opencode serve` is started only when STRATA_OPENCODE_EMBED=1;
// otherwise the service attaches to STRATA_OPENCODE_URL if that is set, or
// the UI connects later.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use tauri::Manager;

struct Sidecars(Vec<Child>);

impl Drop for Sidecars {
    fn drop(&mut self) {
        for mut child in self.0.drain(..) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn repo_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    fs::canonicalize(manifest.join("../../..")).unwrap_or(manifest.join("../../.."))
}

fn which(name: &str) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    for fallback in [
        format!("/opt/homebrew/bin/{name}"),
        format!("/usr/local/bin/{name}"),
        format!("{home}/.bun/bin/{name}"),
    ] {
        let candidate = PathBuf::from(fallback);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn data_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let dir = PathBuf::from(home).join(".agent-strata");
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
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
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
    match cmd.spawn() {
        Ok(child) => Some(child),
        Err(e) => {
            eprintln!("spawn {} failed: {e}", bin.display());
            None
        }
    }
}

impl Sidecars {
    fn start() -> Self {
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

        let mut envs: Vec<(&str, String)> = vec![
            ("STRATA_DB", db),
            ("STRATA_PORT", port.to_string()),
        ];
        if std::env::var("STRATA_OPENCODE_EMBED").as_deref() == Ok("1") {
            envs.push(("STRATA_OPENCODE_URL", "http://127.0.0.1:4096".into()));
        } else if let Ok(url) = std::env::var("STRATA_OPENCODE_URL") {
            if !url.is_empty() {
                envs.push(("STRATA_OPENCODE_URL", url));
            }
        }
        for key in [
            "STRATA_OPENCODE_USERNAME",
            "STRATA_OPENCODE_PASSWORD",
            "STRATA_POLICY",
        ] {
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
                    children.push(child);
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
        } else if !service.is_file() {
            eprintln!("agent-strata: service entry not found at {}", service.display());
        } else if let Some(bun) = which("bun") {
            if let Some(child) = spawn(
                &bun,
                &[service.to_string_lossy().into_owned()],
                &root,
                &envs,
                &log,
            ) {
                children.push(child);
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
        .setup(|app| {
            app.manage(Sidecars::start());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running agent-strata");
}
