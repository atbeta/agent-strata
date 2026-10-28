// Deterministic synthetic event store for the transcript benchmark.
//
// One mulberry32 stream, seeded once, drives every choice below, and event
// ids are positional rather than random ULIDs — so a given FIXTURE_VERSION
// produces byte-identical content on every machine and every run. Bump the
// version when the generator changes; the cached database is rebuilt then.
//
// The shape mimics what the opencode adapter writes: one workspace, one
// session each of "many turns" and "huge turns", and four small sessions to
// fill the sidebar. Sessions are left idle, not busy, the way a finished
// conversation sits in the store.

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../../../../packages/store/src/index";
import type { ContentBlock, EventInput } from "../../../../packages/schema/src/index";

export const FIXTURE_VERSION = 2;

export const FIXTURE_SESSIONS = {
  long: "opencode:ses_benchlong",
  heavy: "opencode:ses_benchheavy",
  small: [
    "opencode:ses_benchsmall1",
    "opencode:ses_benchsmall2",
    "opencode:ses_benchsmall3",
    "opencode:ses_benchsmall4",
  ],
} as const;

export interface FixtureSessionInfo {
  id: string;
  turns: number;
  /** Sum of the stored event bodies for this session, in bytes. */
  bytes: number;
}

export interface FixtureInfo {
  dbPath: string;
  sessions: FixtureSessionInfo[];
  /** Sum of every stored event body, in bytes. */
  bytes: number;
}

const WORKSPACE = "/bench/workspace";
const BACKEND = "opencode";
const MODEL = "bench/synth-1";
const BASE_TS = Date.parse("2025-06-01T08:00:00.000Z");

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rand = mulberry32(1);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
const chance = (p: number): boolean => rand() < p;

const WORDS = [
  "agent", "compile", "render", "scroll", "transcript", "session", "store", "event",
  "buffer", "window", "parser", "stream", "socket", "query", "index", "cache",
  "layout", "virtual", "measure", "viewport", "anchor", "frame", "pipeline",
  "backend", "adapter", "mapper", "projector", "schema", "driver", "worker",
  "diff", "patch", "commit", "branch", "merge", "review", "assert", "verify",
  "latency", "throughput", "profile", "metric", "sample", "budget", "threshold",
  "row", "column", "panel", "sidebar", "overlay", "token", "policy", "request",
];

const IDENTIFIERS = [
  "scrollTop", "rowHeight", "turnIndex", "viewOffset", "lastSeq", "eventBus",
  "renderPass", "measureRow", "projectView", "syncStore", "flushQueue",
  "readTail", "mapEvents", "attachSink", "resolveTurn", "emitFrame",
];

const PATHS = [
  "src/session-detail.tsx", "src/virtual-tail.ts", "src/transcript-layout.ts",
  "packages/store/src/index.ts", "packages/projector/src/index.ts",
  "packages/service/src/index.ts", "packages/schema/src/index.ts",
  "apps/desktop/ui/src/api.ts", "src/prompt-navigator.tsx", "src/chrome.tsx",
];

const SENTENCE_OPENERS = [
  "The benchmark needs", "We should", "Can you", "Please", "I noticed",
  "It looks like", "When you get a chance,", "For the next pass,",
];

function words(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(pick(WORDS));
  return out.join(" ");
}

function sentence(): string {
  const n = int(6, 14);
  const s = `${words(1)} ${words(n - 1)}`;
  return `${s[0]!.toUpperCase()}${s.slice(1)}.`;
}

function paragraph(sentences = int(2, 4)): string {
  const out: string[] = [];
  for (let i = 0; i < sentences; i++) {
    let s = sentence();
    // Sprinkle inline code through the prose the way real replies carry it.
    if (chance(0.35)) {
      const at = int(0, s.length - 2);
      s = `${s.slice(0, at)} \`${pick(IDENTIFIERS)}\` ${s.slice(at)}`;
    }
    out.push(s);
  }
  return out.join(" ");
}

function prose(min: number, max: number): string {
  const target = int(min, max);
  let body = "";
  while (body.length < target) {
    body += body ? " " : "";
    body += sentence();
  }
  return body;
}

function userText(): string {
  const target = int(80, 400);
  let body = pick(SENTENCE_OPENERS);
  while (body.length < target) body += ` ${sentence()}`;
  return body;
}

