import { createEffect, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  api,
  archiveSession,
  connectBackend,
  deleteSession,
  disconnectBackend,
  fmtUsd,
  getJson,
  realWorkspace,
  renameSession,
  type Connection,
  type SessionRow,
  type SessionsResponse,
  type StrataEvent,
} from "./api";
import { SessionDetail } from "./session-detail";
import { CompareView } from "./compare";
import { PolicyEditor } from "./policy";
import { Icon } from "./icons";
import { inDesktopShell } from "./shell";

type Route =
  | { name: "fleet" }
  | { name: "session"; id: string }
  | { name: "compare"; a: string; b: string }
  | { name: "policy" };

function parseHash(): Route {
  const h = location.hash.slice(1);
  const s = h.match(/^\/session\/(.+)$/);
  if (s) return { name: "session", id: decodeURIComponent(s[1]!) };
  const c = h.match(/^\/compare\/([^/]+)\/(.+)$/);
  if (c) return { name: "compare", a: decodeURIComponent(c[1]!), b: decodeURIComponent(c[2]!) };
  if (h === "/policy") return { name: "policy" };
  return { name: "fleet" };
}

function relTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const mins = Math.round((now - t) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours}h`;
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const WS_KEY = "strata.workspace";
const ALL = "__all__";

function baseName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function SessionListItem(props: {
  id: string;
  title: string;
  active: boolean;
  busy: boolean;
  time: string;
  timeTitle: string;
  actions: boolean;
  onOpen: () => void;
  onRename: (title: string) => Promise<void>;
  onArchive: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal(props.title);
  const [armed, setArmed] = createSignal(false);
  const [hot, setHot] = createSignal(false);
  let input: HTMLInputElement | undefined;
  const showActions = () => props.actions && (hot() || props.active || armed() || editing());

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
      class={`group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors ${
        props.active ? "bg-accent text-foreground" : "text-foreground/80 hover:bg-secondary/70"
      }`}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      onClick={() => {
        if (editing()) return;
        props.onOpen();
      }}
      onKeyDown={(e) => {
        if (editing()) return;
        if (e.key === "Enter") props.onOpen();
      }}
    >
      <Show when={props.busy}>
        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-status-active" />
      </Show>
      <Show
        when={editing()}
        fallback={<span class="min-w-0 flex-1 truncate text-[13px]">{props.title}</span>}
      >
        <input
          ref={(el) => {
            input = el;
            el.focus();
            el.select();
          }}
          class="min-w-0 flex-1 rounded bg-background px-1 py-0.5 text-[13px] focus:outline-none"
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
      <Show
        when={showActions() && !editing()}
        fallback={
          <span
            class="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums"
            title={props.timeTitle}
          >
            {props.time}
          </span>
        }
      >
        <span class="flex shrink-0 items-center">
          <button
            class="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
            title="Rename"
            aria-label="Rename"
            onClick={(e) => {
              e.stopPropagation();
              setArmed(false);
              setDraft(props.title);
              setEditing(true);
            }}
          >
            <Icon name="pencil" class="h-3.5 w-3.5" />
          </button>
          <button
            class="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
            title="Archive"
            aria-label="Archive"
            onClick={(e) => {
              e.stopPropagation();
              void props.onArchive();
            }}
          >
            <Icon name="archive" class="h-3.5 w-3.5" />
          </button>
          <button
            class={`grid h-6 w-6 place-items-center rounded hover:bg-background ${
              armed() ? "text-destructive" : "text-muted-foreground hover:text-foreground"
            }`}
            title={armed() ? "Confirm delete" : "Delete"}
            aria-label={armed() ? "Confirm delete" : "Delete"}
            onClick={(e) => {
              e.stopPropagation();
              if (!armed()) {
                setArmed(true);
                return;
              }
              void props.onDelete();
            }}
          >
            <Icon name="trash" class="h-3.5 w-3.5" />
          </button>
        </span>
      </Show>
    </div>
  );
}

function eventPreview(e: StrataEvent): string {
  const d = e.data;
  const blocks = (d.content ?? d.output) as unknown;
  if (Array.isArray(blocks))
    return blocks
      .map((b) =>
        typeof b === "object" && b !== null
          ? String((b as { text?: string }).text ?? `[${(b as { type?: string }).type}]`)
          : String(b),
      )
      .join(" ")
      .slice(0, 160);
  if (typeof blocks === "string") return blocks.slice(0, 160);
  if (d.tool) return `${String(d.tool)} ${JSON.stringify(d.input ?? "").slice(0, 80)}`;
  if (d.title) return String(d.title);
  return JSON.stringify(d).slice(0, 160);
}

export function App() {
  const [route, setRoute] = createSignal<Route>(parseHash());
  const [clock, setClock] = createSignal(Date.now());
  const [data, { refetch }] = createResource(() => getJson<SessionsResponse>("/sessions"));
  const [conns, { refetch: refetchConns }] = createResource(() =>
    getJson<{ connections: Connection[] }>("/connections"),
  );
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
  const [connUser, setConnUser] = createSignal("");
  const [connPass, setConnPass] = createSignal("");
  const [connErr, setConnErr] = createSignal("");
  const [connecting, setConnecting] = createSignal(false);
  const [compareOn, setCompareOn] = createSignal(false);
  const [compareSel, setCompareSel] = createSignal<string[]>([]);
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
    const clockTimer = setInterval(() => setClock(Date.now()), 30_000);
    const es = new EventSource(api("/stream"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    es.onmessage = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        refetch();
        void refetchWs();
      }, 200);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
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
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("keydown", onKey);
      clearInterval(clockTimer);
      clearTimeout(timer);
      es.close();
    });
  });

  const connect = async () => {
    setConnErr("");
    setConnecting(true);
    try {
      await connectBackend({
        baseUrl: connUrl().trim(),
        name: connName().trim() || undefined,
        username: connUser() || undefined,
        password: connPass() || undefined,
      });
      setConnOpen(false);
      refetchConns();
      refetch();
      window.dispatchEvent(new Event("strata-connections"));
    } catch (e) {
      setConnErr(e instanceof Error ? e.message : String(e));
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
    const row = (data()?.sessions ?? []).find(
      (s) => !s.parent && !s.archived && !s.deleted && realWorkspace(s.workspace ?? s.summary.workspace),
    );
    const ws = realWorkspace(row?.workspace ?? row?.summary.workspace);
    if (ws) chooseWorkspace(ws);
  });

  const newSession = async () => {
    const res = await fetch(api("/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: currentDir() }),
    });
    const body = (await res.json()) as { id?: string; error?: string };
    if (body.id) {
      refetch();
      location.hash = `/session/${encodeURIComponent(body.id)}`;
    } else {
      setConnErr(body.error ?? "could not create a session");
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

  const sessionWorkspace = (s: SessionRow) => realWorkspace(s.workspace ?? s.summary.workspace);

  const sessions = () => {
    const q = query().trim().toLowerCase();
    const rows = (data()?.sessions ?? []).filter((s) => !s.parent && !s.archived && !s.deleted);
    const dir = currentDir();
    const scoped = dir ? rows.filter((s) => sessionWorkspace(s) === dir) : rows;
    if (!q) return scoped;
    return scoped.filter((s) => {
      const title = (s.title ?? s.summary.title ?? s.summary.session_id).toLowerCase();
      const ws = (sessionWorkspace(s) ?? "").toLowerCase();
      return title.includes(q) || ws.includes(q);
    });
  };

  const workspaceOptions = () => {
    const map = new Map<string, string>();
    const cur = currentDir();
    if (cur) map.set(cur, baseName(cur));
    for (const w of wsList()?.workspaces ?? []) {
      if (w.directory) map.set(w.directory, w.name || baseName(w.directory));
    }
    for (const s of data()?.sessions ?? []) {
      const ws = sessionWorkspace(s);
      if (ws && !map.has(ws)) map.set(ws, baseName(ws));
    }
    return [...map.entries()].map(([directory, name]) => ({ directory, name }));
  };

  const groups = () => {
    const rows = sessions();
    if (rows.length === 0) return [] as [string, SessionRow[]][];
    if (currentDir()) return [["", rows] as [string, SessionRow[]]];
    const byWs = new Map<string, SessionRow[]>();
    for (const s of rows) {
      const ws = sessionWorkspace(s) ?? "no workspace";
      byWs.set(ws, [...(byWs.get(ws) ?? []), s]);
    }
    return [...byWs.entries()];
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
  const connected = () => (conns()?.connections.length ?? 0) > 0;

  return (
    <div class="flex h-full min-h-0 bg-background">
      <aside class="flex w-[272px] shrink-0 flex-col border-r border-border bg-card/50">
        <div
          class={`flex h-12 items-center gap-2 pr-3 ${inDesktopShell() ? "pl-[76px]" : "px-3"}`}
          data-tauri-drag-region
        >
          <button
            class="text-sm font-semibold tracking-tight"
            onClick={() => (location.hash = "/")}
          >
            strata
          </button>
          <button
            class="ml-auto grid h-7 w-7 place-items-center rounded-md text-lg leading-none text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            title={connected() ? "new session" : "connect a backend"}
            onClick={() => {
              if (!connected()) {
                setConnOpen(true);
                return;
              }
              void newSession();
            }}
          >
            +
          </button>
        </div>
        <div class="relative px-2 pb-1">
          <button
            class={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-secondary ${
              wsOpen() ? "bg-secondary" : ""
            }`}
            title={currentDir() ?? "All workspaces"}
            onClick={() => setWsOpen((v) => !v)}
          >
            <Icon name="folder" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate text-[13px]">
              {currentDir() ? baseName(currentDir()!) : "All"}
            </span>
          </button>
          <Show when={wsOpen()}>
            <button
              class="fixed inset-0 z-10 cursor-default"
              aria-label="Close"
              onClick={() => setWsOpen(false)}
            />
            <div class="absolute left-2 right-2 z-20 mt-1 rounded-md border border-border bg-card p-1 shadow-lg">
              <button
                class={`flex w-full items-center rounded px-2 py-1.5 text-left text-[13px] hover:bg-secondary ${
                  !currentDir() ? "text-foreground" : "text-muted-foreground"
                }`}
                onClick={() => chooseWorkspace(ALL)}
              >
                All
              </button>
              <For each={workspaceOptions()}>
                {(w) => (
                  <button
                    class={`flex w-full items-center rounded px-2 py-1.5 text-left text-[13px] hover:bg-secondary ${
                      currentDir() === w.directory ? "text-foreground" : "text-foreground/80"
                    }`}
                    title={w.directory}
                    onClick={() => chooseWorkspace(w.directory)}
                  >
                    <span class="truncate">{w.name}</span>
                  </button>
                )}
              </For>
              <form
                class="mt-1 border-t border-border pt-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  const path = wsDraft().trim();
                  if (path) chooseWorkspace(path);
                }}
              >
                <input
                  class="w-full rounded bg-secondary/70 px-2 py-1 font-mono text-[11px] focus:outline-none"
                  placeholder="/path/to/project"
                  value={wsDraft()}
                  onInput={(e) => setWsDraft(e.currentTarget.value)}
                />
              </form>
            </div>
          </Show>
        </div>
        <div class="px-3 pb-2">
          <input
            class="w-full rounded-md border border-transparent bg-secondary/70 px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none"
            placeholder="Search"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              }
            }}
          />
          <Show when={actionErr()}>
            <p class="mt-1 truncate font-mono text-[10px] text-destructive" title={actionErr()}>
              {actionErr()}
            </p>
          </Show>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <For
            each={groups()}
            fallback={
              <p class="px-2 py-6 text-xs text-muted-foreground">
                {query().trim()
                  ? "no matching sessions"
                  : data()
                    ? "no sessions yet"
                    : "connect a backend to see sessions"}
              </p>
            }
          >
            {([ws, rows]) => (
              <section class="mb-3">
                <Show when={realWorkspace(ws)}>
                  <h2 class="truncate px-2 py-1 font-mono text-[10px] text-muted-foreground">{ws}</h2>
                </Show>
                <For each={rows}>
                  {(s) => {
                    const id = s.summary.session_id;
                    return (
                      <SessionListItem
                        id={id}
                        title={s.title ?? s.summary.title ?? "untitled"}
                        active={activeId() === id || compareSel().includes(id)}
                        busy={s.busy === true}
                        time={relTime(s.summary.last_ts, clock())}
                        timeTitle={new Date(s.summary.last_ts).toLocaleString()}
                        actions={!compareOn()}
                        onOpen={() => openSession(id)}
                        onRename={(title) => runAction(id, () => renameSession(id, title), false)}
                        onArchive={() => runAction(id, () => archiveSession(id), true)}
                        onDelete={() => runAction(id, () => deleteSession(id), true)}
                      />
                    );
                  }}
                </For>
              </section>
            )}
          </For>
        </div>
        <div class="border-t border-border p-3">
          <div class="flex flex-wrap items-center gap-1.5">
            <For each={conns()?.connections ?? []}>
              {(c) => (
                <span class="flex max-w-full items-center gap-1.5 rounded-full bg-secondary px-2 py-0.5 text-[11px]">
                  <span class="h-1.5 w-1.5 rounded-full bg-status-active" />
                  <span class="truncate">{c.name ?? c.baseUrl}</span>
                  <button
                    class="text-muted-foreground hover:text-destructive"
                    title="disconnect"
                    onClick={() =>
                      void disconnectBackend(c.id).then(() => {
                        refetchConns();
                        window.dispatchEvent(new Event("strata-connections"));
                      })
                    }
                  >
                    ×
                  </button>
                </span>
              )}
            </For>
          </div>
          <Show when={connOpen()}>
            <div class="mt-2 space-y-1.5">
              <input
                class="w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-[11px] focus:border-ring focus:outline-none"
                placeholder="http://127.0.0.1:4096"
                value={connUrl()}
                onInput={(e) => setConnUrl(e.currentTarget.value)}
              />
              <div class="flex gap-1.5">
                <input
                  class="w-1/3 rounded-md border border-input bg-background px-2 py-1 text-[11px] focus:border-ring focus:outline-none"
                  placeholder="name"
                  value={connName()}
                  onInput={(e) => setConnName(e.currentTarget.value)}
                />
                <input
                  class="w-1/3 rounded-md border border-input bg-background px-2 py-1 text-[11px] focus:border-ring focus:outline-none"
                  placeholder="user"
                  value={connUser()}
                  onInput={(e) => setConnUser(e.currentTarget.value)}
                />
                <input
                  type="password"
                  class="w-1/3 rounded-md border border-input bg-background px-2 py-1 text-[11px] focus:border-ring focus:outline-none"
                  placeholder="password"
                  value={connPass()}
                  onInput={(e) => setConnPass(e.currentTarget.value)}
                />
              </div>
              <button
                class="w-full rounded-md bg-primary py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
                disabled={connecting() || !connUrl().trim()}
                onClick={() => void connect()}
              >
                {connecting() ? "connecting…" : "connect"}
              </button>
            </div>
          </Show>
          <Show when={connErr()}>
            <p class="mt-1.5 font-mono text-[10px] text-destructive">{connErr()}</p>
          </Show>
          <div class="mt-2 flex items-center gap-0.5">
            <button
              class={`grid h-7 w-7 place-items-center rounded-md hover:bg-secondary ${
                connOpen() ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
              title={connOpen() ? "Close" : "Connect"}
              aria-label={connOpen() ? "Close" : "Connect"}
              onClick={() => setConnOpen((v) => !v)}
            >
              <Icon name="link" />
            </button>
            <button
              class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
              title="Policy"
              aria-label="Policy"
              onClick={() => (location.hash = "/policy")}
            >
              <Icon name="shield" />
            </button>
            <button
              class={`grid h-7 w-7 place-items-center rounded-md hover:bg-secondary ${
                compareOn() ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
              title="Compare"
              aria-label="Compare"
              onClick={() => {
                setCompareOn((v) => !v);
                setCompareSel([]);
              }}
            >
              <Icon name="columns" />
            </button>
            <Show when={compareSel().length === 2}>
              <button
                class="ml-auto rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground"
                onClick={() => {
                  const [a, b] = compareSel();
                  location.hash = `/compare/${encodeURIComponent(a!)}/${encodeURIComponent(b!)}`;
                  setCompareOn(false);
                  setCompareSel([]);
                }}
              >
                open
              </button>
            </Show>
          </div>
        </div>
      </aside>

      <main class="min-w-0 flex-1">
        <Show when={route().name === "fleet"}>
          <div class="flex h-full flex-col">
            <div
              class="flex h-12 items-center border-b border-border px-6 text-xs text-muted-foreground"
              data-tauri-drag-region
            >
              <span>
                {(data()?.sessions.length ?? 0).toLocaleString()} sessions ·{" "}
                <span class="font-mono tabular-nums text-foreground">
                  {fmtUsd(data()?.aggregate.total.cost_usd ?? 0)}
                </span>
              </span>
            </div>
            <div class="min-h-0 flex-1 overflow-y-auto">
              <Show
                when={query().trim()}
                fallback={
                  <div class="mx-auto flex max-w-md flex-col items-center px-6 pt-28 text-center">
                    <p class="text-lg font-medium">
                      {connected() ? "Pick a session" : "Connect OpenCode"}
                    </p>
                    <p class="mt-2 text-sm text-muted-foreground">
                      {connected()
                        ? "Sessions already on the server show up in the sidebar. New ones start with +."
                        : "Point strata at an opencode serve URL. Existing sessions are indexed as soon as the stream attaches."}
                    </p>
                    <button
                      class="mt-5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
                      onClick={() => (connected() ? void newSession() : setConnOpen(true))}
                    >
                      {connected() ? "new session" : "connect"}
                    </button>
                  </div>
                }
              >
                <Show
                  when={!results.loading && (results()?.length ?? 0) === 0}
                  fallback={
                    <div class="mx-auto max-w-2xl py-4">
                      <For each={results() ?? []}>
                    {(e) => (
                      <button
                        class="block w-full px-4 py-2.5 text-left hover:bg-secondary/50"
                        onClick={() => (location.hash = `/session/${encodeURIComponent(e.session_id)}`)}
                      >
                        <div class="flex items-center gap-2 text-[11px]">
                          <span class="font-mono text-event-tool">{e.type}</span>
                          <span class="ml-auto font-mono text-muted-foreground tabular-nums">
                            {e.ts.slice(0, 16).replace("T", " ")}
                          </span>
                        </div>
                        <div class="mt-0.5 truncate text-sm text-foreground/85">{eventPreview(e)}</div>
                      </button>
                    )}
                  </For>
                    </div>
                  }
                >
                  <div class="mx-auto flex max-w-md flex-col items-center px-6 pt-28 text-center">
                    <p class="text-lg font-medium">No matches</p>
                    <p class="mt-2 text-sm text-muted-foreground">
                      Nothing in the event log matches{" "}
                      <span class="font-mono text-foreground">{query().trim()}</span>.
                    </p>
                  </div>
                </Show>
              </Show>
            </div>
          </div>
        </Show>
        <Show when={route().name === "session" ? (route() as { id: string }).id : undefined} keyed>
          {(id) => <SessionDetail id={id} />}
        </Show>
        <Show when={route().name === "compare"}>
          <div class="h-full overflow-y-auto">
            <CompareView
              a={(route() as { a: string }).a}
              b={(route() as { b: string }).b}
              back={() => (location.hash = "/")}
            />
          </div>
        </Show>
        <Show when={route().name === "policy"}>
          <div class="h-full overflow-y-auto">
            <PolicyEditor back={() => (location.hash = "/")} />
          </div>
        </Show>
      </main>
    </div>
  );
}
