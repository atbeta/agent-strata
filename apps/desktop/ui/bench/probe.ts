/**
 * In-page instrumentation for the transcript bench.
 *
 * Installed with `context.addInitScript(installProbe)`, so it runs before the
 * app on every navigation. Playwright ships the function by its source text:
 * it must not close over anything in this module.
 *
 * What it records, all on the page's own clock (`performance.now()` origin):
 *
 * - One sample per animation frame, taken at the start of the frame callback:
 *   the transcript scroller's scroll state and the rows visible in it. Frame
 *   gaps come from the rAF timestamps, which is the only frame signal that
 *   exists in both WebKit and Chromium (WebKit has no Long Tasks API).
 * - Every programmatic scroll of the transcript scroller: `scrollTop` writes,
 *   `scrollTo`/`scrollBy` on it, and `scrollIntoView` on anything inside it.
 *   Writes made by the bench's own driver are flagged so they can be excluded.
 * - Click times (capture phase), page errors, and long tasks where supported.
 *
 * Sampling reads layout once per frame. That costs a little and is the same
 * cost on every build being compared, which is what an A/B needs.
 */
export function installProbe(): void {
  type Sample = {
    t: number;
    ft: number;
    st: number;
    sh: number;
    ch: number;
    ids: string[];
    tops: number[];
    rows: number;
    drive: number;
  };
  type Write = { t: number; kind: string; from: number; to: number; driver: boolean };
  const w = window as unknown as { __bench?: unknown };
  if (w.__bench) return;

  const samples: Sample[] = [];
  const writes: Write[] = [];
  const clicks: number[] = [];
  const errors: string[] = [];
  const longtasks: { t: number; d: number }[] = [];
  let driving = false;
  let drive = 0;
  let stepLeft = 0;
  let stepPx = 0;
  let stepDone: (() => void) | undefined;
  let target: Set<string> | undefined;
  let lastChange = 0;
  let lastKey = "";
  let fallback: HTMLElement | null = null;
  const waiters: Array<{ quiet: number; notBefore: number; cap: number; done: (r: { settled: boolean; at: number }) => void }> = [];

  const scroller = (): HTMLElement | null => {
    const tagged = document.querySelector<HTMLElement>("[data-transcript-scroller]");
    if (tagged) return tagged;
    // Builds that predate the hook: the nearest scrolling ancestor of a message.
    if (fallback?.isConnected) return fallback;
    let el = document.querySelector("[data-message-role]")?.parentElement ?? null;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") break;
      el = el.parentElement;
    }
    fallback = el;
    return el;
  };
  const isScroller = (el: Element) => el === scroller();

  const proto = Element.prototype;
  const top = Object.getOwnPropertyDescriptor(proto, "scrollTop")!;
  const record = (el: Element, kind: string, apply: () => void) => {
    // The driver's own steps are not recorded: reading the position around
    // them would force the layout the driver is careful not to force.
    if (driving) return apply();
    const from = top.get!.call(el) as number;
    apply();
    writes.push({ t: performance.now(), kind, from, to: top.get!.call(el) as number, driver: driving });
  };
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    enumerable: top.enumerable,
    get() {
      return top.get!.call(this);
    },
    set(v: number) {
      if (isScroller(this)) record(this, "top", () => top.set!.call(this, v));
      else top.set!.call(this, v);
    },
  });
  for (const name of ["scrollTo", "scrollBy"] as const) {
    const orig = proto[name] as (...a: unknown[]) => void;
    proto[name] = function (this: Element, ...a: unknown[]) {
      if (isScroller(this)) record(this, name, () => orig.apply(this, a));
      else orig.apply(this, a);
    } as never;
  }
  const intoView = proto.scrollIntoView;
  proto.scrollIntoView = function (this: Element, ...a: unknown[]) {
    const sc = scroller();
    if (sc && sc !== this && sc.contains(this)) record(sc, "intoView", () => intoView.apply(this, a as never));
    else intoView.apply(this, a as never);
  };

  addEventListener("click", () => clicks.push(performance.now()), true);
  addEventListener("error", (e) => errors.push(String((e as ErrorEvent).message ?? e)));
  addEventListener("unhandledrejection", (e) => errors.push(`unhandled: ${String((e as PromiseRejectionEvent).reason)}`));
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longtasks.push({ t: e.startTime, d: e.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {
    // WebKit: no Long Tasks API. Frame gaps still cover it.
  }

  const contentOk = (s: Sample | undefined) => {
    if (!s || s.ids.length === 0) return false;
    if (!target) return true;
    for (const id of s.ids) if (!target.has(id)) return false;
    return true;
  };

  /**
   * Sampling reads layout, so it runs after the frame has painted, in a task
   * posted from the frame callback. Read at the start of the frame, it forced
   * a layout that the app's own frame callbacks then invalidated again: a CPU
   * profile of wheel scrolling put 80ms of the gesture's 128ms of JS in this
   * probe. After paint, layout is clean and the reads cost nearly nothing.
   * The sample keeps the frame's rAF timestamp, so frame gaps are unchanged.
   */
  const post = new MessageChannel();
  let pendingTs: number[] = [];
  post.port1.onmessage = () => {
    const due = pendingTs;
    pendingTs = [];
    for (const ts of due) sample(ts);
  };
  /** scrollTop as of the last sample: the driver steps from it without reading layout. */
  let lastSt: number | undefined;

  const frame = (ts: number) => {
    requestAnimationFrame(frame);
    // The driver acts like input: it moves the scroller at the start of the
    // frame and never reads layout to do it. It stops a step short of the top,
    // so every step it takes is applied in full and `drive` is exact.
    const sc = scroller();
    if (sc && stepLeft > 0 && lastSt !== undefined) {
      const step = Math.min(stepPx, stepLeft);
      if (lastSt - drive - step < 0) {
        stepLeft = 0;
        stepDone?.();
      } else {
        driving = true;
        sc.scrollBy(0, -step);
        driving = false;
        drive += step;
        stepLeft -= step;
        if (stepLeft <= 0) stepDone?.();
      }
    }
    pendingTs.push(ts);
    post.port2.postMessage(0);
  };

  const sample = (ft: number) => {
    // `t` is when the sample was taken, on the same clock as clicks, writes and
    // route changes, so "after the click" means after it. `ft` is the frame it
    // belongs to, which is what frame gaps are measured on.
    const ts = performance.now();
    const sc = scroller();
    const s: Sample = { t: ts, ft, st: 0, sh: 0, ch: 0, ids: [], tops: [], rows: 0, drive };
    drive = 0;
    if (sc) {
      s.st = top.get!.call(sc) as number;
      s.sh = sc.scrollHeight;
      s.ch = sc.clientHeight;
      const box = sc.getBoundingClientRect();
      const rows = sc.querySelectorAll<HTMLElement>("[data-turn-id]");
      s.rows = rows.length;
      for (const r of rows) {
        const b = r.getBoundingClientRect();
        if (b.bottom <= box.top || b.top >= box.bottom || b.height === 0) continue;
        s.ids.push(r.dataset.turnId!);
        s.tops.push(b.top - box.top);
      }
    }
    samples.push(s);
    lastSt = sc ? s.st : undefined;

    const key = `${s.st}|${s.sh}|${s.ch}|${s.rows}|${s.ids.join(",")}|${Math.round(s.tops[0] ?? 0)}`;
    const lastWrite = writes.length ? writes[writes.length - 1]!.t : 0;
    if (key !== lastKey) {
      lastKey = key;
      lastChange = ts;
    }
    if (lastWrite > lastChange) lastChange = lastWrite;

    for (let i = waiters.length - 1; i >= 0; i--) {
      const wt = waiters[i]!;
      const since = Math.max(lastChange, wt.notBefore);
      if (ts - since >= wt.quiet && contentOk(s)) {
        waiters.splice(i, 1);
        wt.done({ settled: true, at: since });
      } else if (ts - wt.notBefore >= wt.cap) {
        waiters.splice(i, 1);
        wt.done({ settled: false, at: ts });
      }
    }
  };
  requestAnimationFrame(frame);

  w.__bench = {
    now: () => performance.now(),
    setTarget(ids: string[] | null) {
      target = ids ? new Set(ids) : undefined;
    },
    waitSettled(quiet: number, cap: number, notBefore: number) {
      return new Promise<{ settled: boolean; at: number }>((done) => waiters.push({ quiet, cap, notBefore, done }));
    },
    /** Scroll the transcript up by `total` px, `step` px per frame. Resolves when done or at the top. */
    stepUp(total: number, step: number) {
      return new Promise<void>((done) => {
        stepLeft = total;
        stepPx = step;
        stepDone = () => {
          stepDone = undefined;
          done();
        };
      });
    },
    scrollerBox() {
      const sc = scroller();
      if (!sc) return null;
      const b = sc.getBoundingClientRect();
      return { x: b.left, y: b.top, width: b.width, height: b.height };
    },
    take(from: number) {
      return {
        samples: samples.filter((s) => s.t >= from),
        writes: writes.filter((x) => x.t >= from),
        clicks: clicks.filter((x) => x >= from),
        errors: errors.slice(),
        longtasks: longtasks.filter((x) => x.t >= from),
      };
    },
  };
}
