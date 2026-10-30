import { describe, expect, test } from "bun:test";
import { stopConfirmed, stopVerdict } from "./stop-verdict";

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
