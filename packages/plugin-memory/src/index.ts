// Durable memory: notes that outlive the session.
//
// The agent reads and writes them; the reader sees, edits, disables and
// deletes them in Settings → Memory. They live one layer above the
// repository — in the app's own data directory, not in a file the project
// carries — so nothing here ends up in a commit, and a workspace that is
// thrown away takes its notes with it.
//
// Two scopes, and the difference is the difference between a fact about the
// reader and a fact about a project:
//
// - `global` — holds everywhere. The reader's language, their preferences,
//   the rules they have given more than once.
// - `workspace` — holds for one directory. Its conventions, the decisions
//   taken in it, the pitfalls found in it.
//
// A fact that is wrong is worse than no fact, because the model will believe
// it. So a memory is disabled rather than deleted when it is temporarily
// wrong, it carries the time it was written, and the reader can turn any
// entry off from the settings page.

import { randomBytes } from "node:crypto";
import type {
  PluginContext,
  PluginManifest,
  ResourceRequest,
  ResourceResult,
  StrataPlugin,
  ToolCallRequest,
  ToolCallResult,
} from "@agent-strata/plugin-sdk";
import { DEFAULT_PROMPT_BUDGET, renderPrompt } from "./render";
import { MemoryStore, MemoryStoreError } from "./store";
import type { MemoryEntry, MemoryScope } from "./types";
import { workspaceKey } from "./workspace";

export const manifest: PluginManifest = {
  id: "memory",
  name: "Durable memory",
  version: "1.0.0",
  description:
    "Notes that carry across sessions: the reader's preferences and this workspace's conventions.",
  // Off until the reader asks for it. What this plugin collects is the most
  // personal thing in the box, and nobody agreed to that by installing the
  // app.
  default: "disabled",
  entry: { kind: "builtin" },
  provides: ["tools", "resources"],
  permissions: {},
  hooks: { beforeTool: [], systemPrompt: true },
  tools: [
    {
      name: "add",
      description: [
        "Remember one durable fact for later sessions.",
        "",
        "Save what a later session would need and cannot read from the repository:",
        "the reader's preferences, this workspace's conventions, a decision and the",
        "reason behind it, a pitfall that cost time. Do not save what a file, a test,",
        "or git history already says — that belongs in the code, where the next person",
        "finds it.",
        "",
        "One fact per entry, self-contained: a later session reads it without this",
        "conversation. Write \"User prefers replies in Traditional Chinese.\", not",
        "\"he said that earlier\".",
        "",
        "`scope` is `workspace` (the default when the session has one) or `global`.",
        "Global is for facts about the reader that hold in every project, and is used",
        "sparingly; a project's conventions belong to the project.",
        "",
        "`key` names the fact so a later write replaces it instead of piling up beside",
        "it: use a stable slug such as `deploy.prod`. Without a key, every call adds a",
        "new entry.",
        "",
        "The reader sees every entry in Settings → Memory, where it can be edited,",
        "disabled or deleted.",
      ].join("\n"),
      input: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The fact to remember, one self-contained sentence.",
          },
          scope: {
            type: "string",
            enum: ["global", "workspace"],
            description: "Where it holds. Defaults to the session's workspace.",
          },
          key: {
            type: "string",
            description: "A stable name for the fact, so a later write replaces it.",
          },
        },
        required: ["text"],
      },
      policy: { default: "allow", risk: "write" },
    },
    {
      name: "list",
      description: [
        "List the memories in one scope, oldest first.",
        "",
        "Use it to see what is already remembered before saving something new, and to",
        "find the id a later `memory_update` or `memory_remove` needs.",
      ].join("\n"),
      input: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["global", "workspace"] },
          enabled_only: { type: "boolean", description: "Only the entries that are injected." },
        },
      },
      policy: { default: "allow", risk: "read" },
    },
    {
      name: "search",
      description: "Search the memories for a word or phrase. Matches the text and the key.",
      input: {
        type: "object",
        properties: {
          query: { type: "string", description: "The word or phrase to look for." },
          scope: { type: "string", enum: ["global", "workspace"] },
        },
        required: ["query"],
      },
      policy: { default: "allow", risk: "read" },
    },
    {
      name: "update",
      description: [
        "Change a memory that is already there.",
        "",
        "Use it when a remembered fact turns out to be wrong or out of date — a stale",
        "memory is worse than none, because the model believes it. Set `enabled` to",
        "false to keep an entry without injecting it.",
      ].join("\n"),
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "The id from a memory list or search." },
          text: { type: "string", description: "The new text." },
          enabled: { type: "boolean", description: "False keeps it without injecting it." },
        },
        required: ["id"],
      },
      policy: { default: "allow", risk: "write" },
    },
    {
      name: "remove",
      description: "Forget a memory. The entry is removed from the file, not just from the prompt.",
      input: {
        type: "object",
        properties: { id: { type: "string", description: "The id from a memory list or search." } },
        required: ["id"],
      },
      policy: { default: "allow", risk: "write" },
    },
  ],
  resources: [{ key: "memories", mime: "application/json", scope: "session" }],
  settings: {
    type: "object",
    properties: {
      maxPromptChars: {
        type: "number",
        default: DEFAULT_PROMPT_BUDGET,
        // The protocol alone is 671 characters, so anything below it would
        // buy silence rather than a smaller prompt.
        minimum: 1_000,
        maximum: 40_000,
        step: 500,
        title: "Prompt budget",
        description:
          "The ceiling on what memory may add to one prompt, protocol included. Entries that do not fit are left out and the model is told.",
      },
      maxEntries: {
        type: "number",
        default: 200,
        minimum: 10,
        maximum: 2_000,
        step: 10,
        title: "Entries per scope",
        description: "How many memories one scope may hold before saving is refused.",
      },
      maxEntryChars: {
        type: "number",
        default: 2_000,
        minimum: 100,
        maximum: 8_000,
        step: 100,
        title: "Characters per entry",
        description: "How long one memory may be.",
      },
    },
  },
};

