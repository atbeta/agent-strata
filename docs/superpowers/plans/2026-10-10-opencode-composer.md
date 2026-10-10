# OpenCode Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The session composer does what OpenCode Desktop's does: `@` completes workspace files and attaches them, `/` lists and runs the backend's commands, pasted / dropped / picked images and PDFs go along with the message and show as thumbnails in the user bubble, and Tab cycles the primary agent.

**Architecture:** Three planes as in the roadmap.
- *Command plane:* `BackendDriver.prompt` takes a `PromptPart[]` instead of a string; a new optional `BackendDriver.command` runs a backend command. Service routes: `POST /sessions/:id/prompt` (now `parts`, `text` kept as shorthand), `POST /sessions/:id/command`, `GET /sessions/:id/capabilities`.
- *Session record:* the OpenCode mapper drops the synthetic text OpenCode injects when it reads an attached file, maps image file parts to CASF `image` blocks, and its version goes up so stored sessions are rebuilt.
- *Extension plane:* the composer reads `/command` and `/find/file` through the existing read-only passthrough.
- *UI:* pure composer logic in `composer-input.ts` (unit-tested), the suggestion menu and attachment strip in `composer-menu.tsx`, wired into the existing composer in `session-detail.tsx`.

**Tech Stack:** Bun 1.3, TypeScript, `bun:test`, `@opencode-ai/sdk` 1.18.35 (v2 client), Solid + Tailwind + Kobalte UI, Tauri v2.

**Constraints:** `.superpowers/sdd-composer/constraints.md`.

---

## Facts verified live against OpenCode 1.18.32 (do not re-verify)

