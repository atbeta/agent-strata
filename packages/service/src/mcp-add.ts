/** A server the page can add. OpenCode stores this on the running process. */
export type McpServerConfig =
  | { type: "local"; command: string[] }
  | { type: "remote"; url: string };

export type McpAddRequest = { name: string; config: McpServerConfig };

const NAME = /^[\w][\w.-]{0,63}$/;

/** The page sends a name plus a command line or an http(s) URL, never a config file. */
export function mcpAddRequest(body: unknown): McpAddRequest | { error: string } {
  if (!body || typeof body !== "object") return { error: "name required" };
  const raw = body as { name?: unknown; command?: unknown; url?: unknown };
  if (typeof raw.name !== "string" || !raw.name.trim()) return { error: "name required" };
  const name = raw.name.trim();
  if (!NAME.test(name) || name.includes("..")) return { error: "invalid name" };
  const hasCommand = raw.command !== undefined && raw.command !== "";
  const hasUrl = raw.url !== undefined && raw.url !== "";
  if (hasCommand && hasUrl) return { error: "command or url" };
  if (!hasCommand && !hasUrl) return { error: "command or url" };
  if (hasCommand) {
    if (typeof raw.command !== "string") return { error: "invalid command" };
    const command = splitCommand(raw.command);
    if (!command) return { error: "invalid command" };
    return { name, config: { type: "local", command } };
  }
  if (typeof raw.url !== "string") return { error: "invalid url" };
  const url = remoteUrl(raw.url);
  if (!url) return { error: "invalid url" };
  return { name, config: { type: "remote", url } };
}

/** Drop an upstream error that repeats the command or the URL. */
export function safeMcpError(err: unknown, secret: { command?: string[]; url?: string }): string {
  const text = err instanceof Error ? err.message : String(err);
  const needles = [...(secret.command ?? []), secret.url ?? ""].filter((part) => part.length >= 8);
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 200 || needles.some((part) => trimmed.includes(part))) return "mcp add failed";
  return trimmed;
}

function splitCommand(input: string): string[] | undefined {
  const text = input.trim();
  if (!text || text.length > 2000) return undefined;
  const out: string[] = [];
  let cur = "";
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '"') quote = false;
      else cur += ch;
      continue;
    }
    if (ch === '"') {
      quote = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (!cur) continue;
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (quote || !cur) return undefined;
  out.push(cur);
  if (out.length > 16 || out.some((part) => part.length > 400)) return undefined;
  return out;
}

function remoteUrl(input: string): string | undefined {
  const text = input.trim();
  if (!text || text.length > 2000) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return url.toString();
}
