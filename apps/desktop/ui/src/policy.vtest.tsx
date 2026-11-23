import { afterEach, expect, test, vi } from "vitest";
import { render } from "solid-js/web";
import type { Policy } from "./api";
import { setLocale } from "./i18n";
import { PolicyEditor } from "./policy";

const FILE = "/Users/beta/.agent-strata/policy.json";
let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function stubApi(initial: Policy | null) {
  let current = initial;
  const seen: { method: string; url: string; body?: unknown }[] = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method, url, body });
    if (url.endsWith("/policy") && method === "GET") {
      return Promise.resolve(Response.json({ policy: current, file: FILE }));
    }
    if (url.endsWith("/policy") && method === "PUT") {
      current = body as Policy;
      return Promise.resolve(Response.json({ ok: true }));
    }
    if (url.endsWith("/policy") && method === "DELETE") {
      current = null;
      return Promise.resolve(Response.json({ ok: true }));
    }
    if (url.endsWith("/policy/test") && method === "POST") {
      return Promise.resolve(Response.json({ decision: "allow" }));
    }
    return Promise.reject(new Error(`unexpected ${method} ${url}`));
  });
  return seen;
}

function mount(initial: Policy | null = null) {
  const seen = stubApi(initial);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <PolicyEditor />, host);
  return { host, seen };
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  expect(found, `button ${text}`).toBeTruthy();
  return found!;
}

test("the empty page guides rule creation and keeps advanced content folded", async () => {
  setLocale("zh");
  const { host, seen } = mount();
  await vi.waitFor(() => expect(host.textContent).toContain("还没有自定义规则"));
  expect(host.textContent).not.toContain(FILE);
  expect(host.textContent).not.toContain("保存策略");
  expect(host.textContent).not.toContain("输入（JSON）");

  button(host, "高级设置").click();
  expect(host.textContent).toContain("policy.json");
  expect(host.textContent).not.toContain(FILE);
  expect(host.textContent).toContain("复制路径");
  expect(host.textContent).not.toContain("重置权限策略");

  button(host, "验证规则").click();
  expect(host.textContent).toContain("输入（JSON）");
  button(host, "运行").click();
  await vi.waitFor(() => expect(seen.some((entry) => entry.url.endsWith("/policy/test"))).toBe(true));
});

test("default changes offer cancel and save, then report the saved policy", async () => {
  setLocale("zh");
  const { host, seen } = mount();
  await vi.waitFor(() => expect(host.textContent).toContain("还没有自定义规则"));
  button(host, "不再询问").click();
  expect(host.textContent).toContain("有未保存的更改");
  button(host, "取消").click();
  expect(host.textContent).not.toContain("有未保存的更改");

  button(host, "不再询问").click();
  button(host, "保存策略").click();
  await vi.waitFor(() => expect(host.textContent).toContain("已保存，实时连接会立即生效"));
  expect(seen.find((entry) => entry.method === "PUT")?.body).toMatchObject({ default: "allow" });
  expect(host.textContent).not.toContain("有未保存的更改");
});

test("adding a rule opens its editor and creates a dirty draft", async () => {
  setLocale("zh");
  const { host } = mount();
  await vi.waitFor(() => expect(host.textContent).toContain("还没有自定义规则"));
  button(host, "添加规则").click();
  expect(host.textContent).toContain("规则 ID");
  expect(host.textContent).toContain("有未保存的更改");
  expect(host.querySelector("input[placeholder='bash']")).toBeTruthy();
});

test("clearing asks first and only then deletes the server policy", async () => {
  setLocale("zh");
  const initial: Policy = {
    version: 1,
    default: "allow",
    rules: [{ id: "allow-ls", effect: "allow", tool: "bash", when: { command: { glob: "ls *" } } }],
  };
  const { host, seen } = mount(initial);
  await vi.waitFor(() => {
    expect([...host.querySelectorAll("input")].some((input) => input.value === "allow-ls")).toBe(true);
  });
  button(host, "高级设置").click();
  button(host, "清空规则").click();
  const dialog = await vi.waitFor(() => {
    const element = document.body.querySelector("[aria-label='清空全部规则？']");
    expect(element).toBeTruthy();
    return element!;
  });
  expect(seen.some((entry) => entry.method === "DELETE")).toBe(false);
  const confirm = [...dialog.querySelectorAll("button")].find((item) => item.textContent === "清空规则");
  confirm!.click();
  await vi.waitFor(() => expect(host.textContent).toContain("已清空，恢复为逐项确认"));
  expect(seen.some((entry) => entry.method === "DELETE")).toBe(true);
  expect(host.textContent).toContain("还没有自定义规则");
});
