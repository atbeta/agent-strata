// Streams one short reply through OpenCode and strata at once and reports
// whether a reader saw it being written. It creates a real session, spends a
// few hundred tokens on the server's default model, then deletes the session.
// Mid-reply it asks strata to sync, as the sidebar does on a timer and on
// focus, which must neither rebuild the session nor set its text back.
//
//   bun run scripts/probe-stream.ts
//
// OPENCODE_URL (default http://127.0.0.1:4096), STRATA_URL (default
// http://127.0.0.1:7700), PROBE_DIR (default the current directory).

const OC = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096";
const ST = process.env.STRATA_URL ?? "http://127.0.0.1:7700";
const dir = process.env.PROBE_DIR ?? process.cwd();
const q = `directory=${encodeURIComponent(dir)}`;
const t0 = Date.now();
const ms = () => Date.now() - t0;

type Frame = Record<string, any>;

async function sse(url: string, onData: (d: Frame) => void, signal: AbortSignal) {
  const res = await fetch(url, { signal, headers: { accept: "text/event-stream" } });
  if (!res.body) throw new Error(`${url} returned no stream`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            onData(JSON.parse(line.slice(5).trim()));
          } catch {
            // comment frames and heartbeats
          }
        }
      }
    }
  } catch {
    // aborted
  }
}

const abort = new AbortController();
let sid = "";
let deltas = 0;
let rebuilt = 0;
let finalAt: number | undefined;
let synced: Promise<unknown> | undefined;
const snapshots: { t: number; text: string; thinking: string }[] = [];
let idle!: () => void;
const done = new Promise<void>((resolve) => (idle = resolve));

void sse(
  `${OC}/event?${q}`,
  (e) => {
    const p = e.properties ?? {};
    if (!sid || p.sessionID !== sid) return;
    if (e.type === "message.part.delta") deltas++;
    if (e.type === "session.idle" || (e.type === "session.status" && p.status?.type === "idle")) idle();
  },
  abort.signal,
);

void sse(
  `${ST}/stream`,
  (e) => {
    if (!sid || e.session_id !== `opencode:${sid}`) return;
    if (e.type === "session.rebuilt") rebuilt++;
    if (e.type !== "turn.assistant") return;
    const blocks: { type: string; text?: string }[] = e.data?.content ?? [];
    const join = (type: string) =>
      blocks
        .filter((b) => b.type === type)
        .map((b) => b.text ?? "")
        .join("\n");
    if (!e.data?.partial) {
      finalAt = ms();
      return;
    }
    const snap = { t: ms(), text: join("text"), thinking: join("thinking") };
    snapshots.push(snap);
    if (!synced && snap.text) synced = fetch(`${ST}/sync`, { method: "POST" }).catch(() => {});
  },
  abort.signal,
);

await Bun.sleep(800);
const created = (await (
  await fetch(`${OC}/session?${q}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "strata stream probe" }),
  })
).json()) as { id: string };
sid = created.id;
await fetch(`${OC}/session/${sid}/prompt_async?${q}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    parts: [
      {
        type: "text",
        text: "Write the numbers 1 to 120 as English words, separated by spaces. Do not use any tools. No other text.",
      },
    ],
  }),
});
await Promise.race([done, Bun.sleep(90_000)]);
await Bun.sleep(1500);
await synced;
abort.abort();
await fetch(`${OC}/session/${sid}?${q}`, { method: "DELETE" });

// each frame must extend the one before it; a length check would miss text
// that was set back and then caught up
const monotonic = snapshots.every((s, i) => {
  const prev = snapshots[i - 1];
  return !prev || (s.text.startsWith(prev.text) && s.thinking.startsWith(prev.thinking));
});
const textFrames = snapshots.filter((s) => s.text).length;
const report = {
  session: sid,
  opencode_deltas: deltas,
  strata_snapshots: snapshots.length,
  text_frames: textFrames,
  synced_mid_reply: synced !== undefined,
  monotonic,
  rebuilt_during_run: rebuilt,
  final_landed: finalAt !== undefined,
  text_lengths: snapshots.filter((s) => s.text).map((s) => s.text.length),
};
console.log(JSON.stringify(report, null, 2));
const ok =
  textFrames >= 10 && synced !== undefined && monotonic && rebuilt === 0 && finalAt !== undefined;
process.exit(ok ? 0 : 1);