1. **`@file`.** `POST /session/:id/prompt_async` with parts `[{ type: "text", text: "@hello.txt what is …" }, { type: "file", mime: "text/plain", filename: "hello.txt", url: "file:///C:/…/hello.txt", source: { type: "file", path: "hello.txt", text: { value: "@hello.txt", start: 0, end: 10 } } }]` → the model answers from the file. OpenCode stores the user message as: the text part, **two `text` parts with `synthetic: true`** ("Called the Read tool with the following input: …" and the file's contents wrapped in `<path>…<content>…`), then the file part (url, mime, filename, source as sent).
2. **Image.** A file part `{ type: "file", mime: "image/png", filename: "red.png", url: "data:image/png;base64,…" }` with a text part → the default model answers "Red." The stored user message has the text part and the file part with the full data URL; no `source`. An undecodable image makes OpenCode emit `session.error` (`ImageDecodeError`), store **no** message and emit **no** `session.status` — so a UI waiting for idle would wait forever. The UI must only attach images it could decode.
3. **`session.command`.** `POST /session/:id/command` body `{ command, arguments, agent?, model?: "provider/model", variant?, parts?: FilePartInput[] }`. It answers **only when the whole run is done** (32.7 s for `/init`). Aborting the HTTP request after 300 ms does **not** stop the run: it completes and is stored. An unknown command answers `500 {"name":"UnknownError","data":{"message":"Unexpected server error…"}}` within ~200 ms and emits `session.error` "Command not found: …". The stored user message's text is the expanded template, not `/name`.
4. **Commands from the directory.** A file `<dir>/.opencode/command/echo.md` containing front matter `description: Echo the arguments back` and body `Reply with exactly the following words and nothing else, no tools: $ARGUMENTS` shows up in `GET /command?directory=<dir>` as `{ name: "echo", source: "command", description: "Echo the arguments back", … }`, and running it with `arguments: "banana split sundae"` makes the model reply `banana split sundae`.
5. **`/find/file`.** `?query=hel&limit=10` → `["hello.txt"]` (paths relative to the directory, `/`-separated). `query=` (empty) → `[]`.
6. **SDK.** `client.command.list({ directory })` → `{ data: Command[] }`. `client.session.command({ sessionID, directory, command, arguments, agent, model, variant, parts })` → `{ data?, error? }` (does not throw on HTTP errors). `client.session.promptAsync({ sessionID, directory, model, agent, parts })` with `parts: Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>`; `FilePartInput = { type: "file"; mime; filename?; url; source?: { type: "file"; path; text: { value; start; end } } | … }`.
7. **Projector.** A turn may have assistant messages and no `turn.user` (`TurnBlock` guards `props.turn.user`). `imageSrc` in `transcript.tsx` renders an `image` block from `uri`, from a `data:` string, or from `data` + `mime`.
8. **Tauri.** `apps/desktop/src-tauri/tauri.conf.json` does not set `dragDropEnabled`, so Tauri v2's default (`true`) takes file drops at the window level and HTML5 `drop` events never see the files.
9. **Service guard.** Since `995fc72` every route refuses non-loopback Hosts and other sites' requests; only the desktop shell gets CORS. The new routes need nothing extra.

---

## File map

| File | Change |
|---|---|
| `packages/service/src/driver.ts` | `PromptPart`, `CommandOpts`; `prompt(nativeId, parts, opts)`; optional `command`; capabilities `commands?`, `attachments?` |
| `packages/service/src/prompt-parts.ts` (new) | validate a request's parts |
| `packages/service/src/opencode-parts.ts` (new) | `PromptPart[]` → OpenCode `FilePartInput`/`TextPartInput` |
| `packages/service/src/opencode-driver.ts` | new `prompt`, `command`, capabilities |
| `packages/service/src/acp-driver.ts` | new `prompt` signature (text only) |
| `packages/service/src/index.ts` | `/prompt` parts, `/command`, `/capabilities` |
| `packages/adapter-opencode/src/index.ts` | `prompt(sessionID, parts, opts)`, `command(…)`; mapper: synthetic text, image blocks; `OPENCODE_MAPPER_VERSION = "opencode-4"` |
| `packages/service/test/fake-opencode.ts` | record method + body; routes get the request |
| `packages/service/test/prompt-parts.test.ts` (new), `packages/service/test/composer.test.ts` (new) | service tests |
| `packages/adapter-opencode/test/opencode.test.ts` | mapper tests |
| `apps/desktop/ui/src/api.ts` | `PromptPart`, `SessionCapabilities`, `CommandInfo`, `readCapabilities`, `readCommands`, `findFiles`, `sendPrompt`, `runCommand`; `readOpencode(…, signal)` |
| `apps/desktop/ui/src/composer-input.ts` (new) + `.test.ts` | triggers, insertion, parts, commands, agents, attachments |
| `apps/desktop/ui/src/composer-menu.tsx` (new) | `ComposerMenu`, `AttachmentStrip` |
| `apps/desktop/ui/src/session-detail.tsx` | wire it all into the composer |
| `apps/desktop/ui/src/icons.tsx` | `"attach"` icon |
| `apps/desktop/ui/src/locales/{zh,en}/session.ts` | strings |
| `apps/desktop/src-tauri/tauri.conf.json` | `"dragDropEnabled": false` |
| `scripts/probe-composer.ts` (new), `README.md` | acceptance probe, docs |

---

### Task 1: Prompts carry parts

**Files:** `driver.ts`, `prompt-parts.ts` (new), `opencode-parts.ts` (new), `opencode-driver.ts`, `acp-driver.ts`, `index.ts`, `adapter-opencode/src/index.ts` (`prompt` only), `fake-opencode.ts`, tests `prompt-parts.test.ts` (new), `composer.test.ts` (new).

- [ ] **Step 1: `fake-opencode.ts` records bodies.** Change it so routes receive the request and may be async, and `seen` records method and body text:

```ts
/** Just enough of `opencode serve` for a driver to connect, plus whatever a test adds. */
export function fakeOpencode(
  routes: Record<string, (url: URL, req: Request) => Response | Promise<Response>> = {},
) {
  const seen: { path: string; query: URLSearchParams; method: string; body: string }[] = [];
  // … stream() unchanged …
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? "" : await req.clone().text();
      seen.push({ path: url.pathname, query: url.searchParams, method: req.method, body });
      // … the rest unchanged, `route(url)` becomes `route(url, req)` …
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
}
```

Existing callers (`(url) => …`) keep compiling.

- [ ] **Step 2: Write the failing tests.**

`packages/service/test/prompt-parts.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readPromptParts, MAX_ATTACHMENT_BYTES } from "../src/prompt-parts";

const png = "data:image/png;base64,iVBORw0KGgo=";

describe("a prompt's parts", () => {
  test("text alone is shorthand for one text part", () => {
    expect(readPromptParts({ text: "hi" })).toEqual([{ type: "text", text: "hi" }]);
  });

  test("text, workspace files and attachments pass as sent", () => {
    const parts = [
      { type: "text", text: "@a.ts look" },
      { type: "file_ref", path: "src/a.ts", mention: { start: 0, end: 5 } },
      { type: "attachment", mime: "image/png", url: png, filename: "shot.png" },
    ];
    expect(readPromptParts({ parts })).toEqual(parts as never);
  });

  test("an attachment without words is a prompt", () => {
    expect(readPromptParts({ parts: [{ type: "attachment", mime: "application/pdf", url: "data:application/pdf;base64,JVBERi0=" }] })).toHaveLength(1);
  });

  test("nothing to send, or a part it cannot read, is refused with a reason", () => {
    const bad = (body: unknown) => {
      const r = readPromptParts(body as never);
      expect(Array.isArray(r)).toBe(false);
      return (r as { error: string }).error;
    };
    expect(bad({})).toMatch(/text or parts/);
    expect(bad({ parts: [] })).toMatch(/text or parts/);
    expect(bad({ parts: [{ type: "text", text: "  " }] })).toMatch(/text or parts/);
    expect(bad({ parts: [{ type: "video" }] })).toMatch(/part 0/);
    expect(bad({ parts: [{ type: "file_ref", path: "C:\\Windows\\win.ini" }] })).toMatch(/workspace/);
    expect(bad({ parts: [{ type: "file_ref", path: "/etc/passwd" }] })).toMatch(/workspace/);
    expect(bad({ parts: [{ type: "file_ref", path: "../outside.txt" }] })).toMatch(/workspace/);
    expect(bad({ parts: [{ type: "file_ref", path: "a.ts", mention: { start: 3, end: 1 } }] })).toMatch(/part 0/);
    expect(bad({ parts: [{ type: "attachment", mime: "text/html", url: "data:text/html;base64,PGI+" }] })).toMatch(/image or PDF/);
    expect(bad({ parts: [{ type: "attachment", mime: "image/png", url: "https://x/y.png" }] })).toMatch(/data URL/);
    expect(bad({ parts: [{ type: "attachment", mime: "image/png", url: "data:image/jpeg;base64,AA==" }] })).toMatch(/data URL/);
    const big = "data:image/png;base64," + "A".repeat(Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 8);
    expect(bad({ parts: [{ type: "attachment", mime: "image/png", url: big }] })).toMatch(/5 MB/);
  });
});
```

`packages/service/test/composer.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { startService } from "../src/index";
import { fakeOpencode } from "./fake-opencode";

const png = "data:image/png;base64,iVBORw0KGgo=";

describe("the composer through strata", () => {
  const upstream = fakeOpencode({
    "/session/ses_x/prompt_async": () => new Response(null, { status: 204 }),
  });
  let svc: ReturnType<typeof startService>;
  let base = "";
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const session = `/sessions/${encodeURIComponent("opencode:ses_x")}`;
  const sent = () =>
    JSON.parse(upstream.seen.filter((s) => s.path === "/session/ses_x/prompt_async").at(-1)!.body) as {
      parts: unknown[];
      agent?: string;
    };

  beforeAll(async () => {
    svc = startService({ db: ":memory:", port: 0 });
    base = `http://127.0.0.1:${svc.port}`;
    await post("/connect", { baseUrl: upstream.baseUrl, directory: "/conn" });
    svc.store.append([
      makeEvent({
        session_id: "opencode:ses_x",
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "x", workspace: "/repo/x" },
      } as EventInput),
    ]);
  });
  afterAll(() => {
    svc.stop();
    upstream.stop();
  });

  test("a session says what its backend's composer can do", async () => {
    expect(await fetch(`${base}${session}/capabilities`).then((r) => r.json())).toEqual({
      connected: true,
      prompt: true,
      abort: true,
      commands: true,
      attachments: true,
      extension: "opencode",
    });
    expect(
      await fetch(`${base}/sessions/${encodeURIComponent("acp:nobody:1")}/capabilities`).then((r) => r.json()),
    ).toEqual({ connected: false });
  });

  test("text, a workspace file and an image reach OpenCode as its own parts", async () => {
    const res = await post(`${session}/prompt`, {
      agent: "plan",
      parts: [
        { type: "text", text: "@src/a.ts and this" },
        { type: "file_ref", path: "src/a.ts", mention: { start: 0, end: 9 } },
        { type: "attachment", mime: "image/png", url: png, filename: "shot.png" },
      ],
    });
    expect(res.status).toBe(200);
    expect(sent()).toMatchObject({
      agent: "plan",
      parts: [
        { type: "text", text: "@src/a.ts and this" },
        {
          type: "file",
          mime: "text/plain",
          filename: "a.ts",
          url: pathToFileURL(resolve("/repo/x", "src/a.ts")).href,
          source: { type: "file", path: "src/a.ts", text: { value: "@src/a.ts", start: 0, end: 9 } },
        },
        { type: "file", mime: "image/png", url: png, filename: "shot.png" },
      ],
    });
  });

  test("the old text body still works, and a bad part never leaves strata", async () => {
    expect((await post(`${session}/prompt`, { text: "plain" })).status).toBe(200);
    expect(sent().parts).toEqual([{ type: "text", text: "plain" }]);
    const before = upstream.seen.length;
    const res = await post(`${session}/prompt`, { parts: [{ type: "file_ref", path: "../x" }] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/workspace/);
    expect(upstream.seen.length).toBe(before);
  });
});
```

And in `packages/service/test/service.test.ts`, in the existing ACP test that posts `{ text: "diff" }` to `/prompt`, add right after it:

```ts
    const withImage = await fetch(`${base}/sessions/${encodeURIComponent(created.id)}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "x" }, { type: "attachment", mime: "image/png", url: "data:image/png;base64,AA==" }] }),
    });
    expect(withImage.status).toBe(400);
    expect(((await withImage.json()) as { error: string }).error).toMatch(/attachments/);
```

(adapt the variable names — `base`, `created` — to the ones that test actually uses).

- [ ] **Step 3: Run them, watch them fail.** `bun test packages/service/test/prompt-parts.test.ts packages/service/test/composer.test.ts packages/service/test/service.test.ts` → module not found / 404 / 400 "text required".

- [ ] **Step 4: `driver.ts`.** Add, above `PromptOpts`:

```ts
/** One piece of a prompt. Paths are relative to the session's workspace. */
export type PromptPart =
  | { type: "text"; text: string }
  | {
      type: "file_ref";
      path: string;
      /** where the `@path` that picked it sits in the text part */
      mention?: { start: number; end: number };
    }
  | { type: "attachment"; mime: string; /** a data: URL */ url: string; filename?: string };
```

`BackendCapabilities` gains:

```ts
  /** run the backend's own commands (`/init`, …) */
  commands?: boolean;
  /** file and attachment parts in a prompt; without it only text goes through */
  attachments?: boolean;
```

`BackendDriver.prompt` becomes `prompt(nativeId: string, parts: PromptPart[], opts?: PromptOpts): Promise<void>;`.

- [ ] **Step 5: `prompt-parts.ts`.**

```ts
import { isAbsolute } from "node:path";
import type { PromptPart } from "./driver";

export const ATTACHMENT_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const inWorkspace = (path: string) =>
  path.length > 0 && !isAbsolute(path) && !/^[a-zA-Z]:/.test(path) && !/^[\\/]/.test(path) && !path.split(/[\\/]/).includes("..");

function readPart(p: unknown): PromptPart | string {
  if (!p || typeof p !== "object") return "not an object";
  const o = p as Record<string, unknown>;
  if (o.type === "text") return typeof o.text === "string" ? { type: "text", text: o.text } : "text must be a string";
  if (o.type === "file_ref") {
    if (typeof o.path !== "string" || !inWorkspace(o.path)) return "workspace";
    const m = o.mention as { start?: unknown; end?: unknown } | undefined;
    if (m === undefined) return { type: "file_ref", path: o.path };
    if (!Number.isInteger(m.start) || !Number.isInteger(m.end) || (m.start as number) < 0 || (m.end as number) <= (m.start as number))
      return "mention must be 0 <= start < end";
    return { type: "file_ref", path: o.path, mention: { start: m.start as number, end: m.end as number } };
  }
  if (o.type === "attachment") {
    if (typeof o.mime !== "string" || !ATTACHMENT_MIMES.has(o.mime)) return "attachments must be an image or PDF";
    if (typeof o.url !== "string" || !o.url.startsWith(`data:${o.mime};base64,`)) return "attachment url must be a data URL of its mime";
    const encoded = o.url.length - o.url.indexOf(",") - 1;
    if ((encoded * 3) / 4 > MAX_ATTACHMENT_BYTES) return "attachments are limited to 5 MB";
    if (o.filename !== undefined && typeof o.filename !== "string") return "filename must be a string";
    return { type: "attachment", mime: o.mime, url: o.url, ...(o.filename ? { filename: o.filename as string } : {}) };
  }
  return "unknown type";
}

/** The parts a request asks to send, or why they cannot be sent. */
export function readPromptParts(body: { parts?: unknown; text?: unknown } | null): PromptPart[] | { error: string } {
  const raw: unknown[] =
    Array.isArray(body?.parts) ? body.parts : typeof body?.text === "string" ? [{ type: "text", text: body.text }] : [];
  const parts: PromptPart[] = [];
  for (const [i, p] of raw.entries()) {
    const r = readPart(p);
    if (typeof r === "string")
      return { error: r === "workspace" ? `part ${i}: path must stay inside the session's workspace` : `part ${i}: ${r}` };
    parts.push(r);
  }
  const something = parts.some((p) => p.type !== "text" || p.text.trim() !== "");
  return something ? parts : { error: "text or parts required" };
}
```

(The test for `{ type: "video" }` expects `/part 0/`; the workspace cases expect `/workspace/`; the html attachment expects `/image or PDF/`; both URL cases expect `/data URL/`; the big one `/5 MB/`.)

- [ ] **Step 6: `opencode-parts.ts`.**

```ts
import { basename, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PromptPart } from "./driver";

