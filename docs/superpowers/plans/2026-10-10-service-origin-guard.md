# Service Origin Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No page the user visits in a browser can drive the strata service: every route gets the loopback-Host check, the another-site check and shell-only CORS that the extension plane already has.

**Architecture:** The origin helpers move out of `extension-route.ts` into `shell-origin.ts`. `Bun.serve`'s `fetch` becomes a thin guard — refuse a non-loopback Host or a request another site made, answer preflights for shell origins only, then call the existing router and stamp shell CORS on its response. The global `access-control-allow-origin: *` goes away.

**Tech Stack:** Bun 1.3, TypeScript, `bun:test`.

## Why

Today every response carries `access-control-allow-origin: *`, the global `OPTIONS` handler grants any preflight, and write routes parse JSON whatever the content-type. So any page can, with a no-preflight `text/plain` POST:

- `POST /connect` `{ "backend": "acp", "command": "<anything>" }` — strata spawns that command;
- `POST /sessions/:id/prompt` — the agent runs whatever the page asks, and the page reads the result back from `/sessions/:id/view` because `*` makes it readable.

A DNS-rebound page (attacker domain resolving to 127.0.0.1) reaches the same routes as a same-origin page; only the Host header gives it away.

## Who must keep working

| Caller | Origin | Sec-Fetch-Site | Host |
|---|---|---|---|
| packaged Windows shell | `http://tauri.localhost` | cross-site | `127.0.0.1:7700` |
| packaged macOS/Linux shell | `tauri://localhost` | cross-site | `127.0.0.1:7700` |
| `tauri dev` | `http://localhost:5178` | cross-site | `127.0.0.1:7700` |
| browser dev via Vite `/api` proxy (no `changeOrigin`) | absent on GET, `http://localhost:5178` on POST | same-origin | `localhost:5178` |
| scripts, tests, curl, Tauri Rust side | absent | absent | `127.0.0.1:<port>` |

All pass `isLoopbackHost` and `!fromAnotherSite` as they are written today. The desktop check for the extension plane already exercised the first rows' Origin handling on a real shell.

## Files

- Create: `packages/service/src/shell-origin.ts` — `SHELL_ORIGINS`, `isLoopbackHost`, `shellCors`, `fromAnotherSite` moved verbatim from `extension-route.ts`.
- Modify: `packages/service/src/extension-route.ts` — import those four from `./shell-origin`; keep its own checks (it is tested standalone).
- Modify: `packages/service/src/index.ts` — the guard; drop `cors`.
- Modify: `packages/service/test/extension.test.ts` — import helpers from `../src/shell-origin`.
- Modify: `packages/service/test/service.test.ts` — the `*` assertion, plus a new describe for the guard.
- Modify: `README.md` — Security model.

### Task 1: Guard every route

- [ ] **Step 1: Write the failing tests** in `packages/service/test/service.test.ts`.

Replace, in the test `"health, sessions, events, view, compare, export"`:

```ts
    expect(healthRes.headers.get("access-control-allow-origin")).toBe("*");
```

with:

```ts
    expect(healthRes.headers.get("access-control-allow-origin")).toBeNull();
```

and the bare `OPTIONS /connect` preflight just below it stays as is (no Origin: a non-browser caller; 204 is still right).

Add a new top-level describe at the end of the file:

