import { createEffect, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  abortSession,
  api,
  fmtUsd,
  getJson,
  importSession,
  realWorkspace,
  respondPermission,
  respondQuestion,
  type ContentBlock,
  type OptionsResponse,
  type PendingAsk,
  type PendingQuestion,
  type SessionView,
  type ToolCallView,
  type Turn,
} from "./api";
import { Md } from "./md";
import { Icon } from "./icons";

function BlockText(props: { blocks: ContentBlock[]; tight?: boolean }) {
  return (
    <For each={props.blocks}>
      {(b) => (
        <Show
          when={b.type !== "thinking"}
          fallback={
            <details class="group my-1.5">
              <summary class="inline-flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground [list-style:none] hover:text-foreground">
                <span class="text-[10px] transition-transform group-open:rotate-90">▸</span>
                Thought
              </summary>
              <Md class="mt-1.5 border-l border-border pl-3 text-[13px] leading-6 text-muted-foreground" text={b.text ?? ""} />
            </details>
          }
        >
          <Show
            when={b.type !== "file_ref"}
            fallback={
              <p class="my-1 font-mono text-xs text-event-file">
                {(b as { path?: string }).path}
              </p>
            }
          >
            <Md class={props.tight ? "md-bubble" : ""} text={b.text ?? `[${b.type}]`} />
          </Show>
        </Show>
      )}
    </For>
  );
}