export type OpencodeFilePart = {
  type: "file";
  mime: string;
  url: string;
  filename?: string;
  source?: { type: "file"; path: string; text: { value: string; start: number; end: number } };
};
export type OpencodePart = { type: "text"; text: string } | OpencodeFilePart;

/** OpenCode reads a `file://` part itself, so a workspace file goes by its absolute URL. */
export function toOpencodeParts(parts: PromptPart[], directory: string | undefined): OpencodePart[] {
  return parts.map((p): OpencodePart => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "attachment")
      return { type: "file", mime: p.mime, url: p.url, ...(p.filename ? { filename: p.filename } : {}) };
    if (!directory) throw new Error("this session has no workspace to read files from");
    const abs = resolve(directory, p.path);
    const rel = relative(directory, abs);
    if (rel.startsWith("..") || resolve(directory, rel) !== abs) throw new Error(`${p.path} is outside the workspace`);
    const value = `@${p.path}`;
    return {
      type: "file",
      mime: "text/plain",
      filename: basename(p.path),
      url: pathToFileURL(abs).href,
      source: {
        type: "file",
        path: p.path,
        text: p.mention ? { value, start: p.mention.start, end: p.mention.end } : { value, start: 0, end: 0 },
      },
    };
  });
}
```

- [ ] **Step 7: adapter `prompt`.** In `packages/adapter-opencode/src/index.ts`, change `prompt` to take the parts as OpenCode wants them:

```ts
    async prompt(
      sessionID: string,
      parts: Array<{ type: "text"; text: string } | { type: "file"; mime: string; url: string; filename?: string; source?: object }>,
      promptOpts?,
    ) {
      await client.session.promptAsync({
        sessionID,
        directory: promptOpts?.directory ?? opts.directory,
        model: promptOpts?.model,
        agent: promptOpts?.agent,
        // server schema accepts `variant` (reasoning effort); SDK types lag
        ...(promptOpts?.variant ? ({ variant: promptOpts.variant } as object) : {}),
        parts: parts as never,
      });
    },
```

Keep whatever explicit type the existing `promptOpts?` parameter has (look at how the return object is typed — if the connection's type is declared separately, update that declaration). Update any adapter test or e2e helper that calls `conn.prompt(id, "text")` to pass `[{ type: "text", text: "…" }]`.

- [ ] **Step 8: drivers.**

`opencode-driver.ts`: import `toOpencodeParts`; capabilities gain `commands: true, attachments: true` (commands is implemented in Task 2; setting it now is fine because the route arrives in the same plan — if you prefer, set it in Task 2); prompt:

```ts
    prompt: (nativeId, parts, promptOpts) =>
      conn.prompt(nativeId, toOpencodeParts(parts, promptOpts?.directory ?? opts.directory), promptOpts),
```

`acp-driver.ts`: `async prompt(nativeId, parts)` with `const text = parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");` then the existing body using `text`. Capabilities unchanged (no `commands`, no `attachments`).

- [ ] **Step 9: service routes** in `packages/service/src/index.ts`.

Import `readPromptParts` from `./prompt-parts`.

Replace the body of `if (cmd === "prompt" && req.method === "POST") { … }` with:

```ts
        const body = (await req.json().catch(() => null)) as {
          parts?: unknown;
          text?: unknown;
          model?: { providerID: string; modelID: string };
          agent?: string;
          variant?: string;
        } | null;
        const parts = readPromptParts(body);
        if (!Array.isArray(parts)) return json(parts, 400);
        if (!conn.capabilities.attachments && parts.some((p) => p.type !== "text"))
          return json({ error: "backend cannot take attachments" }, 400);
        try {
          await conn.prompt(native, parts, {
            model: body?.model,
            agent: body?.agent,
            variant: body?.variant,
            directory,
          });
          return json({ ok: true });
        } catch (e) {
          return json({ error: String(e) }, 502);
        }
```

Add, just before `const sessionCmd = …`:

```ts
    const capsMatch = path.match(/^\/sessions\/([^/]+)\/capabilities$/);
    if (capsMatch && req.method === "GET") {
      const casfId = decodeURIComponent(capsMatch[1]!);
      const conn = driverFor(casfId);
      if (!conn?.nativeId(casfId)) return json({ connected: false });
      const c = conn.capabilities;
      return json({
        connected: true,
        prompt: c.prompt,
        abort: c.abort,
        commands: c.commands === true,
        attachments: c.attachments === true,
        ...(conn.extension ? { extension: conn.extension.kind } : {}),
      });
    }
```

(`decodeURIComponent` can throw on a malformed escape; wrap it like the extension route does and answer 404.)

- [ ] **Step 10: Run tests** — the three files from Step 3, then `bun test` and `bun run typecheck` (`$LASTEXITCODE` 0). Fix every compile error the signature change surfaces (other tests or fakes that build a `BackendDriver` and implement `prompt(nativeId, text)`).

- [ ] **Step 11: Commit.** `feat(service): prompts carry text, workspace files and attachments as parts`

---

### Task 2: Run the backend's commands

**Files:** `driver.ts`, `adapter-opencode/src/index.ts`, `opencode-driver.ts`, `index.ts`, `composer.test.ts`.

- [ ] **Step 1: Failing tests.** In `composer.test.ts`, add to the `fakeOpencode` routes:

```ts
    "/command": () =>
      Response.json([
        { name: "init", template: "x", hints: [] },
        { name: "slow", template: "x", hints: [] },
        { name: "broken", template: "x", hints: [] },
      ]),
    "/session/ses_x/command": async (_url, req) => {
      const { command } = (await req.json()) as { command: string };
      if (command === "broken") return Response.json({ name: "UnknownError", data: { message: "boom" } }, { status: 500 });
      // a command answers when the whole run is done
      if (command === "slow") await Bun.sleep(60_000);
      return Response.json({ info: { id: "msg_1", role: "assistant" }, parts: [] });
    },
```

and tests:

```ts
  test("a command runs with its arguments, agent, model and files", async () => {
    const res = await post(`${session}/command`, {
      command: "init",
      arguments: "be brief",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude" },
      parts: [{ type: "file_ref", path: "README.md" }],
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(upstream.seen.filter((s) => s.path === "/session/ses_x/command").at(-1)!.body);
    expect(body).toMatchObject({
      command: "init",
      arguments: "be brief",
      agent: "build",
      model: "anthropic/claude",
      parts: [{ type: "file", filename: "README.md", url: pathToFileURL(resolve("/repo/x", "README.md")).href }],
    });
  });

  test("a long command is handed over without waiting for the reply", async () => {
    const t0 = Date.now();
    const res = await post(`${session}/command`, { command: "slow", arguments: "" });
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test("an unknown command is refused before OpenCode, a failing one reports why", async () => {
    const before = upstream.seen.filter((s) => s.path === "/session/ses_x/command").length;
    const unknown = await post(`${session}/command`, { command: "nope", arguments: "" });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toMatch(/unknown command: \/nope/);
    expect(upstream.seen.filter((s) => s.path === "/session/ses_x/command").length).toBe(before);
    const broken = await post(`${session}/command`, { command: "broken", arguments: "" });
    expect(broken.status).toBe(502);
    expect(((await broken.json()) as { error: string }).error).toMatch(/boom/);
    expect((await post(`${session}/command`, { arguments: "x" })).status).toBe(400);
    expect((await post(`${session}/command`, { command: "init", parts: [{ type: "text", text: "x" }] })).status).toBe(400);
  });
```

