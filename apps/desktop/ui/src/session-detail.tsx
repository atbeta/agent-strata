import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  api,
  fmtUsd,
  getJson,
  respondPermission,
  STATUS_DOT,
  STATUS_LABEL,
  type ContentBlock,
  type OptionsResponse,
  type PendingAsk,
  type SessionView,
  type StrataEvent,
  type ToolCallView,
  type Turn,
} from "./api";
import { Md } from "./md";

function BlockText(props: { blocks: ContentBlock[] }) {
  return (
    <For each={props.blocks}>
      {(b) => (
        <Show
          when={b.type !== "thinking"}
          fallback={
            <details class="group my-2 rounded-md bg-muted/60 px-3 py-2">
              <summary class="flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground [list-style:none]">
                <span class="transition-transform group-open:rotate-90">▸</span>
                thinking
              </summary>
              <Md class="mt-2 text-xs text-muted-foreground/90" text={b.text ?? ""} />
            </details>
          }
        >
          <Show
            when={b.type !== "file_ref"}
            fallback={
              <p class="my-1 font-mono text-xs text-muted-foreground">
                📎 {(b as { path?: string }).path}
              </p>
            }
          >
            <Md text={b.text ?? `[${b.type}]`} />
          </Show>
        </Show>
      )}
    </For>
  );
}

function ToolCallRow(props: { call: ToolCallView }) {
  const [open, setOpen] = createSignal(false);
  const statusColor = () =>
    props.call.status === "error" || props.call.permission?.decision === "deny"
      ? "text-status-error"
      : "text-event-tool";
  const inputPreview = () => {
    const s = JSON.stringify(props.call.input);
    return s.length > 100 ? s.slice(0, 100) + "…" : s;
  };
  return (
    <div class="overflow-hidden rounded-lg border border-border bg-secondary/40 font-mono text-xs">
      <button
        class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-secondary/70"
        onClick={() => setOpen((v) => !v)}
      >
        <span class={`text-muted-foreground transition-transform ${open() ? "rotate-90" : ""}`}>
          ▸
        </span>
        <span class={statusColor()}>{props.call.tool}</span>
        <span class="min-w-0 truncate text-muted-foreground">{inputPreview()}</span>
        <span class="ml-auto shrink-0 text-muted-foreground">{props.call.status}</span>
      </button>
      <Show when={open()}>
        <div class="space-y-2 border-t border-border px-3 py-2.5">
          <Show when={props.call.permission}>
            {(p) => (
              <div class="text-event-permission">
                permission {p().decision ?? "pending"} by {p().by ?? "?"}
                {p().reason ? ` — ${p().reason}` : ""}
              </div>
            )}
          </Show>
          <pre class="whitespace-pre-wrap break-all text-muted-foreground">
            {JSON.stringify(props.call.input, null, 2)}
          </pre>
          <Show when={props.call.output}>
            <pre class="max-h-64 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-background/60 p-2 text-muted-foreground">
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
            <div class="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5">
              <BlockText blocks={blocks()} />
            </div>
          </div>
        )}
      </Show>
      <For each={props.turn.assistant}>
        {(a) => (
          <div class="pr-8">
            <div class="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span class="font-medium text-event-assistant">assistant</span>
              <Show when={a.model}>
                <span class="font-mono">{a.model}</span>
              </Show>
              <Show when={a.partial}>
                <span class="animate-pulse">▋ streaming</span>
              </Show>
            </div>
            <BlockText blocks={a.content} />
          </div>
        )}
      </For>
      <For each={props.turn.tool_calls}>{(c) => <ToolCallRow call={c} />}</For>
    </div>
  );
}