function codeLine(lang: "ts" | "py" | "bash"): string {
  const id = pick(IDENTIFIERS);
  const n = int(0, 999);
  if (lang === "bash") {
    return pick([
      `echo "[${n}] ${words(3)}"`,
      `grep -n "${pick(WORDS)}" ${pick(PATHS)} | head -${int(3, 40)}`,
      `bun run ${pick(WORDS)} --flag ${n}`,
      `find . -name "*.${pick(["ts", "tsx", "json"])}" | wc -l`,
      `git log --oneline -${int(2, 20)}`,
    ]);
  }
  if (lang === "py") {
    return pick([
      `def ${id.toLowerCase()}_${n}(rows):`,
      `    return [r for r in rows if r.${pick(WORDS)} > ${n}]`,
      `total = sum(x.${pick(WORDS)} for x in batch)`,
      `print(f"${words(4)}: {elapsed:.2f}ms")`,
      `    ${id.toLowerCase()} = load_${pick(WORDS)}("${pick(PATHS)}")`,
      `assert len(turns) == ${n}, f"expected ${n} turns"`,
    ]);
  }
  return pick([
    `const ${id}${n} = ${pick(WORDS)}.${pick(WORDS)}(${int(1, 500)});`,
    `export function ${id}${n}(el: HTMLElement): number {`,
    `  return Math.max(0, el.${id} - ${int(0, 800)});`,
    `if (seq.${pick(WORDS)} !== undefined) out.push(${id});`,
    `const ${pick(WORDS)} = rows.map((r) => r.${pick(WORDS)}).filter(Boolean);`,
    `  ${id} = await ${pick(WORDS)}(${pick(WORDS)}Id, { limit: ${int(1, 200)} });`,
    `set${id[0]!.toUpperCase()}${id.slice(1)}((n) => n + ${int(1, 9)});`,
    `interface ${id[0]!.toUpperCase()}${id.slice(1)}${n} { seq: number; ts: string }`,
    `for (const t of ${pick(WORDS)}s) render(t.${pick(WORDS)});`,
  ]);
}

function codeBlock(lang: "ts" | "py" | "bash", lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) out.push(codeLine(lang));
  return `\`\`\`${lang}\n${out.join("\n")}\n\`\`\``;
}

function bulletList(): string {
  const n = int(3, 6);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`- ${sentence().slice(0, -1)} — ${words(int(3, 8))}`);
  return out.join("\n");
}

function gfmTable(): string {
  const head = "| Step | Tool | Latency (ms) | Bytes |";
  const sep = "| --- | --- | ---: | ---: |";
  const rows: string[] = [];
  for (let i = 0; i < 10; i++) {
    rows.push(`| ${words(2)} | ${pick(["bash", "read", "edit", "grep", "write"])} | ${int(4, 2500)} | ${int(64, 120000)} |`);
  }
  return [head, sep, ...rows].join("\n");
}

/** Pad to at least `min`, then cut at a paragraph/line boundary under `max`. */
function fitText(body: string, min: number, max: number): string {
  while (body.length < min) body += `\n\n${paragraph()}`;
  if (body.length <= max) return body;
  const para = body.lastIndexOf("\n\n", max);
  if (para >= min) return body.slice(0, para);
  const line = body.lastIndexOf("\n", max);
  return body.slice(0, line >= min ? line : max);
}

/** Assistant markdown for the long and small sessions: 600–3,000 chars. */
function assistantMarkdown(): string {
  const blocks: string[] = [paragraph(int(2, 4))];
  if (chance(0.4)) blocks.push(bulletList());
  if (chance(0.35)) blocks.push(codeBlock(pick(["ts", "py", "bash"] as const), int(10, 40)));
  blocks.push(paragraph(int(1, 2)));
  return fitText(blocks.join("\n\n"), 600, 3000);
}

/** Assistant markdown for the heavy session: 8–20KB, 3–6 code blocks, one table. */
function heavyMarkdown(): string {
  const target = int(8_000, 20_000);
  let body = `${paragraph(int(3, 5))}\n\n${gfmTable()}\n\n${paragraph(int(1, 3))}`;
  const nblocks = int(3, 6);
  for (let b = 0; b < nblocks; b++) {
    const rest = nblocks - b - 1;
    // Reserve roughly a minimum block for the ones still to come so the last
    // block is not starved into breaking its 40-line floor.
    const budget = (target - body.length - rest * 40 * 55) / 55;
    const lines = Math.max(40, Math.min(150, Math.floor(budget)));
    body += `\n\n${paragraph(int(1, 2))}\n\n${codeBlock(pick(["ts", "py", "bash"] as const), lines)}`;
  }
  return fitText(body, 8_000, 20_000);
}

