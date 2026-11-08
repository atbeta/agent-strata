// The plugin host: what the service knows about plugins.
//
// Three jobs, and they are deliberately in one file because they are the same
// state seen from three sides:
//
// - registry: which plugins exist, what each claims, and whether it is running;
// - lifecycle: start, stop, restart, and the state file that survives a crash;
// - dispatch: turning a route or a tool call into a plugin method call, with
//   the checks the host can actually make (guards, namespacing, timeouts) in
//   front of it.
//
// What is *not* here is the policy decision. `/plugins/:id/tools/:tool` is
// dispatched by the service route, which asks policy and the reader first and
// then calls `host.callTool`. Keeping the two apart is what makes "the only
// policy point" checkable by reading one file.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  hostAllowed,
  loadManifest,
  parseHttpUrl,
  qualifiedToolName,
  satisfiesRange,
  splitToolName,
  STRATA_VERSION,
  type PluginContext,
  type PluginEvent,
  type PluginManifest,
  type PluginSummary,
  type StrataPlugin,
  type ToolCallResult,
  type ToolEntry,
  type ToolGuard,
} from "@agent-strata/plugin-sdk";
import { writeSecureJson } from "../secure-write";

export type PluginState = "disabled" | "starting" | "running" | "stopping" | "failed";

export interface PluginRecord {
  manifest: PluginManifest;
  plugin: StrataPlugin;
  state: PluginState;
  /** Set when the state is `failed`; the most recent reason. */
  error?: string;
  initializedAt?: number;
}

export interface PluginLogger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface RegisteredPlugin {
  manifest: PluginManifest;
  create: () => StrataPlugin;
}

export interface PluginHostOptions {
  /** Root for per-plugin data (`<dir>/plugins/<id>`). */
  dataDir: string;
  /** The state file; `<dir>/plugins-state.json` by default. */
  stateFile?: string;
  logger: PluginLogger;
  /** Where a session's workspace is, for `guards.workspace`. */
  workspaceOf: (sessionId: string) => string | undefined;
  /** The casf id for a session named natively by a backend. */
  resolveSession: (id: string) => string;
  /**
   * The call a progress event belongs to when the adapter could not name one.
   *
   * The design asks for this fallback explicitly (§4.3): an OpenCode release
   * whose tool context has no call id would otherwise make progress invisible,
   * because there would be nothing to attach it to. The session's own view is
   * the only place that knows which call is in flight, so the service answers.
   */
  pendingCall?: (sessionId: string, toolName: string) => string | undefined;
  /** Forward a plugin event to the service's own fan-out (dev.* events rely on this). */
  onStreamEvent?: (event: unknown) => void;
  /**
   * A tool's progress, for the live channel.
   *
   * Deliberately separate from `onStreamEvent`: progress has a schema and a
   * join key, and the override hook that calls it is the UI's, not a plugin's.
   */
  onProgress?: (progress: {
    plugin_id: string;
    tool: string;
    call_id?: string;
    session_id: string;
    message?: string;
    percent?: number;
    data?: unknown;
  }) => void;
}

interface EventSink {
  emit: (event: PluginEvent) => void;
  add: (listener: (event: PluginEvent) => void) => () => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The host.
 *
 * One instance per service, long-lived, holding the same objects the routes
 * and the plugin lifecycle see.
 */
export class PluginHost {
  private readonly records = new Map<string, PluginRecord>();
  private readonly registered = new Map<string, RegisteredPlugin>();
  private readonly sinks = new Map<string, EventSink>();
  private readonly disabled = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly stateFile: string;
  private stopping = false;

  constructor(private readonly options: PluginHostOptions) {
    this.stateFile = options.stateFile ?? join(options.dataDir, "plugins-state.json");
    this.loadState();
  }

  // -------------------------------------------------------------------------
  // Registration and lifecycle
  // -------------------------------------------------------------------------

  /** Declare a builtin plugin. Nothing runs until `enable`. */
  register(entry: RegisteredPlugin): void {
    const { manifest } = entry;
    if (this.registered.has(manifest.id)) {
      throw new Error(`plugin "${manifest.id}" is registered twice`);
    }
    this.registered.set(manifest.id, entry);
    this.records.set(manifest.id, {
      manifest,
      plugin: entry.create(),
      state: "disabled",
    });
  }

