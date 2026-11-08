// The contract between strata and a plugin.
//
// A plugin declares what it contributes in a manifest, and implements the
// methods the host calls. Both halves live here so the two sides cannot drift:
// the service validates every manifest with `loadManifest`, and the plugin
// packages are the only consumers of `StrataPlugin`.
//
// Nothing in this file knows about a specific capability. A tool that drives a
// browser and a tool that starts a dev server are the same shape here, which
// is what makes "add a capability" mean "add a package" instead of "touch the
// service, the UI and the shell".

import { z } from "zod";

/**
 * A plugin id is also a route segment and a tool-name prefix.
 *
 * The character set has no underscore on purpose: tool names are exposed as
 * `<id>_<tool>`, and the adapter splits that on the first underscore. An id
 * that could contain one would make the split ambiguous.
 */
export const PluginId = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "plugin id must match [a-z][a-z0-9-]*")
  .refine((id) => id !== "tools" && id !== "hooks", {
    message: '"tools" and "hooks" are reserved route segments, not plugin ids',
  });

/** A tool name, unique inside its plugin. `_` is allowed; `-` reads better. */
export const ToolName = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/, "tool name must match [a-z][a-z0-9]*(-|_)[a-z0-9]*");

/** JSON Schema for a tool's input. Kept as a loose record: the backend owns it. */
export const InputSchema = z.record(z.unknown());

export const PolicyDefault = z.enum(["allow", "ask", "deny"]);
export type PolicyDefault = z.infer<typeof PolicyDefault>;

/**
 * A constraint the host enforces before the plugin sees the call.
 *
 * This is the only per-tool surface the host can actually police: it does not
 * know what a tool means, only which of its inputs it was told to check.
 */
export const ToolGuard = z.enum(["net", "workspace"]);
export type ToolGuard = z.infer<typeof ToolGuard>;

export const PluginToolManifest = z.object({
  name: ToolName,
  description: z.string().min(1),
  input: InputSchema,
  policy: z
    .object({
      default: PolicyDefault,
      risk: z.enum(["network", "exec", "fs", "read", "write", "unknown"]).optional(),
    })
    .optional(),
  /** input field -> constraint, checked by the host before dispatch */
  guards: z.record(ToolGuard).optional(),
  /** single-call ceiling; absent means the host default */
  timeout_ms: z.number().int().positive().max(30 * 60_000).optional(),
});
export type PluginToolManifest = z.infer<typeof PluginToolManifest>;

export const PluginResourceManifest = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]*$/),
  mime: z.string().min(1),
  description: z.string().optional(),
});

export const PanelKind = z.enum(["screencast", "logs", "status", "component"]);
export type PanelKind = z.infer<typeof PanelKind>;

