import { createContext, useContext } from "solid-js";
import { probePaths, revealPath, type PathProbe } from "./api";
import { ServiceError } from "./errors";

/**
 * Local paths in rendered text, recognised and made clickable.
 *
 * Detection is deliberately narrow: a token has to announce itself as a path
 * (`~/`, `./`, `../`, a drive letter, a UNC `\\server`, or `/` under a known
 * filesystem root) or carry a file extension across a separator (`src/foo.ts`,
 * `src\foo.ts`). Bare `a/b` tokens without an extension stay text — `and/or`,
 * `feature/branch`, and `either/or` are not files — and neither are API
 * routes like `/docs/getting-started`.
 */

/** One path-shaped token inside a text node. */
export type PathMatch = { start: number; end: number; raw: string; dir: boolean };

/**
 * A path-shaped token that has not been confirmed as a real local path.
 *
 * The element is kept by reference: it stays valid when the node is moved
 * into the document, and it is how the confirmed ones are found again. `abs`
 * is the path it resolved to, once the session's workspace has anchored it —
 * and `null` when it is not a path on this machine at all.
 */
export type PathCandidate = { el: HTMLElement; raw: string; abs?: string | null };

/** Anything that cannot sit inside a path token — whitespace, markup, pairing brackets. */
const GAP = String.raw`[^\s<>"'\`|()\[\]{}]`;

const PATHISH = new RegExp(
  [
    // UNC paths — \\server\share — before the plain absolute arm eats the
    // single backslashes as ordinary characters
    String.raw`\\\\${GAP}*`,
    // ~ and absolute POSIX paths, and protocol-relative //host (dropped later)
    String.raw`~?\/${GAP}*`,
    // Drive-letter paths, both separators
    String.raw`[A-Za-z]:[\\/][^\s<>"'\`|()\[\]{}]*`,
    // ./ and ../ relatives
    String.raw`\.{1,2}\/${GAP}*`,
    // Bare relatives: starts on a word-ish character, contains a separator —
    // / on one platform, \ on the other.
    //
    // The lookbehind keeps the arm from starting mid-token. `GAP` includes
    // the separators, so the prefix would otherwise swallow a whole token
    // and then backtrack one character at a time looking for a separator it
    // never finds — quadratic over a long unbroken run (a base64 blob, a
    // minified bundle). A token without a separator matches nowhere, so
    // refusing to start inside one changes no match: the engine would have
    // matched earlier, at the start of the run.
    String.raw`(?<![\w@+.,%=\-])[\w@+.,%=\-]${GAP}*[\\/]${GAP}*`,
  ].join("|"),
  "g",
);

const TRAILING = /[*_.,;:!?]+$/;
const FILE_TAIL = /\.[A-Za-z0-9]{1,12}$/;

/**
 * Top-level directories an extension-less absolute path may start with and
 * still be a filesystem path. Without this, `/docs/getting-started` and
 * `/api/users` — API routes, not files — link the same way `/Users/x` does.
 * A route never carries a file extension, so `/api/v2.json` still qualifies.
 */
const POSIX_ROOTS = new Set([
  "Users",
  "home",
  "tmp",
  "var",
  "etc",
  "opt",
  "usr",
  "private",
  "Volumes",
  "mnt",
  "media",
  "root",
  "srv",
  "dev",
  "run",
  "boot",
  "data",
  "System",
  "Library",
  "Applications",
]);

export function findPaths(text: string): PathMatch[] {
  const out: PathMatch[] = [];
  for (const m of text.matchAll(PATHISH)) {
    let raw = m[0];
    let start = m.index;
    // Emphasis markers hugging a token are markdown, not path.
    const stripped = raw.replace(/^[_*]+/, "");
    start += raw.length - stripped.length;
    raw = stripped;
    // `//x` is a protocol-relative URL or a comment, and `/x` straight after a
    // scheme's colon is the tail of one. Neither is a filesystem path.
    if (raw.startsWith("//")) continue;
    if (raw.startsWith("/") && text[start - 1] === ":") continue;
    const dir = /[\\/]$/.test(raw);
    if (dir) raw = raw.slice(0, -1);
    raw = raw.replace(TRAILING, "");
    if (!isPath(raw)) continue;
    // A bare relative has to end like a file (or it already said it is a
    // directory) — `src/foo.ts` qualifies, `and/or` does not. A colon in the
    // first segment means the match swallowed `scheme://…` instead.
    const anchored = /^([~.]?\/|\\\\|[A-Za-z]:[\\/])/.test(raw);
    if (!anchored && (raw.split(/[/\\]/)[0]!.includes(":") || (!dir && !FILE_TAIL.test(raw)))) continue;
    // An absolute path without a file tail is a filesystem path only under a
    // known root — otherwise it reads exactly like an API route.
    if (raw.startsWith("/") && !raw.startsWith("~/")) {
      const segs = raw.split("/").filter(Boolean);
      if (!POSIX_ROOTS.has(segs[0]!) && !FILE_TAIL.test(segs.at(-1) ?? "")) continue;
    }
    out.push({ start, end: start + raw.length, raw, dir });
  }
  return out;
}

