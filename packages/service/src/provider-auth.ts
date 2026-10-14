/** API-key providers. The key is written to OpenCode and never copied into a response. */

const PROVIDER_ID = /^[\w.-]+$/;
const KEY_MAX = 4096;

export interface ProviderPrompt {
  type: "text" | "select";
  key: string;
  message: string;
  placeholder?: string;
  options?: { label: string; value: string }[];
  when?: { key: string; op: "eq" | "neq"; value: string };
}

export interface ProviderMethod {
  index: number;
  type: "api" | "oauth";
  label: string;
  prompts?: ProviderPrompt[];
}

export interface ApiProvider {
  id: string;
  name: string;
  connected: boolean;
  methods: ProviderMethod[];
  /**
   * An API key can be pasted for this one. A row with no `methods` has no
   * sign-in choice to offer, so without this the page cannot tell "nothing to
   * do here" apart from "a key is exactly what this wants".
   */
  canKey: boolean;
}

/**
 * The vendors to put in front of someone who asked which ones people actually
 * use, in the order to read them.
 *
 * OpenCode's auth table only ever names vendors with an OAuth flow, which in
 * practice means the overseas ones. The API-key vendors — the ones anyone
 * outside that list reaches for first — are absent from the page entirely, so
 * there was nowhere to paste their key. Ids are the ones OpenCode's provider
 * catalog actually carries (`kimi` is `moonshotai-cn`, GLM is `zhipuai`); the
 * display names are ours because upstream's say "Zhipu AI" and "Moonshot AI",
 * which is no help to someone looking for GLM or Kimi.
 *
 * **Region matters more than it looks.** Most of these vendors run two
 * platforms on two domains, and the catalog carries both as separate entries:
 * `minimax` is `api.minimax.io`, `minimax-cn` is `api.minimax.cn`; `zai` is
 * `api.z.ai`, `zhipuai` is `open.bigmodel.cn`; likewise `moonshotai` /
 * `moonshotai-cn`, `siliconflow` / `siliconflow-cn`, `alibaba` /
 * `alibaba-cn`. A key bought on the Chinese platform does not work on the
 * international one, so this list is the `-cn` side throughout. DeepSeek,
 * OpenCode Go, Volcengine and ModelScope publish a single endpoint and need no
 * such choice.
 *
 * The catalog behind this is a couple of hundred entries. Listing all of them
 * would trade one unusable list for a longer one, which is why this is a short
 * list rather than a filter over everything.
 */
const COMMON: readonly { id: string; name: string }[] = [
  { id: "deepseek", name: "DeepSeek" },
  { id: "minimax-cn", name: "MiniMax (minimax.cn)" },
  { id: "zhipuai", name: "Zhipu AI (GLM)" },
  { id: "moonshotai-cn", name: "Moonshot AI (Kimi)" },
  { id: "opencode-go", name: "OpenCode Go" },
  { id: "alibaba-cn", name: "Alibaba (Qwen)" },
  { id: "siliconflow-cn", name: "SiliconFlow (siliconflow.cn)" },
  { id: "volcengine", name: "Volcengine Ark" },
  { id: "modelscope", name: "ModelScope" },
  { id: "stepfun", name: "StepFun" },
];

export interface OAuthStart {
  url: string;
  method: "auto" | "code";
  instructions: string;
}

