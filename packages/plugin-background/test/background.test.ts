import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginContext } from "@agent-strata/plugin-sdk";
import { createBackgroundPlugin } from "../src/index";
import { MAX_BACKGROUND_BYTES } from "../src/image";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1]);

function context(dir: string, config: Record<string, unknown> = {}, events: unknown[] = []) {
  return {
    pluginId: "background",
    resolveSession: (id: string) => id,
    dataDir: dir,
    config,
    logger: { info() {}, warn() {}, error() {} },
    emit: (event: unknown) => events.push(event),
  } as PluginContext;
}

async function plugin(dir: string, config: Record<string, unknown> = {}, events: unknown[] = []) {
  const value = createBackgroundPlugin();
  await value.initialize(context(dir, config, events));
  return value;
}

describe("the background plugin", () => {
  test("starts empty, stores an image, replaces it, and deletes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "background-"));
    const events: unknown[] = [];
    const p = await plugin(dir, {}, events);
    const empty = JSON.parse(String((await p.readResource!({ key: "background" })).body));
    expect(empty.image).toBeNull();

    expect((await p.route!(new Request("http://localhost/image", { method: "PUT", body: PNG }), "/image"))?.status).toBe(200);
    const image = await p.readResource!({ key: "image" });
    expect(image.mime).toBe("image/png");
    expect([...image.body]).toEqual([...PNG]);
    expect(JSON.parse(String((await p.readResource!({ key: "background" })).body)).image.resource).toBe("image");

    await p.route!(new Request("http://localhost/image", { method: "PUT", body: WEBP }), "/image");
    expect((await p.readResource!({ key: "image" })).mime).toBe("image/webp");
    await p.route!(new Request("http://localhost/image", { method: "DELETE" }), "/image");
    expect(JSON.parse(String((await p.readResource!({ key: "background" })).body)).image).toBeNull();
    expect(events).toHaveLength(3);
    await p.shutdown();
  });

  test("persists across instances and clamps the reader's settings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "background-"));
    const first = await plugin(dir);
    await first.route!(new Request("http://localhost/image", { method: "PUT", body: PNG }), "/image");
    await first.shutdown();

    const second = await plugin(dir, { fit: "contain", opacity: 200, blur: -4, scrim: 120 });
    expect((await second.readResource!({ key: "image" })).mime).toBe("image/png");
    const spec = JSON.parse(String((await second.readResource!({ key: "background" })).body));
    expect(spec).toMatchObject({ fit: "contain", opacity: 1, blur: 0, scrim: 0.8 });
    await second.shutdown();
  });

  test("rejects unknown formats and oversized requests without changing the image", async () => {
    const dir = mkdtempSync(join(tmpdir(), "background-"));
    const events: unknown[] = [];
    const p = await plugin(dir, {}, events);
    const invalid = await p.route!(
      new Request("http://localhost/image", { method: "PUT", body: new Uint8Array([1, 2, 3]) }),
      "/image",
    );
    expect(invalid?.status).toBe(400);
    const large = await p.route!(
      new Request("http://localhost/image", {
        method: "PUT",
        headers: { "content-length": String(MAX_BACKGROUND_BYTES + 1) },
        body: PNG,
      }),
      "/image",
    );
    expect(large?.status).toBe(413);
    expect(JSON.parse(String((await p.readResource!({ key: "background" })).body)).image).toBeNull();
    expect(events).toHaveLength(0);
    await p.shutdown();
  });
});
