import type { BackendDriver } from "./driver";
import { fromAnotherSite, isLoopbackHost, shellCors } from "./shell-origin";

/** GET /connections/:id/<kind>/<path> and /sessions/:id/<kind>/<path>; undefined for anything else. */
export async function extensionRoute(
  req: Request,
  url: URL,
  resolve: {
    connection(id: string): BackendDriver | undefined;
    /** undefined unless the session belongs to a connected driver and has a workspace */
    session(casfId: string): { driver: BackendDriver; directory: string } | undefined;
  },
): Promise<Response | undefined> {
  const m = url.pathname.match(/^\/(connections|sessions)\/([^/]+)\/([a-z]+)(\/.+)$/);
  if (!m) return undefined;
  const origin = req.headers.get("origin");
  const headers: Record<string, string> = {
    vary: "origin",
    "x-content-type-options": "nosniff",
    // whatever the backend answers with must never run as this origin's page
    "content-security-policy": "sandbox",
    ...shellCors(origin),
  };
  const fail = (status: number, error: string) => Response.json({ error }, { status, headers });
  if (req.method !== "GET") return fail(405, "method not allowed");
  if (!isLoopbackHost(req.headers.get("host")) || fromAnotherSite(origin, req.headers.get("sec-fetch-site")))
    return fail(403, "forbidden");
  let id: string;
  try {
    id = decodeURIComponent(m[2]!);
  } catch {
    return fail(404, "not found");
  }
  const kind = m[3]!;
  const path = m[4]!;
  let driver: BackendDriver | undefined;
  let directory: string | undefined;
  if (m[1] === "sessions") {
    const owned = resolve.session(id);
    driver = owned?.driver;
    directory = owned?.directory;
  } else {
    // a directory named by the caller could make the backend open, and load the
    // config of, any folder on this machine
    driver = resolve.connection(id);
  }
  const ext = driver?.extension;
  if (!ext || ext.kind !== kind || !ext.paths.has(path)) return fail(404, "not found");
  const query = new URLSearchParams(url.searchParams);
  if (path === "/session/diff") {
    query.delete("session");
    const native = m[1] === "sessions" ? driver?.nativeId(id) : undefined;
    if (native && /^[\w.-]+$/.test(native)) query.set("session", native);
  }
  try {
    const res = await ext.get(path, query, directory, req.signal);
    return new Response(res.body, {
      status: res.status,
      headers: { ...headers, "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (e) {
    return fail(502, String(e));
  }
}