Add to the capabilities test nothing (already expects `commands: true`). In `service.test.ts`'s ACP test, add: `POST /sessions/<acp id>/command` `{ command: "init" }` → 400 with `/cannot run commands/`.

- [ ] **Step 2: Run, watch them fail** (404 / 400).

- [ ] **Step 3: `driver.ts`.** Add:

```ts
export interface CommandOpts extends PromptOpts {
  /** files and attachments that go along; commands take no text parts */
  parts?: PromptPart[];
}
```

and on `BackendDriver`, after `prompt`:

```ts
  /** run one of the backend's commands; resolves once it has started */
  command?(nativeId: string, name: string, args: string, opts?: CommandOpts): Promise<void>;
```

- [ ] **Step 4: adapter `command`.** In the object `connectOpencode` returns, after `prompt`:

```ts
    async command(
      sessionID: string,
      c: {
        command: string;
        arguments: string;
        agent?: string;
        model?: { providerID: string; modelID: string };
        variant?: string;
        directory?: string;
        parts?: Array<{ type: "file"; mime: string; url: string; filename?: string; source?: object }>;
      },
    ) {
      const directory = c.directory ?? opts.directory;
      const listed = await client.command.list({ directory });
      if (!(listed.data ?? []).some((x) => x.name === c.command)) throw new UnknownCommandError(c.command);
      const run = client.session.command({
        sessionID,
        directory,
        command: c.command,
        arguments: c.arguments,
        agent: c.agent,
        model: c.model ? `${c.model.providerID}/${c.model.modelID}` : undefined,
        variant: c.variant,
        parts: c.parts as never,
      });
      // OpenCode answers when the whole run is done, and the run goes on if
      // nobody waits; a command that fails to start fails at once.
      const early = await Promise.race([
        run.then(
          (r) => ({ r }),
          (thrown: unknown) => ({ thrown }),
        ),
        Bun.sleep(COMMAND_START_MS).then(() => undefined),
      ]);
      if (early === undefined) {
        void run.then(
          (r) => r.error && console.error(`opencode command /${c.command} failed:`, r.error),
          (err) => console.error(`opencode command /${c.command} failed:`, err),
        );
        return;
      }
      if ("thrown" in early) throw early.thrown;
      if (early.r.error) throw new Error(errorMessage(early.r.error));
    },
```

with, at module level near the other constants:

```ts
/** How long a command may take to fail before it counts as started. */
export const COMMAND_START_MS = 1_500;

export class UnknownCommandError extends Error {
  constructor(name: string) {
    super(`unknown command: /${name}`);
  }
}

function errorMessage(e: unknown): string {
  const data = (e as { data?: { message?: unknown } })?.data;
  if (data && typeof data.message === "string") return data.message;
  return typeof e === "string" ? e : JSON.stringify(e);
}
```

(If an `errorMessage`-like helper already exists in the file, reuse it instead.) Export `UnknownCommandError` from the package entry.

- [ ] **Step 5: driver + route.**

`opencode-driver.ts`:

```ts
    command: (nativeId, name, args, c) =>
      conn.command(nativeId, {
        command: name,
        arguments: args,
        agent: c?.agent,
        model: c?.model,
        variant: c?.variant,
        directory: c?.directory ?? opts.directory,
        parts: c?.parts
          ? (toOpencodeParts(c.parts, c.directory ?? opts.directory) as OpencodeFilePart[])
          : undefined,
      }),
```

`index.ts`: add `command` to the `sessionCmd` regex alternatives, and inside that block:

```ts
      if (cmd === "command" && req.method === "POST") {
        if (!conn.capabilities.commands || !conn.command) return json({ error: "backend cannot run commands" }, 400);
        const body = (await req.json().catch(() => null)) as {
          command?: unknown;
          arguments?: unknown;
          parts?: unknown;
          model?: { providerID: string; modelID: string };
          agent?: string;
          variant?: string;
        } | null;
        if (typeof body?.command !== "string" || !body.command) return json({ error: "command required" }, 400);
        let parts: PromptPart[] | undefined;
        if (body.parts !== undefined) {
          const read = readPromptParts({ parts: body.parts });
          if (!Array.isArray(read)) return json(read, 400);
          if (read.some((p) => p.type === "text")) return json({ error: "a command takes its words as arguments" }, 400);
          parts = read;
        }
        try {
          await conn.command(native, body.command, typeof body.arguments === "string" ? body.arguments : "", {
            parts,
            model: body.model,
            agent: body.agent,
            variant: body.variant,
            directory,
          });
          return json({ ok: true });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof UnknownCommandError ? 400 : 502);
        }
      }
```

Note `readPromptParts` refuses a parts list with nothing to send (all text blank) — for commands, a list of only file parts passes. An empty `parts: []` would be refused; the UI omits `parts` when there are none.

- [ ] **Step 6: Run tests, full suite, typecheck. Commit.** `feat(service): run the backend's commands from a session`

---

### Task 3: The record shows what the user sent

**Files:** `packages/adapter-opencode/src/index.ts` (mapper), `packages/adapter-opencode/test/opencode.test.ts`.

