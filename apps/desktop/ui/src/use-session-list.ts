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
import { fleetAttention, projectName } from "./fleet";
import { readPins, togglePin, writePins } from "./pins";
import { t } from "./i18n";
import { displayTitle } from "./session-title";
import { windowTitle } from "./permission-card";
import { inDesktopShell } from "./shell";
import { announceFinished, finishedSessions, readNotify, rememberBusy } from "./notify";

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
 * grouped views, pins and the attention lens, the row actions, and the two
 * ambient effects that read the list — finish notifications and the window
 * title's waiting count.
 */
export function useSessionList(opts: {
  /** Project directories with no sessions yet — they still get a group. */
  extraDirs: () => string[];
  clock: () => number;
  activeId: () => string | undefined;
}) {
  // The first read waits for the service to come up; every refetch after is an
  // ordinary request, so a momentary hiccup reports as an error instead of
  // spinning forever.
  let opened = false;
  const [data, { refetch }] = createResource(() => {
    const load = opened
      ? getJson<SessionsResponse>("/sessions")
      : getJsonWhenUp<SessionsResponse>("/sessions");
    opened = true;
    return load;
  });

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

  const busySeen = new Map<string, boolean>();
  let busyReady = false;
  createEffect(() => {
    const next = (settled(data)?.sessions ?? [])
      .filter((s) => !s.archived && !s.deleted)
      .map((s) => ({
        id: s.summary.session_id,
        title: displayTitle(s.title || s.summary.title) ?? t("session.untitled"),
        busy: s.busy === true,
      }));
    if (!busyReady) {
      rememberBusy(busySeen, next);
      busyReady = true;
      return;
    }
    if (readNotify()) {
      for (const row of finishedSessions(busySeen, next)) announceFinished(row.title);
    }
    rememberBusy(busySeen, next);
  });

  /**
   * Sessions the reader keeps on top, and the "only what is running" lens.
   *
   * A pin is window-side state — it says this window cares about this
   * session, which is a property of the person looking, not of the session,
   * so it persists in storage rather than on the backend. `attentionOnly`
   * is the momentary version of the same question and is deliberately not
   * persisted: it answers "where is my running work" for a glance, and a
   * lens that survived restarts would hide sessions the reader forgot they
   * filtered out.
   */
  const [pins, setPins] = createSignal(readPins());
  const [attentionOnly, setAttentionOnly] = createSignal(false);
  const togglePinned = (id: string) => {
    const next = togglePin(pins(), id);
    setPins(next);
    writePins(next);
  };

  /** The attention set, filter included — pinned rows count when they run. */
  const attentionRows = () => fleetAttention(sessions());

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
    out.push(
      ...sorted.map(([ws, list]) => ({
        key: ws || "none",
        label: ws ? projectName(ws) : t("sidebar.project.none"),
        hint: ws && (labelCounts.get(projectName(ws)) ?? 0) > 1 ? dirHint(ws) : undefined,
        title: ws || undefined,
        rows: list,
        dir: ws || undefined,
      })),
    );
    return out;
  };

  /**
   * Same bargain one level up: the outer `<For>` compares group objects by
   * reference too, and a group rebuilt around the same rows would take its
   * children with it. Rows are already held still by `library`, so comparing
   * them by identity here is enough to know the group is unchanged.
   *
   * The attention lens shares this memo rather than building its own list in
   * the render path, because a freshly allocated group every poll would
   * unmount every row in it and drop a half-typed rename with it.
   */
  const groups = createMemo((prev: SidebarGroup[] | undefined) =>
    holdRows(
      attentionOnly()
        ? [{ key: "__attention__", label: t("sidebar.group.attention"), rows: attentionRows() }]
        : buildGroups(),
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
    pins,
    togglePinned,
    attentionOnly,
    setAttentionOnly,
    attentionRows,
    groups,
    actionErr,
    setActionErr,
    runAction,
  };
}

export type SessionListCtl = ReturnType<typeof useSessionList>;
