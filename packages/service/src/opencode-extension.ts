import type { BackendExtension } from "./driver";
import { apiCredential, apiProviders, providerId, ProviderAuthError, safeProviderError } from "./provider-auth";
import { PTY_ID, TerminalError, ptyInfo, ptyShells, type PtyInfo } from "./terminal";

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
  const send = (method: string, path: string, directory: string | undefined, body?: unknown) => {
    const q = new URLSearchParams();
    if (directory) q.set("directory", directory);
    const ticket = path.endsWith("/connect-token");
    return doFetch(`${base}${path}?${q}`, {
      method,
      headers: {
        ...headers,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        // tells OpenCode this is a connect-ticket mint, not a browser CSRF
        ...(ticket ? { "x-opencode-ticket": "1" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  };
  const read = async (res: Response): Promise<unknown> => {
    if (!res.ok) throw new TerminalError("terminal failed", res.status === 404 ? 404 : 502);
    return res.json().catch(() => undefined);
  };
  const readJson = async (res: Response, secret = ""): Promise<unknown> => {
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderAuthError(safeProviderError(text, secret), res.status === 404 ? 404 : 502);
    }
    return res.json().catch(() => undefined);
  };
  const one = async (res: Response): Promise<PtyInfo> => {
    const info = ptyInfo(await read(res));
    if (!info) throw new TerminalError("terminal failed", 502);
    return info;
  };
  return {
    kind: "opencode",
    paths: OPENCODE_EXTENSION_PATHS,
    terminal: {
      shells: async (directory) => ptyShells(await read(await send("GET", "/pty/shells", directory))),
      list: async (directory) => {
        const rows = await read(await send("GET", "/pty", directory));
        if (!Array.isArray(rows)) return [];
        return rows.flatMap((row) => {
          const info = ptyInfo(row);
          return info && info.status === "running" ? [info] : [];
        });
      },
      create: async (directory, command, title) => {
        const body: { cwd: string; command?: string; title?: string } = { cwd: directory };
        if (command) body.command = command;
        if (title) body.title = title;
        return one(await send("POST", "/pty", directory, body));
      },
      remove: async (directory, id) => {
        if (!PTY_ID.test(id)) throw new TerminalError("not found", 404);
        await read(await send("DELETE", `/pty/${encodeURIComponent(id)}`, directory));
      },
      resize: async (directory, id, size) => {
        if (!PTY_ID.test(id)) throw new TerminalError("not found", 404);
        await read(await send("PUT", `/pty/${encodeURIComponent(id)}`, directory, { size }));
      },
      open: async (directory, id) => {
        if (!PTY_ID.test(id)) throw new TerminalError("not found", 404);
        const minted = (await read(await send("POST", `/pty/${encodeURIComponent(id)}/connect-token`, directory))) as {
          ticket?: unknown;
        };
        if (!minted || typeof minted.ticket !== "string" || minted.ticket.length === 0)
          throw new TerminalError("terminal failed", 502);
        const url = new URL(`${base}/pty/${encodeURIComponent(id)}/connect`);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("directory", directory);
        url.searchParams.set("ticket", minted.ticket);
        return { url: url.toString(), headers: { ...headers } };
      },
    },
    providers: {
      async list() {
        const [listed, methods] = await Promise.all([
          send("GET", "/provider", opts.directory).then((res) => readJson(res)),
          send("GET", "/provider/auth", opts.directory).then((res) => readJson(res)),
        ]);
        return apiProviders(listed, methods);
      },
      async setKey(id, key) {
        const provider = providerId(id);
        const credential = apiCredential(key);
        if (!provider || !credential) throw new ProviderAuthError("key required", 400);
        await readJson(await send("PUT", `/auth/${encodeURIComponent(provider)}`, opts.directory, credential), credential.key);
      },
      async remove(id) {
        const provider = providerId(id);
        if (!provider) throw new ProviderAuthError("not found", 404);
        await readJson(await send("DELETE", `/auth/${encodeURIComponent(provider)}`, opts.directory));
      },
    },
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
