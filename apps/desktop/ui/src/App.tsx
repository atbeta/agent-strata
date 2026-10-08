import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  api,
  connectBackend,
  disconnectBackend,
  fmtUsd,
  getJson,
  STATUS_DOT,
  STATUS_LABEL,
  type Connection,
  type SessionRow,
  type SessionsResponse,
  type StrataEvent,
} from "./api";
import { SessionDetail } from "./session-detail";
import { CompareView } from "./compare";
import { PolicyEditor } from "./policy";

type Route =
  | { name: "fleet" }
  | { name: "session"; id: string }
  | { name: "compare"; a: string; b: string }
  | { name: "policy" };

function parseHash(): Route {
  const h = location.hash.slice(1);
  const s = h.match(/^\/session\/(.+)$/);
  if (s) return { name: "session", id: s[1]! };
  const c = h.match(/^\/compare\/([^/]+)\/(.+)$/);
  if (c) return { name: "compare", a: c[1]!, b: c[2]! };
  if (h === "/policy") return { name: "policy" };
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

function eventPreview(e: StrataEvent): string {
  const d = e.data;
  const blocks = (d.content ?? d.output) as unknown;
  if (Array.isArray(blocks))
    return blocks
      .map((b) => (typeof b === "object" && b !== null ? String((b as { text?: string }).text ?? `[${(b as { type?: string }).type}]`) : String(b)))
      .join(" ")
      .slice(0, 140);
  if (typeof blocks === "string") return blocks.slice(0, 140);
  if (d.tool) return `${String(d.tool)} ${JSON.stringify(d.input ?? "").slice(0, 100)}`;
  if (d.path) return String(d.path);
  if (d.title) return String(d.title);
  return JSON.stringify(d).slice(0, 140);
}

function Fleet() {
  const [data, { refetch }] = createResource(() => getJson<SessionsResponse>("/sessions"));
  const [conns, { refetch: refetchConns }] = createResource(() =>
    getJson<{ connections: Connection[] }>("/connections"),
  );
  const [connOpen, setConnOpen] = createSignal(false);
  const [connUrl, setConnUrl] = createSignal("http://127.0.0.1:4096");
  const [connName, setConnName] = createSignal("");
  const [connUser, setConnUser] = createSignal("");
  const [connPass, setConnPass] = createSignal("");
  const [connErr, setConnErr] = createSignal("");
  const [connecting, setConnecting] = createSignal(false);
  const [liveCount, setLiveCount] = createSignal(0);
  const [compareSel, setCompareSel] = createSignal<string[]>([]);
  const [query, setQuery] = createSignal("");
  const [results] = createResource(query, async (q) =>
    q.trim()
      ? (await getJson<{ events: StrataEvent[] }>(
          `/events?text=${encodeURIComponent(q.trim())}&order=desc&limit=50`,
        )).events
      : [],
  );

  const connect = async () => {
    setConnErr("");
    setConnecting(true);
    try {
      await connectBackend({
        baseUrl: connUrl().trim(),
        name: connName().trim() || undefined,
        username: connUser() || undefined,
        password: connPass() || undefined,
      });
      setConnOpen(false);
      refetchConns();
      refetch();
    } catch (e) {
      setConnErr(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  };

  const toggleCompare = (id: string) =>
    setCompareSel((sel) =>
      sel.includes(id) ? sel.filter((x) => x !== id) : [...sel.slice(-1), id],
    );

  const groups = () => {
    const byWs = new Map<string, SessionRow[]>();
    for (const s of data()?.sessions ?? []) {
      const ws = s.summary.workspace ?? "no workspace";
      byWs.set(ws, [...(byWs.get(ws) ?? []), s]);
    }
    return [...byWs.entries()].map(([workspace, sessions]) => ({ workspace, sessions }));
  };

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
        <div class="ml-auto flex gap-2">
          <button
            class="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => (location.hash = "/policy")}
          >
            policy
          </button>
          <button
            class="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            onClick={async () => {
              const res = await fetch(api("/sessions"), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
              });
              const body = (await res.json()) as { id?: string };
              if (body.id) location.hash = `/session/${body.id}`;
            }}
          >
            + new session
          </button>
          <Show when={compareSel().length === 2}>
          <button
            class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            onClick={() => {
              const [a, b] = compareSel();
              location.hash = `/compare/${a}/${b}`;
            }}
          >
            compare 2 sessions →
          </button>
          </Show>
        </div>
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

      <section class="mt-4 rounded-lg border border-border bg-card px-4 py-3">
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span class="font-medium text-muted-foreground">backends</span>
          <For each={conns()?.connections ?? []}>
            {(c) => (
              <span class="flex items-center gap-1.5 rounded-md bg-secondary px-2 py-1 font-mono">
                <span class="h-1.5 w-1.5 rounded-full bg-status-active" />
                {c.name ?? c.baseUrl}
                <span class="text-muted-foreground">
                  {c.name ? c.baseUrl : c.backend}
                </span>
                <button
                  class="ml-1 text-muted-foreground transition-colors hover:text-destructive"
                  title="disconnect"
                  onClick={() =>
                    void disconnectBackend(c.id).then(() => {
                      refetchConns();
                      refetch();
                    })
                  }
                >
                  ✕
                </button>
              </span>
            )}
          </For>
          <Show when={(conns()?.connections.length ?? 0) === 0}>
            <span class="text-muted-foreground">none connected</span>
          </Show>
          <button
            class="ml-auto rounded-md bg-secondary px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
            onClick={() => setConnOpen((v) => !v)}
          >
            {connOpen() ? "cancel" : "+ connect"}
          </button>
        </div>
        <Show when={connOpen()}>
          <div class="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
            <input
              class="w-52 rounded-md border border-input bg-secondary/50 px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none"
              placeholder="server URL"
              value={connUrl()}
              onInput={(e) => setConnUrl(e.currentTarget.value)}
            />
            <input
              class="w-32 rounded-md border border-input bg-secondary/50 px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none"
              placeholder="name (optional)"
              value={connName()}
              onInput={(e) => setConnName(e.currentTarget.value)}
            />
            <input
              class="w-28 rounded-md border border-input bg-secondary/50 px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none"
              placeholder="username (optional)"
              value={connUser()}
              onInput={(e) => setConnUser(e.currentTarget.value)}
            />
            <input
              type="password"
              class="w-28 rounded-md border border-input bg-secondary/50 px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none"
              placeholder="password (optional)"
              value={connPass()}
              onInput={(e) => setConnPass(e.currentTarget.value)}
            />
            <button
              class="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              disabled={connecting() || !connUrl().trim()}
              onClick={() => void connect()}
            >
              {connecting() ? "connecting…" : "add server"}
            </button>
          </div>
        </Show>
        <Show when={connErr()}>
          <p class="mt-2 font-mono text-xs text-destructive">{connErr()}</p>
        </Show>
      </section>

      <div class="mt-4">
        <input
          class="w-full max-w-md rounded-md border border-input bg-secondary/50 px-3 py-1.5 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none"
          placeholder="search all sessions (FTS)…"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </div>

      <Show when={query().trim()}>
        <section class="mt-4 rounded-lg border border-border bg-card">
          <For
            each={results() ?? []}
            fallback={
              <p class="p-4 text-sm text-muted-foreground">
                {results.loading ? "searching…" : "no events match"}
              </p>
            }
          >
            {(e) => (
              <button
                class="block w-full border-b border-border px-4 py-2.5 text-left transition-colors last:border-0 hover:bg-secondary/50"
                onClick={() => (location.hash = `/session/${e.session_id}`)}
              >
                <div class="flex items-center gap-2 text-xs">
                  <span class="font-mono text-event-tool">{e.type}</span>
                  <span class="truncate font-mono text-muted-foreground">{e.session_id}</span>
                  <span class="ml-auto shrink-0 font-mono text-muted-foreground tabular-nums">
                    {e.ts.slice(0, 19).replace("T", " ")}
                  </span>
                </div>
                <div class="mt-1 truncate text-sm text-foreground/80">{eventPreview(e)}</div>
              </button>
            )}
          </For>
        </section>
      </Show>

      <Show when={!query().trim()}>
      <For each={groups()} fallback={<p class="mt-5 text-muted-foreground">no sessions yet</p>}>
        {(g) => (
          <section class="mt-6">
            <h2 class="mb-3 font-mono text-xs font-medium text-muted-foreground">{g.workspace}</h2>
            <div class="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
              <For each={g.sessions}>
                {(s) => (
                  <SessionCard
                    s={s}
                    compareSelected={compareSel().includes(s.summary.session_id)}
                    onCompareToggle={() => toggleCompare(s.summary.session_id)}
                  />
                )}
              </For>
            </div>
          </section>
        )}
      </For>
      </Show>
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
    <>
      <Show when={route().name === "fleet"}>
        <Fleet />
      </Show>
      <Show when={route().name === "session"}>
        <SessionDetail id={(route() as { id: string }).id} back={back} />
      </Show>
      <Show when={route().name === "compare"}>
        <CompareView
          a={(route() as { a: string }).a}
          b={(route() as { b: string }).b}
          back={back}
        />
      </Show>
      <Show when={route().name === "policy"}>
        <PolicyEditor back={back} />
      </Show>
    </>
  );
}
