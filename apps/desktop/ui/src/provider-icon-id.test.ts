import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { providerIconId } from "./provider-icon-id";
import { PROVIDER_ICON_FALLBACK, PROVIDER_ICONS } from "./provider-icons/names";

const sprite = readFileSync(join(import.meta.dir, "provider-icons", "sprite.svg"), "utf8");

describe("a provider's icon", () => {
  test("a known id draws its own mark", () => {
    expect(providerIconId("anthropic")).toBe("anthropic");
    expect(providerIconId("OpenAI")).toBe("openai");
  });

  test("regional and plan variants share the one drawing", () => {
    expect(providerIconId("minimax-cn")).toBe(providerIconId("minimax"));
    expect(providerIconId("opencode-go")).toBe(providerIconId("opencode"));
  });

  test("a suffix nobody catalogued falls back to the provider it extends", () => {
    expect(providerIconId("anthropic-work")).toBe("anthropic");
    expect(providerIconId("openai-proxy-eu")).toBe("openai");
  });

  test("an unknown or missing provider still gets a mark", () => {
    expect(providerIconId("no-such-provider")).toBe(PROVIDER_ICON_FALLBACK);
    expect(providerIconId("")).toBe(PROVIDER_ICON_FALLBACK);
    expect(providerIconId(undefined)).toBe(PROVIDER_ICON_FALLBACK);
  });

  test("every id the table names is a symbol the sprite holds", () => {
    const symbols = new Set([...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
    expect(symbols.has(PROVIDER_ICON_FALLBACK)).toBe(true);
    for (const target of Object.values(PROVIDER_ICONS)) expect(symbols.has(target)).toBe(true);
  });
});
