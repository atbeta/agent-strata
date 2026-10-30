/**
 * Transcript bench: replays a reader's journeys through long sessions in real
 * engines and reports what they cost and whether they went right.
 *
 *   bun run bench                         fixtures, webkit + chromium, 3 reps
 *   bun run bench --engines webkit --reps 5
 *   bun run bench --compare bench/results/<file>.json
 *   bun run bench --dev                   against the Vite dev server instead of a production build
 *   bun run bench --db ~/.agent-strata/events.db --long <id> --heavy <id> --small <id>,<id>,<id>
 *
 * WebKit is the engine the desktop app ships in (Tauri on macOS is WKWebView),
 * so it is the one that decides. Chromium is there because that is where every
 * earlier measurement in this repo was taken.
 *
 * The UI under test is a production build by default: the dev server runs
 * Solid's dev build and an HMR wrapper around every component, which a CPU
 * profile of an open showed as a large share of the time spent.
 *
 * Exits non-zero when any correctness check failed.
 */
import { chromium, webkit, type Browser, type BrowserType } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installProbe } from "./probe";
import { median } from "./metrics";
import { FLOWS, type FlowContext, type FlowSessions, type Metric, type StepResult } from "./scenarios";
import { startEnv } from "./env";
import { FIXTURE_VERSION } from "./fixtures";

const ENGINES: Record<string, BrowserType> = { webkit, chromium };

function args() {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    engines: (get("engines") ?? "webkit,chromium").split(","),
    reps: Number(get("reps") ?? 3),
    flows: (get("flows") ?? "A,B,C").split(","),
    headed: a.includes("--headed"),
    compare: get("compare"),
    out: get("out"),
    db: get("db"),
    long: get("long"),
    heavy: get("heavy"),
    small: get("small"),
    verbose: a.includes("--verbose"),
    build: (a.includes("--dev") ? "dev" : "prod") as "dev" | "prod",
  };
}

const FLOW_TIMEOUT_MS = 180_000;

function within<T>(ms: number, message: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const sh = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd: import.meta.dir });
  return r.stdout.toString().trim();
};

interface RunRecord {
  engine: string;
  rep: number;
  flow: string;
  steps: StepResult[];
  /** Set when the flow could not finish; later steps are missing. */
  aborted?: string;
}

interface Report {
  meta: Record<string, unknown>;
  runs: RunRecord[];
  /** engine → "flow/step" → metric → median across reps */
  summary: Record<string, Record<string, Record<string, number>>>;
  failures: string[];
}

/** Metrics printed in the table, in this order; the JSON keeps all of them. */
const SHOWN = [
  "settleMs",
  "firstContentMs",
  "firstCorrectMs",
  "maxGap",
  "over50",
  "blockedMs",
  "longtaskMs",
  "appWrites",
  "partials",
  "driftMax",
  "driftOver2",
  "staleMs",
  "blankBefore",
  "blankAfter",
  "firstMoveMs",
  "landingError",
  "placeError",
  "roLoops",
];

function summarise(runs: RunRecord[]): Report["summary"] {
  const acc: Record<string, Record<string, Record<string, number[]>>> = {};
  for (const run of runs) {
    for (const step of run.steps) {
      const key = `${run.flow}/${step.name}`;
      const slot = ((acc[run.engine] ??= {})[key] ??= {});
      for (const [m, v] of Object.entries(step.metrics)) {
        if (typeof v === "number" && Number.isFinite(v)) (slot[m] ??= []).push(v);
        else if (typeof v === "boolean") (slot[m] ??= []).push(v ? 1 : 0);
      }
    }
  }
  const out: Report["summary"] = {};
  for (const [engine, steps] of Object.entries(acc)) {
    out[engine] = {};
    for (const [key, metrics] of Object.entries(steps)) {
      out[engine]![key] = Object.fromEntries(Object.entries(metrics).map(([m, xs]) => [m, median(xs)]));
    }
  }
  return out;
}

const fmt = (n: number | undefined) => (n === undefined || Number.isNaN(n) ? "-" : n >= 100 ? n.toFixed(0) : n.toFixed(1));

function print(summary: Report["summary"], base?: Report["summary"]) {
  for (const [engine, steps] of Object.entries(summary)) {
    console.log(`\n## ${engine}${base ? "  (current / baseline / Δ%)" : "  (median across reps)"}`);
    const cols = SHOWN.filter((m) => Object.values(steps).some((s) => m in s));
    const rows = Object.entries(steps).map(([key, s]) => [
      key,
      ...cols.map((m) => {
        const cur = s[m];
        const was = base?.[engine]?.[key]?.[m];
        if (!base) return fmt(cur);
        const pct = was && cur !== undefined ? `${(((cur - was) / was) * 100).toFixed(0)}%` : "";
        return `${fmt(cur)}/${fmt(was)}${pct ? ` ${pct}` : ""}`;
      }),
    ]);
    const head = ["step", ...cols];
    const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
    const line = (r: string[]) => r.map((c, i) => c.padEnd(width[i]!)).join("  ");
    console.log(line(head));
    for (const r of rows) console.log(line(r));
  }
}

