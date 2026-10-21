import { createEffect, createMemo, createResource, createSignal } from "solid-js";
import {
  getJson,
  getJsonWhenUp,
  realWorkspace,
  type SessionRow,
  type SessionsResponse,
} from "./api";
import { settled } from "./resource";
import { holdRows, sameValue } from "./session-rows";
import { fleetAttention, projectName, dayKey } from "./fleet";
import { readPins, togglePin, writePins } from "./pins";
import {
  dayLabel,
  groupVisible,
  lensActive,
  lensCount,
  lensTypes,
  NO_LENS,
  readLens,
  sessionVisible,
  writeLens,
  type GroupBy,
  type LensSession,
  type PeriodLens,
  type ProjectLens,
  type StatusLens,
} from "./project-view";
import { t } from "./i18n";
import { displayTitle } from "./session-title";
import { windowTitle } from "./permission-card";
import { inDesktopShell } from "./shell";
import {
  announceFinished,
  announceNeedsInput,
  finishedSessions,
  readNotify,
  rememberBusy,
  rememberWaiting,
  waitingSessions,
} from "./notify";

export type SidebarGroup = {
  key: string;
  label: string;
  hint?: string;
  title?: string;
  rows: SessionRow[];
  /** A real project directory — only project groups carry one. It is what a
      group-level "+" aims a new session at, and what marks the group as
      worth showing even while it holds no rows. */
  dir?: string;
};

/**
 * The parent directory, abbreviated to `~` when it sits under a user home.
 * Shown only to disambiguate two projects that share a basename — for a
 * unique label it would repeat what the row already says.
 */
function dirHint(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const at = path.replace(/[/\\]+$/, "").lastIndexOf(sep);
  const parent = at <= 0 ? sep : path.slice(0, at);
  return parent.replace(/^\/Users\/[^/]+/, "~");
}

/**
 * The sidebar's session data: the /sessions resource, its workspace-scoped and
 * grouped views, pins and the project lens, the row actions, and the two
 * ambient effects that read the list — finish notifications and the window
 * title's waiting count.
 */
