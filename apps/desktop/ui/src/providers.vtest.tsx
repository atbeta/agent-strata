import { afterEach, expect, test, vi } from "vitest";
import { render } from "solid-js/web";
import { ProviderSettings } from "./providers";
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

const engine: Connection = { id: "eng", backend: "opencode", baseUrl: "http://127.0.0.1:4096", placement: "embed" };
const remote: Connection = {
  id: "rem",
  backend: "opencode",
  baseUrl: "http://192.168.5.101:14198",
  placement: "external",
  name: "家里 101",
};

function ctl(connections: Connection[], forNew: string) {
  const resource = Object.assign(() => ({ connections }), { latest: { connections }, error: undefined });
  return { conns: resource, newSessionConnection: () => forNew } as unknown as ConnectionsCtl;
}

function providersOf() {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const provider = url.includes("/connections/rem/") ? "openai" : "anthropic";
    return Response.json({
      providers: [{ id: provider, name: provider, connected: true, canKey: true, methods: [] }],
    });
  });
  return asked;
}

async function mount(conns: ConnectionsCtl) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <ProviderSettings conns={conns} />, host);
  await vi.waitFor(() => expect(host.textContent).toMatch(/anthropic|openai/));
  return host;
}

test("one server shows its list with no switch", async () => {
  providersOf();
  const host = await mount(ctl([engine], "eng"));
  expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  expect(host.textContent).toContain("anthropic");
});

test("several servers show one list at a time, starting on the one new sessions go to", async () => {
  const asked = providersOf();
  const host = await mount(ctl([engine, remote], "rem"));
  const radios = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  expect(radios.map((radio) => radio.textContent)).toEqual([t("sidebar.source.local"), "家里 101"]);
  expect(radios[1]!.getAttribute("aria-checked")).toBe("true");
  expect(host.textContent).toContain("openai");
  expect(host.textContent).not.toContain("anthropic");

  radios[0]!.click();
  await vi.waitFor(() => expect(host.textContent).toContain("anthropic"));
  expect(host.textContent).not.toContain("openai");
  expect(asked.some((url) => url.includes("/connections/eng/providers"))).toBe(true);
});
