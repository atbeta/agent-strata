import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  abortSession,
  api,
  fmtUsd,
  getJson,
  importSession,
  realWorkspace,
  respondPermission,
  respondQuestion,
  searchSession,
  type OptionsResponse,
  type PendingAsk,
  type PendingQuestion,
  type SearchHit,
  type SessionView,
} from "./api";
import { Icon } from "./icons";
import { DiffBlock } from "./diff";
import { num, t, tn } from "./i18n";
import { DragBar } from "./chrome";
import { inDesktopShell, shellPlatform } from "./shell";
import { Tip } from "./tip";
import { TraceDrawer, TraceStrip, type TraceBlock } from "./trace";
import { TurnBlock } from "./transcript";
import { Virtual, type VirtualApi } from "./virtual";
import { applyStreamingSnapshot, type StreamingSnapshot } from "./live";
import { Picker } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** An errored Solid resource throws when read, which unmounts the whole window. */
function settled<T>(resource: { error: unknown; (): T | undefined }): T | undefined {
  return resource.error ? undefined : resource();
}
import {
  navigateHistory,
  readDraft,
  readHistory,
  rememberPrompt,
  sessionContext,
  writeDraft,
  writeHistory,
} from "./prompt-memory";

function QuestionCard(props: { q: PendingQuestion; onDone: () => void }) {
  const [picks, setPicks] = createSignal<string[][]>(props.q.questions.map(() => []));
  const [custom, setCustom] = createSignal<string[]>(props.q.questions.map(() => ""));
  const [err, setErr] = createSignal("");

  const toggle = (qi: number, label: string, multiple?: boolean) => {
    setPicks((all) =>
      all.map((cur, i) => {
        if (i !== qi) return cur;
        if (multiple) return cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label];
        return cur[0] === label ? [] : [label];
      }),
    );
  };

  const answers = () =>
    props.q.questions.map((question, i) => {
      const selected = picks()[i] ?? [];
      const extra = custom()[i]?.trim();
      if (selected.length && extra && question.custom) return [...selected, extra];
      if (selected.length) return selected;
      return extra ? [extra] : [];
    });

  const submit = async () => {
    if (answers().some((a) => a.length === 0)) {
      setErr(t("question.err.answer_each"));
      return;
    }
    setErr("");
    await respondQuestion(props.q.request_id, "reply", answers());
    props.onDone();
  };

  return (
    <div class="rounded-xl border border-event-permission/40 bg-event-permission/10 p-4">
      <For each={props.q.questions}>
        {(question, qi) => (
          <div class={qi() > 0 ? "mt-4 border-t border-border/60 pt-4" : ""}>
            <div class="text-2xs font-medium uppercase tracking-wide text-event-permission">
              {question.header}
            </div>
            <p class="mt-1 text-sm">{question.question}</p>
            <div class="mt-2 flex flex-wrap gap-1.5">
              <For each={question.options}>
                {(opt) => {
                  const on = () => (picks()[qi()] ?? []).includes(opt.label);
                  return (
                    <Tip label={opt.description}>
                      <button
                        class={`rounded-full px-3 py-1 text-xs transition-colors ${
                          on()
                            ? "bg-primary text-primary-foreground"
                            : "bg-secondary text-foreground hover:bg-accent"
                        }`}
                        onClick={() => toggle(qi(), opt.label, question.multiple)}
                      >
                        {opt.label}
                      </button>
                    </Tip>
                  );
                }}
              </For>
            </div>
            <Show when={question.custom}>
              <input
                class="mt-2 w-full rounded-md border border-input bg-background/50 px-2.5 py-1.5 text-sm focus:border-ring focus:outline-none"
                placeholder={t("question.placeholder.custom")}
                value={custom()[qi()] ?? ""}
                onInput={(e) =>
                  setCustom((all) => all.map((v, i) => (i === qi() ? e.currentTarget.value : v)))
                }
              />
            </Show>
          </div>
        )}
      </For>
      <div class="mt-3 flex items-center gap-2">
        <button
          class="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
          onClick={() => void submit()}
        >
          {t("question.reply")}
        </button>
        <button
          class="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => void respondQuestion(props.q.request_id, "reject").then(props.onDone)}
        >
          {t("question.dismiss")}
        </button>
        <Show when={err()}>
          <span class="text-xs text-destructive">{err()}</span>
        </Show>
      </div>
    </div>
  );
}

function sessionModel(v: SessionView | undefined): string | undefined {
  const turns = v?.turns ?? [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const assistant = turns[i]!.assistant;
    for (let j = assistant.length - 1; j >= 0; j--) {
      if (assistant[j]?.model) return assistant[j]!.model;
    }
  }
  return undefined;
}

function splitModel(id: string): { providerID: string; modelID: string } | undefined {
  const i = id.indexOf("/");
  if (i <= 0) return undefined;
  return { providerID: id.slice(0, i), modelID: id.slice(i + 1) };
}

function LoadingTranscript() {
  return (
    <div class="mx-auto w-full max-w-3xl space-y-4 px-5 py-8">
      <div class="ml-auto h-10 w-2/3 animate-pulse rounded-2xl bg-secondary/80" />
      <div class="h-4 w-5/6 animate-pulse rounded bg-secondary/50" />
      <div class="h-4 w-2/3 animate-pulse rounded bg-secondary/40" />
    </div>
  );
}

function fileName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) || path;
}

/** Ctrl on a PC, ⌘ on a Mac. The tooltip used to say "Ctrl+F" on every platform. */
function findKey(): string {
  return shellPlatform() === "macos" ? "⌘F" : "Ctrl+F";
}

/** How a file changed. The wire values are `add`/`modify`/`delete`; these are labels. */
function changeWord(change: string): string {
  if (change === "add") return t("file.added");
  if (change === "delete") return t("file.deleted");
  return t("file.edited");
}

