import { z } from "zod";
import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();

export const ContentBlock = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking"), text: z.string() }),
  z
    .object({
      type: z.literal("image"),
      mime: z.string(),
      data: z.string().optional(),
      uri: z.string().optional(),
    })
    .refine((b) => (b.data === undefined) !== (b.uri === undefined), {
      message: "exactly one of data/uri required",
    }),
  z.object({
    type: z.literal("file_ref"),
    path: z.string(),
    range: z.object({ start: z.number(), end: z.number() }).optional(),
  }),
]);
export type ContentBlock = z.infer<typeof ContentBlock>;

export const Usage = z.object({
  input: z.number().int().min(0),
  output: z.number().int().min(0),
  reasoning: z.number().int().min(0).optional(),
  cache_read: z.number().int().min(0).optional(),
  cache_write: z.number().int().min(0).optional(),
});
export type Usage = z.infer<typeof Usage>;

const Source = z.object({
  backend: z.string(),
  agent: z.string().optional(),
  native_id: z.string().optional(),
});

const EnvelopeBase = z.object({
  id: z.string(),
  session_id: z.string(),
  seq: z.number().int().min(1),
  ts: z.string().datetime({ offset: true }),
  source: Source,
});

const data = {
  "session.started": z.object({
    workspace: z.string(),
    title: z.string().optional(),
    model: z.string().optional(),
    parent_session_id: z.string().optional(),
    fork_point: z.object({ event_id: z.string() }).optional(),
  }),
  "session.ended": z.object({
    reason: z.enum(["completed", "cancelled", "error"]),
    error: z.string().optional(),
  }),
  "session.status": z.object({
    state: z.enum(["busy", "idle"]),
  }),
  // later snapshot of title / directory / archive. Omitted fields stay as they were.
  "session.updated": z.object({
    title: z.string().optional(),
    workspace: z.string().optional(),
    archived: z.boolean().optional(),
  }),
  "session.deleted": z.object({}),
  "turn.user": z.object({
    turn_id: z.string(),
    content: z.array(ContentBlock),
  }),
  "turn.assistant": z.object({
    turn_id: z.string(),
    content: z.array(ContentBlock),
    // backend message id — lets a later snapshot replace an earlier partial
    // one for the same message instead of appending a duplicate
    msg_id: z.string().optional(),
    // still streaming: a later snapshot (or the final completed event)
    // supersedes this content
    partial: z.boolean().optional(),
    model: z.string().optional(),
    usage: Usage.optional(),
    cost_usd: z.number().min(0).optional(),
    latency_ms: z.number().int().min(0).optional(),
    stop_reason: z.string().optional(),
  }),
  "tool.call": z.object({
    turn_id: z.string(),
    call_id: z.string(),
    tool: z.string(),
    input: z.record(z.unknown()),
  }),
  "tool.result": z.object({
    call_id: z.string(),
    status: z.enum(["ok", "error", "interrupted"]),
    output: z.string().optional(),
    latency_ms: z.number().int().min(0).optional(),
  }),
  "permission.requested": z.object({
    request_id: z.string(),
    call_id: z.string().optional(),
    tool: z.string(),
    input: z.record(z.unknown()),
    options: z.array(z.string()).optional(),
  }),
  "permission.resolved": z.object({
    request_id: z.string(),
    decision: z.enum(["allow", "deny"]),
    by: z.enum(["user", "policy", "auto"]),
    scope: z.enum(["once", "session", "always"]).optional(),
    rule_id: z.string().optional(),
    reason: z.string().optional(),
  }),
  "file.changed": z.object({
    path: z.string(),
    change: z.enum(["add", "modify", "delete"]),
    diff: z.string().optional(),
  }),
  "plan.updated": z.object({
    entries: z.array(
      z.object({
        content: z.string(),
        status: z.enum(["pending", "in_progress", "completed"]),
      }),
    ),
  }),
  "question.asked": z.object({
    request_id: z.string(),
    questions: z.array(
      z.object({
        question: z.string(),
        header: z.string(),
        options: z.array(z.object({ label: z.string(), description: z.string() })),
        multiple: z.boolean().optional(),
        custom: z.boolean().optional(),
      }),
    ),
  }),
  "question.resolved": z.object({
    request_id: z.string(),
    decision: z.enum(["reply", "reject"]),
    answers: z.array(z.array(z.string())).optional(),
  }),
} as const;

