import { createResource, createSignal, For, onCleanup, onMount } from "solid-js";

interface SessionRow {
  summary: {
    session_id: string;
    backend: string;
    workspace: string | null;
    title: string | null;
    started_at: string;
    last_seq: number;
  };
  status: "active" | "completed" | "cancelled" | "error" | string;
  title?: string;
  totals: { input: number; output: number; cost_usd: number; tool_calls: number };
}

interface SessionsResponse {
  sessions: SessionRow[];
  aggregate: { total: { cost_usd: number; input: number; output: number } };
}

const api = (p: string) => `/api${p}`;

const STATUS_DOT: Record<string, string> = {
  active: "bg-status-active",
  completed: "bg-status-completed",
  error: "bg-status-error",
  cancelled: "bg-status-cancelled",
};

const STATUS_LABEL: Record<string, string> = {
  active: "running",
  completed: "done",
  error: "error",
  cancelled: "stopped",
};

function SessionCard(props: { s: SessionRow }) {
  const dot = () => STATUS_DOT[props.s.status] ?? "bg-status-pending";
  const label = () => STATUS_LABEL[props.s.status] ?? props.s.status;
  return (
    <article class="rounded-lg border border-border bg-card p-4 text-card-foreground transition-colors hover:border-ring/50">
      <div class="flex items-center gap-2">
        <span class={`h-2 w-2 shrink-0 rounded-full ${dot()}`} />
        <b class="truncate text-sm font-medium">
          {props.s.title ?? props.s.summary.title ?? props.s.summary.session_id}
        </b>
        <span class="ml-auto shrink-0 text-xs text-muted-foreground">{label()}</span>
      </div>
      <div class="mt-2 truncate font-mono text-xs text-muted-foreground">
        {props.s.summary.backend} · {props.s.summary.workspace ?? "—"}
      </div>
      <div class="mt-3 flex gap-4 font-mono text-xs text-muted-foreground tabular-nums">
        <span>{props.s.totals.tool_calls} tools</span>
        <span>{(props.s.totals.input + props.s.totals.output).toLocaleString()} tok</span>
        <span>${props.s.totals.cost_usd.toFixed(4)}</span>
      </div>
    </article>
  );
}

export function App() {
  const [data, { refetch }] = createResource(async () => {
    const res = await fetch(api("/sessions"));
    if (!res.ok) throw new Error(`service ${res.status}`);
    return (await res.json()) as SessionsResponse;
  });
  const [liveCount, setLiveCount] = createSignal(0);

  onMount(() => {
    const es = new EventSource(api("/stream"));
    es.onmessage = () => {
      setLiveCount((n) => n + 1);
      refetch();
    };
    onCleanup(() => es.close());
  });

  return (
    <main class="mx-auto max-w-6xl p-6">
      <header>
        <h1 class="text-2xl font-semibold">Agent Strata</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          fleet view — all agent sessions, live from the event log
        </p>
      </header>

      <section class="mt-5 flex gap-8 rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
        <div>
          total cost:{" "}
          <b class="font-mono text-foreground tabular-nums">
            ${(data()?.aggregate.total.cost_usd ?? 0).toFixed(4)}
          </b>
        </div>
        <div>
          tokens:{" "}
          <b class="font-mono text-foreground tabular-nums">
            {(data()?.aggregate.total.input ?? 0).toLocaleString()} in
          </b>
          {" / "}
          <b class="font-mono text-foreground tabular-nums">
            {(data()?.aggregate.total.output ?? 0).toLocaleString()} out
          </b>
        </div>
        <div>
          live events: <b class="font-mono text-foreground tabular-nums">{liveCount()}</b>
        </div>
      </section>

      <section class="mt-5 grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
        <For each={data()?.sessions ?? []} fallback={<p class="text-muted-foreground">no sessions yet</p>}>
          {(s) => <SessionCard s={s} />}
        </For>
      </section>
    </main>
  );
}