export interface ProviderApi {
  list(): Promise<ApiProvider[]>;
  setKey(id: string, key: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** `method` is the index in OpenCode's own method list. */
  authorize(id: string, method: number, inputs: Record<string, string> | undefined, signal?: AbortSignal): Promise<OAuthStart>;
  callback(id: string, method: number, code: string | undefined, signal?: AbortSignal): Promise<void>;
}

export class ProviderAuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function providerId(raw: string): string | undefined {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (!PROVIDER_ID.test(id) || id === "." || id === ".." || id.includes("..")) return undefined;
  return id;
}

/** A key OpenCode will store. Empty and oversized values are refused. */
export function apiCredential(key: unknown): { type: "api"; key: string } | undefined {
  if (typeof key !== "string") return undefined;
  const trimmed = key.trim();
  if (!trimmed || trimmed.length > KEY_MAX) return undefined;
  return { type: "api", key: trimmed };
}

/**
 * Providers OpenCode can sign in: an API key, OAuth, or both.
 * `key`, `options`, and `models` on the upstream objects are dropped on purpose.
 * `index` is the method's place in OpenCode's list, which authorize requires.
 */
export function apiProviders(list: unknown, methods: unknown): ApiProvider[] {
  const catalog =
    list && typeof list === "object" ? (list as { all?: unknown; connected?: unknown }) : {};
  const all = Array.isArray(catalog.all) ? catalog.all : [];
  const connected = new Set(
    Array.isArray(catalog.connected)
      ? catalog.connected.filter((id): id is string => typeof id === "string")
      : [],
  );
  const names = new Map<string, string>();
  for (const row of all) {
    if (!row || typeof row !== "object") continue;
    const id = (row as { id?: unknown }).id;
    if (typeof id !== "string" || !PROVIDER_ID.test(id)) continue;
    const name = (row as { name?: unknown }).name;
    names.set(id, typeof name === "string" && name.trim() ? name.trim() : id);
  }
  const table =
    methods && typeof methods === "object" && !Array.isArray(methods)
      ? (methods as Record<string, unknown>)
      : {};
  const out: ApiProvider[] = [];
  for (const [id, value] of Object.entries(table)) {
    if (!PROVIDER_ID.test(id) || !Array.isArray(value)) continue;
    const methodsForProvider: ProviderMethod[] = [];
    value.forEach((method, index) => {
      if (!method || typeof method !== "object") return;
      const type = (method as { type?: unknown }).type;
      if (type !== "api" && type !== "oauth") return;
      const labelRaw = (method as { label?: unknown }).label;
      const label = typeof labelRaw === "string" && labelRaw.trim() ? labelRaw.trim() : type === "api" ? "API key" : "OAuth";
      const prompts = providerPrompts((method as { prompts?: unknown }).prompts);
      methodsForProvider.push({ index, type, label, ...(prompts.length ? { prompts } : {}) });
    });
    if (methodsForProvider.length === 0) continue;
    out.push({
      id,
      name: names.get(id) ?? id,
      connected: connected.has(id),
      methods: methodsForProvider,
      canKey: methodsForProvider.some((method) => method.type === "api"),
    });
  }
  // Whatever `connected` names has a credential the server can use, and it
  // answers the instant one is written or deleted — there is no cache to wait
  // out. It used to be filtered on `source === "api"`, meant to separate a
  // stored key from one that merely shares an env var.
  //
  // That field is a generation behind. Measured against opencode 1.18.35: a key
  // written through the API reads `source: "custom"` for the whole life of the
  // process and only becomes `"api"` after a restart. So the filter hid the row
  // the user had just saved, and this second pass was the reason "保存后没反应"
  // and "断开后还亮着" were one bug rather than two.
  //
  // The cost of dropping it: a provider that is connected only because a shared
  // env var or an OpenCode account covers it now reads as 已接入 too, and the
  // disconnect action on such a row has nothing stored to remove. It is still
  // the server's own answer, and a row that works but says 未接入 is the worse
  // lie.
  const listed = new Set(out.map((row) => row.id));
  for (const id of connected) {
    if (!PROVIDER_ID.test(id) || listed.has(id)) continue;
    listed.add(id);
    out.push({ id, name: names.get(id) ?? id, connected: true, methods: [], canKey: true });
  }
  // And the vendors nobody has keyed yet but should still be able to: without
  // this they are not on the page, and with `methods: []` there was nothing to
  // open. `names.has` is the membership test that matters — a vendor OpenCode's
  // catalog does not carry cannot take a key, however well known it is here.
  // `connected` stays false on purpose: a stored credential was already claimed
  // by the pass above, and repeating the test for "shares an env var" here is
  // how a vendor nobody signed into ends up under 已接入.
  for (const entry of COMMON) {
    if (listed.has(entry.id) || !names.has(entry.id)) continue;
    listed.add(entry.id);
    out.push({ id: entry.id, name: entry.name, connected: false, methods: [], canKey: true });
  }
  const rank = new Map(COMMON.map((entry, index) => [entry.id, index]));
  const unranked = Number.MAX_SAFE_INTEGER;
  out.sort(
    (a, b) =>
      Number(b.connected) - Number(a.connected) ||
      (rank.get(a.id) ?? unranked) - (rank.get(b.id) ?? unranked) ||
      a.name.localeCompare(b.name),
  );
  return out;
}

function providerPrompts(raw: unknown): ProviderPrompt[] {
  if (!Array.isArray(raw)) return [];
  const out: ProviderPrompt[] = [];
  for (const prompt of raw) {
    if (!prompt || typeof prompt !== "object" || out.length >= 8) continue;
    const row = prompt as { type?: unknown; key?: unknown; message?: unknown; placeholder?: unknown; options?: unknown; when?: unknown };
    if ((row.type !== "text" && row.type !== "select") || typeof row.key !== "string" || !/^[\w.-]+$/.test(row.key)) continue;
    if (typeof row.message !== "string" || !row.message.trim()) continue;
    const next: ProviderPrompt = { type: row.type, key: row.key, message: row.message.trim().slice(0, 200) };
    if (typeof row.placeholder === "string" && row.placeholder.trim()) next.placeholder = row.placeholder.trim().slice(0, 80);
    if (row.type === "select" && Array.isArray(row.options)) {
      const options = row.options.flatMap((option) => {
        if (!option || typeof option !== "object") return [];
        const label = (option as { label?: unknown }).label;
        const value = (option as { value?: unknown }).value;
        if (typeof label !== "string" || typeof value !== "string" || !label.trim() || !value.trim()) return [];
        return [{ label: label.trim().slice(0, 80), value: value.trim().slice(0, 80) }];
      });
      if (options.length === 0) continue;
      next.options = options.slice(0, 20);
    }
    if (row.when && typeof row.when === "object") {
      const when = row.when as { key?: unknown; op?: unknown; value?: unknown };
      if (typeof when.key === "string" && (when.op === "eq" || when.op === "neq") && typeof when.value === "string") {
        next.when = { key: when.key, op: when.op, value: when.value.slice(0, 80) };
      }
    }
    out.push(next);
  }
  return out;
}

export function methodIndex(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 32) return undefined;
  return raw;
}

