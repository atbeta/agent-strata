import type { BackendExtension } from "./driver";
import { apiCredential, apiProviders, oauthStart, providerId, ProviderAuthError, safeProviderError } from "./provider-auth";
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
  // the backend's own tool table — what the capability probe reads
  "/experimental/tool/ids",
  // v2's plugin catalogue — what the capability probe reads there
  "/plugin",
]);

const TIMEOUT_MS = 15_000;

/** A workspace-relative path. `..`, an absolute path, and an empty read are refused. */
function safeRelative(raw: string, allowRoot: boolean): string | undefined {
  const path = raw.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!path || path === ".") return allowRoot ? "." : undefined;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return undefined;
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined;
  return parts.join("/");
}

function encodeRelative(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function textual(mime: string): boolean {
  const value = mime.toLowerCase();
  return (
    value.startsWith("text/") ||
    value.includes("json") ||
    value.includes("javascript") ||
    value.includes("xml") ||
    value.includes("yaml") ||
    value.includes("svg")
  );
}

function fileNodes(rows: unknown, directory: string | undefined) {
  if (!Array.isArray(rows)) return [];
  const root = directory ? directory.replace(/[\\/]+$/, "") : "";
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as { path?: unknown; type?: unknown; ignored?: unknown };
    if (typeof item.path !== "string" || !item.path || item.path === ".") continue;
    const path = item.path.replace(/\/+$/, "");
    if (!safeRelative(path, false)) continue;
    const name = path.split("/").filter(Boolean).at(-1) ?? path;
    out.push({
      name,
      path,
      absolute: root ? `${root}/${path}` : path,
      type: item.type === "directory" ? "directory" : "file",
      ignored: item.ignored === true,
    });
  }
  return out;
}

