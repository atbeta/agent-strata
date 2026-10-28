import type { Page } from "playwright";
import {
  appWrites,
  drift,
  frameStats,
  jumpStats,
  openStats,
  placeError,
  placeOf,
  switchStats,
  type Place,
  type Recording,
} from "./metrics";

/**
 * The reader's journeys the bench replays, and what each one must get right.
 *
 * `failures` are correctness: things a reader has reported and a release has
 * claimed to fix. They fail the run. Everything in `metrics` is quality, read
 * against a baseline rather than a threshold.
 */

export type Metric = number | boolean | null;

export interface StepResult {
  name: string;
  failures: string[];
  metrics: Record<string, Metric>;
}

export interface FlowContext {
  page: Page;
  uiUrl: string;
  /** Turn ids of each session, in order, as the service projects them. */
  orders: ReadonlyMap<string, readonly string[]>;
  /** Page errors raised since the current step began; drained by each step. */
  errors: string[];
}

type Settled = { settled: boolean; at: number };

/** Allowed distance between where a row should be and where it is. */
const PLACE_TOLERANCE = 24;
/** A click that has not moved the transcript by now reads as an unresponsive window. */
const CLICK_RESPONSE_MS = 500;
/** The old conversation may outlive the route change by about a frame or two. */
const STALE_MS = 150;

const bench = (page: Page) => ({
  now: () => page.evaluate(() => (window as any).__bench.now() as number),
  setTarget: (ids: readonly string[] | null) =>
    page.evaluate((x) => (window as any).__bench.setTarget(x), ids ? [...ids] : null),
  async settle(notBefore: number, quiet: number, cap: number): Promise<Settled> {
    const inPage = page.evaluate(
      ([q, c, n]) => (window as any).__bench.waitSettled(q, c, n) as Promise<Settled>,
      [quiet, cap, notBefore] as const,
    );
    // The page's own cap needs frames to run. A main thread that never frees
    // again would leave the evaluate hanging, so the bench keeps its own.
    const guard = new Promise<Settled>((_, reject) =>
      setTimeout(() => reject(new Error(`page produced no frames for ${cap + 5000}ms`)), cap + 5000),
    );
    return Promise.race([inPage, guard]);
  },
  take: (from: number) => page.evaluate((f) => (window as any).__bench.take(f) as Recording, from),
  stepUp: (total: number, step: number) =>
    page.evaluate(([t, s]) => (window as any).__bench.stepUp(t, s) as Promise<void>, [total, step] as const),
  box: () =>
    page.evaluate(
      () => (window as any).__bench.scrollerBox() as { x: number; y: number; width: number; height: number } | null,
    ),
});

const hashFor = (id: string) => `/session/${encodeURIComponent(id)}`;

function orderOf(ctx: FlowContext, id: string): readonly string[] {
  const o = ctx.orders.get(id);
  if (!o?.length) throw new Error(`no turns known for ${id}`);
  return o;
}

function common(rec: Recording, from: number, to: number, r: Settled): Record<string, Metric> {
  const f = frameStats(rec.samples, from, to);
  const w = appWrites(rec.writes, from, to);
  const lt = rec.longtasks.filter((x) => x.t >= from && x.t <= to);
  return {
    settled: r.settled,
    settleMs: r.at - from,
    frames: f.frames,
    maxGap: f.maxGap,
    p95Gap: f.p95Gap,
    over50: f.over50,
    over100: f.over100,
    blockedMs: f.blockedMs,
    appWrites: w.count,
    appWritePx: w.movedPx,
    longtaskMs: lt.length ? lt.reduce((n, x) => n + x.d, 0) : null,
  };
}

/**
 * A resize observer whose callback changed layout enough to need another
 * round in the same frame. Not a crash: the browser drops the extra round and
 * says so. It is how often the list's measuring fights its own layout, so it
 * is counted rather than failed.
 */
const RO_LOOP = /ResizeObserver loop/;

function finish(ctx: FlowContext, name: string, metrics: Record<string, Metric>, failures: string[]): StepResult {
  const errors = ctx.errors.splice(0);
  metrics.roLoops = errors.filter((e) => RO_LOOP.test(e)).length;
  for (const e of errors) if (!RO_LOOP.test(e)) failures.push(`page error: ${e}`);
  if (metrics.settled === false) failures.push("did not settle");
  return { name, metrics, failures };
}

