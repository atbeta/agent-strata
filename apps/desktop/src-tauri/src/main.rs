// Release builds are GUI programs. Without this, Windows opens a console
// beside the window and keeps it until the process exits.
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

// Agent Strata desktop shell.
//
// Spawns the strata service next to the webview. A release build uses the
// bundled sidecar. `tauri dev` still runs the TypeScript entry with bun.
// Embedded `opencode serve` is supervised only when this shell owns the
// service and the mode is embed; otherwise the service attaches to a
// pre-set STRATA_OPENCODE_URL, or the UI connects later.
//
// `App::run` ends in `process::exit`, which does not run destructors, so
// `Drop` never reaps these children. They are stopped on `RunEvent::Exit`,
// and that wait returns only once the process groups are gone.

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
    child_env, health_ok, plan_with_port, previous_port, read_mode, resolve_mode, serve_args,
    service_env, supervise, write_status, OpencodeMode, OpencodeState, Spawned,
};

use std::thread::JoinHandle;

use tauri::Manager;

struct Sidecars {
    shutdown: Arc<AtomicBool>,
    /// First caller reaps. Exit and Drop can both arrive; the second finds nothing to stop.
    stopped: AtomicBool,
    opencode: Arc<Mutex<Option<Child>>>,
    service: Mutex<Option<Child>>,
    supervise: Mutex<Option<JoinHandle<()>>>,
}

impl Sidecars {
    fn empty() -> Self {
        Self {
            shutdown: Arc::new(AtomicBool::new(false)),
            stopped: AtomicBool::new(false),
            opencode: Arc::new(Mutex::new(None)),
            service: Mutex::new(None),
            supervise: Mutex::new(None),
        }
    }

    /// Stop opencode and the service, and wait until their process groups are gone.
    ///
    /// The supervise thread is joined in between the two opencode reaps so it
    /// cannot start a replacement after the first one was taken.
    fn shutdown(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        self.shutdown.store(true, Ordering::SeqCst);
        self.reap_opencode();
        if let Some(handle) = self
            .supervise
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = handle.join();
                let _ = tx.send(());
            });
            let _ = rx.recv_timeout(Duration::from_secs(2));
        }
        self.reap_opencode();
        if let Some(mut child) = self
            .service
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            reap(&mut child);
        }
    }

    fn reap_opencode(&self) {
        if let Some(mut child) = self
            .opencode
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            reap(&mut child);
        }
    }
}

