import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRenderEffect, createRoot } from "solid-js";
import { clearPaneBusy, paneStatus, publishPaneBusy } from "./pane-activity";

const read = (f: string) => readFileSync(join(import.meta.dir, f), "utf8");

/**
 * Source with whole-line `//` comments removed.
 *
 * These assertions are about what the code does, and several of the reasons
 * below are written as comments beside it — a test that greps for a class name
 * has to be able to say that name in prose without tripping itself.
 */
const code = (f: string) =>
  read(f)
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

const idle = { status: "completed", busy: false };

describe("a pane dot that is not held hostage to the session list", () => {
  test("a pane's own view outranks a list row that has not caught up", () => {
    // The reported failure: a session visibly generating in a pane you are not
    // in, with a quiet grey dot beside its name. The list is refetched on a
    // 200ms debounce that bursts of durable events keep pushing back, so the
    // row is simply late — and the dot is 28px tall, which is where you look to
    // decide whether to switch over.
    publishPaneBusy("a1", true);
    expect(paneStatus("a1", idle)?.kind).toBe("running");
    clearPaneBusy("a1");
  });

  test("the list still wins when no pane has spoken", () => {
    expect(paneStatus("b1", { status: "completed", busy: true })?.kind).toBe("running");
    expect(paneStatus("b1", idle)?.kind).toBe("done");
  });

  test("a pane that has not caught up cannot talk the list out of a run", () => {
    // Only one direction is safe to resolve. A stale "busy" clears on the next
    // read; a missing one waits for an event that may never come, which is the
    // original bug wearing the other hat.
    publishPaneBusy("c1", false);
    expect(paneStatus("c1", { status: "completed", busy: true })?.kind).toBe("running");
    clearPaneBusy("c1");
  });

  test("a claim expires with the pane that made it", () => {
    // Without this the fix is a new latch with no exit: close the pane on a
    // running session and the header keeps saying running forever.
    publishPaneBusy("d1", true);
    clearPaneBusy("d1");
    expect(paneStatus("d1", idle)?.kind).toBe("done");
  });

  test("waiting still outranks running", () => {
    publishPaneBusy("e1", true);
    expect(paneStatus("e1", { status: "completed", needs_input: true })?.kind).toBe("needs-input");
    clearPaneBusy("e1");
  });

  test("a session no pane is showing has no status to draw", () => {
    expect(paneStatus("f1", undefined)).toBeUndefined();
  });
});

describe("a publisher that does not subscribe to what it writes", () => {
  // Every pane publishes from inside an effect, so this is the shape that has
  // to settle rather than loop. The first version of `publishPaneBusy` read the
  // map to decide whether it needed to write — and because it read it from
  // inside the caller's effect, the write invalidated the effect that made it,
  // and the second pane mounted stack-overflowed the window. A writer that
  // leaves a subscription behind is not a writer.
  //
  // `createRenderEffect`, not `createEffect`: under `bun test` `solid-js`
  // resolves to the SSR build, where `createEffect` is a no-op and would let a
  // loop pass as a no-op. The two share dependency tracking, which is the only
  // part this is about.
  test("publishing from a reactive scope settles on the first pass", () => {
    let runs = 0;
    const dispose = createRoot((d) => {
      createRenderEffect(() => {
        runs++;
        publishPaneBusy("loop", false);
      });
      return d;
    });
    expect(runs).toBe(1);
    dispose();
    // And the claim is gone with the pane that made it.
    expect(paneStatus("loop", idle)?.kind).toBe("done");
  });

  test("clearing from a reactive scope settles too", () => {
    publishPaneBusy("clear-loop", true);
    let runs = 0;
    createRoot(() => {
      createRenderEffect(() => {
        runs++;
        clearPaneBusy("clear-loop");
      });
    });
    expect(runs).toBe(1);
    expect(paneStatus("clear-loop", idle)?.kind).toBe("done");
  });

  test("the header's read happens inside the call, not once at module load", () => {
    // The reactivity here is `seen()` being read while `paneStatus` runs. Hoist
    // it out — cache the status, read the map at module scope, any of the
    // obvious "tidying" moves — and the dot stops following the pane while every
    // merge assertion above keeps passing, because they all call `paneStatus`
    // again by hand.
    //
    // Asserted on the source rather than on a re-run: `bun test` resolves
    // `solid-js` to the SSR build, where effects do not propagate the way the
    // running app does, so a behavioural test here would prove nothing about
    // either version.
    const src = read("pane-activity.ts");
    const body = src.slice(src.indexOf("export function paneStatus"));
    // Read per call, OR-ed with the row, inside the expression that builds the
    // status — not looked up once and stored.
    expect(body).toContain("busy: row.busy === true || seen().get(sessionId) === true");
  });

  test("the publisher reads the map untracked", () => {
    // Guard on the source, not just on the behaviour: the behaviour can also be
    // achieved by a write that happens not to change anything, and that version
    // would start looping the moment a pane's state actually changed.
    const src = read("pane-activity.ts");
    expect(src).toContain("untrack(");
    const body = src.slice(src.indexOf("export function publishPaneBusy"));
    expect(body.slice(0, 300)).toContain("untrack(");
  });
});

