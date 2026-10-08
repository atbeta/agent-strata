import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  api,
  fmtUsd,
  getJson,
  STATUS_DOT,
  STATUS_LABEL,
  type SessionRow,
  type SessionsResponse,
} from "./api";
import { SessionDetail } from "./session-detail";
import { CompareView } from "./compare";

type Route =
  | { name: "fleet" }
  | { name: "session"; id: string }
  | { name: "compare"; a: string; b: string };

function parseHash(): Route {
  const h = location.hash.slice(1);
  const s = h.match(/^\/session\/(.+)$/);
  if (s) return { name: "session", id: s[1]! };
  const c = h.match(/^\/compare\/([^/]+)\/(.+)$/);
  if (c) return { name: "compare", a: c[1]!, b: c[2]! };
  return { name: "fleet" };
}

function SessionCard(props: {
  s: SessionRow;
  compareSelected: boolean;
  onCompareToggle: () => void;
}) {
  const dot = () => STATUS_DOT[props.s.status] ?? "bg-status-pending";
  const label = () => STATUS_LABEL[props.s.status] ?? props.s.status;
  return (
    <article
      class={`cursor-pointer rounded-lg border bg-card p-4 text-card-foreground transition-colors hover:border-ring/50 ${
        props.compareSelected ? "border-ring" : "border-border"
      }`}
      onClick={() => (location.hash = `/session/${props.s.summary.session_id}`)}
    >
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
      <div class="mt-3 flex items-center gap-4 font-mono text-xs text-muted-foreground tabular-nums">
        <span>{props.s.totals.tool_calls} tools</span>
        <span>{(props.s.totals.input + props.s.totals.output).toLocaleString()} tok</span>
        <span>{fmtUsd(props.s.totals.cost_usd)}</span>
        <button
          class={`ml-auto rounded px-2 py-0.5 text-[10px] transition-colors ${
            props.compareSelected
              ? "bg-primary text-primary-foreground"
              : "bg-secondary text-muted-foreground hover:text-foreground"
          }`}
          onClick={(e) => {
            e.stopPropagation();
            props.onCompareToggle();
          }}
        >
          {props.compareSelected ? "A/B ✓" : "compare"}
        </button>
      </div>
    </article>
  );
}

function Fleet() {
  const [data, { refetch }] = createResource(() => getJson<SessionsResponse>("/sessions"));
  const [liveCount, setLiveCount] = createSignal(0);
  const [compareSel, setCompareSel] = createSignal<string[]>([]);

  const toggleCompare = (id: string) =>
    setCompareSel((sel) =>
      sel.includes(id) ? sel.filter((x) => x !== id) : [...sel.slice(-1), id],
    );

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
      <header class="flex items-end">
        <div>
          <h1 class="text-2xl font-semibold">Agent Strata</h1>
          <p class="mt-1 text-sm text-muted-foreground">
            fleet view — all agent sessions, live from the event log
          </p>
        </div>
        <Show when={compareSel().length === 2}>
          <button
            class="ml-auto rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            onClick={() => {
              const [a, b] = compareSel();
              location.hash = `/compare/${a}/${b}`;
            }}
          >
            compare 2 sessions →
          </button>
        </Show>
      </header>

      <section class="mt-5 flex gap-8 rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
        <div>
          total cost:{" "}
          <b class="font-mono text-foreground tabular-nums">
            {fmtUsd(data()?.aggregate.total.cost_usd ?? 0)}
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
        <For
          each={data()?.sessions ?? []}
          fallback={<p class="text-muted-foreground">no sessions yet</p>}
        >
          {(s) => (
            <SessionCard
              s={s}
              compareSelected={compareSel().includes(s.summary.session_id)}
              onCompareToggle={() => toggleCompare(s.summary.session_id)}
            />
          )}
        </For>
      </section>
    </main>
  );
}

export function App() {
  const [route, setRoute] = createSignal<Route>(parseHash());
  onMount(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    onCleanup(() => window.removeEventListener("hashchange", onHash));
  });
  const back = () => (location.hash = "/");

  return (
    <Show
      when={route().name === "fleet"}
      fallback={
        <Show
          when={route().name === "session" && (route() as { id: string }).id}
          fallback={
            <CompareView
              a={(route() as { a: string }).a}
              b={(route() as { b: string }).b}
              back={back}
            />
          }
        >
          <SessionDetail id={(route() as { id: string }).id} back={back} />
        </Show>
      }
    >
      <Fleet />
    </Show>
  );
}
