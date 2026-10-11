import { describe, expect, test } from "bun:test";
import { apiCredential, apiProviders, oauthStart, providerId, safeProviderError } from "../src/provider-auth";

const secret = "sk-live-secret";

describe("api providers", () => {
  test("an api method is listed and the key is not", () => {
    const rows = apiProviders(
      {
        all: [
          { id: "anthropic", name: "Anthropic", key: secret, options: { token: secret }, models: { a: { key: secret } } },
          { id: "copilot", name: "GitHub Copilot" },
        ],
        connected: ["anthropic"],
      },
      {
        anthropic: [{ type: "api", label: "API key" }, { type: "oauth", label: "Claude Max" }],
        copilot: [{ type: "oauth", label: "Sign in" }],
        "other/nope": [{ type: "api", label: "API key" }],
      },
    );
    expect(rows).toEqual([
      {
        id: "anthropic",
        name: "Anthropic",
        connected: true,
        methods: [
          { index: 0, type: "api", label: "API key" },
          { index: 1, type: "oauth", label: "Claude Max" },
        ],
      },
      {
        id: "copilot",
        name: "GitHub Copilot",
        connected: false,
        methods: [{ index: 0, type: "oauth", label: "Sign in" }],
      },
    ]);
    expect(JSON.stringify(rows).includes(secret)).toBe(false);
  });

  test("a provider known only by its auth method still appears", () => {
    const rows = apiProviders({}, { groq: [{ type: "api", label: "API key" }] });
    expect(rows).toEqual([
      { id: "groq", name: "groq", connected: false, methods: [{ index: 0, type: "api", label: "API key" }] },
    ]);
  });

  test("a key is the api credential, and a blank one is refused", () => {
    expect(apiCredential(`  ${secret}  `)).toEqual({ type: "api", key: secret });
    expect(apiCredential("   ")).toBeUndefined();
    expect(apiCredential(1)).toBeUndefined();
  });

  test("a provider id is a single path segment", () => {
    expect(providerId("anthropic")).toBe("anthropic");
    expect(providerId("a%2Fb")).toBeUndefined();
    expect(providerId("..")).toBeUndefined();
  });

  test("an upstream error that repeats the key is not shown", () => {
    expect(safeProviderError(JSON.stringify({ message: `bad ${secret}` }), secret)).toBe("provider auth failed");
    expect(safeProviderError(JSON.stringify({ message: "invalid key" }), secret)).toBe("invalid key");
  });

  test("an oauth start keeps the address and drops everything else", () => {
    expect(
      oauthStart({
        url: "https://auth.example/start?ticket=secret-ticket",
        method: "code",
        instructions: "paste the code",
        access_token: secret,
      }),
    ).toEqual({
      url: "https://auth.example/start?ticket=secret-ticket",
      method: "code",
      instructions: "paste the code",
    });
    expect(oauthStart({ url: "javascript:alert(1)", method: "auto", instructions: "go" })).toBeUndefined();
  });
});