export function useSessionList(opts: {
  /** Project directories with no sessions yet — they still get a group. */
  extraDirs: () => string[];
  /** The project the reader is standing in — a lens never takes it away. */
  keepDir?: () => string | undefined;
  clock: () => number;
  activeId: () => string | undefined;
}) {
  // The first read waits for the service to come up; every refetch after is an
  // ordinary request, so a momentary hiccup reports as an error instead of
  // spinning forever.
  let opened = false;
  const [limit, setLimit] = createSignal(200);
  const [data, { refetch }] = createResource(limit, (n) => {
    const path = `/sessions?limit=${n}`;
    const load = opened
      ? getJson<SessionsResponse>(path)
      : getJsonWhenUp<SessionsResponse>(path);
    opened = true;
    return load;
  });
  const more = () => settled(data)?.more === true;
  const loadMore = () => setLimit((n) => Math.min(n + 200, 2000));

  const waiting = () =>
    (settled(data)?.sessions ?? []).filter((s) => s.needs_input && !s.archived && !s.deleted).length;
  createEffect(() => {
    const title = windowTitle(waiting());
    document.title = title;
    if (!inDesktopShell()) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title));
  });

  const sessionWorkspace = (s: SessionRow) => realWorkspace(s.workspace ?? s.summary.workspace);

  /**
   * The same list, row for row, whenever the answer came back the same.
   *
   * `data` refetches on a timer, on focus and after every event, and `<For>`
   * compares its items by reference — so fresh rows rebuilt the whole sidebar
   * several times a minute, taking a half-typed rename and a delete waiting on
   * its second click with them.
   */
  const library = createMemo((prev: SessionRow[] | undefined) =>
    holdRows(
      (settled(data)?.sessions ?? []).filter((s) => !s.parent && !s.archived && !s.deleted),
      prev,
      (s) => s.summary.session_id,
      sameValue,
    ),
  );

  const sessions = () => library();

  /** Archived roots, held the same way: the sidebar shows them in their own fold. */
  const archived = createMemo((prev: SessionRow[] | undefined) =>
    holdRows(
      (settled(data)?.sessions ?? []).filter((s) => !s.parent && s.archived === true && !s.deleted),
      prev,
      (s) => s.summary.session_id,
      sameValue,
    ),
  );

  const busySeen = new Map<string, boolean>();
  const waitingSeen = new Map<string, boolean>();
  let noticesReady = false;
  createEffect(() => {
    // A parent carries its subagent's wait; notifying the child as well would
    // announce the same approval twice under a title the sidebar hides.
    const next = (settled(data)?.sessions ?? [])
      .filter((s) => !s.parent && !s.archived && !s.deleted)
      .map((s) => ({
        id: s.summary.session_id,
        title: displayTitle(s.title || s.summary.title) ?? t("session.untitled"),
        busy: s.busy === true,
        needsInput: s.needs_input === true,
      }));
    if (!noticesReady) {
      rememberBusy(busySeen, next);
      rememberWaiting(waitingSeen, next);
      noticesReady = true;
      return;
    }
    if (readNotify()) {
      const waiting = waitingSessions(waitingSeen, next);
      const waitingIds = new Set(waiting.map((row) => row.id));
      for (const row of finishedSessions(busySeen, next)) {
        // A turn that stops on a question is waiting, not finished. Announcing
        // both would put two notices on the same pause.
        if (!waitingIds.has(row.id) && row.needsInput !== true) {
          announceFinished(row.title, row.id);
        }
      }
      for (const row of waiting) announceNeedsInput(row.title, row.id);
    }
    rememberBusy(busySeen, next);
    rememberWaiting(waitingSeen, next);
  });

  /**
   * Sessions the reader keeps on top.
   *
   * A pin is window-side state — it says this window cares about this
   * session, which is a property of the person looking, not of the session,
   * so it persists in storage rather than on the backend.
   */
  const [pins, setPins] = createSignal(readPins());
  const togglePinned = (id: string) => {
    const next = togglePin(pins(), id);
    setPins(next);
    writePins(next);
  };

  /**
   * The lens on the project section.
   *
   * It answers "which projects am I looking at, and how": it keeps the
   * project structure and narrows what is inside it — by name, by backend,
   * by status, by age, and by the way the list is cut up.
   */
  const [lens, setLensRaw] = createSignal<ProjectLens>(readLens());
  const setLens = (next: ProjectLens) => {
    setLensRaw(next);
    writeLens(next);
  };
  const patchLens = (part: Partial<ProjectLens>) => setLens({ ...lens(), ...part });
  const setQuery = (query: string) => patchLens({ query });
  const setHideEmpty = (hideEmpty: boolean) => patchLens({ hideEmpty });
  const setGroupBy = (groupBy: GroupBy) => patchLens({ groupBy });
  const setStatus = (status: StatusLens) => patchLens({ status });
  const setPeriod = (period: PeriodLens) => patchLens({ period });
  const setType = (type: string) => patchLens({ type });
  const clearLens = () => setLens(NO_LENS);

  /** The backends the list holds — what the type menu offers. */
  const types = () => lensTypes(sessions().map((s) => s.summary.backend));

  /** A session, as the lens looks at it. */
  const lensSession = (s: SessionRow): LensSession => ({
    title: s.title ?? s.summary.title,
    backend: s.summary.backend,
    lastTs: s.summary.last_ts,
    busy: s.busy === true,
    needsInput: s.needs_input === true,
  });

  /**
   * The groups under the header, cut up the way the reader asked.
   *
   * Two ways to cut the same sessions up: by the place they live, or by the
   * day they last ran. The first keeps the project's own shape — a "+" can
   * aim a new session at it. The second keeps the shape of a diary, and has
   * no place to aim at, because a day is not a directory.
   */
  const buildGroups = (): SidebarGroup[] => {
    const rows = sessions();
    if (rows.length === 0 && opts.extraDirs().length === 0) return [];

    // Three lanes, each row in exactly one: pinned first, then whatever is
    // running or waiting — the same set the fleet page calls "needs
    // attention" — then everything else in its usual buckets. Repeating a
    // row under both 需要关注 and its day would make the list argue with
    // itself about where the session lives.
    const pinSet = new Set(pins());
    const pinned: SessionRow[] = [];
    const loose: SessionRow[] = [];
    for (const s of rows) {
      (pinSet.has(s.summary.session_id) ? pinned : loose).push(s);
    }
    pinned.sort((a, b) => b.summary.last_ts.localeCompare(a.summary.last_ts));

    const attention = fleetAttention(loose);
    const attentionIds = new Set(attention.map((s) => s.summary.session_id));
    const rest = loose.filter((s) => !attentionIds.has(s.summary.session_id));

    const out: SidebarGroup[] = [];
    if (pinned.length > 0) {
      out.push({ key: "__pinned__", label: t("sidebar.group.pinned"), rows: pinned });
    }
    if (attention.length > 0) {
      out.push({ key: "__attention__", label: t("sidebar.group.attention"), rows: attention });
    }

    // The lens narrows the projects, not the lanes above them: a pin is the
    // reader's own choice and the attention set is the work that is moving,
    // and neither of them is a project the reader has to find.
    const now = opts.clock();
    const lensNow = lens();
    out.push(
      ...(lensNow.groupBy === "day"
        ? dayGroups(rest, lensNow, now)
        : projectGroups(rest, lensNow, now)),
    );
    return out;
  };

  /** The same sessions, cut up by the place they live. */
  const projectGroups = (
    rest: SessionRow[],
    lensNow: ProjectLens,
    now: number,
  ): SidebarGroup[] => {
    const byWs = new Map<string, SessionRow[]>();
    for (const s of rest) {
      const ws = sessionWorkspace(s) ?? "";
      const list = byWs.get(ws) ?? [];
      list.push(s);
      byWs.set(ws, list);
    }
    const sorted = [...byWs.entries()].sort((a, b) => {
      const ta = new Date(a[1][0]?.summary.last_ts ?? 0).getTime();
      const tb = new Date(b[1][0]?.summary.last_ts ?? 0).getTime();
      return tb - ta;
    });
    // A project with no sessions still gets a group — the service's workspace
    // list and the reader's own additions are places work can start, and a
    // "+" needs somewhere to point.
    for (const dir of opts.extraDirs()) {
      if (dir && !byWs.has(dir)) sorted.push([dir, []]);
    }
    // A hint exists to tell two same-named projects apart. Counting labels
    // first means a unique project shows its name alone, and only the
    // duplicates pay for the parent path.
    const labelCounts = new Map<string, number>();
    for (const [ws] of sorted) {
      const label = ws ? projectName(ws) : "";
      if (label) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
    const groups = sorted.map(([ws, list]) => {
      const label = ws ? projectName(ws) : t("sidebar.project.none");
      const project = { label, path: ws };
      const rows = list.filter((s) => sessionVisible(lensNow, lensSession(s), project, now));
      return {
        key: ws || "none",
        label,
        hint: ws && (labelCounts.get(projectName(ws)) ?? 0) > 1 ? dirHint(ws) : undefined,
        title: ws || undefined,
        rows,
        dir: ws || undefined,
        total: list.length,
      };
    });
    return groups
      .filter((group) =>
        groupVisible(
          lensNow,
          { rows: group.rows.length, total: group.total, path: group.title ?? "" },
          opts.keepDir?.(),
        ),
      )
      .map(({ total: _total, ...group }) => group);
  };

  /** The same sessions, cut up by the day they last ran. */
  const dayGroups = (rest: SessionRow[], lensNow: ProjectLens, now: number): SidebarGroup[] => {
    const byDay = new Map<string, SessionRow[]>();
    for (const s of rest) {
      const ts = new Date(s.summary.last_ts).getTime();
      if (!Number.isFinite(ts)) continue;
      const day = dayKey(ts);
      const list = byDay.get(day) ?? [];
      list.push(s);
      byDay.set(day, list);
    }
    const groups = [...byDay.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([day, list]) => {
        const rows = list.filter((s) => {
          const ws = sessionWorkspace(s) ?? "";
          const project = { label: ws ? projectName(ws) : t("sidebar.project.none"), path: ws };
          return sessionVisible(lensNow, lensSession(s), project, now);
        });
        return {
          key: `day:${day}`,
          label: dayLabel(day, now),
          rows,
          total: list.length,
        };
      });
    return groups
      .filter((group) =>
        groupVisible(lensNow, { rows: group.rows.length, total: group.total, path: "" }),
      )
      .map(({ total: _total, ...group }) => group);
  };

  /**
   * Same bargain one level up: the outer `<For>` compares group objects by
   * reference too, and a group rebuilt around the same rows would take its
   * children with it. Rows are already held still by `library`, so comparing
   * them by identity here is enough to know the group is unchanged.
   */
  const groups = createMemo((prev: SidebarGroup[] | undefined) =>
    holdRows(
      buildGroups(),
      prev,
      (g) => g.key,
      (a, b) =>
        a.key === b.key &&
        a.label === b.label &&
        a.hint === b.hint &&
        a.title === b.title &&
        a.rows.length === b.rows.length &&
        a.rows.every((row, i) => row === b.rows[i]),
    ),
  );

  const [actionErr, setActionErr] = createSignal("");
  const runAction = async (id: string, fn: () => Promise<void>, leave: boolean) => {
    setActionErr("");
    try {
      await fn();
      if (leave && opts.activeId() === id) location.hash = "/";
      refetch();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    }
  };

  return {
    data,
    refetch,
    waiting,
    sessionWorkspace,
    library,
    sessions,
    archived,
    pins,
    togglePinned,
    lens,
    lensActive: () => lensActive(lens()),
    lensCount: () => lensCount(lens()),
    setQuery,
    setHideEmpty,
    setGroupBy,
    setStatus,
    setPeriod,
    setType,
    clearLens,
    types,
    groups,
    actionErr,
    setActionErr,
    runAction,
    more,
    loadMore,
  };
}

export type SessionListCtl = ReturnType<typeof useSessionList>;
