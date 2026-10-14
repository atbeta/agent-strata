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
        canKey: true,
      },
      {
        id: "copilot",
        name: "GitHub Copilot",
        connected: false,
        methods: [{ index: 0, type: "oauth", label: "Sign in" }],
        canKey: false,
      },
    ]);
    expect(JSON.stringify(rows).includes(secret)).toBe(false);
  });

  test("a credential with no sign-in method is listed, connected or not", () => {
    const rows = apiProviders(
      {
        all: [
          { id: "deepseek", name: "DeepSeek", source: "api" },
          { id: "minimax", name: "MiniMax", source: "env" },
          { id: "openai", name: "OpenAI" },
        ],
        connected: ["deepseek", "minimax"],
      },
      { openai: [{ type: "api", label: "API key" }] },
    );
    // `source` is ignored on purpose: opencode only relabels it on restart, so
    // a key saved a moment ago still reads "custom" and filtering on it would
    // hide the row the user had just saved.
    expect(rows).toEqual([
      { id: "deepseek", name: "DeepSeek", connected: true, methods: [], canKey: true },
      { id: "minimax", name: "MiniMax", connected: true, methods: [], canKey: true },
      { id: "openai", name: "OpenAI", connected: false, methods: [{ index: 0, type: "api", label: "API key" }], canKey: true },
    ]);
  });

  test("a key saved this second is already connected", () => {
    // Verbatim the shape opencode answers with straight after a PUT: named as
    // connected, still labelled "custom" because it only relabels on restart.
    const rows = apiProviders({ all: [{ id: "deepseek", name: "DeepSeek", source: "custom" }], connected: ["deepseek"] }, {});
    expect(rows).toEqual([{ id: "deepseek", name: "DeepSeek", connected: true, methods: [], canKey: true }]);
  });

  test("a provider connected only by a shared env var is not hidden either", () => {
    const rows = apiProviders({ all: [{ id: "opencode-go", name: "OpenCode Go", source: "custom" }], connected: ["opencode-go"] }, {});
    expect(rows).toEqual([{ id: "opencode-go", name: "OpenCode Go", connected: true, methods: [], canKey: true }]);
  });

  test("a provider known only by its auth method still appears", () => {
    const rows = apiProviders({}, { groq: [{ type: "api", label: "API key" }] });
    expect(rows).toEqual([
      { id: "groq", name: "groq", connected: false, methods: [{ index: 0, type: "api", label: "API key" }], canKey: true },
    ]);
  });

  test("the vendors that only ever wanted a key are listed ahead of the rest", () => {
    const rows = apiProviders(
      {
        all: [
          { id: "azure", name: "Azure" },
          { id: "deepseek", name: "DeepSeek" },
          // The China platform, not `moonshotai` on api.moonshot.ai: a key
          // bought on one does not work on the other.
          { id: "moonshotai-cn", name: "Moonshot AI (China)" },
          { id: "github-copilot", name: "GitHub Copilot" },
        ],
        connected: [],
      },
      {
        azure: [{ type: "api", label: "API key" }],
        "github-copilot": [{ type: "oauth", label: "Sign in" }],
      },
    );
    // No sign-in method, so the page used to refuse to open these rows at all —
    // there was nowhere to paste the key they exist for.
    expect(rows.slice(0, 2)).toEqual([
      { id: "deepseek", name: "DeepSeek", connected: false, methods: [], canKey: true },
      { id: "moonshotai-cn", name: "Moonshot AI (Kimi)", connected: false, methods: [], canKey: true },
    ]);
    expect(rows.map((row) => row.id)).toEqual(["deepseek", "moonshotai-cn", "azure", "github-copilot"]);
  });

  test("the international half of a split vendor is not listed", () => {
    // Same vendors, wrong platform: everything here resolves, and listing it
    // would hand out an entry whose endpoint the key does not work against.
    const rows = apiProviders(
      {
        all: [
          { id: "minimax", name: "MiniMax (minimax.io)" },
          { id: "moonshotai", name: "Moonshot AI" },
          { id: "zai", name: "Z.AI" },
          { id: "siliconflow", name: "SiliconFlow" },
          { id: "alibaba", name: "Alibaba" },
        ],
        connected: [],
      },
      {},
    );
    expect(rows).toEqual([]);
  });

  test("a vendor OpenCode does not carry is not invented", () => {
    const rows = apiProviders({ all: [{ id: "azure", name: "Azure" }], connected: [] }, { azure: [{ type: "api", label: "API key" }] });
    expect(rows.map((row) => row.id)).toEqual(["azure"]);
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