export function SessionDetail(props: { id: string; back: () => void }) {
  // replayPos: when set, the view is projected from events up to that seq only
  const [replayPos, setReplayPos] = createSignal<number | null>(null);
  const [view, { refetch }] = createResource(
    () => ({ id: props.id, pos: replayPos() }),
    ({ id, pos }) =>
      getJson<SessionView>(
        `/sessions/${id}/view${pos === null ? "" : `?until_seq=${pos}`}`,
      ),
  );
  const [maxSeq] = createResource(async () => {
    const r = await getJson<{ events: StrataEvent[] }>(
      `/events?session_id=${encodeURIComponent(props.id)}&order=desc&limit=1`,
    );
    return r.events[0]?.seq ?? 0;
  });
  const [asks, { refetch: refetchAsks }] = createResource(async () => {
    const r = await getJson<{ pending: PendingAsk[] }>("/permissions");
    return r.pending.filter((p) => p.session_id === props.id);
  });
  const [draft, setDraft] = createSignal("");
  const [sendErr, setSendErr] = createSignal("");
  const [options] = createResource(() => getJson<OptionsResponse>("/options"));
  const [modelSel, setModelSel] = createSignal("");
  const [agentSel, setAgentSel] = createSignal("");
  const [variantSel, setVariantSel] = createSignal("");
  let draftEl: HTMLTextAreaElement | undefined;

  const selectedModel = () =>
    options()?.models.find((m) => `${m.providerID}/${m.modelID}` === modelSel());
  const modelGroups = () => {
    const byProvider = new Map<string, NonNullable<OptionsResponse>["models"]>();
    for (const m of options()?.models ?? []) {
      byProvider.set(m.providerID, [...(byProvider.get(m.providerID) ?? []), m]);
    }
    return [...byProvider.entries()];
  };

  onMount(() => {
    const es = new EventSource(api("/stream"));
    // partial assistant snapshots arrive rapidly during streaming — coalesce
    // refetches instead of re-projecting the whole log per snapshot
    let timer: ReturnType<typeof setTimeout> | undefined;
    es.onmessage = (m) => {
      try {
        const evt = JSON.parse(m.data) as { session_id?: string; type: string };
        if (evt.session_id === props.id || evt.type === "permission.requested") {
          if (replayPos() === null) {
            clearTimeout(timer);
            timer = setTimeout(() => {
              refetch();
              refetchAsks();
            }, 100);
          }
        }
      } catch {
        // non-session frames (service.connected)
      }
    };
    onCleanup(() => {
      clearTimeout(timer);
      es.close();
    });
  });

  const respond = async (requestId: string, decision: "allow" | "deny") => {
    await respondPermission(requestId, decision);
    refetchAsks();
  };

  const autogrow = () => {
    if (!draftEl) return;
    draftEl.style.height = "auto";
    draftEl.style.height = `${Math.min(draftEl.scrollHeight, 240)}px`;
  };

  const send = async () => {
    const text = draft().trim();
    if (!text) return;
    setDraft("");
    setSendErr("");
    if (draftEl) draftEl.style.height = "auto";
    const m = modelSel().split("/");
    const model = m.length === 2 ? { providerID: m[0]!, modelID: m[1]! } : undefined;
    const agent = agentSel() || undefined;
    const variant = variantSel() || undefined;
    try {
      const res = await fetch(api(`/sessions/${encodeURIComponent(props.id)}/prompt`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, model, agent, variant }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSendErr(body.error ?? `service ${res.status}`);
        setDraft(text);
      }
    } catch (err) {
      setSendErr(err instanceof Error ? err.message : "network error");
      setDraft(text);
    }
  };

  const pickerCls =
    "h-7 max-w-48 rounded-md border border-transparent bg-transparent px-1.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-secondary focus:border-input focus:outline-none";

  return (
    <main class="mx-auto max-w-3xl p-6">
      <button
        class="text-sm text-muted-foreground transition-colors hover:text-foreground"
        onClick={props.back}
      >
        ← fleet
      </button>
      <Show when={view()} fallback={<p class="mt-6 text-muted-foreground">loading…</p>}>
        {(v) => (
          <>
            <header class="mt-4 flex items-center gap-3">
              <span class={`h-2.5 w-2.5 rounded-full ${STATUS_DOT[v().status] ?? "bg-status-pending"}`} />
              <h1 class="truncate text-xl font-semibold">{v().title ?? v().session_id}</h1>
              <span class="text-sm text-muted-foreground">
                {STATUS_LABEL[v().status] ?? v().status}
              </span>
              <span class="ml-auto flex gap-2">
                <button
                  class={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    replayPos() !== null
                      ? "bg-event-assistant/20 text-event-assistant"
                      : "border border-border bg-secondary text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() =>
                    setReplayPos(replayPos() === null ? (maxSeq() ?? 0) : null)
                  }
                >
                  {replayPos() !== null ? "exit replay" : "⏮ replay"}
                </button>
                <a
                  class="rounded-md border border-border bg-secondary px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-ring/50 hover:text-foreground"
                  href={`/api/export?session_id=${v().session_id}`}
                  download=""
                >
                  export CASF
                </a>
              </span>
            </header>
            <div class="mt-1 font-mono text-xs text-muted-foreground">
              {v().backend} · {v().workspace ?? "—"} · {v().turns.length} turns ·{" "}
              {v().totals.tool_calls} tools · {fmtUsd(v().totals.cost_usd)}
            </div>

            <Show when={replayPos() !== null}>
              <section class="mt-4 flex items-center gap-3 rounded-lg border border-event-assistant/40 bg-event-assistant/5 px-4 py-2.5">
                <input
                  type="range"
                  class="flex-1 accent-event-assistant"
                  min={1}
                  max={maxSeq() ?? 1}
                  value={replayPos() ?? 1}
                  onInput={(e) => setReplayPos(Number(e.currentTarget.value))}
                />
                <span class="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                  event {replayPos()} / {maxSeq() ?? "?"}
                </span>
              </section>
            </Show>

            <Show when={replayPos() === null}>
            <For each={asks() ?? []}>
              {(p) => (
                <div class="mt-5 rounded-lg border border-event-permission/50 bg-event-permission/10 p-4">
                  <div class="flex items-center gap-2 text-sm font-medium text-event-permission">
                    permission requested — {p.tool}
                    <span class="ml-auto flex gap-2">
                      <button
                        class="rounded-md bg-status-active/20 px-3 py-1 text-xs font-medium text-status-active transition-opacity hover:opacity-80"
                        onClick={() => void respond(p.request_id, "allow")}
                      >
                        allow once
                      </button>
                      <button
                        class="rounded-md bg-destructive/20 px-3 py-1 text-xs font-medium text-destructive transition-opacity hover:opacity-80"
                        onClick={() => void respond(p.request_id, "deny")}
                      >
                        deny
                      </button>
                    </span>
                  </div>
                  <div class="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-secondary/50 p-2 font-mono text-xs text-muted-foreground">
                    {JSON.stringify(p.input, null, 2)}
                  </div>
                </div>
              )}
            </For>
            </Show>

            <section class="mt-6 space-y-6">
              <For each={v().turns}>{(t) => <TurnBlock turn={t} />}</For>
            </section>

            <Show when={replayPos() === null}>
            <section class="mt-8">
              <div class="rounded-xl border border-input bg-card transition-colors focus-within:border-ring">
                <textarea
                  ref={draftEl}
                  class="max-h-60 w-full resize-none bg-transparent px-4 py-3 font-sans text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none"
                  rows={1}
                  placeholder="send a prompt…"
                  value={draft()}
                  onInput={(e) => {
                    setDraft(e.currentTarget.value);
                    autogrow();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
                  }}
                />
                <div class="flex items-center gap-1.5 border-t border-border px-2.5 py-2">
                  <Show when={(options()?.models.length ?? 0) > 0}>
                    <select
                      class={pickerCls}
                      value={modelSel()}
                      onChange={(e) => {
                        setModelSel(e.currentTarget.value);
                        setVariantSel("");
                      }}
                    >
                      <option value="">model: default</option>
                      <For each={modelGroups()}>
                        {([pid, models]) => (
                          <optgroup label={pid}>
                            <For each={models}>
                              {(m) => (
                                <option value={`${m.providerID}/${m.modelID}`}>
                                  {m.modelID}
                                </option>
                              )}
                            </For>
                          </optgroup>
                        )}
                      </For>
                    </select>
                  </Show>
                  <Show when={(selectedModel()?.variants?.length ?? 0) > 0}>
                    <select
                      class={pickerCls}
                      value={variantSel()}
                      onChange={(e) => setVariantSel(e.currentTarget.value)}
                    >
                      <option value="">effort: default</option>
                      <For each={selectedModel()!.variants}>
                        {(v) => <option value={v}>{v}</option>}
                      </For>
                    </select>
                  </Show>
                  <Show when={(options()?.agents.length ?? 0) > 0}>
                    <select
                      class={pickerCls}
                      value={agentSel()}
                      onChange={(e) => setAgentSel(e.currentTarget.value)}
                    >
                      <option value="">agent: default</option>
                      <For each={options()!.agents}>
                        {(a) => <option value={a.name}>{a.name}</option>}
                      </For>
                    </select>
                  </Show>
                  <span class="ml-auto hidden text-[10px] text-muted-foreground sm:inline">
                    ⌘/Ctrl+Enter
                  </span>
                  <button
                    class="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                    disabled={!draft().trim()}
                    title="send"
                    onClick={() => void send()}
                  >
                    <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M8 12.5v-9M3.8 7.3 8 3l4.2 4.3" />
                    </svg>
                  </button>
                </div>
              </div>
              <Show when={sendErr()}>
                <p class="mt-2 font-mono text-xs text-destructive">{sendErr()}</p>
              </Show>
            </section>
            </Show>

            <Show when={v().files_changed.length > 0}>
              <section class="mt-8 rounded-lg border border-border bg-card p-4">
                <h2 class="text-sm font-medium">files changed</h2>
                <ul class="mt-2 space-y-1 font-mono text-xs">
                  <For each={v().files_changed}>
                    {(f) => (
                      <li class="flex gap-3">
                        <span class="w-14 text-event-file">{f.change}</span>
                        <span class="break-all text-muted-foreground">{f.path}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>
          </>
        )}
      </Show>
    </main>
  );
}
