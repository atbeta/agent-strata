import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const composer = readFileSync(join(import.meta.dir, "session-composer.tsx"), "utf8");
const detail = readFileSync(join(import.meta.dir, "session-detail.tsx"), "utf8");

/**
 * A child session is driven by its parent — the composer on it must not send.
 * The gate lives in the controller, not just the textarea's `readonly` flag,
 * because Enter and the cite/edit paths all reach `send` without the box.
 */
describe("a read-only composer", () => {
  test("send, canSend and canAttach all answer to the same gate", () => {
    expect(composer).toContain("const writable = () => args.readOnly?.() === undefined");
    expect(composer).toContain("if (!writable()) return;");
    expect(composer).toContain("canSend = () => writable() && connected()");
    expect(composer).toContain("canAttach = () => writable() &&");
  });

  test("the reason replaces the placeholder and the box goes read-only", () => {
    expect(composer).toContain("ro() ??");
    expect(composer).toContain("readOnly={ro() !== undefined}");
    // Mutating affordances — pickers, permission, goal edit — leave with it.
    expect(composer).toContain("agent={!ro() &&");
    expect(composer).toContain("permission={ro() ? undefined : props.permission}");
    expect(composer).toContain("goal={ro() ? undefined :");
  });

  test("a child session is what sets the reason", () => {
    expect(detail).toContain("displayed()?.parent_session_id ? t(\"composer.childReadonly\")");
    expect(detail).toContain("v().parent_session_id ? t(\"composer.childReadonly\")");
  });
});