  /** Start every registered plugin that is not disabled, in registration order. */
  async startAll(): Promise<void> {
    for (const id of this.registered.keys()) {
      if (this.disabled.has(id)) continue;
      await this.enable(id).catch((e: unknown) => {
        this.options.logger.error(`could not enable plugin ${id}`, e);
      });
    }
  }

  async enable(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) throw new Error(`no plugin "${id}"`);
    if (record.state === "running" || record.state === "starting") return;
    this.guardEngines(record.manifest);
    record.state = "starting";
    record.error = undefined;
    this.changed();

    const data = join(this.options.dataDir, "plugins", id);
    mkdirSync(data, { recursive: true });
    const sink = this.sinkFor(id);
    const ctx: PluginContext = {
      pluginId: id,
      dataDir: data,
      resolveSession: (sessionId) => this.options.resolveSession(sessionId),
      config: (record.manifest.config as Record<string, unknown> | undefined) ?? {},
      logger: {
        info: (m, d) => this.log(id, "info", m, d),
        warn: (m, d) => this.log(id, "warn", m, d),
        error: (m, d) => this.log(id, "error", m, d),
      },
      emit: (event) => sink.emit(event),
    };

    // A fresh instance on every start: a plugin that failed half-way through
    // initialize may hold resources it never reported, and reusing it would
    // make restart a different operation than enable-after-disable.
    const fresh = this.registered.get(id)!.create();
    record.plugin = fresh;
    try {
      await fresh.initialize(ctx);
      if (fresh.onEvent) fresh.onEvent((event) => sink.emit(event));
      record.state = "running";
      record.initializedAt = Date.now();
      this.disabled.delete(id);
      this.persist();
      this.changed();
    } catch (e) {
      record.state = "failed";
      record.error = e instanceof Error ? e.message : String(e);
      this.options.logger.error(`plugin ${id} failed to initialize`, e);
      this.changed();
      throw e;
    }
  }