```ts
describe("only the desktop shell reaches the service from a browser", () => {
  let svc: ReturnType<typeof startService>;
  let base = "";
  beforeAll(() => {
    svc = startService({ db: ":memory:", port: 0 });
    base = `http://127.0.0.1:${svc.port}`;
  });
  afterAll(() => svc.stop());
  const connections = async () =>
    ((await fetch(`${base}/connections`).then((r) => r.json())) as { connections: unknown[] }).connections.length;

  test("a page on another site cannot make strata run a command", async () => {
    const res = await fetch(`${base}/connect`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "text/plain" },
      body: JSON.stringify({ backend: "acp", command: "calc.exe" }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(await connections()).toBe(0);
  });

  test("a request another site made the browser send, or a rebound Host, goes nowhere", async () => {
    expect((await fetch(`${base}/sync`, { method: "POST", headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await fetch(`${base}/sessions`, { headers: { origin: "null" } })).status).toBe(403);
    expect((await fetch(`${base}/stream`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${base}/health`, { headers: { host: "evil.example" } })).status).toBe(403);
  });

  test("a preflight is granted to the shell and nobody else", async () => {
    const ask = (origin: string) =>
      fetch(`${base}/connect`, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
      });
    const shell = await ask("http://tauri.localhost");
    expect(shell.status).toBe(204);
    expect(shell.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost");
    expect(shell.headers.get("access-control-allow-methods")).toContain("POST");
    expect(shell.headers.get("access-control-allow-headers")).toBe("content-type");
    expect((await ask("https://evil.example")).status).toBe(403);
  });

  test("the shell reads every route cross-origin, the dev proxy reads it same-origin", async () => {
    for (const origin of ["http://tauri.localhost", "tauri://localhost", "http://localhost:5178"]) {
      const res = await fetch(`${base}/health`, { headers: { origin, "sec-fetch-site": "cross-site" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("vary")).toContain("origin");
    }
    const proxied = await fetch(`${base}/sync`, {
      method: "POST",
      headers: { host: "localhost:5178", origin: "http://localhost:5178", "sec-fetch-site": "same-origin" },
    });
    expect(proxied.status).toBe(200);
    const stream = await fetch(`${base}/stream`, { headers: { origin: "http://tauri.localhost" } });
    expect(stream.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost");
    await stream.body?.cancel();
  });
});
```

Make sure `beforeAll`/`afterAll` are in the file's `bun:test` import. If Bun's `fetch` silently replaces a `host` header you set (check: the rebound-Host assertion passes before the implementation, or `/sync` with `host: localhost:5178` is seen with a different Host), replace those two Host assertions with direct calls on the exported guard (see Step 3) and say so in the report.

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test packages/service/test/service.test.ts`
Expected: the `*` assertion and the new describe fail (403s come back 200, preflight from evil gets 204, `*` instead of echoed origin).

- [ ] **Step 3: Implement**

`packages/service/src/shell-origin.ts`: move `SHELL_ORIGINS` (with its comment, reworded so it speaks of the whole service, not just extension reads), `isLoopbackHost`, `shellCors`, `fromAnotherSite` from `extension-route.ts` unchanged in behaviour. Add:

```ts
/** A browser request strata must refuse: a rebound Host, or another site's page. */
export function refused(req: Request): boolean {
  return (
    !isLoopbackHost(req.headers.get("host")) ||
    fromAnotherSite(req.headers.get("origin"), req.headers.get("sec-fetch-site"))
  );
}
```

`extension-route.ts`: import `fromAnotherSite`, `isLoopbackHost`, `shellCors` (or `refused`) from `./shell-origin`; drop the moved code; behaviour unchanged.

`index.ts`:

- import `refused`, `shellCors` from `./shell-origin`.
- delete the `cors` constant and its comment; `json` sends only `content-type`; the `/stream` response drops `...cors`.
- rename the current `async fetch(req) { ... }` body into a local `async function route(req: Request): Promise<Response>` defined before `Bun.serve`, minus its first `OPTIONS` line.
- `Bun.serve({ ..., async fetch(req) { ... } })` becomes:

```ts
    async fetch(req) {
      // The desktop UI calls this process from the shell's origin (packaged:
      // tauri.localhost; dev: the Vite port); no other page may drive it.
      const allow = { vary: "origin", ...shellCors(req.headers.get("origin")) };
      if (refused(req)) return Response.json({ error: "forbidden" }, { status: 403, headers: allow });
      if (req.method === "OPTIONS")
        return new Response(null, {
          status: 204,
          headers: {
            ...allow,
            "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
            "access-control-allow-headers": "content-type",
          },
        });
      const res = await route(req);
      for (const [k, v] of Object.entries(allow)) res.headers.set(k, v);
      return res;
    },
```

If any route returns a `Response` whose headers are immutable (a `fetch()` result passed straight through), wrap it in `new Response(res.body, res)` before setting; the extension route already rebuilds its response.

- [ ] **Step 4: Run tests**

Run: `bun test packages/service/test/service.test.ts packages/service/test/extension.test.ts`
Expected: all pass.

- [ ] **Step 5: README**

In `README.md` → Security model, replace the sentence starting "Extension reads (`/…/opencode/<path>`) reach files…" through "…does not have these checks yet." with:

```markdown
The HTTP API listens on the loopback address only and refuses any request whose Host is not `127.0.0.1`/`localhost` (a DNS-rebound page) or that another site's page made the browser send; only the desktop shell's origins can read its responses cross-origin. Extension reads (`/…/opencode/<path>`) reach files on this machine, so on top of that they are GET-only and allow-listed.
```

- [ ] **Step 6: Full checks and commit**

Run: `bun test` → 0 fail. `bun run typecheck` → `$LASTEXITCODE` 0.

```powershell
git add packages/service/src/shell-origin.ts packages/service/src/extension-route.ts packages/service/src/index.ts packages/service/test/service.test.ts packages/service/test/extension.test.ts README.md
git commit -m "fix(service): refuse requests other sites make and grant cors to the shell only"
```

- [ ] **Step 7: Live check (controller)**

Restart the service on 7700, run `bun run scripts/probe-extension.ts` and `bun run scripts/probe-stream.ts`, and check `POST /connect` with `Origin: https://evil.example` is 403. Then the user opens the desktop (`tauri dev`) and confirms the session list loads, a prompt streams, and connect/disconnect work.