function isPath(raw: string): boolean {
  if (raw === "/" || raw === "~" || raw === "." || raw === ".." || raw === "\\\\") return false;
  if (/^~$|^~[^/]/.test(raw)) return false;
  return /[/\\]/.test(raw) || /^[A-Za-z]:$/.test(raw);
}

/** Where a rendered path lands for this session. */
export type ResolvedPath = {
  /** Inside the session workspace, as a relative path the file API accepts. */
  rel?: string;
  /** An absolute path the local file manager can be asked about. `~/` stays
   *  unexpanded — the service knows HOME, the UI does not. */
  abs?: string;
};

/** Collapse `.`/`..` and duplicate separators; keeps the leading `/`. */
function normSegs(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return (absolute ? "/" : "") + out.join("/");
}

function under(path: string, root: string): string | undefined {
  if (path === root) return "";
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

/** `under` for the drive world: compares lowercased, slices the real case. */
function underCi(path: string, root: string): string | undefined {
  if (path.toLowerCase() === root.toLowerCase()) return "";
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.toLowerCase().startsWith(prefix.toLowerCase())
    ? path.slice(prefix.length)
    : undefined;
}

export function resolveTarget(raw: string, workspace: string | undefined): ResolvedPath {
  const p = raw.trim();
  if (p === "~" || p.startsWith("~/")) return { abs: p };
  // A UNC path anchors on its server — there is no workspace to place it in.
  if (p.startsWith("\\\\")) return { abs: p };
  const ws = workspace?.replace(/\\/g, "/").replace(/\/+$/, "");
  const wsDrive = ws !== undefined && /^[A-Za-z]:\//.test(ws);
  // A drive-letter path is compared case-insensitively on its own separator
  // world; mixing `C:/x` against a POSIX workspace can never land inside it.
  if (/^[A-Za-z]:[\\/]/.test(p)) {
    const posix = normSegs(p.replace(/\\/g, "/"));
    const rel = wsDrive ? underCi(posix, ws) : undefined;
    // The revealable copy goes back to native separators for explorer.
    return rel === undefined ? { abs: p } : { rel, abs: posix.replace(/\//g, "\\") };
  }
  if (p.startsWith("/")) {
    const abs = normSegs(p);
    const rel = ws && !wsDrive ? under(abs, ws) : undefined;
    return rel === undefined ? { abs } : { rel, abs };
  }
  // Relative: only a session workspace can anchor it.
  if (!ws) return {};
  const joined = normSegs(`${ws}/${p.replace(/\\/g, "/")}`);
  const rel = wsDrive ? underCi(joined, ws) : ws.startsWith("/") ? under(joined, ws) : undefined;
  // `../x` walks out of the workspace — still a real local path, just not
  // one the file API will serve.
  if (rel === undefined) return { abs: wsDrive ? joined.replace(/\//g, "\\") : joined };
  return { rel, abs: wsDrive ? joined.replace(/\//g, "\\") : joined };
}

/**
 * Mark path-shaped text nodes under `host` as candidates.
 *
 * A candidate is not a link yet. It is a token that looks like a path and
 * waits for the service — which owns HOME and the list of folders this
 * reader may open — to say whether it is one. A path the model invented, or
 * one that has since been deleted, stays plain text: a link that cannot be
 * opened is worse than no link.
 *
 * Anchors are left alone — a markdown link's text belongs to its href.
 */
export function markPathCandidates(host: ParentNode): PathCandidate[] {
  const candidates: PathCandidate[] = [];
  const texts: Text[] = [];
  const walk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest("a,[data-path],[data-path-candidate]")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) texts.push(n as Text);
  for (const node of texts) {
    const found = findPaths(node.data);
    if (!found.length) continue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const f of found) {
      frag.append(document.createTextNode(node.data.slice(at, f.start)));
      const span = document.createElement("span");
      span.className = "path-candidate";
      span.dataset.pathCandidate = f.raw;
      span.textContent = f.raw;
      frag.append(span);
      candidates.push({ el: span, raw: f.raw });
      at = f.end;
    }
    frag.append(document.createTextNode(node.data.slice(at)));
    node.replaceWith(frag);
  }
  return candidates;
}

/** Turn a confirmed candidate into the button a reader can click. */
export function upgradePathCandidate(candidate: PathCandidate): void {
  const el = candidate.el;
  // The element is still in a tree — a candidate whose row was already
  // upgraded has no parent left. `isConnected` is not the test: the whole
  // transcript may not be in the document yet when the answer arrives, and
  // the button still belongs where the text is.
  if (!el.parentNode) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "path-link";
  button.dataset.path = candidate.raw;
  button.title = candidate.raw;
  button.textContent = candidate.raw;
  el.replaceWith(button);
}

/**
 * What the service said about a path, and when it said it.
 *
 * A path that exists stays a path — that verdict never expires. A path that
 * did not exist may exist tomorrow, so its verdict is only trusted for a
 * while: a file the reader just created becomes a link again without a
 * reload.
 */
type Verdict = { ok: boolean; expires: number };

/** How long a "this path is not there" answer is trusted. */
const MISSING_TTL_MS = 30_000;
/** How long an unreachable service is trusted to have answered. */
const UNREACHABLE_TTL_MS = 5_000;
/** How many paths one probe asks about. The service reads a batch, not a stream. */
const PROBE_BATCH = 256;

const verdicts = new Map<string, Verdict>();

function verdictOf(abs: string): boolean | undefined {
  const v = verdicts.get(abs);
  if (!v) return undefined;
  if (v.expires !== Infinity && v.expires <= Date.now()) {
    verdicts.delete(abs);
    return undefined;
  }
  return v.ok;
}

/**
 * One provider's undecided candidates.
 *
 * A candidate stays here until it is either a link or plain text for good.
 * The list is the one place that holds a path token strongly, so the rows
 * that scrolled away are dropped from it on every pass.
 */
type Pending = {
  candidates: PathCandidate[];
  /** Whether a pass is already queued for this tick. */
  scheduled: boolean;
};

const pendings = new WeakMap<PathApi, Pending>();

/**
 * Is the element on the reader's screen?
 *
 * The window is the frame of reference, and so is the scroller the element
 * sits in: a row the reader has scrolled past is clipped by the transcript,
 * and a path in it is not in front of them even though the window still
 * covers the place where it would be.
 *
 * The scroller's rectangle is read once per pass — the reads that follow it
 * are cached, because nothing is written between them.
 */
type Bounds = { top: number; bottom: number; left: number; right: number };

function onScreen(el: HTMLElement, scrollers: Map<Element, Bounds>): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  if (r.bottom <= 0 || r.top >= window.innerHeight) return false;
  if (r.right <= 0 || r.left >= window.innerWidth) return false;
  const scroller = el.closest("[data-transcript-scroller]");
  if (!scroller) return true;
  let s = scrollers.get(scroller);
  if (!s) {
    const box = scroller.getBoundingClientRect();
    s = { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
    scrollers.set(scroller, s);
  }
  return r.bottom > s.top && r.top < s.bottom;
}

/**
 * Ask the service about a batch of candidates.
 *
 * The candidates are collected first and asked about in one call: a
 * transcript can mount a dozen blocks in one frame, and a dozen calls would
 * be a dozen round-trips for one answer.
 */
export function queueConfirm(api: PathApi, candidates: readonly PathCandidate[]): void {
  if (!candidates.length) return;
  let p = pendings.get(api);
  if (!p) {
    p = { candidates: [], scheduled: false };
    pendings.set(api, p);
    // The gate opens when the reader stops scrolling, and that is the moment
    // the paths on the page are worth looking at. Registered once: every
    // gesture that ends sends us back through here.
    api.onReady?.(() => void flushPending(api, p!));
  }
  p.candidates.push(...candidates);
  if (p.scheduled) return;
  p.scheduled = true;
  // A microtask, not a frame: the nodes are in the tree by the time it runs,
  // and a candidate that is nowhere near the document cannot be upgraded.
  queueMicrotask(() => {
    p!.scheduled = false;
    void flushPending(api, p!);
  });
}

async function flushPending(api: PathApi, p: Pending): Promise<void> {
  // The rows that scrolled away are released before anything else: this list
  // is what holds them.
  p.candidates = p.candidates.filter((c) => c.el.parentNode !== null);
  if (api.blocked?.()) {
    // The reader is scrolling. The gesture has to end before anything is
    // asked or done: a row that mounts mid-scroll is not a question worth a
    // round-trip, and the answer would land while the row is off screen.
    return;
  }
  if (!p.candidates.length) return;
  const ws = api.workspace?.();
  // Only the paths on the reader's screen are worth asking about. A long
  // session holds thousands of path-shaped tokens, and the service has no
  // business answering questions about a page the reader is not looking at —
  // and no budget to answer them while it is busy with something else.
  const scrollers = new Map<Element, Bounds>();
  const shown: PathCandidate[] = [];
  for (const c of p.candidates) {
    if (c.abs === undefined) {
      const abs = resolveTarget(c.raw, ws).abs;
      // A path that is not on this machine at all never becomes a link.
      c.abs = abs ?? null;
    }
    if (c.abs === null) continue;
    if (!onScreen(c.el, scrollers)) continue;
    shown.push(c);
  }
  if (!shown.length) return;
  const paths = [...new Set(shown.map((c) => c.abs!))];
  const confirmed = await confirmPaths(paths, probePaths);
  // A path the reader is looking at becomes a link; the ones off screen stay
  // text until they are looked at, and by then the verdict is in the cache.
  for (const c of shown) {
    if (confirmed.has(c.abs!)) upgradePathCandidate(c);
  }
}

/**
 * Which of these paths the service confirms.
 *
 * The answer is remembered: a path that exists stays a path — that verdict
 * never expires — and a path that does not is only believed for a while, so
 * a file the reader just created becomes a link again without a reload.
 *
 * The probe is asked once for the whole batch. A paragraph of prose holds
 * dozens of path-shaped tokens, and a dozen round-trips for one answer is a
 * dozen round-trips too many.
 */
export async function confirmPaths(
  paths: readonly string[],
  probe: (paths: string[]) => Promise<PathProbe[]>,
): Promise<Set<string>> {
  const unknown = paths.filter((p) => verdictOf(p) === undefined);
  for (let i = 0; i < unknown.length; i += PROBE_BATCH) {
    await probeBatch(unknown.slice(i, i + PROBE_BATCH), probe);
  }
  const confirmed = new Set<string>();
  for (const p of paths) if (verdictOf(p) === true) confirmed.add(p);
  return confirmed;
}

async function probeBatch(
  paths: string[],
  probe: (paths: string[]) => Promise<PathProbe[]>,
): Promise<void> {
  if (!paths.length) return;
  const now = Date.now();
  try {
    const answers = await probe(paths);
    for (const a of answers) {
      verdicts.set(a.path, { ok: a.ok, expires: a.ok ? Infinity : now + MISSING_TTL_MS });
    }
    // A path the service did not answer for is not a path we can open.
    for (const abs of paths) {
      if (!verdicts.has(abs)) verdicts.set(abs, { ok: false, expires: now + MISSING_TTL_MS });
    }
  } catch {
    // The service could not be reached: nothing is confirmed, so nothing
    // becomes a link. The verdict is short-lived — the service may be back
    // in a moment, and a path that is real should not stay text for long.
    const until = now + UNREACHABLE_TTL_MS;
    for (const abs of paths) verdicts.set(abs, { ok: false, expires: until });
  }
}

/** What the transcript and the file preview offer around a recognised path. */
export type PathApi = {
  /** Left click: open in the right rail when it lands in the workspace, else
   *  hand it to the file manager. Failures go to the provider's error slot.
   *  The anchor is where the click happened — the failure is shown there. */
  open: (raw: string, anchor?: HTMLElement) => void;
  /** Whether "open the enclosing folder" can run — no absolute, no menu item. */
  revealable: (raw: string) => boolean;
  /** The context menu's file-manager action. */
  reveal: (raw: string) => void;
  /** The workspace a relative path is anchored to. */
  workspace?: () => string | undefined;
  /**
   * True while path work should wait. The transcript says yes while the
   * reader is scrolling: a row that mounts mid-gesture must not ask the
   * service anything.
   */
  blocked?: () => boolean;
  /** Ask to be called again once the gate opens. The provider owns the gate,
   *  so it owns the moment it opens. */
  onReady?: (fn: () => void) => void;
};

/** Present where rendered text may offer path actions; absent everywhere else. */
export const PathActions = createContext<PathApi>();

export function pathActions(): PathApi | undefined {
  return useContext(PathActions);
}

/** Shared resolve-then-reveal so each provider only owns its error surface. */
export function revealResolved(raw: string, workspace: string | undefined): Promise<void> {
  const abs = resolveTarget(raw, workspace).abs;
  return abs === undefined
    ? Promise.reject(new ServiceError("path is not local", "not-local"))
    : revealPath(abs);
}
