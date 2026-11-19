import type {
  PluginContext,
  PluginManifest,
  StrataPlugin,
  ToolCallResult,
} from "@agent-strata/plugin-sdk";
import {
  BackgroundImageError,
  BackgroundImageStore,
  readImageRequest,
} from "./image";

export const manifest: PluginManifest = {
  id: "background",
  name: "Custom background",
  version: "1.0.0",
  description: "Use a local image as the app background, with fit, opacity, blur, and contrast controls.",
  entry: { kind: "builtin" },
  provides: ["resources"],
  permissions: {},
  tools: [],
  resources: [
    { key: "background", mime: "application/json", scope: "global" },
    { key: "image", mime: "image/*", scope: "global" },
  ],
  ui: { background: { resource: "background" }, toolRenderers: {} },
  settings: {
    type: "object",
    properties: {
      fit: { type: "enum", enum: ["cover", "contain"], default: "cover", title: "Image fit" },
      opacity: {
        type: "number",
        default: 60,
        minimum: 0,
        maximum: 100,
        step: 5,
        unit: "%",
        title: "Image opacity",
      },
      blur: {
        type: "number",
        default: 0,
        minimum: 0,
        maximum: 24,
        step: 1,
        unit: "px",
        title: "Background blur",
      },
      scrim: {
        type: "number",
        default: 35,
        minimum: 0,
        maximum: 80,
        step: 5,
        unit: "%",
        title: "Contrast overlay",
      },
    },
  },
};

export function createBackgroundPlugin(): StrataPlugin {
  let ctx: PluginContext;
  let images: BackgroundImageStore;

  const changed = () => {
    ctx.emit({ type: "stream", data: { type: "plugins.changed" } });
  };
  const numberSetting = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(ctx.config[key] ?? fallback);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };

  return {
    async initialize(context) {
      ctx = context;
      images = new BackgroundImageStore(ctx.dataDir);
    },
    listTools() {
      return [];
    },
    async callTool(): Promise<ToolCallResult> {
      return { output: "background has no tools", isError: true };
    },
    async readResource(req) {
      if (req.key === "background") {
        return {
          mime: "application/json",
          body: JSON.stringify({
            version: 1,
            image: images.has() ? { resource: "image" } : null,
            fit: ctx.config.fit === "contain" ? "contain" : "cover",
            opacity: numberSetting("opacity", 60, 0, 100) / 100,
            blur: numberSetting("blur", 0, 0, 24),
            scrim: numberSetting("scrim", 35, 0, 80) / 100,
          }),
        };
      }
      if (req.key === "image") {
        const image = images.read();
        if (!image) throw new Error("no background image");
        return image;
      }
      throw new Error(`no resource ${req.key}`);
    },
    async route(req, subpath) {
      if (subpath !== "/image") return undefined;
      try {
        if (req.method === "PUT") {
          images.write(await readImageRequest(req));
        } else if (req.method === "DELETE") {
          images.remove();
        } else {
          return Response.json({ error: "method not allowed" }, { status: 405 });
        }
        changed();
        return Response.json({ ok: true, hasImage: images.has() });
      } catch (error) {
        const status = error instanceof BackgroundImageError ? error.status : 500;
        return Response.json(
          { error: error instanceof Error ? error.message : "image update failed" },
          { status },
        );
      }
    },
    async shutdown() {},
  };
}