function ContextRing(props: { percent: number | null }) {
  const length = 2 * Math.PI * 6;
  // Read props inside JSX. A const captured on first run stays at 0, because
  // the context window arrives after the transcript.
  const tone = () =>
    props.percent == null
      ? "text-muted-foreground"
      : props.percent >= 90
        ? "text-destructive"
        : props.percent >= 75
          ? "text-status-cancelled"
          : "text-foreground";
  return (
    <svg viewBox="0 0 16 16" class={`size-4 ${tone()}`} aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" class="stroke-border" stroke-width="2" />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-dasharray={`${(Math.max(0, Math.min(100, props.percent ?? 0)) / 100) * length} ${length}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

/** A filled bar reads faster than the ring once the number is spelled out. */
function ContextBar(props: { percent: number | null }) {
  const width = () => `${Math.max(0, Math.min(100, props.percent ?? 0))}%`;
  const tone = () =>
    props.percent == null
      ? "bg-border"
      : props.percent >= 90
        ? "bg-destructive"
        : props.percent >= 75
          ? "bg-status-cancelled"
          : "bg-foreground";
  return (
    <div class="h-1.5 w-full overflow-hidden rounded-full bg-border">
      <div class={`h-full rounded-full transition-[width] ${tone()}`} style={{ width: width() }} />
    </div>
  );
}

/** Label / value row in the session details panel. */
function InfoRow(props: { label: string; value: string; mono?: boolean; tone?: string }) {
  return (
    <div class="flex items-baseline justify-between gap-6 py-1">
      <span class="text-xs text-muted-foreground">{props.label}</span>
      <span
        class={`text-xs tabular-nums ${props.mono ? "font-mono" : ""} ${props.tone ?? "text-foreground"}`}
      >
        {props.value}
      </span>
    </div>
  );
}

/**
 * The context ring, made into the entry point for everything about the session
 * that is not the transcript: context use, token breakdown, and cost. Cost
 * used to sit in the header as bare text where it read as clutter next to the
 * window caption; here it has room to be a real number.
 */
function SessionInfo(props: {
  totals: SessionView["totals"];
  context: { total: number; percent: number | null } | undefined;
  model: string;
  backend: string;
  status: string;
  workspace?: string;
}) {
  const contextLimit = () => {
    if (!props.context || props.context.percent == null || props.context.total <= 0) return null;
    return Math.round(props.context.total / (props.context.percent / 100));
  };

  return (
    <div class="w-72">
      <div class="mb-2 text-sm font-medium">{t("info.session")}</div>

      <div class="rounded-md border border-border bg-secondary/40 p-2.5">
        <div class="flex items-baseline justify-between">
          <span class="text-xs text-muted-foreground">{t("info.context")}</span>
          <span class="font-mono text-xs tabular-nums text-foreground">
            {props.context
              ? props.context.percent == null
                ? `${num(props.context.total)} tok`
                : `${props.context.percent}%`
              : "—"}
          </span>
        </div>
        <div class="mt-2">
          <ContextBar percent={props.context?.percent ?? null} />
        </div>
        <div class="mt-1.5 flex items-baseline justify-between text-2xs text-muted-foreground">
          <span>
            {props.context ? `${num(props.context.total)} tokens` : t("info.context.none")}
          </span>
          <Show when={contextLimit()}>
            <span class="font-mono">{t("info.context.of", { n: num(contextLimit()!) })}</span>
          </Show>
        </div>
      </div>

      <div class="mt-3 divide-y divide-border border-t border-border">
        <InfoRow label={t("info.model")} value={props.model || "—"} mono />
        <InfoRow label={t("info.cost")} value={fmtUsd(props.totals.cost_usd)} mono />
        <InfoRow label={t("info.input")} value={num(props.totals.input)} mono />
        <InfoRow label={t("info.output")} value={num(props.totals.output)} mono />
        <Show when={props.totals.reasoning > 0}>
          <InfoRow label={t("info.reasoning")} value={num(props.totals.reasoning)} mono />
        </Show>
        <Show when={props.totals.cache_read > 0}>
          <InfoRow label={t("info.cache_read")} value={num(props.totals.cache_read)} mono />
        </Show>
        <InfoRow
          label={t("info.tool_calls")}
          value={`${props.totals.tool_calls}${props.totals.tool_errors ? ` · ${t("info.tool_calls.failed", { n: num(props.totals.tool_errors) })}` : ""}`}
          mono
          tone={props.totals.tool_errors > 0 ? "text-status-error" : undefined}
        />
        <InfoRow label={t("info.status")} value={props.status} />
        <InfoRow label={t("info.backend")} value={props.backend} mono />
        <Show when={props.workspace}>
          <InfoRow label={t("info.workspace")} value={props.workspace!} mono />
        </Show>
      </div>
    </div>
  );
}

/** Newest sequence number for a session, or 0. Covers (session_id, seq), so this is an index probe. */
async function readHead(id: string): Promise<number> {
  const r = await getJson<{ events: { seq: number }[] }>(
    `/events?session_id=${encodeURIComponent(id)}&order=desc&limit=1`,
  );
  return r.events[0]?.seq ?? 0;
}

/**
 * A search result's context. FTS brackets the terms it matched, and splitting
 * on those brackets is what makes a hit findable at a glance — a snippet of
 * transcript prose with no marker on the word the reader searched for is just
 * more text to read.
 */
function Snippet(props: { text: string }) {
  const parts = () => props.text.split(/(\[[^\]]*\])/g).filter(Boolean);
  return (
    <span class="line-clamp-2 text-xs leading-5 text-foreground/85">
      <For each={parts()}>
        {(s) =>
          s.startsWith("[") && s.endsWith("]") ? (
            <mark class="rounded-sm bg-primary/20 px-0.5 text-foreground">{s.slice(1, -1)}</mark>
          ) : (
            s
          )
        }
      </For>
    </span>
  );
}

export function SessionDetail(props: { id: string }) {
  const [replayPos, setReplayPos] = createSignal<number | null>(null);
  const [traceOn, setTraceOn] = createSignal(false);
  const [traceBlock, setTraceBlock] = createSignal<TraceBlock | null>(null);
  const [railForced, setRailForced] = createSignal(false);
  const [railDismissed, setRailDismissed] = createSignal(false);
  /** which file the reader opened in the rail, null for the plain list */
  const [openFile, setOpenFile] = createSignal<string | null>(null);
  const [booting, setBooting] = createSignal(true);
  const [modelTouched, setModelTouched] = createSignal(false);
  const [view, { refetch, mutate }] = createResource(
    () => ({ id: props.id, pos: replayPos() }),
    ({ id, pos }) =>
      getJson<SessionView>(
        `/sessions/${encodeURIComponent(id)}/view${pos === null ? "" : `?until_seq=${pos}`}`,
      ),
  );
  const [maxSeq, { refetch: refetchSeq }] = createResource(() => props.id, readHead);
  const [asks, { refetch: refetchAsks }] = createResource(
    () => props.id,
    async (id) => {
      const r = await getJson<{ pending: PendingAsk[] }>("/permissions");
      return r.pending.filter((p) => p.session_id === id);
    },
  );
  const [questions, { refetch: refetchQuestions }] = createResource(
    () => props.id,
    async (id) => {
      const r = await getJson<{ pending: (PendingQuestion & { session_id: string })[] }>(
        "/questions",
      );
      return r.pending.filter((p) => p.session_id === id);
    },
  );
  const [draft, setDraft] = createSignal(readDraft(props.id));
  const [queued, setQueued] = createSignal<string[]>([]);
  const [histIndex, setHistIndex] = createSignal(-1);
  const [histSaved, setHistSaved] = createSignal("");
  const [sendErr, setSendErr] = createSignal("");
  const [stopping, setStopping] = createSignal(false);
  const [pendingSend, setPendingSend] = createSignal(false);
  const [options, { refetch: refetchOptions }] = createResource(() =>
    getJson<OptionsResponse>("/options"),
  );
  const [modelSel, setModelSel] = createSignal("");
  const [agentSel, setAgentSel] = createSignal("");
  const [variantSel, setVariantSel] = createSignal("");
  let draftEl: HTMLTextAreaElement | undefined;
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

  // Full-text search inside the open session. This is not a convenience: the
  // transcript is windowed, so the reader's own Ctrl+F only sees the rows that
  // happen to be mounted. Searching has to go to the index to reach the rest.
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [hitAt, setHitAt] = createSignal(0);
  const [probe, setProbe] = createSignal("");
  let searchEl: HTMLInputElement | undefined;
  let resultsEl: HTMLUListElement | undefined;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let list: VirtualApi | undefined;

  const onQuery = (v: string) => {
    setQuery(v);
    clearTimeout(probeTimer);
    // Every keystroke that reached the index would be a round trip; the index
    // is fast but the network round trip is not, and the answer only has to be
    // right by the time the reader stops typing.
    probeTimer = setTimeout(() => setProbe(v.trim()), 180);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
    setProbe("");
    setHitAt(0);
  };

  const [result] = createResource(
    () => (searchOpen() && probe() ? { id: props.id, q: probe() } : null),
    ({ id, q }) => searchSession(id, q),
  );
  const hits = () => result()?.hits;

  /**
 * Where a hit lives: a tool result carries no turn of its own — the projector
 * binds it to one through the call that produced it — so a match on tool output
 * is traced back through that call. The transcript in hand already holds that
 * mapping, so resolving costs nothing and needs no second request.
 */
const turnIndexOf = (h: SearchHit): number => {
    const turns = settled(view)?.turns;
    if (!turns) return -1;
    if (h.turn_id) return turns.findIndex((t) => t.turn_id === h.turn_id);
    if (h.call_id) return turns.findIndex((t) => t.tool_calls.some((c) => c.call_id === h.call_id));
    return -1;
  };

  /**
   * One jump target per turn, and only turns a hit can actually be walked to.
   * The index answers in relevance order, which is no order at all to a reader:
   * the first few turns for one term came back 97, 125, 949, 83, 1087. Stepping
   * through matches is a walk down a conversation, so they are sorted into it.
   */
  const targets = createMemo(() => {
    const seen = new Set<string>();
    const out: { hit: SearchHit; at: number }[] = [];
    for (const h of hits() ?? []) {
      const at = turnIndexOf(h);
      if (at < 0) continue;
      const k = settled(view)?.turns[at]?.turn_id ?? `#${h.seq}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ hit: h, at });
    }
    return out.sort((a, b) => a.at - b.at).map((x) => x.hit);
  });

  const goTo = (h: SearchHit | undefined) => {
    const i = h ? turnIndexOf(h) : -1;
    if (i >= 0) list?.scrollToIndex(i);
  };

  /** Turns are addressed by an opaque id, so a result has to say which one it is. */
  const turnNumber = (h: SearchHit) => turnIndexOf(h) + 1;

  const step = (delta: number) => {
    const all = targets();
    if (!all.length) return;
    const next = Math.max(0, Math.min(all.length - 1, hitAt() + delta));
    setHitAt(next);
    goTo(all[next]);
  };

  const openSearch = (keep?: string) => {
    setSearchOpen(true);
    if (keep) onQuery(keep);
    queueMicrotask(() => searchEl?.focus());
  };

  // Stepping through matches moves the selection much faster than a list this
  // long scrolls on its own, so the active row is pulled into view. Without
  // this the counter reads "26/26" above a list still showing the first four.
  createEffect(() => {
    const at = hitAt();
    resultsEl?.querySelector(`[data-hit="${at}"]`)?.scrollIntoView({ block: "nearest" });
  });

  createEffect(() => {
    const agents = settled(options)?.agents ?? [];
    if (!agentSel() && agents[0]) setAgentSel(agents[0].name);
  });

  createEffect(() => {
    if (modelTouched()) return;
    const inherited = sessionModel(settled(view));
    if (inherited) {
      setModelSel(inherited);
      return;
    }
    if (booting() || !settled(view)) return;
    const models = settled(options)?.models ?? [];
    if (models[0]) setModelSel(`${models[0].providerID}/${models[0].modelID}`);
  });

  const selectedModel = () =>
    settled(options)?.models.find((m) => `${m.providerID}/${m.modelID}` === modelSel());
  // empty model means "server default"; still offer that leading model's efforts
  const effortModel = () =>
    selectedModel() ?? settled(options)?.models.find((m) => (m.variants?.length ?? 0) > 0);
  const modelOptions = () => {
    const models = settled(options)?.models ?? [];
    const known = new Set(models.map((m) => `${m.providerID}/${m.modelID}`));
    // A session can name a model the server no longer lists. Keep it selectable
    // rather than silently snapping the composer to something else.
    const stale =
      modelSel() && !known.has(modelSel())
        ? [
            {
              value: modelSel(),
              label: modelSel().slice(modelSel().indexOf("/") + 1),
              group: "Unavailable",
            },
          ]
        : [];
    return [
      ...stale,
      ...models.map((m) => ({
        value: `${m.providerID}/${m.modelID}`,
        label: m.modelID,
        group: m.providerID,
      })),
    ];
  };
  const generating = () =>
    pendingSend() ||
    !!settled(view)?.busy ||
    !!settled(view)?.turns.some((t) => t.assistant.some((a) => a.partial));

  /**
   * The prompt has been handed over but the agent has not produced a thing
   * yet. That gap is a round trip through the backend, and until it closes the
   * transcript is a column of nothing below the question just asked — which
   * reads as a hang rather than as work. The turn itself may not exist yet
   * either, so the answer is "is the newest turn still silent", not a fixed row.
   */
  const lastSilentTurn = createMemo(() => {
    if (!generating()) return undefined;
    const turns = settled(view)?.turns;
    const last = turns?.[turns.length - 1];
    if (last && (last.assistant.length > 0 || last.tool_calls.length > 0)) return undefined;
    return last;
  });

  createEffect(() => writeDraft(props.id, draft()));

  onMount(() => {
    if (draft()) queueMicrotask(autogrow);
    void importSession(props.id)
      .catch(() => {})
      .finally(() => {
        void Promise.resolve(refetch()).finally(() => setBooting(false));
        void refetchSeq();
      });
    const onConns = () => refetchOptions();
    window.addEventListener("strata-connections", onConns);
    // Ctrl+F is the shortcut every reader already has for "find me this in the
    // text I am looking at". Windowing the transcript took that away from them,
    // so it goes to the index instead of to rows that happen to be mounted.
    const onFindKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "f") return;
      e.preventDefault();
      if (searchOpen()) searchEl?.focus();
      else openSearch();
    };
    window.addEventListener("keydown", onFindKey);
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
          void refetch();
          void refetchSeq();
        })
        .catch(() => {});
    }, 3_000);
    const es = new EventSource(api("/stream"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    es.onmessage = (m) => {
      try {
        const evt = JSON.parse(m.data) as {
          session_id?: string;
          type: string;
          data?: { state?: string; partial?: boolean };
        };
        if (evt.session_id === props.id && evt.type === "turn.assistant" && evt.data?.partial === true) {
          if (replayPos() === null) {
            const snap = evt.data as unknown as StreamingSnapshot;
            mutate((v) => (v ? applyStreamingSnapshot(v, snap) : v));
          }
          return;
        }
        if (evt.session_id === props.id && evt.type === "session.status" && evt.data?.state === "idle")
          setPendingSend(false);
        if (evt.session_id === props.id || evt.type === "permission.requested" || evt.type === "question.asked") {
          if (replayPos() === null) {
            clearTimeout(timer);
            timer = setTimeout(() => {
              refetch();
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
      clearTimeout(probeTimer);
      es.close();
      window.removeEventListener("strata-connections", onConns);
      window.removeEventListener("keydown", onFindKey);
    });
  });

  const respond = async (requestId: string, decision: "allow" | "deny") => {
    await respondPermission(requestId, decision);
    refetchAsks();
  };

  const autogrow = () => {
    if (!draftEl) return;
    draftEl.style.height = "auto";
    draftEl.style.height = `${Math.min(draftEl.scrollHeight, 220)}px`;
  };

  const deliver = async (text: string) => {
    setSendErr("");
    setPendingSend(true);
    setHistIndex(-1);
    writeHistory(rememberPrompt(readHistory(), text));
    const picked = selectedModel();
    const implied = !picked && variantSel() ? effortModel() : undefined;
    const source = picked ?? implied;
    const model = source
      ? { providerID: source.providerID, modelID: source.modelID }
      : splitModel(modelSel());
    try {
      const res = await fetch(api(`/sessions/${encodeURIComponent(props.id)}/prompt`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          model,
          agent: agentSel() || undefined,
          variant: variantSel() || undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSendErr(body.error ?? t("err.service", { status: res.status }));
        setDraft(text);
        setPendingSend(false);
      }
    } catch (err) {
      setSendErr(err instanceof Error ? err.message : t("err.network"));
      setDraft(text);
      setPendingSend(false);
    }
  };

  const send = () => {
    const text = draft().trim();
    if (!text) return;
    if (generating()) {
      setQueued((q) => [...q, text]);
      setDraft("");
      setHistIndex(-1);
      if (draftEl) draftEl.style.height = "auto";
      return;
    }
    setDraft("");
    if (draftEl) draftEl.style.height = "auto";
    void deliver(text);
  };

  // A follow-up typed while the agent is running waits here, then goes out
  // on the next idle. deliver() sets pendingSend in the same turn, so this
  // does not drain the rest of the queue until that turn finishes.
  createEffect(() => {
    if (generating() || replayPos() !== null) return;
    const next = queued()[0];
    if (!next) return;
    setQueued((q) => q.slice(1));
    void deliver(next);
  });

  const editQueued = (index: number) => {
    const item = queued()[index];
    if (!item) return;
    const current = draft().trim();
    setQueued((q) => {
      const rest = q.filter((_, i) => i !== index);
      return current ? [...rest, current] : rest;
    });
    setHistIndex(-1);
    setDraft(item);
    queueMicrotask(() => {
      autogrow();
      draftEl?.focus();
    });
  };

  const context = () => {
    const id = modelSel();
    const model = (settled(options)?.models ?? []).find((m) => `${m.providerID}/${m.modelID}` === id);
    return sessionContext(settled(view)?.turns ?? [], model?.context);
  };
  const contextLabel = (total: number, percent: number | null) =>
    percent == null
      ? t("context.none", { n: num(total) })
      : t("context.percent", { percent, n: num(total) });

  const stop = async () => {
    if (stopping()) return;
    setSendErr("");
    setStopping(true);
    try {
      await abortSession(props.id);
      setPendingSend(false);
    } catch (err) {
      setSendErr(err instanceof Error ? err.message : t("err.abort"));
    } finally {
      setStopping(false);
    }
  };

  const hasWork = () => {
    const v = settled(view);
    return !!v && (v.files_changed.length > 0 || (v.plan?.length ?? 0) > 0);
  };
  const railOn = () => !traceBlock() && (railForced() || (hasWork() && !railDismissed()));
  const toggleRail = () => {
    setTraceBlock(null);
    setReplayPos(null);
    if (railOn()) {
      setRailForced(false);
      setRailDismissed(true);
      return;
    }
    setRailDismissed(false);
    setRailForced(true);
  };

  return (
    <div class="flex h-full min-h-0">
      <div class="relative flex min-w-0 flex-1 flex-col">
        <Show
          when={settled(view)}
          fallback={
            <div class="flex h-full min-h-0 flex-col">
              <DragBar />
              <Show
                when={view.error}
                fallback={<LoadingTranscript />}
              >
                <p class="px-8 pt-24 text-sm text-muted-foreground">{t("session.service_unreachable")}</p>
              </Show>
            </div>
          }
        >
          {(v) => (
            <>
              <header
                class="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 select-none"
                data-tauri-drag-region={inDesktopShell() ? "" : undefined}
              >
                <div class="flex min-w-0 flex-1 items-baseline gap-2">
                  <h1 class="min-w-0 truncate text-sm font-medium" title={v().title ?? t("session.untitled")}>
                    {v().title ?? t("session.untitled")}
                  </h1>
                  <Show when={realWorkspace(v().workspace)}>
                    {(ws) => (
                      <span
                        class="max-w-40 shrink-0 truncate font-mono text-2xs text-muted-foreground"
                        title={ws()}
                      >
                        {ws() === "/" || ws() === "\\" ? t("path.root") : ws().split(/[/\\]/).filter(Boolean).at(-1)}
                      </span>
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
                  <button
                    class={`grid h-7 w-7 place-items-center rounded-md transition-colors ${
                      searchOpen()
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                    }`}
                    aria-label={t("session.search.label")}
                    aria-expanded={searchOpen()}
                    onClick={() => (searchOpen() ? closeSearch() : openSearch())}
                  >
                    <Icon name="search" />
                  </button>
                </Tip>
                <Tip label={traceOn() ? t("trace.live") : t("trace.replay")}>
                    <button
                      class={`grid h-7 w-7 place-items-center rounded-md transition-colors ${
                        traceOn()
                          ? "bg-secondary text-foreground"
                          : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                      }`}
                      aria-label={traceOn() ? t("trace.live") : t("trace.replay")}
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
                    </button>
                  </Tip>
                  <Tip label={railOn() ? t("rail.hide") : t("rail.show")}>
                    <button
                      class={`relative grid h-7 w-7 place-items-center rounded-md transition-colors ${
                        railOn()
                          ? "bg-secondary text-foreground"
                          : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                      }`}
                      aria-label={railOn() ? t("rail.hide") : t("rail.show")}
                      onClick={toggleRail}
                    >
                      <Icon name="files" />
                      {/* Only while the rail is open. A dot on a toggle that stays
                          lit with the panel closed says "something is here" without
                          saying where — and the rail itself already shows the count. */}
                      <Show when={railOn() && v().files_changed.length > 0}>
                        <span class="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-event-file" />
                      </Show>
                    </button>
                  </Tip>
                  <Tip label={t("header.export")}>
                    <a
                      class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                      aria-label={t("header.export")}
                      href={`${api("/export")}?session_id=${encodeURIComponent(v().session_id)}`}
                      download=""
                    >
                      <Icon name="download" />
                    </a>
                  </Tip>
                </span>
              </header>

              <Show when={searchOpen()}>
                <div class="absolute right-4 top-11 z-30 w-[26rem] max-w-[calc(100%-2rem)] overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
                  <div class="flex items-center gap-2 border-b border-border px-3 py-2">
                    <Icon name="search" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <input
                      ref={(el) => (searchEl = el)}
                      class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                      placeholder={t("session.search.placeholder")}
                      value={query()}
                      onInput={(e) => onQuery(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          step(e.shiftKey ? -1 : 1);
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          closeSearch();
                        }
                      }}
                    />
                    <Show when={probe()}>
                      <span class="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                        {result.loading
                          ? "…"
                          : targets().length
                            ? `${hitAt() + 1}/${targets().length}${result()?.more ? "+" : ""}`
                            : t("session.search.counter.none")}
                      </span>
                    </Show>
                    <button
                      class="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
                      aria-label={t("session.search.prev")}
                      disabled={!targets().length}
                      onClick={() => step(-1)}
                    >
                      <Icon name="chevron" class="h-3.5 w-3.5 rotate-180" />
                    </button>
                    <button
                      class="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
                      aria-label={t("session.search.next")}
                      disabled={!targets().length}
                      onClick={() => step(1)}
                    >
                      <Icon name="chevron" class="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <Show
                    when={targets().length > 0}
                    fallback={
                      <Show when={probe() && !result.loading}>
                        <p class="px-3 py-4 text-center text-xs text-muted-foreground">
                          {t("session.search.empty")}
                        </p>
                      </Show>
                    }
                  >
                    <ul ref={(el) => (resultsEl = el)} class="max-h-72 overflow-x-hidden overflow-y-auto py-1">
                      <For each={targets()}>
                        {(h, i) => (
                          <li>
                            <button
                              data-hit={i()}
                              class={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors ${
                                i() === hitAt() ? "bg-secondary" : "hover:bg-secondary/60"
                              }`}
                              onClick={() => {
                                setHitAt(i());
                                goTo(h);
                              }}
                            >
                              <Snippet text={h.snippet} />
                              <span class="font-mono text-2xs text-muted-foreground">
                                {t("session.search.turn", { n: turnNumber(h) })}
                              </span>
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </div>
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

              <div
                ref={scroller}
                // overflow-x is stated, not left out. CSS turns a `visible`
                // overflow-x into `auto` whenever overflow-y is a scroller, so
                // any one row wider than the column grew a horizontal scrollbar
                // that shrank the column — and windowing meant that row came and
                // went while scrolling, so the whole transcript breathed in and
                // out. Everything inside already scrolls or wraps on its own.
                class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  setScrollTop(el.scrollTop);
                  setViewport(el.clientHeight);
                  setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 96);
                }}
              >
                <div class="mx-auto w-full max-w-3xl px-5 py-4">
                  <Show
                    when={!booting()}
                    fallback={<LoadingTranscript />}
                  >
                    <Show
                      when={v().turns.length > 0}
                      fallback={
                        <Show
                          when={!lastSilentTurn()}
                          fallback={
                            <div class="flex items-center justify-center gap-2 pt-16 text-sm text-muted-foreground">
                              <Icon name="spark" class="size-3.5 animate-pulse text-event-assistant" />
                              {t("transcript.thinking")}
                            </div>
                          }
                        >
                          <p class="pt-16 text-center text-sm text-muted-foreground">
                            {t("session.empty")}
                          </p>
                        </Show>
                      }
                    >
                    <Virtual
                      items={v().turns}
                      id={(t) => t.turn_id}
                      estimate={100}
                      gap={32}
                      scrollTop={scrollTop()}
                      viewport={viewport()}
                      scroller={() => scroller}
                      api={(a) => (list = a)}
                    >
                      {(t) => <TurnBlock turn={t} awaiting={() => lastSilentTurn() === t} />}
                    </Virtual>
                    </Show>
                  </Show>
                </div>
              </div>

              <Show when={replayPos() === null}>
                <div class="shrink-0 bg-gradient-to-t from-background from-70% px-5 pb-4 pt-6">
                  <div class="mx-auto w-full max-w-3xl space-y-2">
                    <For each={settled(asks) ?? []}>
                      {(p) => (
                        <div class="rounded-xl border border-event-permission/40 bg-event-permission/10 p-3">
                          <div class="flex items-center gap-2 text-sm">
                            <span class="font-medium text-event-permission">{p.tool}</span>
                            <span class="text-xs text-muted-foreground">{t("permission.wants_to_run")}</span>
                            <span class="ml-auto flex gap-1.5">
                              <button
                                class="rounded-md bg-status-active/15 px-2.5 py-1 text-xs font-medium text-status-active hover:bg-status-active/25"
                                onClick={() => void respond(p.request_id, "allow")}
                              >
                                {t("permission.allow")}
                              </button>
                              <button
                                class="rounded-md bg-destructive/15 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/25"
                                onClick={() => void respond(p.request_id, "deny")}
                              >
                                {t("permission.deny")}
                              </button>
                            </span>
                          </div>
                          <pre class="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md bg-background/50 p-2 font-mono text-2xs text-muted-foreground">
                            {JSON.stringify(p.input, null, 2)}
                          </pre>
                        </div>
                      )}
                    </For>
                    <For each={settled(questions) ?? []}>
                      {(q) => (
                        <QuestionCard
                          q={q}
                          onDone={() => {
                            refetchQuestions();
                            refetch();
                          }}
                        />
                      )}
                    </For>
                    <div>
                      <Show when={queued().length > 0}>
                        <div class="rounded-t-2xl border border-b-0 border-input bg-secondary/70 px-3 pb-4 pt-2">
                          <p class="text-2xs font-medium text-muted-foreground">
                            {tn("composer.queued", queued().length)}
                          </p>
                          <ul class="mt-1 space-y-1">
                            <For each={queued()}>
                              {(text, i) => (
                                <li class="flex items-center gap-2">
                                  <span class="min-w-0 flex-1 truncate text-sm">{text}</span>
                                  <button
                                    type="button"
                                    class="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                                    onClick={() => editQueued(i())}
                                  >
                                    {t("composer.edit")}
                                  </button>
                                  <button
                                    type="button"
                                    class="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                                    aria-label={t("composer.remove_queued")}
                                    onClick={() => setQueued((q) => q.filter((_, n) => n !== i()))}
                                  >
                                    ×
                                  </button>
                                </li>
                              )}
                            </For>
                          </ul>
                        </div>
                      </Show>
                    <div
                      class={`rounded-2xl border border-input bg-card shadow-[0_8px_30px_-18px_rgba(0,0,0,0.7)] transition-colors focus-within:border-ring ${queued().length > 0 ? "-mt-2" : ""}`}
                    >
                      <textarea
                        ref={draftEl}
                        class="max-h-56 w-full resize-none bg-transparent px-4 py-3 font-sans text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none"
                        rows={1}
                        placeholder={generating() ? t("composer.placeholder.queue") : t("composer.placeholder.message")}
                        value={draft()}
                        onInput={(e) => {
                          setDraft(e.currentTarget.value);
                          setHistIndex(-1);
                          autogrow();
                        }}
                        onKeyDown={(e) => {
                          if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.isComposing) {
                            const moved = navigateHistory({
                              direction: e.key === "ArrowUp" ? "up" : "down",
                              text: draft(),
                              cursor: e.currentTarget.selectionStart ?? 0,
                              index: histIndex(),
                              entries: readHistory(),
                              saved: histSaved(),
                            });
                            if (moved.handled) {
                              e.preventDefault();
                              if (histIndex() < 0) setHistSaved(draft());
                              setHistIndex(moved.index);
                              setDraft(moved.text);
                              queueMicrotask(() => {
                                autogrow();
                                const pos = moved.cursor === "start" ? 0 : moved.text.length;
                                draftEl?.setSelectionRange(pos, pos);
                              });
                              return;
                            }
                          }
                          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                            e.preventDefault();
                            send();
                          }
                        }}
                      />
                      <div class="flex items-center gap-2 px-3 pb-2.5">
                        <Show when={generating()}>
                          <span class="text-xs text-muted-foreground">{t("composer.running")}</span>
                        </Show>
                        <div class="ml-auto">
                          <Show
                            when={!generating()}
                            fallback={
                              <Tip label={stopping() ? t("composer.stopping") : t("composer.stop")}>
                                <button
                                  class="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-foreground text-background transition-opacity hover:opacity-80 active:scale-95 disabled:opacity-40"
                                  disabled={stopping()}
                                  aria-label={stopping() ? t("composer.stopping_aria") : t("composer.stop")}
                                  onClick={() => void stop()}
                                >
                                  <span class="h-2.5 w-2.5 rounded-[2px] bg-background" />
                                </button>
                              </Tip>
                            }
                          >
                            <Tip label={draft().trim() ? t("composer.send") : t("composer.type")}>
                              <button
                                class="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 disabled:active:scale-100"
                                disabled={!draft().trim()}
                                aria-label={draft().trim() ? t("composer.send") : t("composer.type")}
                                onClick={() => void send()}
                              >
                                <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                  <path d="M8 12.5v-9M3.8 7.3 8 3l4.2 4.3" />
                                </svg>
                              </button>
                            </Tip>
                          </Show>
                        </div>
                      </div>
                    </div>
                    </div>
                    <div class="flex items-center gap-0.5 px-1">
                      <Popover gutter={8} placement="top-start">
                        <Tip label={contextLabel(context()?.total ?? 0, context()?.percent ?? null)}>
                          <PopoverTrigger
                            class="mr-auto grid h-7 w-7 place-items-center rounded-md transition-colors hover:bg-secondary"
                            aria-label={t("composer.details")}
                          >
                            <ContextRing percent={context()?.percent ?? null} />
                          </PopoverTrigger>
                        </Tip>
                        <PopoverContent>
                          <SessionInfo
                            totals={v().totals}
                            context={context()}
                            model={modelSel()}
                            backend={v().backend}
                            status={v().status}
                            workspace={v().workspace}
                          />
                        </PopoverContent>
                      </Popover>
                      <div class="flex min-w-0 items-center justify-end gap-0.5">
                      <Show when={(settled(options)?.models.length ?? 0) > 0 && (Boolean(modelSel()) || !booting())}>
                        <Picker
                          label={t("picker.model")}
                          value={modelSel()}
                          options={modelOptions()}
                          onChange={(value) => {
                            setModelTouched(true);
                            setModelSel(value);
                            setVariantSel("");
                          }}
                        />
                      </Show>
                      <Show when={(effortModel()?.variants?.length ?? 0) > 0}>
                        <Picker
                          label={t("picker.effort")}
                          capitalize
                          emptyOption={t("picker.default")}
                          placeholder={t("picker.default")}
                          value={variantSel()}
                          options={(effortModel()?.variants ?? []).map((name) => ({ value: name, label: name }))}
                          onChange={setVariantSel}
                        />
                      </Show>
                      <Show when={(settled(options)?.agents.length ?? 0) > 0}>
                        <Picker
                          label={t("picker.agent")}
                          capitalize
                          value={agentSel()}
                          options={(settled(options)!.agents ?? []).map((a) => ({ value: a.name, label: a.name }))}
                          onChange={setAgentSel}
                        />
                      </Show>
                      </div>
                    </div>
                    <Show when={sendErr()}>
                      <p class="font-mono text-2xs text-destructive">{sendErr()}</p>
                    </Show>
                  </div>
                </div>
              </Show>
            </>
          )}
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
      <Show when={railOn() && settled(view)}>
        {(v) => {
          const files = () => v().files_changed;
          const fileLabel = () => {
            const n = files().length;
            if (n === 0) return t("rail.plan");
            return tn("rail.files", n);
          };
          // The list of names is worthless at 288px next to a real diff, so the
          // rail borrows room only while a reader is actually reading one.
          const open = () => files().find((f) => f.path === openFile()) ?? null;
          const toggleFile = (path: string) => setOpenFile(openFile() === path ? null : path);
          const jumpTo = (turnIndex: number) => {
            if (turnIndex >= 0) list?.scrollToIndex(turnIndex);
          };
          return (
            <aside
              class={`flex shrink-0 flex-col border-l border-border ${
                open() ? "w-[min(600px,48vw)]" : "w-72"
              }`}
            >
              <div
                class="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3 select-none"
                data-tauri-drag-region={inDesktopShell() ? "" : undefined}
              >
                <span class="shrink-0 text-sm font-medium">
                  {generating() ? t("rail.running") : t("rail.done")}
                </span>
                <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{fileLabel()}</span>
                <button
                  class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
                  aria-label={t("rail.hide")}
                  onClick={toggleRail}
                >
                  ×
                </button>
              </div>
              <div class="flex min-h-0 flex-1">
                <div
                  class={`min-h-0 space-y-5 overflow-x-hidden overflow-y-auto px-2 py-3 ${
                    open() ? "w-44 shrink-0 border-r border-border" : "w-full px-3"
                  }`}
                >
                  <Show when={(v().plan?.length ?? 0) > 0}>
                    <section>
                      <h2 class="px-1 text-2xs font-medium text-muted-foreground">{t("rail.plan")}</h2>
                      <ul class="mt-1.5 space-y-1 text-sm">
                        <For each={v().plan}>
                          {(item) => (
                            <li class="flex gap-2 px-1">
                              <span
                                class={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                                  item.status === "completed"
                                    ? "bg-status-completed"
                                    : item.status === "in_progress"
                                      ? "bg-status-active"
                                      : "bg-status-pending"
                                }`}
                              />
                              <span class={item.status === "completed" ? "text-muted-foreground line-through" : ""}>
                                {item.content}
                              </span>
                            </li>
                          )}
                        </For>
                      </ul>
                    </section>
                  </Show>
                  <Show
                    when={files().length > 0}
                    fallback={<p class="px-1 text-xs text-muted-foreground">{t("rail.nothing")}</p>}
                  >
                    <ul class="space-y-0.5">
                      <For each={files()}>
                        {(f) => (
                          <li>
                            <button
                              type="button"
                              aria-expanded={openFile() === f.path}
                              onClick={() => toggleFile(f.path)}
                              title={f.path}
                              class={`flex w-full cursor-pointer items-baseline gap-2 rounded-md px-1 py-1 text-left hover:bg-secondary ${
                                openFile() === f.path ? "bg-secondary" : ""
                              }`}
                            >
                              <span
                                class={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                                  f.change === "add"
                                    ? "bg-status-active"
                                    : f.change === "delete"
                                      ? "bg-status-error"
                                      : "bg-status-completed"
                                }`}
                              />
                              <span class="min-w-0 flex-1">
                                <span class="block truncate text-sm">{fileName(f.path)}</span>
                                <Show when={f.count > 1}>
                                  <span class="block truncate text-2xs text-muted-foreground">
                                    {/* the dot already says how it changed */}
                                    {open() ? "" : changeWord(f.change) + " · "}
                                    {tn("file.changes", f.count)}
                                  </span>
                                </Show>
                              </span>
                              {/* ≥ because a change nothing explained leaves its lines uncounted */}
                              <span
                                class="shrink-0 font-mono text-2xs"
                                title={f.unexplained ? t("file.partial") : undefined}
                              >
                                <span class="text-diff-add-fg">
                                  {f.unexplained ? "≥+" : "+"}
                                  {num(f.additions)}
                                </span>{" "}
                                <span class="text-diff-del-fg">−{num(f.deletions)}</span>
                              </span>
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </div>

                <Show when={open()}>
                  {(f) => (
                    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                      <div class="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2">
                        <span class="min-w-0 flex-1 font-mono text-2xs break-all text-muted-foreground">
                          {f().path}
                        </span>
                        <button
                          type="button"
                          class="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-secondary hover:text-foreground"
                          onClick={() => setOpenFile(null)}
                        >
                          {t("file.close")}
                        </button>
                      </div>
                      <div class="min-h-0 flex-1 overflow-x-auto overflow-y-auto px-3 py-2">
                        <Show when={f().unexplained}>
                          <p class="mb-2 rounded-md bg-secondary/60 px-2 py-1.5 text-2xs text-muted-foreground">
                            {tn("file.hidden", f().edits.filter((e) => !e.diff).length)}
                          </p>
                        </Show>
                        <For each={f().edits}>
                          {(edit) => (
                            <section class="mb-3 last:mb-0">
                              <div class="sticky left-0 mb-1 flex w-max items-center gap-2 bg-background">
                                <span class="rounded bg-secondary px-1.5 py-0.5 text-2xs text-muted-foreground">
                                  {edit.whole_file ? t("file.whole") : t("file.region")}
                                </span>
                                <span class="font-mono text-2xs">
                                  <span class="text-diff-add-fg">+{num(edit.additions)}</span>{" "}
                                  <span class="text-diff-del-fg">−{num(edit.deletions)}</span>
                                </span>
                                <Show when={edit.turn_index >= 0}>
                                  <button
                                    type="button"
                                    class="ml-auto shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-secondary hover:text-foreground"
                                    onClick={() => jumpTo(edit.turn_index)}
                                  >
                                    {t("file.jump")}
                                  </button>
                                </Show>
                              </div>
                              <Show
                                when={edit.diff}
                                fallback={
                                  <p class="rounded-md bg-secondary/60 px-2 py-1.5 text-2xs text-muted-foreground">
                                    {t("file.noDiff")}
                                  </p>
                                }
                              >
                                <DiffBlock patch={edit.diff!} />
                              </Show>
                            </section>
                          )}
                        </For>
                      </div>
                    </div>
                  )}
                </Show>
              </div>
            </aside>
          );
        }}
      </Show>
    </div>
  );
}
