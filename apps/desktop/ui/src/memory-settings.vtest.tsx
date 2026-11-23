import { afterEach, expect, test, vi } from "vitest";
import { createSignal } from "solid-js";
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

function stubApi(
  seen: string[] = [],
  workspaces: { key: string; path: string; last_used: string }[] = [
    { key: "w1", path: "/work/one", last_used: "2026-01-01T00:00:00.000Z" },
  ],
) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    seen.push(`${method} ${url}`);
    if (url.includes("/plugins/memory/workspaces")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            version: 1,
            workspaces,
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

test("turning the plugin on loads the workspaces it has seen", async () => {
  // A page that was opened while the plugin was off must catch up when the
  // reader turns it on: the workspace memories live behind a tab, and a tab
  // that never appears is a memory the reader cannot reach.
  setLocale("zh");
  const seen: string[] = [];
  stubApi(seen);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const [disabled, setDisabled] = createSignal(true);
  dispose = render(
    () => <MemorySettings disabled={disabled()} onEnable={() => setDisabled(false)} />,
    host,
  );

  await vi.waitFor(() => expect(host.textContent).toContain("插件没有运行"));
  // The plugin was off, so the page asked it nothing.
  expect(seen).toHaveLength(0);

  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "重新启用");
  expect(button).toBeTruthy();
  button!.click();

  await vi.waitFor(() => expect(host.textContent).toContain("one"));
  expect(seen.some((line) => line.includes("/plugins/memory/workspaces"))).toBe(true);
});

test("a workspace read that lands after the plugin was turned off paints no error", async () => {
  // A plugin that is off answers no route, so a read still in flight fails.
  // That failure must not show up next to the "the plugin is not running"
  // notice — the reader turned it off on purpose.
  setLocale("zh");
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/plugins/memory/workspaces")) {
      return gate.then(
        () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
      );
    }
    if (url.includes("/plugins/memory/memories")) {
      return Promise.resolve(new Response(JSON.stringify({ scope: "global", memories }), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });

  const host = document.createElement("div");
  document.body.appendChild(host);
  const [disabled, setDisabled] = createSignal(false);
  dispose = render(() => <MemorySettings disabled={disabled()} />, host);

  await vi.waitFor(() => expect(host.textContent).toContain("Traditional Chinese"));
  setDisabled(true);
  await vi.waitFor(() => expect(host.textContent).toContain("插件没有运行"));

  // The read comes back now, failing the way a plugin that is off would.
  release!();
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(host.querySelector("p[role='alert']")).toBeNull();
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

test("a few workspaces stay on the row, and the path is on the tab", async () => {
  setLocale("zh");
  stubApi();
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <MemorySettings />, host);

  await vi.waitFor(() => expect(host.textContent).toContain("one"));
  const tab = [...host.querySelectorAll("button")].find((button) => button.textContent === "one");
  expect(tab?.getAttribute("title")).toBe("/work/one");
  expect(host.querySelector("[aria-label='记忆范围'][aria-haspopup]")).toBeNull();
});

test("many workspaces collapse to a menu that names each path", async () => {
  setLocale("zh");
  const seen: string[] = [];
  stubApi(
    seen,
    ["alpha", "beta", "gamma", "delta", "epsilon"].map((name, index) => ({
      key: `w${index}`,
      path: `/repos/${name}/web`,
      last_used: `2026-01-0${index + 1}T00:00:00.000Z`,
    })),
  );
  const host = document.createElement("div");
  document.body.appendChild(host);
  window.scrollTo = () => {};
  Element.prototype.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  dispose = render(() => <MemorySettings />, host);

  await vi.waitFor(() => {
    expect(host.querySelector("[role='tablist']")).toBeNull();
    expect(host.querySelector("button[aria-label='记忆范围']")).toBeTruthy();
  });
  // Closed, the row is the current scope. The other projects are not painted
  // across the page.
  expect(host.textContent).toContain("全局");
  expect(host.textContent).not.toContain("alpha");
  expect(host.textContent).not.toContain("/repos/epsilon/web");

  const trigger = host.querySelector<HTMLButtonElement>("button[aria-label='记忆范围']");
  trigger!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  await vi.waitFor(() => expect(document.body.textContent).toContain("/repos/alpha/web"));
  expect(document.body.textContent).toContain("/repos/epsilon/web");

  const row = [...document.body.querySelectorAll("[role='menuitem']")].find((item) =>
    item.textContent?.includes("/repos/delta/web"),
  );
  expect(row).toBeTruthy();
  row!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
  await vi.waitFor(() => expect(seen.some((line) => line.includes("workspace=w3"))).toBe(true));
  expect(host.textContent).toContain("web");
  expect(host.textContent).not.toContain("alpha");
});
