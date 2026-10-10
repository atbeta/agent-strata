import type { BackendExtension } from "./driver";

/** Read-only OpenCode endpoints the desktop may reach through strata. */
export const OPENCODE_EXTENSION_PATHS: ReadonlySet<string> = new Set([
  "/find/file",
  "/find",
  "/find/symbol",
  "/file",
  "/file/content",
  "/file/status",
  "/command",
  "/agent",
  "/skill",
  "/vcs",
  "/vcs/diff",
  "/lsp",
  "/mcp",
  "/formatter",
  "/path",
]);

const TIMEOUT_MS = 15_000;

export function opencodeExtension(opts: {
  baseUrl: string;
  directory?: string;
  username?: string;
  password?: string;
  fetch?: typeof fetch;
}): BackendExtension {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> =
    opts.username !== undefined || opts.password !== undefined
      ? { authorization: `Basic ${btoa(`${opts.username ?? ""}:${opts.password ?? ""}`)}` }
      : {};
  const doFetch = opts.fetch ?? fetch;
  return {
    kind: "opencode",
    paths: OPENCODE_EXTENSION_PATHS,
    get(path, query, directory) {
      if (!OPENCODE_EXTENSION_PATHS.has(path)) return Promise.resolve(new Response(null, { status: 404 }));
      const q = new URLSearchParams(query);
      // Where the read happens is strata's to choose (the session's directory,
      // else the connection's), never the caller's.
      q.delete("directory");
      q.delete("workspace");
      const dir = directory || opts.directory;
      if (dir) q.set("directory", dir);
      const qs = q.toString();
      return doFetch(`${base}${path}${qs ? `?${qs}` : ""}`, {
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    },
  };
}
