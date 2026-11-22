import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  readSound,
  saveSound,
  soundForEvent,
  soundName,
  SOUND_FAMILIES,
  SOUND_OPTIONS,
} from "./sound";

function storage(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("sound preferences", () => {
  test("uses the OpenCode defaults for each event", () => {
    const s = storage();
    expect(readSound("agent", s)).toBe("staplebops-01");
    expect(readSound("permission", s)).toBe("staplebops-02");
    expect(readSound("error", s)).toBe("nope-03");
  });

  test("saves one event without changing the others", () => {
    const s = storage();
    saveSound("permission", "nope-05", s);
    expect(readSound("permission", s)).toBe("nope-05");
    expect(readSound("agent", s)).toBe("staplebops-01");
    expect(readSound("error", s)).toBe("nope-03");
  });

  test("none is a saved choice, and an old synthetic id falls back safely", () => {
    const s = storage({ "strata.sound.error": "drop" });
    expect(readSound("error", s)).toBe("nope-03");
    saveSound("error", "none", s);
    expect(readSound("error", s)).toBe("none");
  });
});

describe("the bundled OpenCode sound library", () => {
  test("contains all 45 assets in five families", () => {
    const assets = SOUND_OPTIONS.filter((id) => id !== "none");
    expect(assets).toHaveLength(45);
    expect(new Set(assets).size).toBe(45);
    expect(SOUND_FAMILIES.map((family) => family.sounds.length)).toEqual([10, 10, 7, 12, 6]);
    expect(soundName("bip-bop-03")).toBe("Bip-bop 03");
  });

  test("ships a nonempty audio file and the upstream license", () => {
    for (const id of SOUND_OPTIONS) {
      if (id === "none") continue;
      const path = fileURLToPath(new URL(`../public/sounds/opencode/${id}.aac`, import.meta.url));
      expect(statSync(path).size).toBeGreaterThan(0);
    }
    const license = fileURLToPath(new URL("../public/sounds/opencode/LICENSE", import.meta.url));
    expect(statSync(license).size).toBeGreaterThan(0);
  });
});

describe("session event sounds", () => {
  test("separates permission requests from questions", () => {
    expect(soundForEvent({ type: "permission.requested" })).toBe("permission");
    expect(soundForEvent({ type: "question.asked" })).toBe("agent");
  });

  test("plays for real errors, not an error clear", () => {
    expect(soundForEvent({ type: "session.error", data: { error: { message: "boom" } } })).toBe("error");
    expect(soundForEvent({ type: "session.error", data: { error: null } })).toBeUndefined();
    expect(soundForEvent({ type: "session.ended", data: { reason: "error" } })).toBe("error");
    expect(soundForEvent({ type: "session.ended", data: { reason: "completed" } })).toBeUndefined();
  });

  test("ignores unrelated events", () => {
    expect(soundForEvent({ type: "session.status", data: { state: "idle" } })).toBeUndefined();
    expect(soundForEvent({ type: "tool.progress" })).toBeUndefined();
  });
});