function logLines(bytes: number): string {
  const out: string[] = [];
  let size = 0;
  while (size < bytes) {
    const line = pick([
      `${new Date(BASE_TS + int(0, 3_600_000)).toISOString()} INFO  ${words(4)} (${int(1, 900)}ms)`,
      `[${int(1000, 9999)}] ${pick(IDENTIFIERS)}: ${words(int(2, 6))} -> ${int(0, 4096)}`,
      `WARN  ${words(6)}`,
      `${pick(IDENTIFIERS)}(${int(0, 60)}) returned ${int(0, 65536)} bytes`,
      `  at ${pick(IDENTIFIERS)} (${pick(PATHS)}:${int(1, 2000)}:${int(1, 80)})`,
    ]);
    out.push(line);
    size += line.length + 1;
  }
  return out.join("\n");
}

function grepLines(bytes: number): string {
  const out: string[] = [];
  let size = 0;
  while (size < bytes) {
    const line = `${pick(PATHS)}:${int(1, 2000)}: ${words(int(3, 9))} \`${pick(IDENTIFIERS)}\``;
    out.push(line);
    size += line.length + 1;
  }
  return out.join("\n");
}

function readLines(bytes: number): string {
  const out: string[] = [];
  let size = 0;
  let ln = int(1, 400);
  while (size < bytes) {
    const line = `${String(ln++).padStart(5)} | ${codeLine("ts")}`;
    out.push(line);
    size += line.length + 1;
  }
  return out.join("\n");
}

function diffLines(bytes: number): string {
  const path = pick(PATHS);
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let size = out[0]!.length + out[1]!.length + 2;
  while (size < bytes) {
    out.push(`@@ -${int(1, 800)},${int(3, 20)} +${int(1, 800)},${int(3, 20)} @@`);
    for (let i = 0, n = int(4, 12); i < n && size < bytes; i++) {
      const sign = pick(["+", "-", " "]);
      const line = `${sign}${codeLine("ts")}`;
      out.push(line);
      size += line.length + 1;
    }
  }
  return out.join("\n");
}

function toolOutput(tool: string, bytes: number): string {
  switch (tool) {
    case "bash":
      return `$ ${pick(["bun test", "bun run build", "git status", "rg --files"])}\n${logLines(bytes)}`;
    case "read":
      return readLines(bytes);
    case "edit":
      return diffLines(bytes);
    case "grep":
      return grepLines(bytes);
    default:
      return `wrote ${pick(PATHS)}\n${logLines(Math.max(0, bytes - 40))}`;
  }
}

function toolInput(tool: string): Record<string, unknown> {
  const path = pick(PATHS);
  switch (tool) {
    case "bash":
      return { command: `${pick(["bun test", "rg", "git diff", "wc -l"])} ${path}`, timeout: 120000 };
    case "read":
      return { filePath: path, offset: int(0, 300), limit: int(40, 400) };
    case "edit":
      return { filePath: path, oldString: words(int(2, 5)), newString: words(int(2, 5)) };
    case "grep":
      return { pattern: pick(IDENTIFIERS), path: dirname(path), include: "*.{ts,tsx}" };
    default:
      return { filePath: path, content: words(int(4, 10)) };
  }
}

/** Tool-call count for an ordinary turn: 0:30% 1:25% 2:20% 3:12% 4:8% 5:5%. */
function toolCount(): number {
  const r = rand();
  if (r < 0.3) return 0;
  if (r < 0.55) return 1;
  if (r < 0.75) return 2;
  if (r < 0.87) return 3;
  if (r < 0.95) return 4;
  return 5;
}

interface SessionSpec {
  id: string;
  nativeId: string;
  tag: string;
  title: string;
  turns: number;
  heavy?: boolean;
}

