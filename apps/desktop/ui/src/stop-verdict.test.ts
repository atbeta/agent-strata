import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stopConfirmed, stopVerdict } from "./stop-verdict";

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");

/**
 * A stop the reader asked for has one of two failures, and they are opposites:
 * claiming one that did not happen, and refusing to believe one that did. The
 * second is the one that shipped — every stop on a long session reported itself
 * as unconfirmed — so these hold the evidence, not the optimism.
 */
describe("stop verdict", () => {
  test("a backend that took the abort is believed, whatever the view says", () => {
    // The case from the report. The abort returned 200 and the session was idle
    // within a second, but the view behind the button had not been re-fetched
    // yet, so it still read busy — and the watchdog called it a failed stop.
    expect(stopVerdict(true, true)).toBe("confirmed");
    expect(stopConfirmed(true, true)).toBe(true);
  });

  test("a stop still in flight is not claimed", () => {
    expect(stopVerdict(false, true)).toBe("waiting");
    expect(stopConfirmed(false, true)).toBe(false);
  });

  test("a view that says nothing is running is believed on its own", () => {
    // The session can go idle between the reader deciding to stop and the
    // request landing, so a listener on the transition would wait for an event
    // that has already been and gone.
    expect(stopVerdict(false, false)).toBe("confirmed-by-view");
    expect(stopConfirmed(false, false)).toBe(true);
  });
});

describe("stop verdict ratchet", () => {
  test("the prompt-handover flag is dropped before the request, not after", () => {
    // The handover is the one part of `generating()` the client owns. Closing
    // it after `await` put a round trip between the button and the session
    // reading as idle, which on a slow view is long enough for the watchdog to
    // fire on a stop that worked.
    const src = read("session-composer.tsx");
    // Bound the slice to `stop` itself — later helpers also close the handover.
    const start = src.indexOf("const stop = async");
    const stop = src.slice(start, src.indexOf("\n  const ", start + 1));
    const before = stop.slice(0, stop.indexOf("try {"));
    const after = stop.slice(stop.indexOf("try {"));
    expect(before).toContain("closeHandover()");
    expect(after).not.toContain("closeHandover()");
  });

  test("the confirmation is the abort's answer, not the view's", () => {
    const src = read("session-composer.tsx");
    expect(src).toContain("stopConfirmed(abortAccepted(), generating())");
  });

  test("a refused abort says so rather than waiting for a verdict", () => {
    // The 502 path has to leave the stopping state, or the button keeps a
    // promise the backend already refused.
    const src = read("session-composer.tsx");
    const stop = src.slice(src.indexOf("const stop = async"));
    const catchBlock = stop.slice(stop.indexOf("catch (err)"));
    expect(catchBlock.slice(0, 300)).toContain("setStopping(false)");
    expect(catchBlock.slice(0, 300)).not.toContain("setAbortAccepted(true)");
  });
});
