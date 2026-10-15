// Decides whether a stop can be confirmed at all.
//
// The desktop UI holds "stopping" until the session reads idle and reports
// "stop did not land" after 8 seconds otherwise. This runs one long turn and
// aborts it mid-flight, recording every event the backend sends — so the
// question is answered by the log rather than by inference: does an abort
// produce the idle the confirmation watches for?
//
//   bun run scripts/probe-abort.ts

const OC = process.env.OPENCODE_URL ?? "http://127.0.0.1:14096";
const ST = process.env.STRATA_URL ?? "http://127.0.0.1:7700";
const dir = process.env.PROBE_DIR ?? process.cwd();
const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(6);

type Frame = Record<string, any>;

const log: { t: number; kind: string; detail: string }[] = [];
const note = (kind: string, detail: string) => {
  log.push({ t: Date.now() - t0, kind, detail });
  console.log(`[${ms()}ms] ${kind.padEnd(16)} ${detail}`);
};

// 1. A session, through strata so the ids line up with what the app shows.
const created = await fetch(`${ST}/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ workspace: dir }),
}).then((r) => r.json());
const casfId: string = created?.summary?.session_id ?? created?.id;
if (!casfId) throw new Error(`could not create a session: ${JSON.stringify(created)}`);
note("session", casfId);

// 2. Watch strata's event stream for this session only.
const seen: Frame[] = [];
const ac = new AbortController();
const watching = (async () => {
  const res = await fetch(`${ST}/stream`, {
    headers: { accept: "text/event-stream" },
    signal: ac.signal,
  });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const frame = JSON.parse(line.slice(5).trim()) as Frame;
        const sid = frame.session_id ?? frame.data?.session_id;
        if (sid && sid !== casfId) continue;
        seen.push(frame);
        const type = frame.type ?? "?";
        if (type.startsWith("session.")) note("EVENT", `${type} ${JSON.stringify(frame.data ?? {})}`);
      } catch {
        /* keepalive */
      }
    }
    buf = buf.slice(buf.lastIndexOf("\n") + 1);
  }
})().catch(() => {});

// 3. A prompt that will still be running in three seconds.
const prompt = `Write a detailed 3000-word essay about the history of the printing press. Take your time and be thorough.`;
void fetch(`${ST}/sessions/${encodeURIComponent(casfId)}/prompt`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
}).catch((e) => note("prompt-error", String(e)));
note("prompt", "sent");

// 4. Wait until it is genuinely busy, then abort.
let busySeen = false;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 250));
  const v = await fetch(`${ST}/sessions/${encodeURIComponent(casfId)}/view`)
    .then((r) => r.json())
    .catch(() => null);
  if (v?.busy) { busySeen = true; break; }
}
note("state", busySeen ? "busy — aborting now" : "never became busy");
if (!busySeen) {
  ac.abort();
  console.log("\nRESULT: inconclusive — the turn never started.");
  process.exit(0);
}

const abortRes = await fetch(`${ST}/sessions/${encodeURIComponent(casfId)}/abort`, { method: "POST" })
  .then(async (r) => ({ status: r.status, body: await r.text().catch(() => "") }))
  .catch((e) => ({ status: 0, body: String(e) }));
note("abort", `POST returned ${abortRes.status} ${abortRes.body.slice(0, 120)}`);

// 5. The question: does the session read idle within the UI's 8-second window?
let idleAt: number | null = null;
for (let i = 0; i < 48; i++) {
  await new Promise((r) => setTimeout(r, 250));
  const v = await fetch(`${ST}/sessions/${encodeURIComponent(casfId)}/view`)
    .then((r) => r.json())
    .catch(() => null);
  if (v && !v.busy) { idleAt = Date.now() - t0; break; }
}
ac.abort();

if (idleAt === null) {
  console.log(`\nRESULT: the session never went idle within ${idleAt ?? 12}s.`);
  console.log("         The UI's confirmation watches exactly this, so every stop is reported as failed.");
} else {
  console.log(`\nRESULT: idle at ${idleAt}ms — within the 8s window: ${idleAt < 8000 ? "YES" : "NO, but it did land"}`);
}

console.log("\n--- session.status / session.ended received ---");
for (const f of seen) {
  if (f.type === "session.status" || f.type === "session.ended") {
    console.log(`  ${String(f.seq ?? "").padStart(4)} ${f.type} ${JSON.stringify(f.data ?? {})}`);
  }
}
console.log("\n--- all event types in order ---");
console.log("  " + seen.map((f) => f.type).join(" → "));

await fetch(`${ST}/sessions/${encodeURIComponent(casfId)}`, { method: "DELETE" }).catch(() => {});
process.exit(0);
