/**
 * Repro: the app stops answering input after the reader clicks the
 * auto-accept switch in the composer while a permission ask is on screen.
 *
 * The path, as the reader walks it:
 *   1. a backend raises a permission ask (the ACP mock agent does exactly
 *      that, and the service's own dev_start ask does too)
 *   2. the ask is on screen as a card
 *   3. the reader reaches for "auto accept" in the input area
 *   4. the app stops answering
 *
 * What is measured is not "did it look right" but "did the main thread keep
 * answering": the probe samples one rAF per frame, so a blocked main thread
 * shows up as a gap between frames, and a click that lands but changes nothing
 * shows up as a click with no reaction after it.
 *
 *   bun run bench/repro-autoaccept.ts [--headed] [--no-click] [--out <file>]
 */
import { webkit, type Browser } from "playwright";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { installProbe } from "./probe";
import { startEnv } from "./env";

const HERE = import.meta.dir;
const MOCK = join(HERE, "../../../../packages/adapter-acp/test/fixtures/mock-agent.ts");
const REPO = join(HERE, "../../../..");

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

interface Gap {
  max: number;
  gaps: number[];
}

function frameGaps(samples: { ft: number }[]): Gap {
  const gaps: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i]!.ft - samples[i - 1]!.ft;
    if (d > 0) gaps.push(d);
  }
  gaps.sort((a, b) => a - b);
  return { max: gaps.length ? gaps[gaps.length - 1]! : 0, gaps };
}

async function main() {
  const logs: string[] = [];
  const env = await startEnv({ build: "prod", log: (l) => logs.push(l) });
  const base = env.serviceUrl;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  let browser: Browser | undefined;
  const out: Record<string, unknown> = {};
  try {
    // 1. A backend that asks. The mock agent raises a real ACP permission
    //    request; the service's dev_start ask is the other way the same card
    //    reaches the reader.
    const connected = (await (await post("/connect", {
      backend: "acp",
      command: process.execPath,
      args: [MOCK],
      agentName: "mock",
      cwd: REPO,
      directory: REPO,
      policy: { version: 1, default: "ask", rules: [] },
    })).json()) as { id: string };
    const created = (await (await post("/sessions", {
      connection_id: connected.id,
      directory: REPO,
    })).json()) as { id: string };
    out.session = created.id;

    // 2. The ask. /dev blocks on the reader's answer, so it is left running.
    // The ask blocks on the reader's answer, so the request is left running.
    void post("/dev", { session_id: created.id, command: "sleep 30" }).catch(() => undefined);
    let ask: { request_id: string } | undefined;
    for (let i = 0; i < 200 && !ask; i++) {
      const pending = (await (await fetch(`${base}/permissions`, {
        headers: { authorization: `Bearer ${env.token}` },
      })).json()) as { pending: { request_id: string }[] };
      ask = pending.pending[0];
      if (!ask) await Bun.sleep(50);
    }
    if (!ask) throw new Error("no permission ask was raised");
    out.ask = ask.request_id;

    // 3. The reader's window.
    browser = await webkit.launch({ headless: !has("--headed") });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      locale: "en-US",
    });
    await context.addInitScript(installProbe);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${env.uiUrl}/#/session/${encodeURIComponent(created.id)}`);
    // The card the reader reaches for.
    await page.getByText(/sleep 30|dev_start/).first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1500);

    const toggle = page.getByLabel(/本会话自动接受|Auto-accept/).first();
    const buttons = await page.evaluate(() =>
      [...document.querySelectorAll("button")].map((b) => ({
        aria: b.getAttribute("aria-label"),
        title: b.getAttribute("title"),
        text: (b.textContent ?? "").trim().slice(0, 40),
        pressed: b.getAttribute("aria-pressed"),
      })),
    );
    out.buttons = buttons;
    const before = await page.evaluate(() => (window as any).__bench.now() as number);
    const base0 = await page.evaluate((f) => (window as any).__bench.take(f) as any, before);

    if (has("--no-click")) {
      await page.waitForTimeout(6000);
    } else {
      // 4. The click.
      const t0 = Date.now();
      try {
        await toggle.click({ timeout: 10_000 });
        out.clickMs = Date.now() - t0;
      } catch (e) {
        out.clickError = String(e);
        await page.screenshot({ path: `${HERE}/results/repro-no-toggle.png` }).catch(() => undefined);
        out.pageText = (await page.evaluate(() => document.body.innerText.slice(0, 2000))) as string;
      }

      // How long until the switch says it is on: the reader's own read moves
      // first, so this is the UI acknowledging the click, not the service.
      const flipped = await Promise.race([
        page
          .waitForFunction(
            () => document.querySelector('[aria-label="本会话自动接受"]')?.getAttribute("aria-pressed") === "true",
            undefined,
            { timeout: 15_000 },
          )
          .then(() => "flipped")
          .catch(() => "never flipped"),
        Bun.sleep(15_000).then(() => "timeout"),
      ]);
      out.switch = flipped;
      await page.waitForTimeout(6000);
    }

    const after = await page.evaluate((f) => (window as any).__bench.take(f) as any, before);
    const gaps = frameGaps(after.samples as { ft: number }[]);
    // The main thread, asked directly: how long does it take to answer?
    const t1 = Date.now();
    await page.evaluate(() => 1).catch(() => undefined);
    out.mainThreadMs = Date.now() - t1;
    out.frames = after.samples.length;
    out.maxGapMs = Math.round(gaps.max);
    out.gapsOver200 = gaps.gaps.filter((g) => g > 200).length;
    out.gapsOver1000 = gaps.gaps.filter((g) => g > 1000).length;
    out.clicks = after.clicks.length;
    out.errors = errors;
    out.longtasks = after.longtasks;
    void base0;

    // And: is the app still answering? A click on something unrelated has to
    // change something within half a second.
    const probe = page.getByLabel(/会话详情|Session info/).first();
    const hasProbe = (await probe.count()) > 0;
    if (hasProbe) {
      const t2 = Date.now();
      await probe.click({ timeout: 5000 }).catch((e) => out.probeError = String(e));
      out.probeMs = Date.now() - t2;
      out.probeOpen = await page
        .waitForFunction(
          () => !!document.querySelector('[role="dialog"], [data-state="open"]'),
          undefined,
          { timeout: 3000 },
        )
        .then(() => true)
        .catch(() => false);
    }

    const file = val("out") ?? `${HERE}/results/repro-autoaccept.json`;
    writeFileSync(file, JSON.stringify({ out, gaps: gaps.gaps.slice(-40) }, null, 2));
    console.log(JSON.stringify(out, null, 2));
    console.log(`report: ${file}`);
  } finally {
    await browser?.close();
    await env.stop();
    if (logs.length) writeFileSync(`${HERE}/results/repro-autoaccept.log`, logs.join("\n"));
  }
}

await main();
