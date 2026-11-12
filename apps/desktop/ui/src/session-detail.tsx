import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  abortSession,
  getJson,
  importSession,
  readCapabilities,
  readCommands,
  readLsp,
  readVcs,
  realWorkspace,
  readHead,
  revertSession,
  unrevertSession,
  streamUrl,
  type Connection,
  type OptionsResponse,
} from "./api";
import { messageText } from "./transcript-format";
import { isDevEvent } from "./sync-events";
import { t } from "./i18n";
import { SessionEmpty } from "./session-empty";
import { displayTitle } from "./session-title";
import { settled } from "./resource";
import { inDesktopShell } from "./shell";
import { useDismiss } from "./dismiss";
import { TraceDrawer, TracePanel } from "./trace";
import { useTraceReplay } from "./trace-replay";
import { TerminalPane } from "./terminal";
import { TurnBlock } from "./transcript";
import { TranscriptView, type TranscriptApi } from "./transcript-view";
import type { StreamingSnapshot } from "./live";
import { createScrollDeferral, deferTranscriptWrite } from "./scroll-defer";
import { ECHO_TURN_ID } from "./prompt-echo";
import { ChildBoard } from "./child-board";
import { outlineIsPartial } from "./view-cache";
import { registerCommand } from "./commands";
import { PaneStage, type SessionRowSummary } from "./pane-stage";
import { usePaneActions } from "./pane-actions";
import { paneWorkspace, panelOpen, panelTab, setPanelOpen, setPanelTab } from "./session-chrome";
import { writePanelOpen, writePanelTab, type SidePanelTab } from "./right-pane";
import { refreshPlugins } from "./plugin-registry";
import { PeerSessionTranscript } from "./peer-transcript";
import { LoadingTranscript } from "./content-sashes";
import { useSessionSearch, SearchPanel } from "./session-search";
import { clearSearchTarget, searchTarget } from "./search-target";
import { useMcpTools, McpToolsPanel } from "./session-tools";
import { skillDraft } from "./mcp-panel";
import { useSessionComposer, SessionComposer } from "./session-composer";
import { useSessionAsks } from "./session-asks";
import { useSlashCommands } from "./slash-commands";
import { useSessionView } from "./session-view";
import { SessionRail } from "./session-rail";
import { useDevProcesses } from "./dev-processes";
import { createEntranceLedger } from "./entrance";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { clearPaneBusy, publishPaneBusy } from "./pane-activity";
import { SessionHeader } from "./session-header";
import { SessionDock } from "./session-dock";

