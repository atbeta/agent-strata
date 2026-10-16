import { createEffect, createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import { api, getJson, realWorkspace, syncBackend, type StrataEvent } from "./api";
import { settled } from "./resource";
import { projectName } from "./fleet";
import { FleetView } from "./fleet-view";
import { SessionDetail } from "./session-detail";
import { CompareView } from "./compare";
import { SettingsPage } from "./settings";
import { applyTheme, readTheme } from "./theme";
import { applyFonts, readFonts } from "./font";
import { commandForChord, registerCommand } from "./commands";
import { CommandPalette } from "./palette";
import { SessionSwitcher } from "./switcher";
import { PageShell, WindowCaptionBar } from "./chrome";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { t } from "./i18n";
import { isStreamingSnapshotMessage } from "./live";
import { parseHash, type Route } from "./routes";
import { explain } from "./errors";
import { useSessionList } from "./use-session-list";
import { useConnections } from "./use-connections";
import { useWorkspace } from "./use-workspace";
import { useSessionSwitcher } from "./use-switcher";
import { Sidebar } from "./sidebar";

export function App() {
  const [route, setRoute] = createSignal<Route>(parseHash());
  const [clock, setClock] = createSignal(Date.now());
  const activeId = () => {
    const r = route();
    return r.name === "session" ? r.id : undefined;
  };

  const ws = useWorkspace();
  const list = useSessionList({ dir: ws.currentDir, clock, activeId });
  const conns = useConnections({ currentDir: ws.currentDir, onChanged: () => list.refetch() });

  const [query, setQuery] = createSignal("");
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

  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [compareOn, setCompareOn] = createSignal(false);
  const [compareSel, setCompareSel] = createSignal<string[]>([]);
  let chordHeld = false;
  const switcher = useSessionSwitcher({
    sessions: () => list.sessions(),
    activeId,
    exists: (id) => list.library().some((s) => s.summary.session_id === id),
    chordHeld: () => chordHeld,
  });

  // First run with no stored pick: scope to wherever sessions already live.
  createEffect(() => {
    if (ws.workspace() !== null) return;
    const row = (settled(list.data)?.sessions ?? []).find(
      (s) => !s.parent && !s.archived && !s.deleted && realWorkspace(s.workspace ?? s.summary.workspace),
    );
    const dir = realWorkspace(row?.workspace ?? row?.summary.workspace);
    if (dir) ws.chooseWorkspace(dir);
  });

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
          list.refetch();
          conns.refetchConns();
          void ws.refetchWs();
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
        const evt = JSON.parse(m.data) as {
          type?: string;
          connection_id?: string;
          done?: number;
          total?: number;
        };
        // Sync ticks update the progress strip and nothing else; the session.*
        // events a sync produces already drive the refetch.
        if (evt.type?.startsWith("sync.")) {
          conns.onSyncEvent(evt);
          return;
        }
        if (evt.type === "session.started" || evt.type === "session.updated" || evt.type === "session.deleted") wsStale = true;
      } catch {
        // heartbeats
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        list.refetch();
        conns.refetchConns();
        if (wsStale) {
          wsStale = false;
          void ws.refetchWs();
        }
      }, 200);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (switcher.switchOpen() && e.key === "Escape") {
        switcher.setSwitchOpen(false);
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
        if (cmd.id !== "app.nextSession" && cmd.id !== "app.prevSession") switcher.setSwitchOpen(false);
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
      if (ws.wsOpen()) {
        ws.setWsOpen(false);
        e.preventDefault();
        return;
      }
      if (conns.connOpen()) {
        conns.setConnOpen(false);
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Control" && e.key !== "Meta") return;
      switcher.commitSwitch();
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
    /**
     * The webview's own menu is a browser's — back, reload, inspect — and
     * none of it means anything here, so it is suppressed everywhere. Editable
     * text keeps it: the system edit menu there (cut, copy, paste, select all)
     * is real functionality the web cannot faithfully re-create. Surfaces
     * with actual row actions own a ContextMenu trigger instead, which opens
     * before this bubbling handler runs.
     */
    const onContextMenu = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.("input, textarea, select, [contenteditable='true'], [data-native-contextmenu]"))
        return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu);
    onCleanup(() => {
      scheme.removeEventListener("change", onScheme);
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("dragover", onFileDrag);
      window.removeEventListener("drop", onFileDrag);
      window.removeEventListener("contextmenu", onContextMenu);
      clearInterval(clockTimer);
      clearInterval(syncTimer);
      clearTimeout(timer);
      conns.clearSyncGrace();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      es.close();
    });
  });

  const newSession = async () => {
    list.setActionErr("");
    try {
      const res = await fetch(api("/sessions"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory: ws.currentDir(), connection_id: conns.newSessionConnection() }),
      });
      const body = (await res.json()) as { id?: string; error?: string };
      if (body.id) {
        list.refetch();
        location.hash = `/session/${encodeURIComponent(body.id)}`;
      } else {
        conns.setConnErr(body.error ?? t("error.createSession"));
        conns.setConnOpen(true);
      }
    } catch (e) {
      // Reached from `void newSession()`, so a rejection here had nowhere to
      // go: the click did nothing, said nothing, and looked broken. A service
      // that is not answering is the usual reason, and it deserves to be seen.
      list.setActionErr(explain(e));
    }
  };

  const requestNewSession = () => {
    if (!conns.connected()) {
      conns.setConnOpen(true);
      return;
    }
    void newSession();
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

  /** The overview is a place, not a moment before the first click. */
  const openFleet = () => {
    setCompareOn(false);
    setCompareSel([]);
    location.hash = "/";
  };

  /** Enter compare mode with one session already chosen. With no id the user
   *  picks both, which is what the palette command does. */
  const startCompare = (id?: string) => {
    setCompareOn(true);
    setCompareSel(id ? [id] : []);
    if (id && location.hash !== "/") location.hash = "/";
  };

  const cancelCompare = () => {
    setCompareOn(false);
    setCompareSel([]);
  };

  const openCompare = () => {
    const [a, b] = compareSel();
    location.hash = `/compare/${encodeURIComponent(a!)}/${encodeURIComponent(b!)}`;
    cancelCompare();
  };

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
      run: requestNewSession,
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
      id: "app.fleet",
      title: () => t("fleet.nav"),
      run: () => openFleet(),
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
      enabled: () => list.sessions().length >= 2,
      run: () => switcher.moveSession(1),
    }),
  );
  onCleanup(
    registerCommand({
      id: "app.prevSession",
      title: () => t("switcher.prev"),
      chord: { key: "Tab", shift: true, repeat: true },
      enabled: () => list.sessions().length >= 2,
      run: () => switcher.moveSession(-1),
    }),
  );

  return (
    <div class="flex h-full min-h-0 flex-col bg-background">
      <WindowCaptionBar />
      <div class="flex min-h-0 flex-1">
      <Sidebar
        list={list}
        ws={ws}
        conns={conns}
        search={{
          open: searchOpen(),
          query: query(),
          events: settled(results),
          searching: results.loading,
          onOpenChange: (open) => {
            setSearchOpen(open);
            if (!open) setQuery("");
          },
          onQuery: setQuery,
          onOpenSession: openSession,
        }}
        fleetActive={route().name === "fleet"}
        compareOn={compareOn()}
        compareSel={compareSel()}
        onStartCompare={startCompare}
        onCancelCompare={cancelCompare}
        onOpenCompare={openCompare}
        activeId={activeId}
        clock={clock}
        onOpenSession={openSession}
        onNewSession={requestNewSession}
        onOpenFleet={openFleet}
      />

      <main class="@container/main relative min-w-0 flex-1">
        <Show when={route().name === "fleet"}>
          <PageShell
            title={ws.currentDir() ? projectName(ws.currentDir()!) : t("fleet.scope.all")}
            meta={
              ws.currentDir() ? (
                <span class="max-w-[28rem] truncate font-mono text-2xs text-muted-foreground" title={ws.currentDir()}>
                  {ws.currentDir()}
                </span>
              ) : undefined
            }
          >
            <Show
              when={conns.connected()}
              fallback={
                <Show
                  when={conns.attaching()}
                  fallback={
                    <div class="flex h-full items-center justify-center">
                      <EmptyState
                        icon="plug"
                        title={t("action.connectBackend")}
                        description={t("fleet.hint.disconnected")}
                        action={
                          <Button onClick={() => conns.setConnOpen(true)}>
                            {t("action.connect")}
                          </Button>
                        }
                      />
                    </div>
                  }
                >
                  <div class="flex h-full items-center justify-center">
                    <EmptyState
                      icon="plug"
                      title={t("action.attachingBackend")}
                      description={t("fleet.hint.connecting")}
                    />
                  </div>
                </Show>
              }
            >
              <FleetView
                sessions={list.sessions()}
                scoped={ws.currentDir() !== undefined}
                now={clock()}
                onOpen={openSession}
                onOpenProject={(dir) => ws.chooseWorkspace(dir)}
              />
            </Show>
          </PageShell>
        </Show>
        <Show when={route().name === "session"}>
          <SessionDetail
            id={(route() as { id: string }).id}
            sessions={settled(list.data)?.sessions ?? []}
          />
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
        sessions={list.sessions().map((s) => ({
          id: s.summary.session_id,
          title: s.title || s.summary.title || t("common.untitled"),
        }))}
        onOpenSession={(id) => {
          location.hash = `/session/${encodeURIComponent(id)}`;
        }}
        onClose={() => setPaletteOpen(false)}
      />
      <SessionSwitcher
        open={switcher.switchOpen()}
        rows={switcher.switchIds().map((id) => ({
          id,
          title: switcher.switchSource().find((row) => row.id === id)?.title ?? t("common.untitled"),
        }))}
        at={switcher.switchAt()}
        currentId={activeId()}
        onChoose={switcher.chooseSwitch}
        onCancel={() => switcher.setSwitchOpen(false)}
      />
    </div>
  );
}
