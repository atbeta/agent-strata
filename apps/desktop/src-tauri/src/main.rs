// Agent Strata desktop shell.
//
// Spawns sidecar processes and hands the webview the UI:
//   1. `bun run packages/service` — the strata service (port 7700), which owns
//      the event-log store, adapter connections, and the HTTP/SSE API the UI
//      talks to.
//   2. `opencode serve` — the agent backend (port 4096), only when
//      STRATA_OPENCODE_EMBED=1; otherwise the app attaches to an already
//      running instance via the service /connect endpoint.
// Sidecars are killed when the app exits.

use std::process::{Child, Command, Stdio};

struct Sidecars(Vec<Child>);

impl Sidecars {
    fn spawn(bin: &str, args: &[&str], cwd: Option<&str>, envs: &[(&str, String)]) -> Option<Child> {
        let mut cmd = Command::new(bin);
        cmd.args(args)
            .envs(envs.iter().map(|(k, v)| (*k, v.clone())))
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        match cmd.spawn() {
            Ok(c) => Some(c),
            Err(e) => {
                eprintln!("spawn {bin} failed: {e}");
                None
            }
        }
    }

    fn start() -> Self {
        let mut children = Vec::new();

        let service_dir =
            std::env::var("STRATA_SERVICE_DIR").unwrap_or_else(|_| "../../packages/service".into());
        let db = std::env::var("STRATA_DB").unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            format!("{home}/.agent-strata/events.db")
        });

        if let Some(c) = Self::spawn(
            "bun",
            &["run", "src/index.ts"],
            Some(&service_dir),
            &[("STRATA_DB", db), ("STRATA_PORT", "7700".into())],
        ) {
            children.push(c);
        }

        if std::env::var("STRATA_OPENCODE_EMBED").as_deref() == Ok("1") {
            if let Some(c) = Self::spawn("opencode", &["serve", "--port", "4096"], None, &[]) {
                children.push(c);
            }
        }

        Sidecars(children)
    }
}

impl Drop for Sidecars {
    fn drop(&mut self) {
        for mut c in self.0.drain(..) {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|_app| {
            let sidecars = Sidecars::start();
            // Leaked intentionally: sidecars live for the whole app lifetime
            // and are reaped when the process exits.
            std::mem::forget(sidecars);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running agent-strata");
}
