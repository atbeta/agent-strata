import { apiFetch, type SessionRow } from "./api";
import { isGeneratedTitle } from "./pane-session-picker";
import { readDraft, readQueuedText } from "./prompt-memory";
import { readPins } from "./pins";

/**
 * Sessions this window created and has not heard a word from since.
 *
 * "+" creates the session at once — the composer, the panes and everything
 * else need a real id — but a click nobody followed with input leaves that
 * id behind. The mark lives in storage rather than memory so a window closed
 * on an untouched session still gets to reap it on the next launch.
 */
export const FRESH_SESSIONS_KEY = "strata.fresh.v1";

export interface FreshMark {
  /** the directory the session was created in */
  dir?: string;
  /** the repository the session's worktree was cut from; set only for those */
  worktreeOf?: string;
  /** prune attempts that did not land; a watch that keeps missing gives up */
  tries?: number;
}

type FreshMap = Record<string, FreshMark>;

type FreshStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;

function parseMarks(raw: unknown): FreshMap {
  if (!raw || typeof raw !== "object") return {};
  const out: FreshMap = {};
  for (const [id, mark] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || !mark || typeof mark !== "object") continue;
    const m = mark as Record<string, unknown>;
    out[id] = {
      dir: typeof m.dir === "string" ? m.dir : undefined,
      worktreeOf: typeof m.worktreeOf === "string" ? m.worktreeOf : undefined,
      tries: typeof m.tries === "number" ? m.tries : undefined,
    };
  }
  return out;
}

export function readFresh(storage: FreshStorage): FreshMap {
  try {
    return parseMarks(JSON.parse(storage?.getItem(FRESH_SESSIONS_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

function writeFresh(map: FreshMap, storage: FreshStorage): void {
  try {
    if (Object.keys(map).length) storage?.setItem(FRESH_SESSIONS_KEY, JSON.stringify(map));
    else storage?.removeItem(FRESH_SESSIONS_KEY);
  } catch {
    // Private mode: marks are simply not kept.
  }
}

export function markFresh(id: string, mark: FreshMark, storage: FreshStorage): void {
  const map = readFresh(storage);
  map[id] = mark;
  writeFresh(map, storage);
}

export function unmarkFresh(id: string, storage: FreshStorage): void {
  const map = readFresh(storage);
  if (!(id in map)) return;
  delete map[id];
  writeFresh(map, storage);
}

export type FreshVerdict = "keep" | "wait" | "free";

/**
 * What keeps a fresh session alive.
 *
 * "keep" — the reader touched it deliberately (a pin, a title they typed, an
 *   archive): it is theirs now and the watch ends.
 * "wait" — input typed but not sent, a run in flight, or the session still on
 *   screen somewhere: nothing to delete yet, look again on the next leave.
 * "free" — nothing holds it: delete.
 */
export function freshVerdict(input: {
  pinned: boolean;
  titled: boolean;
  archived?: boolean;
  busy?: boolean;
  draft: string;
  queued: number;
  onScreen: boolean;
}): FreshVerdict {
  if (input.pinned || input.titled || input.archived === true) return "keep";
  if (input.onScreen || input.busy === true || input.draft.trim() || input.queued > 0) return "wait";
  return "free";
}

export type PruneOutcome = "kept" | "waiting" | "deleted";

/** A watch that failed this many prunes is assumed to point at a ghost. */
const FRESH_TRIES_MAX = 5;

export function createFreshSessions(deps: {
  /** the session list's rows */
  rows: () => SessionRow[];
  /** the session is on the route, in a visible pane, or in the compare pick */
  onScreen: (id: string) => boolean;
  /** archived rows sit outside `rows`; one the reader shelved is theirs */
  archived?: (id: string) => boolean;
  /** remove a worktree checkout; a non-"ok" answer just leaves it for the sidebar */
  removeWorktree?: (dir: string) => Promise<unknown>;
  /** where the bare "+" aims next; repaired once its worktree is gone */
  lastDir?: () => string | null | undefined;
  rememberDir?: (dir: string) => void;
  fetcher?: (path: string, init?: RequestInit) => Promise<Response>;
  storage?: FreshStorage;
  draft?: (id: string) => string;
  queued?: (id: string) => string[];
  pins?: () => string[];
}) {
  const storage =
    deps.storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  const fetcher = deps.fetcher ?? apiFetch;
  const draft = deps.draft ?? readDraft;
  const queued = deps.queued ?? readQueuedText;
  const pins = deps.pins ?? (() => readPins());

  const mark = (id: string, fresh: FreshMark = {}): void => markFresh(id, fresh, storage);
  const unmark = (id: string): void => unmarkFresh(id, storage);
  const ids = (): string[] => Object.keys(readFresh(storage));

  const miss = (id: string, mark: FreshMark): void => {
    const tries = (mark.tries ?? 0) + 1;
    if (tries >= FRESH_TRIES_MAX) unmark(id);
    else {
      const map = readFresh(storage);
      if (map[id]) {
        map[id] = { ...mark, tries };
        writeFresh(map, storage);
      }
    }
  };

  const pruneOnce = async (id: string): Promise<PruneOutcome> => {
    const marks = readFresh(storage);
    const note = marks[id];
    if (!note) return "kept";
    const row = deps.rows().find((r) => r.summary.session_id === id);
    // The row may simply not have been refetched yet, so its absence is not
    // proof the session is gone — the conditional delete decides either way.
    const title = row?.title ?? row?.summary.title;
    const verdict = freshVerdict({
      pinned: pins().includes(id),
      titled: Boolean(title?.trim() && !isGeneratedTitle(title)),
      archived: deps.archived?.(id) ?? false,
      busy: row?.busy,
      draft: draft(id),
      queued: queued(id).length,
      onScreen: deps.onScreen(id),
    });
    if (verdict === "keep") return "kept";
    if (verdict === "wait") return "waiting";
    let res: Response;
    try {
      res = await fetcher(`/sessions/${encodeURIComponent(id)}?if_empty=1`, { method: "DELETE" });
    } catch {
      miss(id, note);
      return "waiting";
    }
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { not_empty?: boolean };
      // A prompt landed between the click and the request: real session now.
      if (body.not_empty) return "kept";
      miss(id, note);
      return "waiting";
    }
    if (!res.ok) {
      miss(id, note);
      return "waiting";
    }
    return "deleted";
  };

  // Leaving a session fires from both the route effect and the pane effect;
  // a prune already in flight is the answer for whoever asks next.
  const inflight = new Map<string, Promise<PruneOutcome>>();
  const prune = (id: string): Promise<PruneOutcome> => {
    const running = inflight.get(id);
    if (running) return running;
    const p = pruneOnce(id)
      .then(async (outcome) => {
        if (outcome === "waiting") return outcome;
        const note = readFresh(storage)[id];
        unmark(id);
        if (outcome === "deleted" && note?.worktreeOf && note.dir) {
          // The checkout was made for this session; an unused one is litter.
          // Not forced — files someone dropped there make it the sidebar's problem.
          await deps.removeWorktree?.(note.dir).catch(() => {});
          if (deps.lastDir?.() === note.dir) deps.rememberDir?.(note.worktreeOf);
        }
        return outcome;
      })
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  };

  return { mark, unmark, ids, prune };
}

export type FreshSessions = ReturnType<typeof createFreshSessions>;