export const PluginManifestSchema = z
  .object({
    id: PluginId,
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().optional(),
    engines: z.object({ strata: z.string().min(1) }).optional(),
    entry: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("builtin") }),
      z.object({
        kind: z.literal("process"),
        command: z.array(z.string()).min(1),
        protocol: z.literal("mcp"),
      }),
    ]),
    provides: z.array(z.enum(["tools", "resources", "panel", "backend"])).default([]),
    permissions: z
      .object({
        browser: z.boolean().optional(),
        /** host allowlist for `guards.net`; `*` allows anything */
        net: z.array(z.string()).optional(),
        fs: z.array(z.string()).optional(),
        shell: z.boolean().optional(),
      })
      .default({}),
    tools: z.array(PluginToolManifest).default([]),
    resources: z.array(PluginResourceManifest).default([]),
    panel: z
      .object({
        id: z.string().regex(/^[a-z][a-z0-9-]*$/),
        title: z.string().min(1),
        kind: PanelKind,
        icon: z.string().optional(),
      })
      .optional(),
    hooks: z
      .object({
        beforeTool: z.array(z.string()).default([]),
        systemPrompt: z.boolean().default(false),
      })
      .optional(),
    ui: z
      .object({
        toolRenderers: z
          .record(
            z.object({
              kind: z.string().min(1),
              icon: z.string().optional(),
            }),
          )
          .default({}),
      })
      .optional(),
    config: z.record(z.unknown()).optional(),
  })
  .superRefine((m, ctx) => {
    // `provides` is a claim and the sections are the content. Two sources of
    // truth that can disagree are worse than one: a consumer that trusts
    // `provides` would route to a section that is not there, and one that
    // trusts the section would show a panel the manifest never announced.
    const claims = (value: boolean, has: boolean, what: string) => {
      if (value !== has) {
        ctx.addIssue({
          code: "custom",
          path: ["provides"],
          message: has
            ? `manifest has ${what} but does not declare it in provides`
            : `provides declares ${what} but the manifest has no ${what} section`,
        });
      }
    };
    claims(m.provides.includes("tools"), m.tools.length > 0, "tools");
    claims(m.provides.includes("resources"), m.resources.length > 0, "resources");
    claims(m.provides.includes("panel"), m.panel !== undefined, "panel");

    const seen = new Set<string>();
    for (const tool of m.tools) {
      if (seen.has(tool.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["tools"],
          message: `duplicate tool name "${tool.name}"`,
        });
      }
      seen.add(tool.name);
      // A guard on a field the tool never takes can never fire; it reads like
      // protection and is none. The input schema is loose, so the check is
      // only possible when the tool declares its properties.
      for (const field of Object.keys(tool.guards ?? {})) {
        const props = (tool.input as { properties?: Record<string, unknown> }).properties;
        if (props && !(field in props)) {
          ctx.addIssue({
            code: "custom",
            path: ["tools"],
            message: `tool "${tool.name}" guards "${field}", which its input does not declare`,
          });
        }
      }
    }
    for (const field of Object.keys(m.ui?.toolRenderers ?? {})) {
      if (m.ui?.toolRenderers && !seen.has(field)) {
        ctx.addIssue({
          code: "custom",
          path: ["ui", "toolRenderers"],
          message: `renderer for unknown tool "${field}"`,
        });
      }
    }
    if (m.hooks?.beforeTool.length && m.hooks.beforeTool.some((t) => !/^[a-z][a-z0-9_-]*$/i.test(t))) {
      ctx.addIssue({ code: "custom", path: ["hooks", "beforeTool"], message: "invalid tool name" });
    }
  });

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** Parse a manifest, with the error text a human can act on. */
export function loadManifest(raw: unknown): PluginManifest {
  const parsed = PluginManifestSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  throw new Error(`invalid plugin manifest: ${detail}`);
}

/** The name the agent sees: `<plugin>_<tool>`. */
export function qualifiedToolName(pluginId: string, tool: string): string {
  return `${pluginId}_${tool}`;
}

/**
 * Split `<plugin>_<tool>` back into its halves.
 *
 * The id cannot contain an underscore, so the first one is the boundary. A
 * string with no underscore is not a qualified name at all.
 */
export function splitToolName(qualified: string): { pluginId: string; tool: string } | undefined {
  const at = qualified.indexOf("_");
  if (at <= 0 || at === qualified.length - 1) return undefined;
  const pluginId = qualified.slice(0, at);
  const tool = qualified.slice(at + 1);
  if (!/^[a-z][a-z0-9-]*$/.test(pluginId) || !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(tool))
    return undefined;
  return { pluginId, tool };
}

/** One executable tool, as the service sees it after a plugin registered. */
export interface ToolEntry {
  plugin_id: string;
  tool: string;
  /** `<plugin_id>_<tool>` */
  name: string;
  description: string;
  input: Record<string, unknown>;
  policy?: { default: PolicyDefault; risk?: string };
  guards?: Record<string, ToolGuard>;
  timeout_ms?: number;
}

/** The tool table the adapters pull. Deliberately session-free. */
export interface ToolTable {
  tools: ToolEntry[];
}

/** The host's view of a plugin, without the methods. */
export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  description?: string;
  provides: PluginManifest["provides"];
  tools: { name: string; description: string }[];
  resources: { key: string; mime: string }[];
  panel?: PluginManifest["panel"];
  hooks?: PluginManifest["hooks"];
  ui?: PluginManifest["ui"];
}

