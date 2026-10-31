import {
  createEffect,
  createMemo,
  createRenderEffect,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import {
  abortSession,
  api,
  backendLabel,
  downloadExport,
  fmtUsd,
  getJson,
  handoffSession,
  importSession,
  readCapabilities,
  readCommands,
  readSessionPolicy,
  readLsp,
  readVcs,
  folderLabel,
  realWorkspace,
  renameSession,
  respondPermission,
  setSessionPolicy,
  shareSession,
  readHead,
  readViewTail,
  revertSession,
  forkSession,
  summarizeSession,
  unshareSession,
  unrevertSession,
  streamUrl,
  type CommandInfo,
  type Connection,
  type OptionsResponse,
  type PendingAsk,
  type PendingQuestion,
  type SessionView,
} from "./api";
import { builtinCommands, handoffTargets, resolveHandoff } from "./composer-input";
import { copyText } from "./clipboard";
import { messageText } from "./transcript-format";
import { isDevEvent } from "./sync-events";
import { Icon } from "./icons";
import { t } from "./i18n";
import { SessionEmpty } from "./session-empty";
import { displayTitle } from "./session-title";
import { settled } from "./resource";
import { inDesktopShell, shellPlatform } from "./shell";
import { Tip } from "./tip";
import { useDismiss } from "./dismiss";
import { ToggleIcon } from "./header-toggle";
import { toggleClasses } from "./toggle-state";
import { TraceDrawer, TracePanel } from "./trace";
import { createTraceData } from "./trace-data";
import { TerminalPane } from "./terminal";
import { TurnBlock } from "./transcript";
import { TranscriptView, type TranscriptApi } from "./transcript-view";
import { applyStreamingSnapshot, type StreamingSnapshot } from "./live";
import { ECHO_TURN_ID } from "./prompt-echo";
import { descendantSessions } from "./session-tree";
import { ChildBoard } from "./child-board";
import { createSessionViewLoader } from "./session-view-loader";
import { outlineIsPartial, peekView, rememberView, TAIL_TURNS } from "./view-cache";
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
import { clearSearchTarget, searchTarget } from "./search-target";
import { useMcpTools, McpAttentionMark, McpToolsPanel } from "./session-tools";
import { useSessionComposer, SessionComposer } from "./session-composer";
import { SessionRail } from "./session-rail";
import { createEntranceLedger } from "./entrance";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { DragBar } from "./chrome";
import { clearPaneBusy, publishPaneBusy } from "./pane-activity";

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
  /** the colour an open toggle's icon takes, when open means more than "a panel is showing" */
  tone?: string;
  /** the trigger counts as inside its own panel, so dismissing must name it */
  bindRef?: (el: HTMLButtonElement | undefined) => void;
  onClick: () => void;
  children: JSX.Element;
}) {
  return (
    <Button
      ref={props.bindRef}
      type="button"
      size="icon-sm"
      variant="icon"
      class={toggleClasses(props.on)}
      aria-label={props.label}
      aria-expanded={props.expanded}
      aria-pressed={props.pressed}
      onClick={props.onClick}
    >
      <ToggleIcon on={props.on} tone={props.tone}>
        {props.children}
      </ToggleIcon>
    </Button>
  );
}

