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
mod plugin_install;

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use embed::{
    child_env, cleanup_stale_opencode, command_for, detect_runtime, health_ok, plan_with_port,
    previous_port, read_mode, reap_opencode_on_port, resolve_mode, serve_args, service_env,
    supervise, write_pid, write_runtime, write_status, OpencodeMode, OpencodePlan, OpencodeState,
    Spawned,
};

use std::thread::JoinHandle;

use tauri::Manager;

struct Sidecars {
    shutdown: Arc<AtomicBool>,
    /// Set by the doctor's restart button; the supervisor treats it as a
    /// request to kill the current child and converge again on the same plan.
    restart: Arc<AtomicBool>,
    /// First caller reaps. Exit and Drop can both arrive; the second finds nothing to stop.
    stopped: AtomicBool,
    opencode: Arc<Mutex<Option<Child>>>,
    /// The current child's stdin while it sits at a domain login prompt. The
    /// login command answers through it; the kill path drops it with the child.
    login: Arc<Mutex<Option<LoginPipe>>>,
    service: Mutex<Option<Child>>,
    supervise: Mutex<Option<JoinHandle<()>>>,
    /// The handshake a globally loaded plugin reads to find this service. Removed
    /// on a clean exit so a plugin cannot hand work to a process that is gone.
    handshake: PathBuf,
    /// Kept for an on-demand start: switching to embed mid-run asks for a
    /// supervisor that launch never built.
    data: PathBuf,
    log: Option<Log>,
    /// The port the service listens on; an embedded server's plan needs it so
    /// its plugin can find the service.
    service_port: u16,
}

impl Sidecars {
    fn empty() -> Self {
        Self {
            shutdown: Arc::new(AtomicBool::new(false)),
            restart: Arc::new(AtomicBool::new(false)),
            stopped: AtomicBool::new(false),
            opencode: Arc::new(Mutex::new(None)),
            login: Arc::new(Mutex::new(None)),
            service: Mutex::new(None),
            supervise: Mutex::new(None),
            handshake: PathBuf::new(),
            data: data_dir(),
            log: None,
            service_port: 7700,
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
        // Last, and only after the service is gone: a handshake that outlived
        // its service would make every OpenCode on the machine probe a dead
        // port before falling back.
        if !self.handshake.as_os_str().is_empty() {
            let _ = fs::remove_file(&self.handshake);
        }
    }

    /// Ask the supervisor to replace the running embedded server — or stand a
    /// supervisor up when none is alive. Launching in external mode never made
    /// one, and a supervisor that kept failing has already exited; in both
    /// cases the settings page's start button has nothing to signal, so this
    /// builds the thread it needs instead of reporting the launch as final.
    fn request_restart(&self) -> Result<(), String> {
        let mut supervise = self.supervise.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(handle) = supervise.as_ref() {
            if !handle.is_finished() {
                self.restart.store(true, Ordering::SeqCst);
                return Ok(());
            }
        }
        // The file is the choice: a mode picked after launch counts, the mode
        // the launch happened to read does not decide on its own.
        if read_mode(&self.data.join("desktop.json")) != OpencodeMode::Embed {
            return Err("the embedded OpenCode server is not the selected mode".into());
        }
        let Some(log) = self.log.clone() else {
            return Err("the embedded OpenCode server is not being supervised".into());
        };
        let spawned = spawn_opencode_supervisor(
            &self.data,
            &log,
            self.service_port,
            self.shutdown.clone(),
            self.restart.clone(),
            self.opencode.clone(),
            self.login.clone(),
        );
        match spawned {
            Some((handle, _plan)) => {
                *supervise = Some(handle);
                Ok(())
            }
            None => Err("could not start the embedded OpenCode server".into()),
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

type Log = Arc<Mutex<File>>;

/// One line, one timestamp, one lock. Child stdout and stderr both come
/// through here, so a log line cannot be split by the other stream.
fn log_line(log: &Log, line: &str) {
    let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    if let Ok(mut file) = log.lock() {
        let _ = writeln!(file, "{stamp} | {line}");
    }
}

fn log_note(log: &Log, line: &str) {
    log_line(log, line);
}

fn pipe_to_log<R: Read + Send + 'static>(reader: R, log: Log) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            match line {
                Ok(line) => log_line(&log, &line),
                Err(_) => break,
            }
        }
    });
}