export const EVENT_TYPES = Object.keys(data) as [EventType, ...EventType[]];

const variants: z.ZodDiscriminatedUnionOption<"type">[] = Object.entries(data).map(
  ([type, d]) =>
    EnvelopeBase.extend({ type: z.literal(type), data: d }) as z.ZodDiscriminatedUnionOption<"type">,
);

export const Event = z.discriminatedUnion(
  "type",
  variants as [
    z.ZodDiscriminatedUnionOption<"type">,
    ...z.ZodDiscriminatedUnionOption<"type">[],
  ],
);

type DataMap = { [K in keyof typeof data]: z.infer<(typeof data)[K]> };
type Envelope = z.infer<typeof EnvelopeBase>;
export type Event = {
  [K in keyof DataMap]: Omit<Envelope, "type"> & { type: K; data: DataMap[K] };
}[keyof DataMap];
export type EventType = Event["type"];

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventInput = DistOmit<Event, "seq" | "id"> & { id?: string };

export const EventInput = z.discriminatedUnion(
  "type",
  variants.map(
    (v) =>
      z.object({
        id: z.string().optional(),
        session_id: z.string(),
        ts: z.string().datetime({ offset: true }).optional(),
        source: Source,
        type: v.shape.type as z.ZodTypeAny,
        data: v.shape.data as z.ZodTypeAny,
      }) as z.ZodDiscriminatedUnionOption<"type">,
  ) as [
    z.ZodDiscriminatedUnionOption<"type">,
    ...z.ZodDiscriminatedUnionOption<"type">[],
  ],
);

export function parseEvent(e: unknown): Event {
  return Event.parse(e) as Event;
}
export function safeParseEvent(e: unknown): z.SafeParseReturnType<unknown, Event> {
  return Event.safeParse(e) as z.SafeParseReturnType<unknown, Event>;
}
export function makeEvent(
  input: Omit<EventInput, "id" | "ts"> & { id?: string; ts?: string },
): EventInput {
  const parsed = EventInput.parse(input);
  return { ...parsed, id: parsed.id ?? ulid(), ts: parsed.ts ?? new Date().toISOString() } as EventInput;
}

export const DEFAULT_SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/g,
];

export interface RedactRules {
  paths?: string[];
  patterns?: RegExp[];
}

const REDACTED = "[redacted]";

export function redact(event: Event, rules: RedactRules): Event {
  const clone = structuredClone(event);
  const dataObj = clone.data as Record<string, unknown>;

  for (const path of rules.paths ?? []) {
    const segs = path.split(".");
    const walk = (node: unknown, i: number): void => {
      if (node === null || typeof node !== "object") return;
      const seg = segs[i]!;
      const entries =
        seg === "*"
          ? Object.values(node)
          : [((node as Record<string, unknown>)[seg])];
      for (const next of entries) {
        if (i === segs.length - 1) {
          if (seg === "*") {
            for (const k of Object.keys(node as object)) {
              (node as Record<string, unknown>)[k] = REDACTED;
            }
          } else if (seg in (node as Record<string, unknown>)) {
            (node as Record<string, unknown>)[seg] = REDACTED;
          }
        } else {
          walk(next, i + 1);
        }
      }
    };
    walk(dataObj, 0);
  }

  const pats = (rules.patterns ?? []).map(
    (p) => new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g"),
  );
  const scrub = (node: unknown): void => {
    if (typeof node === "string") return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (typeof node[i] === "string") {
          for (const p of pats) node[i] = (node[i] as string).replace(p, REDACTED);
        } else scrub(node[i]);
      }
    } else if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === "string") {
          let s = v;
          for (const p of pats) s = s.replace(p, REDACTED);
          (node as Record<string, unknown>)[k] = s;
        } else scrub(v);
      }
    }
  };
  if (pats.length) scrub(dataObj);
  return clone;
}