export function opencodeExtension(opts: {
  baseUrl: string;
  apiVersion?: "v1" | "v2";
  directory?: string;
  username?: string;
  password?: string;
  fetch?: typeof fetch;
}): BackendExtension {
  const base = `${opts.baseUrl.replace(/\/+$/, "")}${opts.apiVersion === "v2" ? "/api" : ""}`;
  const headers: Record<string, string> =
    opts.username !== undefined || opts.password !== undefined
      ? { authorization: `Basic ${btoa(`${opts.username ?? ""}:${opts.password ?? ""}`)}` }
      : {};
  const doFetch = opts.fetch ?? fetch;
  const send = (method: string, path: string, directory: string | undefined, body?: unknown, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (directory) q.set("directory", directory);
    const ticket = path.endsWith("/connect-token");
    const timeout = AbortSignal.timeout(signal ? 300_000 : TIMEOUT_MS);
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
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  };
  const unwrap = (value: unknown): unknown => {
    if (opts.apiVersion !== "v2" || !value || typeof value !== "object" || Array.isArray(value)) return value;
    const body = value as { data?: unknown; location?: unknown };
    return body.location !== undefined && body.data !== undefined ? body.data : value;
  };
  const read = async (res: Response): Promise<unknown> => {
    if (!res.ok) throw new TerminalError("terminal failed", res.status === 404 ? 404 : 502);
    return unwrap(await res.json().catch(() => undefined));
  };
  const readJson = async (res: Response, secret = ""): Promise<unknown> => {
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderAuthError(safeProviderError(text, secret), res.status === 404 ? 404 : 502);
    }
    return unwrap(await res.json().catch(() => undefined));
  };
  const one = async (res: Response): Promise<PtyInfo> => {
    const info = ptyInfo(await read(res));
    if (!info) throw new TerminalError("terminal failed", 502);
    return info;
  };
  const v2Files = async (path: string, query: URLSearchParams, directory: string | undefined, signal?: AbortSignal) => {
    const loc = new URLSearchParams();
    if (directory) loc.set("location[directory]", directory);
    const timed = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
    const fetchOpts = { headers, redirect: "error" as const, signal: timed };
    if (path === "/file/content") {
      const rel = safeRelative(query.get("path") ?? "", false);
      if (!rel) return new Response(null, { status: 404 });
      const qs = loc.toString();
      const res = await doFetch(`${base}/fs/read/${encodeRelative(rel)}${qs ? `?${qs}` : ""}`, fetchOpts);
      if (!res.ok) return res;
      const mime = res.headers.get("content-type")?.split(";")[0]?.trim();
      if (mime && !textual(mime)) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        return Response.json({
          type: "binary",
          content: Buffer.from(bytes).toString("base64"),
          encoding: "base64",
          mimeType: mime,
        });
      }
      return Response.json({ type: "text", content: await res.text(), ...(mime ? { mimeType: mime } : {}) });
    }
    if (path === "/find/file") {
      const q = query.get("query") ?? "";
      if (!q) return Response.json({ error: "query required" }, { status: 400 });
      loc.set("query", q);
      const limit = query.get("limit");
      if (limit) loc.set("limit", limit);
      const res = await doFetch(`${base}/fs/find?${loc}`, fetchOpts);
      if (!res.ok) return res;
      const rows = unwrap(await res.json().catch(() => undefined));
      const paths = Array.isArray(rows)
        ? rows.flatMap((row) => {
            if (!row || typeof row !== "object") return [];
            const found = (row as { path?: unknown }).path;
            return typeof found === "string" && found ? [found.replace(/\/+$/, "")] : [];
          })
        : [];
      return Response.json(paths);
    }
    const rel = safeRelative(query.get("path") ?? "", true);
    if (!rel) return new Response(null, { status: 404 });
    loc.set("path", rel);
    const res = await doFetch(`${base}/fs/list?${loc}`, fetchOpts);
    if (!res.ok) return res;
    return Response.json(fileNodes(unwrap(await res.json().catch(() => undefined)), directory));
  };
  return {
    kind: "opencode",
    ...(opts.apiVersion ? { apiVersion: opts.apiVersion } : {}),
    paths: OPENCODE_EXTENSION_PATHS,
    // The server keeps one instance per directory: watchers, language servers,
    // and the file handles behind them. On Windows those handles keep a folder
    // from emptying, and only the server's own lifetime used to release them —
    // which is why a deleted worktree went away after the app was restarted.
    // Disposing the directory's instance is what the restart was doing, done
    // at the moment the folder is actually going away.
    dispose: async (directory) => {
      await read(await send("POST", "/instance/dispose", directory));
    },
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
      create: async (directory, input) => {
        const body: Record<string, unknown> = { cwd: input.cwd ?? directory };
        if (input.command) body.command = input.command;
        if (input.args) body.args = input.args;
        if (input.title) body.title = input.title;
        if (input.env) body.env = input.env;
        if (input.rows && input.cols) body.size = { rows: input.rows, cols: input.cols };
        return one(await send("POST", "/pty", directory, body));
      },
      get: async (directory, id) => {
        if (!PTY_ID.test(id)) throw new TerminalError("not found", 404);
        return one(await send("GET", `/pty/${encodeURIComponent(id)}`, directory));
      },
      remove: async (directory, id) => {
        if (!PTY_ID.test(id)) throw new TerminalError("not found", 404);
        await read(await send("DELETE", `/pty/${encodeURIComponent(id)}`, directory));
      },
      resize: async (directory, id, size) => {
        if (!PTY_ID.test(id)) throw new TerminalError("not found", 404);
        await read(await send("PUT", `/pty/${encodeURIComponent(id)}`, directory, { size }));
      },
      open: async (directory, id, cursor) => {
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
        if (cursor !== undefined) url.searchParams.set("cursor", String(cursor));
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
      async authorize(id, method, inputs, signal) {
        const provider = providerId(id);
        if (!provider) throw new ProviderAuthError("not found", 404);
        const table = await readJson(await send("GET", "/provider/auth", opts.directory));
        const rows =
          table && typeof table === "object" && !Array.isArray(table)
            ? (table as Record<string, unknown>)[provider]
            : undefined;
        const chosen = Array.isArray(rows) ? rows[method] : undefined;
        if (!chosen || typeof chosen !== "object" || (chosen as { type?: unknown }).type !== "oauth") {
          throw new ProviderAuthError("method required", 400);
        }
        const body: { method: number; inputs?: Record<string, string> } = { method };
        if (inputs) body.inputs = inputs;
        const started = oauthStart(
          await readJson(
            await send("POST", `/provider/${encodeURIComponent(provider)}/oauth/authorize`, opts.directory, body, signal),
          ),
        );
        if (!started) throw new ProviderAuthError("provider auth failed", 502);
        return started;
      },
      async callback(id, method, code, signal) {
        const provider = providerId(id);
        if (!provider) throw new ProviderAuthError("not found", 404);
        const body: { method: number; code?: string } = { method };
        if (code) body.code = code;
        await readJson(
          await send("POST", `/provider/${encodeURIComponent(provider)}/oauth/callback`, opts.directory, body, signal),
          code ?? "",
        );
      },
    },
    async get(path, query, directory, signal) {
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
      if (opts.apiVersion === "v2" && (path === "/file" || path === "/file/content" || path === "/find/file")) {
        return v2Files(path, q, dir, signal);
      }
      if (dir) q.set("directory", dir);
      const qs = q.toString();
      const res = await doFetch(`${base}${upstream}${qs ? `?${qs}` : ""}`, {
        headers,
        // the credentials are for this server only
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
      });
      if (opts.apiVersion !== "v2" || !res.ok) return res;
      const body = unwrap(await res.json().catch(() => undefined));
      return Response.json(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    },
  };
}
