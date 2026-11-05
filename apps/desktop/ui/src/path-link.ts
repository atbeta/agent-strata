import { createContext, useContext } from "solid-js";
import { revealPath } from "./api";

/**
 * Local paths in rendered text, recognised and made clickable.
 *
 * Detection is deliberately narrow: a token has to announce itself as a path
 * (`/`, `~/`, `./`, `../`, a drive letter) or carry a file extension across a
 * slash (`src/foo.ts`). Bare `a/b` tokens without an extension stay text —
 * `and/or`, `feature/branch`, and `either/or` are not files.
 */

/** One path-shaped token inside a text node. */
export type PathMatch = { start: number; end: number; raw: string; dir: boolean };

/** Anything that cannot sit inside a path token — whitespace, markup, pairing brackets. */
const GAP = String.raw`[^\s<>"'\`|()\[\]{}]`;

const PATHISH = new RegExp(
  [
    // ~ and absolute POSIX paths, and protocol-relative //host (dropped later)
    String.raw`~?\/${GAP}*`,
    // Drive-letter paths, both separators
    String.raw`[A-Za-z]:[\\/][^\s<>"'\`|()\[\]{}]*`,
    // ./ and ../ relatives
    String.raw`\.{1,2}\/${GAP}*`,
    // Bare relatives: starts on a word-ish character, contains a slash
    String.raw`[\w@+.,%=\-]${GAP}*\/${GAP}*`,
  ].join("|"),
  "g",
);

const TRAILING = /[*_.,;:!?]+$/;
const FILE_TAIL = /\.[A-Za-z0-9]{1,12}$/;

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
    const dir = raw.endsWith("/");
    if (dir) raw = raw.slice(0, -1);
    raw = raw.replace(TRAILING, "");
    if (!isPath(raw)) continue;
    // A bare relative has to end like a file (or it already said it is a
    // directory) — `src/foo.ts` qualifies, `and/or` does not. A colon in the
    // first segment means the match swallowed `scheme://…` instead.
    const anchored = /^([~.]?\/|[A-Za-z]:[\\/])/.test(raw);
    if (!anchored && (raw.split("/")[0]!.includes(":") || (!dir && !FILE_TAIL.test(raw)))) continue;
    out.push({ start, end: start + raw.length, raw, dir });
  }
  return out;
}

function isPath(raw: string): boolean {
  if (raw === "/" || raw === "~" || raw === "." || raw === "..") return false;
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

export function resolveTarget(raw: string, workspace: string | undefined): ResolvedPath {
  const p = raw.trim();
  if (p === "~" || p.startsWith("~/")) return { abs: p };
  const ws = workspace?.replace(/\\/g, "/").replace(/\/+$/, "");
  // A drive-letter path is compared case-insensitively on its own separator
  // world; mixing `C:/x` against a POSIX workspace can never land inside it.
  if (/^[A-Za-z]:[\\/]/.test(p)) {
    const posix = normSegs(p.replace(/\\/g, "/"));
    // Case-insensitive containment, but the rel slice keeps its real case.
    const rel =
      ws && /^[A-Za-z]:\//.test(ws) && posix.toLowerCase().startsWith(`${ws.toLowerCase()}/`)
        ? posix.slice(ws.length + 1)
        : posix.toLowerCase() === ws?.toLowerCase()
          ? ""
          : undefined;
    return rel === undefined ? { abs: p } : { rel, abs: posix };
  }
  if (p.startsWith("/")) {
    const abs = normSegs(p);
    const rel = ws && ws.startsWith("/") ? under(abs, ws) : undefined;
    return rel === undefined ? { abs } : { rel, abs };
  }
  // Relative: only a session workspace can anchor it.
  if (!ws || !ws.startsWith("/")) return {};
  const joined = normSegs(`${ws}/${p}`);
  const rel = under(joined, ws);
  // `../x` walks out of the workspace — still a real local path, just not
  // one the file API will serve.
  return rel === undefined ? { abs: joined } : { rel, abs: joined };
}

/**
 * Wrap path-shaped text nodes under `host` in buttons carrying the raw path.
 * Anchors are left alone — a markdown link's text belongs to its href.
 */
export function linkifyPaths(host: ParentNode) {
  const texts: Text[] = [];
  const walk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest("a,[data-path]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) texts.push(n as Text);
  for (const node of texts) {
    const found = findPaths(node.data);
    if (!found.length) continue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const f of found) {
      frag.append(document.createTextNode(node.data.slice(at, f.start)));
      const b = document.createElement("button");
      b.type = "button";
      b.className = "path-link";
      b.dataset.path = f.raw;
      b.title = f.raw;
      b.textContent = f.raw;
      frag.append(b);
      at = f.end;
    }
    frag.append(document.createTextNode(node.data.slice(at)));
    node.replaceWith(frag);
  }
}

/** What the transcript and the file preview offer around a recognised path. */
export type PathApi = {
  /** Left click: open in the right rail when it lands in the workspace, else
   *  hand it to the file manager. Failures go to the provider's error slot. */
  open: (raw: string) => void;
  /** Whether "open the enclosing folder" can run — no absolute, no menu item. */
  revealable: (raw: string) => boolean;
  /** The context menu's file-manager action. */
  reveal: (raw: string) => void;
};

/** Present where rendered text may offer path actions; absent everywhere else. */
export const PathActions = createContext<PathApi>();

export function pathActions(): PathApi | undefined {
  return useContext(PathActions);
}

/** Shared resolve-then-reveal so each provider only owns its error surface. */
export function revealResolved(raw: string, workspace: string | undefined): Promise<void> {
  const abs = resolveTarget(raw, workspace).abs;
  return abs === undefined ? Promise.reject(new Error("path is not local")) : revealPath(abs);
}
