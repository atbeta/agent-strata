import { beforeEach, describe, expect, test } from "bun:test";
import {
  HIDDEN_PROVIDERS_KEY,
  isProviderVisible,
  modelPickerOptions,
  readHiddenProviders,
  serializeHiddenProviders,
  setProviderHidden,
  showAllProviders,
  visibleModels,
  visibleProviders,
} from "./provider-visibility";

function store(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("provider visibility", () => {
  beforeEach(() => showAllProviders(store()));

  test("is empty when nothing is stored", () => {
    expect(readHiddenProviders(store())).toEqual(new Set());
  });

  test("round trips the hidden ids in a stable order", () => {
    const s = store();
    setProviderHidden("openai", true, s);
    setProviderHidden("anthropic", true, s);
    expect(readHiddenProviders(s)).toEqual(new Set(["anthropic", "openai"]));
    expect(s.map.get(HIDDEN_PROVIDERS_KEY)).toBe('["anthropic","openai"]');
  });

  test("malformed and mistyped storage read as no hidden providers", () => {
    expect(readHiddenProviders(store({ [HIDDEN_PROVIDERS_KEY]: "not json" }))).toEqual(new Set());
    expect(readHiddenProviders(store({ [HIDDEN_PROVIDERS_KEY]: "{}" }))).toEqual(new Set());
    expect(readHiddenProviders(store({ [HIDDEN_PROVIDERS_KEY]: "[1, 2, null]" }))).toEqual(new Set());
  });

  test("blank and duplicate entries are dropped", () => {
    expect(
      readHiddenProviders(store({ [HIDDEN_PROVIDERS_KEY]: '["a", "", "a", "b"]' })),
    ).toEqual(new Set(["a", "b"]));
  });

  test("hiding and showing one provider leaves the rest alone", () => {
    const s = store();
    showAllProviders(s);
    setProviderHidden("a", true, s);
    setProviderHidden("b", true, s);
    setProviderHidden("a", false, s);
    expect(readHiddenProviders(s)).toEqual(new Set(["b"]));
    expect(isProviderVisible("a", readHiddenProviders(s))).toBe(true);
    expect(isProviderVisible("b", readHiddenProviders(s))).toBe(false);
  });

  test("show all clears both the signal and the stored list", () => {
    const s = store();
    setProviderHidden("a", true, s);
    showAllProviders(s);
    expect(readHiddenProviders(s)).toEqual(new Set());
    expect(s.map.get(HIDDEN_PROVIDERS_KEY)).toBe("[]");
  });

  test("filters providers and their models by the same ids", () => {
    const hidden = new Set(["other-department"]);
    expect(
      visibleProviders(
        [{ id: "mine" }, { id: "other-department" }],
        hidden,
      ).map((row) => row.id),
    ).toEqual(["mine"]);
    expect(
      visibleModels(
        [
          { providerID: "mine", modelID: "m1" },
          { providerID: "other-department", modelID: "m2" },
        ],
        hidden,
      ).map((model) => model.modelID),
    ).toEqual(["m1"]);
  });

  test("the model picker drops hidden providers but keeps a hidden current model", () => {
    const models = [
      { providerID: "mine", modelID: "m1" },
      { providerID: "other", modelID: "o1" },
    ];
    expect(
      modelPickerOptions(models, "mine/m1", new Set(["other"]), {
        hidden: "Hidden",
        unavailable: "Unavailable",
      }),
    ).toEqual([
      { value: "mine/m1", label: "m1", group: "mine" },
    ]);
    expect(
      modelPickerOptions(models, "other/o1", new Set(["other"]), {
        hidden: "Hidden",
        unavailable: "Unavailable",
      }),
    ).toEqual([
      { value: "other/o1", label: "o1", group: "Hidden" },
      { value: "mine/m1", label: "m1", group: "mine" },
    ]);
  });

  test("a current model the server no longer lists is kept as unavailable", () => {
    expect(
      modelPickerOptions(
        [{ providerID: "mine", modelID: "m1" }],
        "gone/g1",
        new Set(),
        { hidden: "Hidden", unavailable: "Unavailable" },
      ),
    ).toEqual([
      { value: "gone/g1", label: "g1", group: "Unavailable" },
      { value: "mine/m1", label: "m1", group: "mine" },
    ]);
  });

  test("serializes as the same bytes regardless of insertion order", () => {
    expect(serializeHiddenProviders(new Set(["b", "a"]))).toBe(
      serializeHiddenProviders(new Set(["a", "b"])),
    );
  });
});