/** Prompt answers. Anything that is not a short string is dropped. */
export function oauthInputs(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= 12) break;
    if (!/^[\w.-]+$/.test(key) || typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 500) continue;
    out[key] = trimmed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function oauthCode(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return undefined;
  return trimmed;
}

/** The page needs the address and the instructions. Anything else, including a token, stays out. */
export function oauthStart(raw: unknown): OAuthStart | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as { url?: unknown; method?: unknown; instructions?: unknown };
  if (typeof row.url !== "string" || (row.method !== "auto" && row.method !== "code")) return undefined;
  if (typeof row.instructions !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(row.url);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  return { url: row.url, method: row.method, instructions: row.instructions.slice(0, 2000) };
}

export async function providerRoute(
  req: Request,
  pathname: string,
  lookup: (id: string) => ProviderApi | undefined,
): Promise<Response | undefined> {
  const listed = pathname.match(/^\/connections\/([^/]+)\/providers$/);
  const oauth = pathname.match(/^\/connections\/([^/]+)\/providers\/([^/]+)\/oauth$/);
  const callback = pathname.match(/^\/connections\/([^/]+)\/providers\/([^/]+)\/oauth\/callback$/);
  const one = pathname.match(/^\/connections\/([^/]+)\/providers\/([^/]+)$/);
  const hit = listed ?? oauth ?? callback ?? one;
  if (!hit) return undefined;
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const fail = (e: unknown) => {
    const status = e instanceof ProviderAuthError ? e.status : 502;
    return json({ error: e instanceof Error ? e.message : "provider auth failed" }, status);
  };
  let connectionId: string;
  try {
    connectionId = decodeURIComponent(hit[1]!);
  } catch {
    return json({ error: "not found" }, 404);
  }
  const api = lookup(connectionId);
  if (!api) return json({ error: "backend cannot manage providers" }, 400);
  if (listed) {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    try {
      return json({ providers: await api.list() });
    } catch (e) {
      return fail(e);
    }
  }
  const id = providerId(hit[2]!);
  if (!id) return json({ error: "not found" }, 404);
  if (oauth || callback) {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const body = (await req.json().catch(() => null)) as { method?: unknown; inputs?: unknown; code?: unknown } | null;
    const method = methodIndex(body?.method);
    if (method === undefined) return json({ error: "method required" }, 400);
    try {
      if (oauth) {
        const start = await api.authorize(id, method, oauthInputs(body?.inputs), req.signal);
        return json(start);
      }
      const code = oauthCode(body?.code);
      await api.callback(id, method, code, req.signal);
      return json({ ok: true });
    } catch (e) {
      return fail(e);
    }
  }
  if (req.method === "DELETE") {
    try {
      await api.remove(id);
      return json({ ok: true });
    } catch (e) {
      return fail(e);
    }
  }
  if (req.method !== "PUT") return json({ error: "method not allowed" }, 405);
  const body = (await req.json().catch(() => null)) as { key?: unknown } | null;
  const credential = apiCredential(body?.key);
  if (!credential) return json({ error: "key required" }, 400);
  try {
    await api.setKey(id, credential.key);
    return json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

/** Upstream text is safe to show only when it does not repeat the key. */
export function safeProviderError(text: string, secret: string): string {
  const fallback = "provider auth failed";
  if (!text || (secret && text.includes(secret))) return fallback;
  let message = text;
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
    const picked = typeof parsed.message === "string" ? parsed.message : parsed.error;
    if (typeof picked === "string") message = picked;
  } catch {
    // the body was not JSON
  }
  if (!message || message.length > 200 || (secret && message.includes(secret))) return fallback;
  return message;
}