impl Drop for Sidecars {
    fn drop(&mut self) {
        self.shutdown();
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
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // The child's pid becomes its group, so closing can signal the group
        // and take grandchildren (an ACP agent, a plugin) with it.
        cmd.process_group(0);
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

/// The bundled service sits next to the executable. The build step copies it
/// there under this name; the target triple is only on the file in `binaries/`.
fn sidecar_bin() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    #[cfg(windows)]
    let path = dir.join("strata-service.exe");
    #[cfg(not(windows))]
    let path = dir.join("strata-service");
    if path.is_file() {
        Some(path)
    } else {
        None
    }
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe {
        // Negative pid: every member of the group, not only the leader.
        kill(-(pid as i32), 9);
    }
}

/// Signal the child's process group and wait until the child itself is reaped.
fn reap(child: &mut Child) {
    #[cfg(unix)]
    kill_group(child.id());
    #[cfg(windows)]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

impl Sidecars {
    fn start() -> Self {
        let shutdown = Arc::new(AtomicBool::new(false));
        let opencode = Arc::new(Mutex::new(None));
        let mut supervisor = None;
        let data = data_dir();
        let log_path = data.join("service.log");
        let Some(log) = open_log(&log_path) else {
            eprintln!("agent-strata: could not open {}", log_path.display());
            return Sidecars::empty();
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
            return Sidecars::empty();
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
                // The service needs to know that this address is not ours, or it
                // would treat it as the embedded server and prune it away.
                extras.push(("STRATA_OPENCODE_PLACEMENT".to_string(), "external".to_string()));
            }
            OpencodeMode::Embed => {
                // The placement says which server the address belongs to, not
                // whether the binary was there to start it.
                extras.push(("STRATA_OPENCODE_PLACEMENT".to_string(), "embed".to_string()));
                if let Some(bin) = which("opencode") {
                    // The last run's port, if it is still free. A different port
                    // every launch would leave the app with a new remembered
                    // address every time it opened.
                    let preferred = previous_port(&status_path);
                    match plan_with_port(OpencodeMode::Embed, preferred) {
                        Ok(planned) => {
                            let supervise_log =
                                log.try_clone().ok().or_else(|| open_log(&log_path));
                            if let Some(supervise_log) = supervise_log {
                                extras.extend(service_env(&planned));
                                let home = home_dir();
                                let shutdown_flag = shutdown.clone();
                                let opencode_slot = opencode.clone();
                                let exited = Arc::new(AtomicBool::new(false));
                                supervisor = Some(std::thread::spawn(move || {
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
                                                let mut slot =
                                                    opencode_slot.lock().map_err(|_| {
                                                        std::io::Error::new(
                                                            std::io::ErrorKind::Other,
                                                            "opencode mutex poisoned",
                                                        )
                                                    })?;
                                                if shutdown_flag.load(Ordering::SeqCst) {
                                                    reap(&mut child);
                                                    return Err(std::io::Error::new(
                                                        std::io::ErrorKind::Interrupted,
                                                        "shutdown",
                                                    ));
                                                }
                                                if let Some(mut prev) = slot.take() {
                                                    reap(&mut prev);
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
                                                                reap(&mut child);
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
                                }));
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
        // The window used to wait here, up to eight seconds, before the webview
        // could paint. The page retries the first read instead.
        let service_child = if !cfg!(debug_assertions) {
            match sidecar_bin() {
                Some(bin) => spawn(&bin, &[], &data, &envs, &log),
                None => {
                    eprintln!("agent-strata: bundled service is not next to the executable");
                    None
                }
            }
        } else if !service.is_file() {
            eprintln!(
                "agent-strata: service entry not found at {}",
                service.display()
            );
            None
        } else if let Some(bun) = which("bun") {
            spawn(
                &bun,
                &[service.to_string_lossy().into_owned()],
                &root,
                &envs,
                &log,
            )
        } else {
            eprintln!("agent-strata: bun not found on PATH");
            None
        };

        Sidecars {
            shutdown,
            stopped: AtomicBool::new(false),
            opencode,
            service: Mutex::new(service_child),
            supervise: Mutex::new(supervisor),
        }
    }
}

/// A webview download lands in ~/Downloads without ever asking — WKWebView
/// does not show a save panel for blob URLs. The export button goes through
/// this instead: a real save panel, then the file written where it pointed.
/// Returns the chosen path, or None when the panel was dismissed.
#[tauri::command]
async fn save_export(file_name: String, contents: Vec<u8>) -> Result<Option<String>, String> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_file_name(&file_name)
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let path = file.path().to_path_buf();
    fs::write(&path, &contents).map_err(|e| format!("write {} failed: {e}", path.display()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![save_export])
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
            app.manage(Sidecars::start());

            // The page shows this window itself, after two frames, which is
            // what keeps a black webview from flashing with a native title bar
            // over it. `requestAnimationFrame` does not run while the window is
            // off screen, though, and this window starts hidden — so that path
            // cannot finish on its own and the window would never appear at
            // all. Give the page its head start, then show the window here.
            let window = app.get_webview_window("main");
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(1200));
                if let Some(window) = window {
                    // Fail open: a window that never appears is worse than one
                    // that appears a frame early.
                    if !window.is_visible().unwrap_or(false) {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building agent-strata")
        .run(|app, event| match event {
            tauri::RunEvent::Exit => {
                if let Some(sidecars) = app.try_state::<Sidecars>() {
                    sidecars.shutdown();
                }
            }
            // macOS sends this when the Dock icon is clicked while the app is
            // already running. Unhandled, the click does nothing — which is
            // indistinguishable from a window that never showed.
            //
            // `RunEvent::Reopen` only exists on macOS — tauri gates the variant
            // behind `#[cfg(target_os = "macos")]` — so the arm needs the same
            // gate or Windows and Linux fail to compile on the missing variant.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        });
}

#[cfg(all(test, unix))]
mod tests {
    use super::reap;
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }

    #[test]
    fn closing_reaps_the_process_group() {
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .expect("sleep");
        let pid = child.id();
        reap(&mut child);
        let still_alive = unsafe { kill(pid as i32, 0) == 0 };
        assert!(!still_alive, "child {pid} was still alive after close");
    }
}