- [ ] **Step 1: Failing tests** in `opencode.test.ts` (reuse the file's `sessionCreated`, `msgUpdated`, `partUpdated` helpers and the `sid` constant):

```ts
describe("what the user sent", () => {
  const userTurn = (out: { type: string; data: unknown }[]) =>
    out.filter((e) => e.type === "turn.user").at(-1)?.data as { content: object[] } | undefined;

  test("the text OpenCode adds when it reads an attached file stays out of the user's words", () => {
    const m = new OpencodeMapper();
    const out = [
      m.handle(sessionCreated()),
      m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 1 } })),
      m.handle(partUpdated({ id: "t1", sessionID: sid, messageID: "u1", type: "text", text: "@a.ts explain" })),
      m.handle(partUpdated({ id: "t2", sessionID: sid, messageID: "u1", type: "text", synthetic: true, text: "Called the Read tool with the following input: {}" })),
      m.handle(partUpdated({ id: "t3", sessionID: sid, messageID: "u1", type: "text", synthetic: true, text: "<path>a.ts</path><content>secret</content>" })),
      m.handle(partUpdated({
        id: "f1", sessionID: sid, messageID: "u1", type: "file", mime: "text/plain", filename: "a.ts",
        url: "file:///repo/a.ts", source: { type: "file", path: "a.ts", text: { value: "@a.ts", start: 0, end: 5 } },
      })),
    ].flat();
    expect(userTurn(out)!.content).toEqual([
      { type: "text", text: "@a.ts explain" },
      { type: "file_ref", path: "a.ts" },
    ]);
  });

  test("an image the user attached is an image, not a file name", () => {
    const m = new OpencodeMapper();
    const url = "data:image/png;base64,iVBORw0KGgo=";
    const out = [
      m.handle(sessionCreated()),
      m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 1 } })),
      m.handle(partUpdated({ id: "t1", sessionID: sid, messageID: "u1", type: "text", text: "what colour" })),
      m.handle(partUpdated({ id: "f1", sessionID: sid, messageID: "u1", type: "file", mime: "image/png", filename: "red.png", url })),
      m.handle(partUpdated({ id: "f2", sessionID: sid, messageID: "u1", type: "file", mime: "image/png", filename: "r.png", url: "https://x/r.png" })),
      m.handle(partUpdated({ id: "f3", sessionID: sid, messageID: "u1", type: "file", mime: "application/pdf", filename: "spec.pdf", url: "data:application/pdf;base64,JVBERi0=" })),
    ].flat();
    expect(userTurn(out)!.content).toEqual([
      { type: "text", text: "what colour" },
      { type: "image", mime: "image/png", data: "iVBORw0KGgo=" },
      { type: "image", mime: "image/png", uri: "https://x/r.png" },
      { type: "file_ref", path: "spec.pdf" },
    ]);
  });

  test("a user message that is only OpenCode's own text leaves no bubble, and its reply still lands", () => {
    const store = openStore(":memory:");
    const m = new OpencodeMapper();
    const evs = [
      sessionCreated(),
      msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 1 } }),
      partUpdated({ id: "t1", sessionID: sid, messageID: "u1", type: "text", synthetic: true, text: "Continue if you have next steps" }),
      msgUpdated({
        id: "a1", sessionID: sid, role: "assistant", parentID: "u1", time: { created: 2, completed: 3 },
        providerID: "p", modelID: "m", agent: "build", mode: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0, finish: "stop",
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      partUpdated({ id: "t2", sessionID: sid, messageID: "a1", type: "text", text: "done", time: { start: 2, end: 3 } }),
      { id: "i", type: "session.idle", properties: { sessionID: sid } } as unknown as Event,
    ];
    for (const e of evs) store.append(m.handle(e));
    const view = projectSession(store.query({ session_id: `opencode:${sid}` }));
    expect(view.turns.some((t) => t.user && t.user.length > 0)).toBe(false);
    expect(JSON.stringify(view.turns)).toContain("done");
    store.close();
  });

  test("the mapping version moved, so stored sessions are rebuilt", () => {
    expect(OPENCODE_MAPPER_VERSION).toBe("opencode-4");
  });
});
```

(Adjust `store.append`/`store.query`/`projectSession` usage to what the file already does in its store-backed tests — e.g. the test around line 307 — if the signatures differ. If `m.handle` returns events that `store.append` needs wrapped, follow the existing pattern.)

- [ ] **Step 2: Run, watch them fail** (synthetic text present, `file_ref` for images, version `opencode-3`).

- [ ] **Step 3: Implement** in the `message.part.updated` case:

```ts
        } else if (part.type === "text") {
          // OpenCode's own words in the user's message (a read file's contents,
          // "continue" nudges) are not what the user said
          if (part.synthetic || part.ignored) m.parts.delete(part.id);
          else m.parts.set(part.id, { type: "text", text: part.text });
        } else if (part.type === "reasoning") {
          m.parts.set(part.id, { type: "thinking", text: part.text });
        } else if (part.type === "file") {
          m.parts.set(part.id, fileBlock(part));
        }
```

with a module-level helper:

```ts
function fileBlock(part: { mime: string; url: string; filename?: string; source?: object }): ContentBlock {
  if (part.mime.startsWith("image/")) {
    const comma = part.url.indexOf(",");
    if (part.url.startsWith("data:") && part.url.slice(0, comma).endsWith(";base64"))
      return { type: "image", mime: part.mime, data: part.url.slice(comma + 1) };
    if (/^https?:/.test(part.url)) return { type: "image", mime: part.mime, uri: part.url };
  }
  const path = part.source && "path" in part.source ? (part.source as { path: string }).path : (part.filename ?? part.url);
  return { type: "file_ref", path };
}
```

(Import the `ContentBlock` type from `@agent-strata/schema` if the file does not already; keep the `stale` guard branch first as it is.) Check: when the user message ends with no visible content, the existing `if (content.length)` already emits nothing; make sure the `pendingUserMsgs` path does not emit an empty `turn.user` later either (if it would, guard it the same way).

Set `export const OPENCODE_MAPPER_VERSION = "opencode-4";`. If any existing test pins `"opencode-3"`, update it.

- [ ] **Step 4: Run the adapter tests, full suite, typecheck. Commit.** `fix(adapter-opencode): record attached images as images and leave out opencode's own text`

---

### Task 4: Composer logic and API, unit-tested

**Files:** `apps/desktop/ui/src/composer-input.ts` (new), `composer-input.test.ts` (new), `api.ts`, `api.test.ts`.

- [ ] **Step 1: Failing tests** — `apps/desktop/ui/src/composer-input.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  attachmentProblem,
  commandOf,
  insertPick,
  matchCommands,
  nextAgent,
  promptParts,
  toAttachment,
  triggerAt,
} from "./composer-input";

describe("what the caret is typing", () => {
  test("an @ at a word start opens files, anywhere in the draft", () => {
    expect(triggerAt("look at @src/a", 14)).toEqual({ kind: "file", query: "src/a", start: 8, end: 14 });
    expect(triggerAt("@", 1)).toEqual({ kind: "file", query: "", start: 0, end: 1 });
    expect(triggerAt("mail me@x.com", 13)).toBeUndefined();
    expect(triggerAt("@a b", 4)).toBeUndefined();
  });

  test("a / opens commands only as the draft's first word", () => {
    expect(triggerAt("/in", 3)).toEqual({ kind: "command", query: "in", start: 0, end: 3 });
    expect(triggerAt("/init now", 9)).toBeUndefined();
    expect(triggerAt("a /b", 4)).toBeUndefined();
  });
});

describe("taking a suggestion", () => {
  test("replaces the whole word under the caret and leaves one space", () => {
    expect(insertPick("see @RE", { kind: "file", query: "RE", start: 4, end: 7 }, "README.md")).toEqual({
      text: "see @README.md ",
      caret: 15,
    });
    expect(insertPick("@REnope tail", { kind: "file", query: "RE", start: 0, end: 3 }, "README.md")).toEqual({
      text: "@README.md tail",
      caret: 11,
    });
    expect(insertPick("/in", { kind: "command", query: "in", start: 0, end: 3 }, "init")).toEqual({
      text: "/init ",
      caret: 6,
    });
  });
});

describe("what goes out", () => {
  test("words, then the files the draft still mentions, then attachments", () => {
    const shot = { id: "1", name: "s.png", mime: "image/png", url: "data:image/png;base64,AA==" };
    expect(promptParts("  @a.ts vs @b.ts  ", ["a.ts", "b.ts", "gone.ts"], [shot])).toEqual([
      { type: "text", text: "@a.ts vs @b.ts" },
      { type: "file_ref", path: "a.ts", mention: { start: 0, end: 5 } },
      { type: "file_ref", path: "b.ts", mention: { start: 9, end: 14 } },
      { type: "attachment", mime: "image/png", url: "data:image/png;base64,AA==", filename: "s.png" },
    ]);
    expect(promptParts("@a.tsx", ["a.ts"], [])).toEqual([{ type: "text", text: "@a.tsx" }]);
    expect(promptParts("", [], [shot])).toHaveLength(1);
  });

  test("a draft naming a listed command runs it with the rest as arguments", () => {
    expect(commandOf("/init  be brief ", ["init", "review"])).toEqual({ name: "init", args: "be brief" });
    expect(commandOf("/init", ["init"])).toEqual({ name: "init", args: "" });
    expect(commandOf("/nope x", ["init"])).toBeUndefined();
    expect(commandOf("say /init", ["init"])).toBeUndefined();
  });

  test("commands that start with the query come first", () => {
    const list = [{ name: "review" }, { name: "init" }, { name: "mcp-search:web" }, { name: "customize-opencode" }];
    expect(matchCommands(list, "i").map((c) => c.name)).toEqual(["init", "review", "customize-opencode"]);
    expect(matchCommands(list, "").map((c) => c.name)).toEqual(["review", "init", "mcp-search:web", "customize-opencode"]);
  });
});

describe("tab through agents", () => {
  test("wraps both ways and starts from the ends when nothing is picked", () => {
    expect(nextAgent(["build", "plan"], "build", 1)).toBe("plan");
    expect(nextAgent(["build", "plan"], "plan", 1)).toBe("build");
    expect(nextAgent(["build", "plan"], "build", -1)).toBe("plan");
    expect(nextAgent(["build", "plan"], "", 1)).toBe("build");
    expect(nextAgent(["build", "plan"], "", -1)).toBe("plan");
    expect(nextAgent([], "", 1)).toBeUndefined();
  });
});

describe("attachments", () => {
  test("only images and PDFs up to 5 MB", () => {
    expect(attachmentProblem({ type: "image/png", size: 10 })).toBeUndefined();
    expect(attachmentProblem({ type: "application/pdf", size: 10 })).toBeUndefined();
    expect(attachmentProblem({ type: "text/plain", size: 10 })).toBe("type");
    expect(attachmentProblem({ type: "image/png", size: 5 * 1024 * 1024 + 1 })).toBe("size");
  });

  test("a file becomes a data URL of its own type", async () => {
    const a = await toAttachment(new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" }), "k");
    expect(a).toEqual({ id: "k", name: "x.png", mime: "image/png", url: "data:image/png;base64,AQID" });
  });
});
```

And add to `api.test.ts`:

```ts
import { opencodePath } from "./api";
// … existing …
  test("a file search carries its query and limit", () => {
    expect(opencodePath("opencode:ses_1", "/find/file", { query: "a", limit: 20, dirs: "false" })).toBe(
      "/sessions/opencode%3Ases_1/opencode/find/file?query=a&limit=20&dirs=false",
    );
  });
```

- [ ] **Step 2: Run, watch them fail.** `bun test apps/desktop/ui/src/composer-input.test.ts apps/desktop/ui/src/api.test.ts`.

- [ ] **Step 3: `api.ts`.** Add near the other types:

```ts
/** One piece of a prompt; paths are relative to the session's workspace. */
export type PromptPart =
  | { type: "text"; text: string }
  | { type: "file_ref"; path: string; mention?: { start: number; end: number } }
  | { type: "attachment"; mime: string; url: string; filename?: string };

export interface SessionCapabilities {
  connected: boolean;
  prompt?: boolean;
  abort?: boolean;
  commands?: boolean;
  attachments?: boolean;
  extension?: "opencode";
}

export interface CommandInfo {
  name: string;
  description?: string;
  source?: "command" | "mcp" | "skill";
  hints?: string[];
}

export interface PromptChoice {
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
}
```

`readOpencode` gains a 4th parameter `signal?: AbortSignal` passed to `fetch(…, { signal })`. Then:

```ts
export function readCapabilities(sessionId: string): Promise<SessionCapabilities> {
  return getJson<SessionCapabilities>(`/sessions/${encodeURIComponent(sessionId)}/capabilities`);
}

export function readCommands(sessionId: string): Promise<CommandInfo[] | undefined> {
  return readOpencode<CommandInfo[]>(sessionId, "/command");
}

export function findFiles(sessionId: string, query: string, signal?: AbortSignal): Promise<string[] | undefined> {
  return readOpencode<string[]>(sessionId, "/find/file", { query, limit: 20, dirs: "false" }, signal);
}

export async function sendPrompt(sessionId: string, parts: PromptPart[], choice: PromptChoice): Promise<void> {
  await throwOnError(
    await fetch(api(`/sessions/${encodeURIComponent(sessionId)}/prompt`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts, ...choice }),
    }),
  );
}

export async function runCommand(
  sessionId: string,
  command: { name: string; args: string; parts?: PromptPart[] },
  choice: PromptChoice,
): Promise<void> {
  await throwOnError(
    await fetch(api(`/sessions/${encodeURIComponent(sessionId)}/command`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: command.name,
        arguments: command.args,
        ...(command.parts?.length ? { parts: command.parts } : {}),
        ...choice,
      }),
    }),
  );
}
```

(`throwOnError` is declared further down the file as a function declaration, so it is hoisted.)

- [ ] **Step 4: `composer-input.ts`.**

```ts
import type { PromptPart } from "./api";

/** An `@file` mention or a leading `/command` the caret is in the middle of typing. */
export interface Trigger {
  kind: "file" | "command";
  query: string;
  start: number;
  end: number;
}

export function triggerAt(text: string, caret: number): Trigger | undefined {
  const before = text.slice(0, caret);
  const slash = /^\/(\S*)$/.exec(before);
  if (slash) return { kind: "command", query: slash[1]!, start: 0, end: caret };
  const at = /(?:^|\s)@(\S*)$/.exec(before);
  if (at) return { kind: "file", query: at[1]!, start: caret - at[1]!.length - 1, end: caret };
  return undefined;
}

/** The rest of the word under the caret goes too, so editing a mention mid-word replaces all of it. */
export function insertPick(text: string, t: Trigger, pick: string): { text: string; caret: number } {
  const token = `${t.kind === "file" ? "@" : "/"}${pick}`;
  const after = text.slice(t.end).replace(/^\S*/, "").replace(/^\s/, "");
  return { text: `${text.slice(0, t.start)}${token} ${after}`, caret: t.start + token.length + 1 };
}

function mentions(text: string, picked: readonly string[]): { path: string; start: number; end: number }[] {
  const out: { path: string; start: number; end: number }[] = [];
  for (const path of new Set(picked)) {
    const token = `@${path}`;
    for (let i = text.indexOf(token); i >= 0; i = text.indexOf(token, i + 1)) {
      const end = i + token.length;
      if ((i === 0 || /\s/.test(text[i - 1]!)) && (end === text.length || /\s/.test(text[end]!))) {
        out.push({ path, start: i, end });
        break;
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  /** data: URL */
  url: string;
}

/** A file picked from the menu goes along only while the draft still mentions it. */
export function promptParts(draft: string, picked: readonly string[], attachments: readonly Attachment[]): PromptPart[] {
  const text = draft.trim();
  const parts: PromptPart[] = text ? [{ type: "text", text }] : [];
  for (const m of mentions(text, picked)) parts.push({ type: "file_ref", path: m.path, mention: { start: m.start, end: m.end } });
  for (const a of attachments) parts.push({ type: "attachment", mime: a.mime, url: a.url, filename: a.name });
  return parts;
}

export function commandOf(draft: string, names: readonly string[]): { name: string; args: string } | undefined {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(draft.trim());
  if (!m || !names.includes(m[1]!)) return undefined;
  return { name: m[1]!, args: (m[2] ?? "").trim() };
}

export function matchCommands<T extends { name: string }>(list: readonly T[], query: string): T[] {
  const q = query.toLowerCase();
  const name = (c: T) => c.name.toLowerCase();
  return [...list.filter((c) => name(c).startsWith(q)), ...list.filter((c) => !name(c).startsWith(q) && name(c).includes(q))];
}

export function nextAgent(agents: readonly string[], current: string, step: 1 | -1): string | undefined {
  if (agents.length === 0) return undefined;
  const i = agents.indexOf(current);
  if (i < 0) return step > 0 ? agents[0] : agents[agents.length - 1];
  return agents[(i + step + agents.length) % agents.length];
}

export const ATTACHMENT_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,application/pdf";
const ATTACHMENT_MIMES = new Set(ATTACHMENT_ACCEPT.split(","));
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export function attachmentProblem(file: { type: string; size: number }): "type" | "size" | undefined {
  if (!ATTACHMENT_MIMES.has(file.type)) return "type";
  if (file.size > MAX_ATTACHMENT_BYTES) return "size";
  return undefined;
}

export async function toAttachment(file: File, id: string): Promise<Attachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { id, name: file.name, mime: file.type, url: `data:${file.type};base64,${btoa(binary)}` };
}
```

- [ ] **Step 5: Run tests; root `bun test`; root `bun run typecheck`; `bun run typecheck` inside `apps/desktop/ui` — all exit 0. Commit.** `feat(ui): composer logic for mentions, commands, attachments and agents`

---

### Task 5: The composer

**Files:** `composer-menu.tsx` (new), `session-detail.tsx`, `icons.tsx`, `locales/zh/session.ts`, `locales/en/session.ts`, `apps/desktop/src-tauri/tauri.conf.json`.

Read `apps/desktop/DESIGN.md` first. Colors: `bg-popover` for the menu, `bg-secondary` for chips and the active row, `text-muted-foreground` for details, `border-border`; radius `rounded-lg` for the menu, `rounded-md` for rows/chips; `text-sm` rows, `text-2xs` badges. Icons from `Icon`. No new visual language.

- [ ] **Step 1: Strings.** Add under the composer section of `locales/zh/session.ts`, and the same keys in `locales/en/session.ts`:

| key | zh | en |
|---|---|---|
| `composer.menu.files` | 文件 | Files |
| `composer.menu.commands` | 命令 | Commands |
| `composer.menu.search_files` | 输入文件名搜索 | Type to search files |
| `composer.menu.no_match` | 没有匹配项 | No matches |
| `composer.menu.source.mcp` | MCP | MCP |
| `composer.menu.source.skill` | 技能 | Skill |
| `composer.attach` | 添加图片或 PDF | Attach images or PDFs |
| `composer.attach.remove` | 移除 {name} | Remove {name} |
| `composer.attach.bad_type` | {name}：只支持图片和 PDF | {name}: only images and PDFs |
| `composer.attach.too_big` | {name} 超过 5 MB | {name} is over 5 MB |
| `composer.attach.unreadable` | {name} 无法作为图片读取 | {name} could not be read as an image |
| `composer.attachments.one` | 1 个附件 | 1 attachment |
| `composer.attachments.other` | {n} 个附件 | {n} attachments |
| `picker.agent.tip` | 智能体（Tab 切换） | Agent (Tab to switch) |

- [ ] **Step 2: `icons.tsx`.** Add `"attach"` to `Name` and a paperclip glyph in the same 16-unit, 1.5-stroke style, e.g. `<path d="M10.5 4.5 5.6 9.4a1.6 1.6 0 0 0 2.3 2.3l5-5a3 3 0 0 0-4.3-4.3l-5 5a4.4 4.4 0 0 0 6.2 6.2l4.2-4.2" />`.

- [ ] **Step 3: `composer-menu.tsx`.**

```tsx
import { For, Show } from "solid-js";
import { Icon } from "./icons";
import { t } from "./i18n";
import type { Attachment } from "./composer-input";

export interface MenuItem {
  key: string;
  /** what is inserted after `@` or `/` */
  value: string;
  label: string;
  detail?: string;
  badge?: string;
}

/** Suggestions above the composer. Focus stays in the textarea; rows are picked with the mouse or the keys it forwards. */
export function ComposerMenu(props: {
  kind: "file" | "command";
  items: MenuItem[];
  active: number;
  /** shown instead of rows: why there is nothing yet */
  hint?: string;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}) {
  let list: HTMLUListElement | undefined;
  // keep the active row visible while arrowing through a long list
  const scrollTo = (el: HTMLElement, i: number) => {
    if (i === props.active) queueMicrotask(() => el.scrollIntoView({ block: "nearest" }));
  };
  return (
    <div class="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
      <p class="px-3 pb-1 pt-2 text-2xs font-medium text-muted-foreground">
        {props.kind === "file" ? t("composer.menu.files") : t("composer.menu.commands")}
      </p>
      <Show
        when={props.items.length > 0}
        fallback={<p class="px-3 pb-2.5 text-sm text-muted-foreground">{props.hint ?? t("composer.menu.no_match")}</p>}
      >
        <ul ref={list} role="listbox" class="max-h-64 overflow-y-auto px-1 pb-1">
          <For each={props.items}>
            {(item, i) => (
              <li
                ref={(el) => scrollTo(el, i())}
                role="option"
                aria-selected={i() === props.active}
                class={`flex cursor-default items-baseline gap-2 rounded-md px-2 py-1.5 text-sm ${i() === props.active ? "bg-secondary text-foreground" : "text-foreground/90"}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  props.onPick(i());
                }}
                onMouseMove={() => props.onHover(i())}
              >
                <Show when={props.kind === "file"}>
                  <Icon name="files" class="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground" />
                </Show>
                <span class={`shrink-0 ${props.kind === "command" ? "font-mono text-xs" : "truncate"}`}>{item.label}</span>
                <Show when={item.detail}>
                  <span class="min-w-0 truncate text-xs text-muted-foreground">{item.detail}</span>
                </Show>
                <Show when={item.badge}>
                  <span class="ml-auto shrink-0 rounded bg-secondary px-1.5 text-2xs text-muted-foreground">{item.badge}</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

