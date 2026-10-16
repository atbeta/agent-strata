import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import {
  api,
  downloadExport,
  fmtUsd,
  getJson,
  importSession,
  readCapabilities,
  readCommands,
  readSessionPolicy,
  readLsp,
  readVcs,
  realWorkspace,
  respondPermission,
  setSessionPolicy,
  readViewTail,
  revertSession,
  forkSession,
  unrevertSession,
  type OptionsResponse,
  type PendingAsk,
  type PendingQuestion,
  type SessionView,
} from "./api";
import { Icon } from "./icons";
import { t } from "./i18n";
import { settled } from "./resource";
import { inDesktopShell, shellPlatform } from "./shell";
import { Tip } from "./tip";
import { TraceDrawer, TraceStrip, type TraceBlock } from "./trace";
import { TerminalPane } from "./terminal";
import { TurnBlock } from "./transcript";
import { Virtual, type VirtualApi } from "./virtual";
import { JUMP_GAP } from "./virtual-tail";
import { PromptNavigator } from "./prompt-navigator";
import { promptAt, promptEntries } from "./prompt-outline";
import { applyStreamingSnapshot, mergeViewTail, type StreamingSnapshot } from "./live";
import { ECHO_TURN_ID } from "./prompt-echo";
import {
  filesKeyOf,
  peekView,
  rememberView,
  tailMatches,
  TAIL_TURNS,
  viewFromTail,
} from "./view-cache";
import { registerCommand } from "./commands";
import { LayoutSwitcher, PaneStage, type SessionRowSummary } from "./pane-stage";
import {
  applyLayoutPreset,
  assignSessionToWorkspace,
  closePane,
  focusedLeaf,
  focusPane,
  resizeSplit,
  setPaneSession,
  splitPane,
  toggleZoomPane,
  type LayoutPreset,
  type PaneWorkspaceState,
  type SplitDir,
} from "./pane-tree";
import {
  contentW,
  paneScrollMemory,
  paneWorkspace,
  panelOpen,
  panelTab,
  setPanelOpen,
  setPanelTab,
  updatePaneWorkspace,
} from "./session-chrome";
import { writePanelOpen, writePanelTab, type SidePanelTab } from "./right-pane";
import { PeerSessionTranscript } from "./peer-transcript";
import { ContentSashes, LoadingTranscript } from "./content-sashes";
import { AskCard, QuestionCard } from "./session-prompts";
import { useSessionSearch, SearchPanel } from "./session-search";
import { useMcpTools, McpToolsPanel } from "./session-tools";
import { useSessionComposer, SessionComposer } from "./session-composer";
import { SessionRail } from "./session-rail";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { DragBar } from "./chrome";

/** Newest sequence number for a session, or 0. Covers (session_id, seq), so this is an index probe. */
async function readHead(id: string): Promise<number> {
  const r = await getJson<{ events: { seq: number }[] }>(
    `/events?session_id=${encodeURIComponent(id)}&order=desc&limit=1`,
  );
  return r.events[0]?.seq ?? 0;
}

/** Ctrl on a PC, ⌘ on a Mac. The tooltip used to say "Ctrl+F" on every platform. */
function findKey(): string {
  return shellPlatform() === "macos" ? "⌘F" : "Ctrl+F";
}

/**
 * A header panel toggle: icon button, quiet at rest, filled while its panel is
 * open.
 *
 * Five of these sit in one row — search, terminal, files, replay, tools — and
 * each had the same class string written out again with the selected state
 * interpolated, so adding a sixth meant copying a ternary. None of them drew a
 * focus ring either, which left tabbing across the header moving an invisible
 * cursor past five controls.
 *
 * `expanded` and `pressed` are separate because the search button answers
 * `aria-expanded` (it reveals a field) while the rest answer `aria-pressed`
 * (they toggle a surface that stays in the layout).
 */
function PanelToggle(props: {
  label: string;
  on: boolean;
  expanded?: boolean;
  pressed?: boolean;
  onClick: () => void;
  children: JSX.Element;
}) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="icon"
      class={props.on ? "bg-secondary text-foreground" : undefined}
      aria-label={props.label}
      aria-expanded={props.expanded}
      aria-pressed={props.pressed}
      onClick={props.onClick}
    >
      {props.children}
    </Button>
  );
}