describe("a peer pane that cannot be frozen by a hand-off failing silently", () => {
  test("it keeps an exit that does not run through the forwarded stream", () => {
    // `/stream` is one connection owned by the focused pane. A peer whose only
    // subscription is a window event that pane dispatches on its behalf cannot
    // report that forward failing: a reconnect, a peer mounted while the
    // stream was down, one dropped message — all indistinguishable from an
    // idle session, and permanent, because the correcting event is also the
    // one that is not arriving.
    const peer = read("peer-transcript.tsx");
    expect(peer).toContain("readHead");
    const probe = peer.slice(peer.indexOf("const probe = setInterval"));
    expect(probe).toContain("refreshPeerView");
  });

  test("the probe pays for a view only when the session actually moved", () => {
    // An unchanged head must return before any view work, or four idle panes
    // would re-project four whole sessions every three seconds — which is the
    // cost the focused pane's head probe was written to avoid.
    const peer = code("peer-transcript.tsx");
    const probe = peer.slice(peer.indexOf("const probe = setInterval"));
    expect(probe).toContain("if (seq === head) return;");
    expect(probe.indexOf("if (seq === head) return;")).toBeLessThan(probe.indexOf("refreshPeerView"));
  });

  test("the head probe lives in the API module, shared, not copy-pasted per pane", () => {
    expect(read("api.ts")).toContain("export async function readHead");
    // One definition. Two copies of an index probe is one too many.
    expect(read("session-detail.tsx")).not.toContain("async function readHead");
  });
});

describe("focus you can find without hunting", () => {
  test("the header states it at full strength, not at a fourth of one", () => {
    // 13% grey at 60% strength over a 6.5% background is about a four-point
    // lightness step — on the least contrast-sensitive channel available, on a
    // seven-pixel band. That is the difference between two headers and one
    // header you have to check.
    const header = code("pane-stage.tsx").slice(code("pane-stage.tsx").indexOf("@container flex h-7"));
    expect(header).toContain('"bg-secondary text-foreground"');
    expect(header).not.toContain("bg-secondary/60");
  });

  test("weight carries focus too, for a reader who cannot separate the greys", () => {
    const stage = code("pane-stage.tsx");
    const header = stage.slice(stage.indexOf("@container flex h-7"));
    expect(header).toContain("font-semibold");
    expect(header).toContain("font-medium");
  });

  test("the rail is as tall as the header, so it reads as an edge", () => {
    const stage = code("pane-stage.tsx");
    const rail = stage.slice(stage.indexOf("w-0.5 shrink-0 rounded-full"));
    expect(rail.slice(0, 160)).toContain("h-5 bg-primary");
    expect(rail.slice(0, 160)).not.toContain("h-3");
  });
});
