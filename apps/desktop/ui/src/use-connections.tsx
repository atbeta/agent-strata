import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import {
  backendLabel,
  connectBackend,
  disconnectBackend,
  forgetBackend,
  getJson,
  getJsonWhenUp,
  type ConnectionAttempt,
  type ConnectionPlacement,
  type ConnectionsResponse,
} from "./api";
import { settled } from "./resource";
import { staleSyncTicks } from "./sync-events";
import { backendHeadline, viewPhase, type ViewPhase } from "./connection-status";
import { explain, fadeSignal } from "./errors";
import { t } from "./i18n";
import { Icon } from "./icons";
import { Tip } from "./tip";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

const NEW_CONN_KEY = "strata.newSessionConnection";

export function endpointHost(url: string): string {
  if (url.startsWith("acp://")) return url.slice("acp://".length);
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The shortest form of an address that still tells two instances apart.
 *
 * Local backends are nearly all loopback, and every one of them reads
 * `127.0.0.1:<port>` — the host is the part that never varies and the port is
 * the whole identity, so a row that shows the host too has spent its width on
 * nothing. A remote address keeps its host, because there it is the part that
 * repeats.
 */
export function endpointShort(url: string): string {
  const host = endpointHost(url);
  const name = host.toLowerCase();
  const loopback =
    host.startsWith("127.") ||
    name === "localhost" ||
    name.startsWith("localhost:") ||
    host.startsWith("[::1]:");
  if (!loopback) return host;
  const colon = host.lastIndexOf(":");
  const port = colon === -1 ? "" : host.slice(colon + 1);
  return /^\d+$/.test(port) ? port : host;
}

/**
 * Everything the sidebar knows about backends: the connection list, the
 * connect form, which connection a new session lands on, and per-connection
 * sync progress replayed from the stream.
 */
export function useConnections(opts: {
  currentDir: () => string | undefined;
  onChanged: () => void;
  /** Every sync is over, however it ended: the last tick is gone. */
  onSyncOver?: () => void;
}) {
  // The first read waits out the race with the service coming up. A fetch that
  // fails in that race is not "no backend" — concluding that paints the
  // disconnected sentence over a launch that has not answered yet.
  let opened = false;
  const [conns, { refetch: refetchConns }] = createResource(() => {
    const load = opened
      ? getJson<ConnectionsResponse>("/connections")
      : getJsonWhenUp<ConnectionsResponse>("/connections");
    opened = true;
    return load;
  });
  const phase = (): ViewPhase => viewPhase(settled(conns), conns.error);
  const connected = () => phase() === "connected";
  const attempts = () => settled(conns)?.attempts ?? [];
  const failedAttempts = () => attempts().filter((attempt) => attempt.phase === "failed");

  // Boot can give up between the 12s polls. While something is still being
  // dialed, reread often enough that the failure shows when the dialing stops.
  createEffect(() => {
    if (phase() !== "attaching") return;
    const timer = setInterval(() => void refetchConns(), 500);
    onCleanup(() => clearInterval(timer));
  });

  const [connErr, setConnErr] = fadeSignal("");
  const [connUrl, setConnUrl] = createSignal("http://127.0.0.1:4096");
  const [connName, setConnName] = createSignal("");
  const [connKind, setConnKind] = createSignal<"opencode" | "acp">("opencode");
  const [connCmd, setConnCmd] = createSignal("opencode acp");
  const [connUser, setConnUser] = createSignal("");
  const [connPass, setConnPass] = createSignal("");
  const [connecting, setConnecting] = createSignal(false);

  const [newConn, setNewConn] = createSignal<string | null>(localStorage.getItem(NEW_CONN_KEY));
  const chooseNewConn = (id: string) => {
    setNewConn(id);
    localStorage.setItem(NEW_CONN_KEY, id);
  };
  const newSessionConnection = () => {
    const list = settled(conns)?.connections ?? [];
    return list.find((c) => c.id === newConn())?.id ?? list[0]?.id;
  };

  const connect = async () => {
    setConnErr("");
    setConnecting(true);
    try {
      const words = connCmd().trim().split(/\s+/).filter(Boolean);
      const id = await connectBackend(
        connKind() === "acp"
          ? {
              backend: "acp",
              command: words[0]!,
              args: words.slice(1),
              cwd: opts.currentDir(),
              name: connName().trim() || undefined,
            }
          : {
              baseUrl: connUrl().trim(),
              name: connName().trim() || undefined,
              username: connUser() || undefined,
              password: connPass() || undefined,
            },
      );
      chooseNewConn(id);
      refetchConns();
      opts.onChanged();
      window.dispatchEvent(new Event("strata-connections"));
    } catch (e) {
      setConnErr(explain(e));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = (id: string) => {
    void disconnectBackend(id).then(() => {
      refetchConns();
      window.dispatchEvent(new Event("strata-connections"));
    });
  };

  const forget = (endpoint: string) => {
    void forgetBackend(endpoint).then(() => {
      refetchConns();
      window.dispatchEvent(new Event("strata-connections"));
    });
  };

  /**
   * Backend sync progress per connection. `started`/`progress`/`finished`
   * arrive over the stream; the strip only appears once a sync outlives a
   * short grace period, so the steady-state poll — over in a blink — never
   * flashes it.
   */
  const [syncTicks, setSyncTicks] = createSignal<ReadonlyMap<string, { done: number; total: number }>>(
    new Map(),
  );
  const [syncShown, setSyncShown] = createSignal(false);
  let syncGrace: ReturnType<typeof setTimeout> | undefined;

  /**
   * The check that finds a tick the stream lost.
   *
   * `sync.finished` rides the socket. A socket that breaks in the middle of a
   * sync never delivers it, and the tick then holds everything still for
   * good: the pull stays off, the transcript's own events are dropped, and
   * the spinner never stops.
   *
   * So a tick that is still up is checked against the service, which is the
   * authority. The read has to be a request of its own, issued after the
   * `sync.started` that made the tick: the snapshot in hand may have been
   * taken before that and would answer `idle` for a sync that is running —
   * which would clear a live sync and let the token total climb again, row
   * by row. The service writes the sync into `activeSyncs` before it
   * broadcasts `sync.started`, so a request that leaves after the tick
   * exists reads the truth.
   */
  const reconcileTicks = async () => {
    // Only the ids this read can speak for: a tick that appeared while the
    // request was in flight is younger than the rows it answers.
    const ids = [...syncTicks().keys()];
    if (ids.length === 0) return;
    let rows: ConnectionsResponse;
    try {
      rows = await getJson<ConnectionsResponse>("/connections");
    } catch {
      return; // the service is unreachable; the next tick asks again
    }
    const known = new Map(ids.map((id) => [id, true]));
    for (const id of staleSyncTicks(known, rows.connections)) dropTick(id);
  };

  /**
   * The check runs while a tick is up. It starts with the first tick and
   * stops with the last, rather than through an effect: a progress event
   * arrives often enough that an effect reading the ticks would rebuild the
   * timer before it ever fired.
   */
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  const stopReconciling = () => {
    if (!reconcileTimer) return;
    clearInterval(reconcileTimer);
    reconcileTimer = undefined;
  };
  const startReconciling = () => {
    if (reconcileTimer) return;
    reconcileTimer = setInterval(() => void reconcileTicks(), 1_000);
  };
  onCleanup(stopReconciling);

  /**
   * A tick goes away — the service said the sync finished, or the tick was
   * found stale. Either way the last one to go is the moment the reader gets
   * the list back: the strip comes down and everything is read once more.
   */
  const dropTick = (id: string) => {
    const next = new Map(syncTicks());
    next.delete(id);
    setSyncTicks(next);
    if (next.size > 0) return;
    clearTimeout(syncGrace);
    setSyncShown(false);
    stopReconciling();
    // The list is held still while any sync runs; reread once, when the
    // last one is over, rather than on every connection's finish.
    opts.onChanged();
    opts.onSyncOver?.();
  };

  const onSyncEvent = (evt: { type?: string; connection_id?: string; done?: number; total?: number }) => {
    const id = evt.connection_id ?? "";
    if (evt.type === "sync.finished") {
      dropTick(id);
      return;
    }
    const idle = syncTicks().size === 0;
    const next = new Map(syncTicks());
    next.set(id, { done: evt.done ?? 0, total: evt.total ?? 0 });
    setSyncTicks(next);
    startReconciling();
    if (idle) syncGrace = setTimeout(() => setSyncShown(true), 1_500);
  };
  const clearSyncGrace = () => clearTimeout(syncGrace);

  /**
   * The snapshot's own sync flag, for the gap the stream cannot cover.
   * `syncTicks` is fed by `sync.*` events, but a conn is listed before its
   * sync starts and the socket attaches later still — a sync that fires in
   * between produces no events this window can see. While the snapshot says
   * busy and the ticks are quiet, reread until one side catches up.
   */
  const syncBusy = () =>
    (settled(conns)?.connections ?? []).some((c) => c.sync === "starting" || c.sync === "syncing");
  createEffect(() => {
    if (!syncBusy() || syncTicks().size > 0) return;
    const timer = setInterval(() => void refetchConns(), 1_000);
    onCleanup(() => clearInterval(timer));
  });

  return {
    conns,
    refetchConns,
    phase,
    attempts,
    failedAttempts,
    connected,
    connUrl,
    setConnUrl,
    connName,
    setConnName,
    connKind,
    setConnKind,
    connCmd,
    setConnCmd,
    connUser,
    setConnUser,
    connPass,
    setConnPass,
    connErr,
    setConnErr,
    connecting,
    connect,
    disconnect,
    forget,
    chooseNewConn,
    newSessionConnection,
    syncTicks,
    syncShown,
    syncBusy,
    onSyncEvent,
    clearSyncGrace,
    reconcileTicks,
  };
}

export type ConnectionsCtl = ReturnType<typeof useConnections>;

function placementWord(placement: ConnectionPlacement | undefined): string {
  if (placement === "embed") return t("connect.placement.embed");
  if (placement === "external") return t("connect.placement.external");
  return "";
}

function attemptLine(attempt: ConnectionAttempt): string {
  const place = placementWord(attempt.placement);
  const host = endpointShort(attempt.endpoint);
  return place ? `${host} · ${place}` : host;
}

const HEADLINE_KEY = {
  connecting: "sidebar.backend.connecting",
  failed: "sidebar.backend.failed",
  missing: "sidebar.backend.missing",
  unreachable: "error.serviceUnreachable",
  none: "sidebar.backend.none",
} as const;

/**
 * The sidebar's bottom strip: the live connections, and a way into the rules
 * this window runs under.
 *
 * Adding, disconnecting and forgetting an address are a list with actions, and
 * this corner is one line tall. The rows here are the situation — which
 * backends are up, and whether one of them is still syncing. Beside them sit
 * the two doors that change what this window may do: the permission policy,
 * which decides what an agent can run without asking, and the settings gear.
 */
export function ConnectionsFooter(props: { conns: ConnectionsCtl }) {
  const c = () => props.conns;
  const headline = () => backendHeadline(c().phase());
  const headlineTone = () =>
    headline() === "failed" || headline() === "unreachable" ? "text-destructive" : "text-muted-foreground";
  return (
    <div class="border-t border-border px-2">
      <Show when={c().connErr() && !c().connected()}>
        <p class="my-1 px-1.5 font-mono text-2xs text-destructive">{c().connErr()}</p>
      </Show>
      <div class="flex min-h-7 items-center gap-1">
        <div class="min-w-0 flex-1">
          <Show
            when={c().connected()}
            fallback={
              <p class={`truncate px-1.5 py-1 text-xs ${headlineTone()}`}>{t(HEADLINE_KEY[headline()])}</p>
            }
          >
            <For each={settled(c().conns)?.connections ?? []}>
              {(conn) => {
                const tick = () => (c().syncShown() ? c().syncTicks().get(conn.id) : undefined);
                const syncText = () =>
                  tick()
                    ? tick()!.total > 0
                      ? t("sidebar.sync.progress", { done: tick()!.done, total: tick()!.total })
                      : t("sidebar.sync.scanning")
                    : undefined;
                return (
                  <div
                    class="flex min-w-0 items-center gap-2 px-1.5 py-0 text-xs"
                    title={syncText()}
                  >
                    <Show
                      when={tick()}
                      fallback={<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-status-active" />}
                    >
                      <span
                        class="size-3 shrink-0 rounded-full border-2 border-muted-foreground/25 border-t-foreground motion-safe:animate-spin"
                        role="img"
                        aria-label={syncText() ?? t("sidebar.sync.busy")}
                      />
                    </Show>
                    <Tip label={endpointHost(conn.baseUrl)} class="min-w-0">
                      <span class="truncate">
                        {backendLabel(conn.backend)}
                        <Show when={placementWord(conn.placement)}>
                          {(word) => <span class="text-2xs text-muted-foreground"> {word()}</span>}
                        </Show>
                      </span>
                    </Tip>
                  </div>
                );
              }}
            </For>
          </Show>
        </div>
        <Tip label={t("sidebar.permission.policy")}>
          <Button
            variant="icon"
            size="icon-2xs"
            class="text-muted-foreground"
            aria-label={t("sidebar.permission.policy")}
            onClick={() => {
              location.hash = "/settings/permission";
            }}
          >
            <Icon name="shield" class="size-3.5" />
          </Button>
        </Tip>
        <Tip label={t("settings.open")}>
          <Button
            variant="icon"
            size="icon-2xs"
            class="text-muted-foreground"
            aria-label={t("settings.open")}
            onClick={() => {
              location.hash = "/settings/backends";
            }}
          >
            <Icon name="gear" class="size-3.5" />
          </Button>
        </Tip>
      </div>
    </div>
  );
}


/**
 * The fleet page when nothing is connected yet.
 *
 * Same phase as the footer. The connect button appears once we know a person
 * has to do something — not while the first read is still in flight, and not
 * while a backend is still being dialed.
 */
export function ConnectionEmpty(props: { conns: ConnectionsCtl }) {
  const phase = () => props.conns.phase();
  const connecting = () => phase() === "pending" || phase() === "attaching";
  const failed = () => phase() === "failed";
  const missing = () => phase() === "missing";
  const unreachable = () => phase() === "unreachable";
  const title = () =>
    connecting()
      ? t("action.attachingBackend")
      : failed()
        ? t("sidebar.backend.failed")
        : missing()
          ? t("sidebar.backend.missing")
          : unreachable()
            ? t("error.serviceUnreachable")
            : t("action.connectBackend");
  const description = () => {
    if (connecting()) return t("fleet.hint.connecting");
    if (failed()) {
      const targets = props.conns.failedAttempts().map(attemptLine).join("  ");
      return targets ? `${targets} ${t("fleet.hint.failed")}` : t("fleet.hint.failed");
    }
    if (missing()) return t("settings.opencode.missing");
    if (phase() === "idle") return t("fleet.hint.disconnected");
    return undefined;
  };
  return (
    <EmptyState
      icon={failed() || unreachable() ? "alert" : "plug"}
      tone={failed() || unreachable() ? "danger" : "neutral"}
      title={title()}
      description={description()}
      action={
        failed() || phase() === "idle" ? (
          <Button
            onClick={() => {
              location.hash = "/settings/backends";
            }}
          >
            {t("action.connect")}
          </Button>
        ) : missing() ? (
          <a
            href="https://opencode.ai"
            target="_blank"
            rel="noreferrer"
            class="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {t("settings.opencode.install")}
          </a>
        ) : undefined
      }
    />
  );
}
