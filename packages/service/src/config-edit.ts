/** OpenCode config. A failed check never reaches the write. */

const MAX = 262_144;

export interface ConfigApi {
  read(directory: string): Promise<unknown>;
  write(directory: string, patch: Record<string, unknown>): Promise<void>;
}

export function configDocument(text: string): { config: Record<string, unknown> } | { error: string } {
  if (typeof text !== "string" || !text.trim() || text.length > MAX) return { error: "invalid config" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "invalid config" };
  }
  if (!isRecord(parsed)) return { error: "invalid config" };
  return { config: parsed };
}

/**
 * Keys whose values changed. A missing key is a removal, which this OpenCode
 * build merges back in, so the write is refused and the file stays as it was.
 */
export function configPatch(
  before: unknown,
  after: unknown,
): { patch: Record<string, unknown> } | { error: "removed" | "same" } {
  if (!isRecord(before) || !isRecord(after)) return { error: "removed" };
  if (hasRemoval(before, after)) return { error: "removed" };
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) patch[key] = after[key];
  }
  if (Object.keys(patch).length === 0) return { error: "same" };
  return { patch };
}

/** An upstream error that repeats a config value is not shown. */
export function safeConfigError(err: unknown, patch: Record<string, unknown>): string {
  const text = err instanceof Error ? err.message : String(err);
  const secrets = leafValues(patch).filter((value) => value.length >= 12);
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 300 || secrets.some((value) => trimmed.includes(value))) return "config update failed";
  return trimmed;
}

/** The directory must be one this connection already has open. */
export function configDirectory(raw: string | null, known: string[]): string | undefined {
  const wanted = (raw ?? "").trim() || known[0];
  if (!wanted || wanted.length > 1024 || wanted.includes("\0")) return undefined;
  if (wanted.split(/[\\/]/).includes("..")) return undefined;
  const needle = normalize(wanted);
  return known.find((dir) => normalize(dir) === needle);
}

export async function configRoute(
  req: Request,
  pathname: string,
  url: URL,
  lookup: (id: string) =>
    | {
        directory?: string;
        config: ConfigApi;
        known(): Promise<string[]>;
      }
    | undefined,
): Promise<Response | undefined> {
  const hit = pathname.match(/^\/connections\/([^/]+)\/config$/);
  if (!hit) return undefined;
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  if (req.method !== "GET" && req.method !== "PATCH") return json({ error: "method not allowed" }, 405);
  let connectionId: string;
  try {
    connectionId = decodeURIComponent(hit[1]!);
  } catch {
    return json({ error: "not found" }, 404);
  }
  const conn = lookup(connectionId);
  if (!conn) return json({ error: "backend cannot edit config" }, 400);
  const known = await conn.known().catch(() => [] as string[]);
  const dirs = [...(conn.directory ? [conn.directory] : []), ...known];
  const directory = configDirectory(url.searchParams.get("directory"), dirs);
  if (!directory) return json({ error: "directory required" }, 400);
  if (req.method === "GET") {
    try {
      const config = await conn.config.read(directory);
      if (!isRecord(config)) return json({ error: "config update failed" }, 502);
      return json({ config });
    } catch (e) {
      return json({ error: safeConfigError(e, {}) }, 502);
    }
  }
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX + 64) return json({ error: "invalid config" }, 400);
  let text: unknown;
  try {
    text = (JSON.parse(raw) as { text?: unknown }).text;
  } catch {
    return json({ error: "invalid config" }, 400);
  }
  if (typeof text !== "string") return json({ error: "invalid config" }, 400);
  const parsed = configDocument(text);
  if ("error" in parsed) return json(parsed, 400);
  let current: unknown;
  try {
    current = await conn.config.read(directory);
  } catch (e) {
    return json({ error: safeConfigError(e, {}) }, 502);
  }
  const diff = configPatch(current, parsed.config);
  if ("error" in diff) {
    if (diff.error === "same") return json({ ok: true });
    return json({ error: "config cannot remove fields" }, 400);
  }
  try {
    await conn.config.write(directory, diff.patch);
    return json({ ok: true });
  } catch (e) {
    return json({ error: safeConfigError(e, diff.patch) }, 502);
  }
}

function hasRemoval(before: unknown, after: unknown): boolean {
  if (Array.isArray(before) || Array.isArray(after)) return false;
  if (!isRecord(before) || !isRecord(after)) return false;
  for (const key of Object.keys(before)) {
    if (!Object.prototype.hasOwnProperty.call(after, key)) return true;
    if (hasRemoval(before[key], after[key])) return true;
  }
  return false;
}

function leafValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(leafValues);
  if (isRecord(value)) return Object.values(value).flatMap(leafValues);
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
