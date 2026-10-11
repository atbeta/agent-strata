/** API-key providers. The key is written to OpenCode and never copied into a response. */

const PROVIDER_ID = /^[\w.-]+$/;
const KEY_MAX = 4096;

export interface ApiProvider {
  id: string;
  name: string;
  connected: boolean;
  label: string;
}

export interface ProviderApi {
  list(): Promise<ApiProvider[]>;
  setKey(id: string, key: string): Promise<void>;
  remove(id: string): Promise<void>;
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
 * Providers that accept an API key. `key`, `options`, and `models` on the
 * upstream objects are dropped on purpose.
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
    const api = value.find(
      (method) => method && typeof method === "object" && (method as { type?: unknown }).type === "api",
    ) as { label?: unknown } | undefined;
    if (!api) continue;
    const label = typeof api.label === "string" && api.label.trim() ? api.label.trim() : "API key";
    out.push({ id, name: names.get(id) ?? id, connected: connected.has(id), label });
  }
  out.sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
  return out;
}

export async function providerRoute(
  req: Request,
  pathname: string,
  lookup: (id: string) => ProviderApi | undefined,
): Promise<Response | undefined> {
  const listed = pathname.match(/^\/connections\/([^/]+)\/providers$/);
  const one = pathname.match(/^\/connections\/([^/]+)\/providers\/([^/]+)$/);
  if (!listed && !one) return undefined;
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  let connectionId: string;
  try {
    connectionId = decodeURIComponent((listed ?? one)![1]!);
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
      const status = e instanceof ProviderAuthError ? e.status : 502;
      return json({ error: e instanceof Error ? e.message : "provider auth failed" }, status);
    }
  }
  const id = providerId(one![2]!);
  if (!id) return json({ error: "not found" }, 404);
  if (req.method === "DELETE") {
    try {
      await api.remove(id);
      return json({ ok: true });
    } catch (e) {
      const status = e instanceof ProviderAuthError ? e.status : 502;
      return json({ error: e instanceof Error ? e.message : "provider auth failed" }, status);
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
    const status = e instanceof ProviderAuthError ? e.status : 502;
    return json({ error: e instanceof Error ? e.message : "provider auth failed" }, status);
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