  async disable(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) throw new Error(`no plugin "${id}"`);
    this.disabled.add(id);
    await this.stopRecord(record);
    this.persist();
    this.changed();
  }

  async restart(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) throw new Error(`no plugin "${id}"`);
    await this.stopRecord(record);
    await this.enable(id);
  }

  /** Stop everything. Called when the service shuts down. */
  async stopAll(): Promise<void> {
    this.stopping = true;
    for (const record of this.records.values()) {
      await this.stopRecord(record);
    }
  }

  private async stopRecord(record: PluginRecord): Promise<void> {
    if (record.state !== "running" && record.state !== "failed" && record.state !== "starting") {
      record.state = "disabled";
      return;
    }
    record.state = "stopping";
    this.changed();
    try {
      await record.plugin.shutdown();
    } catch (e) {
      this.options.logger.warn(`plugin ${record.manifest.id} failed to shut down`, e);
    }
    record.state = "disabled";
    record.initializedAt = undefined;
    this.changed();
  }

  private guardEngines(manifest: PluginManifest): void {
    const range = manifest.engines?.strata;
    if (!range) return;
    const verdict = satisfiesRange(STRATA_VERSION, range);
    if (!verdict.ok) {
      throw new Error(`plugin "${manifest.id}" ${verdict.reason ?? "does not support this version"}`);
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  idle(): boolean {
    return this.stopping;
  }

  list(): { id: string; state: PluginState; error?: string; manifest: PluginManifest }[] {
    return [...this.records.values()].map((r) => ({
      id: r.manifest.id,
      state: r.state,
      error: r.error,
      manifest: r.manifest,
    }));
  }

  summary(): PluginSummary[] {
    return [...this.records.values()].map((r) => ({
      id: r.manifest.id,
      name: r.manifest.name,
      version: r.manifest.version,
      description: r.manifest.description,
      provides: r.manifest.provides,
      tools: r.manifest.tools.map((t) => ({ name: t.name, description: t.description })),
      resources: r.manifest.resources.map((r2) => ({ key: r2.key, mime: r2.mime })),
      panel: r.manifest.panel,
      hooks: r.manifest.hooks,
      ui: r.manifest.ui,
    }));
  }

  get(id: string): PluginRecord | undefined {
    return this.records.get(id);
  }

  /**
   * The tool table the adapters pull.
   *
   * Deliberately session-free: OpenCode loads a plugin (and its tools) once,
   * before any session exists, so a table that varied by session could not be
   * registered there at all. Whether a call is allowed is decided at call
   * time, which is the only place the answer is current anyway.
   */
  toolTable(): ToolEntry[] {
    const out: ToolEntry[] = [];
    for (const record of this.records.values()) {
      if (record.state !== "running") continue;
      for (const tool of record.plugin.listTools()) {
        const declared = record.manifest.tools.find((t) => t.name === tool.name);
        out.push({
          plugin_id: record.manifest.id,
          tool: tool.name,
          name: qualifiedToolName(record.manifest.id, tool.name),
          description: tool.description,
          input: tool.input,
          policy: declared?.policy,
          guards: declared?.guards,
          timeout_ms: declared?.timeout_ms,
        });
      }
    }
    return out;
  }

  /** Resolve a route segment pair back to a running plugin and tool. */
  resolveTool(
    pluginId: string,
    tool: string,
  ): { record: PluginRecord; entry: ToolEntry } | undefined {
    const record = this.records.get(pluginId);
    if (!record || record.state !== "running") return undefined;
    const entry = this.toolTable().find((t) => t.plugin_id === pluginId && t.tool === tool);
    if (!entry) return undefined;
    return { record, entry };
  }

  /** Resolve `<plugin>_<tool>` as an adapter sees it. */
  resolveQualified(name: string): { pluginId: string; tool: string } | undefined {
    const split = splitToolName(name);
    if (!split) return undefined;
    if (!this.resolveTool(split.pluginId, split.tool)) return undefined;
    return split;
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  /**
   * Run a tool.
   *
   * Guards run here rather than in the route: they are a property of the tool
   * declaration, and a second caller of `callTool` (a test, the MCP adapter,
   * a future one) must get the same refusal. The caller has already asked
   * policy; this method does not.
   */
  async callTool(
    pluginId: string,
    tool: string,
    req: { callId?: string; sessionId: string; input: Record<string, unknown>; signal: AbortSignal },
  ): Promise<ToolCallResult> {
    const found = this.resolveTool(pluginId, tool);
    if (!found) throw new Error(`no tool ${pluginId}_${tool}`);
    const { record, entry } = found;
    const guardError = this.checkGuards(pluginId, entry.guards ?? {}, req.input, req.sessionId);
    if (guardError) throw new GuardError(guardError);

    const timeout = entry.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (req.signal.aborted) controller.abort();
    else req.signal.addEventListener("abort", onAbort, { once: true });

    /**
     * Why the call stopped, if it stopped for a reason the host chose.
     *
     * A plugin is given a signal, and a well-behaved one stops when it fires.
     * One that ignores it must not hold the host — a tool call that never
     * returns is a session that never settles — so the host stops *waiting*
     * even when the plugin keeps running, and says which of the two happened.
     */
    // Resolve the join key once, before the call: a progress event reported a
    // second later must be attached to the call that started now, not to
    // whichever one happens to be pending when it arrives.
    const callId =
      req.callId ?? this.options.pendingCall?.(req.sessionId, qualifiedToolName(pluginId, tool));

    let stopped: "timeout" | "interrupted" | undefined;
    const abortReason = new Promise<never>((_, reject) => {
      const stop = (why: "timeout" | "interrupted") => {
        stopped = why;
        controller.abort();
        reject(new Error(why === "timeout" ? `timed out after ${timeout}ms` : "interrupted"));
      };
      controller.signal.addEventListener(
        "abort",
        () => {
          if (stopped) return;
          stop("interrupted");
        },
        { once: true },
      );
      setTimeout(() => {
        if (!stopped) {
          stopped = "timeout";
          controller.abort();
          reject(new Error(`timed out after ${timeout}ms`));
        }
      }, timeout).unref?.();
    });

    try {
      const result = await Promise.race([
        record.plugin.callTool({
          tool,
          callId: req.callId,
          sessionId: req.sessionId,
          input: req.input,
          signal: controller.signal,
          progress: (event) => {
            this.options.onProgress?.({
              plugin_id: pluginId,
              tool,
              call_id: callId,
              session_id: req.sessionId,
              message: event.message,
              percent: event.percent,
              data: event.data,
            });
          },
        }),
        abortReason,
      ]);
      return result;
    } finally {
      // Let a late resolution be dropped rather than surface as an unhandled
      // rejection after the caller has already been told the call failed.
      abortReason.catch(() => {});
      req.signal.removeEventListener("abort", onAbort);
    }
  }

  async readResource(
    pluginId: string,
    key: string,
    sessionId: string,
  ): Promise<{ mime: string; body: Uint8Array | string }> {
    const record = this.records.get(pluginId);
    if (!record || record.state !== "running") throw new Error(`no plugin "${pluginId}"`);
    if (!record.manifest.resources.some((r) => r.key === key)) throw new Error(`no resource ${key}`);
    if (!record.plugin.readResource) throw new Error(`plugin "${pluginId}" has no resources`);
    const result = await record.plugin.readResource({ key, sessionId });
    return { mime: result.mime, body: result.body };
  }

  /** `ANY /plugins/:id/<rest>`. */
  async route(pluginId: string, req: Request, subpath: string): Promise<Response | undefined> {
    const record = this.records.get(pluginId);
    if (!record || record.state !== "running") return undefined;
    if (!record.plugin.route) return undefined;
    return record.plugin.route(req, subpath);
  }

  // -------------------------------------------------------------------------
  // Hooks
  // -------------------------------------------------------------------------

  /**
   * Ask every plugin that declared this tool.
   *
   * Fail-open on a plugin error or a timeout, and on purpose: a hook that
   * cannot answer must not be a hook that blocks work the reader asked for.
   * Only a plugin that explicitly answered `allow: false` denies the call.
   */
  async beforeTool(req: {
    sessionId: string;
    tool: string;
    input: Record<string, unknown>;
  }): Promise<{ allow: true } | { allow: false; message: string }> {
    for (const record of this.records.values()) {
      if (record.state !== "running") continue;
      const declared = record.manifest.hooks?.beforeTool ?? [];
      if (!declared.includes(req.tool)) continue;
      if (!record.plugin.beforeToolCall) continue;
      try {
        const verdict = await withTimeout(
          record.plugin.beforeToolCall({
            tool: req.tool,
            input: req.input,
            sessionId: req.sessionId,
          }),
          5_000,
        );
        if (!verdict.allow) return { allow: false, message: verdict.message };
      } catch (e) {
        this.options.logger.warn(`plugin ${record.manifest.id} hook failed for ${req.tool}`, e);
      }
    }
    return { allow: true };
  }

  /** Concatenate every plugin's contribution, in registration order. */
  async systemPrompt(sessionId: string): Promise<string> {
    const parts: string[] = [];
    for (const record of this.records.values()) {
      if (record.state !== "running") continue;
      if (!record.manifest.hooks?.systemPrompt) continue;
      if (!record.plugin.systemPrompt) continue;
      try {
        const text = await withTimeout(record.plugin.systemPrompt(sessionId), 5_000);
        if (text && text.trim().length > 0) parts.push(text.trim());
      } catch (e) {
        this.options.logger.warn(`plugin ${record.manifest.id} system prompt failed`, e);
      }
    }
    return parts.join("\n\n");
  }

  // -------------------------------------------------------------------------
  // Session and directory lifecycle
  // -------------------------------------------------------------------------

  async sessionEnded(sessionId: string): Promise<void> {
    for (const record of this.records.values()) {
      if (record.state !== "running") continue;
      try {
        await record.plugin.sessionEnded?.(sessionId);
      } catch (e) {
        this.options.logger.warn(`plugin ${record.manifest.id} session cleanup failed`, e);
      }
    }
  }

  async releaseDirectory(dir: string): Promise<void> {
    for (const record of this.records.values()) {
      if (record.state !== "running") continue;
      try {
        await record.plugin.releaseDirectory?.(dir);
      } catch (e) {
        this.options.logger.warn(`plugin ${record.manifest.id} directory release failed`, e);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /** Subscribe to plugin events for one plugin's SSE stream. */
  subscribe(pluginId: string, listener: (event: PluginEvent) => void): () => void {
    const sink = this.sinkFor(pluginId);
    return sink.add(listener);
  }

  /** Whether a running plugin exists; used to decide 404 vs 200 on the event route. */
  isRunning(pluginId: string): boolean {
    return this.records.get(pluginId)?.state === "running";
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private sinkFor(id: string): EventSink {
    let sink = this.sinks.get(id);
    if (!sink) {
      const listeners = new Set<(e: PluginEvent) => void>();
      const created = {
        emit: (event: PluginEvent) => {
          // A plugin forwarding a service event (dev.*) goes to /stream, not
          // to its own stream: the UI already listens there for it, and
          // duplicating it would make every dev process appear twice.
          if (event.type === "stream") {
            this.options.onStreamEvent?.(event.data);
            return;
          }
          for (const fn of listeners) {
            try {
              fn(event);
            } catch {
              // one broken reader must not starve the others
            }
          }
        },
        add: (listener: (e: PluginEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      this.sinks.set(id, created);
      sink = created;
    }
    return sink;
  }

  private changed(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // a listener that throws is a UI bug, not a host failure
      }
    }
  }

  // -------------------------------------------------------------------------
  // Guards
  // -------------------------------------------------------------------------

  private checkGuards(
    pluginId: string,
    guards: Record<string, ToolGuard>,
    input: Record<string, unknown>,
    sessionId: string,
  ): string | undefined {
    for (const [field, guard] of Object.entries(guards)) {
      const value = input[field];
      if (value === undefined) continue;
      if (guard === "workspace") {
        if (typeof value !== "string") return `${field} must be a path`;
        const root = this.options.workspaceOf(sessionId);
        if (!root) return `this session has no workspace, so ${field} cannot be checked`;
        if (!insidePath(root, value)) return `${field} must stay inside the session workspace`;
        continue;
      }
      if (guard === "net") {
        // The same parse the plugin itself uses, so a tool documented to take
        // `host:port` is not refused here before the plugin sees it.
        const parsed = parseHttpUrl(value);
        if (parsed.error) return `${field}: ${parsed.error}`;
        const host = parsed.host!;
        const allowed = this.records.get(pluginId)?.manifest.permissions.net;
        // No allowlist means the manifest did not say which hosts are its
        // business; the guard then only holds the scheme and credential rules,
        // which is what a declaration of `net` without entries means.
        if (allowed && allowed.length > 0 && !hostAllowed(host, allowed)) {
          return `${field}: ${host} is not in this plugin's network allowlist`;
        }
        continue;
      }
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  private loadState(): void {
    if (!existsSync(this.stateFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, "utf8")) as unknown;
      if (!raw || typeof raw !== "object") return;
      const disabled = (raw as { disabled?: unknown }).disabled;
      if (Array.isArray(disabled)) {
        for (const id of disabled) if (typeof id === "string") this.disabled.add(id);
      }
    } catch {
      // A corrupt state file must not stop the service: the default is
      // "everything enabled", which is what a missing file means too.
    }
  }

  private persist(): void {
    try {
      writeSecureJson(this.stateFile, { disabled: [...this.disabled].sort() });
    } catch (e) {
      this.options.logger.warn("could not write plugins-state.json", e);
    }
  }

  private log(id: string, level: "info" | "warn" | "error", message: string, data?: unknown): void {
    const suffix = data === undefined ? "" : ` ${safeJson(data)}`;
    this.options.logger[level](`[plugin:${id}] ${message}${suffix}`);
  }
}

/** A guard refused the call. The route turns this into a 403, not a tool error. */
export class GuardError extends Error {}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
  } catch {
    return String(value);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Whether `target` (a relative or absolute path) stays inside `root`. */
function insidePath(root: string, target: string): boolean {
  const base = resolve(root);
  const full = isAbsolute(target) ? resolve(target) : resolve(base, target);
  const rel = relative(base, full);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}


/** Load and register manifests given as data — the entry point `builtin.ts` uses. */
export function manifestOf(raw: unknown): PluginManifest {
  return loadManifest(raw);
}
