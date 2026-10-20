import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionStatus, showsMark } from "./session-status";

/**
 * `GET /sessions` has always sent three status fields and the lists read two of
 * them. `status` — which is the one that says a session ended in an error —
 * had no reader at all, so a failed session and a finished one drew the same
 * thing: nothing. These tests hold the precedence that replaced it, and the
 * ratchet at the bottom stops a list going back to picking its own colours.
 */

const row = (patch: { status?: string; busy?: boolean; needs_input?: boolean }) => patch;

describe("session status", () => {
  test("waiting outranks running", () => {
    // A session blocked on a permission is also busy, and it is the one going
    // nowhere. Calling that "running" tells the reader to wait patiently for
    // something that will not move until they answer.
    expect(sessionStatus(row({ busy: true, needs_input: true })).kind).toBe("needs-input");
  });

  test("busy is running, and running draws the moving mark without a word", () => {
    const s = sessionStatus(row({ busy: true, status: "active" }));
    expect(s.kind).toBe("running");
    expect(s.badge).toBe(false);
    expect(showsMark(s)).toBe(true);
  });

  test("busy outranks a status left over from an earlier turn", () => {
    // The projector clears `busy` on `session.ended`, so this pairing should
    // not reach here. If it ever does, live work is the truer answer.
    expect(sessionStatus(row({ busy: true, status: "error" })).kind).toBe("running");
  });

  test("an errored session is the one state that gets a badge and a red tone", () => {
    // The gap this closes: nothing drew it before, and nothing else on the row
    // would either.
    const s = sessionStatus(row({ status: "error" }));
    expect(s.kind).toBe("failed");
    expect(s.badge).toBe(true);
    expect(s.tone.dot).toBe("bg-status-error");
  });

  test("cancelled and completed draw no mark and no word", () => {
    for (const status of ["cancelled", "completed"]) {
      const s = sessionStatus(row({ status }));
      expect(s.badge).toBe(false);
      expect(showsMark(s)).toBe(false);
    }
  });

  test("an unknown or absent status is idle, not crashed", () => {
    // `status` is a plain `string` on the wire. A backend that adds a state
    // must not blank the list.
    expect(sessionStatus(row({})).kind).toBe("idle");
    expect(sessionStatus(row({ status: "something-new" })).kind).toBe("idle");
  });

  test("every state has its own word", () => {
    // These were three dictionaries saying the same two words three ways.
    const labels = ["active", "completed", "cancelled", "error"].map(
      (status) => sessionStatus(row({ status })).label,
    );
    labels.push(sessionStatus(row({ busy: true })).label);
    labels.push(sessionStatus(row({ needs_input: true })).label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("only the loud states draw a mark; quiet rows show nothing", () => {
    // A row with nothing in front of the title has no status, and on a list of
    // finished sessions that is most rows. Marks are reserved for the states
    // that are actually asking for the eye: waiting, running, failed.
    const drawn = ["needs-input", "running", "failed"] as const;
    for (const kind of drawn) {
      const s = sessionStatus(
        kind === "needs-input"
          ? row({ needs_input: true })
          : kind === "running"
            ? row({ busy: true })
            : row({ status: "error" }),
      );
      expect(s.kind).toBe(kind);
      expect(showsMark(s)).toBe(true);
    }
    for (const s of [
      sessionStatus(row({ status: "completed" })),
      sessionStatus(row({ status: "cancelled" })),
      sessionStatus(row({})),
    ]) {
      expect(showsMark(s)).toBe(false);
      expect(s.badge).toBe(false);
    }
  });
});

describe("lists draw status through one primitive", () => {
  const read = (f: string) => readFileSync(join(import.meta.dir, f), "utf8");

  /** One top-level component's body, so a ratchet cannot be aimed at the wrong one. */
  const body = (src: string, from: string) => {
    const i = src.indexOf(from);
    if (i < 0) throw new Error(`no such component: ${from}`);
    const j = src.indexOf("\nfunction ", i);
    return src.slice(i, j < 0 ? undefined : j);
  };

  test("the running mark breathes through the middle", () => {
    // A perimeter chase left nine cells sitting still, so the mark read as a
    // hollow ring. The inner four use the bright curve; the edge uses the dim
    // one; nothing is a ring.
    const mark = read("components/ui/session-status.tsx");
    expect(mark).not.toContain("cell-ring");
    expect(mark).toContain("cell-dim");
    const theme = read("theme.css");
    expect(theme).toContain("animation-name: status-busy-core");
    expect(theme).toContain("animation-name: status-busy-edge");
    expect(theme).not.toContain("status-busy-chase");
  });

  test("both lists use it", () => {
    // Two lists, two bespoke status drawings, one vocabulary.
    for (const file of ["sidebar-row.tsx", "fleet-view.tsx"]) {
      expect(read(file)).toContain("<SessionStatusMark");
    }
  });

  test("the sidebar row takes no raw status props", () => {
    // `busy` and `needsInput` arrived as separate booleans, which is how the
    // row ended up deciding for itself: green dot OR orange badge, no third
    // option, and nothing at all for the state that had none.
    const src = read("sidebar-row.tsx");
    expect(src).not.toContain("props.busy");
    expect(src).not.toContain("props.needsInput");
  });

  test("the sidebar row picks no status colour of its own", () => {
    // Scoped to the row. Elsewhere in the app the same classes are correct:
    // a connection row draws a green dot for a live backend, and the attaching
    // screen breathes while it connects. Neither is a session.
    const row = body(read("sidebar-row.tsx"), "function SessionListItem");
    expect(row).not.toMatch(/bg-status-|bg-event-permission|bg-transparent/);
  });

  test("the fleet list picks no status colour of its own", () => {
    const src = read("fleet-view.tsx");
    expect(src).not.toContain("bg-event-permission");
    expect(src).not.toMatch(/bg-status-/);
  });
});