/// Watches a child's raw stdout/stderr before the log sees it. Chunks arrive
/// unsplit — a prompt that never ends in a newline still reaches the watcher.
type Scan = Arc<dyn Fn(&[u8]) + Send + Sync>;

/// The company fork parks every subcommand — `serve` included — at a domain
/// account prompt when it has no credentials on disk. Upstream builds never
/// print these markers, so watching costs nothing on a stock binary.
const AUTH_PROMPT: &str = "请输入域账号";
const AUTH_REFUSED: &str = "域账号或密码错误";

/// A stdin kept open for the fork's login prompt, plus the stage the output
/// scanner reports into. Answering the prompt writes to `stdin` and drops
/// `stage` back to 1 so a previous refusal clears while it is checked.
struct LoginPipe {
    stdin: ChildStdin,
    stage: Arc<AtomicU8>,
}

/// Report prompt markers into `stage`: 1 while parked, 2 once a refusal is
/// seen. The refusal is sticky — a re-prompt after it does not clear the error
/// on screen; only a fresh answer through `LoginPipe` does.
fn auth_scan(stage: Arc<AtomicU8>) -> Scan {
    let tail = Mutex::new(String::new());
    Arc::new(move |chunk: &[u8]| {
        let mut tail = tail.lock().unwrap_or_else(|e| e.into_inner());
        let hay = format!("{}{}", tail.as_str(), String::from_utf8_lossy(chunk));
        if hay.contains(AUTH_REFUSED) {
            stage.store(2, Ordering::SeqCst);
        } else if hay.contains(AUTH_PROMPT) {
            let _ = stage.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst);
        }
        let keep = hay.len().min(64);
        let mut cut = hay.len() - keep;
        while !hay.is_char_boundary(cut) {
            cut += 1;
        }
        *tail = hay[cut..].to_string();
    })
}

/// Log output line-wise like `pipe_to_log`, but hand every raw chunk to `scan`
/// first: a login prompt ends mid-line, so line buffering would hide it.
fn pipe_to_log_scanned<R: Read + Send + 'static>(mut reader: R, log: Log, scan: Scan) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    scan(&buf[..n]);
                    pending.extend_from_slice(&buf[..n]);
                    while let Some(pos) = pending.iter().position(|b| *b == b'\n') {
                        let line: Vec<u8> = pending.drain(..=pos).collect();
                        log_line(&log, &String::from_utf8_lossy(&line[..line.len() - 1]));
                    }
                }
            }
        }
        if !pending.is_empty() {
            log_line(&log, &String::from_utf8_lossy(&pending));
        }
    });
}

fn spawn(
    bin: &Path,
    args: &[String],
    cwd: &Path,
    envs: &[(&str, String)],
    log: &Log,
) -> Option<Child> {
    spawn_with(bin, args, cwd, envs, log, false, None)
}

