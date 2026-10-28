import { describe, expect, test } from "bun:test";
import {
  modelForComposer,
  PREFERRED_MODEL_KEY,
  preferredNewSessionModel,
  readPreferredModel,
  writePreferredModel,
} from "./model-preference";

function store(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

const models = [
  { providerID: "anthropic", modelID: "claude" },
  { providerID: "openai", modelID: "gpt" },
];

describe("the model a new session starts on", () => {
  test("a manual choice is what the next new session uses", () => {
    const s = store();
    writePreferredModel("openai/gpt", s);
    expect(s.getItem(PREFERRED_MODEL_KEY)).toBe("openai/gpt");
    expect(readPreferredModel(s)).toBe("openai/gpt");
    expect(preferredNewSessionModel(models, readPreferredModel(s))).toBe("openai/gpt");
  });

  test("a choice the server no longer lists falls back to the first offered model", () => {
    expect(preferredNewSessionModel(models, "google/gemini")).toBe("anthropic/claude");
    expect(preferredNewSessionModel(models, undefined)).toBe("anthropic/claude");
    expect(preferredNewSessionModel([], "openai/gpt")).toBeUndefined();
  });

  test("nothing stored, or a value that is not a model, is not a choice", () => {
    expect(readPreferredModel(store())).toBeUndefined();
    expect(readPreferredModel(store({ [PREFERRED_MODEL_KEY]: "claude" }))).toBeUndefined();
    expect(readPreferredModel(store({ [PREFERRED_MODEL_KEY]: "{" }))).toBeUndefined();
    const s = store();
    writePreferredModel("claude", s);
    expect(s.getItem(PREFERRED_MODEL_KEY)).toBeNull();
  });

  test("an existing session keeps the model it already used", () => {
    expect(
      modelForComposer({
        touched: false,
        ready: true,
        inherited: "anthropic/claude",
        models,
        remembered: "openai/gpt",
      }),
    ).toBe("anthropic/claude");
  });

  test("a new session, with no model of its own, takes the manual choice", () => {
    expect(
      modelForComposer({
        touched: false,
        ready: true,
        inherited: undefined,
        models,
        remembered: "openai/gpt",
      }),
    ).toBe("openai/gpt");
  });

  test("a session still loading, or a picker the reader just moved, is left alone", () => {
    expect(
      modelForComposer({
        touched: false,
        ready: false,
        inherited: "anthropic/claude",
        models,
        remembered: "openai/gpt",
      }),
    ).toBeUndefined();
    expect(
      modelForComposer({
        touched: true,
        ready: true,
        inherited: undefined,
        models,
        remembered: "openai/gpt",
      }),
    ).toBeUndefined();
  });
});
