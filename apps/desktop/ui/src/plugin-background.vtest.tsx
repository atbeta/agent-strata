import { afterEach, expect, test, vi } from "vitest";
import { render } from "solid-js/web";
import { PluginBackground } from "./plugin-background";
import { refreshPlugins } from "./plugin-registry";

let dispose: (() => void) | undefined;
let originalCreate: PropertyDescriptor | undefined;
let originalRevoke: PropertyDescriptor | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
  if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate);
  if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
  document.body.innerHTML = "";
});

test("the global background mounts, updates active state, and releases its blob", async () => {
  originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  const create = vi.fn(() => "blob:background-1");
  const revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  vi.stubGlobal("Image", class {
    naturalWidth = 100;
    naturalHeight = 100;
    src = "";
    decode() {
      return Promise.resolve();
    }
  });

  let running = true;
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/plugins/background/resources/background")) {
      return Promise.resolve(Response.json({
        version: 1,
        image: { resource: "image" },
        fit: "cover",
        opacity: 0.6,
        blur: 4,
        scrim: 0.35,
      }));
    }
    if (url.includes("/plugins/background/resources/image")) {
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      }));
    }
    if (url.includes("/plugins")) {
      return Promise.resolve(Response.json({
        plugins: [{
          id: "background",
          name: "Custom background",
          version: "1",
          state: running ? "running" : "disabled",
          provides: ["resources"],
          tools: [],
          resources: [
            { key: "background", mime: "application/json", scope: "global" },
            { key: "image", mime: "image/*", scope: "global" },
          ],
          ui: { background: { resource: "background" }, toolRenderers: {} },
        }],
      }));
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });

  await refreshPlugins();
  const active = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <PluginBackground onActive={active} />, host);
  const layer = await vi.waitFor(() => {
    const value = host.querySelector<HTMLElement>("[data-plugin-background]");
    expect(value).toBeTruthy();
    return value!;
  });
  expect(layer.getAttribute("aria-hidden")).toBe("true");
  expect(layer.querySelector<HTMLElement>("[style]")?.style.opacity).toBe("0.6");
  expect(active).toHaveBeenLastCalledWith(true);

  running = false;
  await refreshPlugins();
  await vi.waitFor(() => expect(host.querySelector("[data-plugin-background]")).toBeNull());
  expect(active).toHaveBeenLastCalledWith(false);
  expect(revoke).toHaveBeenCalledWith("blob:background-1");
});