export function SessionDetail(props: {
  id: string;
  sessions: SessionRowSummary[];
}) {
  createEffect(() => {
    const id = props.id;
    updatePaneWorkspace((ws) => assignSessionToWorkspace(ws, id));
  });

  const candidateSessionIds = () => props.sessions.map((s) => s.summary.session_id);

  const navigatePaneSession = (sessionId: string | null) => {
    if (sessionId && sessionId !== props.id) {
      location.hash = `/session/${encodeURIComponent(sessionId)}`;
    }
  };

  const handleSelectPreset = (preset: LayoutPreset) => {
    const next = updatePaneWorkspace((ws) =>
      applyLayoutPreset(ws, preset, props.id, candidateSessionIds()),
    );
    navigatePaneSession(focusedLeaf(next).sessionId);
  };

  const handleSplitPane = (paneId: string, dir: SplitDir) => {
    // Seed the new split with the next session not already on screen, or leave
    // the pane empty for the picker.
    const usedIds = new Set<string>();
    const collectUsed = (n: PaneWorkspaceState["root"]) => {
      if (n.kind === "leaf") {
        if (n.sessionId) usedIds.add(n.sessionId);
      } else {
        collectUsed(n.a);
        collectUsed(n.b);
      }
    };
    collectUsed(paneWorkspace().root);
    usedIds.add(props.id);
    const nextCandidate = candidateSessionIds().find((sid) => !usedIds.has(sid)) ?? null;
    const next = updatePaneWorkspace((ws) => splitPane(ws, paneId, dir, nextCandidate));
    navigatePaneSession(focusedLeaf(next).sessionId);
  };

  const handleFocusPane = (paneId: string, sessionId: string | null) => {
    updatePaneWorkspace((ws) => focusPane(ws, paneId));
    navigatePaneSession(sessionId);
  };

  const handleSelectPaneSession = (paneId: string, sessionId: string) => {
    updatePaneWorkspace((ws) => setPaneSession(ws, paneId, sessionId));
    navigatePaneSession(sessionId);
  };

  const handleClosePane = (paneId: string) => {
    const next = updatePaneWorkspace((ws) => closePane(ws, paneId));
    navigatePaneSession(focusedLeaf(next).sessionId);
  };

  const handleToggleZoom = (paneId: string) => {
    const next = updatePaneWorkspace((ws) => toggleZoomPane(ws, paneId));
    navigatePaneSession(focusedLeaf(next).sessionId);
  };

  const handleResizeSplit = (splitId: string, ratio: number) => {
    updatePaneWorkspace((ws) => resizeSplit(ws, splitId, ratio));
  };
  const [replayPos, setReplayPos] = createSignal<number | null>(null);
  const [traceOn, setTraceOn] = createSignal(false);
  const [traceBlock, setTraceBlock] = createSignal<TraceBlock | null>(null);
  const [terminalOn, setTerminalOn] = createSignal(false);
  const opening = peekView(props.id);
  const [booting, setBooting] = createSignal(!opening);
  /** the background re-import that lands after the stored view is already up */
  const [importing, setImporting] = createSignal(true);
  // The files list key travels with the cached view so a warm open can leave
  // an unchanged list off the wire. forceFull skips the cache for one fetch.
  let filesKey: string | undefined = opening?.filesKey;
  let forceFull = false;
  let fetchGen = 0;
  let viewAlive = true;
  /** Consecutive automatic reload attempts after a failed one. */
  let retries = 0;
  onCleanup(() => {
    viewAlive = false;
  });
  const [view, { refetch, mutate }] = createResource(
    () => ({ id: props.id, pos: replayPos() }),
    (key: { id: string; pos: number | null }) => {
      const gen = ++fetchGen;
      const path = `/sessions/${encodeURIComponent(key.id)}/view`;
      // Consume the flag even when this fetch is a replay, so leaving the
      // replay does not turn the next live open into a full download.
      const fullNow = forceFull;
      forceFull = false;
      if (key.pos !== null) return getJson<SessionView>(`${path}?until_seq=${key.pos}`);
      if (fullNow) {
        return getJson<SessionView>(path).then((full) => {
          if (gen === fetchGen) {
            filesKey = filesKeyOf(full);
            rememberView(key.id, full, filesKey);
          }
          return full;
        });
      }
      const hit = peekView(key.id);
      if (hit) {
        if (hit.filesKey) filesKey = hit.filesKey;
        return Promise.resolve(hit.view);
      }
      // Paint the tail, then replace it with the settled view. The preview is
      // not cached: storing it would make the next open a transcript with no history.
      return readViewTail(key.id, TAIL_TURNS).then(async (tail) => {
        if (gen !== fetchGen) return viewFromTail(tail);
        if (viewAlive) {
          filesKey = tail.files_key;
          mutate(viewFromTail(tail));
        }
        const full = await getJson<SessionView>(path).catch(() => undefined);
        if (gen !== fetchGen || !full) return viewFromTail(tail);
        const keyOf = filesKeyOf(full);
        if (viewAlive) filesKey = keyOf;
        rememberView(key.id, full, keyOf);
        return full;
      });
    },
    opening ? { initialValue: opening.view } : undefined,
  );
  const [maxSeq, { refetch: refetchSeq }] = createResource(() => props.id, readHead);
  // Live machine state, not part of the record: it shows only while the
  // session's OpenCode backend is connected, and follows a checkout made
  // outside strata once the window comes back.
  const [vcs, { refetch: refetchVcs }] = createResource(
    () => props.id,
    (id) => readVcs(id).catch(() => undefined),
  );
  const [asks, { refetch: refetchAsks }] = createResource(
    () => props.id,
    async (id) => {
      const r = await getJson<{ pending: PendingAsk[] }>("/permissions");
      return r.pending.filter((p) => p.session_id === id);
    },
  );
  const [hiddenAsks, setHiddenAsks] = createSignal<ReadonlySet<string>>(new Set());
  const unhideAsk = (request_id: string) =>
    setHiddenAsks((cur) => {
      const next = new Set(cur);
      next.delete(request_id);
      return next;
    });
  const [questions, { refetch: refetchQuestions }] = createResource(
    () => props.id,
    async (id) => {
      const r = await getJson<{ pending: (PendingQuestion & { session_id: string })[] }>(
        "/questions",
      );
      return r.pending.filter((p) => p.session_id === id);
    },
  );
  const [options, { refetch: refetchOptions }] = createResource(() =>
    getJson<OptionsResponse>("/options"),
  );
  const [caps, { refetch: refetchCaps }] = createResource(
    () => props.id,
    (id) => readCapabilities(id).catch(() => undefined),
  );
  const opencode = () => caps()?.extension === "opencode";
  const [lspServers] = createResource(
    () => (opencode() ? props.id : undefined),
    (id) => readLsp(id).catch(() => undefined),
  );
  const [commands, { refetch: refetchCommands }] = createResource(
    () => (caps()?.commands && opencode() ? props.id : undefined),
    (id) => readCommands(id).catch(() => undefined),
  );
  /**
   * Whether this session has been told to stop asking.
   *
   * Per session on purpose and not persisted: it is a stance about a
   * conversation in progress, so switching sessions must show what that
   * session is actually doing rather than the last one that was touched.
   *
   * `unknown` is a real answer and not a polite default. A read that failed —
   * a service too old to have the route, a sidecar that has not come up — used
   * to be reported as `inherit`, which drew an ordinary "off" switch and made
   * a broken backend look exactly like a working one. Pressing it then did
   * nothing at all: the write 404'd, the catch undid the flip, and every
   * symptom was the button being dead. Anything unreadable now says so on the
   * button rather than pretending.
   */
  const [autoAccept, { refetch: refetchAutoAccept }] = createResource(
    () => props.id,
    (id) => readSessionPolicy(id).catch(() => "unknown" as const),
  );
  const [autoAcceptErr, setAutoAcceptErr] = createSignal("");
  const on = () => autoAccept() === "auto";
  const toggleAutoAccept = async () => {
    const next = on() ? "inherit" : "auto";
    setAutoAcceptErr("");
    // Flip the reader's own read first. The route is a local POST and the
    // answer is already known; waiting for it would make the button sit there
    // not having moved, which is how a reader toggles it twice.
    refetchAutoAccept(next);
    // What was already on screen has to follow. A card still waiting while the
    // header says the session is not waiting any more is the same disagreement
    // this whole switch is meant to remove, and it is the one a reader meets
    // first — they are looking at a permission when they reach for the button.
    const held = next === "auto" ? (asks() ?? []).map((a) => a.request_id) : [];
    for (const request_id of held) setHiddenAsks((cur) => new Set(cur).add(request_id));
    try {
      await setSessionPolicy(props.id, next);
      for (const request_id of held) {
        await respondPermission(request_id, "allow", "once").catch(() => {
          // Gone, or answered elsewhere. Either way it is not this reader's
          // to hold up the switch over.
          unhideAsk(request_id);
        });
      }
      refetchAutoAccept();
      refetchAsks();
    } catch (err) {
      for (const request_id of held) unhideAsk(request_id);
      setAutoAcceptErr(err instanceof Error ? err.message : String(err));
      refetchAutoAccept();
    }
  };

  let scroller: HTMLDivElement | undefined;
  // Virtual needs these every frame it decides what to keep mounted. The
  // scroller owns the scroll, so the offset is read back out of it rather than
  // re-derived here.
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewport, setViewport] = createSignal(0);
  // Whether the reader is following the tail. It is a signal rather than a
  // plain flag because the virtual list has to consult it while applying
  // measurements, which happens outside any render pass here.
  const [pinned, setPinned] = createSignal(true);
  /** The turn at the top of the viewport — which prompt the outline lights up. */
  const [activeTurn, setActiveTurn] = createSignal(0);
  let list: VirtualApi | undefined;

  /**
   * One panel on the right, opened only by the reader. Trace and replay step
   * out of the way while it is open, and the choice persists across sessions.
   */
  const openPanel = (tab?: SidePanelTab) => {
    setTraceBlock(null);
    setReplayPos(null);
    if (tab) {
      setPanelTab(tab);
      writePanelTab(tab);
    }
    setPanelOpen(true);
    writePanelOpen(true);
  };
  const closePanel = () => {
    setPanelOpen(false);
    writePanelOpen(false);
  };
  const togglePanel = () => {
    // The trace drawer borrows the same edge while the panel stays open, so the
    // reader's next click still means "show me the panel", not "close nothing".
    if (panelOpen() && !traceBlock()) closePanel();
    else openPanel();
  };
  const selectTab = (tab: SidePanelTab) => {
    setPanelTab(tab);
    writePanelTab(tab);
  };

  // A durable event during a reply only moves the last turns, and the whole
  // view of a long session is megabytes. A rebuild, a replay, or a tail that no
  // longer lines up goes back to the full view. Every view load goes through
  // here one at a time, and waits out a fetch already in flight: mutate() does
  // not cancel that fetch, so a tail laid down first would be replaced by the
  // older full view and leave the files list behind the key the server holds.
  let running: Promise<void> | undefined;
  let nextRefresh: "tail" | "full" | undefined;
  const waitWhileLoading = () =>
    new Promise<void>((resolve) => {
      const tick = () => {
        if (!viewAlive || !view.loading) resolve();
        else setTimeout(tick, 16);
      };
      tick();
    });
  /** settles once the view reflects this request, queued behind a running one or not */
  const refreshView = (full = false): Promise<void> => {
    if (replayPos() !== null) return Promise.resolve();
    if (running) {
      if (full || !nextRefresh) nextRefresh = full ? "full" : "tail";
      return running;
    }
    running = loadView(full);
    return running;
  };
  const loadView = async (full: boolean): Promise<void> => {
    let wantFull = full;
    try {
      for (;;) {
        if (!viewAlive || replayPos() !== null) return;
        if (view.loading) {
          if (wantFull) nextRefresh = "full";
          else if (!nextRefresh) nextRefresh = "tail";
          await waitWhileLoading();
          if (!viewAlive) return;
          if (!nextRefresh) break;
          wantFull = nextRefresh === "full";
          nextRefresh = undefined;
          continue;
        }
        const current = settled(view);
        if (wantFull || !current) {
          if (replayPos() !== null) return;
          filesKey = undefined;
          forceFull = true;
          await refetch();
          if (!viewAlive || replayPos() !== null) return;
          const fullView = settled(view);
          if (fullView) {
            filesKey = filesKeyOf(fullView);
            rememberView(props.id, fullView, filesKey);
          }
        } else {
          const tail = await readViewTail(props.id, TAIL_TURNS, filesKey);
          if (!viewAlive || replayPos() !== null) return;
          if (view.loading) {
            nextRefresh = nextRefresh ?? "tail";
            continue;
          }
          const base = settled(view) ?? current;
          if (tailMatches(base, tail)) {
            filesKey = tail.files_key;
            rememberView(props.id, base, filesKey);
          } else {
            const merged = mergeViewTail(base, tail);
            if (!merged) {
              filesKey = undefined;
              wantFull = true;
              continue;
            }
            filesKey = tail.files_key;
            mutate(merged);
            rememberView(props.id, merged, filesKey);
          }
        }
        if (!nextRefresh) break;
        wantFull = nextRefresh === "full";
        nextRefresh = undefined;
      }
    } catch {
      // the next event or the head poll asks again
    } finally {
      running = undefined;
      if (nextRefresh) {
        const again = nextRefresh === "full";
        nextRefresh = undefined;
        queueMicrotask(() => void refreshView(again));
      }
    }
  };

  const composer = useSessionComposer({
    sessionId: () => props.id,
    view: () => settled(view),
    booting,
    caps,
    commands,
    options: () => settled(options),
    replayPos,
    refreshView: (full) => refreshView(full),
  });

  let tools: ReturnType<typeof useMcpTools>;
  const search = useSessionSearch({
    sessionId: () => props.id,
    view: () => settled(view),
    scrollToIndex: (i) => list?.scrollToIndex(i),
    onOpen: () => tools.setToolsOpen(false),
  });
  tools = useMcpTools({
    sessionId: () => props.id,
    enabled: opencode,
    onOpen: () => search.closeSearch(),
    onError: (message) => composer.setSendErr(message),
  });

  /** One outline row per real prompt, rebuilt from the view already in hand. */
  const entries = createMemo(() => promptEntries(settled(view)?.turns ?? []));
  const showNav = () => !booting() && replayPos() === null && entries().length >= 2;
  /** Following the tail means the active prompt is the last one, whatever row is on top. */
  const activeEntry = () => (pinned() ? entries().at(-1) : promptAt(entries(), activeTurn()));

  let jumpSettleGen = 0;
  const jumpToTurn = (turnId: string) => {
    const i = settled(view)?.turns.findIndex((t) => t.turn_id === turnId) ?? -1;
    if (i < 0) return;
    // A jump is the reader leaving the tail — same bargain scrollToIndex makes.
    setPinned(false);
    list?.scrollToIndex(i, "start");
    setActiveTurn(i);
    // Rows land on estimated heights; once neighbours mount and measure, the
    // target drifts. Re-anchor to the row's real box for a few frames, holding
    // the same gap a fresh jump gets rather than the top edge itself.
    //
    // Two failures live here, and they need different answers. The row can be
    // mounted and sitting in the wrong place, which is drift and one subtraction
    // fixes. Or it can be not mounted at all, which is what actually happens on
    // a real jump: `scrollToIndex` writes `scrollTop`, the window is recomputed
    // from the parent's mirrored signal, and until that round trip lands the row
    // is not in the document. Giving up on that — the old code returned on the
    // first missing row, having spent none of its eight tries — left the reader
    // somewhere else entirely, with a nav tick showing the jump they asked for
    // and no evidence of it on screen.
    const gen = ++jumpSettleGen;
    let tries = 0;
    let waiting = 0;
    const settle = () => {
      if (gen !== jumpSettleGen) return;
      const el = scroller;
      if (!el) return;
      const row = el.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`);
      if (!(row instanceof HTMLElement)) {
        // Not in the document yet. Keep looking: this is the window catching up
        // with the scroll we just asked for, and it is measured in frames.
        if (++waiting > 60) return;
        requestAnimationFrame(settle);
        return;
      }
      const drift = row.getBoundingClientRect().top - el.getBoundingClientRect().top - JUMP_GAP;
      if (Math.abs(drift) <= 4) return;
      if (tries >= 8) return;
      tries += 1;
      el.scrollTop += drift;
      requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  };

  const jumpToLatest = () => {
    jumpSettleGen++;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    setPinned(true);
    setActiveTurn(Math.max(0, (settled(view)?.turns.length ?? 1) - 1));
  };

  /**
   * The prompt has been handed over but the agent has not produced a thing
   * yet. That gap is a round trip through the backend, and until it closes the
   * transcript is a column of nothing below the question just asked — which
   * reads as a hang rather than as work. The turn itself may not exist yet
   * either, so the answer is "is the newest turn still silent", not a fixed row.
   */
  const lastSilentTurn = createMemo(() => {
    if (!composer.generating()) return undefined;
    const turns = settled(view)?.turns;
    const last = turns?.[turns.length - 1];
    if (last && (last.assistant.length > 0 || last.tool_calls.length > 0)) return undefined;
    return last;
  });

  const turns = createMemo(() => composer.decorateTurns(settled(view)?.turns ?? []));

  // When focus switches between panes (or sidebar sessions) without unmounting
  // `SessionDetail`, swap per-session transient state and paint any cached view
  // synchronously so other panes in the split tree stay mounted undisturbed.
  let activeSessionId = props.id;
  createEffect(() => {
    const id = props.id;
    if (id === activeSessionId) return;
    activeSessionId = id;
    const hit = peekView(id);
    filesKey = hit?.filesKey;
    forceFull = false;
    retries = 0;
    setBooting(!hit);
    setImporting(!hit);
    if (hit) mutate(hit.view);
    setReplayPos(null);
    setTraceOn(false);
    setTraceBlock(null);
    setHiddenAsks(new Set<string>());
    composer.resetFor(id);
    search.closeSearch();
    tools.setToolsOpen(false);
    void (async () => {
      const before = await readHead(id).catch(() => undefined);
      await importSession(id).catch(() => {});
      if (props.id !== id) return;
      const after = await readHead(id).catch(() => undefined);
      setImporting(false);
      if (after !== before) void refreshView(true);
      void refetchSeq();
    })();
  });

  // The stored view is already loading — the transcript paints as soon as it
  // lands instead of waiting on a full re-import first. A cached view or a
  // tail preview is enough to leave the boot state; the settled view follows.
  createEffect(() => {
    if (booting() && (view.state === "ready" || view.state === "errored" || settled(view))) setBooting(false);
  });

  /**
   * A failed load used to be permanent.
   *
   * The view resource only refetches when its source changes, so one request
   * that failed — the window opening before the service was listening, a proxy
   * restarting, a laptop waking — left the reader on that message for the rest
   * of the session with no way out but leaving. Try a few times on our own,
   * backing off so a service that is genuinely down is not hammered, then stop
   * and leave the button for them.
   */
  createEffect(() => {
    if (!view.error) {
      retries = 0;
      return;
    }
    if (retries >= 4) return;
    const wait = 500 * 2 ** retries++;
    const timer = setTimeout(() => {
      if (viewAlive) void refetch();
    }, wait);
    onCleanup(() => clearTimeout(timer));
  });

  // A warm open paints the cached view from the resource, then checks the
  // tail. Head equality is not enough while a reply is still streaming.
  createEffect(() => {
    const id = props.id;
    if (replayPos() !== null) return;
    if (!peekView(id)) return;
    queueMicrotask(() => {
      if (viewAlive && replayPos() === null) void refreshView(false);
    });
  });

  onMount(() => {
    // Re-import in the background and only pay for a second full view when it
    // actually moved the session — the head probe is index-only, so this stays
    // cheap even when the import found nothing new.
    void (async () => {
      const before = await readHead(props.id).catch(() => undefined);
      await importSession(props.id).catch(() => {});
      const after = await readHead(props.id).catch(() => undefined);
      setImporting(false);
      if (after !== before) void refreshView(true);
      void refetchSeq();
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
    // Seed the virtual window's inputs. Without this the list would start with a
    // zero-height viewport and only learn its size on the first scroll, which
    // for a session that opens pinned to the bottom means one wasted pass.
    if (scroller) {
      setScrollTop(scroller.scrollTop);
      setViewport(scroller.clientHeight);
    }
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
          void refreshView();
          void refetchSeq();
        })
        .catch(() => {});
    }, 3_000);
    const es = new EventSource(api("/stream"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rebuilt = false;
    es.onmessage = (m) => {
      try {
        const evt = JSON.parse(m.data) as {
          session_id?: string;
          type: string;
          data?: { state?: string; partial?: boolean };
        };
        if (evt.session_id && evt.session_id !== props.id) {
          window.dispatchEvent(new CustomEvent("strata-stream-event", { detail: evt }));
        }
        if (evt.session_id === props.id && evt.type === "turn.assistant" && evt.data?.partial === true) {
          // An idle session keeps receiving a leftover snapshot. Painting it
          // puts the cursor back on a turn that has finished.
          if (replayPos() === null && (settled(view)?.busy === true || composer.generating())) {
            const snap = evt.data as unknown as StreamingSnapshot;
            mutate((v) => {
              if (!v) return v;
              const next = applyStreamingSnapshot(v, snap);
              // Only extend a view we already settled. A tail preview is shorter
              // and must not replace the full transcript in the reader cache.
              const held = peekView(props.id);
              if (
                next !== v &&
                held &&
                next.turns.length >= held.view.turns.length &&
                next.turns[0]?.turn_id === held.view.turns[0]?.turn_id
              ) {
                rememberView(props.id, next);
              }
              return next;
            });
          }
          return;
        }
        if (evt.session_id === props.id && evt.type === "session.status" && evt.data?.state === "idle")
          composer.clearPending();
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
            if (evt.session_id === props.id && evt.type === "session.rebuilt") rebuilt = true;
            clearTimeout(timer);
            timer = setTimeout(() => {
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
    onCleanup(() => {
      clearInterval(poll);
      clearTimeout(timer);
      es.close();
      window.removeEventListener("strata-connections", onConns);
      window.removeEventListener("focus", onFocus);
    });
  });

  const respond = async (requestId: string, decision: "allow" | "deny", scope?: "once" | "always") => {
    setHiddenAsks((cur) => new Set(cur).add(requestId));
    try {
      await respondPermission(requestId, decision, scope);
    } catch (err) {
      const missing = err instanceof Error && /\b404\b/.test(err.message);
      if (!missing) {
        setHiddenAsks((cur) => {
          const next = new Set(cur);
          next.delete(requestId);
          return next;
        });
        composer.setSendErr(err instanceof Error ? err.message : t("err.network"));
      }
    }
    refetchAsks();
  };

  const openAsks = () => {
    const hidden = hiddenAsks();
    const decided = new Set<string>();
    const finished = new Set<string>();
    for (const turn of settled(view)?.turns ?? []) {
      for (const call of turn.tool_calls) {
        if (call.permission?.request_id && call.permission.decision) decided.add(call.permission.request_id);
        if (call.call_id && call.status !== "pending") finished.add(call.call_id);
      }
    }
    return (settled(asks) ?? []).filter((ask) => {
      if (hidden.has(ask.request_id) || decided.has(ask.request_id)) return false;
      if (ask.call_id && finished.has(ask.call_id)) return false;
      return true;
    });
  };

  const childOf = (id: string) => {
    const row = props.sessions.find((s) => s.summary.session_id === id);
    if (!row) return undefined;
    return { title: row.title ?? "", status: row.status, busy: row.busy };
  };
  const openChild = (id: string) => {
    location.hash = `/session/${encodeURIComponent(id)}`;
  };

  const revertTurn = (turnId: string) => {
    void revertSession(props.id, turnId).catch((err) =>
      composer.setSendErr(err instanceof Error ? err.message : t("err.network")),
    );
  };

  const forkTurn = (turnId: string) => {
    void forkSession(props.id, turnId)
      .then((id) => {
        location.hash = `/session/${encodeURIComponent(id)}`;
      })
      .catch((err) => composer.setSendErr(err instanceof Error ? err.message : t("err.network")));
  };

  // Ctrl+F stays "find in what I am reading". Windowing the transcript took the
  // browser's own find away, so the shortcut goes to the session index.
  onCleanup(
    registerCommand({
      id: "session.find",
      title: () => t("session.search.label"),
      chord: { key: "f" },
      run: () => {
        if (search.searchOpen()) search.focusInput();
        else search.openSearch();
      },
    }),
  );
  onCleanup(
    registerCommand({
      id: "session.terminal",
      title: () => (terminalOn() ? t("terminal.hide") : t("terminal.show")),
      chord: { key: "`" },
      enabled: () => opencode(),
      run: () => setTerminalOn((on) => !on),
    }),
  );
  onCleanup(
    registerCommand({
      id: "session.panel",
      title: () => (panelOpen() ? t("panel.hide") : t("panel.show")),
      run: () => togglePanel(),
    }),
  );
  onCleanup(
    registerCommand({
      id: "pane.splitRight",
      title: () => t("pane.split.right"),
      run: () => handleSplitPane(paneWorkspace().focusedPaneId, "row"),
    }),
  );
  onCleanup(
    registerCommand({
      id: "pane.splitDown",
      title: () => t("pane.split.down"),
      run: () => handleSplitPane(paneWorkspace().focusedPaneId, "col"),
    }),
  );
  onCleanup(
    registerCommand({
      id: "pane.grid4",
      title: () => t("pane.mode.grid4"),
      run: () => handleSelectPreset("grid-4"),
    }),
  );
  onCleanup(
    registerCommand({
      id: "pane.single",
      title: () => t("pane.mode.single"),
      run: () => handleSelectPreset("single"),
    }),
  );

  return (
    <div class="flex h-full min-h-0">
      <div class="@container/session relative flex min-w-0 flex-1 flex-col">
        <Show
          when={settled(view)}
          fallback={
            <div class="flex h-full min-h-0 flex-col">
              <DragBar />
              <Show
                when={view.error}
                fallback={<LoadingTranscript />}
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
                        onClick={() => {
                          retries = 0;
                          void refetch();
                        }}
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
              <header
                class="@container flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 select-none"
                data-tauri-drag-region={inDesktopShell() ? "" : undefined}
              >
                <div class="flex min-w-0 flex-1 items-baseline gap-2">
                  <Show when={v().parent_session_id}>
                    {(parentId) => {
                      const parent = () => props.sessions.find((s) => s.summary.session_id === parentId());
                      return (
                        <>
                          <Button
                            type="button"
                            variant="quiet"
                            size="sm"
                            class="h-auto max-w-48 shrink-0 truncate px-0 py-0 text-sm"
                            onClick={() => {
                              location.hash = `/session/${encodeURIComponent(parentId())}`;
                            }}
                          >
                            {parent()?.title || t("session.child.back")}
                          </Button>
                          {/* The parent is a link back and the h1 is where we
                              are — without a mark between them the two titles
                              read as one run-on name. */}
                          <Icon
                            name="chevron-right"
                            class="size-3 shrink-0 self-center text-muted-foreground/60"
                          />
                        </>
                      );
                    }}
                  </Show>
                  {/* Identity first. `flex-1` on a zero basis takes the free space, and the
                      min-width floor means the title gives up its width last.
                      The chips beside it stop being offered any width at all
                      below 440px — a truncated chip renders one glyph and then
                      reads as corruption, and both are on screen elsewhere (the
                      branch in the footer, the workspace in the sidebar). Before
                      this the title reached 0px at the window's 960px minimum
                      and the session you were reading had no name on screen. */}
                  <h1
                    class="min-w-24 flex-1 truncate text-sm font-medium"
                    title={v().title ?? t("session.untitled")}
                  >
                    {v().title ?? t("session.untitled")}
                  </h1>
                  <Show when={realWorkspace(v().workspace)}>
                    {(ws) => (
                      <span
                        class="max-w-40 shrink-0 truncate font-mono text-2xs text-muted-foreground @max-[440px]:hidden"
                        title={ws()}
                      >
                        {ws() === "/" || ws() === "\\" ? t("path.root") : ws().split(/[/\\]/).filter(Boolean).at(-1)}
                      </span>
                    )}
                  </Show>
                  <Show when={settled(vcs)?.branch}>
                    {(branch) => (
                      <Tip
                        label={t("header.branch.tip", { branch: branch() })}
                        class="@max-[440px]:hidden"
                      >
                        <span class="flex max-w-32 shrink-0 items-baseline gap-1 font-mono text-2xs text-muted-foreground">
                          <Icon name="branch" class="h-3 w-3 shrink-0 self-center" />
                          <span class="truncate">{branch()}</span>
                        </span>
                      </Tip>
                    )}
                  </Show>
                </div>
                <span class="flex shrink-0 items-center gap-0.5">
                  <Show when={v().totals.cost_usd > 0}>
                    <Tip label={t("header.cost.tip", { amount: fmtUsd(v().totals.cost_usd) })}>
                      <span class="mr-1 font-mono text-2xs text-muted-foreground tabular-nums">
                        {fmtUsd(v().totals.cost_usd)}
                      </span>
                    </Tip>
                  </Show>
                  <Tip label={t("session.search.tip", { shortcut: findKey() })}>
                  <PanelToggle
                    label={t("session.search.label")}
                    on={search.searchOpen()}
                    expanded={search.searchOpen()}
                    onClick={() => (search.searchOpen() ? search.closeSearch() : search.openSearch())}
                  >
                    <Icon name="search" />
                  </PanelToggle>
                </Tip>
                <Show when={opencode()}>
                    <Tip label={terminalOn() ? t("terminal.hide") : t("terminal.show")}>
                      <PanelToggle
                        label={terminalOn() ? t("terminal.hide") : t("terminal.show")}
                        on={terminalOn()}
                        pressed={terminalOn()}
                        onClick={() => setTerminalOn((on) => !on)}
                      >
                        <Icon name="terminal" />
                      </PanelToggle>
                    </Tip>
                  </Show>
                  <Tip label={traceOn() ? t("trace.live") : t("trace.replay")}>
                    <PanelToggle
                      label={traceOn() ? t("trace.live") : t("trace.replay")}
                      on={traceOn()}
                      pressed={traceOn()}
                      onClick={() => {
                        if (traceOn()) {
                          setTraceOn(false);
                          setTraceBlock(null);
                          setReplayPos(null);
                        } else {
                          setTraceOn(true);
                        }
                      }}
                    >
                      <Icon name="replay" />
                    </PanelToggle>
                  </Tip>
                  <Show when={opencode()}>
                    <Tip label={t("header.tools")}>
                      <PanelToggle
                        label={t("header.tools")}
                        on={tools.toolsOpen()}
                        pressed={tools.toolsOpen()}
                        onClick={tools.toggleTools}
                      >
                        <Icon name="plug" />
                      </PanelToggle>
                    </Tip>
                  </Show>
                  <Tip
                    label={
                      autoAcceptErr() ||
                      (autoAccept() === "unknown"
                        ? t("header.autoAccept.broken")
                        : t(on() ? "header.autoAccept.on" : "header.autoAccept.off"))
                    }
                  >
                    <span class="contents">
                      <PanelToggle
                        label={t("header.autoAccept")}
                        on={on()}
                        pressed={on()}
                        onClick={() => void toggleAutoAccept()}
                      >
                        <Icon
                          name="shield"
                          class={
                            autoAcceptErr() || autoAccept() === "unknown"
                              ? "text-destructive"
                              : undefined
                          }
                        />
                      </PanelToggle>
                    </span>
                  </Tip>
                  <LayoutSwitcher
                    workspace={paneWorkspace()}
                    onPreset={handleSelectPreset}
                    onSplit={(dir) => handleSplitPane(paneWorkspace().focusedPaneId, dir)}
                    onToggleZoom={() => handleToggleZoom(paneWorkspace().focusedPaneId)}
                  />
                  <Tip label={t("header.export")}>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="icon"
                      aria-label={t("header.export")}
                      onClick={() =>
                        void downloadExport(v().session_id).catch((err) =>
                          composer.setSendErr(err instanceof Error ? err.message : t("err.network")),
                        )
                      }
                    >
                      <Icon name="download" />
                    </Button>
                  </Tip>
                </span>
              </header>

              <Show when={search.searchOpen()}>
                <SearchPanel search={search} />
              </Show>

              <Show when={tools.toolsOpen()}>
                <McpToolsPanel tools={tools} />
              </Show>

              <Show when={traceOn()}>
                <TraceStrip
                  sessionId={props.id}
                  selected={traceBlock()?.key ?? null}
                  onSelect={(block) => {
                    if (traceBlock()?.key === block.key) {
                      setTraceBlock(null);
                      setReplayPos(null);
                      return;
                    }
                    setTraceBlock(block);
                    setReplayPos(block.seq);
                  }}
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
                onFocusPane={handleFocusPane}
                onSelectPaneSession={handleSelectPaneSession}
                onSplitPane={handleSplitPane}
                onClosePane={handleClosePane}
                onToggleZoom={handleToggleZoom}
                onResizeSplit={handleResizeSplit}
                renderPeerTranscript={(peerSessionId, paneId) => (
                  <PeerSessionTranscript
                    sessionId={peerSessionId}
                    paneId={paneId}
                    sessions={props.sessions}
                    onFocus={() => handleFocusPane(paneId, peerSessionId)}
                    onOpenChild={openChild}
                  />
                )}
                renderFocusedTranscript={() => (
              <div class={`relative flex flex-1 flex-col ${paneWorkspace().mode === "multiplex" ? "min-h-0" : "min-h-[30vh]"}`}>
              <ContentSashes />
              <div
                ref={(el) => {
                  scroller = el;
                  const memKey = `${paneWorkspace().focusedPaneId}:${props.id}`;
                  queueMicrotask(() => {
                    if (!el) return;
                    setViewport(el.clientHeight);
                    const remembered = paneScrollMemory.get(memKey);
                    if (remembered && !remembered.pinned && remembered.scrollTop > 0) {
                      el.scrollTop = remembered.scrollTop;
                      setScrollTop(remembered.scrollTop);
                      setPinned(false);
                    }
                  });
                }}
                // overflow-x is stated, not left out. CSS turns a `visible`
                // overflow-x into `auto` whenever overflow-y is a scroller, so
                // any one row wider than the column grew a horizontal scrollbar
                // that shrank the column — and windowing meant that row came and
                // went while scrolling, so the whole transcript breathed in and
                // out. Everything inside already scrolls or wraps on its own.
                class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  const isPinned = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
                  setScrollTop(el.scrollTop);
                  setViewport(el.clientHeight);
                  setPinned(isPinned);
                  setActiveTurn(list?.indexAtTop() ?? 0);
                  paneScrollMemory.set(`${paneWorkspace().focusedPaneId}:${props.id}`, {
                    scrollTop: el.scrollTop,
                    pinned: isPinned,
                  });
                }}
              >
                <div
                  class={
                    showNav()
                      ? "mx-auto w-full py-4 pl-11 pr-5"
                      : "mx-auto w-full px-5 py-4"
                  }
                  style={{ "max-width": `${contentW()}px` }}
                >
                  <Show
                    when={!booting() && !(importing() && turns().length === 0)}
                    fallback={<LoadingTranscript />}
                  >
                    <Show
                      when={turns().length > 0}
                      fallback={
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
                          <div class="flex justify-center">
                            <EmptyState
                              icon="spark"
                              title={t("session.empty")}
                              description={t("session.empty_hint")}
                              class="py-10"
                            />
                          </div>
                        </Show>
                      }
                    >
                    <Virtual
                      items={turns()}
                      id={(t) => t.turn_id}
                      estimate={100}
                      gap={32}
                      scrollTop={scrollTop()}
                      viewport={viewport()}
                      scroller={() => scroller}
                      api={(a) => {
                        list = a;
                        setActiveTurn(a.indexAtTop());
                      }}
                    >
                      {(turn) => (
                        <div data-turn-id={turn().turn_id}>
                          <TurnBlock
                            turn={turn()}
                            awaiting={() =>
                              turn().turn_id === ECHO_TURN_ID || lastSilentTurn() === turn()
                            }
                            childOf={childOf}
                            onOpenChild={openChild}
                            onEdit={composer.editTurn}
                            onRevert={caps()?.revert ? revertTurn : undefined}
                            onFork={caps()?.fork ? forkTurn : undefined}
                          />
                        </div>
                      )}
                    </Virtual>
                    </Show>
                  </Show>
                </div>
              </div>
              <Show when={showNav()}>
                <PromptNavigator
                  entries={entries()}
                  activeId={activeEntry()?.turnId}
                  onSelect={jumpToTurn}
                />
              </Show>
              <Show when={!booting() && replayPos() === null && !pinned() && v().turns.length > 0}>
                <Button
                  type="button"
                  variant="quiet"
                  size="xs"
                  class="surface-popover absolute bottom-4 left-1/2 z-20 h-auto -translate-x-1/2 rounded-full border border-border bg-popover px-3 py-1 shadow-md"
                  onClick={jumpToLatest}
                >
                  {t("nav.latest")}
                </Button>
              </Show>
              </div>
                )}
              />

              <Show when={replayPos() === null}>
                {/*
                  The dock is `shrink-0`, so whatever it takes, the transcript
                  does not get. That made the cap on the card stack a fiction:
                  `max-h-[45vh]` bounded the cards, but the dock's own `pt-6 pb-4`
                  and the composer below it were outside it, and the measured
                  total was 548px against a 900px window — 405 of cards plus 40 of
                  padding plus a 103px composer. The transcript was left 232px,
                  and since it arrives at full height and is then squeezed, the
                  reader watches their conversation compress on entry.

                  The cap therefore belongs to the dock, not to the cards inside
                  it, and it has to leave the composer room: the composer is
                  where a pending question is answered, so a cap that buried it
                  would answer the reader's problem by taking away the only way
                  out of it. `max-h-[55vh]` on the scrollable region keeps both,
                  and the composer stays outside it, pinned where it is.
                */}
                <div class="shrink-0 bg-gradient-to-t from-background from-70% px-5 pb-4 pt-6">
                  <div class="mx-auto w-full space-y-2" style={{ "max-width": `${contentW()}px` }}>
                    {/* Pending asks and questions share the dock with the
                        composer, and the dock is `shrink-0` — four stacked
                        prompts measured 1024px against a 900px window, which
                        took every pixel the transcript had and left that column
                        at zero height, so the "back to latest" control, anchored
                        to it, landed in the title bar. The stack now takes at
                        most half the window and scrolls; the composer stays
                        where it is. */}
                    <div class="max-h-[40vh] overflow-y-auto">
                      <div class="space-y-2">
                    {/* A prompt that fails to load is the worst thing that can
                        happen here: the agent is waiting for an answer the user
                        cannot see, and the session looks stuck rather than
                        broken. Say so, and let them ask again. */}
                    <Show when={questions.error || asks.error}>
                      <div class="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5">
                        <Icon name="alert" class="mt-0.5 size-3.5 shrink-0 text-destructive" />
                        <div class="min-w-0 flex-1">
                          <div class="text-sm text-destructive">
                            {t("prompt.load_failed")}
                          </div>
                          <div class="mt-0.5 text-2xs leading-4 text-muted-foreground">
                            {t("prompt.load_failed_hint")}
                          </div>
                        </div>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          class="shrink-0"
                          onClick={() => {
                            void refetchQuestions();
                            void refetchAsks();
                          }}
                        >
                          {t("session.retry")}
                        </Button>
                      </div>
                    </Show>
                    <For each={openAsks()}>
                      {(p) => (
                        <AskCard
                          ask={p}
                          onRespond={(id, decision, scope) => void respond(id, decision, scope)}
                        />
                      )}
                    </For>
                    <For each={settled(questions) ?? []}>
                      {(q) => (
                        <QuestionCard
                          q={q}
                          onDone={() => {
                            refetchQuestions();
                            void refreshView();
                          }}
                        />
                      )}
                    </For>
                      </div>
                    </div>
                    <Show when={v().revert_turn_id}>
                      <div class="flex items-center justify-between gap-2 px-1">
                        <span class="text-2xs text-muted-foreground">{t("message.reverted")}</span>
                        <Button
                          type="button"
                          variant="quiet"
                          size="xs"
                          class="h-auto px-0 py-0"
                          onClick={() =>
                            void unrevertSession(props.id).catch((err) =>
                              composer.setSendErr(err instanceof Error ? err.message : t("err.network")),
                            )
                          }
                        >
                          {t("message.restore")}
                        </Button>
                      </div>
                    </Show>
                    <SessionComposer
                      c={composer}
                      sessionId={() => props.id}
                      plan={v().plan}
                      title={v().title}
                    />
                  </div>
                </div>
              </Show>
            </>
          )}
        </Show>
        <Show when={terminalOn() && opencode()}>
          <TerminalPane sessionId={props.id} />
        </Show>
        <Show when={opencode()}>
          <footer class="flex h-7 shrink-0 items-center gap-3 border-t border-border px-4 text-2xs text-muted-foreground">
            <span class="truncate">{settled(vcs)?.branch ? t("status.branch", { branch: settled(vcs)!.branch! }) : t("status.noBranch")}</span>
            <span class={lspServers()?.some((s) => s.status === "error") ? "text-destructive" : ""}>
              {lspServers()?.some((s) => s.status === "error")
                ? t("status.lspErr", { n: lspServers()!.filter((s) => s.status === "error").length })
                : t("status.lsp", { n: lspServers()?.length ?? 0 })}
            </span>
            <span>
              {t("status.mcp", {
                on: tools.mcpServers().filter(([, s]) => s.status === "connected").length,
                n: tools.mcpServers().length,
              })}
            </span>
          </footer>
        </Show>
      </div>

      <Show when={traceBlock()}>
        {(block) => (
          <TraceDrawer
            block={block()}
            onClose={() => {
              setTraceBlock(null);
              setReplayPos(null);
            }}
          />
        )}
      </Show>
      <Show when={!traceBlock() && settled(view)}>
        {(v) => (
          <SessionRail
            sessionId={() => props.id}
            view={v}
            opencode={opencode}
            open={panelOpen}
            tab={panelTab}
            onSelectTab={selectTab}
            onClose={closePanel}
            onOpen={() => openPanel()}
            onJumpToTurn={(i) => {
              if (i >= 0) list?.scrollToIndex(i);
            }}
            onCite={composer.citeLine}
          />
        )}
      </Show>
    </div>
  );
}