function sessionEvents(spec: SessionSpec, startSeq: number): EventInput[] {
  const events: EventInput[] = [];
  let clock = BASE_TS + startSeq * 1_000;
  let seq = startSeq;
  const ev = (type: EventInput["type"], data: unknown): void => {
    clock += int(120, 900);
    events.push({
      id: `${spec.tag}-e${seq++}`,
      session_id: spec.id,
      ts: new Date(clock).toISOString(),
      source: { backend: BACKEND, native_id: spec.nativeId },
      type,
      data,
    } as EventInput);
  };

  ev("session.started", { workspace: WORKSPACE, title: spec.title, model: MODEL });
  ev("session.updated", { title: spec.title });
  ev("session.status", { state: "busy" });

  for (let i = 0; i < spec.turns; i++) {
    const turnId = `${spec.tag}-t${i}`;
    const msgId = `${spec.tag}-m${i}`;
    ev("turn.user", {
      turn_id: turnId,
      content: [{ type: "text", text: userText() }] satisfies ContentBlock[],
    });
    const nTools = spec.heavy ? int(8, 20) : toolCount();
    for (let k = 0; k < nTools; k++) {
      const callId = `${turnId}-c${k}`;
      const tool = pick(["bash", "read", "edit", "grep", "write"] as const);
      ev("tool.call", {
        turn_id: turnId,
        call_id: callId,
        tool,
        input: toolInput(tool),
        order: k,
        msg_id: msgId,
      });
      ev("tool.result", {
        call_id: callId,
        status: "ok",
        output: toolOutput(tool, spec.heavy ? int(2_000, 10_500) : int(200, 6_000)),
        latency_ms: int(4, 2_500),
      });
    }
    const content: ContentBlock[] = [];
    if (!spec.heavy && chance(0.2)) {
      content.push({ type: "thinking", text: prose(300, 1_500) });
    }
    content.push({ type: "text", text: spec.heavy ? heavyMarkdown() : assistantMarkdown() });
    ev("turn.assistant", {
      turn_id: turnId,
      msg_id: msgId,
      content,
      model: MODEL,
      usage: {
        input: int(400, 4_000),
        output: int(200, 3_000),
        ...(chance(0.2) ? { reasoning: int(50, 800) } : {}),
      },
      cost_usd: Math.round(rand() * 90) / 10_000,
      latency_ms: int(800, 9_000),
      stop_reason: "end_turn",
    });
  }

  ev("session.status", { state: "idle" });
  return events;
}

const SPECS: SessionSpec[] = [
  { id: FIXTURE_SESSIONS.long, nativeId: "ses_benchlong", tag: "long", title: "Bench: 1600-turn transcript", turns: 1_600 },
  { id: FIXTURE_SESSIONS.heavy, nativeId: "ses_benchheavy", tag: "heavy", title: "Bench: heavy transcript", turns: 38, heavy: true },
  ...FIXTURE_SESSIONS.small.map((id, i) => ({
    id,
    nativeId: `ses_benchsmall${i + 1}`,
    tag: `small-${i + 1}`,
    title: `Bench: small session ${i + 1}`,
    turns: 20,
  })),
];

const here = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(here, ".cache");
const CACHE_DB = join(CACHE_DIR, `fixtures-v${FIXTURE_VERSION}.db`);

function inspect(path: string): FixtureInfo {
  const store = openStore(path);
  try {
    const counts = new Map(store.classCounts().map((c) => [c.session_id, c]));
    const sessions: FixtureSessionInfo[] = SPECS.map((spec) => {
      const c = counts.get(spec.id);
      const turns = store.query({ session_id: spec.id, types: ["turn.user"], limit: 10_000 }).length;
      return { id: spec.id, turns, bytes: (c?.rebuildable_bytes ?? 0) + (c?.local_bytes ?? 0) };
    });
    return { dbPath: path, sessions, bytes: sessions.reduce((s, x) => s + x.bytes, 0) };
  } finally {
    store.close();
  }
}

function buildCache(): void {
  // Reseed per build: the content is a function of FIXTURE_VERSION alone.
  rand = mulberry32(1);
  mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = join(CACHE_DIR, `.build-${process.pid}.db`);
  rmSync(tmp, { force: true });
  rmSync(`${tmp}-wal`, { force: true });
  rmSync(`${tmp}-shm`, { force: true });
  const store = openStore(tmp);
  let seq = 0;
  try {
    for (const spec of SPECS) {
      const events = sessionEvents(spec, seq);
      seq += events.length;
      store.append(events);
    }
    // Fold the WAL into the main file so the cache is a single complete file.
    store.optimize();
    store.backupTo(CACHE_DB);
  } finally {
    store.close();
    rmSync(tmp, { force: true });
    rmSync(`${tmp}-wal`, { force: true });
    rmSync(`${tmp}-shm`, { force: true });
  }
}

/**
 * Make `path` a copy of the cached fixture database, building the cache on
 * first use, and report what is inside.
 */
export function buildFixtureDb(path: string): FixtureInfo {
  if (!existsSync(CACHE_DB)) buildCache();
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(CACHE_DB, path);
  return inspect(path);
}
