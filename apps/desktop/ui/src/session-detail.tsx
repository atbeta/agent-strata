import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  api,
  fmtUsd,
  getJson,
  respondPermission,
  STATUS_DOT,
  STATUS_LABEL,
  type ContentBlock,
  type PendingAsk,
  type SessionView,
  type ToolCallView,
  type Turn,
} from "./api";

function BlockText(props: { blocks: ContentBlock[] }) {
  return (
    <For each={props.blocks}>
      {(b) => (
        <p class="whitespace-pre-wrap text-sm leading-relaxed">{b.text ?? `[${b.type}]`}</p>
      )}
    </For>
  );
}

function ToolCallRow(props: { call: ToolCallView }) {
  const statusColor = () =>
    props.call.status === "error" || props.call.permission?.decision === "deny"
      ? "text-status-error"
      : "text-event-tool";
  const inputPreview = () => {
    const s = JSON.stringify(props.call.input);
    return s.length > 80 ? s.slice(0, 80) + "…" : s;
  };
  return (
    <div class="rounded-md border border-border bg-secondary/50 px-3 py-2 font-mono text-xs">
      <div class="flex items-center gap-2">
        <span class={statusColor()}>▸ {props.call.tool}</span>
        <span class="truncate text-muted-foreground">{inputPreview()}</span>
        <span class="ml-auto shrink-0 text-muted-foreground">{props.call.status}</span>
      </div>
      <Show when={props.call.permission}>
        {(p) => (
          <div class="mt-1 text-event-permission">
            permission {p().decision ?? "pending"} by {p().by ?? "?"}
            {p().reason ? ` — ${p().reason}` : ""}
          </div>
        )}
      </Show>
      <Show when={props.call.output}>
        <div class="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap text-muted-foreground">
          {props.call.output}
        </div>
      </Show>
    </div>
  );
}

function TurnBlock(props: { turn: Turn }) {
  return (
    <div class="space-y-2">
      <Show when={props.turn.user}>
        {(blocks) => (
          <div class="border-l-2 border-event-user pl-3">
            <div class="text-xs font-medium text-event-user">user</div>
            <BlockText blocks={blocks()} />
          </div>
        )}
      </Show>
      <For each={props.turn.assistant}>
        {(a) => (
          <div class="border-l-2 border-event-assistant pl-3">
            <div class="flex gap-2 text-xs font-medium text-event-assistant">
              assistant
              <Show when={a.model}>
                <span class="font-mono font-normal text-muted-foreground">{a.model}</span>
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
  const [view, { refetch }] = createResource(
    () => props.id,
    (id) => getJson<SessionView>(`/sessions/${id}/view`),
  );
  const [asks, { refetch: refetchAsks }] = createResource(async () => {
    const r = await getJson<{ pending: PendingAsk[] }>("/permissions");
    return r.pending.filter((p) => p.session_id === props.id);
  });
  const [draft, setDraft] = createSignal("");
  const [sendErr, setSendErr] = createSignal("");

  onMount(() => {
    const es = new EventSource(api("/stream"));
    es.onmessage = (m) => {
      try {
        const evt = JSON.parse(m.data) as { session_id?: string; type: string };
        if (evt.session_id === props.id || evt.type === "permission.requested") {
          refetch();
          refetchAsks();
        }
      } catch {
        // non-session frames (service.connected)
      }
    };
    onCleanup(() => es.close());
  });

  const respond = async (requestId: string, decision: "allow" | "deny") => {
    await respondPermission(requestId, decision);
    refetchAsks();
  };

  const send = async () => {
    const text = draft().trim();
    if (!text) return;
    setDraft("");
    setSendErr("");
    const res = await fetch(api(`/sessions/${encodeURIComponent(props.id)}/prompt`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setSendErr(body.error ?? `service ${res.status}`);
      setDraft(text);
    }
  };

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
              <a
                class="ml-auto rounded-md border border-border bg-secondary px-3 py-1 text-xs transition-colors hover:border-ring/50"
                href={`/api/export?session=${v().session_id}`}
                download=""
              >
                export CASF
              </a>
            </header>
            <div class="mt-1 font-mono text-xs text-muted-foreground">
              {v().backend} · {v().workspace ?? "—"} · {v().turns.length} turns ·{" "}
              {v().totals.tool_calls} tools · {fmtUsd(v().totals.cost_usd)}
            </div>

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

            <section class="mt-6 space-y-5">
              <For each={v().turns}>{(t) => <TurnBlock turn={t} />}</For>
            </section>

            <section class="mt-8">
              <textarea
                class="w-full rounded-lg border border-input bg-secondary/50 p-3 font-sans text-sm text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none"
                rows={3}
                placeholder="send a prompt…"
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
                }}
              />
              <div class="mt-2 flex items-center gap-3">
                <button
                  class="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
                  onClick={() => void send()}
                >
                  send ��↵
                </button>
                <Show when={sendErr()}>
                  <span class="text-xs text-destructive">{sendErr()}</span>
                </Show>
              </div>
            </section>

            <Show when={v().files_changed.length > 0}>
              <section class="mt-8 rounded-lg border border-border bg-card p-4">
                <h2 class="text-sm font-medium">files changed</h2>
                <ul class="mt-2 space-y-1 font-mono text-xs">
                  <For each={v().files_changed}>
                    {(f) => (
                      <li class="flex gap-3">
                        <span class="w-14 text-event-file">{f.change}</span>
                        <span class="text-muted-foreground">{f.path}</span>
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
