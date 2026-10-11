/** Just enough of `opencode serve` for a driver to connect, plus whatever a test adds. */
export function fakeOpencode(
  routes: Record<string, (url: URL, req: Request) => Response | Promise<Response>> = {},
  sockets?: {
    message(ws: { send(data: string | Uint8Array): void }, message: string | Uint8Array): void;
  },
) {
  const seen: { path: string; query: URLSearchParams; method: string; body: string }[] = [];
  const enc = new TextEncoder();
  const listeners = new Set<(frame: unknown) => void>();
  // cancel and push share `send`; a closed controller must not be enqueued on.
  const stream = (first: unknown) => {
    let remove: () => void = () => {};
    return new Response(
      new ReadableStream({
        start(ctrl) {
          let open = true;
          const send = (frame: unknown) => {
            if (!open) return;
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
          };
          send(first);
          listeners.add(send);
          remove = () => {
            open = false;
            listeners.delete(send);
          };
        },
        cancel() {
          remove();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: {
      message(ws, message) {
        if (!sockets) return;
        sockets.message(ws, typeof message === "string" ? message : new Uint8Array(message));
      },
    },
    async fetch(req, server) {
      const url = new URL(req.url);
      if (sockets && url.pathname.endsWith("/connect")) {
        seen.push({ path: url.pathname, query: url.searchParams, method: req.method, body: "" });
        if (server.upgrade(req)) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
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
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    seen,
    push(frame: unknown) {
      for (const send of listeners) send(frame);
    },
    stop: () => server.stop(true),
  };
}
