// Isolated bench environment: a throwaway copy of a store, the service on a
// free port pointed at it, and the UI dev server proxying to that service.
//
// Nothing here touches the user's real state: the database is copied into a
// fresh temp dir (an online backup for a live WAL store), HOME is redirected
// so the service's desktop directory and policy file land in the temp dir
// too, and remembered-connection sidecars like connections.json never reach
// the copy — so boot does not dial the user's real backends. stop() kills
// both process trees and removes the temp dir.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { buildFixtureDb, FIXTURE_SESSIONS } from "./fixtures";

export interface BenchSessions {
  long: string;
  heavy: string;
  small: string[];
}

export interface BenchEnv {
  uiUrl: string; // e.g. http://127.0.0.1:5191  (page: `${uiUrl}/#/session/${encodeURIComponent(id)}`)
  serviceUrl: string; // direct service URL, for node-side fetches
  token: string; // bearer token the service expects
  sessions: BenchSessions;
  stop(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(here, "..");
const SERVICE_DIR = join(here, "../../../../packages/service");

const log0 = (_line: string) => {};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Lines of a child process's stdout/stderr, forwarded to the bench log. */
function pipeLogs(proc: ChildProcess, tag: string, log: (line: string) => void): void {
  for (const stream of [proc.stdout, proc.stderr]) {
    if (!stream) continue;
    let buf = "";
    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        log(`[${tag}] ${buf.slice(0, nl)}`);
        buf = buf.slice(nl + 1);
      }
    });
    stream.on("end", () => {
      if (buf.trim()) log(`[${tag}] ${buf.trimEnd()}`);
    });
  }
}

/** Kill a spawned process and anything it spawned, TERM first then KILL. */
function killTree(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const bail = setTimeout(() => {
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
      resolve();
    }, 4_000);
    bail.unref?.();
    proc.once("exit", () => {
      clearTimeout(bail);
      resolve();
    });
    try {
      if (proc.pid) process.kill(-proc.pid, "SIGTERM");
      else proc.kill("SIGTERM");
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
  });
}

interface Spawned {
  proc: ChildProcess;
  stop(): Promise<void>;
}

function spawnLogged(
  cmd: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; tag: string; log: (line: string) => void },
): Spawned {
  const proc = spawn(cmd[0]!, cmd.slice(1), {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    // own process group: `bun run` can wrap the real server in a child, and
    // stopping the wrapper alone would leave the port held behind it
    detached: true,
  });
  pipeLogs(proc, opts.tag, opts.log);
  return { proc, stop: () => killTree(proc) };
}

async function waitUp(
  url: string,
  spawned: Spawned,
  what: string,
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (spawned.proc.exitCode !== null || spawned.proc.signalCode !== null) {
      throw new Error(`${what} exited (code ${spawned.proc.exitCode ?? spawned.proc.signalCode}) before becoming ready`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`${what} did not come up at ${url} within ${timeoutMs}ms`);
    await Bun.sleep(150);
  }
}

/**
 * Copy a live store without writing to it: VACUUM INTO is SQLite's online
 * backup — it reads the source under a normal read snapshot while another
 * process may still be writing, and produces one complete file.
 */
