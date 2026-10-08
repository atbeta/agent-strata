import { openStore } from "@agent-strata/store";
import { makeEvent, type EventInput } from "@agent-strata/schema";

const store = openStore(process.env.STRATA_DB!);
const ev = (sid: string, type: string, data: object, ts: string): EventInput =>
  makeEvent({ session_id: sid, type, ts, source: { backend: "opencode" }, data } as EventInput);
const t = (m: number) => new Date(Date.now() - m * 60000).toISOString();

for (const [i, [sid, title, ws]] of (
  [
    ["opencode:s1", "Refactor auth middleware", "~/repos/webapp"],
    ["opencode:s2", "Fix flaky payment test", "~/repos/billing"],
    ["opencode:s3", "Add rate limiting", "~/repos/api"],
  ] as const
).entries()) {
  const evs: EventInput[] = [
    ev(sid, "session.started", { workspace: ws, title }, t(30 - i * 10)),
    ev(sid, "turn.user", { turn_id: "t1", content: [{ type: "text", text: title }] }, t(29 - i * 10)),
    ev(sid, "turn.assistant", {
      turn_id: "t1",
      model: "anthropic/claude-sonnet-4",
      usage: { input: 2400, output: 900 },
      cost_usd: 0.031,
      latency_ms: 4200,
      content: [{ type: "text", text: "on it" }],
    }, t(28 - i * 10)),
    ev(sid, "tool.call", { turn_id: "t1", call_id: "c1", tool: "bash", input: { command: "npm test" } }, t(27 - i * 10)),
    ev(sid, "tool.result", { call_id: "c1", status: "ok", output: "42 passed", latency_ms: 3100 }, t(26 - i * 10)),
  ];
  if (sid !== "opencode:s3") {
    evs.push(ev(sid, "session.ended", { reason: "completed" }, t(20 - i * 10)));
  }
  store.append(evs);
}
console.log("seeded");