/** A fresh page opened straight onto a session: the cold open. */
export async function openCold(ctx: FlowContext, name: string, id: string): Promise<StepResult> {
  const b = bench(ctx.page);
  const order = orderOf(ctx, id);
  await ctx.page.goto(`${ctx.uiUrl}/#${hashFor(id)}`);
  await b.setTarget(order);
  // With no backend connected the app stops at its startup gate, and the
  // transcript only mounts once the reader enters with local history. The
  // open is timed from that click: what came before it is the gate, not the
  // transcript.
  const gate = ctx.page.getByRole("button", { name: /enter with local history only|仅本地历史/i });
  const rows = ctx.page.locator("[data-transcript-scroller] [data-turn-id]").first();
  await Promise.race([gate.waitFor({ timeout: 20_000 }), rows.waitFor({ timeout: 20_000 })]);
  let from = 0;
  if (await gate.isVisible()) {
    const before = await b.now();
    await gate.click();
    from = (await b.take(before)).clicks[0] ?? before;
  }
  const r = await b.settle(from, 800, 20_000);
  const rec = await b.take(0);
  const o = openStats(rec.samples, order, from, r.at);
  const failures: string[] = [];
  if (!o.atTail) failures.push("did not open on the latest turn");
  if (o.headShown) failures.push(`painted turn ${o.minIndexShown} of ${order.length} on the way to the tail`);
  if (o.blankFrames > 0) failures.push(`${o.blankFrames} blank frames after content appeared`);
  return finish(ctx, name, { ...common(rec, from, r.at, r), gated: from > 0, ...o }, failures);
}

/** Scroll up at a steady rate the bench controls, so drift can be measured exactly. */
export async function stepUp(ctx: FlowContext, name: string, total: number, step: number): Promise<StepResult> {
  const b = bench(ctx.page);
  const t0 = await b.now();
  await b.stepUp(total, step);
  const t1 = await b.now();
  const r = await b.settle(t1, 500, 8_000);
  const rec = await b.take(t0);
  const d = drift(rec.samples, t0, r.at);
  return finish(
    ctx,
    name,
    {
      ...common(rec, t0, r.at, r),
      gestureMs: t1 - t0,
      driftFrames: d.frames,
      driftMax: d.maxAbs,
      driftSum: d.sumAbs,
      driftOver2: d.over2,
    },
    [],
  );
}

/** Scroll up with real wheel input, through the browser's own scrolling path. */
export async function wheelUp(ctx: FlowContext, name: string, total: number, step: number): Promise<StepResult> {
  const b = bench(ctx.page);
  const box = await b.box();
  if (!box) throw new Error("no transcript scroller");
  await ctx.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const t0 = await b.now();
  for (let done = 0; done < total; done += step) {
    await ctx.page.mouse.wheel(0, -step);
    await ctx.page.waitForTimeout(16);
  }
  const t1 = await b.now();
  const r = await b.settle(t1, 500, 8_000);
  const rec = await b.take(t0);
  const first = rec.samples[0];
  const last = rec.samples.at(-1);
  return finish(
    ctx,
    name,
    { ...common(rec, t0, r.at, r), gestureMs: t1 - t0, scrolledPx: first && last ? first.st - last.st : null },
    [],
  );
}

/** Click a prompt in the outline and land on it. */
export async function jump(ctx: FlowContext, name: string, id: string, fraction: number): Promise<StepResult> {
  const b = bench(ctx.page);
  const order = orderOf(ctx, id);
  // The rail is windowed like the transcript: only the ticks near its own
  // scroll position exist. Move it to the fraction's position the way a
  // reader would — scroll the rail, then click a mounted tick.
  const rail = ctx.page.locator(".prompt-nav .rail");
  await rail.evaluate((el, f) => {
    el.scrollTop = Math.max(0, el.scrollHeight * f - el.clientHeight / 2);
  }, fraction);
  await ctx.page.waitForFunction(
    () => document.querySelectorAll(".prompt-nav .nav-tick[data-turn-id]").length > 0,
  );
  const ticks = ctx.page.locator(".prompt-nav .nav-tick[data-turn-id]");
  const count = await ticks.count();
  if (count < 2) throw new Error(`outline has ${count} prompts`);
  const tick = ticks.nth(Math.floor(count / 2));
  const target = (await tick.getAttribute("data-turn-id"))!;
  if (!order.includes(target)) throw new Error(`outline prompt ${target} is not a turn of ${id}`);
  const t0 = await b.now();
  await tick.click();
  const clicked = (await b.take(t0)).clicks[0] ?? t0;
  const r = await b.settle(clicked, 600, 8_000);
  const rec = await b.take(t0);
  const j = jumpStats(rec.samples, target, clicked);
  const failures: string[] = [];
  if (j.firstMoveMs === null || j.firstMoveMs > CLICK_RESPONSE_MS)
    failures.push(`click moved nothing within ${CLICK_RESPONSE_MS}ms (first move: ${j.firstMoveMs ?? "never"})`);
  if (j.landingError === null) failures.push("jump target is not on screen");
  else if (j.landingError > PLACE_TOLERANCE) failures.push(`jump target landed ${Math.round(j.landingError)}px off`);
  return finish(
    ctx,
    name,
    { ...common(rec, clicked, r.at, r), targetIndex: order.indexOf(target), ...j },
    failures,
  );
}

