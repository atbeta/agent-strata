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
import { backendHeadline, viewPhase, type ViewPhase } from "./connection-status";
import { explain } from "./errors";
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
  const loopback = /^127\./.test(host) || /^localhost(:|$)/i.test(host) || /^\[::1\]:/.test(host);
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

  const [connErr, setConnErrRaw] = createSignal("");
  let connErrTimer: ReturnType<typeof setTimeout> | undefined;
  const setConnErr = (msg: string) => {
    clearTimeout(connErrTimer);
    setConnErrRaw(msg);
    connErrTimer = msg ? setTimeout(() => setConnErrRaw(""), 12_000) : undefined;
  };
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
  const onSyncEvent = (evt: { type?: string; connection_id?: string; done?: number; total?: number }) => {
    const id = evt.connection_id ?? "";
    if (evt.type === "sync.finished") {
      const next = new Map(syncTicks());
      next.delete(id);
      setSyncTicks(next);
      if (next.size === 0) {
        clearTimeout(syncGrace);
        setSyncShown(false);
      }
      opts.onChanged();
      return;
    }
    const idle = syncTicks().size === 0;
    const next = new Map(syncTicks());
    next.set(id, { done: evt.done ?? 0, total: evt.total ?? 0 });
    setSyncTicks(next);
    if (idle) syncGrace = setTimeout(() => setSyncShown(true), 800);
  };
  const clearSyncGrace = () => clearTimeout(syncGrace);

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
    onSyncEvent,
    clearSyncGrace,
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
 * The sidebar's bottom strip: the live connections, and a way into settings.
 *
 * Adding, disconnecting and forgetting an address are a list with actions, and
 * this corner is one line tall. The rows here are the situation — which
 * backends are up, and whether one of them is still syncing.
 */
export function ConnectionsFooter(props: {
  conns: ConnectionsCtl;
  compareReady: boolean;
  onCompareOpen: () => void;
}) {
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
                return (
                  <div
                    class="flex min-w-0 items-center gap-2 px-1.5 py-0 text-xs"
                    title={
                      tick()
                        ? tick()!.total > 0
                          ? t("sidebar.sync.progress", { done: tick()!.done, total: tick()!.total })
                          : t("sidebar.sync.scanning")
                        : conn.baseUrl
                    }
                  >
                    <span
                      class={`h-1.5 w-1.5 shrink-0 rounded-full bg-status-active ${
                        tick() ? "motion-safe:animate-pulse" : ""
                      }`}
                    />
                    <span class="truncate">
                      {backendLabel(conn.backend)}
                      <Show when={placementWord(conn.placement)}>
                        {(word) => <span class="text-2xs text-muted-foreground"> {word()}</span>}
                      </Show>
                      <span class="font-mono text-2xs text-muted-foreground"> · {endpointHost(conn.baseUrl)}</span>
                    </span>
                    <Show when={tick()}>
                      {(tk) => (
                        <span class="ml-auto font-mono text-2xs text-muted-foreground tabular-nums">
                          {tk().total > 0 ? `${tk().done}/${tk().total}` : t("sidebar.sync.busy")}
                        </span>
                      )}
                    </Show>
                  </div>
                );
              }}
            </For>
          </Show>
        </div>
        <Show when={props.compareReady}>
          <Tip label={t("sidebar.compare.openTip")}>
            <Button size="sm" onClick={() => props.onCompareOpen()}>
              {t("sidebar.compare.open")}
            </Button>
          </Tip>
        </Show>
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
            class="text-xs text-muted-foreground hover:text-foreground"
          >
            {t("settings.opencode.install")}
          </a>
        ) : undefined
      }
    />
  );
}
