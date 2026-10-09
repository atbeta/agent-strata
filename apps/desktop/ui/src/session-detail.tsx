import { createEffect, createResource, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js";
import {
  abortSession,
  api,
  fmtUsd,
  getJson,
  importSession,
  realWorkspace,
  respondPermission,
  respondQuestion,
  type OptionsResponse,
  type PendingAsk,
  type PendingQuestion,
  type SessionView,
} from "./api";
import { Icon } from "./icons";
import { CaptionGutter, DragBar } from "./chrome";
import { inDesktopShell, usesCustomCaption } from "./shell";
import { Tip } from "./tip";
import { TraceDrawer, TraceStrip, type TraceBlock } from "./trace";
import { TurnBlock } from "./transcript";

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
      setErr("answer each question");
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
            <div class="text-[11px] font-medium uppercase tracking-wide text-event-permission">
              {question.header}
            </div>
            <p class="mt-1 text-sm">{question.question}</p>
            <div class="mt-2 flex flex-wrap gap-1.5">
              <For each={question.options}>
                {(opt) => {
                  const on = () => (picks()[qi()] ?? []).includes(opt.label);
                  return (
                    <button
                      class={`rounded-full px-3 py-1 text-xs transition-colors ${
                        on()
                          ? "bg-primary text-primary-foreground"
                          : "bg-secondary text-foreground hover:bg-accent"
                      }`}
                      title={opt.description}
                      onClick={() => toggle(qi(), opt.label, question.multiple)}
                    >
                      {opt.label}
                    </button>
                  );
                }}
              </For>
            </div>
            <Show when={question.custom}>
              <input
                class="mt-2 w-full rounded-md border border-input bg-background/50 px-2.5 py-1.5 text-sm focus:border-ring focus:outline-none"
                placeholder="or type your own"
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
          reply
        </button>
        <button
          class="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => void respondQuestion(props.q.request_id, "reject").then(props.onDone)}
        >
          dismiss
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

function changeWord(change: string): string {
  if (change === "add") return "added";
  if (change === "delete") return "deleted";
  return "edited";
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

export function SessionDetail(props: { id: string }) {
  const [replayPos, setReplayPos] = createSignal<number | null>(null);
  const [traceOn, setTraceOn] = createSignal(false);
  const [traceBlock, setTraceBlock] = createSignal<TraceBlock | null>(null);
  const [railForced, setRailForced] = createSignal(false);
  const [railDismissed, setRailDismissed] = createSignal(false);
  const [booting, setBooting] = createSignal(true);
  const [modelTouched, setModelTouched] = createSignal(false);
  const [view, { refetch }] = createResource(
    () => ({ id: props.id, pos: replayPos() }),
    ({ id, pos }) =>
      getJson<SessionView>(
        `/sessions/${encodeURIComponent(id)}/view${pos === null ? "" : `?until_seq=${pos}`}`,
      ),
  );
  const [maxSeq, { refetch: refetchSeq }] = createResource(
    () => props.id,
    async (id) => {
      const r = await getJson<{ events: { seq: number }[] }>(
        `/events?session_id=${encodeURIComponent(id)}&order=desc&limit=1`,
      );
      return r.events[0]?.seq ?? 0;
    },
  );
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
  let pinned = true;

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
  const modelGroups = () => {
    const byProvider = new Map<string, NonNullable<OptionsResponse>["models"]>();
    for (const m of settled(options)?.models ?? []) {
      byProvider.set(m.providerID, [...(byProvider.get(m.providerID) ?? []), m]);
    }
    return [...byProvider.entries()];
  };
  const generating = () =>
    pendingSend() ||
    !!settled(view)?.busy ||
    !!settled(view)?.turns.some((t) => t.assistant.some((a) => a.partial));

  createEffect(() => {
    settled(view)?.turns.length;
    settled(view)?.busy;
    if (!pinned || !scroller) return;
    queueMicrotask(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
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
    const poll = setInterval(() => {
      if (replayPos() === null) refetch();
    }, 3_000);
    const es = new EventSource(api("/stream"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    es.onmessage = (m) => {
      try {
        const evt = JSON.parse(m.data) as {
          session_id?: string;
          type: string;
          data?: { state?: string };
        };
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
      es.close();
      window.removeEventListener("strata-connections", onConns);
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
        setSendErr(body.error ?? `service ${res.status}`);
        setDraft(text);
        setPendingSend(false);
      }
    } catch (err) {
      setSendErr(err instanceof Error ? err.message : "network error");
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
      ? `${total.toLocaleString()} tokens in context`
      : `${percent}% of context · ${total.toLocaleString()} tokens`;

  const stop = async () => {
    if (stopping()) return;
    setSendErr("");
    setStopping(true);
    try {
      await abortSession(props.id);
      setPendingSend(false);
    } catch (err) {
      setSendErr(err instanceof Error ? err.message : "abort failed");
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

  const pickerCls =
    "h-7 max-w-52 cursor-pointer truncate rounded-md bg-transparent px-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus:outline-none";

  return (
    <div class="flex h-full min-h-0">
      <div class="flex min-w-0 flex-1 flex-col">
        <Show
          when={settled(view)}
          fallback={
            <div class="flex h-full min-h-0 flex-col">
              <DragBar />
              <Show
                when={view.error}
                fallback={<LoadingTranscript />}
              >
                <p class="px-8 pt-24 text-sm text-muted-foreground">Can't reach the strata service.</p>
              </Show>
            </div>
          }
        >
          {(v) => (
            <>
              <header
                class={`flex h-11 shrink-0 items-center gap-2 border-b border-border select-none ${
                  usesCustomCaption() ? "pl-5 pr-2" : "px-4"
                }`}
                data-tauri-drag-region={inDesktopShell() ? "" : undefined}
              >
                <div class="flex min-w-0 flex-1 items-baseline gap-2">
                  <h1 class="min-w-0 truncate text-[13px] font-medium" title={v().title ?? "untitled session"}>
                    {v().title ?? "untitled session"}
                  </h1>
                  <Show when={realWorkspace(v().workspace)}>
                    {(ws) => (
                      <span
                        class="max-w-40 shrink-0 truncate font-mono text-[11px] text-muted-foreground"
                        title={ws()}
                      >
                        {ws() === "/" || ws() === "\\" ? "Root" : ws().split(/[/\\]/).filter(Boolean).at(-1)}
                      </span>
                    )}
                  </Show>
                </div>
                <span class="flex shrink-0 items-center gap-0.5">
                  <Show when={v().totals.cost_usd > 0}>
                    <span
                      class="mr-1 font-mono text-[11px] text-muted-foreground tabular-nums"
                      title="Session cost"
                    >
                      {fmtUsd(v().totals.cost_usd)}
                    </span>
                  </Show>
                  <Tip label={traceOn() ? "Back to live" : "Replay"}>
                  <button
                    class={`grid h-7 w-7 place-items-center rounded-md transition-colors ${
                      traceOn()
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                    }`}
                    aria-label={traceOn() ? "Back to live" : "Replay"}
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
                  <Tip label={railOn() ? "Hide files" : "Files and plan"}>
                  <button
                    class={`relative grid h-7 w-7 place-items-center rounded-md transition-colors ${
                      railOn()
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                    }`}
                    aria-label={railOn() ? "Hide files" : "Files and plan"}
                    onClick={toggleRail}
                  >
                    <Icon name="files" />
                    <Show when={v().files_changed.length > 0}>
                      <span class="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-event-file" />
                    </Show>
                  </button>
                  </Tip>
                  <Tip label="Export transcript">
                  <a
                    class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    aria-label="Export transcript"
                    href={`${api("/export")}?session_id=${encodeURIComponent(v().session_id)}`}
                    download=""
                  >
                    <Icon name="download" />
                  </a>
                  </Tip>
                </span>
                <CaptionGutter />
              </header>

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
                class="min-h-0 flex-1 overflow-y-auto"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
                }}
              >
                <div class="mx-auto w-full max-w-3xl space-y-8 px-5 py-4">
                  <Show
                    when={!booting()}
                    fallback={<LoadingTranscript />}
                  >
                    <Show
                      when={v().turns.length > 0}
                      fallback={
                        <p class="pt-16 text-center text-sm text-muted-foreground">
                          Empty session. Write a prompt to start.
                        </p>
                      }
                    >
                    <Index each={v().turns}>{(t) => <TurnBlock turn={t()} />}</Index>
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
                            <span class="text-xs text-muted-foreground">wants to run</span>
                            <span class="ml-auto flex gap-1.5">
                              <button
                                class="rounded-md bg-status-active/15 px-2.5 py-1 text-xs font-medium text-status-active hover:bg-status-active/25"
                                onClick={() => void respond(p.request_id, "allow")}
                              >
                                allow
                              </button>
                              <button
                                class="rounded-md bg-destructive/15 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/25"
                                onClick={() => void respond(p.request_id, "deny")}
                              >
                                deny
                              </button>
                            </span>
                          </div>
                          <pre class="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md bg-background/50 p-2 font-mono text-[11px] text-muted-foreground">
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
                          <p class="text-[11px] font-medium text-muted-foreground">
                            {queued().length === 1 ? "Queued" : `${queued().length} queued`}
                          </p>
                          <ul class="mt-1 space-y-1">
                            <For each={queued()}>
                              {(text, i) => (
                                <li class="flex items-center gap-2">
                                  <span class="min-w-0 flex-1 truncate text-[13px]">{text}</span>
                                  <button
                                    type="button"
                                    class="shrink-0 text-[12px] text-muted-foreground hover:text-foreground"
                                    onClick={() => editQueued(i())}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    class="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                                    aria-label="Remove queued message"
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
                        placeholder={generating() ? "Queue a follow-up…" : "Message…"}
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
                          <span class="text-[12px] text-muted-foreground">Running</span>
                        </Show>
                        <div class="ml-auto">
                          <Show
                            when={!generating()}
                            fallback={
                              <Tip label={stopping() ? "Stopping…" : "Stop"}>
                                <button
                                  class="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-foreground text-background transition-opacity hover:opacity-80 active:scale-95 disabled:opacity-40"
                                  disabled={stopping()}
                                  aria-label={stopping() ? "Stopping" : "Stop"}
                                  onClick={() => void stop()}
                                >
                                  <span class="h-2.5 w-2.5 rounded-[2px] bg-background" />
                                </button>
                              </Tip>
                            }
                          >
                            <Tip label={draft().trim() ? "Send" : "Type a message"}>
                              <button
                                class="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 disabled:active:scale-100"
                                disabled={!draft().trim()}
                                aria-label={draft().trim() ? "Send" : "Type a message"}
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
                      <Show when={context()}>
                        {(c) => (
                          <Tip label={contextLabel(c().total, c().percent)} class="mr-auto">
                            <span
                              class="grid h-7 w-7 place-items-center"
                              aria-label={contextLabel(c().total, c().percent)}
                            >
                              <ContextRing percent={c().percent} />
                            </span>
                          </Tip>
                        )}
                      </Show>
                      <div class={`flex min-w-0 items-center justify-end gap-0.5 ${context() ? "" : "ml-auto"}`}>
                      <Show when={(settled(options)?.models.length ?? 0) > 0 && (Boolean(modelSel()) || !booting())}>
                        <select
                          class={pickerCls}
                          value={modelSel()}
                          title="Model"
                          aria-label="Model"
                          onChange={(e) => {
                            setModelTouched(true);
                            setModelSel(e.currentTarget.value);
                            setVariantSel("");
                          }}
                        >
                          <Show
                            when={
                              modelSel() &&
                              !(settled(options)?.models ?? []).some(
                                (m) => `${m.providerID}/${m.modelID}` === modelSel(),
                              )
                            }
                          >
                            <option value={modelSel()}>{modelSel().slice(modelSel().indexOf("/") + 1)}</option>
                          </Show>
                          <For each={modelGroups()}>
                            {([pid, models]) => (
                              <optgroup label={pid}>
                                <For each={models}>
                                  {(m) => (
                                    <option value={`${m.providerID}/${m.modelID}`}>{m.modelID}</option>
                                  )}
                                </For>
                              </optgroup>
                            )}
                          </For>
                        </select>
                      </Show>
                      <Show when={(effortModel()?.variants?.length ?? 0) > 0}>
                        <select
                          class={`${pickerCls} capitalize`}
                          value={variantSel()}
                          title="Thinking effort"
                          aria-label="Thinking effort"
                          onChange={(e) => setVariantSel(e.currentTarget.value)}
                        >
                          <option value="">Default</option>
                          <For each={effortModel()?.variants ?? []}>
                            {(name) => <option value={name}>{name}</option>}
                          </For>
                        </select>
                      </Show>
                      <Show when={(settled(options)?.agents.length ?? 0) > 0}>
                        <select
                          class={`${pickerCls} capitalize`}
                          value={agentSel()}
                          title="Agent"
                          aria-label="Agent"
                          onChange={(e) => setAgentSel(e.currentTarget.value)}
                        >
                          <For each={settled(options)!.agents}>
                            {(a) => <option value={a.name}>{a.name}</option>}
                          </For>
                        </select>
                      </Show>
                      </div>
                    </div>
                    <Show when={sendErr()}>
                      <p class="font-mono text-[11px] text-destructive">{sendErr()}</p>
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
            if (n === 1) return "1 file";
            if (n > 1) return `${n} files`;
            return "Plan";
          };
          return (
            <aside class="flex w-72 shrink-0 flex-col border-l border-border">
              <div
                class="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3 select-none"
                data-tauri-drag-region={inDesktopShell() ? "" : undefined}
              >
                <span class="shrink-0 text-[13px] font-medium">
                  {generating() ? "Running" : "Done"}
                </span>
                <span class="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{fileLabel()}</span>
                <button
                  class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
                  aria-label="Hide files"
                  onClick={toggleRail}
                >
                  ×
                </button>
                <CaptionGutter />
              </div>
              <div class="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-3">
                <Show when={(v().plan?.length ?? 0) > 0}>
                  <section>
                    <h2 class="px-1 text-[11px] font-medium text-muted-foreground">Plan</h2>
                    <ul class="mt-1.5 space-y-1 text-[13px]">
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
                  fallback={<p class="px-1 text-[12px] text-muted-foreground">Nothing changed yet.</p>}
                >
                  <ul class="space-y-0.5">
                    <For each={files()}>
                      {(f) => (
                        <li class="flex items-baseline gap-2 rounded-md px-1 py-1" title={f.path}>
                          <span class="min-w-0 flex-1 truncate text-[13px]">{fileName(f.path)}</span>
                          <span class="shrink-0 text-[10px] text-muted-foreground">{changeWord(f.change)}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
            </aside>
          );
        }}
      </Show>
    </div>
  );
}