function copyDbOnline(src: string, dest: string): void {
  if (!existsSync(src)) throw new Error(`store not found: ${src}`);
  mkdirSync(dirname(dest), { recursive: true });
  const escaped = dest.replace(/'/g, "''");
  try {
    const ro = new Database(src, { readonly: true });
    try {
      ro.exec(`VACUUM INTO '${escaped}'`);
    } finally {
      ro.close();
    }
  } catch (readonlyErr) {
    // Some SQLite builds refuse VACUUM INTO on a read-only handle. Opening
    // read-write and only ever reading still never writes to the source.
    try {
      const rw = new Database(src);
      try {
        rw.exec(`VACUUM INTO '${escaped}'`);
      } finally {
        rw.close();
      }
    } catch {
      throw readonlyErr;
    }
  }
}

export async function startEnv(opts?: {
  db?: string; // a real store to benchmark instead of fixtures (e.g. ~/.agent-strata/events.db)
  sessions?: Partial<BenchSessions>; // required with db
  log?: (line: string) => void;
}): Promise<BenchEnv> {
  const log = opts?.log ?? log0;
  if (opts?.db && !opts.sessions) {
    throw new Error("startEnv: opts.sessions is required when opts.db names a real store");
  }
  const sessions: BenchSessions = opts?.db
    ? {
        long: opts.sessions!.long!,
        heavy: opts.sessions!.heavy!,
        small: opts.sessions!.small ?? [],
      }
    : { long: FIXTURE_SESSIONS.long, heavy: FIXTURE_SESSIONS.heavy, small: [...FIXTURE_SESSIONS.small] };

  const root = mkdtempSync(join(tmpdir(), "strata-bench-"));
  const tmpDb = join(root, "events.db");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });

  const started: Spawned[] = [];
  let shimServer: { stop(): void } | undefined;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await Promise.all(started.map((s) => s.stop().catch(() => {})));
    shimServer?.stop();
    rmSync(root, { recursive: true, force: true });
  };

  try {
    if (opts?.db) {
      log(`[env] copying store ${opts.db} -> ${tmpDb}`);
      copyDbOnline(opts.db, tmpDb);
    } else {
      const info = buildFixtureDb(tmpDb);
      log(
        `[env] fixture store ${tmpDb}: ${info.sessions.map((s) => `${s.id.split(":").pop()}=${s.turns}t/${s.bytes}B`).join(" ")}`,
      );
    }

    const token = randomBytes(24).toString("hex");
    const servicePort = await freePort();
    const uiPort = await freePort();
    const serviceUrl = `http://127.0.0.1:${servicePort}`;
    const uiUrl = `http://127.0.0.1:${uiPort}`;
    const bun = Bun.which("bun") ?? "bun";

    const serviceEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      STRATA_DB: tmpDb,
      STRATA_PORT: String(servicePort),
      STRATA_API_TOKEN: token,
      STRATA_DESKTOP_DIR: join(root, "desktop"),
      STRATA_POLICY: join(root, "policy.json"),
    };
    // Any auto-connect address inherited from the caller's environment would
    // dial a real backend; the bench store must stay the only thing on screen.
    delete serviceEnv.STRATA_OPENCODE_URL;
    delete serviceEnv.STRATA_OPENCODE_USERNAME;
    delete serviceEnv.STRATA_OPENCODE_PASSWORD;
    delete serviceEnv.STRATA_OPENCODE_PLACEMENT;

    log(`[env] service: bun run src/index.ts (port ${servicePort}, db ${tmpDb})`);
    const svc = spawnLogged([bun, "run", "src/index.ts"], {
      cwd: SERVICE_DIR,
      env: serviceEnv,
      tag: "service",
      log,
    });
    started.push(svc);
    await waitUp(`${serviceUrl}/health`, svc, "service");

    // The service refuses a page whose Origin is not the shell's own
    // (tauri.localhost, or the dev port 5178). A bench UI runs on a random
    // port, and the browser stamps that port as the Origin of every POST,
    // so the vite /api proxy forwards to this shim, which rewrites the
    // Origin to the sanctioned dev origin on the way to the real service.
    // WebSocket upgrades are not forwarded (the bench never opens a terminal).
    const shim = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      // `/stream` is a long-lived response; the default 10s idle timeout cuts it.
      idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const headers = new Headers(req.headers);
        for (const hop of [
          "host",
          "connection",
          "content-length",
          "keep-alive",
          "transfer-encoding",
          "upgrade",
        ]) {
          headers.delete(hop);
        }
        headers.set("origin", "http://127.0.0.1:5178");
        return fetch(`${serviceUrl}${url.pathname}${url.search}`, {
          method: req.method,
          headers,
          body: req.body,
          redirect: "manual",
        } as RequestInit);
      },
    });
    const shimUrl = `http://127.0.0.1:${shim.port}`;
    shimServer = shim;
    log(`[env] origin shim: ${shimUrl} -> ${serviceUrl}`);

    log(`[env] ui: bunx vite --port ${uiPort} --strictPort`);
    const vite = spawnLogged(
      [bun, "x", "vite", "--host", "127.0.0.1", "--port", String(uiPort), "--strictPort"],
      {
        cwd: UI_DIR,
        env: {
          ...process.env,
          STRATA_SERVICE_URL: shimUrl,
          STRATA_API_TOKEN: token,
        },
        tag: "ui",
        log,
      },
    );
    started.push(vite);
    await waitUp(uiUrl, vite, "vite dev server");

    return { uiUrl, serviceUrl, token, sessions, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}
