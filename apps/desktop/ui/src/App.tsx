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
  syncBackend,
  type Connection,
  type SessionRow,
  type SessionsResponse,
  type StrataEvent,
} from "./api";
import { SessionDetail } from "./session-detail";
import { CompareView } from "./compare";
import { PolicyEditor } from "./policy";
import { Icon } from "./icons";
import { DragBar } from "./chrome";
import { inDesktopShell, usesOverlayTrafficLights } from "./shell";
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

const TIME_BUCKETS = ["Today", "Yesterday", "Previous 7 days", "Older"] as const;

function dayBucket(iso: string, now: number): (typeof TIME_BUCKETS)[number] {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "Older";
  const start = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const diff = Math.round((start(now) - start(t)) / 86_400_000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return "Previous 7 days";
  return "Older";
}

const WS_KEY = "strata.workspace";
const ALL = "__all__";

function baseName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function projectName(path: string): string {
  if (path === "/" || path === "\\") return "Root";
  return baseName(path);
}

function projectHint(path: string): string {
  if (path === "/" || path === "\\") return "filesystem root";
  const parent = parentPath(path);
  return parent === path ? path : parent;
}

/** An errored Solid resource throws when read. Check first so one failed request cannot unmount the menu. */
function settled<T>(resource: { error: unknown; (): T | undefined }): T | undefined {
  return resource.error ? undefined : resource();
}

function explain(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === "Load failed" || msg === "Failed to fetch") return "Can't reach the strata service";
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
      class={`relative flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors ${
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
      <span
        class={`h-1.5 w-1.5 shrink-0 rounded-full ${props.busy ? "bg-status-active" : "bg-transparent"}`}
      />
      <Show
        when={editing()}
        fallback={<span class="min-w-0 flex-1 truncate pr-[4.75rem] text-[13px] leading-none">{props.title}</span>}
      >
        <input
          ref={(el) => {
            input = el;
            el.focus();
            el.select();
          }}
          class="min-w-0 flex-1 rounded bg-background px-1 py-0.5 text-[13px] leading-none focus:outline-none"
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
        <span
          class={`pointer-events-none absolute right-2 top-1/2 w-[4.5rem] -translate-y-1/2 text-right font-mono text-[10px] text-muted-foreground tabular-nums ${
            showActions() ? "invisible" : ""
          }`}
          title={props.timeTitle}
        >
          {props.time}
        </span>
        <span
          class={`absolute right-0.5 top-1/2 flex -translate-y-1/2 items-center ${
            showActions() ? "" : "invisible pointer-events-none"
          }`}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            title="Rename"
            aria-label="Rename"
            tabIndex={showActions() ? 0 : -1}
            onClick={(e) => {
              e.stopPropagation();
              setArmed(false);
              setDraft(props.title);
              setEditing(true);
            }}
          >
            <Icon name="pencil" class="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Archive"
            aria-label="Archive"
            tabIndex={showActions() ? 0 : -1}
            onClick={(e) => {
              e.stopPropagation();
              void props.onArchive();
            }}
          >
            <Icon name="archive" class="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            class={armed() ? "text-destructive" : ""}
            title={armed() ? "Confirm delete" : "Delete"}
            aria-label={armed() ? "Confirm delete" : "Delete"}
            tabIndex={showActions() ? 0 : -1}
            onClick={(e) => {
              e.stopPropagation();
              if (!armed()) {
                setArmed(true);
                return;
              }
              void props.onDelete();
            }}
          >
            <Icon name="trash" class="size-3.5" />
          </Button>
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
    const pull = () => {
      void syncBackend()
        .catch(() => {})
        .finally(() => {
          refetch();
          void refetchWs();
        });
    };
    pull();
    const syncTimer = setInterval(pull, 12_000);
    const onFocus = () => pull();
    window.addEventListener("focus", onFocus);
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
      clearInterval(syncTimer);
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
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
    const rows = (settled(data)?.sessions ?? []).filter((s) => !s.parent && !s.archived && !s.deleted);
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
          label: ws ? projectName(ws) : "No project",
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
      label: bucket,
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

  return (
    <div class="flex h-full min-h-0 bg-background">
      <aside class="flex w-[300px] shrink-0 flex-col border-r border-border bg-background">
        <div
          class={`flex h-11 shrink-0 items-center gap-2 border-b border-border pr-3 select-none ${
            usesOverlayTrafficLights() ? "pl-[76px]" : "px-3"
          }`}
          data-tauri-drag-region={inDesktopShell() ? "" : undefined}
        >
          <Button
            variant="ghost"
            class="h-7 px-1.5 text-sm font-semibold tracking-tight hover:bg-transparent"
            onClick={() => (location.hash = "/")}
          >
            strata
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            class="ml-auto text-lg leading-none text-muted-foreground"
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
          </Button>
        </div>
        <div class="flex flex-col gap-2 px-3 pb-3">
          <div>
            <p class="mb-1 px-0.5 text-[11px] font-medium text-muted-foreground">Project</p>
            <DropdownMenu open={wsOpen()} onOpenChange={setWsOpen} gutter={6}>
              <DropdownMenuTrigger
                class={cn(
                  "flex w-full items-center gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1.5 text-left transition-colors hover:bg-secondary",
                  wsOpen() && "bg-secondary",
                )}
                title={currentDir() ?? "All projects"}
              >
                <span class="grid size-7 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground">
                  <Icon name="folder" class="size-3.5" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[13px] font-medium leading-tight">
                    {currentDir() ? projectName(currentDir()!) : "All projects"}
                  </span>
                  <span class="block truncate font-mono text-[10px] leading-tight text-muted-foreground">
                    {currentDir() ? projectHint(currentDir()!) : `${sessions().length} sessions`}
                  </span>
                </span>
                <Icon
                  name="chevron"
                  class={cn("size-3.5 shrink-0 text-muted-foreground", wsOpen() && "rotate-180")}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent class="max-h-80 w-[276px] overflow-y-auto">
                <DropdownMenuItem
                  class={cn("flex-col items-start gap-0", !currentDir() && "bg-accent")}
                  onSelect={() => chooseWorkspace(ALL)}
                >
                  <span class="font-medium">All projects</span>
                  <span class="text-[10px] text-muted-foreground">Every directory on this connection</span>
                </DropdownMenuItem>
                <For each={workspaceOptions()}>
                  {(w) => (
                    <DropdownMenuItem
                      class={cn("flex-col items-start gap-0", currentDir() === w.directory && "bg-accent")}
                      title={w.directory}
                      onSelect={() => chooseWorkspace(w.directory)}
                    >
                      <span class="w-full truncate">{projectName(w.directory)}</span>
                      <span class="w-full truncate font-mono text-[10px] text-muted-foreground">{w.directory}</span>
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
                    <TextFieldLabel class="text-[11px] font-medium text-muted-foreground">Open directory</TextFieldLabel>
                    <TextFieldInput
                      class="h-8 font-mono text-[11px]"
                      placeholder="/path/to/project"
                      onKeyDown={(e) => e.stopPropagation()}
                    />
                  </TextField>
                </form>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <TextField value={query()} onChange={setQuery} class="relative gap-0">
            <Icon
              name="search"
              class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <TextFieldInput
              class="h-8 pr-7 pl-8"
              placeholder="Search sessions"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                  e.currentTarget.blur();
                }
              }}
            />
            <Show when={query().trim()}>
              <Button
                variant="ghost"
                size="icon-sm"
                class="absolute top-1/2 right-0.5 -translate-y-1/2 text-muted-foreground"
                aria-label="Clear search"
                title="Clear search"
                onClick={() => setQuery("")}
              >
                ×
              </Button>
            </Show>
          </TextField>
          <Show when={actionErr()}>
            <p class="truncate font-mono text-[10px] text-destructive" title={actionErr()}>
              {actionErr()}
            </p>
          </Show>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto border-t border-border px-1.5 py-1">
          <For
            each={groups()}
            fallback={
              <p class="px-2 py-8 text-center text-xs text-muted-foreground">
                {query().trim()
                  ? "No sessions match this search."
                  : data.error
                    ? explain(data.error)
                    : settled(data)
                      ? "No sessions in this project yet."
                      : "Connect a backend to see sessions."}
              </p>
            }
          >
            {(group) => (
              <section class="mb-2">
                <h2 class="flex items-baseline gap-2 px-2 pt-3 pb-1" title={group.hint}>
                  <span class="shrink-0 text-[11px] font-medium text-muted-foreground">
                    {group.label}
                  </span>
                  <Show when={group.hint}>
                    <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground/80">
                      {group.hint}
                    </span>
                  </Show>
                  <span class="ml-auto font-mono text-[10px] text-muted-foreground/70 tabular-nums">
                    {group.rows.length}
                  </span>
                </h2>
                <For each={group.rows}>
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
            <For each={settled(conns)?.connections ?? []}>
              {(c) => (
                <span class="flex max-w-full items-center gap-1.5 rounded-full bg-secondary px-2 py-0.5 text-[11px]">
                  <span class="h-1.5 w-1.5 rounded-full bg-status-active" />
                  <span class="truncate">{c.name ?? c.baseUrl}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    class="size-4 text-muted-foreground hover:bg-transparent hover:text-destructive"
                    title="disconnect"
                    aria-label="Disconnect"
                    onClick={() =>
                      void disconnectBackend(c.id).then(() => {
                        refetchConns();
                        window.dispatchEvent(new Event("strata-connections"));
                      })
                    }
                  >
                    ×
                  </Button>
                </span>
              )}
            </For>
          </div>
          <Show when={connOpen()}>
            <div class="mt-2 space-y-1.5">
              <TextField value={connUrl()} onChange={setConnUrl} class="gap-0">
                <TextFieldInput
                  class="h-8 bg-background font-mono text-[11px]"
                  placeholder="http://127.0.0.1:4096"
                />
              </TextField>
              <div class="flex gap-1.5">
                <TextField value={connName()} onChange={setConnName} class="w-1/3 gap-0">
                  <TextFieldInput class="h-8 bg-background px-2 text-[11px]" placeholder="name" />
                </TextField>
                <TextField value={connUser()} onChange={setConnUser} class="w-1/3 gap-0">
                  <TextFieldInput class="h-8 bg-background px-2 text-[11px]" placeholder="user" />
                </TextField>
                <TextField value={connPass()} onChange={setConnPass} class="w-1/3 gap-0">
                  <TextFieldInput
                    type="password"
                    class="h-8 bg-background px-2 text-[11px]"
                    placeholder="password"
                  />
                </TextField>
              </div>
              <Button
                class="h-8 w-full"
                disabled={connecting() || !connUrl().trim()}
                onClick={() => void connect()}
              >
                {connecting() ? "connecting…" : "connect"}
              </Button>
            </div>
          </Show>
          <Show when={connErr()}>
            <p class="mt-1.5 font-mono text-[10px] text-destructive">{connErr()}</p>
          </Show>
          <div class="mt-2 flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              class={connOpen() ? "text-foreground" : "text-muted-foreground"}
              title={connOpen() ? "Close" : "Connect"}
              aria-label={connOpen() ? "Close" : "Connect"}
              onClick={() => setConnOpen((v) => !v)}
            >
              <Icon name="link" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-muted-foreground"
              title="Policy"
              aria-label="Policy"
              onClick={() => (location.hash = "/policy")}
            >
              <Icon name="shield" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              class={compareOn() ? "bg-secondary text-foreground" : "text-muted-foreground"}
              title="Compare"
              aria-label="Compare"
              onClick={() => {
                setCompareOn((v) => !v);
                setCompareSel([]);
              }}
            >
              <Icon name="columns" />
            </Button>
            <Show when={compareSel().length === 2}>
              <Button
                size="sm"
                class="ml-auto"
                onClick={() => {
                  const [a, b] = compareSel();
                  location.hash = `/compare/${encodeURIComponent(a!)}/${encodeURIComponent(b!)}`;
                  setCompareOn(false);
                  setCompareSel([]);
                }}
              >
                open
              </Button>
            </Show>
          </div>
        </div>
      </aside>

      <main class="min-w-0 flex-1">
        <Show when={route().name === "fleet"}>
          <div class="flex h-full flex-col">
            <DragBar class="text-[13px] text-muted-foreground">
              <span>
                {sessions().length.toLocaleString()}
                {currentDir() ? " in this project" : " sessions"} ·{" "}
                <span class="font-mono tabular-nums text-foreground">
                  {fmtUsd(settled(data)?.aggregate.total.cost_usd ?? 0)}
                </span>
              </span>
            </DragBar>
            <div class="min-h-0 flex-1 overflow-y-auto">
              <Show
                when={query().trim()}
                fallback={
                  <div class="mx-auto flex max-w-sm flex-col items-start px-8 pt-24">
                    <p class="text-sm font-medium text-foreground">
                      {connected() ? "Pick a session" : "Connect OpenCode"}
                    </p>
                    <p class="mt-1.5 text-[13px] leading-5 text-muted-foreground">
                      {connected()
                        ? "Sessions already on the server show up in the sidebar. New ones start with +."
                        : "Point strata at an opencode serve URL. Existing sessions are indexed as soon as the stream attaches."}
                    </p>
                    <Button
                      class="mt-5"
                      onClick={() => (connected() ? void newSession() : setConnOpen(true))}
                    >
                      {connected() ? "new session" : "connect"}
                    </Button>
                  </div>
                }
              >
                <Show
                  when={!results.loading && !results.error && (settled(results)?.length ?? 0) === 0}
                  fallback={
                    <div class="mx-auto max-w-2xl py-4">
                      <For each={settled(results) ?? []}>
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
          <div class="flex h-full min-h-0 flex-col">
            <DragBar>
              <button
                class="text-[13px] text-muted-foreground hover:text-foreground"
                onClick={() => (location.hash = "/")}
              >
                ← fleet
              </button>
              <span class="text-[13px] text-foreground">Compare</span>
            </DragBar>
            <div class="min-h-0 flex-1 overflow-y-auto">
              <CompareView
                a={(route() as { a: string }).a}
                b={(route() as { b: string }).b}
              />
            </div>
          </div>
        </Show>
        <Show when={route().name === "policy"}>
          <div class="flex h-full min-h-0 flex-col">
            <DragBar>
              <button
                class="text-[13px] text-muted-foreground hover:text-foreground"
                onClick={() => (location.hash = "/")}
              >
                ← fleet
              </button>
              <span class="text-[13px] text-foreground">Policy</span>
            </DragBar>
            <div class="min-h-0 flex-1 overflow-y-auto">
              <PolicyEditor />
            </div>
          </div>
        </Show>
      </main>
    </div>
  );
}