export function SessionDetail(props: {
  id: string;
  sessions: SessionRowSummary[];
  onNewSession: () => void;
  connections?: Connection[];
}) {
  const panes = usePaneActions(props);
  const [maxSeq, { refetch: refetchSeq }] = createResource(() => props.id, readHead);
  const {
    replayPos,
    traceOn,
    traceKey,
    traceBlocks,
    traceLoading,
    traceBlock,
    traceParent,
    traceGap,
    toggleTrace,
    selectTrace,
    deselectTrace,
    resetTrace,
    resequenceTrace,
  } = useTraceReplay(props, maxSeq);
  const [terminalOn, setTerminalOn] = createSignal(false);
  const toggleTerminal = () => setTerminalOn((on) => !on);
  const {
    view,
    displayed,
    viewReady,
    importing,
    endImport,
    refreshView,
    paintSnapshot,
    retryView,
    resetView,
  } = useSessionView(props, { replayPos, generating: () => composer.generating() });

  // The focused pane vouches for its own session too, for the same reason the
  // peers do: the header reads the freshest evidence available, and this view
  // is the freshest. Guarded on the view's own id because a resource keyed on
  // `props.id` still holds the previous session's answer for the beat before it
  // resolves, and publishing that under the new id would move the lie rather
  // than fix it.
  createEffect(() => {
    const id = props.id;
    const v = settled(view);
    publishPaneBusy(id, v?.session_id === id && v.busy === true);
    onCleanup(() => clearPaneBusy(id));
  });
  const {
    promptsFailed,
    refetchAsks,
    refetchQuestions,
    refetchAutoAccept,
    asksFrom,
    openAsks,
    openQuestions,
    respond,
    resetAsks,
    autoAcceptToggle,
  } = useSessionAsks(props, view, (message) => composer.setSendErr(message));
  const [options, { refetch: refetchOptions }] = createResource(() =>
    getJson<OptionsResponse>("/options"),
  );
  const [caps, { refetch: refetchCaps }] = createResource(
    () => props.id,
    (id) => readCapabilities(id).catch(() => undefined),
  );
  const opencode = () => caps()?.extension === "opencode";
  // Live machine state, not part of the record: it shows only while the
  // session's OpenCode backend is connected, and follows a checkout made
  // outside strata once the window comes back. One read feeds the header
  // chip and the rail's branch option; a second copy in the rail was the
  // same endpoint asked twice per session open. This resource must sit
  // below `opencode`: createResource evaluates its source eagerly, so a
  // forward reference throws on mount.
  const [vcs, { refetch: refetchVcs }] = createResource(
    () => (opencode() ? props.id : undefined),
    (id) => readVcs(id).catch(() => undefined),
  );
  // The rail's background tab and the composer's pill read the same list; the
  // pill must keep working while the rail is closed.
  const dev = useDevProcesses(() => props.id, opencode);
  const [lspServers] = createResource(
    () => (opencode() ? props.id : undefined),
    (id) => readLsp(id).catch(() => undefined),
  );
  const [commands, { refetch: refetchCommands }] = createResource(
    () => (caps()?.commands && opencode() ? props.id : undefined),
    (id) => readCommands(id).catch(() => undefined),
  );
  let list: TranscriptApi | undefined;

  /**
   * One panel on the right, opened only by the reader. Trace and replay step
   * out of the way while it is open, and the choice persists across sessions.
   */
  const openPanel = (tab?: SidePanelTab) => {
    deselectTrace();
    if (tab) {
      setPanelTab(tab);
      writePanelTab(tab);
    }
    setPanelOpen(true);
    writePanelOpen(true);
  };
  const panelVisible = () => panelOpen() && !traceBlock();
  const closePanel = () => {
    setPanelOpen(false);
    writePanelOpen(false);
    panelTriggerEl?.focus();
  };
  const togglePanel = () => {
    // The trace drawer borrows the same edge while the panel stays open, so the
    // reader's next click still means "show me the panel", not "close nothing".
    if (panelVisible()) closePanel();
    else openPanel();
  };
  const selectTab = (tab: SidePanelTab) => {
    setPanelTab(tab);
    writePanelTab(tab);
  };

  /**
   * A path clicked in the transcript asks for the files tab and a row in it.
   * The nonce lets the same file be focused twice — the rail sees a new
   * request each time, not a value that compares equal and never fires.
   */
  const [pathFocus, setPathFocus] = createSignal<{ path: string; n: number }>();
  const openPathInRail = (rel: string) => {
    openPanel("files");
    setPathFocus({ path: rel, n: Date.now() });
  };

  const { slashCommands, runBuiltin } = useSlashCommands(props, {
    view,
    caps,
    commands,
    opencode,
    composer: () => composer,
    toggleTerminal,
  });

  const composer = useSessionComposer({
    sessionId: () => props.id,
    view: () => displayed(),
    booting: () => !viewReady(),
    caps,
    commands: slashCommands,
    onBuiltin: runBuiltin,
    options: () => settled(options),
    replayPos,
    refreshView: (full) => refreshView(full),
    branch: () => settled(vcs)?.branch ?? undefined,
    sessionActivity: () =>
      props.sessions.map((row) => ({ id: row.summary.session_id, busy: row.busy === true })),
    // A child session is driven by its parent — nothing can be sent into it.
    readOnly: () =>
      displayed()?.parent_session_id ? t("composer.childReadonly") : undefined,
  });

  let tools: ReturnType<typeof useMcpTools>;
  const search = useSessionSearch({
    sessionId: () => props.id,
    view: () => settled(view),
    scrollToIndex: (i) => list?.jumpToIndex(i),
    onOpen: () => tools.setToolsOpen(false),
  });
  tools = useMcpTools({
    sessionId: () => props.id,
    enabled: opencode,
    onOpen: () => search.closeSearch(),
    onError: (message) => composer.setSendErr(message),
  });
  /**
   * A transcript hit from the global palette. The palette knows the query and
   * the session; the turn is resolved here, against the view being loaded.
   */
  createEffect(() => {
    const target = searchTarget();
    if (!target) return;
    if (target.sessionId !== props.id) {
      clearSearchTarget();
      return;
    }
    clearSearchTarget();
    search.openSearch(target.query, true);
  });

  /**
   * The two anchored panels put themselves away when the press lands elsewhere.
   *
   * Both are anchored to the header and hold work in progress — a half-typed
   * query, a connect button — so leaving them up was deliberate, but so was
   * having to find the same trigger again to close them. Each names its own
   * trigger and its own body: forget the trigger and the press that dismisses
   * and the press that reopens both arrive, and the button reads as stuck.
   */
  let searchPanelEl: HTMLDivElement | undefined;
  let searchTriggerEl: HTMLButtonElement | undefined;
  let toolsPanelEl: HTMLDivElement | undefined;
  let toolsTriggerEl: HTMLButtonElement | undefined;
  let moreTriggerEl: HTMLButtonElement | undefined;
  let panelTriggerEl: HTMLButtonElement | undefined;
  const visibleToolsTrigger = () =>
    toolsTriggerEl?.getClientRects().length ? toolsTriggerEl : moreTriggerEl;
  useDismiss(search.searchOpen, search.closeSearch, () => searchPanelEl, () => searchTriggerEl);
  useDismiss(tools.toolsOpen, tools.closeTools, () => toolsPanelEl, visibleToolsTrigger);

  /**
   * The prompt has been handed over but the agent has not produced a thing
   * yet. That gap is a round trip through the backend, and until it closes the
   * transcript is a column of nothing below the question just asked — which
   * reads as a hang rather than as work. The turn itself may not exist yet
   * either, so the answer is "is the newest turn still silent", not a fixed row.
   *
   * It reads the view, not `turns()`: this memo runs at once, and `turns` is
   * created below it. Calling it here threw before the binding existed, which
   * aborted the render and left every later click, including settings, with
   * nowhere to go.
   */
  const lastSilentTurn = createMemo(() => {
    if (!composer.generating()) return undefined;
    const turns = settled(view)?.turns;
    const last = turns?.[turns.length - 1];
    if (last && (last.assistant.length > 0 || last.tool_calls.length > 0)) return undefined;
    return last;
  });

  /**
   * The column the reader is looking at, and which of its turns may move in.
   *
   * Both come from one memo on purpose. The ledger advances as this runs, so
   * putting it in an effect would let the rows be built before the reader was told
   * which of them were new — and nothing would ever animate. Asking inside a memo
   * that has already settled on what to render is what makes the column agree
   * with itself.
   *
   * The ledger is keyed on the session the *view* says it is, not on `props.id`.
   * The id changes a beat before the data does, so a ledger that reset on the id
   * would take the conversation being left as the baseline for the one being
   * opened, and announce all of it as newly arrived.
   */
  const entrance = createEntranceLedger();
  /**
   * The view on screen, as the composer decorates it. `displayed` comes from
   * the view hook, created before the composer so the composer can read it
   * while it is setting up.
   */
  const shown = createMemo(() => {
    const v = displayed();
    const t = composer.decorateTurns(v?.turns ?? []);
    return { turns: t, arriving: entrance.arriving(v?.session_id ?? "", t.map((x) => x.turn_id)) };
  });
  const turns = () => shown().turns;

  // When focus switches between panes (or sidebar sessions) without unmounting
  // `SessionDetail`, swap per-session transient state and paint any cached view
  // synchronously so other panes in the split tree stay mounted undisturbed.
  let activeSessionId = props.id;
  createEffect(() => {
    const id = props.id;
    if (id === activeSessionId) return;
    /**
     * Nothing in here may throw, and the latch moves only once the switch has
     * actually been made.
     *
     * The report was a pane that stopped following the sidebar: the selection
     * moved because it reads the route directly, while the transcript beside it
     * kept showing the previous conversation — and leaving for the overview,
     * which unmounts this component, cured it. An effect that has thrown stops
     * being notified, which fits that exactly; it was not reproduced here, so
     * treat the mechanism as the likely one rather than a proven one. The two
     * changes below are right either way.
     *
     * The latch used to be set first, so a failure also left it claiming a
     * switch that never happened. Setting it last means a failure is retried
     * the next time anything here changes instead of being remembered as done.
     */
    try {
      scrollDeferral.take();
      resetView(id);
      resetTrace();
      resetAsks();
      composer.resetFor(id);
      search.closeSearch();
      tools.setToolsOpen(false);
      activeSessionId = id;
    } catch (err) {
      // The pane is now showing one session's chrome over another's content,
      // which is worse than either. Say so and let the next change retry.
      console.error(`switching to ${id} failed; the pane still shows ${activeSessionId}:`, err);
      composer.setSendErr(err instanceof Error ? err.message : t("err.network"));
      return;
    }
    void (async () => {
      const before = await readHead(id).catch(() => undefined);
      await importSession(id).catch(() => {});
      if (props.id !== id) return;
      const after = await readHead(id).catch(() => undefined);
      endImport();
      if (after !== before) {
        resequenceTrace();
        void refreshView(true);
      }
      void refetchSeq();
    })();
  });

  let scrollGate = { gesturing: false, following: true };
  const scrollDeferral = createScrollDeferral();
  const holdingWrites = () => deferTranscriptWrite(scrollGate.gesturing, scrollGate.following);
  const flushScrollDeferral = () => {
    if (holdingWrites() || !scrollDeferral.pending()) return;
    const held = scrollDeferral.take();
    if (held.snap) paintSnapshot(held.snap);
    if (held.refresh) {
      void refreshView(held.refresh === "full");
      void refetchSeq();
    }
  };
  const onScrollGate = (gate: { gesturing: boolean; following: boolean }) => {
    scrollGate = gate;
    flushScrollDeferral();
  };

  onMount(() => {
    // Re-import in the background and only pay for a second full view when it
    // actually moved the session — the head probe is index-only, so this stays
    // cheap even when the import found nothing new.
    //
    // The transcript waits on `importing` only while the session has no turns,
    // so a hung import is a pane that never finishes loading. `importSession`
    // carries its own deadline, and this clears the flag even if the whole
    // probe throws: the local record is already on screen and is the better
    // thing to show than a spinner with no reason.
    void (async () => {
      try {
        const before = await readHead(props.id).catch(() => undefined);
        await importSession(props.id).catch(() => {});
        const after = await readHead(props.id).catch(() => undefined);
        if (after !== before) {
          resequenceTrace();
          void refreshView(true);
        }
        void refetchSeq();
      } finally {
        endImport();
      }
    })();
    const onConns = () => {
      refetchOptions();
      refetchVcs();
      refetchCaps();
      refetchCommands();
    };
    window.addEventListener("strata-connections", onConns);
    const onFocus = () => refetchVcs();
    window.addEventListener("focus", onFocus);
    const poll = setInterval(() => {
      if (replayPos() !== null) return;
      // This is the fallback for a dropped stream message, not the main path —
      // that is /stream, which already collapses a burst into one refetch.
      // Pulling the whole view on a timer meant re-downloading megabytes and
      // rebuilding tens of thousands of nodes every three seconds to discover
      // nothing had moved, and the rebuild is what the scroll stutter was:
      // ~280ms of blocked main thread, three times in any eight seconds of
      // scrolling. Ask for the head instead — a few hundred bytes, index-only —
      // and only pay for the view when the session has actually advanced.
      void readHead(props.id)
        .then((seq) => {
          if (seq === maxSeq()) return;
          if (holdingWrites()) {
            scrollDeferral.noteRefresh(false);
            return;
          }
          void refreshView();
          void refetchSeq();
        })
        .catch(() => {});
    }, 3_000);
    // The stream's address carries the token the service expects, and an
    // EventSource cannot carry a header — so the address is only known once
    // the shell has handed the token over.
    let es: EventSource | undefined;
    let esClosed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rebuilt = false;
    const onStreamMessage = (m: MessageEvent) => {
      try {
        const evt = JSON.parse(m.data) as {
          session_id?: string;
          type: string;
          data?: { state?: string; partial?: boolean };
        };
        if (evt.session_id && (evt.session_id !== props.id || isDevEvent(evt.type))) {
          window.dispatchEvent(new CustomEvent("strata-stream-event", { detail: evt }));
        }
        // A dev server's output is not a turn. It is forwarded above, because the
        // background panel reads it from that window event, and then it stops
        // here: re-projecting the transcript for every line a server writes kept
        // a running server from ever letting the view settle.
        if (isDevEvent(evt.type)) return;
        if (evt.session_id === props.id && evt.type === "turn.assistant" && evt.data?.partial === true) {
          // An idle session keeps receiving a leftover snapshot. Painting it
          // puts the cursor back on a turn that has finished.
          const snap = evt.data as unknown as StreamingSnapshot;
          if (holdingWrites()) scrollDeferral.noteSnap(snap);
          else paintSnapshot(snap);
          return;
        }
        if (evt.session_id === props.id && evt.type === "session.status" && evt.data?.state === "idle")
          composer.clearPending();
        if (evt.type === "plugins.changed") {
          // A plugin was enabled, disabled or restarted: the tool renderers and
          // panel tabs this window draws all come from that set.
          void refreshPlugins();
          return;
        }
        if (evt.type === "tool.progress") {
          // Progress is live-only and belongs to a tool row, not to the
          // transcript. It is forwarded for whoever is drawing that row.
          window.dispatchEvent(new CustomEvent("strata-stream-event", { detail: evt }));
          return;
        }
        if (evt.type === "session.policy") {
          // Another window, or another pane of this one, moved the switch. A
          // read that is only correct because it happens not to be looking
          // somewhere else is a read that will be wrong the moment someone
          // glances at the same session twice. Handled here and then ignored
          // below: permissions are not turns, so nothing in the view moved.
          if (evt.session_id === props.id) refetchAutoAccept();
          return;
        }
        if (evt.session_id === props.id || evt.type === "permission.requested" || evt.type === "question.asked") {
          if (replayPos() === null) {
            const ask = evt.type === "permission.requested" || evt.type === "question.asked";
            if (evt.session_id === props.id && evt.type === "session.rebuilt") {
              rebuilt = true;
              resequenceTrace();
            }
            // A scroll through history keeps the column still. Asks still
            // surface — those are decisions, not transcript layout.
            if (holdingWrites() && evt.session_id === props.id && !ask) {
              scrollDeferral.noteRefresh(rebuilt);
              rebuilt = false;
              clearTimeout(timer);
              timer = setTimeout(() => {
                refetchAsks();
                refetchQuestions();
                refetchSeq();
              }, 80);
              return;
            }
            if (holdingWrites() && ask) {
              clearTimeout(timer);
              timer = setTimeout(() => {
                refetchAsks();
                refetchQuestions();
                refetchSeq();
              }, 80);
              return;
            }
            clearTimeout(timer);
            timer = setTimeout(() => {
              // The gesture can start during this wait. Applying the view then
              // is the hitch the hold is there to avoid.
              if (holdingWrites()) {
                scrollDeferral.noteRefresh(rebuilt);
                rebuilt = false;
                refetchAsks();
                refetchQuestions();
                refetchSeq();
                return;
              }
              void refreshView(rebuilt);
              rebuilt = false;
              refetchAsks();
              refetchQuestions();
              refetchSeq();
            }, 80);
          }
        }
      } catch {
        // service.connected and heartbeats
      }
    };
    void streamUrl("/stream").then((url) => {
      if (esClosed) return;
      es = new EventSource(url);
      es.onmessage = onStreamMessage;
    });
    onCleanup(() => {
      clearInterval(poll);
      clearTimeout(timer);
      esClosed = true;
      es?.close();
      window.removeEventListener("strata-connections", onConns);
      window.removeEventListener("focus", onFocus);
    });
  });

  const childOf = (id: string) => {
    const row = props.sessions.find((s) => s.summary.session_id === id);
    if (!row) return undefined;
    return { title: row.title ?? "", status: row.status, busy: row.busy };
  };
  const openChild = (id: string) => {
    location.hash = `/session/${encodeURIComponent(id)}`;
  };

  const revertTurn = (turnId: string) => {
    const turn = (settled(view)?.turns ?? []).find((item) => item.turn_id === turnId);
    const text = turn?.user ? messageText(turn.user) : "";
    void (async () => {
      // A busy session refuses the stage. Stop it first, the same way /undo does,
      // then hand the withdrawn prompt back so the reader can send it again.
      if (composer.generating()) await abortSession(props.id);
      await revertSession(props.id, turnId);
      if (text.trim()) {
        composer.setDraft(text);
        queueMicrotask(() => composer.autogrow());
      }
    })().catch((err) => composer.setSendErr(err instanceof Error ? err.message : t("err.network")));
  };

  // Ctrl+F stays "find in what I am reading". Windowing the transcript took the
  // browser's own find away, so the shortcut goes to the session index.
  for (const command of [
    {
      id: "session.find",
      title: () => t("session.search.label"),
      chord: { key: "f" },
      run: () => {
        if (search.searchOpen()) search.focusInput();
        else search.openSearch();
      },
    },
    {
      id: "session.terminal",
      title: () => (terminalOn() ? t("terminal.hide") : t("terminal.show")),
      chord: { key: "`" },
      enabled: () => opencode(),
      run: toggleTerminal,
    },
    {
      id: "session.panel",
      title: () => (panelOpen() ? t("panel.hide") : t("panel.show")),
      run: () => togglePanel(),
    },
    {
      id: "pane.splitRight",
      title: () => t("pane.split.right"),
      run: () => panes.split(paneWorkspace().focusedPaneId, "row"),
    },
    {
      id: "pane.splitDown",
      title: () => t("pane.split.down"),
      run: () => panes.split(paneWorkspace().focusedPaneId, "col"),
    },
    {
      id: "pane.grid4",
      title: () => t("pane.mode.grid4"),
      run: () => panes.selectPreset("grid-4"),
    },
    {
      id: "pane.single",
      title: () => t("pane.mode.single"),
      run: () => panes.selectPreset("single"),
    },
  ]) {
    onCleanup(registerCommand(command));
  }

  const listedTitle = () => {
    const row = props.sessions.find((s) => s.summary.session_id === props.id);
    return displayTitle(row?.title ?? row?.summary.title) ?? t("session.untitled");
  };

  return (
    <div class="flex h-full min-h-0">
      <div class="@container/session relative flex min-w-0 flex-1 flex-col">
        <Show
          when={displayed()}
          fallback={
            <div class="flex h-full min-h-0 flex-col">
              <Show
                when={view.error}
                fallback={
                  <>
                    {/* One row, the same 36px the loaded header occupies. This
                        used to stack an empty DragBar under a second title row,
                        so opening a cold session pushed everything below down
                        by a header height and snapped it back on arrival. */}
                    <div
                      class="flex h-9 shrink-0 items-center border-b border-border px-4 select-none"
                      data-tauri-drag-region={inDesktopShell() ? "" : undefined}
                    >
                      <h1 class="min-w-0 flex-1 truncate text-sm font-medium">{listedTitle()}</h1>
                    </div>
                    <LoadingTranscript />
                  </>
                }
              >
                <div class="flex flex-1 items-center justify-center">
                  <EmptyState
                    icon="alert"
                    tone="danger"
                    title={t("session.service_unreachable")}
                    description={t("session.service_unreachable_hint")}
                    action={
                      <Button
                        size="sm"
                        onClick={retryView}
                      >
                        {t("session.retry")}
                      </Button>
                    }
                  />
                </div>
              </Show>
            </div>
          }
        >
          {(v) => (
            <>
              <SessionHeader
                view={v()}
                sessions={props.sessions}
                branch={settled(vcs)?.branch ?? undefined}
                opencode={opencode()}
                search={search}
                tools={tools}
                terminalOn={terminalOn()}
                onToggleTerminal={toggleTerminal}
                traceOn={traceOn()}
                onToggleTrace={toggleTrace}
                panelVisible={panelVisible()}
                onTogglePanel={togglePanel}
                workspace={paneWorkspace()}
                onPreset={panes.selectPreset}
                onSplit={(dir) => panes.split(paneWorkspace().focusedPaneId, dir)}
                onToggleZoom={() => panes.toggleZoom(paneWorkspace().focusedPaneId)}
                onError={composer.setSendErr}
                bindSearchTrigger={(el) => (searchTriggerEl = el)}
                bindToolsTrigger={(el) => (toolsTriggerEl = el)}
                bindMoreTrigger={(el) => (moreTriggerEl = el)}
                bindPanelTrigger={(el) => (panelTriggerEl = el)}
              />

              <ChildBoard parentId={props.id} sessions={props.sessions} />

              <Show when={search.searchOpen()}>
                <SearchPanel search={search} bindPanel={(el) => (searchPanelEl = el)} />
              </Show>

              <Show when={tools.toolsOpen()}>
                <McpToolsPanel
                  tools={tools}
                  lsp={lspServers}
                  bindPanel={(el) => (toolsPanelEl = el)}
                  onSkill={(name) => {
                    tools.setToolsOpen(false);
                    composer.setDraft((d) => skillDraft(d, name));
                    composer.focusDraft();
                  }}
                />
              </Show>

              <Show when={traceOn()}>
                <TracePanel
                  blocks={traceBlocks()}
                  loading={traceLoading()}
                  selected={traceKey()}
                  onSelect={selectTrace}
                  onClearSelection={deselectTrace}
                />
              </Show>

              {/* `min-h-0` alone lets the dock take everything. The transcript
                  is the thing the reader came for, so it gets a floor: a dock
                  that grows past this much pushes the dock's own scrollbox
                  rather than collapsing the conversation to a strip. It is also
                  what stops the entry jump — the column arrives at full height
                  and is then squeezed when the pending questions land, and the
                  reader sees their transcript compress rather than the dock
                  expand into room that was already there. */}
              <PaneStage
                workspace={paneWorkspace()}
                sessions={props.sessions}
                transcriptSessionId={props.id}
                onFocusPane={panes.focus}
                onSelectPaneSession={panes.selectSession}
                onSplitPane={panes.split}
                onClosePane={panes.close}
                onToggleZoom={panes.toggleZoom}
                onResizeSplit={panes.resize}
                renderPeerTranscript={(peerSessionId, paneId) => (
                  <PeerSessionTranscript
                    sessionId={peerSessionId}
                    paneId={paneId}
                    sessions={props.sessions}
                    onFocus={() => panes.focus(paneId, peerSessionId)}
                    onOpenChild={openChild}
                  />
                )}
                renderFocusedTranscript={() => (
                  <TranscriptView
                    paneId={paneWorkspace().focusedPaneId}
                    sessionId={displayed()?.session_id ?? props.id}
                    turns={turns()}
                    onScrollGate={onScrollGate}
                    workspace={() => realWorkspace(displayed()?.workspace)}
                    onOpenPath={openPathInRail}
                    ready={viewReady() && !(importing() && turns().length === 0)}
                    nav={viewReady() && replayPos() === null && !outlineIsPartial(displayed())}
                    latest={replayPos() === null}
                    class={paneWorkspace().mode === "multiplex" ? "min-h-0" : "min-h-[30vh]"}
                    empty={
                      <Show
                        when={!lastSilentTurn()}
                        fallback={
                          <div class="flex justify-center">
                            <EmptyState
                              icon="brain"
                              title={t("transcript.thinking")}
                              class="py-10"
                            />
                          </div>
                        }
                      >
                        {/* Centres optically rather than dead-centre: the
                            composer sits at the bottom, so the middle of what is
                            left reads higher than the middle of the column. */}
                        <div class="flex flex-1 items-center justify-center pb-[10vh]">
                          <SessionEmpty
                            workspace={v().workspace}
                            branch={settled(vcs)?.branch}
                            hints={{
                              mention: opencode(),
                              command: Array.isArray(slashCommands()),
                            }}
                            onPick={(text) => {
                              composer.setDraft(text);
                              composer.focusDraft();
                            }}
                          />
                        </div>
                      </Show>
                    }
                    renderTurn={(turn, part) => (
                      <TurnBlock
                        turn={turn()}
                        part={part()}
                        entering={() => shown().arriving.has(turn().turn_id)}
                        live={() => composer.generating() && turns().at(-1)?.turn_id === turn().turn_id}
                        tailTurn={() => turn().turn_id === turns().at(-1)?.turn_id}
                        ended={() => displayed()?.status !== "active"}
                        awaiting={() => turn().turn_id === ECHO_TURN_ID || lastSilentTurn() === turn()}
                        childOf={childOf}
                        onOpenChild={openChild}
                        onEdit={composer.editTurn}
                        onRevert={caps()?.revert ? revertTurn : undefined}
                      />
                    )}
                    api={(a) => {
                      list = a;
                    }}
                  />
                )}
              />

              <Show when={replayPos() === null}>
                <SessionDock
                  promptsFailed={promptsFailed()}
                  onRetryPrompts={() => {
                    void refetchQuestions();
                    void refetchAsks();
                  }}
                  asks={openAsks()}
                  questions={openQuestions()}
                  from={asksFrom}
                  onRespond={(id, decision, scope) => void respond(id, decision, scope)}
                  onQuestionDone={() => {
                    refetchQuestions();
                    void refreshView();
                  }}
                  reverted={Boolean(v().revert_turn_id)}
                  onRestore={() =>
                    void unrevertSession(props.id).catch((err) =>
                      composer.setSendErr(err instanceof Error ? err.message : t("err.network")),
                    )
                  }
                  disconnected={caps()?.connected === false}
                >
                  <SessionComposer
                    c={composer}
                    sessionId={() => props.id}
                    plan={v().plan}
                    title={v().title}
                    permission={autoAcceptToggle}
                    goal={v().goal}
                    goalMet={v().goal_met}
                    goalPaused={v().goal_paused}
                    readOnly={() =>
                      v().parent_session_id ? t("composer.childReadonly") : undefined
                    }
                    background={
                      opencode()
                        ? {
                            count: dev.count,
                            commands: dev.commands,
                            open: () => openPanel("background"),
                            active: () =>
                              panelOpen() && !traceBlock() && panelTab() === "background",
                          }
                        : undefined
                    }
                  />
                </SessionDock>
              </Show>
            </>
          )}
        </Show>
        <Show when={terminalOn() && opencode()}>
          <TerminalPane sessionId={props.id} onEmpty={() => setTerminalOn(false)} />
        </Show>
      </div>

      <Show when={traceBlock()}>
        {(block) => (
          <TraceDrawer
            block={block()}
            parent={traceParent()}
            gapMs={traceGap()}
            onOpenChild={openChild}
            onClose={deselectTrace}
          />
        )}
      </Show>
      <Show when={!traceBlock() && displayed()}>
        {(v) => (
          <SessionRail
            sessionId={() => props.id}
            view={v}
            opencode={opencode}
            open={panelOpen}
            tab={panelTab}
            onSelectTab={selectTab}
            onClose={closePanel}
            pathFocus={pathFocus}
            onJumpToTurn={(i) => {
              if (i >= 0) list?.jumpToIndex(i);
            }}
            onCite={composer.citeLine}
            dev={dev}
            vcs={() => settled(vcs)}
          />
        )}
      </Show>
    </div>
  );
}