const TOOLS = new Set(["add", "list", "search", "update", "remove"]);

export interface MemoryPluginOptions {
  /** Where a session's workspace is; a session without one can only keep global memories. */
  workspaceOf(sessionId: string): string | undefined;
  /** A store to use instead of the default one. Tests use it; production does not. */
  store?: MemoryStore;
}

/** Where a scope's file lives, and the key that names it. */
interface Target {
  scope: MemoryScope;
  key?: string;
}

export function createMemoryPlugin(options: MemoryPluginOptions): StrataPlugin {
  let context: PluginContext | undefined;
  let store: MemoryStore | undefined;

  const memory = (): MemoryStore => {
    if (!store) throw new Error("the memory plugin was called before it initialized");
    return store;
  };

  const number = (key: string, fallback: number): number => {
    const value = Number(context?.config[key] ?? fallback);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };

  /** The workspace a session works in, and the key its notes are filed under. */
  const workspaceOf = (sessionId: string): Target => {
    const path = options.workspaceOf(sessionId);
    if (!path) return { scope: "global" };
    return { scope: "workspace", key: workspaceKey(path) };
  };

  const pathOf = (sessionId: string): string | undefined => options.workspaceOf(sessionId);

  const entriesOf = (scope: MemoryScope, key?: string): MemoryEntry[] =>
    memory().read(scope, key).memories;

  /**
   * Read one scope for the prompt, and treat an unreadable file as an empty
   * scope rather than as the end of the prompt.
   *
   * The two scopes live in two files. A hand edit that went wrong in one of
   * them — or a file that lost permission — must not cost the reader the
   * other: the facts that still hold would vanish from every session, and the
   * only sign would be a warning nobody reads.
   */
  const safeEntries = (scope: MemoryScope, key?: string): MemoryEntry[] => {
    try {
      return [...entriesOf(scope, key)].reverse();
    } catch (error) {
      context?.logger.warn(`memory could not be read for the ${scope} scope`, error);
      return [];
    }
  };

  /**
   * The two scopes a session sees, each newest first.
   *
   * The newest first because a stale memory is the dangerous kind: when the
   * budget is tight, the ones most likely to still be true are the ones that
   * must survive.
   *
   * A scope whose file cannot be read comes back empty instead of taking the
   * other one with it: the two live in two files, and one of them going wrong
   * must not cost the facts that are still there.
   */
  const visibleTo = (sessionId: string): { workspace: MemoryEntry[]; global: MemoryEntry[] } => {
    const where = workspaceOf(sessionId);
    return {
      workspace: where.scope === "workspace" ? safeEntries("workspace", where.key) : [],
      global: safeEntries("global"),
    };
  };

  const newId = (): string => `m_${randomBytes(4).toString("hex")}`;

  const now = (): string => new Date().toISOString();

  /**
   * Change one entry in one scope; returns it, or undefined when it is not
   * there. Each scope is its own file, so a lookup across both is two
   * independent writes rather than one write over both.
   *
   * `source` records who last wrote the text: the agent's claim and the
   * reader's own are not the same kind of memory. Turning an entry off is not
   * a rewrite, so it leaves the source alone.
   */
  const updateIn = (
    target: Target,
    id: string,
    text: string | undefined,
    enabled: boolean | undefined,
    source: "agent" | "user",
  ): MemoryEntry | undefined => {
    // A lookup that finds nothing must not rewrite the file: the other scope
    // may hold the entry, and a file rewritten for nothing is a file that
    // moved under the reader's feet.
    if (!memory().read(target.scope, target.key).memories.some((row) => row.id === id)) {
      return undefined;
    }
    let found: MemoryEntry | undefined;
    memory().mutate(target.scope, target.key, (file) => {
      const entry = file.memories.find((row) => row.id === id);
      if (!entry) return;
      if (text !== undefined) {
        entry.text = text;
        entry.source = source;
      }
      if (enabled !== undefined) entry.enabled = enabled;
      entry.updated_at = now();
      found = entry;
    });
    return found;
  };

  const removeIn = (target: Target, id: string): MemoryEntry | undefined => {
    if (!memory().read(target.scope, target.key).memories.some((row) => row.id === id)) {
      return undefined;
    }
    let found: MemoryEntry | undefined;
    memory().mutate(target.scope, target.key, (file) => {
      found = file.memories.find((entry) => entry.id === id);
      if (found) file.memories = file.memories.filter((entry) => entry.id !== id);
    });
    return found;
  };

  /**
   * Forget every entry in one scope; returns how many there were.
   *
   * Disabling a plugin and forgetting what it remembered are different acts:
   * one stops the reading, the other drops what was written. A reader who
   * wants the second should not have to find the data directory by hand.
   *
   * The file is emptied, not deleted. An empty file and a missing file mean
   * the same thing to the store, but an empty one leaves the reader's own
   * file in place for them to look at.
   */
  const clearScope = (target: Target): number => {
    const existing = memory().read(target.scope, target.key).memories;
    if (!existing.length) return 0;
    memory().mutate(target.scope, target.key, (file) => {
      file.memories = [];
    });
    return existing.length;
  };

  /**
   * Every scope the plugin knows about: the global one and every workspace
   * it has seen.
   *
   * The index is the list of workspaces, not the directory listing, so a
   * workspace whose file was deleted by hand is still known — and clearing it
   * is still correct, because clearing writes an empty file rather than
   * deleting one.
   */
  const allTargets = (): Target[] => {
    const targets: Target[] = [{ scope: "global" }];
    for (const row of memory().readIndex().workspaces) {
      targets.push({ scope: "workspace", key: row.key });
    }
    return targets;
  };

  /** Both places an entry may live, nearest first. */
  const targetsOf = (sessionId: string): Target[] => {
    const where = workspaceOf(sessionId);
    return where.scope === "workspace"
      ? [{ scope: "workspace", key: where.key }, { scope: "global" }]
      : [{ scope: "global" }];
  };

  /** Save one fact, replacing the entry with the same key when there is one. */
  const save = (
    target: Target,
    text: string,
    key: string,
    source: "agent" | "user",
  ): MemoryEntry => {
    let saved: MemoryEntry | undefined;
    memory().mutate(target.scope, target.key, (file) => {
      if (key) {
        // The same key is the same fact: a second write replaces it rather
        // than adding a line beside it.
        const existing = file.memories.find((entry) => entry.key === key);
        if (existing) {
          const changed = existing.text !== text;
          existing.text = text;
          // Turning an entry back on is the reader's call. An agent that
          // writes a *different* text under the same key has a new version of
          // the fact and it goes back in; an agent repeating itself does not
          // get to undo the reader's decision that it is wrong.
          if (changed || source === "user") existing.enabled = true;
          existing.source = source;
          existing.updated_at = now();
          saved = existing;
          return;
        }
      }
      if (file.memories.length >= number("maxEntries", 200)) {
        throw new Error(
          `this scope already holds ${file.memories.length} memories — remove one, or give the fact a key so it replaces an older one`,
        );
      }
      const entry: MemoryEntry = {
        id: newId(),
        text,
        enabled: true,
        ...(key ? { key } : {}),
        source,
        created_at: now(),
        updated_at: now(),
      };
      file.memories.push(entry);
      saved = entry;
    });
    if (!saved) throw new Error("the memory was not saved");
    return saved;
  };

  return {
    async initialize(ctx: PluginContext) {
      context = ctx;
      store =
        options.store ??
        new MemoryStore({
          dataDir: ctx.dataDir,
          maxEntries: number("maxEntries", 200),
          maxEntryChars: number("maxEntryChars", 2_000),
        });
    },

    listTools() {
      return manifest.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input: tool.input,
      }));
    },

    /**
     * The contribution to the system prompt.
     *
     * Rebuilt on every model call, so it has to be cheap and it has to be
     * stable: the same memories must produce the same text, or the prompt
     * cache misses on every turn.
     */
    async systemPrompt(sessionId: string): Promise<string | undefined> {
      const path = pathOf(sessionId);
      if (path) {
        // Recording the workspace is a side effect, not a requirement: if it
        // fails, the settings page loses a tab — but the session still gets
        // its memories.
        try {
          memory().touchWorkspace(workspaceKey(path), path, now());
        } catch (error) {
          context?.logger.warn("memory could not record the workspace", error);
        }
      }
      try {
        const rendered = renderPrompt({
          ...visibleTo(sessionId),
          budget: number("maxPromptChars", DEFAULT_PROMPT_BUDGET),
        });
        // Nothing remembered, nothing said: a reader who never uses memory
        // pays nothing for it, and the tool descriptions already say when to
        // save.
        return rendered.empty ? undefined : rendered.text;
      } catch (error) {
        context?.logger.warn("memory could not be rendered", error);
        return undefined;
      }
    },

    async callTool(req: ToolCallRequest): Promise<ToolCallResult> {
      if (!TOOLS.has(req.tool)) return { output: `unknown tool ${req.tool}`, isError: true };
      try {
        const input = req.input ?? {};
        const where = workspaceOf(req.sessionId);

        if (req.tool === "add") {
          const text = typeof input.text === "string" ? input.text.trim() : "";
          if (!text) throw new Error("text is required");
          const limit = number("maxEntryChars", 2_000);
          if (text.length > limit) throw new Error(`a memory may be at most ${limit} characters`);
          const scope = resolveScope(input.scope, where);
          const key = typeof input.key === "string" ? input.key.trim() : "";
          if (scope === "workspace" && !where.key) {
            throw new Error("this session has no workspace, so its memory can only be global");
          }
          const target: Target = scope === "workspace" ? { scope, key: where.key } : { scope };
          const saved = save(target, text, key, "agent");
          return { output: JSON.stringify({ memory: saved }) };
        }

        if (req.tool === "list") {
          const scope = resolveScope(input.scope, where);
          const target = targetFor(scope, where);
          const enabledOnly = input.enabled_only === true;
          const memories = entriesOf(target.scope, target.key).filter(
            (entry) => !enabledOnly || entry.enabled,
          );
          return { output: JSON.stringify({ scope: target.scope, memories }) };
        }

        if (req.tool === "search") {
          const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
          if (!query) throw new Error("query is required");
          const scope = resolveScope(input.scope, where);
          const target = targetFor(scope, where);
          const hits = entriesOf(target.scope, target.key).filter(
            (entry) =>
              entry.text.toLowerCase().includes(query) ||
              (entry.key ?? "").toLowerCase().includes(query),
          );
          return { output: JSON.stringify({ scope: target.scope, query, memories: hits }) };
        }

        if (req.tool === "update") {
          const id = typeof input.id === "string" ? input.id : "";
          if (!id) throw new Error("id is required");
          const text = typeof input.text === "string" ? input.text.trim() : undefined;
          if (text !== undefined) {
            const limit = number("maxEntryChars", 2_000);
            if (!text) throw new Error("text may not be empty");
            if (text.length > limit) throw new Error(`a memory may be at most ${limit} characters`);
          }
          const enabled = typeof input.enabled === "boolean" ? input.enabled : undefined;
          let updated: MemoryEntry | undefined;
          for (const target of targetsOf(req.sessionId)) {
            updated = updateIn(target, id, text, enabled, "agent");
            if (updated) break;
          }
          if (!updated) throw new Error(`there is no memory called ${id}`);
          return { output: JSON.stringify({ memory: updated }) };
        }

        if (req.tool === "remove") {
          const id = typeof input.id === "string" ? input.id : "";
          if (!id) throw new Error("id is required");
          let removed: MemoryEntry | undefined;
          for (const target of targetsOf(req.sessionId)) {
            removed = removeIn(target, id);
            if (removed) break;
          }
          if (!removed) throw new Error(`there is no memory called ${id}`);
          return { output: `Forgot ${id}.` };
        }

        throw new Error(`unknown tool ${req.tool}`);
      } catch (error) {
        return { output: error instanceof Error ? error.message : String(error), isError: true };
      }
    },

    /** The management surface the settings page uses. */
    async route(req: Request, subpath: string): Promise<Response | undefined> {
      try {
        if (subpath === "/workspaces" && req.method === "GET") {
          return Response.json(memory().readIndex());
        }
        if (subpath === "/memories" && req.method === "GET") {
          const url = new URL(req.url);
          const target = targetFromQuery(url.searchParams);
          if (!target) return Response.json({ error: "a workspace scope needs a key" }, { status: 400 });
          return Response.json({ scope: target.scope, memories: entriesOf(target.scope, target.key) });
        }
        if (subpath === "/memories" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const text = typeof body.text === "string" ? body.text.trim() : "";
          if (!text) return Response.json({ error: "text is required" }, { status: 400 });
          const limit = number("maxEntryChars", 2_000);
          if (text.length > limit) {
            return Response.json({ error: `a memory may be at most ${limit} characters` }, { status: 400 });
          }
          const url = new URL(req.url);
          const target = targetFromQuery(url.searchParams) ?? { scope: "global" as const };
          const key = typeof body.key === "string" ? body.key.trim() : "";
          const saved = save(target, text, key, "user");
          return Response.json({ memory: saved });
        }
        if (subpath === "/memories" && req.method === "DELETE") {
          // Forget everything, in one scope or in all of them.
          const url = new URL(req.url);
          const scope = url.searchParams.get("scope");
          if (scope === "all") {
            let count = 0;
            for (const target of allTargets()) count += clearScope(target);
            return Response.json({ ok: true, forgotten: count });
          }
          const target = targetFromQuery(url.searchParams);
          if (!target) return Response.json({ error: "a workspace scope needs a key" }, { status: 400 });
          return Response.json({ ok: true, forgotten: clearScope(target) });
        }
        const one = /^\/memories\/([\w-]+)$/.exec(subpath);
        if (one) {
          const id = one[1]!;
          const url = new URL(req.url);
          const target = targetFromQuery(url.searchParams) ?? { scope: "global" as const };
          if (req.method === "DELETE") {
            const removed = removeIn(target, id);
            if (!removed) return Response.json({ error: "not found" }, { status: 404 });
            return Response.json({ ok: true });
          }
          if (req.method === "PATCH") {
            const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
            const text = typeof body.text === "string" ? body.text.trim() : undefined;
            if (text !== undefined) {
              const limit = number("maxEntryChars", 2_000);
              if (!text) return Response.json({ error: "text may not be empty" }, { status: 400 });
              if (text.length > limit) {
                return Response.json({ error: `a memory may be at most ${limit} characters` }, { status: 400 });
              }
            }
            const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;
            const updated = updateIn(target, id, text, enabled, "user");
            if (!updated) return Response.json({ error: "not found" }, { status: 404 });
            return Response.json({ memory: updated });
          }
        }
        return undefined;
      } catch (error) {
        const status = error instanceof MemoryStoreError ? error.status : 400;
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status },
        );
      }
    },

    async readResource(req: ResourceRequest): Promise<ResourceResult> {
      if (req.key !== "memories" || !req.sessionId) throw new Error("no such resource");
      const visible = visibleTo(req.sessionId);
      return {
        mime: "application/json",
        body: JSON.stringify({ memories: [...visible.workspace, ...visible.global] }),
      };
    },

    async shutdown() {
      store = undefined;
      context = undefined;
    },
  };
}

