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
  "/session/diff",
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
    get(path, query, directory, signal) {
      if (!OPENCODE_EXTENSION_PATHS.has(path)) return Promise.resolve(new Response(null, { status: 404 }));
      const q = new URLSearchParams(query);
      // Where the read happens is strata's to choose (the session's directory,
      // else the connection's), never the caller's.
      q.delete("directory");
      q.delete("workspace");
      let upstream = path;
      if (path === "/session/diff") {
        const session = q.get("session");
        q.delete("session");
        // The id is placed in the path. Anything else would let a query pick a
        // different session, or walk out of this one.
        if (!session || !/^[\w.-]+$/.test(session)) return Promise.resolve(new Response(null, { status: 404 }));
        upstream = `/session/${encodeURIComponent(session)}/diff`;
      }
      const dir = directory || opts.directory;
      if (dir) q.set("directory", dir);
      const qs = q.toString();
      return doFetch(`${base}${upstream}${qs ? `?${qs}` : ""}`, {
        headers,
        // the credentials are for this server only
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
      });
    },
  };
}
