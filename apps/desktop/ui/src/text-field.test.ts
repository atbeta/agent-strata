import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fieldVariants } from "./components/ui/field";

/**
 * `fieldVariants` is the whole contract. Nineteen fields across six screens
 * stopped carrying their own height, face and border and started saying which
 * kind of field they are — so this function is now the only thing standing
 * between them and drifting apart again.
 */

const cls = (v: Parameters<typeof fieldVariants>[0]) => fieldVariants(v).split(/\s+/);

describe("field variants", () => {
  test("the ladder runs 28 → 36", () => {
    expect(cls({ size: "xs" })).toContain("h-7");
    expect(cls({ size: "sm" })).toContain("h-8");
    expect(cls({ size: "default" })).toContain("h-9");
  });

  test("every size keeps the border, the placeholder and the focus ring", () => {
    // These were written out by hand nineteen times and were not the same
    // nineteen times: one screen had no focus ring, another showed a focus
    // ring as a border-colour change, a third had no placeholder colour.
    for (const size of ["xs", "sm", "default"] as const) {
      const c = cls({ size });
      expect(c).toContain("border");
      expect(c).toContain("placeholder:text-muted-foreground");
      expect(c).toContain("focus-visible:ring-2");
      expect(c).toContain("rounded-md");
    }
  });

  test("bare drops the box that the surrounding shell already draws", () => {
    // The global search overlay, the command palette and the in-session find
    // bar each put the field inside a bordered, filled container. Two boxes
    // nested is what made the three read as different controls.
    const c = cls({ size: "default", bare: true });
    expect(c).toContain("border-0");
    expect(c).toContain("bg-transparent");
  });

  test("mono is a face, not a size", () => {
    // A field holding a command, a path or a token. The policy rules, the MCP
    // command and the OAuth code were each carrying their own `font-mono`.
    const c = cls({ size: "sm", mono: true });
    expect(c).toContain("font-mono");
    expect(c).toContain("h-8");
  });
});

describe("the field primitive does not require a provider", () => {
  const SRC = import.meta.dir;
  const FILE = join(SRC, "components", "ui", "text-field.tsx");

  /**
   * This was not hypothetical. The primitive used to wrap Kobalte's
   * `TextField`, whose input throws `useFormControlContext must be used within
   * a FormControlContext.Provider` when it is rendered on its own — and
   * nineteen of the call sites render a field with no caption above it, so no
   * root. All nineteen took the whole page down to a blank screen, and nothing
   * in the file said the constraint existed.
   *
   * The fix was to drop Kobalte, not to document the rule and wrap nineteen
   * fields in a caption they do not have. A guard that the file reaches for no
   * external form context means reintroducing one has to be a decision someone
   * makes on purpose.
   */
  test("text-field.tsx imports no Kobalte form control", () => {
    const src = readFileSync(FILE, "utf8");
    expect(src).not.toMatch(/@kobalte\/core/);
  });

  test("the screen set imports no Kobalte primitives directly", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".tsx") && !path.includes(join("components", "ui"))) {
          if (readFileSync(path, "utf8").includes("@kobalte/core")) offenders.push(path);
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
