import { afterEach, expect, test, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { BackendSettings } from "./backend-settings";
import { t } from "./i18n";
import type { ConnectionsCtl } from "./use-connections";
import type { Connection } from "./api";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function ctl(connections: Connection[]) {
  const [connUrl, setConnUrl] = createSignal("");
  const resource = Object.assign(() => ({ connections }), { latest: { connections }, error: undefined });
  return {
    ctl: {
      conns: resource,
      attempts: () => [],
      connKind: () => "opencode",
      setConnKind: () => {},
      connUrl,
      setConnUrl,
      connName: () => "",
      setConnName: () => {},
      connUser: () => "",
      setConnUser: () => {},
      connPass: () => "",
      setConnPass: () => {},
      connCmd: () => "opencode acp",
      setConnCmd: () => {},
      connErr: () => "",
      connecting: () => false,
      connect: async () => {},
      disconnect: async () => {},
      forget: () => {},
      chooseNewConn: () => {},
      newSessionConnection: () => connections[0]?.id,
    } as unknown as ConnectionsCtl,
    setConnUrl,
  };
}

const engine: Connection = {
  id: "eng",
  backend: "opencode",
  baseUrl: "http://127.0.0.1:4096",
  placement: "embed",
  tier: "local",
  plugins: true,
};
const remote: Connection = {
  id: "rem",
  backend: "opencode",
  baseUrl: "http://192.168.5.101:14198",
  placement: "external",
  tier: "remote",
  plugins: false,
};
const localServer: Connection = {
  id: "loc",
  backend: "opencode",
  baseUrl: "http://127.0.0.1:5555",
  placement: "external",
  tier: "local",
  plugins: true,
};

function launchIs(launch: unknown) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
    String(input).includes("/desktop/opencode") ? Response.json(launch) : Response.json([]),
  );
}

const running = {
  mode: "embed",
  apiVersion: "v1",
  state: "running",
  runtime: { source: "path", bin: "/opt/homebrew/bin/opencode", version: "1.14.2" },
};

test("the engine is the foundation apart from the servers, and the tiers say what a server cannot do", async () => {
  launchIs(running);
  const { ctl: c } = ctl([engine, remote, localServer]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <BackendSettings conns={c} />, host);
  await vi.waitFor(() => expect(host.textContent).toContain(t("settings.opencode.state.running")));
  expect(host.textContent).toContain(t("settings.engine.title"));
  // the servers list does not repeat the engine
  expect(host.textContent).not.toContain("127.0.0.1:4096");
  const serversGroup = [...host.querySelectorAll("section,div")].filter((el) =>
    el.textContent?.includes(t("settings.backends.connected")),
  );
  expect(serversGroup.length).toBeGreaterThan(0);

  // tiers, not lifecycles: the remote server is marked remote with its
  // capability line; the loopback one is this machine with none of that
  expect(host.textContent).toContain(t("connect.tier.remote"));
  expect(host.textContent).toContain(t("settings.backends.pluginsMissing"));
  expect(host.textContent).toContain(t("connect.tier.local"));
  // exactly one missing-plugin line — the probed-capable servers carry none
  const missingLines = host.textContent!.split(t("settings.backends.pluginsMissing")).length - 1;
  expect(missingLines).toBe(1);
  // the engine's lifecycle is right here, not a page away
  expect(host.querySelector(`[aria-label="${t("settings.opencode.mode")}"]`)).not.toBeNull();
  expect(host.querySelector(`[role="radio"][aria-checked="true"]`)?.textContent).toBe("v1");
  expect(host.textContent).toContain(t("settings.opencode.restart"));
});

test("switching the API major saves v2 and keeps the rest of the launch mode", async () => {
  let current = { ...running };
  let saved: Record<string, unknown> | undefined;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes("/desktop/opencode")) return Response.json([]);
    if (init?.method === "PUT") {
      saved = JSON.parse(String(init.body)) as Record<string, unknown>;
      current = { ...current, apiVersion: "v2" };
      return Response.json({ mode: "embed", apiVersion: "v2", applied: "next-launch" });
    }
    return Response.json(current);
  });
  const { ctl: c } = ctl([engine]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <BackendSettings conns={c} />, host);
  const v2 = await vi.waitFor(() => {
    const found = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === "v2");
    expect(found).toBeTruthy();
    return found!;
  });
  v2.click();
  await vi.waitFor(() => expect(saved).toEqual({ mode: "embed", apiVersion: "v2" }));
  expect(host.textContent).not.toContain(t("settings.opencode.desktopOnly"));
});