function ToolCallRow(props: { call: ToolCallView }) {
  const [open, setOpen] = createSignal(false);
  const denied = () =>
    props.call.status === "error" || props.call.permission?.decision === "deny";
  const preview = () => {
    const s = JSON.stringify(props.call.input);
    return s.length > 88 ? s.slice(0, 88) + "…" : s;
  };
  return (
    <div class="overflow-hidden rounded-lg border border-border/80 bg-card/60 font-mono text-xs">
      <button
        class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-secondary/60"
        onClick={() => setOpen((v) => !v)}
      >
        <span class={`text-[10px] text-muted-foreground transition-transform ${open() ? "rotate-90" : ""}`}>
          ▸
        </span>
        <span class={denied() ? "text-status-error" : "text-event-tool"}>{props.call.tool}</span>
        <span class="min-w-0 truncate text-muted-foreground">{preview()}</span>
        <span class="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
          {props.call.status}
        </span>
      </button>
      <Show when={open()}>
        <div class="space-y-2 border-t border-border px-3 py-2.5">
          <Show when={props.call.permission}>
            {(p) => (
              <div class="text-event-permission">
                permission {p().decision ?? "pending"}
                {p().by ? ` · ${p().by}` : ""}
                {p().reason ? ` — ${p().reason}` : ""}
              </div>
            )}
          </Show>
          <pre class="whitespace-pre-wrap break-all text-muted-foreground">
            {JSON.stringify(props.call.input, null, 2)}
          </pre>
          <Show when={props.call.output}>
            <pre class="max-h-64 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-background/70 p-2 text-muted-foreground">
              {props.call.output}
            </pre>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function TurnBlock(props: { turn: Turn }) {
  return (
    <div class="space-y-3">
      <Show when={props.turn.user}>
        {(blocks) => (
          <div class="flex justify-end">
            <div class="max-w-[min(85%,36rem)] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-secondary-foreground">
              <BlockText blocks={blocks()} tight />
            </div>
          </div>
        )}
      </Show>
      <For each={props.turn.assistant}>
        {(a) => (
          <div class="max-w-3xl">
            <Show when={a.partial}>
              <div class="mb-1 text-[11px] text-event-assistant">streaming</div>
            </Show>
            <div class="relative">
              <BlockText blocks={a.content} />
              <Show when={a.partial}>
                <span class="ml-0.5 inline-block h-[1em] w-[2px] translate-y-0.5 animate-pulse bg-foreground/70 align-text-bottom" />
              </Show>
            </div>
          </div>
        )}
      </For>
      <div class="max-w-3xl space-y-2">
        <For each={props.turn.tool_calls}>{(c) => <ToolCallRow call={c} />}</For>
      </div>
    </div>
  );
}

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

export function SessionDetail(props: { id: string }) {
  const [replayPos, setReplayPos] = createSignal<number | null>(null);
  const [filesOpen, setFilesOpen] = createSignal(false);
  const [view, { refetch }] = createResource(
    () => ({ id: props.id, pos: replayPos() }),
    ({ id, pos }) =>
      getJson<SessionView>(`/sessions/${id}/view${pos === null ? "" : `?until_seq=${pos}`}`),
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
  const [draft, setDraft] = createSignal("");
  const [sendErr, setSendErr] = createSignal("");
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
    const models = options()?.models ?? [];
    if (!modelSel() && models[0]) setModelSel(`${models[0].providerID}/${models[0].modelID}`);
    const agents = options()?.agents ?? [];
    if (!agentSel() && agents[0]) setAgentSel(agents[0].name);
  });

  const selectedModel = () =>
    options()?.models.find((m) => `${m.providerID}/${m.modelID}` === modelSel());
  // empty model means "server default"; still offer that leading model's efforts
  const effortModel = () =>
    selectedModel() ?? options()?.models.find((m) => (m.variants?.length ?? 0) > 0);
  const modelGroups = () => {
    const byProvider = new Map<string, NonNullable<OptionsResponse>["models"]>();
    for (const m of options()?.models ?? []) {
      byProvider.set(m.providerID, [...(byProvider.get(m.providerID) ?? []), m]);
    }
    return [...byProvider.entries()];
  };
  const generating = () =>
    pendingSend() ||
    !!view()?.busy ||
    !!view()?.turns.some((t) => t.assistant.some((a) => a.partial));

  createEffect(() => {
    view()?.turns.length;
    view()?.busy;
    if (!pinned || !scroller) return;
    queueMicrotask(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  });

  onMount(() => {
    void importSession(props.id)
      .catch(() => {})
      .finally(() => {
        refetch();
        refetchSeq();
      });
    const onConns = () => refetchOptions();
    window.addEventListener("strata-connections", onConns);
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

  const send = async () => {
    const text = draft().trim();
    if (!text || generating()) return;
    setDraft("");
    setSendErr("");
    setPendingSend(true);
    if (draftEl) draftEl.style.height = "auto";
    const picked = selectedModel();
    const implied = !picked && variantSel() ? effortModel() : undefined;
    const source = picked ?? implied;
    const model = source
      ? { providerID: source.providerID, modelID: source.modelID }
      : undefined;
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

  const stop = async () => {
    setSendErr("");
    try {
      await abortSession(props.id);
      setPendingSend(false);
    } catch (err) {
      setSendErr(err instanceof Error ? err.message : "abort failed");
    }
  };

  const pickerCls =
    "h-7 max-w-52 cursor-pointer truncate rounded-md bg-transparent px-2 text-[13px] text-foreground/80 transition-colors hover:bg-secondary focus:outline-none";

  return (
    <div class="flex h-full min-h-0">
      <div class="flex min-w-0 flex-1 flex-col">
        <Show when={view()} fallback={<p class="p-8 text-sm text-muted-foreground">loading…</p>}>
          {(v) => (
            <>
              <header class="flex h-12 shrink-0 items-center gap-2.5 px-5">
                <Show when={generating()}>
                  <span class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-status-active" />
                </Show>
                <h1 class="truncate text-sm font-medium">{v().title ?? "untitled session"}</h1>
                <Show when={realWorkspace(v().workspace)}>
                  {(ws) => (
                    <span class="hidden truncate font-mono text-[11px] text-muted-foreground sm:inline">
                      {ws()}
                    </span>
                  )}
                </Show>
                <span class="ml-auto flex items-center gap-0.5">
                  <Show when={v().totals.cost_usd > 0}>
                    <span class="mr-1 hidden font-mono text-[11px] text-muted-foreground tabular-nums md:inline">
                      {fmtUsd(v().totals.cost_usd)}
                    </span>
                  </Show>
                  <button
                    class={`grid h-7 w-7 place-items-center rounded-md transition-colors ${
                      replayPos() !== null
                        ? "bg-event-assistant/15 text-event-assistant"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                    }`}
                    title={replayPos() !== null ? "Live" : "Replay"}
                    aria-label={replayPos() !== null ? "Live" : "Replay"}
                    onClick={() => setReplayPos(replayPos() === null ? (maxSeq() ?? 0) : null)}
                  >
                    <Icon name="replay" />
                  </button>
                  <button
                    class={`relative grid h-7 w-7 place-items-center rounded-md transition-colors ${
                      filesOpen()
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                    }`}
                    title="Files"
                    aria-label="Files"
                    onClick={() => setFilesOpen((o) => !o)}
                  >
                    <Icon name="files" />
                    <Show when={v().files_changed.length > 0}>
                      <span class="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-event-file" />
                    </Show>
                  </button>
                  <a
                    class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    title="Export"
                    aria-label="Export"
                    href={`/api/export?session_id=${encodeURIComponent(v().session_id)}`}
                    download=""
                  >
                    <Icon name="download" />
                  </a>
                </span>
              </header>

              <Show when={replayPos() !== null}>
                <div class="flex shrink-0 items-center gap-3 border-b border-event-assistant/30 bg-event-assistant/5 px-4 py-2">
                  <input
                    type="range"
                    class="flex-1 accent-event-assistant"
                    min={1}
                    max={maxSeq() ?? 1}
                    value={replayPos() ?? 1}
                    onInput={(e) => setReplayPos(Number(e.currentTarget.value))}
                  />
                  <span class="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                    {replayPos()} / {maxSeq() ?? "?"}
                  </span>
                </div>
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
                    when={v().turns.length > 0}
                    fallback={
                      <p class="pt-16 text-center text-sm text-muted-foreground">
                        Empty session. Write a prompt to start.
                      </p>
                    }
                  >
                    <For each={v().turns}>{(t) => <TurnBlock turn={t} />}</For>
                  </Show>
                </div>
              </div>

              <Show when={replayPos() === null}>
                <div class="shrink-0 bg-gradient-to-t from-background from-70% px-5 pb-4 pt-6">
                  <div class="mx-auto w-full max-w-3xl space-y-2">
                    <For each={asks() ?? []}>
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
                    <For each={questions() ?? []}>
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
                    <div class="rounded-2xl border border-input bg-card shadow-[0_8px_30px_-18px_rgba(0,0,0,0.7)] transition-colors focus-within:border-ring">
                      <textarea
                        ref={draftEl}
                        class="max-h-56 w-full resize-none bg-transparent px-4 py-3 font-sans text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none"
                        rows={1}
                        placeholder={generating() ? "working…" : "Message…"}
                        value={draft()}
                        onInput={(e) => {
                          setDraft(e.currentTarget.value);
                          autogrow();
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                            e.preventDefault();
                            void send();
                          }
                        }}
                      />
                      <div class="flex items-center gap-1 px-2 pb-2">
                        <Show when={(options()?.models.length ?? 0) > 0}>
                          <select
                            class={pickerCls}
                            value={modelSel()}
                            title="Model"
                            onChange={(e) => {
                              setModelSel(e.currentTarget.value);
                              setVariantSel("");
                            }}
                          >
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
                            onChange={(e) => setVariantSel(e.currentTarget.value)}
                          >
                            <option value="">Default</option>
                            <For each={effortModel()?.variants ?? []}>
                              {(name) => <option value={name}>{name}</option>}
                            </For>
                          </select>
                        </Show>
                        <Show when={(options()?.agents.length ?? 0) > 0}>
                          <select
                            class={`${pickerCls} capitalize`}
                            value={agentSel()}
                            title="Agent"
                            onChange={(e) => setAgentSel(e.currentTarget.value)}
                          >
                            <For each={options()!.agents}>
                              {(a) => <option value={a.name}>{a.name}</option>}
                            </For>
                          </select>
                        </Show>
                        <Show
                          when={!generating()}
                          fallback={
                            <button
                              class="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-md bg-foreground text-background hover:opacity-90"
                              title="stop"
                              onClick={() => void stop()}
                            >
                              <span class="h-2.5 w-2.5 rounded-[2px] bg-background" />
                            </button>
                          }
                        >
                          <button
                            class="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-30"
                            disabled={!draft().trim()}
                            title="send"
                            onClick={() => void send()}
                          >
                            <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M8 12.5v-9M3.8 7.3 8 3l4.2 4.3" />
                            </svg>
                          </button>
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

      <Show when={filesOpen() && view()}>
        <aside class="flex w-72 shrink-0 flex-col border-l border-border bg-card/30">
          <div class="flex h-12 items-center px-4 text-xs font-medium text-muted-foreground">
            session
          </div>
          <div class="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-6">
            <Show when={(view()?.plan?.length ?? 0) > 0}>
              <section>
                <h2 class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  plan
                </h2>
                <ul class="mt-2 space-y-1.5 text-sm">
                  <For each={view()!.plan}>
                    {(item) => (
                      <li class="flex gap-2">
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
            <section>
              <h2 class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                files
              </h2>
              <Show
                when={(view()?.files_changed.length ?? 0) > 0}
                fallback={<p class="mt-2 text-xs text-muted-foreground">no file changes yet</p>}
              >
                <ul class="mt-2 space-y-1.5 font-mono text-[11px]">
                  <For each={view()!.files_changed}>
                    {(f) => (
                      <li class="flex gap-2">
                        <span class="w-12 shrink-0 text-event-file">{f.change}</span>
                        <span class="break-all text-muted-foreground">{f.path}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>
          </div>
        </aside>
      </Show>
    </div>
  );
}
