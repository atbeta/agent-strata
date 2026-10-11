import { createEffect, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  api,
  archiveSession,
  connectBackend,
  deleteSession,
  disconnectBackend,
  fmtUsd,
  getJson,
  readOpencodeLaunch,
  realWorkspace,
  renameSession,
  syncBackend,
  type Connection,
  type SessionRow,
  type SessionsResponse,
  type StrataEvent,
} from "./api";
import { SessionDetail } from "./session-detail";
import { CompareView } from "./compare";
import { SettingsPage } from "./settings";
import { settingsPath } from "./settings-sections";
import { applyTheme, readTheme } from "./theme";
import { applyFonts, readFonts } from "./font";
import { announceFinished, finishedSessions, readNotify, rememberBusy } from "./notify";
import { commandForChord, registerCommand } from "./commands";
import { CommandPalette } from "./palette";
import { SessionSwitcher } from "./switcher";
import { readMru, recentOrder, stepIndex, touchMru, writeMru } from "./session-switch";
import { Icon } from "./icons";
import { PageShell, WindowCaptionBar } from "./chrome";
import { inDesktopShell } from "./shell";
import { windowTitle } from "./permission-card";
import { date, num, t, tn } from "./i18n";
import { Tip } from "./tip";
import { CommandSearch } from "./search";
import { isStreamingSnapshotMessage } from "./live";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TextField, TextFieldInput, TextFieldLabel } from "@/components/ui/text-field";
import { cn } from "@/lib/utils";

type Route =
  | { name: "fleet" }
  | { name: "session"; id: string }
  | { name: "compare"; a: string; b: string }
  | { name: "settings"; section?: string };

function parseHash(): Route {
  const h = location.hash.slice(1);
  const s = h.match(/^\/session\/(.+)$/);
  if (s) return { name: "session", id: decodeURIComponent(s[1]!) };
  const c = h.match(/^\/compare\/([^/]+)\/(.+)$/);
  if (c) return { name: "compare", a: decodeURIComponent(c[1]!), b: decodeURIComponent(c[2]!) };
  const settings = settingsPath(h);
  if (settings) return { name: "settings", section: settings.section };
  return { name: "fleet" };
}

/**
 * The landing pane.
 *
 * The sidebar is already the list of sessions, so repeating "pick a session"
 * here — with a button that did the same thing as the `+` above it — spent
 * most of the window saying nothing twice. This answers the one question the
 * sidebar cannot: what these sessions have cost, and which ones were recent.
 *
 * Every figure is summed from the rows already in hand rather than from the
 * server's global aggregate, so filtering to a project narrows the numbers to
 * match the list instead of leaving them describing all of it.
 */
