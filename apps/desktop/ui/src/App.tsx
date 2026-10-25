import { createEffect, createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import { api, getJson, syncBackend, type StrataEvent } from "./api";
import { settled } from "./resource";
import { FleetView } from "./fleet-view";
import { SessionDetail } from "./session-detail";
import { CompareView } from "./compare";
import { SettingsPage } from "./settings";
import { applyTheme, readTheme } from "./theme";
import { applyFonts, readFonts } from "./font";
import { commandForChord, registerCommand } from "./commands";
import { CommandPalette } from "./palette";
import { SessionSwitcher } from "./switcher";
import { PageShell, TopLeftControls, WindowCaptionBar } from "./chrome";
import { canCollapseSidebar, usesCustomCaption } from "./shell";
import { readSidebarOpen, writeSidebarOpen } from "./sidebar-visibility";
import { t } from "./i18n";
import { displayTitle } from "./session-title";
import { isStreamingSnapshotMessage } from "./live";
import { parseHash, type Route } from "./routes";
import { explain } from "./errors";
import { useSessionList } from "./use-session-list";
import { ConnectionEmpty, useConnections } from "./use-connections";
import { useWorkspace } from "./use-workspace";
import { useSessionSwitcher } from "./use-switcher";
import { Sidebar } from "./sidebar";
import { installExternalLinkHandler } from "./external-open";
import { requestSearchTarget } from "./search-target";
import { installNotifyActions } from "./notify";
import { StartupGate } from "./startup-gate";
import { useStartup } from "./use-startup";
import { SyncLine } from "./sync-line";
import { changesSessionList, isDevEvent } from "./sync-events";

export function App() {
  const [route, setRoute] = createSignal<Route>(parseHash());
  const [clock, setClock] = createSignal(Date.now());
  const activeId = () => {
    const r = route();
    return r.name === "session" ? r.id : undefined;
  };

  const ws = useWorkspace();
  const list = useSessionList({
    extraDirs: () => ws.projectDirs(),
    keepDir: () => ws.lastDir() ?? undefined,
    clock,
    activeId,
  });
  const conns = useConnections({ currentDir: () => ws.lastDir() ?? undefined, onChanged: () => list.refetch() });
  const boot = useStartup({ conns, list, ws });
  /** A finished sync is the one moment the overview's usage buckets move. */
  const [usageKey, setUsageKey] = createSignal(1);

  /**
   * Where an undirected "+" lands: the session being read first — the eye is
   * already on that project — then the last place a session was made, then
   * whatever the list's most recent row belongs to.
   */
  const defaultDir = () => {
    const id = activeId();
    const row = id ? list.library().find((s) => s.summary.session_id === id) : undefined;
    if (row) {
      const dir = list.sessionWorkspace(row);
      if (dir) return dir;
    }
    const last = ws.lastDir();
    if (last) return last;
    for (const s of list.library()) {
      const dir = list.sessionWorkspace(s);
      if (dir) return dir;
    }
    return undefined;
  };

  /**
   * The overview's project rows aim the sidebar at a group rather than
   * navigate: there is no per-project page, and folding is the only focus the
   * list has. Cleared by the sidebar once consumed so the same project can be
   * pointed at twice.
   */
  const [focusDir, setFocusDir] = createSignal<string | undefined>(undefined);

  const [query, setQuery] = createSignal("");
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

  /**
   * Whether the left column is on screen.
   *
   * The switch that folds it away sits in the window's top-left corner and
   * not in the column: a button that folds the sidebar cannot live inside
   * the thing it folds. macOS keeps its traffic lights over that corner, so
   * there the column stays and only the palette moves up.
   */
  const [sidebarOpen, setSidebarOpen] = createSignal(
    canCollapseSidebar() ? readSidebarOpen() : true,
  );
  const toggleSidebar = () => {
    const next = !sidebarOpen();
    writeSidebarOpen(next);
    setSidebarOpen(next);
  };
  const openPalette = () => setPaletteOpen(true);

  let chordHeld = false;
  const switcher = useSessionSwitcher({
    sessions: () => list.sessions(),
    activeId,
    exists: (id) => list.library().some((s) => s.summary.session_id === id),
    chordHeld: () => chordHeld,
  });

  onMount(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    // Before anything else: a link clicked in the first frame must not be the
    // one that empties the window.
    const removeLinkHandler = installExternalLinkHandler();
    void installNotifyActions();
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
      // During launch the gate owns the wait and the service is already
      // connecting; a full project/session read every 12s would only add work
      // to the sync it is waiting for. A running sync rereads on its finish,
      // so a poll landing in the middle would only compete with it.
      if (!boot.ready() || conns.syncTicks().size > 0) return;
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
      let type: string | undefined;
      // The project list costs a round trip to every backend, and only a
      // session appearing, moving or going away can change it.
      try {
        const evt = JSON.parse(m.data) as {
          type?: string;
          connection_id?: string;
          done?: number;
          total?: number;
        };
        type = evt.type;
        // Sync ticks update the progress strip and nothing else; the session.*
        // events a sync produces already drive the refetch.
        if (evt.type?.startsWith("sync.")) {
          conns.onSyncEvent(evt);
          // A refetch already queued by the last event would land in the
          // middle of this sync; the finish does the reread instead. The
          // finish clears its own queued copy so the reread happens once.
          if (evt.type === "sync.started" || evt.type === "sync.finished") clearTimeout(timer);
          const allDone = conns.syncTicks().size === 0;
          if (evt.type === "sync.finished" && allDone) {
            setUsageKey((n) => n + 1);
            // Metadata events seen during the sync were deliberately not
            // reread; take the workspace list once the sync is over.
            if (wsStale) {
              wsStale = false;
              void ws.refetchWs();
            }
          }
          return;
        }
        if (evt.type === "session.started" || evt.type === "session.updated" || evt.type === "session.deleted") wsStale = true;
      } catch {
        // heartbeats
      }
      // A sync emits a transcript event per imported message. Re-projecting
      // the whole list for each one is what made the overview's token total
      // climb message by message and put "刚刚" on rows whose real time had
      // not been imported yet. Only a structural event gets through; the
      // finish does one full reread for everything else.
      // A dev server's output is not session activity. It carries a
      // `session_id` because that session owns the process, and it arrives on
      // the same stream, so keying on the id alone made every line of output
      // look like the session moved. Worse than a wasted fetch: this debounce is
      // reset by each event, and a server writing steadily keeps resetting it,
      // so the list never refreshes at all and every row sits at whatever state
      // it had when the server started.
      if (isDevEvent(type)) return;
      const behindSync = conns.syncTicks().size > 0;
      if (behindSync && !changesSessionList(type)) return;
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          list.refetch();
          conns.refetchConns();
          if (wsStale) {
            wsStale = false;
            void ws.refetchWs();
          }
        },
        behindSync ? 900 : 200,
      );
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      // The gate owns the window until launch is over; a shortcut that only
      // changes state behind it would land on an empty app after the gate.
      if (!boot.ready()) return;
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
      if (ws.dirOpen()) {
        ws.setDirOpen(false);
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
      removeLinkHandler();
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

  const newSession = async (dir?: string) => {
    list.setActionErr("");
    const directory = dir ?? defaultDir();
    try {
      const res = await fetch(api("/sessions"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory, connection_id: conns.newSessionConnection() }),
      });
      const body = (await res.json()) as { id?: string; error?: string };
      if (body.id) {
        ws.rememberDir(directory);
        list.refetch();
        location.hash = `/session/${encodeURIComponent(body.id)}`;
      } else {
        conns.setConnErr(body.error ?? t("error.createSession"));
        location.hash = "/settings/backends";
      }
    } catch (e) {
      // Reached from `void newSession()`, so a rejection here had nowhere to
      // go: the click did nothing, said nothing, and looked broken. A service
      // that is not answering is the usual reason, and it deserves to be seen.
      list.setActionErr(explain(e));
    }
  };

  const requestNewSession = (dir?: string) => {
    const phase = conns.phase();
    if (phase !== "connected") {
      // Opening the form while a backend is still being dialed asks the reader
      // to connect something the app has not finished connecting.
      if (phase === "idle" || phase === "failed" || phase === "missing" || phase === "unreachable") {
        location.hash = "/settings/backends";
      }
      return;
    }
    void newSession(dir);
  };

  const openSession = (id: string) => {
    if (compareOn()) {
      setCompareSel((sel) =>
        sel.includes(id) ? sel.filter((x) => x !== id) : [...sel.slice(-1), id],
      );
      return;
    }
    const row = list.library().find((s) => s.summary.session_id === id);
    ws.rememberDir(row ? list.sessionWorkspace(row) : undefined);
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
      // One panel. `Ctrl K` used to open a search that found sessions and
      // transcript but no commands, and `Ctrl Shift P` one that found commands
      // and sessions but no transcript — so half the time you opened the wrong
      // one, and the other half you did not know the other existed. Both
      // chords now open the same list, which answers to all three.
      title: () => t("palette.title"),
      chord: { key: "k" },
      run: () => setPaletteOpen((open) => !open),
    }),
  );
  onCleanup(
    registerCommand({
      id: "app.sidebar",
      title: () => t("sidebar.toggle"),
      // macOS keeps the traffic lights over that corner, so the column stays
      // there and the command has nothing to do.
      enabled: () => canCollapseSidebar(),
      run: () => toggleSidebar(),
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
      <WindowCaptionBar
        sidebarOpen={sidebarOpen()}
        onToggleSidebar={toggleSidebar}
        onOpenPalette={openPalette}
      />
      <Show
        when={boot.ready()}
        fallback={
          <Show
            when={boot.visible()}
            fallback={<div class="min-h-0 flex-1 bg-background" />}
          >
            <StartupGate
              stage={boot.stage()}
              sync={boot.sync()}
              attempts={conns.attempts()}
              slow={boot.slow()}
              canEnter={boot.canEnter()}
              onEnter={boot.enter}
              onRetry={boot.retry}
              onSettings={() => {
                boot.enter();
                location.hash = "/settings/backends";
              }}
            />
          </Show>
        }
      >
      <>
      <div class="flex min-h-0 flex-1">
      <Show when={sidebarOpen()}>
        <Sidebar
          list={list}
          ws={ws}
          conns={conns}
          sidebarOpen={sidebarOpen()}
          onToggleSidebar={toggleSidebar}
          onOpenPalette={openPalette}
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
          focusDir={focusDir}
          clearFocusDir={() => setFocusDir(undefined)}
        />
      </Show>
      {/* The folded column leaves a strip behind, so the switch that unfolds it
          is still on screen. Windows does not need one: its caption strip
          spans the whole window and carries the switch already. */}
      <Show when={!sidebarOpen() && !usesCustomCaption()}>
        <div class="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar pt-2">
          {/* The strip is one button wide and the corner carries two. Side by
              side they are 58px of buttons in a 40px strip, and the second one
              falls off the edge — so they stack here. Same two switches the
              caption bar puts side by side, in a column with room for one. */}
          <TopLeftControls
            class="flex-col"
            sidebarOpen={sidebarOpen()}
            onToggleSidebar={toggleSidebar}
            onOpenPalette={openPalette}
          />
        </div>
      </Show>

      <main class="@container/main relative min-w-0 flex-1">
        <SyncLine ticks={conns.syncTicks()} show={conns.syncShown()} />
        <Show when={route().name === "fleet"}>
          <PageShell title={t("fleet.scope.all")}>
            <Show
              when={conns.phase() === "connected"}
              fallback={
                <div class="flex h-full items-center justify-center">
                  <ConnectionEmpty conns={conns} />
                </div>
              }
            >
              <FleetView
                sessions={list.sessions()}
                now={clock()}
                refreshKey={usageKey()}
                onOpen={openSession}
                onOpenProject={(dir) => setFocusDir(dir)}
              />
            </Show>
          </PageShell>
        </Show>
        <Show when={route().name === "session"}>
          <SessionDetail
            id={(route() as { id: string }).id}
            sessions={settled(list.data)?.sessions ?? []}
            connections={settled(conns.conns)?.connections ?? []}
            onNewSession={requestNewSession}
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
            <SettingsPage section={(route() as { section?: string }).section} conns={conns} />
          </PageShell>
        </Show>
      </main>
      </div>
      <CommandPalette
        open={paletteOpen()}
        query={query()}
        onQuery={setQuery}
        sessions={list.sessions().map((s) => ({
          id: s.summary.session_id,
          title: displayTitle(s.title || s.summary.title) ?? t("common.untitled"),
          workspace: s.workspace ?? s.summary.workspace,
          summary: { title: s.summary.title, workspace: s.summary.workspace },
        }))}
        events={settled(results)}
        searching={results.loading}
        onOpenSession={(id) => {
          location.hash = `/session/${encodeURIComponent(id)}`;
        }}
        onOpenHit={(id, text) => {
          requestSearchTarget(id, text.trim());
          location.hash = `/session/${encodeURIComponent(id)}`;
        }}
        onClose={() => {
          setPaletteOpen(false);
          setQuery("");
        }}
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
      </>
      </Show>
    </div>
  );
}
