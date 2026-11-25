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

test("the engine is the foundation apart from the servers, and the tiers say what a server cannot do", async () => {
  const { ctl: c } = ctl([engine, remote, localServer]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <BackendSettings conns={c} />, host);
  await vi.waitFor(() => expect(host.textContent).toContain(t("settings.engine.title")));

  // the engine card carries its own url; the servers list does not repeat it
  const engineCard = [...host.querySelectorAll("div")].find((el) => el.textContent?.includes("127.0.0.1:4096"));
  expect(engineCard).toBeTruthy();
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
  // the engine's lifecycle is managed on the OpenCode page, one click away
  expect(host.textContent).toContain(t("settings.engine.manage"));
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
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
    String(input).includes("/desktop/opencode")
      ? Response.json({ mode: "external", state: "external" })
      : Response.json([]),
  );
  const { ctl: c } = ctl([remote]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <BackendSettings conns={c} />, host);
  await vi.waitFor(() => expect(host.textContent).toContain(t("settings.engine.off")));
  expect(host.textContent).not.toContain(t("settings.engine.offline"));
  expect(host.textContent).toContain(t("settings.engine.manage"));
});

test("an engine that should be running but is not points to its state", async () => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
    String(input).includes("/desktop/opencode")
      ? Response.json({ mode: "embed", state: "starting" })
      : Response.json([]),
  );
  const { ctl: c } = ctl([remote]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <BackendSettings conns={c} />, host);
  await vi.waitFor(() => expect(host.textContent).toContain(t("settings.engine.offline")));
  expect(host.textContent).not.toContain(t("settings.engine.off"));
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
