import { afterAll, describe, expect, test } from "bun:test";
import { OPENCODE_EXTENSION_PATHS, opencodeExtension } from "../src/opencode-extension";

describe("opencode extension", () => {
  const seen: { path: string; query: string; auth: string | null }[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, query: url.search, auth: req.headers.get("authorization") });
      if (url.pathname === "/find/file" && !url.searchParams.get("query"))
        return Response.json({ error: "query required" }, { status: 400 });
      return Response.json({ path: url.pathname, directory: url.searchParams.get("directory") });
    },
  });
  afterAll(() => upstream.stop(true));
  const baseUrl = `http://127.0.0.1:${upstream.port}`;

  test("a read goes to the same path with the caller's query and strata's directory", async () => {
    const ext = opencodeExtension({ baseUrl, directory: "/conn" });
    const res = await ext.get(
      "/find/file",
      new URLSearchParams({ query: "driver", limit: "5", directory: "/elsewhere" }),
      "/repo",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/find/file", directory: "/repo" });
    const q = new URLSearchParams(seen.at(-1)!.query);
    expect(q.get("query")).toBe("driver");
    expect(q.get("limit")).toBe("5");
    expect(q.getAll("directory")).toEqual(["/repo"]);
  });

  test("without a session directory the connection's own is used, and none at all is fine", async () => {
    await opencodeExtension({ baseUrl, directory: "/conn" }).get("/vcs", new URLSearchParams());
    expect(new URLSearchParams(seen.at(-1)!.query).get("directory")).toBe("/conn");
    await opencodeExtension({ baseUrl, directory: "/conn" }).get("/vcs", new URLSearchParams(), "");
    expect(new URLSearchParams(seen.at(-1)!.query).get("directory")).toBe("/conn");
    await opencodeExtension({ baseUrl: `${baseUrl}/` }).get(
      "/vcs",
      new URLSearchParams({ directory: "/sneaky", workspace: "wrk_other" }),
    );
    expect(seen.at(-1)).toMatchObject({ path: "/vcs", query: "" });
  });

  test("the server's basic auth pair rides along", async () => {
    await opencodeExtension({ baseUrl, username: "opencode", password: "pw" }).get("/path", new URLSearchParams());
    expect(seen.at(-1)!.auth).toBe(`Basic ${btoa("opencode:pw")}`);
    await opencodeExtension({ baseUrl }).get("/path", new URLSearchParams());
    expect(seen.at(-1)!.auth).toBeNull();
  });

  test("the server's own error status comes back as is", async () => {
    const res = await opencodeExtension({ baseUrl }).get("/find/file", new URLSearchParams());
    expect(res.status).toBe(400);
  });

  test("a path off the list never leaves strata", async () => {
    const before = seen.length;
    const res = await opencodeExtension({ baseUrl }).get("/config", new URLSearchParams());
    expect(res.status).toBe(404);
    expect(seen.length).toBe(before);
    expect(OPENCODE_EXTENSION_PATHS.has("/config")).toBe(false);
    expect(OPENCODE_EXTENSION_PATHS.has("/command")).toBe(true);
  });
});