/** Where the reader is right now. */
export async function placeNow(ctx: FlowContext): Promise<Place | null> {
  const b = bench(ctx.page);
  return placeOf((await b.take((await b.now()) - 200)).samples.at(-1));
}

/**
 * Open another session in the same pane, the way the sidebar does (it sets
 * the route). `expect` says where the reader should land: the tail for a
 * session never left mid-way, or the place they left it.
 */
export async function switchTo(
  ctx: FlowContext,
  name: string,
  prev: string,
  next: string,
  expect: { tail: true } | { place: Place },
): Promise<StepResult> {
  const b = bench(ctx.page);
  const prevIds = new Set(orderOf(ctx, prev));
  const order = orderOf(ctx, next);
  await b.setTarget(order);
  const t0 = await ctx.page.evaluate((h) => {
    const t = performance.now();
    location.hash = h;
    return t;
  }, hashFor(next));
  const r = await b.settle(t0, 800, 15_000);
  const rec = await b.take(t0);
  const s = switchStats(rec.samples, prevIds, order, t0, r.at);
  const o = openStats(rec.samples, order, t0, r.at);
  const failures: string[] = [];
  if (s.staleMs > STALE_MS) failures.push(`previous session still on screen ${Math.round(s.staleMs)}ms after the switch`);
  if (s.blankAfter > 0) failures.push(`${s.blankAfter} blank frames after the new session appeared`);
  const metrics: Record<string, Metric> = { ...common(rec, t0, r.at, r), ...s, headShown: o.headShown };
  if ("tail" in expect) {
    metrics.atTail = o.atTail;
    if (!o.atTail) failures.push("did not open on the latest turn");
    if (o.headShown) failures.push(`painted turn ${o.minIndexShown} of ${order.length} on the way to the tail`);
  } else {
    const err = placeError(expect.place, rec.samples.at(-1));
    metrics.placeError = err;
    if (err === null) failures.push(`came back without the turn the reader left on screen (${expect.place.id})`);
    else if (err > PLACE_TOLERANCE) failures.push(`came back ${Math.round(err)}px from where the reader left`);
  }
  return finish(ctx, name, metrics, failures);
}

export interface FlowSessions {
  long: string;
  heavy: string;
  /** Flow A uses the first, flow C the next two. */
  small: readonly string[];
}

const smallAt = (s: FlowSessions, i: number) => {
  const id = s.small[i];
  if (!id) throw new Error(`flow needs at least ${i + 1} small sessions`);
  return id;
};

export type Flow = (ctx: FlowContext, s: FlowSessions, record: (r: StepResult) => void) => Promise<void>;

/**
 * A: the long session, cold, then everything a reader does in it, then away
 * and back. Each step starts where the last one left the reader.
 */
export const flowA: Flow = async (ctx, s, record) => {
  record(await openCold(ctx, "open", s.long));
  record(await stepUp(ctx, "step-up", 6_000, 120));
  record(await wheelUp(ctx, "wheel-up", 6_000, 100));
  record(await jump(ctx, "jump", s.long, 0.25));
  const left = await placeNow(ctx);
  record(await switchTo(ctx, "switch-heavy", s.long, s.heavy, { tail: true }));
  record(await switchTo(ctx, "switch-small", s.heavy, smallAt(s, 0), { tail: true }));
  if (!left) throw new Error("no place recorded before leaving the long session");
  record(await switchTo(ctx, "return-long", smallAt(s, 0), s.long, { place: left }));
  record(await switchTo(ctx, "return-heavy", s.long, s.heavy, { tail: true }));
};

/**
 * C: opening a session nobody has visited yet, once from a reader following
 * the tail and once from a reader who had scrolled away. Both must land on the
 * new session's latest turn; only the state of the session being left differs.
 */
export const flowC: Flow = async (ctx, s, record) => {
  record(await openCold(ctx, "open", s.long));
  record(await switchTo(ctx, "from-pinned", s.long, smallAt(s, 1), { tail: true }));
  record(await switchTo(ctx, "back-long", smallAt(s, 1), s.long, { tail: true }));
  record(await stepUp(ctx, "step-up", 3_000, 120));
  record(await switchTo(ctx, "from-scrolled", s.long, smallAt(s, 2), { tail: true }));
};

/** B: the session whose turns are individually enormous, cold. */
export const flowB: Flow = async (ctx, s, record) => {
  record(await openCold(ctx, "open", s.heavy));
  record(await stepUp(ctx, "step-up", 4_000, 120));
  record(await jump(ctx, "jump", s.heavy, 0.5));
};

export const FLOWS: Record<string, Flow> = { A: flowA, B: flowB, C: flowC };