fn spawn_with(
    bin: &Path,
    args: &[String],
    cwd: &Path,
    envs: &[(&str, String)],
    log: &Log,
    stdin_piped: bool,
    scan: Option<Scan>,
) -> Option<Child> {
    let mut cmd = command_for(bin);
    cmd.args(args)
        .current_dir(cwd)
        .envs(envs.iter().map(|(k, v)| (*k, v.as_str())))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if stdin_piped {
        cmd.stdin(Stdio::piped());
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // The child's pid becomes its group, so closing can signal the group
        // and take grandchildren (an ACP agent, a plugin) with it.
        cmd.process_group(0);
    }
    // The console is already hidden: the command comes from embed's
    // `command_for`, which starts every one of them without a window.
    match cmd.spawn() {
        Ok(mut child) => {
            if let Some(stdout) = child.stdout.take() {
                match &scan {
                    Some(scan) => pipe_to_log_scanned(stdout, log.clone(), scan.clone()),
                    None => pipe_to_log(stdout, log.clone()),
                }
            }
            if let Some(stderr) = child.stderr.take() {
                match &scan {
                    Some(scan) => pipe_to_log_scanned(stderr, log.clone(), scan.clone()),
                    None => pipe_to_log(stderr, log.clone()),
                }
            }
            Some(child)
        }
        Err(e) => {
            eprintln!("spawn {} failed: {e}", bin.display());
            log_note(log, &format!("spawn {} failed: {e}", bin.display()));
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
        // `Child::kill` terminates one process. The service spawns a dev server
        // per session, and those are grandchildren: killing the service alone
        // leaves them running with nothing that can stop them.
        //
        // The helper is a console program, so it lives in embed.rs, which
        // starts every command without a console window.
        embed::kill_tree(child.id());
    }
    let _ = child.wait();
}

/// Plan the embedded server and start the thread that keeps it alive.
///
/// The same path runs at launch and when the settings page asks for a server
/// nothing supervises — a mode switched mid-run, or a supervisor that gave
/// up. The plan comes back with the thread so the launch path can still hand
/// the address to the service it is about to spawn.
fn spawn_opencode_supervisor(
    data: &Path,
    log: &Log,
    service_port: u16,
    shutdown: Arc<AtomicBool>,
    restart: Arc<AtomicBool>,
    opencode: Arc<Mutex<Option<Child>>>,
    login: Arc<Mutex<Option<LoginPipe>>>,
) -> Option<(JoinHandle<()>, OpencodePlan)> {
    let status_path = data.join("opencode-status.json");
    let pid_path = data.join("opencode.pid");
    // Re-detect rather than trusting the launch result: a binary chosen or
    // installed while the app was open should not need a relaunch.
    let runtime = detect_runtime(data, OpencodeMode::Embed);
    let _ = write_runtime(&data.join("opencode-runtime.json"), &runtime);
    let Some(bin) = runtime
        .bin
        .as_deref()
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    else {
        let _ = write_status(
            &status_path,
            OpencodeMode::Embed,
            OpencodeState::Missing,
            None,
            None,
        );
        log_note(log, "no opencode binary found for embedded mode");
        return None;
    };

    // A previous run may have left its embedded server behind. Reap it before
    // planning so the last port is free again.
    if let Some(pid) = cleanup_stale_opencode(&pid_path) {
        eprintln!("agent-strata: stopped stale opencode process {pid}");
        log_note(log, &format!("stopped stale opencode process {pid}"));
    }
    // The last run's port, if it is still free. A different port every launch
    // would leave the app with a new remembered address every time it opened.
    // If an older run left an opencode serve on that port, stop it first.
    let preferred = previous_port(&status_path);
    if let Some(port) = preferred {
        if !embed::port_is_free(port) {
            if let Some(pid) = reap_opencode_on_port(port) {
                eprintln!("agent-strata: stopped opencode {pid} still holding port {port}");
                log_note(log, &format!("stopped opencode {pid} still holding port {port}"));
            }
        }
    }
    let planned = match plan_with_port(OpencodeMode::Embed, preferred, service_port) {
        Ok(planned) => planned,
        Err(e) => {
            eprintln!("agent-strata: could not plan embedded opencode: {e}");
            log_note(log, &format!("could not plan embedded opencode: {e}"));
            return None;
        }
    };
    let supervise_log = log.clone();
    // One stage shared across respawns: a refusal stays visible even when the
    // prompt is re-read by a replacement child, until an answer goes in.
    let auth_stage = Arc::new(AtomicU8::new(0));
    // The closure needs its own handle: the global install runs outside it,
    // and this one names the plugin.
    let plugin_config_dir = plugin_install::opencode_config_dir();
    let handle_plan = planned.clone();
    let handle = std::thread::spawn(move || {
        let wait_shutdown = shutdown.clone();
        let wait_slot = opencode.clone();
        let exited = Arc::new(AtomicBool::new(false));
        let wait_exited = exited.clone();
        supervise(
            planned,
            &status_path,
            {
                let shutdown_flag = shutdown.clone();
                let opencode_slot = opencode.clone();
                let login_slot = login.clone();
                let auth_stage = auth_stage.clone();
                let exited = exited.clone();
                let plugin_config_dir = plugin_config_dir.clone();
                move |p| {
                    if shutdown_flag.load(Ordering::SeqCst) {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::Interrupted,
                            "shutdown",
                        ));
                    }
                    let args = serve_args(p.port);
                    let mut owned = child_env(p);
                    // Named as well as discovered. The global install already
                    // covers this server, and this keeps a config directory
                    // that is not writable from taking the tools away from the
                    // server we started.
                    if let Some(dir) = plugin_config_dir.clone() {
                        if let Ok(plugin) = plugin_install::install_plugin(&dir) {
                            owned.push((
                                "OPENCODE_CONFIG_CONTENT".into(),
                                plugin_install::config_content(&plugin),
                            ));
                        }
                    }
                    let env_refs: Vec<(&str, String)> =
                        owned.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
                    // stdin stays piped and output gets scanned: a fork that
                    // wants a domain login parks here instead of serving, and
                    // the answer goes down this pipe.
                    let mut child = spawn_with(
                        &bin,
                        &args,
                        &home_dir(),
                        &env_refs,
                        &supervise_log,
                        true,
                        Some(auth_scan(auth_stage.clone())),
                    )
                    .ok_or_else(|| {
                        std::io::Error::new(std::io::ErrorKind::Other, "spawn opencode failed")
                    })?;
                    let _ = write_pid(&pid_path, child.id());
                    if let Some(stdin) = child.stdin.take() {
                        if let Ok(mut slot) = login_slot.lock() {
                            *slot = Some(LoginPipe {
                                stdin,
                                stage: auth_stage.clone(),
                            });
                        }
                    }
                    let mut slot = opencode_slot.lock().map_err(|_| {
                        std::io::Error::new(std::io::ErrorKind::Other, "opencode mutex poisoned")
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
                    let kill_login = login_slot.clone();
                    Ok(Spawned {
                        exited: exited.clone(),
                        kill: Box::new(move || {
                            if let Ok(mut slot) = kill_slot.lock() {
                                if let Some(mut child) = slot.take() {
                                    reap(&mut child);
                                }
                            }
                            // The pipe belongs to the child: a dead one's stdin
                            // must not answer the next prompt's questions.
                            if let Ok(mut login) = kill_login.lock() {
                                login.take();
                            }
                        }),
                        auth_stage: Some(auth_stage.clone()),
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
                                wait_exited.store(true, Ordering::SeqCst);
                            }
                        }
                    }
                    let remaining = d.saturating_sub(start.elapsed());
                    if remaining.is_zero() {
                        break;
                    }
                    std::thread::sleep(remaining.min(Duration::from_millis(50)));
                }
            },
            shutdown,
            restart,
        );
    });
    Some((handle, handle_plan))
}