function FleetOverview(props: {
  sessions: SessionRow[];
  onOpen: (id: string) => void;
  now: number;
}) {
  const cost = () => props.sessions.reduce((sum, s) => sum + s.totals.cost_usd, 0);
  const tokens = () =>
    props.sessions.reduce((sum, s) => sum + s.totals.input + s.totals.output, 0);
  const recent = () =>
    [...props.sessions]
      .sort((a, b) => b.summary.last_ts.localeCompare(a.summary.last_ts))
      .slice(0, 6);

  const figure = (label: string, value: string) => (
    <div class="bg-background px-4 py-3">
      <div class="text-2xs text-muted-foreground">{label}</div>
      <div class="mt-1 font-mono text-lg leading-none tabular-nums text-foreground">{value}</div>
    </div>
  );

  return (
    <div class="px-8 py-10">
      {/* gap-px over a border-coloured field draws the hairlines between the
          figures, which is how this design separates things: one surface, a
          line, no second grey. */}
      <div class="grid max-w-2xl grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border">
        {figure(t("fleet.overview.sessions"), num(props.sessions.length))}
        {figure(t("fleet.overview.cost"), fmtUsd(cost()))}
        {figure(t("fleet.overview.tokens"), num(tokens()))}
      </div>

      <div class="mt-8 max-w-2xl">
        <div class="mb-1 text-xs text-muted-foreground">{t("fleet.overview.recent")}</div>
        <ul class="divide-y divide-border">
          <For each={recent()}>
            {(s) => (
              <li>
                <button
                  type="button"
                  class="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-secondary/60"
                  onClick={() => props.onOpen(s.summary.session_id)}
                >
                  <span class="min-w-0 flex-1 truncate text-sm text-foreground">
                    {s.title ?? s.summary.title ?? t("common.untitled")}
                  </span>
                  <Show when={s.totals.cost_usd > 0}>
                    <span class="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                      {fmtUsd(s.totals.cost_usd)}
                    </span>
                  </Show>
                  <span class="w-12 shrink-0 text-right text-2xs text-muted-foreground">
                    {relTime(s.summary.last_ts, props.now)}
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </div>
    </div>
  );
}

function relTime(iso: string, now = Date.now()): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "";
  const mins = Math.round((now - ts) / 60_000);
  if (mins < 1) return t("time.now");
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours}h`;
  return date(ts);
}

const TIME_BUCKETS = ["time.today", "time.yesterday", "time.week", "time.older"] as const;

function dayBucket(iso: string, now: number): (typeof TIME_BUCKETS)[number] {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "time.older";
  const start = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const diff = Math.round((start(now) - start(ts)) / 86_400_000);
  if (diff <= 0) return "time.today";
  if (diff === 1) return "time.yesterday";
  if (diff < 7) return "time.week";
  return "time.older";
}

const WS_KEY = "strata.workspace";
const NEW_CONN_KEY = "strata.newSessionConnection";
const ALL = "__all__";

function baseName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function projectName(path: string): string {
  if (path === "/" || path === "\\") return t("project.root");
  return baseName(path);
}

function projectHint(path: string): string {
  if (path === "/" || path === "\\") return t("project.rootHint");
  const parent = parentPath(path);
  return parent === path ? path : parent;
}

/** An errored Solid resource throws when read. Check first so one failed request cannot unmount the menu. */
function settled<T>(resource: { error: unknown; (): T | undefined }): T | undefined {
  return resource.error ? undefined : resource();
}

function explain(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === "Load failed" || msg === "Failed to fetch") return t("error.serviceUnreachable");
  return msg;
}

function parentPath(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 1) return path;
  const parent = parts.slice(0, -1).join("/");
  return path.startsWith("\\") ? parent : path.startsWith("/") ? `/${parent}` : parent;
}

function SessionListItem(props: {
  id: string;
  title: string;
  active: boolean;
  busy: boolean;
  needsInput: boolean;
  time: string;
  actions: boolean;
  onOpen: () => void;
  onRename: (title: string) => Promise<void>;
  onArchive: () => Promise<void>;
  onDelete: () => Promise<void>;
  /** Start a comparison with this session already picked. */
  onCompare: () => void;
  /**
   * Which server this session lives on, set only while one backend kind has
   * more than one instance connected.
   */
  instance?: { short: string; tip: string };
}) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal(props.title);
  const [armed, setArmed] = createSignal(false);
  const [hot, setHot] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  let input: HTMLInputElement | undefined;
  // Rename, archive, and delete stay behind one hover control. The menu is a
  // portal, so it has to count as "still on the row" or the control disappears.
  const reveal = () => props.actions && (hot() || menuOpen());

  createEffect(() => {
    if (!editing()) setDraft(props.title);
  });

  const commit = async () => {
    const title = draft().trim();
    setEditing(false);
    if (!title || title === props.title) return;
    await props.onRename(title);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      class={`relative flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors ${
        props.active ? "bg-accent text-foreground" : "text-foreground/80 hover:bg-secondary/70"
      }`}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      onClick={(e) => {
        if (editing()) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest?.("[data-session-menu]")) return;
        props.onOpen();
      }}
      onKeyDown={(e) => {
        if (editing()) return;
        if (e.key === "Enter") props.onOpen();
      }}
    >
      <span
        class={`h-1.5 w-1.5 shrink-0 rounded-full ${props.busy ? "bg-status-active" : "bg-transparent"}`}
      />
      <Show when={props.needsInput}>
        <span class="shrink-0 rounded bg-event-permission/15 px-1 text-2xs font-medium text-event-permission">
          {t("sidebar.session.needsInput")}
        </span>
      </Show>
      {/* Before the title, not after it: the title reserves its right padding
          for the timestamp, which is absolutely positioned over the end of the
          row, and a badge placed after the title lands on top of it. Left of
          the title it also reads as what it is — row metadata, like the status
          dot, rather than part of the session's name.
          A native title on its own span: the session title is pointer-events-none
          by design so the row's own hover label is the one that shows. */}
      <Show when={props.instance && !editing()}>
        <span
          class="shrink-0 rounded bg-secondary/70 px-1 font-mono text-2xs leading-none text-muted-foreground"
          title={props.instance!.tip}
        >
          {props.instance!.short}
        </span>
      </Show>
      <Show
        when={editing()}
        fallback={<span class="min-w-0 flex-1 truncate pr-[4.75rem] text-sm leading-none">{props.title}</span>}
      >
        <input
          ref={(el) => {
            input = el;
            el.focus();
            el.select();
          }}
          class="min-w-0 flex-1 rounded bg-background px-1 py-0.5 text-sm leading-none focus:outline-none"
          value={draft()}
          onClick={(e) => e.stopPropagation()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") void commit();
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={() => void commit()}
        />
      </Show>
      <Show when={!editing()}>
        {/* No title here: the span is pointer-events-none, so a native tooltip
            could never surface. The row's own hover covers it. */}
        <span
          class={`pointer-events-none absolute right-2 top-1/2 w-[4.5rem] -translate-y-1/2 text-right font-mono text-2xs text-muted-foreground tabular-nums ${
            reveal() ? "invisible" : ""
          }`}
        >
          {props.time}
        </span>
        <DropdownMenu
          placement="bottom-end"
          open={menuOpen()}
          onOpenChange={(open) => {
            setMenuOpen(open);
            if (!open) setArmed(false);
          }}
        >
          <DropdownMenuTrigger
            class={`absolute right-1 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground ${
              reveal() ? "" : "invisible pointer-events-none"
            }`}
            aria-label={t("sidebar.session.actions")}
            data-session-menu=""
            tabIndex={reveal() ? 0 : -1}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <Icon name="more" class="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent class="min-w-40">
            <DropdownMenuItem
              onSelect={() => {
                setDraft(props.title);
                setEditing(true);
              }}
            >
              <Icon name="pencil" class="size-3.5 text-muted-foreground" />
              {t("sidebar.session.rename")}
            </DropdownMenuItem>
            {/* Compare belongs on the session rather than behind a global
                toggle: a comparison always starts from one of the two, so
                asking the list to enter a mode first made the user name a
                session before they could start. */}
            <DropdownMenuItem onSelect={props.onCompare}>
              <Icon name="columns" class="size-3.5 text-muted-foreground" />
              {t("sidebar.session.compare")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void props.onArchive()}>
              <Icon name="archive" class="size-3.5 text-muted-foreground" />
              {t("sidebar.session.archive")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              class={armed() ? "text-destructive data-[highlighted]:text-destructive" : ""}
              closeOnSelect={armed()}
              onSelect={() => {
                if (!armed()) {
                  setArmed(true);
                  return;
                }
                void props.onDelete();
              }}
            >
              <Icon name="trash" class={`size-3.5 ${armed() ? "" : "text-muted-foreground"}`} />
              {armed() ? t("sidebar.session.deleteArmed") : t("sidebar.session.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Show>
    </div>
  );
}

function backendLabel(backend: string): string {
  if (backend === "opencode") return "OpenCode";
  if (backend === "acp") return "ACP";
  return backend;
}

function endpointHost(url: string): string {
  if (url.startsWith("acp://")) return url.slice("acp://".length);
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The shortest form of an address that still tells two instances apart.
 *
 * Local backends are nearly all loopback, and every one of them reads
 * `127.0.0.1:<port>` — the host is the part that never varies and the port is
 * the whole identity, so a row that shows the host too has spent its width on
 * nothing. A remote address keeps its host, because there it is the part that
 * repeats.
 */
function endpointShort(url: string): string {
  const host = endpointHost(url);
  const loopback = /^127\./.test(host) || /^localhost(:|$)/i.test(host) || /^\[::1\]:/.test(host);
  if (!loopback) return host;
  const colon = host.lastIndexOf(":");
  const port = colon === -1 ? "" : host.slice(colon + 1);
  return /^\d+$/.test(port) ? port : host;
}

export function App() {
  const [route, setRoute] = createSignal<Route>(parseHash());
  const [clock, setClock] = createSignal(Date.now());
  const [data, { refetch }] = createResource(() => getJson<SessionsResponse>("/sessions"));
  const waiting = () =>
    (settled(data)?.sessions ?? []).filter((s) => s.needs_input && !s.archived && !s.deleted).length;
  createEffect(() => {
    const title = windowTitle(waiting());
    document.title = title;
    if (!inDesktopShell()) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title));
  });
  const [conns, { refetch: refetchConns }] = createResource(() =>
    getJson<{ connections: Connection[] }>("/connections"),
  );
  const [opencodeLaunch] = createResource(readOpencodeLaunch);
  const backendMissing = () => settled(opencodeLaunch)?.state === "missing";
  const [query, setQuery] = createSignal("");
  const [workspace, setWorkspace] = createSignal<string | null>(localStorage.getItem(WS_KEY));
  const [wsOpen, setWsOpen] = createSignal(false);
  const [wsDraft, setWsDraft] = createSignal("");
  const [actionErr, setActionErr] = createSignal("");
  const [wsList, { refetch: refetchWs }] = createResource(() =>
    getJson<{ workspaces: { directory: string; name?: string }[] }>("/workspaces"),
  );
  const [connOpen, setConnOpen] = createSignal(false);
  const [connUrl, setConnUrl] = createSignal("http://127.0.0.1:4096");
  const [connName, setConnName] = createSignal("");
  const [connKind, setConnKind] = createSignal<"opencode" | "acp">("opencode");
  const [connCmd, setConnCmd] = createSignal("opencode acp");
  const [newConn, setNewConn] = createSignal<string | null>(localStorage.getItem(NEW_CONN_KEY));
  const chooseNewConn = (id: string) => {
    setNewConn(id);
    localStorage.setItem(NEW_CONN_KEY, id);
  };
  const newSessionConnection = () => {
    const list = settled(conns)?.connections ?? [];
    return list.find((c) => c.id === newConn())?.id ?? list[0]?.id;
  };
  const [connUser, setConnUser] = createSignal("");
  const [connPass, setConnPass] = createSignal("");
  const [connErr, setConnErr] = createSignal("");
  const [connecting, setConnecting] = createSignal(false);
  const [compareOn, setCompareOn] = createSignal(false);
  const [compareSel, setCompareSel] = createSignal<string[]>([]);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [results] = createResource(query, async (q) =>
    q.trim()
      ? (
          await getJson<{ events: StrataEvent[] }>(
            `/events?text=${encodeURIComponent(q.trim())}&order=desc&limit=40`,
          )
        ).events
      : [],
  );

  onMount(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    applyTheme(readTheme());
    applyFonts(readFonts());
    const scheme = window.matchMedia("(prefers-color-scheme: light)");
    const onScheme = () => {
      if (readTheme() === "system") applyTheme("system");
    };
    scheme.addEventListener("change", onScheme);
    const clockTimer = setInterval(() => setClock(Date.now()), 30_000);
    const es = new EventSource(api("/stream"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pull = () => {
      void syncBackend()
        .catch(() => {})
        .finally(() => {
          refetch();
          refetchConns();
          void refetchWs();
        });
    };
    pull();
    const syncTimer = setInterval(pull, 12_000);
    const onFocus = () => pull();
    window.addEventListener("focus", onFocus);
    // A hidden window is not a window. `pull` asks every backend for its whole
    // project list and rereads all four resources, and none of it reaches an
    // eye until the window comes back — which is when it runs again anyway.
    const onVisibility = () => {
      if (document.visibilityState === "visible") pull();
    };
    document.addEventListener("visibilitychange", onVisibility);
    let wsStale = false;
    es.onmessage = (m) => {
      if (isStreamingSnapshotMessage(m.data)) return;
      // The project list costs a round trip to every backend, and only a
      // session appearing, moving or going away can change it.
      try {
        const type = (JSON.parse(m.data) as { type?: string }).type;
        if (type === "session.started" || type === "session.updated" || type === "session.deleted") wsStale = true;
      } catch {
        // heartbeats
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        refetch();
        refetchConns();
        if (wsStale) {
          wsStale = false;
          void refetchWs();
        }
      }, 200);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (switchOpen() && e.key === "Escape") {
        setSwitchOpen(false);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (paletteOpen() && e.key === "Escape") {
        setPaletteOpen(false);
        e.preventDefault();
        return;
      }
      const cmd = commandForChord(e);
      if (cmd) {
        e.preventDefault();
        e.stopPropagation();
        if (cmd.id !== "app.palette") setPaletteOpen(false);
        if (cmd.id !== "app.nextSession" && cmd.id !== "app.prevSession") setSwitchOpen(false);
        chordHeld = true;
        cmd.run();
        chordHeld = false;
        return;
      }
      if (e.key !== "Escape") return;
      if (searchOpen()) {
        setSearchOpen(false);
        setQuery("");
        e.preventDefault();
        return;
      }
      if (wsOpen()) {
        setWsOpen(false);
        e.preventDefault();
        return;
      }
      if (connOpen()) {
        setConnOpen(false);
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Control" && e.key !== "Meta") return;
      commitSwitch();
    };
    // Capture, so a focused terminal or the composer menu does not take Tab first.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    // The shell leaves file drops to the page, and a page that does not take one
    // navigates the whole window to the file.
    const onFileDrag = (e: DragEvent) => {
      if (e.defaultPrevented || !e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      if (e.type === "dragover") e.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", onFileDrag);
    window.addEventListener("drop", onFileDrag);
    onCleanup(() => {
      scheme.removeEventListener("change", onScheme);
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("dragover", onFileDrag);
      window.removeEventListener("drop", onFileDrag);
      clearInterval(clockTimer);
      clearInterval(syncTimer);
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      es.close();
    });
  });

  const connect = async () => {
    setConnErr("");
    setConnecting(true);
    try {
      const words = connCmd().trim().split(/\s+/).filter(Boolean);
      const id = await connectBackend(
        connKind() === "acp"
          ? {
              backend: "acp",
              command: words[0]!,
              args: words.slice(1),
              cwd: currentDir(),
              name: connName().trim() || undefined,
            }
          : {
              baseUrl: connUrl().trim(),
              name: connName().trim() || undefined,
              username: connUser() || undefined,
              password: connPass() || undefined,
            },
      );
      chooseNewConn(id);
      setConnOpen(false);
      refetchConns();
      refetch();
      window.dispatchEvent(new Event("strata-connections"));
    } catch (e) {
      setConnErr(explain(e));
    } finally {
      setConnecting(false);
    }
  };

  const currentDir = () => {
    const w = workspace();
    if (!w || w === ALL) return undefined;
    return w;
  };

  const chooseWorkspace = (dir: string) => {
    setWorkspace(dir);
    localStorage.setItem(WS_KEY, dir);
    setWsOpen(false);
    setWsDraft("");
  };

  createEffect(() => {
    if (workspace() !== null) return;
    const row = (settled(data)?.sessions ?? []).find(
      (s) => !s.parent && !s.archived && !s.deleted && realWorkspace(s.workspace ?? s.summary.workspace),
    );
    const ws = realWorkspace(row?.workspace ?? row?.summary.workspace);
    if (ws) chooseWorkspace(ws);
  });

  const newSession = async () => {
    const res = await fetch(api("/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: currentDir(), connection_id: newSessionConnection() }),
    });
    const body = (await res.json()) as { id?: string; error?: string };
    if (body.id) {
      refetch();
      location.hash = `/session/${encodeURIComponent(body.id)}`;
    } else {
      setConnErr(body.error ?? t("error.createSession"));
      setConnOpen(true);
    }
  };

  const openSession = (id: string) => {
    if (compareOn()) {
      setCompareSel((sel) =>
        sel.includes(id) ? sel.filter((x) => x !== id) : [...sel.slice(-1), id],
      );
      return;
    }
    location.hash = `/session/${encodeURIComponent(id)}`;
  };

  /** Enter compare mode with one session already chosen. With no id the user
   *  picks both, which is what the palette command does. */
  const startCompare = (id?: string) => {
    setCompareOn(true);
    setCompareSel(id ? [id] : []);
    if (id && location.hash !== "/") location.hash = "/";
  };

  const sessionWorkspace = (s: SessionRow) => realWorkspace(s.workspace ?? s.summary.workspace);

  /**
   * The connection ids the sidebar's sessions are actually spread across.
   *
   * A session carries a `backend`, but that names the kind and never the
   * server, so nothing on the row says which instance produced it. Naming it
   * is only worth the row width when the list is genuinely split: two
   * OpenCodes over one agent's session store hold the same sessions, and which
   * of them owns a given one is arbitrary, so the badge would repeat a single
   * answer down the whole list. A session no connected backend owns counts as
   * its own bucket, because that is the other case where the rows are not
   * interchangeable.
   */
  const splitInstances = () => {
    const ids = new Set<string>();
    for (const g of groups()) for (const s of g.rows) ids.add(s.connection_id ?? "");
    return ids;
  };

  const instanceOf = (s: SessionRow) => {
    if (!s.connection_id || splitInstances().size < 2) return undefined;
    const c = (settled(conns)?.connections ?? []).find((x) => x.id === s.connection_id);
    if (!c) return undefined;
    return {
      short: endpointShort(c.baseUrl),
      tip: `${backendLabel(c.backend)} · ${endpointHost(c.baseUrl)}`,
    };
  };

  const library = () =>
    (settled(data)?.sessions ?? []).filter((s) => !s.parent && !s.archived && !s.deleted);

  const sessions = () => {
    const rows = library();
    const dir = currentDir();
    return dir ? rows.filter((s) => sessionWorkspace(s) === dir) : rows;
  };

  const busySeen = new Map<string, boolean>();
  let busyReady = false;
  createEffect(() => {
    const next = (settled(data)?.sessions ?? [])
      .filter((s) => !s.archived && !s.deleted)
      .map((s) => ({
        id: s.summary.session_id,
        title: s.title || s.summary.title || t("session.untitled"),
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

  const workspaceOptions = () => {
    const map = new Map<string, string>();
    const cur = currentDir();
    if (cur) map.set(cur, projectName(cur));
    for (const w of settled(wsList)?.workspaces ?? []) {
      if (w.directory) map.set(w.directory, w.name || projectName(w.directory));
    }
    for (const s of settled(data)?.sessions ?? []) {
      const ws = sessionWorkspace(s);
      if (ws && !map.has(ws)) map.set(ws, projectName(ws));
    }
    return [...map.entries()].map(([directory, name]) => ({ directory, name }));
  };

  const groups = (): { key: string; label: string; hint?: string; rows: SessionRow[] }[] => {
    const rows = sessions();
    if (rows.length === 0) return [];
    if (!currentDir()) {
      const byWs = new Map<string, SessionRow[]>();
      for (const s of rows) {
        const ws = sessionWorkspace(s) ?? "";
        const list = byWs.get(ws) ?? [];
        list.push(s);
        byWs.set(ws, list);
      }
      return [...byWs.entries()]
        .sort((a, b) => {
          const ta = new Date(a[1][0]?.summary.last_ts ?? 0).getTime();
          const tb = new Date(b[1][0]?.summary.last_ts ?? 0).getTime();
          return tb - ta;
        })
        .map(([ws, list]) => ({
          key: ws || "none",
          label: ws ? projectName(ws) : t("sidebar.project.none"),
          hint: ws || undefined,
          rows: list,
        }));
    }
    const buckets = new Map<string, SessionRow[]>();
    for (const s of rows) {
      const bucket = dayBucket(s.summary.last_ts, clock());
      const list = buckets.get(bucket) ?? [];
      list.push(s);
      buckets.set(bucket, list);
    }
    return TIME_BUCKETS.filter((bucket) => buckets.has(bucket)).map((bucket) => ({
      key: bucket,
      label: t(bucket),
      rows: buckets.get(bucket)!,
    }));
  };

  const runAction = async (id: string, fn: () => Promise<void>, leave: boolean) => {
    setActionErr("");
    try {
      await fn();
      if (leave && activeId() === id) location.hash = "/";
      refetch();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    }
  };

  const activeId = () => {
    const r = route();
    return r.name === "session" ? r.id : undefined;
  };
  const connected = () => (settled(conns)?.connections.length ?? 0) > 0;
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [switchOpen, setSwitchOpen] = createSignal(false);
  const [switchIds, setSwitchIds] = createSignal<string[]>([]);
  const [switchAt, setSwitchAt] = createSignal(0);
  let chordHeld = false;
  let seenSession: string | undefined;

  const switchSource = () =>
    sessions().map((s) => ({
      id: s.summary.session_id,
      title: s.title || s.summary.title || t("common.untitled"),
      lastTs: Date.parse(s.summary.last_ts) || 0,
    }));

  const moveSession = (delta: number) => {
    const opening = !switchOpen();
    const ids = opening ? recentOrder(switchSource(), readMru(), activeId()) : switchIds();
    const at = stepIndex({
      length: ids.length,
      at: opening ? null : switchAt(),
      delta,
      currentAtFront: ids[0] === activeId(),
    });
    if (at === null) return;
    if (!chordHeld) {
      const id = ids[at];
      if (id) location.hash = `/session/${encodeURIComponent(id)}`;
      return;
    }
    if (opening) setSwitchIds(ids);
    setSwitchAt(at);
    setSwitchOpen(true);
  };

  const commitSwitch = () => {
    if (!switchOpen()) return;
    const id = switchIds()[switchAt()];
    setSwitchOpen(false);
    if (id && id !== activeId()) location.hash = `/session/${encodeURIComponent(id)}`;
  };

  const chooseSwitch = (id: string) => {
    setSwitchOpen(false);
    if (id !== activeId()) location.hash = `/session/${encodeURIComponent(id)}`;
  };

  createEffect(() => {
    const id = activeId();
    if (seenSession !== undefined && id !== seenSession) setSwitchOpen(false);
    seenSession = id;
  });

  createEffect(() => {
    const id = activeId();
    if (!id || !library().some((s) => s.summary.session_id === id)) return;
    const prev = readMru();
    if (prev[0] === id) return;
    writeMru(touchMru(prev, id));
  });

  onCleanup(
    registerCommand({
      id: "app.palette",
      title: () => t("palette.title"),
      chord: { key: "p", shift: true },
      listed: false,
      run: () => setPaletteOpen((open) => !open),
    }),
  );
  onCleanup(
    registerCommand({
      id: "app.newSession",
      title: () => t("action.newSession"),
      run: () => {
        if (!connected()) {
          setConnOpen(true);
          return;
        }
        void newSession();
      },
    }),
  );
  onCleanup(
    registerCommand({
      id: "app.search",
      title: () => t("search.label"),
      chord: { key: "k" },
      run: () =>
        setSearchOpen((open) => {
          if (open) setQuery("");
          return !open;
        }),
    }),
  );
  onCleanup(
    registerCommand({
      id: "app.settings",
      title: () => t("settings.title"),
      run: () => {
        location.hash = "/settings";
      },
    }),
  );
  onCleanup(
    registerCommand({
      id: "app.permission",
      title: () => t("settings.permission.title"),
      // Straight to the section, so the keyboard path lands where the eye
      // does rather than on the first tab with the rules one step away.
      run: () => {
        location.hash = "/settings/permission";
      },
    }),
  );
  onCleanup(
    registerCommand({
      id: "app.compare",
      title: () => t("sidebar.compare.start"),
      run: () => startCompare(),
    }),
  );
  onCleanup(
    registerCommand({
      id: "app.nextSession",
      title: () => t("switcher.next"),
      chord: { key: "Tab", repeat: true },
      enabled: () => sessions().length >= 2,
      run: () => moveSession(1),
    }),
  );
  onCleanup(
    registerCommand({
      id: "app.prevSession",
      title: () => t("switcher.prev"),
      chord: { key: "Tab", shift: true, repeat: true },
      enabled: () => sessions().length >= 2,
      run: () => moveSession(-1),
    }),
  );

  return (
    <div class="flex h-full min-h-0 flex-col bg-background">
      <WindowCaptionBar />
      <div class="flex min-h-0 flex-1">
      <aside class="flex w-[300px] shrink-0 flex-col border-r border-border bg-background">
        <div
          class="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-3 pl-3 select-none"
          data-tauri-drag-region={inDesktopShell() ? "" : undefined}
        >
          <Tip class="ml-auto" label={connected() ? t("action.newSession") : t("action.connectBackend")}>
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-lg leading-none text-muted-foreground"
              aria-label={connected() ? t("action.newSession") : t("action.connectBackend")}
              onClick={() => {
                if (!connected()) {
                  setConnOpen(true);
                  return;
                }
                void newSession();
              }}
            >
              +
            </Button>
          </Tip>
        </div>
        <CommandSearch
          open={searchOpen()}
          query={query()}
          sessions={library()}
          events={settled(results)}
          searching={results.loading}
          onOpenChange={(open) => {
            setSearchOpen(open);
            if (!open) setQuery("");
          }}
          onQuery={setQuery}
          onOpenSession={(id) => {
            location.hash = `/session/${encodeURIComponent(id)}`;
          }}
        />
        <div class="flex flex-col gap-2 px-3 pt-2 pb-3">
          <div>
            <p class="mb-1 px-0.5 text-2xs font-medium text-muted-foreground">
              {t("sidebar.project.label")}
            </p>
            <DropdownMenu open={wsOpen()} onOpenChange={setWsOpen} gutter={6}>
              <Tip label={currentDir() ?? t("sidebar.project.all")} class="w-full">
                <DropdownMenuTrigger
                  class={cn(
                    "flex w-full items-center gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1.5 text-left transition-colors hover:bg-secondary",
                    wsOpen() && "bg-secondary",
                  )}
                >
                  <span class="grid size-7 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground">
                    <Icon name="folder" class="size-3.5" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm font-medium leading-tight">
                      {currentDir() ? projectName(currentDir()!) : t("sidebar.project.all")}
                    </span>
                    <span class="block truncate font-mono text-2xs leading-tight text-muted-foreground">
                      {currentDir()
                        ? projectHint(currentDir()!)
                        : tn("sidebar.sessionCount", sessions().length)}
                    </span>
                  </span>
                  <Icon
                    name="chevron"
                    class={cn("size-3.5 shrink-0 text-muted-foreground", wsOpen() && "rotate-180")}
                  />
                </DropdownMenuTrigger>
              </Tip>
              <DropdownMenuContent class="max-h-80 w-[276px] overflow-y-auto">
                <DropdownMenuItem
                  class={cn("flex-col items-start gap-0", !currentDir() && "bg-accent")}
                  onSelect={() => chooseWorkspace(ALL)}
                >
                  <span class="font-medium">{t("sidebar.project.all")}</span>
                  <span class="text-2xs text-muted-foreground">{t("sidebar.project.allHint")}</span>
                </DropdownMenuItem>
                <For each={workspaceOptions()}>
                  {(w) => (
                    <DropdownMenuItem
                      class={cn("flex-col items-start gap-0", currentDir() === w.directory && "bg-accent")}
                      title={w.directory}
                      onSelect={() => chooseWorkspace(w.directory)}
                    >
                      <span class="w-full truncate">{projectName(w.directory)}</span>
                      <span class="w-full truncate font-mono text-2xs text-muted-foreground">{w.directory}</span>
                    </DropdownMenuItem>
                  )}
                </For>
                <DropdownMenuSeparator />
                <form
                  class="px-2 py-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const path = wsDraft().trim();
                    if (path) chooseWorkspace(path);
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <TextField value={wsDraft()} onChange={setWsDraft}>
                    <TextFieldLabel class="text-2xs font-medium text-muted-foreground">
                      {t("sidebar.project.openDirectory")}
                    </TextFieldLabel>
                    <TextFieldInput
                      class="h-8 font-mono text-2xs"
                      placeholder="/path/to/project"
                      onKeyDown={(e) => e.stopPropagation()}
                    />
                  </TextField>
                </form>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <Show when={actionErr()}>
            <p class="truncate font-mono text-2xs text-destructive" title={actionErr()}>
              {actionErr()}
            </p>
          </Show>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto border-t border-border px-1.5 py-1">
          {/* Compare is a mode of the list and it says so at the top of the
              list. The hint used to live inside the connect panel, so entering
              compare mode from anywhere else showed nothing at all: the rows
              simply stopped opening, with no sign of what had changed. */}
          <Show when={compareOn()}>
            <div class="mb-1.5 flex items-center gap-2 rounded-md bg-secondary/40 px-2 py-1.5">
              <Icon name="columns" class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 text-2xs text-muted-foreground">
                {compareSel().length < 2
                  ? t("sidebar.compare.pick", { n: 2 - compareSel().length })
                  : t("sidebar.compare.openTip")}
              </span>
              <button
                type="button"
                class="shrink-0 text-2xs text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => {
                  setCompareOn(false);
                  setCompareSel([]);
                }}
              >
                {t("sidebar.compare.cancel")}
              </button>
            </div>
          </Show>
          <For
            each={groups()}
            fallback={
              <p class="px-2 py-8 text-center text-xs text-muted-foreground">
                {data.error
                  ? explain(data.error)
                  : settled(data)
                    ? t("sidebar.empty.inProject")
                    : t("sidebar.empty.needBackend")}
              </p>
            }
          >
            {(group) => (
              <section class="mb-2">
                <h2 class="flex items-baseline gap-2 px-2 pt-3 pb-1" title={group.hint}>
                  <span class="shrink-0 text-2xs font-medium text-muted-foreground">
                    {group.label}
                  </span>
                  <Show when={group.hint}>
                    <span class="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground/80">
                      {group.hint}
                    </span>
                  </Show>
                  <span class="ml-auto font-mono text-2xs text-muted-foreground/70 tabular-nums">
                    {group.rows.length}
                  </span>
                </h2>
                <For each={group.rows}>
                  {(s) => {
                    const id = s.summary.session_id;
                    return (
                      <SessionListItem
                        id={id}
                        title={s.title ?? s.summary.title ?? t("common.untitled")}
                        active={activeId() === id || compareSel().includes(id)}
                        busy={s.busy === true}
                        needsInput={s.needs_input === true}
                        time={relTime(s.summary.last_ts, clock())}
                        actions={!compareOn()}
                        onOpen={() => openSession(id)}
                        onRename={(title) => runAction(id, () => renameSession(id, title), false)}
                        onArchive={() => runAction(id, () => archiveSession(id), true)}
                        onDelete={() => runAction(id, () => deleteSession(id), true)}
                        onCompare={() => startCompare(id)}
                        instance={instanceOf(s)}
                      />
                    );
                  }}
                </For>
              </section>
            )}
          </For>
        </div>
        <div class="border-t border-border px-2 py-1.5">
          <Show when={connOpen()}>
            <div class="mb-1.5 space-y-1.5 px-1">
              <div class="flex gap-1">
                <Button
                  size="sm"
                  variant={connKind() === "opencode" ? "secondary" : "ghost"}
                  class="h-7 flex-1 text-2xs"
                  onClick={() => setConnKind("opencode")}
                >
                  {t("connect.kind.opencode")}
                </Button>
                <Button
                  size="sm"
                  variant={connKind() === "acp" ? "secondary" : "ghost"}
                  class="h-7 flex-1 text-2xs"
                  onClick={() => setConnKind("acp")}
                >
                  {t("connect.kind.acp")}
                </Button>
              </div>
              <Show
                when={connKind() === "acp"}
                fallback={
                  <>
                    <TextField value={connUrl()} onChange={setConnUrl} class="gap-0">
                      <TextFieldInput
                        class="h-8 bg-background font-mono text-2xs"
                        placeholder="http://127.0.0.1:4096"
                      />
                    </TextField>
                    <div class="flex gap-1.5">
                      <TextField value={connName()} onChange={setConnName} class="w-1/3 gap-0">
                        <TextFieldInput class="h-8 bg-background px-2 text-2xs" placeholder={t("connect.form.name")} />
                      </TextField>
                      <TextField value={connUser()} onChange={setConnUser} class="w-1/3 gap-0">
                        <TextFieldInput
                          class="h-8 bg-background px-2 text-2xs"
                          placeholder={t("connect.form.user")}
                        />
                      </TextField>
                      <TextField value={connPass()} onChange={setConnPass} class="w-1/3 gap-0">
                        <TextFieldInput
                          type="password"
                          class="h-8 bg-background px-2 text-2xs"
                          placeholder={t("connect.form.password")}
                        />
                      </TextField>
                    </div>
                  </>
                }
              >
                <TextField value={connCmd()} onChange={setConnCmd} class="gap-0">
                  <TextFieldInput
                    class="h-8 bg-background font-mono text-2xs"
                    placeholder={t("connect.form.command")}
                  />
                </TextField>
                <TextField value={connName()} onChange={setConnName} class="gap-0">
                  <TextFieldInput class="h-8 bg-background px-2 text-2xs" placeholder={t("connect.form.name")} />
                </TextField>
              </Show>
              <Button
                class="h-8 w-full"
                disabled={connecting() || !(connKind() === "acp" ? connCmd().trim() : connUrl().trim())}
                onClick={() => void connect()}
              >
                {connecting() ? t("action.connecting") : t("action.connect")}
              </Button>
            </div>
          </Show>
          <Show when={connErr()}>
            <p class="mb-1 px-1.5 font-mono text-2xs text-destructive">{connErr()}</p>
          </Show>
          <div class="flex items-center gap-1">
            <div class="min-w-0 flex-1">
              <Show
                when={(settled(conns)?.connections.length ?? 0) > 0}
                fallback={
                  <div class="min-w-0 px-1.5 py-1">
                    <p class="truncate text-xs text-muted-foreground">
                      {backendMissing() ? t("sidebar.backend.missing") : t("sidebar.backend.none")}
                    </p>
                    <Show when={backendMissing()}>
                      <a
                        href="https://opencode.ai"
                        target="_blank"
                        rel="noreferrer"
                        class="mt-0.5 block text-2xs text-muted-foreground hover:text-foreground"
                      >
                        {t("settings.opencode.install")}
                      </a>
                    </Show>
                  </div>
                }
              >
                <For each={settled(conns)?.connections ?? []}>
                  {(c) => (
                    <button
                      type="button"
                      class="flex w-full items-center gap-2 truncate rounded-md px-1.5 py-1 text-left text-xs hover:bg-secondary"
                      title={c.baseUrl}
                      onClick={() => chooseNewConn(c.id)}
                    >
                      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-status-active" />
                      <span class="truncate">
                        {backendLabel(c.backend)}
                        <span class="font-mono text-2xs text-muted-foreground">
                          {" "}
                          · {endpointHost(c.baseUrl)}
                        </span>
                      </span>
                      <Show when={(settled(conns)?.connections.length ?? 0) > 1 && newSessionConnection() === c.id}>
                        <span class="ml-auto shrink-0 text-2xs text-muted-foreground">
                          {t("sidebar.backend.newTarget")}
                        </span>
                      </Show>
                    </button>
                  )}
                </For>
              </Show>
            </div>
            <Show when={compareSel().length === 2}>
              <Tip label={t("sidebar.compare.openTip")}>
                <Button
                  size="sm"
                  onClick={() => {
                    const [a, b] = compareSel();
                    location.hash = `/compare/${encodeURIComponent(a!)}/${encodeURIComponent(b!)}`;
                    setCompareOn(false);
                    setCompareSel([]);
                  }}
                >
                  {t("sidebar.compare.open")}
                </Button>
              </Tip>
            </Show>
            <DropdownMenu placement="top-end">
              <DropdownMenuTrigger
                class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
                aria-label={t("sidebar.menu.more")}
              >
                ···
              </DropdownMenuTrigger>
              <DropdownMenuContent class="min-w-52">
                <DropdownMenuItem onSelect={() => (location.hash = "/settings")}>
                  <Icon name="gear" class="size-3.5 text-muted-foreground" />
                  {t("settings.title")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {/* One row to open the panel, one row per live connection to
                    close it. A "disconnect all" beside a list of per-host
                    disconnects was two ways to do one thing, and the pair had
                    to be read together to know which one the menu meant. */}
                <DropdownMenuItem onSelect={() => setConnOpen((v) => !v)}>
                  <Icon name="link" class="size-3.5 text-muted-foreground" />
                  {connOpen() ? t("action.closeConnect") : t("action.connectBackend")}
                </DropdownMenuItem>
                <For each={settled(conns)?.connections ?? []}>
                  {(c) => (
                    <DropdownMenuItem
                      onSelect={() =>
                        void disconnectBackend(c.id).then(() => {
                          refetchConns();
                          window.dispatchEvent(new Event("strata-connections"));
                        })
                      }
                    >
                      <Icon name="plug" class="size-3.5 text-muted-foreground" />
                      {t("sidebar.menu.disconnect", { host: endpointHost(c.baseUrl) })}
                    </DropdownMenuItem>
                  )}
                </For>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </aside>

      <main class="relative min-w-0 flex-1">
        <Show when={route().name === "fleet"}>
          <PageShell title={currentDir() ?? t("fleet.scope.all")}>
            <Show
              when={connected()}
              fallback={
                <div class="mx-auto flex max-w-sm flex-col items-start px-8 pt-24">
                  <p class="text-sm font-medium text-foreground">
                    {t("action.connectBackend")}
                  </p>
                  <p class="mt-1.5 text-sm leading-5 text-muted-foreground">
                    {t("fleet.hint.disconnected")}
                  </p>
                  <Button class="mt-5" onClick={() => setConnOpen(true)}>
                    {t("action.connect")}
                  </Button>
                </div>
              }
            >
              <FleetOverview sessions={sessions()} onOpen={openSession} now={clock()} />
            </Show>
          </PageShell>
        </Show>
        <Show when={route().name === "session" ? (route() as { id: string }).id : undefined} keyed>
          {(id) => <SessionDetail id={id} sessions={settled(data)?.sessions ?? []} />}
        </Show>
        <Show when={route().name === "compare"}>
          <PageShell
            title={t("nav.compare")}
            back={{ href: "/", label: t("nav.backToFleet") }}
          >
            <CompareView
              a={(route() as { a: string }).a}
              b={(route() as { b: string }).b}
            />
          </PageShell>
        </Show>
        <Show when={route().name === "settings"}>
          <PageShell title={t("settings.title")}>
            <SettingsPage section={(route() as { section?: string }).section} />
          </PageShell>
        </Show>
      </main>
      </div>
      <CommandPalette
        open={paletteOpen()}
        sessions={sessions().map((s) => ({
          id: s.summary.session_id,
          title: s.title || s.summary.title || t("common.untitled"),
        }))}
        onOpenSession={(id) => {
          location.hash = `/session/${encodeURIComponent(id)}`;
        }}
        onClose={() => setPaletteOpen(false)}
      />
      <SessionSwitcher
        open={switchOpen()}
        rows={switchIds().map((id) => ({
          id,
          title: switchSource().find((row) => row.id === id)?.title ?? t("common.untitled"),
        }))}
        at={switchAt()}
        currentId={activeId()}
        onChoose={chooseSwitch}
        onCancel={() => setSwitchOpen(false)}
      />
    </div>
  );
}
