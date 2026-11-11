import type { Event, Part } from "@opencode-ai/sdk/v2";
import { isStreamingSnapshot, type EventInput } from "@agent-strata/schema";
import { OpencodeMapper } from "./mapper";
import { OPENCODE_REBUILT_TYPES } from "./model";

export interface SnapshotMessage {
  info: { id: string; role: string; time?: { created?: number; completed?: number } };
  parts: Part[];
}

/** OpenCode's stored session, replayed as the bus events that would have built it. */
export function snapshotEvents(sessionID: string, info: unknown, messages: SnapshotMessage[]): Event[] {
  const part = (p: Part) =>
    ({
      id: `import:${p.id}`,
      type: "message.part.updated",
      properties: { sessionID, part: p, time: Date.now() },
    }) as unknown as Event;
  const out: Event[] = [
    { id: `import:${sessionID}`, type: "session.created", properties: { sessionID, info } } as unknown as Event,
  ];
  for (const m of messages) {
    const open = m.info.role === "assistant" && m.info.time?.completed === undefined;
    // parts first: a completed assistant message emits turn.assistant on message.updated
    for (const p of m.parts) out.push(part(p));
    out.push({
      id: `import:${m.info.id}`,
      type: "message.updated",
      properties: { sessionID, info: m.info },
    } as unknown as Event);
    // role and parent land on message.updated, so an in-progress assistant
    // only streams once the parts are applied a second time
    if (open) for (const p of m.parts) out.push(part(p));
  }
  return out;
}

/** Every rebuildable event for one session, mapped from scratch. */
export function rebuildEvents(events: Event[], directory?: string): EventInput[] {
  const mapper = new OpencodeMapper({ directory });
  return events
    .flatMap((e) => mapper.handle(e))
    .filter((e) => !isStreamingSnapshot(e) && OPENCODE_REBUILT_TYPES.includes(e.type));
}