impl Sidecars {
    fn start() -> Self {
        let shutdown = Arc::new(AtomicBool::new(false));
        let restart = Arc::new(AtomicBool::new(false));
        let opencode = Arc::new(Mutex::new(None));
        let login = Arc::new(Mutex::new(None));
        let mut supervisor = None;
        let data = data_dir();
        let log_path = data.join("service.log");
        let Some(log_file) = open_log(&log_path) else {
            eprintln!("agent-strata: could not open {}", log_path.display());
            return Sidecars::empty();
        };
        let log: Log = Arc::new(Mutex::new(log_file));
        log_note(&log, "---- agent-strata shell starting ----");

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

        // Read the binary and its version before anything is started. The
        // result is what the settings page shows, and it is separate from the
        // process status the supervisor rewrites on every transition.
        let runtime = detect_runtime(&data, mode);
        let runtime_path = data.join("opencode-runtime.json");
        if let Err(e) = write_runtime(&runtime_path, &runtime) {
            eprintln!(
                "agent-strata: could not write {}: {e}",
                runtime_path.display()
            );
            log_note(
                &log,
                &format!("could not write {}: {e}", runtime_path.display()),
            );
        }

        let mut extras: Vec<(String, String)> = Vec::new();

        if port_open(port) {
            eprintln!(
                "agent-strata: port {port} is already open, leaving the existing service in place"
            );
            log_note(
                &log,
                &format!("port {port} is already open; leaving the existing service in place"),
            );
            return Sidecars::empty();
        }

        // A previous run may have left its embedded server behind (a crash, a
        // killed dev process, a rebuild). Reap it before planning, so the last
        // port is free again and the next launch reuses it instead of opening a
        // second server and remembering a third address.
        let pid_path = data.join("opencode.pid");
        if let Some(pid) = cleanup_stale_opencode(&pid_path) {
            eprintln!("agent-strata: stopped stale opencode process {pid}");
            log_note(&log, &format!("stopped stale opencode process {pid}"));
        }

        let status_path = data.join("opencode-status.json");
        // Installed for every mode, and outside the match below on purpose: the
        // whole point of a global plugin is that the OpenCode the reader started
        // themselves gets it too. Installing it only in the embed branch was the
        // bug — the external server never saw the tools, so the model kept
        // reaching for `Start-Process`.
        if let Some(dir) = plugin_install::opencode_config_dir() {
            match plugin_install::install_plugin(&dir) {
                Ok(path) => {
                    log_note(&log, &format!("installed dev-process plugin at {}", path.display()));
                }
                Err(e) => {
                    eprintln!("agent-strata: could not install the dev-process plugin: {e}");
                    log_note(&log, &format!("could not install dev-process plugin: {e}"));
                }
            }
        }
        match mode {
            OpencodeMode::External => {
                let _ = write_status(&status_path, mode, OpencodeState::External, None, None);
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
                extras.push((
                    "STRATA_OPENCODE_PLACEMENT".to_string(),
                    "external".to_string(),
                ));
            }
            OpencodeMode::Embed => {
                // The placement says which server the address belongs to, not
                // whether the binary was there to start it.
                extras.push(("STRATA_OPENCODE_PLACEMENT".to_string(), "embed".to_string()));
                if let Some((handle, planned)) = spawn_opencode_supervisor(
                    &data,
                    &log,
                    port,
                    shutdown.clone(),
                    restart.clone(),
                    opencode.clone(),
                    login.clone(),
                ) {
                    extras.extend(service_env(&planned));
                    supervisor = Some(handle);
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
                    log_note(&log, "bundled service is not next to the executable");
                    None
                }
            }
        } else if !service.is_file() {
            eprintln!(
                "agent-strata: service entry not found at {}",
                service.display()
            );
            log_note(
                &log,
                &format!("service entry not found at {}", service.display()),
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
            log_note(&log, "bun not found on PATH");
            None
        };

        // The handshake a globally loaded plugin reads. Written only once the
        // service is up: a file pointing at a port nothing listens on is worse
        // than no file, because every OpenCode on the machine probes it first.
        let handshake = plugin_install::opencode_config_dir()
            .map(|dir| plugin_install::handshake_path(&dir))
            .unwrap_or_default();
        if service_child.is_some() && !handshake.as_os_str().is_empty() {
            let url = format!("http://127.0.0.1:{port}");
            if let Some(parent) = handshake.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let body = serde_json::json!({ "url": url, "pid": std::process::id() });
            if let Err(e) = fs::write(&handshake, format!("{body}\n")) {
                eprintln!("agent-strata: could not write {}: {e}", handshake.display());
                log_note(&log, &format!("could not write handshake: {e}"));
            }
        }

        Sidecars {
            shutdown,
            restart,
            stopped: AtomicBool::new(false),
            opencode,
            login,
            service: Mutex::new(service_child),
            supervise: Mutex::new(supervisor),
            handshake,
            data,
            log: Some(log),
            service_port: port,
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

/// Ask the supervisor to replace the embedded server. The command returns as
/// soon as the request is queued; the page polls `/desktop/opencode` for the
/// state to settle rather than holding the UI on a restart.
#[tauri::command]
fn restart_opencode(state: tauri::State<Sidecars>) -> Result<(), String> {
    state.request_restart()
}

/// Answer the embedded server's domain login prompt. The company fork reads
/// the account and password from stdin before it serves anything; an upstream
/// binary never asks, so the pipe only exists while a prompt is parked. A
/// refusal leaves the prompt parked — the form just submits again.
#[tauri::command]
fn opencode_login(
    state: tauri::State<Sidecars>,
    username: String,
    password: String,
) -> Result<(), String> {
    answer_login(&state.login, &username, &password)
}

fn answer_login(
    login: &Mutex<Option<LoginPipe>>,
    username: &str,
    password: &str,
) -> Result<(), String> {
    let mut guard = login.lock().map_err(|_| "login state is poisoned")?;
    let Some(pipe) = guard.as_mut() else {
        return Err("the embedded OpenCode server is not waiting for a login".into());
    };
    writeln!(pipe.stdin, "{username}")
        .and_then(|_| writeln!(pipe.stdin, "{password}"))
        .map_err(|e| format!("could not answer the login prompt: {e}"))?;
    // A refusal stays on screen until an answer actually goes in — this is the
    // point it becomes a fresh attempt, so the status flips back to waiting.
    pipe.stage.store(1, Ordering::SeqCst);
    Ok(())
}

/// Open the log the shell and the embedded server share. The path is fixed,
/// not passed in: this is a doctor button, not a general file opener.
#[tauri::command]
fn open_log_file() -> Result<String, String> {
    let path = data_dir().join("service.log");
    if !path.is_file() {
        return Err("the log file has not been created yet".into());
    }
    open_path(&path).map_err(|e| format!("could not open {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Open the OS notification pane. The desktop notification plugin does not
/// ask for permission on desktop, so when a banner is missing this is where the
/// reader can check that the app (or Terminal, in dev) is allowed.
#[tauri::command]
fn open_notification_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        for url in [
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
            "x-apple.systempreferences:com.apple.preference.notifications",
        ] {
            if Command::new("open")
                .arg(url)
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
            {
                return Ok(());
            }
        }
        Err("could not open the notification settings".into())
    }
    #[cfg(target_os = "windows")]
    {
        // Same rule as the log: `cmd /C start` flashes a console and exits.
        match document_open(shell_execute(std::ffi::OsStr::new(
            "ms-settings:notifications",
        ))) {
            DocumentOpen::Opened => Ok(()),
            DocumentOpen::NoAssociation | DocumentOpen::Failed(_) => {
                Err("could not open the notification settings".into())
            }
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("gnome-control-center")
            .arg("notifications")
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("could not open the notification settings: {e}"))
    }
}

/// What ShellExecute did with a document.
///
/// A return greater than 32 means the shell opened it. 31 and 27 mean the
/// extension has no program, which is the usual state of a `.log` file.
#[derive(Debug, PartialEq, Eq)]
enum DocumentOpen {
    Opened,
    NoAssociation,
    Failed(isize),
}

fn document_open(shell_execute_code: isize) -> DocumentOpen {
    if shell_execute_code > 32 {
        DocumentOpen::Opened
    } else if shell_execute_code == 31 || shell_execute_code == 27 {
        DocumentOpen::NoAssociation
    } else {
        DocumentOpen::Failed(shell_execute_code)
    }
}

fn open_path(path: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(path).status().map(|_| ())
    }
    #[cfg(target_os = "windows")]
    {
        // `cmd /C start` is a console program, so a GUI build flashes a
        // terminal and the window is gone before anyone can read it. `start`
        // also treats the first quoted argument as a window title, so a path
        // with a space — a normal user-profile path — opens nothing.
        // ShellExecute asks the shell to open the document. When a `.log`
        // file has no association, Notepad is a GUI program that can read it.
        match document_open(shell_execute(path.as_os_str())) {
            DocumentOpen::Opened => Ok(()),
            DocumentOpen::NoAssociation => open_with_notepad(path),
            DocumentOpen::Failed(code) => Err(std::io::Error::other(format!(
                "could not open {}: ShellExecute returned {code}",
                path.display()
            ))),
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(path).status().map(|_| ())
    }
}

#[cfg(target_os = "windows")]
fn shell_execute(file: &std::ffi::OsStr) -> isize {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: *mut core::ffi::c_void,
            verb: *const u16,
            file: *const u16,
            params: *const u16,
            dir: *const u16,
            show: i32,
        ) -> isize;
    }

    fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
        value.encode_wide().chain(Some(0)).collect()
    }

    let file = wide(file);
    let verb = wide(std::ffi::OsStr::new("open"));
    unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    }
}

#[cfg(target_os = "windows")]
fn open_with_notepad(path: &Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    // Notepad is a GUI program. The flag keeps a console from appearing if
    // the lookup ever lands on a console shim.
    Command::new("notepad")
        .arg(path)
        .creation_flags(0x08000000)
        .spawn()
        .map(|_| ())
}

/// Re-inspect the binary without restarting anything. The settings page calls
/// this after the reader picks a path, and on demand when a launch looks wrong.
#[tauri::command]
fn opencode_runtime() -> Result<embed::OpencodeRuntime, String> {
    let data = data_dir();
    let mode = read_mode(&data.join("desktop.json"));
    let runtime = detect_runtime(&data, mode);
    write_runtime(&data.join("opencode-runtime.json"), &runtime)
        .map_err(|e| format!("could not write runtime status: {e}"))?;
    Ok(runtime)
}

/// Save or clear the binary chosen in Settings. It takes effect on the next
/// launch: the running embedded server keeps the binary it was started with.
#[tauri::command]
fn set_opencode_bin(path: Option<String>) -> Result<embed::OpencodeRuntime, String> {
    let data = data_dir();
    embed::write_desktop_bin(&data.join("desktop.json"), path.as_deref())
        .map_err(|e| format!("could not save the opencode path: {e}"))?;
    let mode = read_mode(&data.join("desktop.json"));
    let runtime = detect_runtime(&data, mode);
    write_runtime(&data.join("opencode-runtime.json"), &runtime)
        .map_err(|e| format!("could not write runtime status: {e}"))?;
    Ok(runtime)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            save_export,
            restart_opencode,
            opencode_login,
            open_log_file,
            open_notification_settings,
            opencode_runtime,
            set_opencode_bin,
        ])
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
    use super::{answer_login, auth_scan, open_log, reap, spawn, LoginPipe, Log};
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicU8, Ordering};
    use std::sync::{Arc, Mutex};

    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }

    #[test]
    #[cfg(unix)]
    fn spawned_output_is_written_with_a_timestamp() {
        let path = std::env::temp_dir().join(format!("strata-log-test-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let file = open_log(&path).expect("open log");
        let log: Log = Arc::new(Mutex::new(file));
        let mut child = spawn(
            &std::path::PathBuf::from("/bin/echo"),
            &["hello".to_string()],
            &std::env::temp_dir(),
            &[],
            &log,
        )
        .expect("spawn echo");
        let _ = child.wait();
        // The reader thread and the child's exit are independent; wait for
        // the line instead of guessing how long the pipe needs.
        let mut line = String::new();
        for _ in 0..50 {
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            if let Some(found) = text.lines().find(|line| line.contains("hello")) {
                line = found.to_string();
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(!line.is_empty(), "hello line did not reach the log");
        assert!(line.contains(" | hello"), "missing separator: {line}");
        assert_eq!(line.as_bytes().get(4), Some(&b'-'), "missing date: {line}");
        assert_eq!(line.as_bytes().get(7), Some(&b'-'), "missing date: {line}");
        assert_eq!(line.as_bytes().get(10), Some(&b' '), "missing time: {line}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn prompt_markers_park_the_child_and_a_refusal_stays_up() {
        let stage = Arc::new(AtomicU8::new(0));
        let scan = auth_scan(stage.clone());
        scan(b"listening on http://127.0.0.1:4096");
        assert_eq!(stage.load(Ordering::SeqCst), 0);
        scan("欢迎使用研发工具|xOpenCode\n◇ 请输入域账号:".as_bytes());
        assert_eq!(stage.load(Ordering::SeqCst), 1);
        scan("s000\n◇ 请输入域账号密码:".as_bytes());
        assert_eq!(stage.load(Ordering::SeqCst), 1);
        scan("域账号或密码错误，请重新输入\n◇ 请输入域账号:".as_bytes());
        assert_eq!(stage.load(Ordering::SeqCst), 2);
        // The re-prompt after a refusal does not clear the error — only a
        // fresh answer down the pipe does (answer_login stores 1 itself).
        scan("s000\n◇ 请输入域账号密码:".as_bytes());
        assert_eq!(stage.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_marker_split_across_chunks_is_still_caught() {
        let stage = Arc::new(AtomicU8::new(0));
        let scan = auth_scan(stage.clone());
        scan("请输入".as_bytes());
        scan("域账号:".as_bytes());
        assert_eq!(stage.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn an_upstream_boot_never_parks() {
        let stage = Arc::new(AtomicU8::new(0));
        let scan = auth_scan(stage.clone());
        scan(b"opencode serve\nlistening on http://127.0.0.1:4096\n");
        scan(b"session created\nmessage.updated\n");
        assert_eq!(stage.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn answering_the_prompt_writes_both_lines_and_rearms_the_stage() {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("cat");
        let stage = Arc::new(AtomicU8::new(2));
        let login: Mutex<Option<LoginPipe>> = Mutex::new(Some(LoginPipe {
            stdin: child.stdin.take().expect("stdin"),
            stage: stage.clone(),
        }));
        answer_login(&login, "s000", "hunter2").expect("answer");
        // Dropping the pipe gives cat its EOF, so wait_with_output returns.
        drop(login.into_inner().unwrap());
        let out = child.wait_with_output().expect("wait cat");
        assert_eq!(String::from_utf8_lossy(&out.stdout), "s000\nhunter2\n");
        assert_eq!(stage.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn answering_without_a_parked_prompt_is_an_error() {
        let login: Mutex<Option<LoginPipe>> = Mutex::new(None);
        let err = answer_login(&login, "s000", "hunter2").unwrap_err();
        assert!(err.contains("not waiting"), "unexpected error: {err}");
    }

    #[test]
    fn a_log_without_a_program_is_handed_to_notepad() {
        use super::{document_open, DocumentOpen};
        assert_eq!(document_open(33), DocumentOpen::Opened);
        assert_eq!(document_open(31), DocumentOpen::NoAssociation);
        assert_eq!(document_open(27), DocumentOpen::NoAssociation);
        assert_eq!(document_open(2), DocumentOpen::Failed(2));
    }

    #[test]
    fn opening_the_log_does_not_spawn_a_console() {
        let src = include_str!("main.rs");
        let start = src.find("fn open_path").expect("open_path");
        let body = &src[start..];
        let end = body.find("\nfn ").unwrap_or(body.len());
        let body = &body[..end];
        assert!(
            !body.contains("Command::new(\"cmd\")"),
            "open_path still goes through a console:\n{body}"
        );
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
