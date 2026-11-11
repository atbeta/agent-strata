import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dialog = readFileSync(join(import.meta.dir, "components", "ui", "command-dialog.tsx"), "utf8");

describe("the command dialog", () => {
  test("focus goes back only to a trigger that was showing focus", () => {
    expect(dialog).toContain('el.matches(":focus-visible") ? el : undefined');
  });

  test("the scrim does not blur the window on Windows", () => {
    expect(dialog).toContain('shellPlatform() !== "windows" && "backdrop-blur-[2px]"');
  });
});
