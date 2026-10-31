import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const code = (file: string) =>
  readFileSync(join(import.meta.dir, file), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
    .join("\n");

describe("opening a session does not keep the previous one on screen", () => {
  test("the shell and the prompt rail follow the session being opened", () => {
    const src = code("session-detail.tsx");
    // The resource keeps the previous session until the next fetch resolves.
    // Painting that is the leftover rail and the leftover transcript, and the
    // jump when the new view finally arrives.
    expect(src).toContain("when={displayed()}");
    expect(src).not.toContain("when={settled(view)}");
    expect(src).not.toContain("when={!traceBlock() && settled(view)}");
    // The transcript is keyed on the view on screen, not on the route — a
    // session id that ran ahead of its data would remount the list on stale
    // rows.
    expect(src).toContain("sessionId={displayed()?.session_id ?? props.id}");
    expect(src).toContain("turns={turns()}");
    const view = code("transcript-view.tsx");
    expect(view).toContain("promptEntries(props.turns, prev)");
    expect(view).not.toContain("promptEntries(settled(view)");
  });

  test("a tail of the last turns does not draw the prompt rail", () => {
    const src = code("session-detail.tsx");
    expect(src).toContain("outlineIsPartial(displayed())");
    const peer = code("peer-transcript.tsx");
    expect(peer).toContain("outlineIsPartial(");
  });

  test("a stale view does not end the skeleton", () => {
    const src = code("session-detail.tsx");
    expect(src).not.toContain("settled(view))) setBooting(false)");
    expect(src).toContain("displayed()?.session_id === id");
  });
});