export function SessionDetail(props: {
  id: string;
  sessions: SessionRowSummary[];
  onNewSession: () => void;
  connections?: Connection[];
}) {
  // The route session belongs in the focused pane — but only when the route
  // session *changes*.
  //
  // `updatePaneWorkspace` reads the pane signal to get the state it is updating,
  // so a plain effect reading it becomes subscribed to the whole workspace. It
  // then re-ran on every focus change, not just on the route, and stamped the
  // session it was holding — which, on the frame you clicked another pane, was
  // still the *previous* route. `assignSessionToWorkspace` answered rule 4 and
  // replaced the focused pane's session in place, so the pane you had just
  // clicked adopted the other conversation for a frame, and swapped back when
  // the hashchange finally landed. `on` narrows the subscription to the one
  // value this effect is actually about.
  createEffect(
    on(() => props.id, (id) => {
      updatePaneWorkspace((ws) => assignSessionToWorkspace(ws, id));
    }),
  );

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
  /**
   * Selection is a key, not the block: the trace keeps loading while a session
   * runs, and a stored object would show yesterday's data. `traceBlock`
   * resolves the key against the freshest load every read.
   */
  const [traceKey, setTraceKey] = createSignal<string | null>(null);
  /** bumped when events may have been re-sequenced (rebuild, re-import) —
   *  the trace reloads fully instead of appending duplicates */
  const [traceEpoch, setTraceEpoch] = createSignal(0);
  const [terminalOn, setTerminalOn] = createSignal(false);
  const opening = peekView(props.id);
  /** the background re-import that lands after the stored view is already up */
  const [importing, setImporting] = createSignal(true);
  // The files list key travels with the cached view so a warm open can leave
  // an unchanged list off the wire. forceFull skips the cache for one fetch.
  let filesKey: string | undefined = opening?.filesKey;
  let forceFull = false;
  let viewAlive = true;
  const viewLoader = createSessionViewLoader({
    readFull: (id, replayPos) => getJson<SessionView>(
      `/sessions/${encodeURIComponent(id)}/view${replayPos != null ? `?until_seq=${replayPos}` : ""}`,
    ),
    readTail: (id, key) => readViewTail(id, TAIL_TURNS, key),
    currentSessionId: () => props.id,
  });
  /** Consecutive automatic reload attempts after a failed one. */
  let retries = 0;
  onCleanup(() => {
    viewAlive = false;
    viewLoader.invalidate();
  });
  const [view, { refetch, mutate }] = createResource(
    () => ({ id: props.id, pos: replayPos() }),
    async (key: { id: string; pos: number | null }) => {
      viewLoader.invalidate();
      // Consume the flag even when this fetch is a replay, so leaving the
      // replay does not turn the next live open into a full download.
      const fullNow = forceFull;
      forceFull = false;
      if (key.pos !== null) {
        const replay = await viewLoader.loadFull(key.id, key.pos, () => {});
        return replay ?? peekView(props.id)?.view;
      }
      if (fullNow) {
        const full = await viewLoader.loadFull(key.id, null, (loaded, keyOf) => {
          filesKey = keyOf;
          rememberView(key.id, loaded, keyOf);
        });
        return full ?? peekView(props.id)?.view;
      }
      const hit = peekView(key.id);
      if (hit) {
        filesKey = hit.filesKey;
        return hit.view;
      }
      // Paint the tail, then replace it with the settled view. The preview is
      // not cached: storing it would make the next open a transcript with no history.
      const loaded = await viewLoader.loadCold(key.id, (preview, keyOf) => {
        filesKey = keyOf;
        mutate(preview);
      }, (full, keyOf) => {
        filesKey = keyOf;
        rememberView(key.id, full, keyOf);
      });
      return loaded ?? peekView(props.id)?.view;
    },
    opening ? { initialValue: opening.view } : undefined,
  );
  const [maxSeq, { refetch: refetchSeq }] = createResource(() => props.id, readHead);

  /**
   * The trace's event store: paged on open, appended to as the head advances,
   * thrown away when the epoch bumps. Fetches nothing while the trace is off.
   */
  const trace = createTraceData({
    sessionId: () => props.id,
    head: () => maxSeq(),
    epoch: traceEpoch,
    enabled: traceOn,
  });
  /** the block behind the drawer — resolved by key so live data flows in */
  const traceBlock = createMemo(() => {
    const key = traceKey();
    if (!key) return null;
    return trace.blocks().find((b) => b.key === key) ?? null;
  });
  const traceParent = createMemo(() => {
    const b = traceBlock();
    return b?.parentKey ? trace.blocks().find((x) => x.key === b.parentKey) : undefined;
  });
  /** idle time between the previous block's end and the selected one's start */
  const traceGap = createMemo(() => {
    const b = traceBlock();
    if (!b) return undefined;
    const all = trace.blocks();
    const i = all.indexOf(b);
    if (i <= 0) return undefined;
    return Math.max(0, b.startTs - all[i - 1]!.endTs);
  });

  // Keyboard selection moves fast; the replay view fetch must not fire per
  // keypress. The key is stored at once, the fetch is debounced.
  let replayTimer: ReturnType<typeof setTimeout> | undefined;
  const requestReplay = (seq: number, debounce: boolean) => {
    clearTimeout(replayTimer);
    replayTimer = undefined;
    if (debounce) replayTimer = setTimeout(() => setReplayPos(seq), 120);
    else setReplayPos(seq);
  };
  const clearReplay = () => {
    clearTimeout(replayTimer);
    replayTimer = undefined;
    setReplayPos(null);
  };
  onCleanup(() => clearTimeout(replayTimer));

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
  // Live machine state, not part of the record: it shows only while the
  // session's OpenCode backend is connected, and follows a checkout made
  // outside strata once the window comes back.
  const [vcs, { refetch: refetchVcs }] = createResource(
    () => props.id,
    (id) => readVcs(id).catch(() => undefined),
  );
  const [asks, { refetch: refetchAsks }] = createResource(
    () => props.id,
    async () => {
      const r = await getJson<{ pending: PendingAsk[] }>("/permissions");
      return r.pending;
    },
  );
  /**
   * The sessions this one opened, which the sidebar does not show.
   *
   * Their prompts are the reader's to answer all the same: a subagent waiting
   * on an ask stops the conversation they are in, and from here the run simply
   * stops moving. Judged from the list, so a new subagent is picked up the
   * moment it appears.
   */
  const descendants = createMemo(() => descendantSessions(props.sessions, props.id));
  const mine = (sessionId: string) => sessionId === props.id || descendants().has(sessionId);
  /** The subagent's own name, for a card that is not this session's. */
  const asksFrom = (sessionId: string): string | undefined => {
    if (sessionId === props.id) return undefined;
    const row = props.sessions.find((s) => s.summary.session_id === sessionId);
    return row?.title ?? row?.summary.title ?? undefined;
  };
  const [hiddenAsks, setHiddenAsks] = createSignal<ReadonlySet<string>>(new Set());
  const unhideAsk = (request_id: string) =>
    setHiddenAsks((cur) => {
      const next = new Set(cur);
      next.delete(request_id);
      return next;
    });
  const [questions, { refetch: refetchQuestions }] = createResource(
    () => props.id,
    async () => {
      const r = await getJson<{ pending: (PendingQuestion & { session_id: string })[] }>(
        "/questions",
      );
      return r.pending;
    },
  );
  const openQuestions = () => (settled(questions) ?? []).filter((q) => mine(q.session_id ?? props.id));
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
  const autoAcceptOn = () => autoAccept() === "auto";
  const toggleAutoAccept = async () => {
    const next = autoAcceptOn() ? "inherit" : "auto";
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
        await respondPermission(request_id, "allow", "once").catch((err) => {
          // 404 is already gone. 409 is already being submitted — a second
          // click, or this switch racing the card. Neither is a failure to
          // put back on screen. Anything else is, and the card comes back.
          const settled = err instanceof Error && /\b(404|409)\b/.test(err.message);
          if (!settled) unhideAsk(request_id);
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

  let list: TranscriptApi | undefined;

  /**
   * One panel on the right, opened only by the reader. Trace and replay step
   * out of the way while it is open, and the choice persists across sessions.
   */
  const openPanel = (tab?: SidePanelTab) => {
    setTraceKey(null);
    clearReplay();
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
        } else {
          const id = props.id;
          const outcome = await viewLoader.refreshTail(id, filesKey, () => settled(view) ?? current, (next, keyOf, changed) => {
            filesKey = keyOf;
            if (changed) mutate(next);
            rememberView(id, next, keyOf);
          });
          if (!viewAlive || replayPos() !== null || outcome === "stale") return;
          if (outcome === "full") {
            filesKey = undefined;
            wantFull = true;
            continue;
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

  /**
   * Commands the slash menu shows on top of the backend's own: the session
   * actions a CLI keyboard user expects (`/compact`, `/undo`, …), which the
   * backend never lists because they are client actions over plain endpoints,
   * not prompt templates. `commands()` still reports the backend list on its
   * own for anything that wants it unmerged.
   */
  const BUILTIN_DESC: Record<string, () => string> = {
    compact: () => t("cmd.compact"),
    summarize: () => t("cmd.compact"),
    undo: () => t("cmd.undo"),
    redo: () => t("cmd.redo"),
    interrupt: () => t("cmd.interrupt"),
    fork: () => t("cmd.fork"),
    rename: () => t("cmd.rename"),
    share: () => t("cmd.share"),
    unshare: () => t("cmd.unshare"),
    export: () => t("cmd.export"),
    new: () => t("cmd.new"),
    terminal: () => t("cmd.terminal"),
  };
  const targets = createMemo(() => {
    // Until capabilities answer, the owner is unknown, and the menu would
    // offer the backend that is already driving the session.
    if (caps.state === "unresolved" || caps.state === "pending") return [];
    return handoffTargets(
      (props.connections ?? []).map((connection) => ({
        id: connection.id,
        label: connection.name?.trim() || backendLabel(connection.backend),
        detail: connection.baseUrl,
        prompt: connection.capabilities?.prompt === true,
      })),
      caps()?.connection_id,
    );
  });
  const slashCommands = createMemo((): CommandInfo[] | undefined => {
    const c = caps();
    // A stored session whose backend is gone can still be handed off. The
    // slash menu used to wait until a backend was driving this session, which
    // hid the one command that exists for that case.
    const receiving = targets();
    if (!c?.connected && receiving.length === 0) return undefined;
    const v = settled(view);
    const local = builtinCommands({
      summarize: c?.summarize,
      revert: c?.revert,
      reverted: Boolean(v?.revert_turn_id),
      abort: c?.abort,
      fork: c?.fork,
      handoff: receiving.length > 0,
      hasTurns: (v?.turns.length ?? 0) > 0,
      manage: c?.manage,
      share: c?.share,
      terminal: opencode(),
    }).map((name): CommandInfo => ({
      name,
      source: "builtin",
      description:
        name === "handoff"
          ? receiving.length === 1
            ? t("cmd.handoff.one", { name: receiving[0]!.label })
            : t("cmd.handoff.many", { names: receiving.map((target) => target.label).join(", ") })
          : BUILTIN_DESC[name]?.(),
      argument: name === "handoff" && receiving.length !== 1,
    }));
    return [...local, ...(c?.connected ? (commands() ?? []) : [])];
  });

  const runBuiltin = async (name: string, arg: string): Promise<void> => {
    switch (name) {
      case "compact":
      case "summarize": {
        const sel = composer.modelSel();
        const slash = sel.indexOf("/");
        const model = slash > 0 ? { providerID: sel.slice(0, slash), modelID: sel.slice(slash + 1) } : undefined;
        await summarizeSession(props.id, model);
        return;
      }
      case "undo": {
        // The CLI's undo: stop a run in flight first so the revert lands on a
        // settled session, then hand the text back to the composer rather than
        // resending it — editing before resend is the whole point.
        const last = [...(settled(view)?.turns ?? [])]
          .reverse()
          .find((turn) => !turn.reverted && turn.user && messageText(turn.user).trim() !== "");
        if (!last) throw new Error(t("cmd.undo.none"));
        if (composer.generating()) await abortSession(props.id);
        await revertSession(props.id, last.turn_id);
        composer.setDraft(messageText(last.user ?? []));
        queueMicrotask(() => composer.autogrow());
        return;
      }
      case "redo":
        await unrevertSession(props.id);
        return;
      case "interrupt":
        await composer.stop();
        return;
      case "handoff": {
        const list = targets();
        const target = resolveHandoff(list, arg);
        if (!target) {
          throw new Error(
            list.length === 0
              ? t("cmd.handoff.none")
              : t("cmd.handoff.missing", { names: list.map((item) => item.label).join(", ") }),
          );
        }
        const id = await handoffSession(props.id, target.id);
        location.hash = `/session/${encodeURIComponent(id)}`;
        return;
      }
      case "fork": {
        if (!settled(view)?.turns.length) throw new Error(t("cmd.fork.none"));
        const id = await forkSession(props.id, "all");
        location.hash = `/session/${encodeURIComponent(id)}`;
        return;
      }
      case "rename": {
        const title = arg.trim();
        if (!title) throw new Error(t("cmd.rename.missing"));
        await renameSession(props.id, title);
        return;
      }
      case "share": {
        const url = await shareSession(props.id);
        composer.setNotice(url && (await copyText(url)) ? t("cmd.share.copied") : url || t("cmd.share.done"));
        return;
      }
      case "unshare":
        await unshareSession(props.id);
        composer.setNotice(t("cmd.share.removed"));
        return;
      case "export":
        await downloadExport(props.id);
        return;
      case "terminal":
        setTerminalOn((on) => !on);
        return;
      case "new":
        props.onNewSession();
        return;
    }
  };

  const displayed = createMemo(() => {
    const v = settled(view);
    if (v?.session_id === props.id) return v;
    return peekView(props.id)?.view;
  });
  const viewReady = createMemo(() => {
    const id = props.id;
    return displayed()?.session_id === id;
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
  let panelTriggerEl: HTMLButtonElement | undefined;
  useDismiss(search.searchOpen, search.closeSearch, () => searchPanelEl, () => searchTriggerEl);
  useDismiss(tools.toolsOpen, tools.closeTools, () => toolsPanelEl, () => toolsTriggerEl);

  // `displayed` is already created. `turns` is not: this memo runs at once,
  // and calling `turns()` here threw before the binding existed, which aborted
  // the render and left every later click, including settings, with nowhere to go.
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
 * The view on screen. The resource keeps the previous session until the next
 * fetch resolves, and the route changes before that fetch does. A list painted
 * from the stale view is the wrong conversation at the wrong heights. The
 * cache already has the session the pane was showing, so use that until the
 * resource catches up. `displayed` itself is created above, before the
 * composer, so the composer can read it while it is setting up.
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
    activeSessionId = id;
    const hit = peekView(id);
    filesKey = hit?.filesKey;
    forceFull = false;
    retries = 0;
    setImporting(!hit);
    if (hit) mutate(hit.view);
    clearReplay();
    setTraceOn(false);
    setTraceKey(null);
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
      if (after !== before) {
        setTraceEpoch((e) => e + 1);
        void refreshView(true);
      }
      void refetchSeq();
    })();
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
      if (after !== before) {
        setTraceEpoch((e) => e + 1);
        void refreshView(true);
      }
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
            if (evt.session_id === props.id && evt.type === "session.rebuilt") {
              rebuilt = true;
              setTraceEpoch((e) => e + 1);
            }
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

  const respond = async (requestId: string, decision: "allow" | "deny", scope?: "once" | "always") => {
    setHiddenAsks((cur) => new Set(cur).add(requestId));
    try {
      await respondPermission(requestId, decision, scope);
    } catch (err) {
      const missing = err instanceof Error && /\b(404|409)\b/.test(err.message);
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
      if (!mine(ask.session_id)) return false;
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

  /**
   * The auto-accept switch.
   *
   * It lives in the composer's footer now, beside attach, because that is the
   * question it answers: it decides whether what this message goes out is
   * allowed to run without stopping to ask. The eye is already there, next to
   * the send button the reader is about to press, so "is this one going to ask
   * me?" is answerable before they press it rather than after they scroll back
   * up to a header icon.
   *
   * Amber when it is on, like the permission cards it stands for. Red when the
   * state cannot be read — a switch that might be on and reads as off is the one
   * state worth interrupting the reader for. Unlit when it is off, because off
   * is the ordinary case and should not compete with the send button.
   */
  const autoAcceptToggle = () => (
    <Tip
      label={
        autoAcceptErr() ||
        (autoAccept() === "unknown"
          ? t("header.autoAccept.broken")
          : t(autoAcceptOn() ? "header.autoAccept.on" : "header.autoAccept.off"))
      }
    >
      <Button
        type="button"
        size="icon-sm"
        variant="icon"
        aria-pressed={autoAcceptOn()}
        aria-label={t("header.autoAccept")}
        class={`shrink-0 transition-colors ${
          autoAcceptErr() || autoAccept() === "unknown"
            ? "text-destructive"
            : autoAcceptOn()
              ? "text-event-permission"
              : "text-muted-foreground"
        }`}
        onClick={() => void toggleAutoAccept()}
      >
        <Icon name="shield" class="size-4" />
      </Button>
    </Tip>
  );

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
              <DragBar />
              <Show
                when={view.error}
                fallback={
                  <>
                    <div class="flex h-9 shrink-0 items-center border-b border-border px-4">
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
                class="@container flex h-9 shrink-0 items-center gap-2 border-b border-border px-4 select-none"
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
                            class="h-auto max-w-48 shrink-0 px-0 py-0 text-sm"
                            onClick={() => {
                              location.hash = `/session/${encodeURIComponent(parentId())}`;
                            }}
                          >
                            {/* The ellipsis belongs on the label: the button
                                centres what it holds, so a long parent name
                                was cut at both ends rather than at the end. */}
                            <span class="min-w-0 truncate">{parent()?.title || t("session.child.back")}</span>
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
                      branch in the session-details popover, the workspace in
                      the sidebar). Before this the title reached 0px at the
                      window's 960px minimum and the session you were reading
                      had no name on screen. */}
                  <h1
                    class="min-w-24 flex-1 truncate text-sm font-medium"
                    title={displayTitle(v().title) ?? t("session.untitled")}
                  >
                    {displayTitle(v().title) ?? t("session.untitled")}
                  </h1>
                  <Show when={realWorkspace(v().workspace)}>
                    {(ws) => (
                      <span
                        class="max-w-40 shrink-0 truncate font-mono text-2xs text-muted-foreground @max-[440px]:hidden"
                        title={ws()}
                      >
                        {folderLabel(ws())}
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
                  <Show when={v().totals.cost_usd > 0}>
                    <Tip
                      label={t("header.cost.tip", { amount: fmtUsd(v().totals.cost_usd) })}
                      class="@max-[440px]:hidden"
                    >
                      <span class="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
                        {fmtUsd(v().totals.cost_usd)}
                      </span>
                    </Tip>
                  </Show>
                </div>
                <span class="flex shrink-0 items-center gap-0.5">
                  <Tip label={t("session.search.tip", { shortcut: findKey() })}>
                  <PanelToggle
                    label={t("session.search.label")}
                    on={search.searchOpen()}
                    expanded={search.searchOpen()}
                    onClick={() => (search.searchOpen() ? search.closeSearch() : search.openSearch())}
                    bindRef={(el) => (searchTriggerEl = el)}
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
                          setTraceKey(null);
                          clearReplay();
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
                        bindRef={(el) => (toolsTriggerEl = el)}
                      >
                        <span class="relative inline-flex">
                          <Icon name="plug" />
                          <McpAttentionMark tone={tools.attention()} />
                        </span>
                      </PanelToggle>
                    </Tip>
                  </Show>
                  {/* Two clusters: the four to the left open surfaces that
                      inspect this transcript (find, terminal, trace, tools);
                      the rest drive the session itself (pane layout, export,
                      and the changes-and-files panel). One hairline between
                      them keeps the buttons from reading as a wall. */}
                  <span class="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden="true" />
                  <LayoutSwitcher
                    workspace={paneWorkspace()}
                    onPreset={handleSelectPreset}
                    onSplit={(dir) => handleSplitPane(paneWorkspace().focusedPaneId, dir)}
                    onToggleZoom={() => handleToggleZoom(paneWorkspace().focusedPaneId)}
                  />
                  <Tip label={t("header.export")}>
                    <Button
                      type="button"
                      variant="icon"
                      size="icon-sm"
                      aria-label={t("header.export")}
                      onClick={() =>
                        void downloadExport(v().session_id).catch((err) =>
                          composer.setSendErr(err instanceof Error ? err.message : t("err.network")),
                        )
                      }
                    >
                      <Icon name="export" class="size-4 text-muted-foreground" />
                    </Button>
                  </Tip>
                  {/*
                   * The changes-and-files panel opens from here rather than from
                   * a strip on the right edge.
                   *
                   * That strip was 24 pixels wide and permanently on screen, and
                   * all it ever said was that something optional existed on the
                   * other side of it. It held a 288px panel's worth of visual
                   * weight to advertise 288px. A button in this row says the
                   * same thing from where the reader's eye already is, and the
                   * reading column gets a hairline back.
                   *
                   * The mark says "panel", not "files": it is the fold button
                   * for this side of the window, and the window's other side
                   * has one drawn the same way. The drawer still holds files,
                   * but what this button does is open a side.
                   */}
                  <Tip label={t(panelVisible() ? "panel.hide" : "panel.show")}>
                    <PanelToggle
                      label={t(panelVisible() ? "panel.hide" : "panel.show")}
                      on={panelVisible()}
                      pressed={panelVisible()}
                      bindRef={(el) => (panelTriggerEl = el)}
                      onClick={togglePanel}
                    >
                      <Icon name="panel-right" />
                    </PanelToggle>
                  </Tip>
                </span>
              </header>

              <ChildBoard parentId={props.id} sessions={props.sessions} />

              <Show when={search.searchOpen()}>
                <SearchPanel search={search} bindPanel={(el) => (searchPanelEl = el)} />
              </Show>

              <Show when={tools.toolsOpen()}>
                <McpToolsPanel tools={tools} lsp={lspServers} bindPanel={(el) => (toolsPanelEl = el)} />
              </Show>

              <Show when={traceOn()}>
                <TracePanel
                  blocks={trace.blocks()}
                  loading={trace.loading()}
                  selected={traceKey()}
                  onSelect={(block, opts) => {
                    if (traceKey() === block.key) {
                      setTraceKey(null);
                      clearReplay();
                      return;
                    }
                    setTraceKey(block.key);
                    requestReplay(block.seq, opts?.debounce === true);
                  }}
                  onClearSelection={() => {
                    setTraceKey(null);
                    clearReplay();
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
                transcriptSessionId={props.id}
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
              <TranscriptView
                paneId={paneWorkspace().focusedPaneId}
                sessionId={displayed()?.session_id ?? props.id}
                turns={turns()}
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
                renderTurn={(turn) => (
                  <TurnBlock
                    turn={turn()}
                    entering={() => shown().arriving.has(turn().turn_id)}
                    live={() => composer.generating() && turns().at(-1)?.turn_id === turn().turn_id}
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
                <div class="shrink-0 bg-gradient-to-t from-background from-70% px-5 pb-5 pt-6">
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
                          from={asksFrom(p.session_id)}
                          onRespond={(id, decision, scope) => void respond(id, decision, scope)}
                        />
                      )}
                    </For>
                    <For each={openQuestions()}>
                      {(q) => (
                        <QuestionCard
                          q={q}
                          from={asksFrom(q.session_id ?? props.id)}
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
                    <Show when={caps()?.connected === false}>
                      <p class="mb-1.5 flex items-center gap-1.5 px-1 text-2xs text-status-cancelled">
                        <Icon name="plug" class="size-3 shrink-0" />
                        {t("composer.disconnected")}
                      </p>
                    </Show>
                    <SessionComposer
                      c={composer}
                      sessionId={() => props.id}
                      plan={v().plan}
                      title={v().title}
                      permission={autoAcceptToggle}
                      goal={v().goal}
                      goalMet={v().goal_met}
                      goalPaused={v().goal_paused}
                    />
                  </div>
                </div>
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
            onClose={() => {
              setTraceKey(null);
              clearReplay();
            }}
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
            onJumpToTurn={(i) => {
              if (i >= 0) list?.jumpToIndex(i);
            }}
            onCite={composer.citeLine}
          />
        )}
      </Show>
    </div>
  );
}
