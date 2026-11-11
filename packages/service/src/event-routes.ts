import { compareSessions, exportEvents } from "@agent-strata/core";
import type { SessionView } from "@agent-strata/projector";
import type { EventQuery, Store } from "@agent-strata/store";

export async function eventRoute(
  req: Request,
  path: string,
  deps: {
    store: Store;
    sessionView(sessionId: string): SessionView;
    subscribers: Set<(payload: unknown) => void>;
    activeSyncs: Map<string, { done: number; total: number }>;
  },
): Promise<Response | undefined> {
  const url = new URL(req.url);

  if (path === "/events" && req.method === "GET") {
    const count = (raw: string | null): number | undefined | null => {
      if (raw === null || raw === "") return undefined;
      if (!/^\d+$/.test(raw)) return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    };
    const afterSeq = count(url.searchParams.get("after_seq"));
    const offset = count(url.searchParams.get("offset"));
    const limit = count(url.searchParams.get("limit"));
    if (afterSeq === null || offset === null || limit === null) {
      return Response.json({ error: "invalid query" }, { status: 400 });
    }
    const query: EventQuery = {
      session_id: url.searchParams.get("session_id") ?? undefined,
      backend: url.searchParams.get("backend") ?? undefined,
      types: url.searchParams.get("types")?.split(","),
      since: url.searchParams.get("since") ?? undefined,
      until: url.searchParams.get("until") ?? undefined,
      text: url.searchParams.get("text") ?? undefined,
      after_seq: afterSeq,
      order: (url.searchParams.get("order") as "asc" | "desc") ?? "asc",
      offset,
      limit,
    };
    return Response.json({ events: deps.store.query(query) });
  }

  if (path === "/usage/daily" && req.method === "GET") {
    const tz = url.searchParams.get("tz");
    let fmt: Intl.DateTimeFormat;
    try {
      if (tz === null) throw new Error("missing tz");
      fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    } catch {
      return Response.json({ error: "invalid tz" }, { status: 400 });
    }
    const dayOf = (iso: string): string => {
      const parts = fmt.formatToParts(new Date(iso));
      const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
      return `${get("year")}-${get("month")}-${get("day")}`;
    };
    interface DailyBucket {
      session_id: string;
      day: string;
      model: string | null;
      input: number;
      output: number;
      reasoning: number;
      cache_read: number;
      cache_write: number;
      cost_usd: number;
      messages: number;
      tool_calls: number;
      tool_errors: number;
    }
    const buckets = new Map<string, DailyBucket>();
    const bucket = (sessionId: string, day: string, model: string | null): DailyBucket => {
      const key = `${sessionId}\n${day}\n${model ?? ""}`;
      let found = buckets.get(key);
      if (!found) {
        found = {
          session_id: sessionId,
          day,
          model,
          input: 0,
          output: 0,
          reasoning: 0,
          cache_read: 0,
          cache_write: 0,
          cost_usd: 0,
          messages: 0,
          tool_calls: 0,
          tool_errors: 0,
        };
        buckets.set(key, found);
      }
      return found;
    };
    for (const summary of deps.store.listSessions()) {
      const view = deps.sessionView(summary.session_id);
      for (const turn of view.turns) {
        const modelByMsg = new Map<string, string | null>();
        for (const assistant of turn.assistant) {
          if (assistant.msg_id) modelByMsg.set(assistant.msg_id, assistant.model ?? null);
          if (!assistant.ts) continue;
          const current = bucket(summary.session_id, dayOf(assistant.ts), assistant.model ?? null);
          current.input += assistant.usage?.input ?? 0;
          current.output += assistant.usage?.output ?? 0;
          current.reasoning += assistant.usage?.reasoning ?? 0;
          current.cache_read += assistant.usage?.cache_read ?? 0;
          current.cache_write += assistant.usage?.cache_write ?? 0;
          current.cost_usd += assistant.cost_usd ?? 0;
          current.messages += 1;
        }
        for (const call of turn.tool_calls) {
          if (!call.ts) continue;
          const model = call.msg_id ? (modelByMsg.get(call.msg_id) ?? null) : null;
          const current = bucket(summary.session_id, dayOf(call.ts), model);
          current.tool_calls += 1;
          if (call.status === "error" || call.status === "interrupted") current.tool_errors += 1;
        }
      }
    }
    const rows = [...buckets.values()]
      .filter(
        (bucket) =>
          bucket.input + bucket.output + bucket.reasoning + bucket.cache_read + bucket.cache_write +
            bucket.cost_usd + bucket.messages + bucket.tool_calls + bucket.tool_errors >
          0,
      )
      .sort(
        (a, b) =>
          a.day.localeCompare(b.day) ||
          a.session_id.localeCompare(b.session_id) ||
          (a.model === null ? 1 : b.model === null ? -1 : a.model.localeCompare(b.model)),
      );
    return Response.json({ tz, rows });
  }

  if (path === "/compare" && req.method === "GET") {
    const a = url.searchParams.get("a");
    const b = url.searchParams.get("b");
    if (!a || !b) return Response.json({ error: "a and b session ids required" }, { status: 400 });
    return Response.json(compareSessions(deps.sessionView(a), deps.sessionView(b)));
  }

  if (path === "/export" && req.method === "GET") {
    const sessionId = url.searchParams.get("session_id") ?? undefined;
    const body = exportEvents(deps.store, {
      session_id: sessionId,
      redact: url.searchParams.get("redact") !== "false",
    });
    return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
  }

  if (path === "/stream") {
    let enqueue: ((payload: unknown) => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const drop = () => {
      if (enqueue) deps.subscribers.delete(enqueue);
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
    };
    const stream = new ReadableStream<string>({
      start(ctrl) {
        const write = (chunk: string) => {
          try {
            ctrl.enqueue(chunk);
          } catch {
            if (ctrl.desiredSize === null) drop();
          }
        };
        write(`data: ${JSON.stringify({ type: "service.connected" })}\n\n`);
        for (const [connectionId, sync] of deps.activeSyncs) {
          write(
            `data: ${JSON.stringify({ type: "sync.started", connection_id: connectionId, done: sync.done, total: sync.total })}\n\n`,
          );
        }
        heartbeat = setInterval(() => write(`: hb\n\n`), 15_000);
        enqueue = (payload) => write(`data: ${JSON.stringify(payload)}\n\n`);
        deps.subscribers.add(enqueue);
      },
      cancel() {
        drop();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  return undefined;
}