async function main() {
  const opt = args();
  const real = !!opt.db;
  if (real && (!opt.long || !opt.heavy || !opt.small)) throw new Error("--db needs --long, --heavy and --small");
  const logs: string[] = [];
  const env = await startEnv({
    build: opt.build,
    db: opt.db,
    sessions: real ? { long: opt.long!, heavy: opt.heavy!, small: opt.small!.split(",") } : undefined,
    running: opt.flows.includes("D"),
    log: (l) => (opt.verbose ? console.error(l) : logs.push(l)),
  });
  const failures: string[] = [];
  const runs: RunRecord[] = [];
  const orders = new Map<string, string[]>();
  try {
    const sessions: FlowSessions = env.sessions;
    for (const id of new Set([sessions.long, sessions.heavy, ...sessions.small])) {
      const res = await fetch(`${env.serviceUrl}/sessions/${encodeURIComponent(id)}/view`, {
        headers: { authorization: `Bearer ${env.token}` },
      });
      if (!res.ok) throw new Error(`view ${id}: ${res.status}`);
      const view = (await res.json()) as { turns: { turn_id: string }[] };
      orders.set(id, view.turns.map((t) => t.turn_id));
    }

    for (const engine of opt.engines) {
      const type = ENGINES[engine];
      if (!type) throw new Error(`unknown engine ${engine}`);
      const browser: Browser = await type.launch({ headless: !opt.headed });
      try {
        for (let rep = 0; rep < opt.reps; rep++) {
          for (const flow of opt.flows) {
            const run = FLOWS[flow];
            if (!run) throw new Error(`unknown flow ${flow}`);
            // A fresh context per flow: every module-level cache in the app
            // (views, row heights, rendered markdown) starts cold.
            const context = await browser.newContext({
              viewport: { width: 1440, height: 900 },
              deviceScaleFactor: 2,
              locale: "en-US",
            });
            await context.addInitScript(installProbe);
            const page = await context.newPage();
            const ctx: FlowContext = { page, uiUrl: env.uiUrl, orders, errors: [], emit: env.emit };
            // WebKit hands some errors over with an empty name and stack; the message is what is left.
            page.on("pageerror", (e) => ctx.errors.push([e.message, e.stack].filter(Boolean).join("\n") || String(e)));
            const record: RunRecord = { engine, rep, flow, steps: [] };
            runs.push(record);
            try {
              // A browser that dies mid-flow can leave a Playwright call waiting
              // forever; no flow takes anywhere near this long when it works.
              await within(
                FLOW_TIMEOUT_MS,
                `flow did not finish within ${FLOW_TIMEOUT_MS / 1000}s`,
                run(ctx, sessions, (r) => {
                  record.steps.push(r);
                  for (const f of r.failures) failures.push(`${engine} rep${rep} ${flow}/${r.name}: ${f}`);
                }),
              );
            } catch (e) {
              record.aborted = String((e as Error)?.message ?? e);
              failures.push(`${engine} rep${rep} ${flow}: aborted after ${record.steps.length} steps: ${record.aborted}`);
            } finally {
              await within(10_000, "context close timed out", context.close()).catch(() => {});
            }
            console.error(`${engine} rep${rep} ${flow}: ${record.steps.length} steps${record.aborted ? " (aborted)" : ""}`);
          }
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    await env.stop();
  }

  const summary = summarise(runs);
  const date = new Date().toISOString();
  const sha = sh(["git", "rev-parse", "--short", "HEAD"]);
  const report: Report = {
    meta: {
      sha,
      dirty: sh(["git", "status", "--porcelain"]).length > 0,
      date,
      mode: real ? "real" : `fixtures-v${FIXTURE_VERSION}`,
      build: opt.build,
      turns: Object.fromEntries([...orders].map(([id, o]) => [id, o.length])),
      engines: opt.engines,
      reps: opt.reps,
      flows: opt.flows,
      headed: opt.headed,
      viewport: "1440x900@2x",
      bun: Bun.version,
    },
    runs,
    summary,
    failures,
  };
  const dir = join(import.meta.dir, "results");
  mkdirSync(dir, { recursive: true });
  const out = opt.out ?? join(dir, `${date.replace(/[:.]/g, "-")}-${sha}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  if (logs.length) writeFileSync(out.replace(/\.json$/, ".log"), logs.join("\n"));

  const base = opt.compare ? (JSON.parse(readFileSync(opt.compare, "utf8")) as Report).summary : undefined;
  print(summary, base);
  console.log(`\n${failures.length ? `${failures.length} correctness failures:` : "no correctness failures"}`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log(`\nreport: ${out}`);
  process.exit(failures.length ? 1 : 0);
}

await main();