export function AttachmentStrip(props: { items: Attachment[]; onRemove: (id: string) => void }) {
  return (
    <div class="flex flex-wrap gap-2 px-3 pt-3">
      <For each={props.items}>
        {(a) => (
          <div class="group relative">
            <Show
              when={a.mime.startsWith("image/")}
              fallback={
                <div class="flex h-12 max-w-48 items-center gap-1.5 rounded-md bg-secondary px-2.5 text-xs">
                  <Icon name="files" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span class="truncate">{a.name}</span>
                </div>
              }
            >
              <img src={a.url} alt={a.name} class="h-12 w-12 rounded-md border border-border object-cover" />
            </Show>
            <button
              type="button"
              class="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full bg-foreground text-2xs leading-none text-background opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
              aria-label={t("composer.attach.remove", { name: a.name })}
              onClick={() => props.onRemove(a.id)}
            >
              ×
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
```

(Check the actual import paths/names of `t` and `Icon` used by sibling files and match them.)

- [ ] **Step 4: `session-detail.tsx` — state and data.** Near the other composer signals:

```ts
  const [caps, { refetch: refetchCaps }] = createResource(() => props.id, (id) => readCapabilities(id).catch(() => undefined));
  const [commands] = createResource(
    () => (caps()?.commands && caps()?.extension === "opencode" ? props.id : undefined),
    (id) => readCommands(id).catch(() => undefined),
  );
  const [picked, setPicked] = createSignal<string[]>([]);
  const [attachments, setAttachments] = createSignal<Attachment[]>([]);
  const [trigger, setTrigger] = createSignal<Trigger>();
  /** the trigger start the user closed with Escape; it stays closed until they type elsewhere */
  const [dismissedAt, setDismissedAt] = createSignal<number>();
  const [menuItems, setMenuItems] = createSignal<MenuItem[]>([]);
  const [menuActive, setMenuActive] = createSignal(0);
  const [attachErr, setAttachErr] = createSignal("");
```

Call `refetchCaps()` in the existing `strata-connections` handler (`onConns`).

The menu is open when `trigger()` is set, `trigger()!.start !== dismissedAt()`, and the trigger's kind is available: `file` needs `caps()?.extension === "opencode"`, `command` needs `commands()` to be an array.

Items:

```ts
  createEffect(() => {
    const tr = trigger();
    if (!tr || tr.kind !== "command") return;
    const list = matchCommands(commands() ?? [], tr.query).slice(0, 50);
    setMenuItems(
      list.map((c) => ({
        key: c.name,
        value: c.name,
        label: `/${c.name}`,
        detail: c.description,
        badge: c.source === "mcp" ? t("composer.menu.source.mcp") : c.source === "skill" ? t("composer.menu.source.skill") : undefined,
      })),
    );
    setMenuActive(0);
  });

  let fileSearch: AbortController | undefined;
  let fileTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const tr = trigger();
    clearTimeout(fileTimer);
    fileSearch?.abort();
    if (!tr || tr.kind !== "file") return;
    if (!tr.query) {
      setMenuItems([]);
      return;
    }
    fileTimer = setTimeout(() => {
      const ctl = (fileSearch = new AbortController());
      void findFiles(props.id, tr.query, ctl.signal)
        .then((paths) => {
          if (ctl.signal.aborted) return;
          setMenuItems(
            (paths ?? []).map((p) => {
              const cut = p.lastIndexOf("/");
              return { key: p, value: p, label: p.slice(cut + 1), detail: cut > 0 ? p.slice(0, cut) : undefined };
            }),
          );
          setMenuActive(0);
        })
        .catch(() => {});
    }, 120);
  });
  onCleanup(() => {
    clearTimeout(fileTimer);
    fileSearch?.abort();
  });
```

Hint: for `file` with an empty query pass `hint={t("composer.menu.search_files")}`.

Trigger tracking: a helper `const track = () => setTrigger(draftEl ? triggerAt(draft(), draftEl.selectionStart ?? 0) : undefined);` called from `onInput` (after `setDraft`), `onClick`, and `onKeyUp` for `ArrowLeft`/`ArrowRight`/`Home`/`End`. When the trigger's `start` differs from `dismissedAt()`, clear `dismissedAt`.

Picking:

```ts
  const pick = (i: number) => {
    const tr = trigger();
    const item = menuItems()[i];
    if (!tr || !item || !draftEl) return;
    const next = insertPick(draft(), tr, item.value);
    if (tr.kind === "file") setPicked((p) => (p.includes(item.value) ? p : [...p, item.value]));
    setDraft(next.text);
    setTrigger(undefined);
    queueMicrotask(() => {
      autogrow();
      draftEl?.setSelectionRange(next.caret, next.caret);
      draftEl?.focus();
    });
  };
```

- [ ] **Step 5: keys.** At the top of the textarea's `onKeyDown`, before the history handling:

```ts
                          if (menuOpen() && !e.isComposing) {
                            const n = menuItems().length;
                            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                              e.preventDefault();
                              if (n) setMenuActive((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
                              return;
                            }
                            if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && n) {
                              e.preventDefault();
                              pick(menuActive());
                              return;
                            }
                            if (e.key === "Escape") {
                              e.preventDefault();
                              setDismissedAt(trigger()!.start);
                              return;
                            }
                          }
                          if (e.key === "Tab" && !e.isComposing && !e.ctrlKey && !e.altKey && !e.metaKey) {
                            const names = (settled(options)?.agents ?? []).map((a) => a.name);
                            const next = nextAgent(names, agentSel(), e.shiftKey ? -1 : 1);
                            if (next && names.length > 1) {
                              e.preventDefault();
                              setAgentSel(next);
                              return;
                            }
                          }
```

Make sure the existing global `keydown` listener for in-session find (`onFindKey`) does not also react to Escape when the menu handled it (it listens on `window`; `e.preventDefault()` is not enough — check whether it ignores events from the textarea or add `e.stopPropagation()` in the Escape branch).

The agent `Picker` label becomes `t("picker.agent.tip")`.

- [ ] **Step 6: attachments.**

```ts
  let attachSeq = 0;
  const addFiles = async (files: Iterable<File>) => {
    setAttachErr("");
    for (const file of files) {
      const problem = attachmentProblem(file);
      if (problem) {
        setAttachErr(t(problem === "type" ? "composer.attach.bad_type" : "composer.attach.too_big", { name: file.name || "file" }));
        continue;
      }
      if (file.type.startsWith("image/")) {
        // OpenCode drops an undecodable image without a reply or an idle
        const ok = await createImageBitmap(file).then((b) => (b.close(), true), () => false);
        if (!ok) {
          setAttachErr(t("composer.attach.unreadable", { name: file.name || "image" }));
          continue;
        }
      }
      const a = await toAttachment(file, String(++attachSeq));
      setAttachments((list) => [...list, a]);
    }
  };
  const canAttach = () => caps()?.attachments === true;
```

- Textarea `onPaste`: `if (canAttach() && e.clipboardData?.files.length) { e.preventDefault(); void addFiles(e.clipboardData.files); }` (pasted text without files keeps the default).
- The composer well (`div.rounded-2xl …`): `onDragOver={(e) => { if (canAttach() && e.dataTransfer?.types.includes("Files")) e.preventDefault(); }}` and `onDrop={(e) => { if (!canAttach() || !e.dataTransfer?.files.length) return; e.preventDefault(); void addFiles(e.dataTransfer.files); }}`.
- A hidden `<input type="file" multiple accept={ATTACHMENT_ACCEPT}>` and, in the composer's bottom row left of the running label, a 28px icon button (`Tip` label `t("composer.attach")`, `<Icon name="attach" class="h-4 w-4" />`, `text-muted-foreground hover:bg-secondary hover:text-foreground rounded-md`) shown only when `canAttach()`, which clicks the input; the input's `onChange` calls `addFiles(input.files)` then resets `input.value = ""`.
- `<Show when={attachments().length}>` → `<AttachmentStrip items={attachments()} onRemove={(id) => setAttachments((l) => l.filter((a) => a.id !== id))} />` at the top inside the well, above the textarea.
- `attachErr()` is shown like `sendErr()` (same paragraph style), cleared on the next successful add or send.

- [ ] **Step 7: sending.** Queue items become `interface Outgoing { text: string; picked: string[]; attachments: Attachment[] }`. `queued` holds `Outgoing[]`; its list shows `item.text` and, when `item.attachments.length`, a `text-2xs text-muted-foreground` `tn("composer.attachments", n)` after it; `editQueued` restores text, picked and attachments (if the current draft has content, it goes to the queue as an `Outgoing` like today).

```ts
  const deliver = async (out: Outgoing) => {
    setSendErr("");
    setPendingSend(true);
    setHistIndex(-1);
    if (out.text) writeHistory(rememberPrompt(readHistory(), out.text));
    // … model resolution exactly as today …
    const choice = { model, agent: agentSel() || undefined, variant: variantSel() || undefined };
    const command = caps()?.commands ? commandOf(out.text, (commands() ?? []).map((c) => c.name)) : undefined;
    try {
      if (command) {
        const files = promptParts("", [], out.attachments).concat(
          promptParts(out.text, out.picked, []).filter((p) => p.type === "file_ref"),
        );
        await runCommand(props.id, { ...command, parts: files }, choice);
      } else {
        await sendPrompt(props.id, promptParts(out.text, out.picked, out.attachments), choice);
      }
    } catch (err) {
      setSendErr(err instanceof Error ? err.message : t("err.network"));
      setDraft(out.text);
      setPicked(out.picked);
      setAttachments(out.attachments);
      setPendingSend(false);
    }
  };

  const send = () => {
    const out: Outgoing = { text: draft().trim(), picked: picked(), attachments: attachments() };
    if (!out.text && out.attachments.length === 0) return;
    setDraft("");
    setPicked([]);
    setAttachments([]);
    setAttachErr("");
    setTrigger(undefined);
    if (draftEl) draftEl.style.height = "auto";
    if (generating()) {
      setQueued((q) => [...q, out]);
      setHistIndex(-1);
      return;
    }
    void deliver(out);
  };
```

The send button is enabled when `draft().trim() || attachments().length`; its `Tip`/`aria-label` follow the same condition. The queue drain effect passes the `Outgoing` through unchanged. `sendErr` messages coming from `throwOnError` already carry the service's `error` text.

- [ ] **Step 8: menu placement.** Wrap the composer well in `<div class="relative">` (if the queued block and the well share a wrapper, put `relative` on the well's own wrapper) and render, inside it, `<Show when={menuOpen()}><ComposerMenu kind={trigger()!.kind} items={menuItems()} active={menuActive()} hint={…} onPick={pick} onHover={setMenuActive} /></Show>`.

- [ ] **Step 9: Tauri drops.** In `apps/desktop/src-tauri/tauri.conf.json`, add `"dragDropEnabled": false` to the `main` window object.

- [ ] **Step 10: Checks.** Root `bun test`, root `bun run typecheck`, `bun run typecheck` inside `apps/desktop/ui`, and `bun run build` inside `apps/desktop/ui` — all exit 0. Commit. `feat(ui): @ files, / commands, attachments and tab between agents in the composer`

---

### Task 6: Acceptance probe and docs (controller)

**Files:** `scripts/probe-composer.ts` (new), `README.md`.

- [ ] **Step 1: `scripts/probe-composer.ts`** — through a running strata on 7700 and OpenCode on 4096, spending a few hundred tokens on the server's default model (which must accept images). It:
  1. makes a scratch directory under the OS temp dir with `hello.txt` (`the secret word is pomegranate`) and `.opencode/command/echo.md` (fact 4);
  2. `POST /sessions { directory: scratch }`; `GET /sessions/:id/capabilities` must say `commands` and `attachments`;
  3. prompts `@hello.txt what is the secret word? Answer with one word, no tools.` with a `file_ref` part (mention 0–10), waits for the reply, and checks: the user turn has the text and a `file_ref` `hello.txt` and no block containing `<content>` or `Called the Read tool`; the reply contains `pomegranate`;
  4. prompts `What colour is this image? One word, no tools.` with an `attachment` part (a 32×32 red PNG, base64 embedded in the script), checks the user turn has an `image` block and the reply contains `red` (case-insensitive);
  5. `POST /command { command: "echo", arguments: "banana split sundae" }` returns 200 in under 5 s; the reply contains `banana`;
  6. `POST /command { command: "no-such-command" }` returns 400;
  7. deletes the session (`DELETE /sessions/:id`), prints a JSON report, exits 0 only if every check passed.

  "Waits for the reply": poll `GET /sessions/:id/view` every 700 ms (90 s cap) until the number of turns with a non-partial assistant message has grown by one and `busy` is false.

- [ ] **Step 2: README.** In the section describing the desktop/session features, one sentence: the composer completes workspace files with `@`, runs the backend's commands with `/`, takes pasted, dropped or picked images and PDFs (up to 5 MB each), and Tab switches the primary agent — OpenCode sessions only; ACP sessions send text.

- [ ] **Step 3: Live check.** Restart strata on 7700; run `scripts/probe-composer.ts`, `scripts/probe-extension.ts`, `scripts/probe-stream.ts` — all exit 0. Commit. `test(scripts): probe the composer through a running strata`

- [ ] **Step 4: Desktop check (user).** In `tauri dev`, in an OpenCode session:
  1. type `@` plus part of a file name → a list of files; arrow + Enter inserts `@path `; send → the model answers from the file; the user bubble shows the words and a file chip, not the file contents;
  2. type `/` → commands with descriptions; pick one and send → it runs;
  3. paste a screenshot → a thumbnail above the input; send → the thumbnail shows in the user bubble; drag an image file from Explorer onto the composer → attached;
  4. Tab → the agent picker switches build ↔ plan; Shift+Tab back;
  5. Escape closes the menu; Enter with the menu closed sends as before; ↑ still recalls history.