test("the executable is folded away, with its version on the fold, until it is asked for", async () => {
  launchIs(running);
  const { ctl: c } = ctl([engine]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <BackendSettings conns={c} />, host);
  const fold = await vi.waitFor(() => {
    const found = [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((b) =>
      b.textContent?.includes(t("settings.engine.details")),
    );
    expect(found).toBeTruthy();
    return found!;
  });
  expect(fold.textContent).toContain("1.14.2");
  expect(host.textContent).not.toContain("/opt/homebrew/bin/opencode");
  fold.click();
  await vi.waitFor(() => expect(host.textContent).toContain("/opt/homebrew/bin/opencode"));
  expect(fold.getAttribute("aria-expanded")).toBe("true");
});

test("a missing executable is not folded away", async () => {
  launchIs({ mode: "embed", state: "missing", runtime: { source: "missing" } });
  const { ctl: c } = ctl([]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <BackendSettings conns={c} />, host);
  await vi.waitFor(() => expect(host.textContent).toContain(t("settings.opencode.chooseBin")));
  expect(host.textContent).toContain(t("settings.opencode.missing"));
  expect(host.textContent).not.toContain(t("settings.engine.details"));
});

test("a local server the probe found without the plugin says so, though it is this machine", async () => {
  const bare: Connection = { ...localServer, plugins: false };
  const { ctl: c } = ctl([engine, bare]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <BackendSettings conns={c} />, host);
  await vi.waitFor(() => expect(host.textContent).toContain("127.0.0.1:5555"));
  expect(host.textContent).not.toContain(t("connect.tier.remote"));
  expect(host.textContent).toContain(t("settings.backends.pluginsMissing"));
});

test("an engine switched off reads as the setting, not an outage", async () => {
  launchIs({ mode: "external", state: "external" });
  const { ctl: c } = ctl([remote]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <BackendSettings conns={c} />, host);
  await vi.waitFor(() => expect(host.textContent).toContain(t("settings.opencode.modeOff")));
  // nothing to start, restart or locate while it is off
  const buttons = [...host.querySelectorAll("button")].map((b) => b.textContent?.trim());
  expect(buttons).not.toContain(t("settings.opencode.start"));
  expect(buttons).not.toContain(t("settings.opencode.restart"));
  expect(host.textContent).not.toContain(t("settings.engine.details"));
});

test("an engine that should be running but is not shows its state and a way to start it", async () => {
  launchIs({ mode: "embed", state: "stopped" });
  const { ctl: c } = ctl([remote]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <BackendSettings conns={c} />, host);
  await vi.waitFor(() => expect(host.textContent).toContain(t("settings.opencode.state.stopped")));
  expect(host.textContent).toContain(t("settings.opencode.start"));
});

test("a remote server the probe found the plugin tools on carries no warning line", async () => {
  const capableRemote: Connection = { ...remote, plugins: true };
  const { ctl: c } = ctl([engine, capableRemote]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <BackendSettings conns={c} />, host);
  await vi.waitFor(() => expect(host.textContent).toContain(t("connect.tier.remote")));
  // geography still says remote, but detection overrules the inference: the
  // agent there genuinely has the tools, so nothing is to be warned about
  expect(host.textContent).not.toContain(t("settings.backends.pluginsMissing"));
});

test("the add form warns about a remote address before it is connected", async () => {
  const { ctl: c, setConnUrl } = ctl([engine]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <BackendSettings conns={c} />, host);
  await vi.waitFor(() => expect(host.textContent).toContain(t("settings.backends.add")));
  expect(host.textContent).not.toContain(t("connect.remoteNotice"));
  setConnUrl("http://192.168.5.101:14198");
  await vi.waitFor(() => expect(host.textContent).toContain(t("connect.remoteNotice")));
  setConnUrl("http://127.0.0.1:4096");
  await vi.waitFor(() => expect(host.textContent).not.toContain(t("connect.remoteNotice")));
});
