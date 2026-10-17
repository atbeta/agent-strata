import { createResource, createSignal, For, Show } from "solid-js";
import {
  backendLabel,
  connectBackend,
  disconnectBackend,
  getJson,
  readOpencodeLaunch,
  type Connection,
} from "./api";
import { settled } from "./resource";
import { explain } from "./errors";
import { t } from "./i18n";
import { Icon } from "./icons";
import { Tip } from "./tip";
import { Button } from "@/components/ui/button";
import { RowButton } from "@/components/ui/row-button";
import { TextFieldInput } from "@/components/ui/text-field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
  const [conns, { refetch: refetchConns }] = createResource(() =>
    getJson<{ connections: Connection[] }>("/connections"),
  );
  const [opencodeLaunch] = createResource(readOpencodeLaunch);
  const backendMissing = () => settled(opencodeLaunch)?.state === "missing";

  const connected = () => (settled(conns)?.connections.length ?? 0) > 0;

  /**
   * States in which a backend is on its way rather than one waiting on a person.
   *
   * `external` counts: the service attaches to a pre-set `STRATA_OPENCODE_URL`
   * and retries until it answers, which is the same wait as a spawn, just one
   * this shell did not start. `unmanaged` does not, because nothing is coming
   * — that is the one state where the prompt to connect is the whole truth.
   */
  const LAUNCHING = new Set(["starting", "restarting", "running", "external"]);
  const launching = () => LAUNCHING.has(settled(opencodeLaunch)?.state ?? "");

  /**
   * `connected()` is false for the whole stretch between the window opening
   * and the stream attaching: the shell spawns `opencode serve`, the service
   * retries until it answers, and until it does `/connections` is empty. Read
   * as a boolean that stretch looks identical to a person who has not attached
   * anything, and the page asked them to fix something already in progress.
   */
  const attaching = () => !connected() && launching();

  const [connOpen, setConnOpenRaw] = createSignal(false);
  const [connErr, setConnErrRaw] = createSignal("");
  let connErrTimer: ReturnType<typeof setTimeout> | undefined;
  const setConnErr = (msg: string) => {
    clearTimeout(connErrTimer);
    setConnErrRaw(msg);
    // The line sits outside the connect panel, so nothing else ever
    // dismissed it — a dead attempt kept reading as the live state. It
    // gets a shelf life while the panel is closed; inside the panel it is
    // the answer to the form the reader just tried.
    connErrTimer = msg
      ? setTimeout(() => {
          if (!connOpen()) setConnErrRaw("");
        }, 12_000)
      : undefined;
  };
  const setConnOpen = (open: boolean | ((v: boolean) => boolean)) => {
    const next = typeof open === "function" ? open(connOpen()) : open;
    setConnOpenRaw(next);
    if (!next) setConnErr("");
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
      setConnOpen(false);
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
    opencodeLaunch,
    backendMissing,
    connected,
    attaching,
    connOpen,
    setConnOpen,
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
    chooseNewConn,
    newSessionConnection,
    syncTicks,
    syncShown,
    onSyncEvent,
    clearSyncGrace,
  };
}

export type ConnectionsCtl = ReturnType<typeof useConnections>;

/**
 * The sidebar's bottom strip: the connect form when open, then one row per
 * live connection — the row owns its sync progress — plus the compare-open
 * button and the misc menu.
 */
