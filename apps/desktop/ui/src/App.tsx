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
  status: string;
  title?: string;
  totals: { input: number; output: number; cost_usd: number; tool_calls: number };
}

interface SessionsResponse {
  sessions: SessionRow[];
  aggregate: { total: { cost_usd: number; input: number; output: number } };
}

const api = (p: string) => `/api${p}`;

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
    <main>
      <header>
        <h1>Agent Strata</h1>
        <p class="sub">fleet view — all agent sessions, live from the event log</p>
      </header>
      <section class="agg">
        <div>
          total cost:{" "}
          <b>${(data()?.aggregate.total.cost_usd ?? 0).toFixed(4)}</b>
        </div>
        <div>
          tokens: <b>{(data()?.aggregate.total.input ?? 0).toLocaleString()} in</b> /{" "}
          <b>{(data()?.aggregate.total.output ?? 0).toLocaleString()} out</b>
        </div>
        <div>live events received: <b>{liveCount()}</b></div>
      </section>
      <section class="grid">
        <For each={data()?.sessions ?? []} fallback={<p class="empty">no sessions yet</p>}>
          {(s) => (
            <article class={`card ${s.status}`}>
              <div class="row">
                <span class={`dot ${s.status}`} />
                <b>{s.title ?? s.summary.title ?? s.summary.session_id}</b>
              </div>
              <div class="meta">
                {s.summary.backend} · {s.summary.workspace ?? "—"}
              </div>
              <div class="stats">
                <span>{s.totals.tool_calls} tool calls</span>
                <span>
                  {(s.totals.input + s.totals.output).toLocaleString()} tok
                </span>
                <span>${s.totals.cost_usd.toFixed(4)}</span>
              </div>
            </article>
          )}
        </For>
      </section>
    </main>
  );
}
