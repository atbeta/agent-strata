import { afterEach, expect, test, vi } from "vitest";
import { render } from "solid-js/web";
import { setLocale } from "./i18n";
import { MemorySettings } from "./memory-settings";

/**
 * The page that lets the reader correct what the agent remembered.
 *
 * Two decisions only exist here: a memory that is off is still on the page
 * (a wrong fact you cannot see is a fact you cannot fix), and forgetting one
 * asks first.
 */

interface Row {
  id: string;
  text: string;
  enabled: boolean;
  key?: string;
  source: "agent" | "user";
  created_at: string;
  updated_at: string;
}

const memories: Row[] = [
  {
    id: "m_one",
    text: "User prefers Traditional Chinese.",
    enabled: true,
    source: "agent",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "m_two",
    text: "This repo deploys with make deploy.",
    enabled: false,
    key: "deploy",
    source: "agent",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
];

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
});

function stubApi(seen: string[] = []) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    seen.push(`${method} ${url}`);
    if (url.includes("/plugins/memory/workspaces")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            version: 1,
            workspaces: [{ key: "w1", path: "/work/one", last_used: "2026-01-01T00:00:00.000Z" }],
          }),
          { status: 200 },
        ),
      );
    }
    if (url.includes("/plugins/memory/memories") && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify({ scope: "global", memories }), { status: 200 }));
    }
    if (method === "PATCH") {
      return Promise.resolve(
        new Response(JSON.stringify({ memory: { ...memories[0]!, enabled: false } }), { status: 200 }),
      );
    }
    if (method === "POST") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            memory: {
              id: "m_new",
              text: "A new fact.",
              enabled: true,
              source: "user",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
            },
          }),
          { status: 200 },
        ),
      );
    }
    if (method === "DELETE") return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    return Promise.reject(new Error(`unexpected ${method} ${url}`));
  });
}

test("what the agent remembered is on the page, including the ones that are off", async () => {
  setLocale("zh");
  stubApi();
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <MemorySettings />, host);

  await vi.waitFor(() => {
    expect(host.textContent).toContain("User prefers Traditional Chinese.");
  });
  const text = host.textContent ?? "";
  expect(text).toContain("This repo deploys with make deploy.");
  expect(text).toContain("deploy");
  // The scope switcher carries the workspaces the agent has used.
  expect(text).toContain("全局");
  expect(text).toContain("one");
});

test("an entry that is off is still visible, so a wrong fact can be found", async () => {
  setLocale("zh");
  stubApi();
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <MemorySettings />, host);

  await vi.waitFor(() => expect(host.textContent).toContain("make deploy"));
  const off = [...host.querySelectorAll("p")].find((p) => p.textContent?.includes("make deploy"));
  expect(off?.className).toContain("line-through");
});

test("turning one off goes through the plugin, not through the page's own state", async () => {
  setLocale("zh");
  const seen: string[] = [];
  stubApi(seen);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <MemorySettings />, host);

  await vi.waitFor(() => expect(host.textContent).toContain("Traditional Chinese"));
  // The switch's accessible name sits on the checkbox behind the control.
  const switches = [...host.querySelectorAll<HTMLInputElement>("input[aria-label='注入到提示词']")];
  expect(switches.length).toBe(2);
  switches[0]!.click();
  await vi.waitFor(() => {
    expect(seen.some((line) => line.startsWith("PATCH"))).toBe(true);
  });
});

test("a fact the reader adds is saved and shows up on the page", async () => {
  setLocale("zh");
  const seen: string[] = [];
  stubApi(seen);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <MemorySettings />, host);

  await vi.waitFor(() => expect(host.textContent).toContain("Traditional Chinese"));
  const add = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("添加一条记忆"));
  expect(add).toBeTruthy();
  add!.click();

  const input = host.querySelector<HTMLInputElement>("input[placeholder]");
  expect(input).toBeTruthy();
  input!.value = "A new fact.";
  input!.dispatchEvent(new InputEvent("input", { bubbles: true }));

  const save = [...host.querySelectorAll("button")].find((b) => b.textContent === "保存");
  expect(save).toBeTruthy();
  save!.click();

  await vi.waitFor(() => expect(host.textContent).toContain("A new fact."));
  expect(seen.some((line) => line.startsWith("POST"))).toBe(true);
});

test("forgetting one asks first", async () => {
  setLocale("zh");
  const seen: string[] = [];
  stubApi(seen);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <MemorySettings />, host);

  await vi.waitFor(() => expect(host.textContent).toContain("Traditional Chinese"));
  const forget = [...host.querySelectorAll("button")].find((b) => b.textContent === "忘掉");
  expect(forget).toBeTruthy();
  forget!.click();

  await vi.waitFor(() => expect(document.body.textContent).toContain("忘掉这条记忆？"));
  // Nothing has been deleted yet: the reader has not answered.
  expect(seen.some((line) => line.startsWith("DELETE"))).toBe(false);
});

test("a disabled plugin says so instead of showing a list that cannot load", async () => {
  // A disabled plugin answers no route. The page must say that, rather than
  // showing controls whose every action would fail with "not found".
  setLocale("zh");
  const seen: string[] = [];
  stubApi(seen);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <MemorySettings disabled onEnable={() => {}} />, host);

  await vi.waitFor(() => expect(host.textContent).toContain("插件没有运行"));
  // The page asked the plugin nothing, and offered no control that would fail.
  expect(seen).toHaveLength(0);
  expect(host.textContent).not.toContain("User prefers Traditional Chinese.");
  expect(host.textContent).not.toContain("添加一条记忆");
});

test("a disabled plugin offers a way back", async () => {
  setLocale("zh");
  stubApi();
  const host = document.createElement("div");
  document.body.appendChild(host);
  let turnedOn = false;
  dispose = render(
    () => <MemorySettings disabled onEnable={() => { turnedOn = true; }} />,
    host,
  );

  await vi.waitFor(() => expect(host.textContent).toContain("重新启用"));
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "重新启用");
  expect(button).toBeTruthy();
  button!.click();
  expect(turnedOn).toBe(true);
});

test("forgetting everything asks first, and names what it will do", async () => {
  setLocale("zh");
  const seen: string[] = [];
  stubApi(seen);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <MemorySettings />, host);

  await vi.waitFor(() => expect(host.textContent).toContain("Traditional Chinese"));
  const forgetAll = [...host.querySelectorAll("button")].find((b) => b.textContent === "忘掉全部");
  expect(forgetAll).toBeTruthy();
  forgetAll!.click();

  await vi.waitFor(() => expect(document.body.textContent).toContain("忘掉这个范围的全部记忆？"));
  // Nothing is cleared until the reader answers.
  expect(seen.some((line) => line.startsWith("DELETE"))).toBe(false);
});
