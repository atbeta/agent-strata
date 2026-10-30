/**
 * Where the time goes: a JS CPU profile of each bench step.
 *
 *   bun run bench/profile.ts                 flows A and B, production build
 *   bun run bench/profile.ts --flows A --dev
 *
 * Chromium only — WebKit exposes no profiler to Playwright. Use it to find
 * what a change should target, then judge the change with `bun run bench` in
 * WebKit. Profiles are written as .cpuprofile files (open them in Chrome
 * DevTools' Performance panel) next to a printed summary of the heaviest
 * functions by self and by inclusive time.
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startEnv } from "./env";
import { installProbe } from "./probe";
import { jump, openCold, stepUp, wheelUp, type FlowContext } from "./scenarios";

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}
interface Profile {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas: number[];
}

const IGNORED = new Set(["(idle)", "(program)", "(root)"]);

const label = (n: ProfileNode) => {
  const file = (n.callFrame.url.split("/").pop() || "native").split("?")[0];
  return `${n.callFrame.functionName || "(anon)"} @ ${file}:${n.callFrame.lineNumber + 1}`;
};

export function summarize(profile: Profile, top = 20): string {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const selfById = new Map<number, number>();
  profile.samples.forEach((id, i) => selfById.set(id, (selfById.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000));
  const self = new Map<string, number>();
  const incl = new Map<string, number>();
  let total = 0;
  for (const [id, ms] of selfById) {
    const n = byId.get(id)!;
    if (IGNORED.has(n.callFrame.functionName)) continue;
    total += ms;
    self.set(label(n), (self.get(label(n)) ?? 0) + ms);
    // Inclusive: every distinct function on the stack, once.
    const seen = new Set<string>();
    for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
      const node = byId.get(cur)!;
      if (IGNORED.has(node.callFrame.functionName)) continue;
      const k = label(node);
      if (seen.has(k)) continue;
      seen.add(k);
      incl.set(k, (incl.get(k) ?? 0) + ms);
    }
  }
  const list = (m: Map<string, number>) =>
    [...m]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([k, v]) => `  ${v.toFixed(1).padStart(7)}ms  ${k}`)
      .join("\n");
  return `${total.toFixed(0)}ms of JS\n self:\n${list(self)}\n inclusive:\n${list(incl)}`;
}

const argv = process.argv.slice(2);
const flowsAt = argv.indexOf("--flows");
const flows = (flowsAt >= 0 ? argv[flowsAt + 1]! : "A,B").split(",");
const build = argv.includes("--dev") ? "dev" : "prod";

const env = await startEnv({ build });
const browser = await chromium.launch();
const out = join(import.meta.dir, "results", "profiles", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(out, { recursive: true });
try {
  const S = env.sessions;
  const orders = new Map<string, string[]>();
  for (const id of [S.long, S.heavy]) {
    const res = await fetch(`${env.serviceUrl}/sessions/${encodeURIComponent(id)}/view`, {
      headers: { authorization: `Bearer ${env.token}` },
    });
    orders.set(id, ((await res.json()) as { turns: { turn_id: string }[] }).turns.map((t) => t.turn_id));
  }
  for (const flow of flows) {
    const sid = flow === "A" ? S.long : S.heavy;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "en-US" });
    await context.addInitScript(installProbe);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    const ctx: FlowContext = { page, uiUrl: env.uiUrl, orders, errors: [], emit: env.emit };
    const step = async (name: string, run: () => Promise<unknown>) => {
      await cdp.send("Profiler.start");
      await run();
      const { profile } = await cdp.send("Profiler.stop");
      writeFileSync(join(out, `${flow}-${name}.cpuprofile`), JSON.stringify(profile));
      console.log(`\n### ${flow}/${name}: ${summarize(profile as Profile)}`);
    };
    await step("open", () => openCold(ctx, "open", sid));
    await step("step-up", () => stepUp(ctx, "step-up", 6_000, 120));
    if (flow === "A") await step("wheel-up", () => wheelUp(ctx, "wheel-up", 6_000, 100));
    await step("jump", () => jump(ctx, "jump", sid, flow === "A" ? 0.25 : 0.5));
    await context.close();
  }
} finally {
  await browser.close();
  await env.stop();
}
console.log(`\nprofiles: ${out}  (build: ${build})`);