export function ConnectionsFooter(props: {
  conns: ConnectionsCtl;
  compareReady: boolean;
  onCompareOpen: () => void;
}) {
  const c = () => props.conns;
  return (
    <div class="border-t border-border px-2">
      <Show when={c().connOpen()}>
        <div class="my-1.5 space-y-1.5 px-1">
          <div class="flex gap-1">
            <Button
              size="sm"
              variant={c().connKind() === "opencode" ? "secondary" : "ghost"}
              class="h-7 flex-1 text-2xs"
              onClick={() => c().setConnKind("opencode")}
            >
              {t("connect.kind.opencode")}
            </Button>
            <Button
              size="sm"
              variant={c().connKind() === "acp" ? "secondary" : "ghost"}
              class="h-7 flex-1 text-2xs"
              onClick={() => c().setConnKind("acp")}
            >
              {t("connect.kind.acp")}
            </Button>
          </div>
          <Show
            when={c().connKind() === "acp"}
            fallback={
              <>
                <TextFieldInput
                  size="sm"
                  mono
                  value={c().connUrl()}
                  onChange={c().setConnUrl}
                  class="bg-background text-2xs"
                  placeholder="http://127.0.0.1:4096"
                />
                <div class="flex gap-1.5">
                  <TextFieldInput
                    size="sm"
                    value={c().connName()}
                    onChange={c().setConnName}
                    class="w-1/3 bg-background px-2 text-2xs"
                    placeholder={t("connect.form.name")}
                  />
                  <TextFieldInput
                    size="sm"
                    value={c().connUser()}
                    onChange={c().setConnUser}
                    class="w-1/3 bg-background px-2 text-2xs"
                    placeholder={t("connect.form.user")}
                  />
                  <TextFieldInput
                    size="sm"
                    type="password"
                    value={c().connPass()}
                    onChange={c().setConnPass}
                    class="w-1/3 bg-background px-2 text-2xs"
                    placeholder={t("connect.form.password")}
                  />
                </div>
              </>
            }
          >
            <TextFieldInput
              size="sm"
              mono
              value={c().connCmd()}
              onChange={c().setConnCmd}
              class="bg-background text-2xs"
              placeholder={t("connect.form.command")}
            />
            <TextFieldInput
              size="sm"
              value={c().connName()}
              onChange={c().setConnName}
              class="bg-background px-2 text-2xs"
              placeholder={t("connect.form.name")}
            />
          </Show>
          <Button
            class="h-8 w-full"
            disabled={c().connecting() || !(c().connKind() === "acp" ? c().connCmd().trim() : c().connUrl().trim())}
            onClick={() => void c().connect()}
          >
            {c().connecting() ? t("action.connecting") : t("action.connect")}
          </Button>
        </div>
      </Show>
      <Show when={c().connErr()}>
        <p class="my-1 px-1.5 font-mono text-2xs text-destructive">{c().connErr()}</p>
      </Show>
      {/* min-h-7 so the strip lands on the same line as the session view's
          status footer — two bottoms at different heights read as a seam
          misaligned by accident. */}
      <div class="flex min-h-7 items-center gap-1">
        <div class="min-w-0 flex-1">
          <Show
            when={c().connected()}
            fallback={
              <div class="min-w-0 px-1.5 py-1">
                <p class="truncate text-xs text-muted-foreground">
                  {c().attaching()
                    ? t("sidebar.backend.connecting")
                    : c().backendMissing()
                      ? t("sidebar.backend.missing")
                      : t("sidebar.backend.none")}
                </p>
                <Show when={c().backendMissing()}>
                  <a
                    href="https://opencode.ai"
                    target="_blank"
                    rel="noreferrer"
                    class="mt-0.5 block text-2xs text-muted-foreground hover:text-foreground"
                  >
                    {t("settings.opencode.install")}
                  </a>
                </Show>
              </div>
            }
          >
            <For each={settled(c().conns)?.connections ?? []}>
              {(conn) => {
                const tick = () => (c().syncShown() ? c().syncTicks().get(conn.id) : undefined);
                return (
                  <RowButton
                    class="gap-2 px-1.5 py-0 text-xs hover:bg-secondary"
                    title={
                      tick()
                        ? tick()!.total > 0
                          ? t("sidebar.sync.progress", {
                              done: tick()!.done,
                              total: tick()!.total,
                            })
                          : t("sidebar.sync.scanning")
                        : conn.baseUrl
                    }
                    onClick={() => c().chooseNewConn(conn.id)}
                  >
                    <span
                      class={`h-1.5 w-1.5 shrink-0 rounded-full bg-status-active ${
                        tick() ? "motion-safe:animate-pulse" : ""
                      }`}
                    />
                    <span class="truncate">
                      {backendLabel(conn.backend)}
                      <span class="font-mono text-2xs text-muted-foreground">
                        {" "}
                        · {endpointHost(conn.baseUrl)}
                      </span>
                    </span>
                    <span class="ml-auto flex shrink-0 items-center gap-1.5">
                      <Show when={tick()}>
                        {(tk) => (
                          <span
                            role="status"
                            aria-live="polite"
                            class="font-mono text-2xs text-muted-foreground tabular-nums"
                          >
                            {tk().total > 0 ? `${tk().done}/${tk().total}` : t("sidebar.sync.busy")}
                          </span>
                        )}
                      </Show>
                      <Show when={(settled(c().conns)?.connections.length ?? 0) > 1 && c().newSessionConnection() === conn.id}>
                        <span class="text-2xs text-muted-foreground">
                          {t("sidebar.backend.newTarget")}
                        </span>
                      </Show>
                    </span>
                  </RowButton>
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
        <DropdownMenu placement="top-end">
          <DropdownMenuTrigger
            class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label={t("sidebar.menu.more")}
          >
            ···
          </DropdownMenuTrigger>
          <DropdownMenuContent class="min-w-52">
            <DropdownMenuItem onSelect={() => (location.hash = "/settings")}>
              <Icon name="gear" class="size-3.5 text-muted-foreground" />
              {t("settings.title")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/* One row to open the panel, one row per live connection to
                close it. A "disconnect all" beside a list of per-host
                disconnects was two ways to do one thing, and the pair had
                to be read together to know which one the menu meant. */}
            <DropdownMenuItem onSelect={() => c().setConnOpen((v) => !v)}>
              <Icon name="link" class="size-3.5 text-muted-foreground" />
              {c().connOpen() ? t("action.closeConnect") : t("action.connectBackend")}
            </DropdownMenuItem>
            <For each={settled(c().conns)?.connections ?? []}>
              {(conn) => (
                <DropdownMenuItem onSelect={() => c().disconnect(conn.id)}>
                  <Icon name="plug" class="size-3.5 text-muted-foreground" />
                  {t("sidebar.menu.disconnect", { host: endpointHost(conn.baseUrl) })}
                </DropdownMenuItem>
              )}
            </For>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