// ---------------------------------------------------------------------------
// What a plugin implements
// ---------------------------------------------------------------------------

export interface Logger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface PluginContext {
  pluginId: string;
  /**
   * The casf id for a session the caller named.
   *
   * A backend names its sessions natively (`ses_…`) while everything this
   * layer stores is keyed by `opencode:<native>`. A plugin that answers a
   * route with a `?session=` on it needs the same translation a tool call
   * gets, and the host is the only side that knows the mapping.
   */
  resolveSession(id: string): string;
  /** Per-plugin data directory, created before initialize. */
  dataDir: string;
  /** The manifest's `config` defaults, if any. */
  config: Record<string, unknown>;
  logger: Logger;
  /** Send an event to the host, which forwards it on the plugin's SSE stream. */
  emit(event: PluginEvent): void;
}

export interface PluginEvent {
  /** Event kind, namespaced by the plugin: "frame", "console", "progress". */
  type: string;
  data?: unknown;
}

export interface ToolCallRequest {
  /** The tool name inside the plugin, without the id prefix. */
  tool: string;
  /** The CASF call id, when the adapter could supply one. */
  callId?: string;
  sessionId: string;
  input: Record<string, unknown>;
  /** Aborted by the caller, a timeout, or session cancellation. */
  signal: AbortSignal;
  /**
   * Say how far along the call is.
   *
   * Memory only: progress is shown while it happens and never written down, so
   * a long browser action can narrate itself without adding a row to a log
   * that has to stay readable by older builds.
   */
  progress?: (event: { message?: string; percent?: number; data?: unknown }) => void;
}

export interface ToolCallResult {
  output: string;
  /** Images, files and other non-text results; the host spills large ones. */
  attachments?: { type: "image"; mime: string; data: string }[];
  isError?: boolean;
}

export interface ResourceRequest {
  sessionId: string;
  key: string;
  signal?: AbortSignal;
}

export interface ResourceResult {
  mime: string;
  body: Uint8Array | string;
}

export interface PluginTool {
  name: string;
  description: string;
  input: Record<string, unknown>;
}

export interface ToolCallOutcome {
  allow: true;
}

export interface ToolCallDenied {
  allow: false;
  message: string;
}

/**
 * The methods a builtin plugin may implement.
 *
 * Everything past `shutdown` is optional and exists so a capability can be
 * told about things the host knows and it does not: a session ending, a
 * directory about to be removed. A plugin that ignores them simply does not
 * hold anything that outlives a call.
 */
export interface StrataPlugin {
  initialize(ctx: PluginContext): Promise<void>;
  /** provides: tools */
  listTools(): PluginTool[];
  callTool(req: ToolCallRequest): Promise<ToolCallResult>;
  /** provides: resources */
  readResource?(req: ResourceRequest): Promise<ResourceResult>;
  /** `/plugins/:id/<rest>`; returning undefined leaves it a 404 */
  route?(req: Request, subpath: string): Promise<Response | undefined>;
  /** hooks.beforeTool: called before one of the tools it named runs */
  beforeToolCall?(req: {
    tool: string;
    input: Record<string, unknown>;
    sessionId: string;
  }): Promise<ToolCallOutcome | ToolCallDenied>;
  /** hooks.systemPrompt: text appended to the system prompt for this session */
  systemPrompt?(sessionId: string): Promise<string | undefined>;
  /** Stop holding anything that belongs to this session. */
  sessionEnded?(sessionId: string): Promise<void>;
  /** Let go of whatever you hold inside a directory that is about to go. */
  releaseDirectory?(dir: string): Promise<void>;
  /** Emit into the plugin's SSE stream. */
  onEvent?(emit: (event: PluginEvent) => void): void;
  shutdown(): Promise<void>;
}

export type PluginFactory = () => StrataPlugin;

export { STRATA_VERSION, satisfiesRange } from "./version";

export { parseHttpUrl, hostAllowed, type ParsedHttpUrl, type RejectedUrl } from "./url";
