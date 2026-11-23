import { afterEach, expect, test, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { PluginSummary } from "./api";
import { setLocale } from "./i18n";
import { PluginSettings } from "./plugin-settings";

const sessions: PluginSummary = {
  id: "sessions",
  name: "Session memory",
  version: "1.0.0",
  description: "Read earlier sessions.",
  icon: "message",
  state: "running",
  provides: ["tools"],
  tools: [{ name: "list", description: "List sessions" }],
  resources: [],
  settings: {
    schema: {
      type: "object",
      properties: {
        scope: {
          type: "enum",
          enum: ["workspace", "global"],
          default: "workspace",
          title: "Read scope",
        },
      },
    },
    values: { scope: "workspace" },
  },
};

const memory: PluginSummary = {
  id: "memory",
  name: "Durable memory",
  version: "1.0.0",
  description: "Keep preferences across sessions.",
  icon: "brain",
  state: "disabled",
  provides: ["tools"],
  tools: [],
  resources: [],
  ui: { settings: { component: "memory" }, toolRenderers: {} },
};

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  location.hash = "";
});

function stubApi(plugins: PluginSummary[], seen: { url: string; method: string; body?: unknown }[] = []) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    seen.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/plugins") && method === "GET") {
      return Promise.resolve(Response.json({ plugins }));
    }
    if (url.includes("/settings") && method === "POST") {
      return Promise.resolve(Response.json({ ok: true }));
    }
    if (url.includes("/lifecycle") && method === "POST") {
      return Promise.resolve(Response.json({ ok: true }));
    }
    return Promise.reject(new Error(`unexpected ${method} ${url}`));
  });
  return seen;
}

function mount(pluginId?: string, plugins: PluginSummary[] = [sessions, memory]) {
  const seen = stubApi(plugins);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <PluginSettings pluginId={pluginId} />, host);
  return { host, seen };
}

test("the directory leads to a deep-linked detail, with restart kept under About", async () => {
  setLocale("zh");
  const [pluginId, setPluginId] = createSignal<string>();
  const seen = stubApi([sessions, memory]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <PluginSettings pluginId={pluginId()} />, host);

  await vi.waitFor(() => expect(host.textContent).toContain("检索历史会话内容"));
  expect(host.textContent).toContain("跨会话保存约定与偏好");
  expect(host.textContent).not.toContain("确认重启");
  const row = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("会话记忆"),
  );
  row!.click();
  expect(location.hash).toBe("#/settings/plugins/sessions");
  expect(seen.every((entry) => !entry.url.includes("/lifecycle"))).toBe(true);

  setPluginId("sessions");
  await vi.waitFor(() => expect(host.querySelector("[data-plugin-detail='sessions']")).toBeTruthy());
  expect(host.textContent).toContain("v1.0.0");
  expect(host.textContent).not.toContain("再次点击以重建");
  const about = [...host.querySelectorAll("button")].find((button) => button.textContent === "关于");
  about!.click();
  expect(host.textContent).toContain("再次点击以重建");
});

test("schema settings still save as a patch through the existing host API", async () => {
  setLocale("zh");
  const { host, seen } = mount("sessions", [sessions]);
  await vi.waitFor(() => expect(host.textContent).toContain("读取范围"));
  const global = [...host.querySelectorAll("button")].find((button) => button.textContent === "所有工作区");
  global!.click();
  const save = await vi.waitFor(() => {
    const button = [...host.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("保存并重启插件"),
    );
    expect(button).toBeTruthy();
    return button!;
  });
  save.click();
  await vi.waitFor(() => {
    expect(seen.some((entry) => entry.url.includes("/plugins/sessions/settings") && entry.method === "POST")).toBe(true);
  });
  const write = seen.find((entry) => entry.url.includes("/plugins/sessions/settings"));
  expect(write?.body).toEqual({ values: { scope: "global" } });
  await vi.waitFor(() => expect(host.textContent).toContain("设置已保存，插件已重启。"));
  expect(host.textContent).not.toContain("保存并重启插件");
  expect(host.querySelector("[role='status']")?.textContent).toContain("设置已保存");
});

test("a named builtin component hosts the rich memory manager", async () => {
  setLocale("zh");
  const { host } = mount("memory", [memory]);
  await vi.waitFor(() => expect(host.textContent).toContain("插件没有运行"));
  expect(host.textContent).toContain("重新启用");
  expect(host.querySelector("[data-plugin-detail='memory']")).toBeTruthy();
});

test("an unregistered settings component degrades to an explanation, not a blank page", async () => {
  setLocale("zh");
  const future: PluginSummary = {
    ...sessions,
    id: "future",
    name: "Future",
    settings: undefined,
    ui: { settings: { component: "not-in-this-build" }, toolRenderers: {} },
  };
  const { host } = mount("future", [future]);
  await vi.waitFor(() => expect(host.textContent).toContain("此版本无法显示这项设置"));
  const about = [...host.querySelectorAll("button")].find((button) => button.textContent === "关于");
  expect(about).toBeTruthy();
});


test("a disabled plugin saves without claiming that it restarted", async () => {
  setLocale("zh");
  const { host } = mount("sessions", [{ ...sessions, state: "disabled" }]);
  await vi.waitFor(() => expect(host.textContent).toContain("读取范围"));
  const global = [...host.querySelectorAll("button")].find((button) => button.textContent === "所有工作区");
  global!.click();
  const save = [...host.querySelectorAll("button")].find((button) => button.textContent === "保存设置");
  expect(save).toBeTruthy();
  save!.click();
  await vi.waitFor(() => expect(host.textContent).toContain("设置已保存。"));
  expect(host.textContent).not.toContain("插件已重启");
});
