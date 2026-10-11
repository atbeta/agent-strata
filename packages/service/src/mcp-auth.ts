const CODE_MAX = 2048;

/** The code the user pasted. Empty and oversized values are refused. */
export function mcpAuthCode(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const code = raw.trim();
  if (!code || code.length > CODE_MAX) return undefined;
  return code;
}

/**
 * What the page may see after OpenCode starts MCP OAuth.
 * `oauthState` and every other field are dropped. An empty URL means the server
 * was already signed in. Anything other than http(s) is refused.
 */
export function mcpAuthStartView(body: unknown): { url: string } | { ok: true } {
  if (!body || typeof body !== "object") throw new Error("mcp auth failed");
  const row = body as { url?: unknown; authorizationUrl?: unknown; ok?: unknown };
  const url =
    typeof row.url === "string" ? row.url : typeof row.authorizationUrl === "string" ? row.authorizationUrl : "";
  if (!url) return { ok: true };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("mcp auth failed");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("mcp auth failed");
  return { url };
}
