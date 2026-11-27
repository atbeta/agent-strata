import {
  createOpencodeClient,
  type Event,
  type FilePartInput,
  type OpencodeClient,
  type Part,
  type Session,
} from "@opencode-ai/sdk/v2";
import type { OpencodePromptPart } from "./types";

type Obj = Record<string, unknown>;
type ClientConfig = NonNullable<Parameters<typeof createOpencodeClient>[0]>;

const zeroTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

function object(value: unknown): Obj {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function v2Agent(value: unknown): string {
  const name = text(value);
  return name.toLowerCase() === "build" || name.toLowerCase() === "plan" ? name.toLowerCase() : name;
}

function directoryOf(info: Obj): string {
  return text(object(info.location).directory, text(info.directory));
}

function legacySession(raw: unknown): Session {
  const info = object(raw);
  const directory = directoryOf(info);
  const model = object(info.model);
  return {
    ...info,
    slug: text(info.slug, text(info.id)),
    directory,
    path: text(info.path, text(info.subpath)),
    version: text(info.version, "2"),
    model: info.model
      ? {
          id: text(model.id, text(model.modelID)),
          providerID: text(model.providerID),
          ...(model.variant !== undefined ? { variant: model.variant } : {}),
        }
      : undefined,
    time: {
      created: number(object(info.time).created),
      updated: number(object(info.time).updated, number(object(info.time).created)),
      ...(object(info.time).archived !== undefined ? { archived: object(info.time).archived } : {}),
    },
  } as unknown as Session;
}

function partBase(messageID: string, sessionID: string, id: string): Obj {
  return { id, messageID, sessionID };
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((row) => {
        const item = object(row);
        return text(item.text, text(item.value));
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

function legacyTool(raw: Obj, messageID: string, sessionID: string): Part {
  const state = object(raw.state);
  const status = text(state.status, "completed");
  const content = outputText(state.content);
  const metadata = {
    ...object(state.structured),
    ...(state.content !== undefined ? { content: state.content } : {}),
    ...(state.result !== undefined ? { result: state.result } : {}),
  };
  const mappedState =
    status === "error"
      ? {
          status: "error",
          input: object(state.input),
          error: text(object(state.error).message, content || "tool failed"),
          time: { start: number(object(raw.time).created), end: number(object(raw.time).completed) },
          metadata,
        }
      : status === "completed"
        ? {
            status: "completed",
            input: object(state.input),
            output: content || outputText(state.result),
            time: { start: number(object(raw.time).created), end: number(object(raw.time).completed) },
            metadata,
            ...(state.attachments !== undefined ? { attachments: state.attachments } : {}),
          }
        : {
            status: status === "pending" ? "pending" : "running",
            input: object(state.input),
            time: { start: number(object(raw.time).created) },
            metadata,
          };
  return {
    ...partBase(messageID, sessionID, text(raw.id)),
    type: "tool",
    tool: text(raw.name, text(raw.tool, "unknown")),
    callID: text(raw.callID, text(raw.id)),
    state: mappedState,
  } as unknown as Part;
}

function legacyMessage(raw: unknown, sessionID: string, parentID?: string) {
  const message = object(raw);
  const id = text(message.id);
  const type = text(message.type);
  const time = object(message.time);
  if (type === "user") {
    const files = Array.isArray(message.files) ? message.files : [];
    return {
      info: { id, sessionID, role: "user", time },
      parts: [
        {
          ...partBase(id, sessionID, `${id}:text`),
          type: "text",
          text: text(message.text),
        },
        ...files.map((file, index) => {
          const attachment = object(file);
          return {
            ...partBase(id, sessionID, text(attachment.id, `${id}:file:${index}`)),
            type: "file",
            mime: text(attachment.mime, "application/octet-stream"),
            url: text(attachment.uri, text(attachment.url)),
            filename: text(attachment.name, text(attachment.filename)),
          };
        }),
      ],
    };
  }
  if (type === "assistant") {
    const model = object(message.model);
    const content = Array.isArray(message.content) ? message.content : [];
    const parts = content.map((rawPart) => {
      const part = object(rawPart);
      const partID = text(part.id);
      if (part.type === "tool") return legacyTool(part, id, sessionID);
      return {
        ...partBase(id, sessionID, partID),
        type: part.type === "reasoning" ? "reasoning" : "text",
        text: text(part.text),
        ...(part.time !== undefined ? { time: part.time } : {}),
      } as Part;
    });
    return {
      info: {
        id,
        sessionID,
        role: "assistant",
        parentID,
        time,
        providerID: text(model.providerID),
        modelID: text(model.id, text(model.modelID)),
        ...(model.variant !== undefined ? { variant: model.variant } : {}),
        agent: text(message.agent),
        cost: number(message.cost),
        tokens: message.tokens ?? zeroTokens,
        finish: text(message.finish),
        ...(message.error !== undefined ? { error: message.error } : {}),
      },
      parts,
    };
  }
  if (type === "shell") {
    return {
      info: {
        id,
        sessionID,
        role: "assistant",
        parentID,
        time,
        providerID: "",
        modelID: "",
        tokens: zeroTokens,
      },
      parts: [
        {
          ...partBase(id, sessionID, `${id}:shell`),
          type: "tool",
          tool: "bash",
          callID: text(message.callID, id),
          state: {
            status: time.completed === undefined ? "running" : "completed",
            input: { command: text(message.command) },
            output: text(message.output),
            time: { start: number(time.created), end: number(time.completed) },
          },
        } as unknown as Part,
      ],
    };
  }
  if (type === "compaction") {
    return {
      info: {
        id,
        sessionID,
        role: "assistant",
        parentID,
        time,
        providerID: "",
        modelID: "",
        tokens: zeroTokens,
      },
      parts: [
        {
          ...partBase(id, sessionID, `${id}:compaction`),
          type: "compaction",
          auto: message.reason === "auto",
        } as unknown as Part,
      ],
    };
  }
  return undefined;
}

function latestUserMessageID(pendingUsers: Map<string, Part>, sessionID: string): string | undefined {
  let messageID: string | undefined;
  for (const part of pendingUsers.values()) {
    if (part.sessionID === sessionID) messageID = part.messageID;
  }
  return messageID;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * A v2 permission row, in the shape the v1 mapper already understands.
 *
 * The live event is `permission.v2.asked`: `action` is the tool, `resources`
 * are the command lines, and the call id sits on `source.id` rather than
 * `tool.callID`. A list row has the same shape and no `tool`.
 */
function legacyPermission(raw: Obj): Obj {
  const source = object(raw.source);
  const tool = object(raw.tool);
  const messageID = text(tool.messageID, text(source.messageID));
  const callID = text(tool.callID, text(source.callID, text(source.id)));
  const patterns = Array.isArray(raw.patterns) ? stringList(raw.patterns) : stringList(raw.resources);
  const always = Array.isArray(raw.always) ? stringList(raw.always) : stringList(raw.save);
  return {
    ...raw,
    permission: text(raw.permission, text(raw.action)),
    patterns,
    metadata: object(raw.metadata),
    always,
    ...(messageID || callID ? { tool: { messageID, callID } } : {}),
  };
}

export function normalizeV2Event(raw: unknown, pendingUsers: Map<string, Part>): Event | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  let envelope = raw as Obj;
  if (envelope.payload && typeof envelope.payload === "object") envelope = object(envelope.payload);
  const type = text(envelope.type);
  if (!type) return undefined;
  const data = object(envelope.properties && typeof envelope.properties === "object" ? envelope.properties : envelope.data);
  const sessionID = text(data.sessionID);
  const location = object(envelope.location);
  const base = { id: text(envelope.id), type, properties: data } as unknown as Event;
  if (type === "session.inbox.enqueued" && object(data.item).type === "user") {
    const messageID = text(data.inboxID);
    const payload = object(object(data.item).payload);
    pendingUsers.set(messageID, {
      ...partBase(messageID, sessionID, `${messageID}:text`),
      type: "text",
      text: text(payload.text),
    } as unknown as Part);
    return {
      ...base,
      type: "message.updated",
      properties: {
        sessionID,
        info: { id: messageID, sessionID, role: "user", time: { created: number(envelope.created) } },
      },
    } as Event;
  }
  if (type === "session.inbox.delivered") {
    const part = pendingUsers.get(text(data.inboxID));
    if (part) {
      return {
        ...base,
        type: "message.part.updated",
        properties: { sessionID, part, time: number(envelope.created) },
      } as Event;
    }
  }
  const withInfo = (eventType: string) => {
    const info = legacySession({
      ...object(data.info),
      id: text(object(data.info).id, sessionID),
      location: Object.keys(object(data.info)).length > 0 ? object(data.info).location : location,
      time: Object.keys(object(data.info)).length > 0 ? object(data.info).time : { created: number(envelope.created), updated: number(envelope.created) },
    });
    return {
      id: text(envelope.id),
      type: eventType,
      properties: { sessionID: text(info.id, sessionID), info },
    } as unknown as Event;
  };
  if (type === "session.created") return withInfo(type);
  if (["session.renamed", "session.metadata.updated", "session.usage.updated", "session.updated"].includes(type)) {
    return withInfo("session.updated");
  }
  if (type === "session.deleted") return withInfo(type);
  if (type === "session.execution.started") {
    return { ...base, type: "session.status", properties: { sessionID, status: { type: "busy" } } } as Event;
  }
  if (["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(type)) {
    return { ...base, type: "session.idle", properties: { sessionID } } as Event;
  }
  if (type === "session.step.started") {
    const model = object(data.model);
    const messageID = text(data.assistantMessageID);
    return {
      ...base,
      type: "message.updated",
      properties: {
        sessionID,
        info: {
          id: messageID,
          sessionID,
          role: "assistant",
          parentID: latestUserMessageID(pendingUsers, sessionID),
          time: { created: number(data.started, number(envelope.created)) },
          providerID: text(model.providerID),
          modelID: text(model.id),
          ...(model.variant !== undefined ? { variant: model.variant } : {}),
          agent: text(data.agent),
          tokens: zeroTokens,
        },
      },
    } as Event;
  }
  if (type === "session.step.ended") return base;
  if (type === "session.text.started" || type === "session.reasoning.started" || type === "session.text.ended" || type === "session.reasoning.ended") {
    const messageID = text(data.assistantMessageID);
    const partID = `${messageID}:${type.split(".")[1]}:${number(data.ordinal)}`;
    return {
      ...base,
      type: "message.part.updated",
      properties: {
        sessionID,
        part: {
          ...partBase(messageID, sessionID, partID),
          type: type.startsWith("session.reasoning") ? "reasoning" : "text",
          text: text(data.text),
        },
        time: number(envelope.created),
      },
    } as Event;
  }
  if (type === "session.text.delta" || type === "session.reasoning.delta") {
    const messageID = text(data.assistantMessageID);
    return {
      ...base,
      type: "message.part.delta",
      properties: {
        sessionID,
        messageID,
        partID: `${messageID}:${type.split(".")[1]}:${number(data.ordinal)}`,
        field: "text",
        delta: text(data.delta),
      },
    } as Event;
  }
  if (type === "permission.asked" || type === "permission.v2.asked") {
    return {
      ...base,
      type: "permission.asked",
      properties: legacyPermission(data),
    } as Event;
  }
  if (type === "permission.replied" || type === "permission.v2.replied") {
    return {
      ...base,
      type: "permission.replied",
      properties: {
        sessionID: text(data.sessionID, sessionID),
        requestID: text(data.requestID, text(data.id)),
        reply: text(data.reply, text(data.decision)),
      },
    } as Event;
  }
  if (type === "session.revert.staged" || type === "session.revert.cleared") {
    return {
      ...base,
      properties: {
        ...data,
        ...(data.messageID !== undefined ? { revert: { messageID: data.messageID } } : {}),
      },
    } as Event;
  }
  return base;
}

function historyParts(events: unknown[]): Part[] {
  const parts = new Map<string, Part>();
  for (const raw of events) {
    const event = normalizeV2Event(raw, new Map());
    if (!event) continue;
    if (event.type === "message.part.updated") {
      const part = event.properties.part as Part;
      parts.set(part.id, part);
      continue;
    }
    if (event.type === "message.part.delta") {
      const delta = event.properties;
      const previous = parts.get(delta.partID);
      if (previous && (previous.type === "text" || previous.type === "reasoning")) {
        parts.set(delta.partID, { ...previous, text: previous.text + delta.delta });
      }
    }
  }
  return [...parts.values()];
}

export function createVersionedOpencodeClient(
  config: ClientConfig & { apiVersion?: "v1" | "v2" },
): OpencodeClient {
  const { apiVersion = "v1", ...clientConfig } = config;
  const client = createOpencodeClient(clientConfig);
  if (apiVersion === "v1") return client;

  const rawFetch = (clientConfig.fetch ?? globalThis.fetch) as typeof fetch;
  const base = text(clientConfig.baseUrl, "http://localhost:4096").replace(/\/+$/, "");
  const request = async (
    path: string,
    init?: { method?: string; body?: unknown; signal?: AbortSignal },
  ): Promise<{ data?: unknown; error?: unknown; response: Response }> => {
    const response = await rawFetch(
      new Request(`${base}${path}`, {
        method: init?.method ?? "GET",
        headers: {
          ...clientConfig.headers,
          ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: init?.signal,
      }),
    );
    const body = await response.text();
    let parsed: unknown;
    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      parsed = body;
    }
    return response.ok ? { data: parsed, response } : { error: parsed, response };
  };
  const unwrap = <T>(result: { data?: { data?: T } | T }): T | undefined => {
    const data = result.data;
    if (data && typeof data === "object" && "data" in data) return (data as { data?: T }).data;
    return data as T | undefined;
  };
  const subscribe = async (options?: { signal?: AbortSignal }) => {
    const opened = await client.v2.event.subscribe(options as never);
    const pendingUsers = new Map<string, Part>();
    const stream = (async function* () {
      for await (const raw of opened.stream) {
        const event = normalizeV2Event(raw, pendingUsers);
        if (event) yield event;
      }
    })();
    return { ...opened, stream };
  };
  const listSessions = async (options: Obj = {}) => {
    const limit = typeof options.limit === "number" ? Math.min(options.limit, 100) : options.limit;
    const result = await client.v2.session.list({ ...options, limit } as never);
    const rows = unwrap<unknown[]>(result) ?? [];
    return { ...result, data: rows.map(legacySession), cursor: object(result.data).cursor };
  };
  const pageCursors = new Map<number, string>();
  const permissionSessions = new Map<string, string>();
  const questionSessions = new Map<string, string>();
  const listPermissions = async (directory?: string) => {
    const result = await client.v2.permission.request.list({ location: { directory } });
    const rows = (object(result.data).data ?? []) as unknown[];
    for (const raw of rows) {
      const row = object(raw);
      if (text(row.id) && text(row.sessionID)) permissionSessions.set(text(row.id), text(row.sessionID));
    }
    return {
      ...result,
      data: rows.map((raw) => legacyPermission(object(raw))),
    };
  };
  const listQuestions = async (directory?: string) => {
    const result = await client.v2.question.request.list({ location: { directory } });
    const rows = (object(result.data).data ?? []) as unknown[];
    for (const raw of rows) {
      const row = object(raw);
      if (text(row.id) && text(row.sessionID)) questionSessions.set(text(row.id), text(row.sessionID));
    }
    return { ...result, data: rows };
  };
  const sessionIDFor = async (requestID: string, directory: string | undefined, question: boolean) => {
    const known = (question ? questionSessions : permissionSessions).get(requestID);
    if (known) return known;
    if (question) await listQuestions(directory);
    else await listPermissions(directory);
    const found = (question ? questionSessions : permissionSessions).get(requestID);
    if (!found) throw new Error(`${question ? "question" : "permission"} request not found: ${requestID}`);
    return found;
  };

  const compatible = {
    ...client,
    v2: client.v2,
    global: { ...client.global, event: subscribe },
    event: { ...client.event, subscribe },
    project: {
      ...client.project,
      list: async () => {
        const result = await request("/api/project");
        const rows = (Array.isArray(result.data) ? result.data : object(result.data).data ?? []) as unknown[];
        return {
          ...result,
          data: rows.map((raw) => {
            const project = object(raw);
            return { ...project, worktree: text(project.worktree, text(project.canonical)) };
          }),
        };
      },
    },
    experimental: {
      ...client.experimental,
      session: {
        ...client.experimental.session,
        list: async (options: Obj) => {
          const numericCursor = typeof options.cursor === "number" ? options.cursor : undefined;
          const cursor = numericCursor === undefined ? undefined : pageCursors.get(numericCursor);
          if (numericCursor !== undefined && !cursor) return { data: [] };
          const result = await listSessions({
            ...options,
            parentID: options.roots === true ? null : options.parentID,
            archived: options.archived === undefined ? true : options.archived,
            cursor,
          });
          const rows = result.data;
          const oldest = rows.reduce<number | undefined>((found, row) => {
            const updated = number(row.time?.updated, number(row.time?.created));
            return found === undefined || updated < found ? updated : found;
          }, undefined);
          const next = object(result.cursor).next;
          if (oldest !== undefined && typeof next === "string") pageCursors.set(oldest, next);
          return { ...result, data: rows };
        },
      },
    },
    session: {
      ...client.session,
      list: listSessions,
      get: async (options: { sessionID: string }) => {
        const result = await client.v2.session.get(options);
        return { ...result, data: unwrap<unknown>(result) ? legacySession(unwrap(result)) : undefined };
      },
      create: async (options: { title?: string; directory?: string }, requestOptions?: { signal?: AbortSignal }) => {
        const result = await client.v2.session.create(
          { location: { directory: options.directory } } as never,
          requestOptions as never,
        );
        const created = unwrap<unknown>(result);
        if (created && options.title) {
          await request(`/api/session/${encodeURIComponent(text(object(created).id))}`, {
            method: "PATCH",
            body: { title: options.title },
          });
        }
        return { ...result, data: created ? legacySession(created) : undefined };
      },
      messages: async (options: { sessionID: string }) => {
        const all: unknown[] = [];
        let cursor: string | undefined;
        for (;;) {
          const result = await client.v2.session.messages({
            sessionID: options.sessionID,
            ...(cursor ? { cursor } : { limit: 50, order: "asc" }),
          });
          if (result.error) throw new Error(JSON.stringify(result.error));
          const body = object(result.data);
          const rows = (body.data ?? []) as unknown[];
          all.push(...rows);
          const next = object(body.cursor).next;
          if (typeof next !== "string" || rows.length < 50) break;
          cursor = next;
        }
        const needsHistory = all.some((raw) => {
          const message = object(raw);
          return message.type === "assistant" && (!Array.isArray(message.content) || message.content.length === 0);
        });
        const history: unknown[] = [];
        if (needsHistory) {
          let after: number | undefined;
          for (;;) {
            const result = await client.v2.session.history({ sessionID: options.sessionID, limit: 500, after });
            if (result.error) throw new Error(JSON.stringify(result.error));
            const body = object(result.data);
            const rows = (body.data ?? []) as unknown[];
            history.push(...rows);
            if (body.hasMore !== true || rows.length === 0) break;
            after = number(object(object(rows.at(-1)).durable).seq, 0);
            if (after <= 0) break;
          }
        }
        let parentID: string | undefined;
        const messages = [];
        for (const raw of all) {
          const mapped = legacyMessage(raw, options.sessionID, parentID);
          if (!mapped) continue;
          if (mapped.info.role === "user") parentID = mapped.info.id;
          if (mapped.info.role === "assistant" && mapped.parts.length === 0 && history.length > 0) {
            mapped.parts = historyParts(history);
          }
          messages.push(mapped);
        }
        return { data: messages };
      },
      todo: async () => ({ data: undefined }),
      children: async (options: { sessionID: string; directory?: string }) =>
        listSessions({ directory: options.directory, parentID: options.sessionID }),
      promptAsync: async (options: {
        sessionID: string;
        parts: OpencodePromptPart[];
        agent?: string;
        model?: { providerID: string; modelID: string };
        variant?: string;
      }, requestOptions?: { signal?: AbortSignal }) => {
        if (options.agent) {
          const switched = await client.v2.session.switchAgent({ sessionID: options.sessionID, agent: v2Agent(options.agent) });
          if (switched.error) return switched;
        }
        if (options.model || options.variant) {
          const switched = await client.v2.session.switchModel({
            sessionID: options.sessionID,
            model: {
              providerID: options.model?.providerID,
              id: options.model?.modelID,
              ...(options.variant ? { variant: options.variant } : {}),
            } as never,
          });
          if (switched.error) return switched;
        }
        const files = options.parts.filter((part): part is FilePartInput => part.type === "file");
        return request(`/api/session/${encodeURIComponent(options.sessionID)}/prompt`, {
          method: "POST",
          signal: requestOptions?.signal,
          body: {
            text: options.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
            files: files.map((file) => ({
              uri: file.url,
              ...(file.filename ? { name: file.filename } : {}),
            })),
          },
        });
      },
      status: async () => {
        const result = await client.v2.session.active();
        const active = object(object(result.data).data);
        return {
          ...result,
          data: Object.fromEntries(Object.keys(active).map((id) => [id, { type: "busy" }])),
        };
      },
      abort: async (options: { sessionID: string }, requestOptions?: { signal?: AbortSignal }) => {
        const result = await client.v2.session.interrupt(options, requestOptions as never);
        return { ...result, data: result.error ? undefined : true };
      },
      command: async (options: Obj) => {
        const sessionID = text(options.sessionID);
        if (options.agent) {
          const switched = await client.v2.session.switchAgent({ sessionID, agent: v2Agent(options.agent) });
          if (switched.error) return switched;
        }
        if (options.model) {
          const [providerID, ...rest] = text(options.model).split("/");
          const switched = await client.v2.session.switchModel({
            sessionID,
            model: {
              providerID,
              id: rest.join("/"),
              ...(options.variant ? { variant: options.variant } : {}),
            } as never,
          });
          if (switched.error) return switched;
        }
        const parts = Array.isArray(options.parts) ? options.parts : [];
        const files = parts.filter((part): part is FilePartInput => object(part).type === "file");
        return request(`/api/session/${encodeURIComponent(sessionID)}/command`, {
          method: "POST",
          body: {
            name: options.command,
            text: options.arguments,
            files: files.map((file) => ({
              uri: file.url,
              ...(file.filename ? { name: file.filename } : {}),
            })),
          },
        });
      },
      shell: async (options: Obj) => {
        const sessionID = text(options.sessionID);
        if (options.agent) {
          const switched = await client.v2.session.switchAgent({ sessionID, agent: v2Agent(options.agent) });
          if (switched.error) return switched;
        }
        const model = object(options.model);
        if (model.providerID || model.modelID) {
          const switched = await client.v2.session.switchModel({
            sessionID,
            model: { providerID: model.providerID, id: model.modelID } as never,
          });
          if (switched.error) return switched;
        }
        return request(`/api/session/${encodeURIComponent(sessionID)}/shell`, {
          method: "POST",
          body: { command: options.command },
        });
      },
      fork: async (options: { sessionID: string; messageID?: string }) => {
        const result = await request(`/api/session/${encodeURIComponent(options.sessionID)}/fork`, {
          method: "POST",
          body: { before: options.messageID },
        });
        const created = result.data ? unwrap<unknown>(result as { data?: { data?: unknown } }) : undefined;
        return { ...result, data: created ? legacySession(created) : undefined };
      },
      summarize: async (options: { sessionID: string; providerID?: string; modelID?: string }) => {
        if (options.providerID || options.modelID) {
          await client.v2.session.switchModel({
            sessionID: options.sessionID,
            model: { providerID: options.providerID, id: options.modelID } as never,
          });
        }
        return client.v2.session.compact({ sessionID: options.sessionID });
      },
      share: async () => ({ error: "share is not supported by OpenCode v2", response: new Response(null, { status: 404 }) }),
      unshare: async () => ({ error: "share is not supported by OpenCode v2", response: new Response(null, { status: 404 }) }),
      update: async (options: { sessionID: string; title?: string; time?: { archived?: number } }) => {
        const result = await request(`/api/session/${encodeURIComponent(options.sessionID)}`, {
          method: "PATCH",
          body: { title: options.title, time: options.time },
        });
        const updated = result.data ? unwrap<unknown>(result as { data?: { data?: unknown } }) : undefined;
        return { ...result, data: updated ? legacySession(updated) : undefined };
      },
      delete: async (options: { sessionID: string }, requestOptions?: { signal?: AbortSignal }) =>
        request(`/api/session/${encodeURIComponent(options.sessionID)}`, {
          method: "DELETE",
          signal: requestOptions?.signal,
        }),
    },
    provider: {
      ...client.provider,
      list: async () => {
        const result = await client.v2.model.list();
        const models = (object(result.data).data ?? []) as unknown[];
        const providers = new Map<string, Obj>();
        const defaults: Record<string, string> = {};
        for (const raw of models) {
          const model = object(raw);
          if (model.enabled === false) continue;
          const providerID = text(model.providerID);
          const id = text(model.id);
          if (!providerID || !id) continue;
          if (!providers.has(providerID)) {
            providers.set(providerID, { id: providerID, source: "custom", env: [], models: {} });
            defaults[providerID] = id;
          }
          const provider = providers.get(providerID)!;
          const variants = Array.isArray(model.variants)
            ? Object.fromEntries(model.variants.map((variant) => [text(object(variant).id), {}]))
            : {};
          object(provider.models)[id] = {
            name: text(model.name, id),
            variants,
            limit: model.limit,
          };
        }
        return {
          ...result,
          data: {
            all: [...providers.values()],
            connected: [...providers.keys()],
            default: defaults,
          },
        };
      },
    },
    app: {
      ...client.app,
      agents: async () => {
        const result = await client.v2.agent.list();
        const rows = (object(result.data).data ?? []) as unknown[];
        return {
          ...result,
          data: rows.map((raw) => {
            const agent = object(raw);
            return { ...agent, name: text(agent.name, text(agent.id)) };
          }),
        };
      },
    },
    command: {
      ...client.command,
      list: async (options: { directory?: string }) => {
        const result = await client.v2.command.list({ location: { directory: options.directory } });
        return { ...result, data: object(result.data).data ?? [] };
      },
    },
    permission: {
      ...client.permission,
      list: (options: { directory?: string }) => listPermissions(options.directory),
      reply: async (options: { requestID: string; reply: "once" | "always" | "reject"; message?: string; directory?: string }) => {
        const sessionID = await sessionIDFor(options.requestID, options.directory, false);
        // The SDK still posts `{ reply }`. This server requires `{ decision }`
        // and answers 204 with an empty body, which is a successful reply.
        const result = await request(
          `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(options.requestID)}/reply`,
          {
            method: "POST",
            body: { decision: options.reply, ...(options.message ? { message: options.message } : {}) },
          },
        );
        return { ...result, data: result.error ? undefined : true };
      },
    },
    question: {
      ...client.question,
      list: (options: { directory?: string }) => listQuestions(options.directory),
      reply: async (options: { requestID: string; answers: string[][]; directory?: string }) => {
        const sessionID = await sessionIDFor(options.requestID, options.directory, true);
        return client.v2.session.question.reply({
          sessionID,
          requestID: options.requestID,
          questionV2Reply: { answers: options.answers },
        });
      },
      reject: async (options: { requestID: string; directory?: string }) => {
        const sessionID = await sessionIDFor(options.requestID, options.directory, true);
        return client.v2.session.question.reject({ sessionID, requestID: options.requestID });
      },
    },
    mcp: {
      ...client.mcp,
      connect: async (options: { name: string }) =>
        request(`/api/experimental/mcp/${encodeURIComponent(options.name)}/connect`, { method: "POST", body: {} }),
      disconnect: async (options: { name: string }) =>
        request(`/api/experimental/mcp/${encodeURIComponent(options.name)}/disconnect`, { method: "POST", body: {} }),
      add: async (options: { name: string; config: unknown }) =>
        request("/api/mcp", { method: "POST", body: { name: options.name, config: options.config } }),
    },
  };
  return compatible as unknown as OpencodeClient;
}
