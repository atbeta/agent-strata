/** Just enough of `opencode serve` for a driver to connect, plus whatever a test adds. */
export function fakeOpencode(
  routes: Record<string, (url: URL, req: Request) => Response | Promise<Response>> = {},
) {
  const seen: { path: string; query: URLSearchParams; method: string; body: string }[] = [];
  const stream = (frame: unknown) =>
    new Response(
      new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? "" : await req.clone().text();
      seen.push({ path: url.pathname, query: url.searchParams, method: req.method, body });
      if (url.pathname === "/global/event")
        return stream({ directory: "/repo", payload: { type: "server.connected", properties: {} } });
      if (url.pathname === "/event") return stream({ type: "server.connected", properties: {} });
      const route = routes[url.pathname];
      if (route) return route(url, req);
      if (url.pathname === "/session" || url.pathname === "/project") return Response.json([]);
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
}
