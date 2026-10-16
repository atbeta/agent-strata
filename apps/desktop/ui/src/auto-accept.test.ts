import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(import.meta.dir, f), "utf8");

/**
 * The switch is one POST and one bit, so the things worth pinning down are the
 * ones a reader would only notice by being wrong: that the read is per session
 * rather than app-wide, that what was already on screen follows it, and that a
 * second reader of the same session finds out.
 */
describe("the per-session auto-accept switch", () => {
  test("the read is keyed on the session, not shared across the window", () => {
    const src = read("session-detail.tsx");
    // A global signal would carry one session's answer into the next one the
    // reader opened, which is the disagreement this switch exists to remove.
    const decl = src.slice(src.indexOf("const [autoAccept"), src.indexOf("const toggleAutoAccept"));
    expect(decl).toContain("() => props.id");
    expect(decl).toContain("readSessionPolicy(id)");
  });

  test("what was already on screen follows the switch on", () => {
    // The first thing a reader meets: a permission card is up when they reach
    // for the button. Leaving it there would put the header and the card into
    // exactly the disagreement this is meant to end.
    const src = read("session-detail.tsx");
    const start = src.indexOf("const toggleAutoAccept");
    const body = src.slice(start, src.indexOf("\n  const ", start + 1));
    expect(body).toContain('next === "auto" ? (asks() ?? [])');
    expect(body).toContain('respondPermission(request_id, "allow", "once")');
    // And it puts the card back if the switch itself did not land.
    expect(body).toContain("unhideAsk(request_id)");
  });

  test("the reader's own read moves before the request, not after", () => {
    const src = read("session-detail.tsx");
    const start = src.indexOf("const toggleAutoAccept");
    const body = src.slice(start, src.indexOf("\n  const ", start + 1));
    expect(body.indexOf("refetchAutoAccept(next)")).toBeLessThan(body.indexOf("await setSessionPolicy"));
  });

  test("another pane or window moving it is not a stale read", () => {
    const src = read("session-detail.tsx");
    expect(src).toContain('evt.type === "session.policy"');
    expect(src).toContain("if (evt.session_id === props.id) refetchAutoAccept();");
  });

  test("moving it refetches nothing in the transcript", () => {
    // Permissions are not turns. Both panes hold a view that a policy change
    // does not touch, and on a long session the refetch that would follow is
    // the slowest thing either of them does.
    const detail = read("session-detail.tsx");
    const at = detail.indexOf('if (evt.type === "session.policy")');
    const block = detail.slice(at, detail.indexOf("\n        }", at));
    expect(block).toContain("return;");
    const peer = read("peer-transcript.tsx");
    expect(peer).toContain('if (evt.type === "session.policy") return;');
  });

  test("the mode read treats anything but an explicit auto as inheriting", () => {
    // A `known: false` answer, an error swallowed into "inherit", a field that
    // arrives missing — all of them mean the same thing, and guessing "auto"
    // on any of them would silently unlock a session nobody switched on.
    const api = read("api.ts");
    const fn = api.slice(api.indexOf("export async function readSessionPolicy"));
    expect(fn.slice(0, fn.indexOf("\n}"))).toContain('body.mode === "auto" ? "auto" : "inherit"');
  });
});
