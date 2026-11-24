import { afterEach, expect, test, vi } from "vitest";
import { render } from "solid-js/web";
import { setLocale, t } from "./i18n";
import { WorktreeSettings } from "./worktree-settings";

const { openDialog } = vi.hoisted(() => ({ openDialog: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string) => Promise.resolve(command === "service_url" ? "http://service" : "")),
}));

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
  openDialog.mockReset();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  document.body.innerHTML = "";
});

function mount(initialRoot: string | null) {
  let root = initialRoot;
  const writes: unknown[] = [];
  const defaultPath = "/app/data/worktrees";
  vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { path: string };
      writes.push(body);
      root = body.path || null;
      return Promise.resolve(Response.json({ worktreeRoot: root }));
    }
    return Promise.resolve(
      Response.json({
        worktreeRoot: root,
        createsIn: root ?? defaultPath,
        knownRoots: [root ?? defaultPath],
      }),
    );
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <WorktreeSettings />, host);
  return { host, writes, defaultPath };
}

function radio(host: HTMLElement, label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button[role='radio']")].find(
    (item) => item.textContent === label,
  );
  expect(button).toBeTruthy();
  return button!;
}

test("a custom folder can be edited in the browser fallback and default can be restored", async () => {
  setLocale("zh");
  const { host, writes, defaultPath } = mount(null);
  await vi.waitFor(() => expect(host.textContent).toContain(defaultPath));
  expect(host.querySelector("input")).toBeNull();

  radio(host, t("worktree.settings.custom")).click();
  const input = host.querySelector<HTMLInputElement>("input")!;
  expect(input).toBeTruthy();
  input.value = "/picked/browser";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const save = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === t("worktree.settings.save"),
  );
  save!.click();

  await vi.waitFor(() => expect(writes).toEqual([{ path: "/picked/browser" }]));
  await vi.waitFor(() => expect(host.textContent).toContain("/picked/browser"));
  radio(host, t("worktree.settings.default")).click();
  await vi.waitFor(() => expect(writes).toEqual([{ path: "/picked/browser" }, { path: "" }]));
  expect(host.querySelector("input")).toBeNull();
  expect(host.textContent).toContain(t("worktree.settings.cleared"));
});

test("the desktop custom choice opens a native directory picker and saves its selection", async () => {
  setLocale("zh");
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  openDialog.mockResolvedValue("/picked/native");
  const { host, writes } = mount(null);
  await vi.waitFor(() => expect(host.textContent).toContain(t("worktree.settings.defaultPath")));

  radio(host, t("worktree.settings.custom")).click();

  await vi.waitFor(() => expect(writes).toEqual([{ path: "/picked/native" }]));
  expect(openDialog).toHaveBeenCalledWith({
    directory: true,
    multiple: false,
    title: t("worktree.settings.choose"),
  });
  expect(host.querySelector("input")).toBeNull();
  await vi.waitFor(() => expect(host.textContent).toContain("/picked/native"));
});