function resolveScope(given: unknown, fallback: Target): MemoryScope {
  if (given === "global") return "global";
  if (given === "workspace") return "workspace";
  return fallback.scope;
}

/**
 * The file a scope names. A session without a workspace can only keep global
 * memories, and saying that is more use to the model than a file key.
 */
function targetFor(scope: MemoryScope, where: Target): Target {
  if (scope !== "workspace") return { scope };
  if (!where.key) throw new Error("this session has no workspace, so its memory can only be global");
  return { scope, key: where.key };
}

/**
 * The scope and key a request names; undefined when a workspace has no key.
 *
 * The query names the scope and the workspace; the entry's own key travels in
 * the body, so `key` never means two things in one request.
 */
function targetFromQuery(params: URLSearchParams): Target | undefined {
  const scope: MemoryScope = params.get("scope") === "workspace" ? "workspace" : "global";
  const key = params.get("workspace") ?? undefined;
  if (scope === "workspace" && !key) return undefined;
  return scope === "workspace" ? { scope, key } : { scope };
}

export { MemoryStore, MemoryStoreError } from "./store";
export { MEMORY_PROTOCOL, DEFAULT_PROMPT_BUDGET, renderPrompt } from "./render";
export type { MemoryEntry, MemoryFile, MemoryScope, WorkspaceEntry, WorkspaceIndex } from "./types";
export { workspaceKey } from "./workspace";
export default createMemoryPlugin;
