import { afterEach, expect, test, vi } from "vitest";
import { render } from "solid-js/web";
import { setLocale } from "./i18n";
import { listTerminals, openTerminal, setTerminalMode } from "./api";
import { TerminalPane } from "./terminal";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    loadAddon() {}
    open() {}
    write() {}
    onData() {}
    dispose() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock("./api", () => ({
  listTerminals: vi.fn(async () => ({
    shells: [],
    sessions: [
      { id: "shared", title: "构建", command: "", cwd: "", status: "running", mode: "shared" },
      { id: "user", title: "本地", command: "", cwd: "", status: "running", mode: "user" },
    ],
  })),
  openTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  setTerminalMode: vi.fn(),
  resizeTerminal: vi.fn(),
  streamUrlFor: () => new Promise<string>(() => {}),
  terminalSocket: () => new Promise<string>(() => {}),
}));

let dispose: (() => void) | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  host?.remove();
  host = undefined;
  vi.unstubAllGlobals();
});

test("terminal tabs have compact mode icons, sharing toggles, and cut-title tips", async () => {
  setLocale("zh");
  const observers: (() => void)[] = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(measure: () => void) {
      observers.push(measure);
    }
    observe() {}
    disconnect() {}
  });
  vi.mocked(setTerminalMode).mockImplementation(async (_session, id, mode) => ({
    id, title: "本地", command: "", cwd: "", status: "running", mode,
  }));
  host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <TerminalPane sessionId="opencode:s" />, host);

  await vi.waitFor(() => {
    expect(host?.querySelector('[data-terminal-mode="shared"] svg')).not.toBeNull();
    expect(host?.querySelector('[data-terminal-mode="user"] svg')).not.toBeNull();
  });
  const mode = host?.querySelector('[data-terminal-mode="user"]');
  expect(mode?.textContent).toBe("");
  expect(mode?.getAttribute("aria-label")).toContain("Agent 不可见");
  expect(mode?.className).toContain("size-5");
  expect(mode?.querySelector("svg")?.getAttribute("class")).toContain("h-3.5");
  expect(host?.querySelector('[data-terminal-mode="shared"]')?.getAttribute("aria-label")).toContain("都可操作");

  mode?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await vi.waitFor(() => {
    expect(setTerminalMode).toHaveBeenCalledWith("opencode:s", "user", "shared");
    expect(host?.querySelector('[data-terminal-mode="user"]')).toBeNull();
  });

  const title = host?.querySelector('[data-terminal-title="本地"]') as HTMLElement;
  Object.defineProperties(title, {
    scrollWidth: { value: 200 },
    clientWidth: { value: 60 },
  });
  for (const measure of observers) measure();
  title.parentElement?.dispatchEvent(new MouseEvent("mouseenter"));
  await vi.waitFor(() => {
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe("本地");
  });
});

test("opening the rail tab does not start a terminal", async () => {
  setLocale("zh");
  vi.mocked(listTerminals).mockResolvedValue({ shells: [], sessions: [] });
  host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <TerminalPane sessionId="opencode:s" layout="panel" />, host);

  await vi.waitFor(() => {
    expect(host?.textContent).toContain("还没有终端");
  });
  expect(openTerminal).not.toHaveBeenCalled();
});
