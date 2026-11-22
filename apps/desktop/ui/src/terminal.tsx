import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import "@xterm/xterm/css/xterm.css";
import {
  closeTerminal,
  setTerminalMode,
  listTerminals,
  openTerminal,
  resizeTerminal,
  streamUrlFor,
  terminalSocket,
  type PtySession,
  type PtyShell,
} from "./api";
import {
  markShellWarned,
  readTerminalShell,
  readWarnedShell,
  resolveShell,
  shellChoices,
  shouldWarnFallback,
} from "./terminal-shell";
import { t } from "./i18n";
import { Icon } from "./icons";
import { Tip } from "@/tip";
import { fadeSignal } from "./errors";
import { createRequestOwner } from "./request-owner";

export function TerminalPane(props: { sessionId: string; onEmpty?: () => void; layout?: "dock" | "panel" }) {
  const [tabs, setTabs] = createSignal<PtySession[]>([]);
  const [active, setActive] = createSignal<string | undefined>();
  const [shells, setShells] = createSignal<PtyShell[]>([]);
  const [err, setErr] = fadeSignal("");
  const [notice, setNotice] = fadeSignal("");
  const [ready, setReady] = createSignal(false);
  let host: HTMLDivElement | undefined;
  let opening = false;
  const requests = createRequestOwner();
  const sockets = createRequestOwner();
  onCleanup(() => {
    requests.invalidate();
    sockets.invalidate();
  });

  const fail = (e: unknown) => setErr(e instanceof Error ? e.message : t("terminal.failed"));

  const load = async (sessionId: string) => {
    const token = requests.begin(sessionId);
    try {
      const listed = await listTerminals(sessionId);
      if (!requests.isCurrent(token)) return undefined;
      setTabs(listed.sessions);
      setShells(listed.shells ?? []);
      applyFallback(listed.shells ?? []);
      return listed.sessions;
    } catch (e) {
      if (requests.isCurrent(token)) fail(e);
      return undefined;
    }
  };

  /**
   * The lowest free number among our own tab names. Backend-assigned titles
   * (random suffixes) and externally created shells keep theirs — the number
   * only answers "which tab is this" for the ones the pane itself made.
   */
  const nextTitle = () => {
    let n = 1;
    const titles = new Set(tabs().map((row) => row.title));
    while (titles.has(t("terminal.tab", { n }))) n++;
    return t("terminal.tab", { n });
  };

  /**
   * The standing preference, checked against what this backend will actually
   * run. A preference that has quietly stopped applying is the one case worth a
   * word: say it once, then stay out of the way. The terminal still opens.
   */
  const applyFallback = (available: readonly PtyShell[]) => {
    const stored = readTerminalShell();
    if (!resolveShell(stored, available).fellBack) return;
    if (!shouldWarnFallback(stored, readWarnedShell())) return;
    markShellWarned(stored);
    setNotice(t("terminal.shellFallback", { name: stored }));
  };

  /** What a plain "+" press should use. */
  const defaultShell = () => resolveShell(readTerminalShell(), shells()).shell;

  const create = async (shell?: string) => {
    if (opening) return;
    const sessionId = props.sessionId;
    const token = requests.begin(sessionId);
    opening = true;
    setErr("");
    try {
      const created = await openTerminal(sessionId, { title: nextTitle(), shell });
      if (!requests.isCurrent(token)) return;
      setTabs((rows) => [...rows.filter((row) => row.id !== created.id), created]);
      setActive(created.id);
    } catch (e) {
      if (requests.isCurrent(token)) fail(e);
    } finally {
      if (requests.isCurrent(token)) opening = false;
    }
  };

  const close = async (id: string) => {
    const sessionId = props.sessionId;
    const token = requests.begin(sessionId);
    opening = false;
    setErr("");
    const next = tabs().filter((row) => row.id !== id);
    setTabs(next);
    if (active() === id) setActive(next[0]?.id);
    // Nothing left to show — an empty shell pane is chrome without content,
    // so the panel folds itself away rather than waiting for a new tab.
    if (next.length === 0) props.onEmpty?.();
    try {
      await closeTerminal(sessionId, id);
    } catch (e) {
      if (requests.isCurrent(token)) fail(e);
    }
  };

  const toggleMode = async (id: string, mode: PtySession["mode"]) => {
    const sessionId = props.sessionId;
    const token = requests.begin(sessionId);
    setErr("");
    const next = mode === "shared" ? "user" : "shared";
    try {
      const updated = await setTerminalMode(sessionId, id, next);
      if (!requests.isCurrent(token)) return;
      setTabs((rows) => rows.map((row) => row.id === id ? updated : row));
    } catch (e) {
      if (requests.isCurrent(token)) fail(e);
    }
  };

  createEffect(() => {
    const session = props.sessionId;
    requests.invalidate();
    sockets.invalidate();
    opening = false;
    setErr("");
    void load(session).then((rows) => {
      if (!rows || session !== props.sessionId) return;
      const current = rows.find((row) => row.id === active());
      if (current) return;
      if (rows[0]) setActive(rows[0].id);
      else void create(defaultShell());
    });
  });

  createEffect(() => {
    const session = props.sessionId;
    let source: EventSource | undefined;
    let closed = false;
    void streamUrlFor(`/plugins/terminal/events?session=${encodeURIComponent(session)}`).then((url) => {
      if (closed) return;
      source = new EventSource(url);
      source.onmessage = (event) => {
        if (opening) return;
        const data = JSON.parse(String(event.data)) as { type?: string };
        if (data.type !== "terminal.changed") return;
        void listTerminals(session).then((listed) => {
          if (closed || session !== props.sessionId) return;
          setTabs(listed.sessions);
          setShells(listed.shells ?? []);
          if (listed.sessions.some((row) => row.id === active())) return;
          setActive(listed.sessions[0]?.id);
        }).catch(() => {});
      };
    }).catch(() => {});
    onCleanup(() => {
      closed = true;
      source?.close();
    });
  });

  createEffect(() => {
    if (!ready()) return;
    const id = active();
    const el = host;
    if (!id || !el) return;
    const sessionId = props.sessionId;
    const token = sockets.begin(sessionId);
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: termFont(),
      fontSize: contentSize(),
      theme: termTheme(),
      scrollback: 2000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    // The socket's address carries the token the service expects, and a
    // WebSocket cannot carry a header — so the address is only known once the
    // shell has handed the token over.
    let ws: WebSocket | undefined;
    let wsClosed = false;
    let fitted = false;
    const socketCurrent = () => !wsClosed && sockets.isCurrent(token);
    const applySize = () => {
      if (!socketCurrent()) return;
      fit.fit();
      if (term.cols < 1 || term.rows < 1) return;
      void resizeTerminal(sessionId, id, term.rows, term.cols).catch(() => {});
    };
    void terminalSocket(sessionId, id).then((url) => {
      if (!socketCurrent()) return;
      const socket = new WebSocket(url);
      ws = socket;
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        if (!socketCurrent()) return;
        fitted = true;
        applySize();
      };
      socket.onmessage = (ev) => {
        if (!socketCurrent()) return;
        if (typeof ev.data === "string") term.write(ev.data);
        else term.write(new Uint8Array(ev.data as ArrayBuffer));
      };
      socket.onclose = () => {
        if (socketCurrent()) term.write(`\r\n${t("terminal.closed")}\r\n`);
      };
      term.onData((data) => {
        if (socketCurrent() && socket.readyState === WebSocket.OPEN) socket.send(data);
      });
    }).catch((e) => {
      if (socketCurrent()) fail(e);
    });
    const observer = new ResizeObserver(() => {
      if (fitted) applySize();
    });
    observer.observe(el);
    const onFonts = () => {
      term.options.fontFamily = termFont();
      term.options.fontSize = contentSize();
      if (fitted) applySize();
    };
    // The terminal palette is read from the document's tokens, and xterm keeps
    // its colours in the renderer rather than in CSS. A scheme or theme change
    // therefore has to hand it a new palette.
    const onAppearance = () => {
      term.options.theme = termTheme();
    };
    window.addEventListener("strata-fonts", onFonts);
    window.addEventListener("strata-appearance", onAppearance);
    onCleanup(() => {
      sockets.invalidate();
      window.removeEventListener("strata-fonts", onFonts);
      window.removeEventListener("strata-appearance", onAppearance);
      observer.disconnect();
      wsClosed = true;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      term.dispose();
    });
  });

  return (
    <div class={`flex min-h-0 flex-col border-border bg-background ${
      props.layout === "panel" ? "flex-1" : "h-64 shrink-0 border-t"
    }`}>
      <div class="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
        <For each={tabs()}>
          {(tab) => (
            <div
              class={`flex max-w-40 items-center rounded-md ${
                active() === tab.id ? "bg-secondary text-foreground" : "text-muted-foreground"
              }`}
            >
              <Tip label={t(tab.mode === "shared" ? "terminal.mode.sharedHint" : "terminal.mode.userHint")}>
                <Button
                  type="button"
                  variant="icon"
                  size="icon-2xs"
                  data-terminal-mode={tab.mode}
                  aria-label={t(tab.mode === "shared" ? "terminal.mode.sharedHint" : "terminal.mode.userHint")}
                  onClick={() => void toggleMode(tab.id, tab.mode)}
                >
                  <Icon name={tab.mode === "shared" ? "user-agent" : "user"} class="h-3.5 w-3.5" />
                </Button>
              </Tip>
              <Button
                type="button"
                variant="quiet"
                size="xs"
                class="min-w-0 flex-1 gap-0 px-1 text-xs"
                onClick={() => setActive(tab.id)}
              >
                <TerminalTitle text={tab.title} />
              </Button>
              <Tip label={t("terminal.close")}>
                <Button
                  type="button"
                  variant="icon"
                  size="icon-xs"
                  aria-label={t("terminal.close")}
                  onClick={() => void close(tab.id)}
                >
                  <Icon name="x" />
                </Button>
              </Tip>
            </div>
          )}
        </For>
        <DropdownMenu>
          <Tip label={t("terminal.new")}>
            <DropdownMenuTrigger
              variant="icon"
              size="icon-xs"
              aria-label={t("terminal.new")}
            >
              <Icon name="plus" />
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => void create(defaultShell())}>
              {defaultShell()
                ? t("terminal.shellDefault", { name: defaultShell()! })
                : t("terminal.shellBackend")}
            </DropdownMenuItem>
            <Show when={shellChoices(shells()).length > 0}>
              <DropdownMenuSeparator />
              <For each={shellChoices(shells())}>
                {(shell) => (
                  <DropdownMenuItem
                    class="font-mono text-xs"
                    onSelect={() => void create(shell.name)}
                  >
                    {shell.name}
                  </DropdownMenuItem>
                )}
              </For>
            </Show>
          </DropdownMenuContent>
        </DropdownMenu>
        <Show when={err()}>
          <p class="truncate px-2 text-2xs text-destructive">{err()}</p>
        </Show>
      </div>
      <Show when={notice()}>
        <div class="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
          <p class="min-w-0 flex-1 truncate text-2xs text-muted-foreground">{notice()}</p>
          <Tip label={t("terminal.shellDismiss")}>
            <Button
              type="button"
              variant="icon"
              size="icon-2xs"
              class="shrink-0"
              aria-label={t("terminal.shellDismiss")}
              onClick={() => setNotice("")}
            >
              <Icon name="x" />
            </Button>
          </Tip>
        </div>
      </Show>
      <div
        ref={(el) => {
          host = el;
          setReady(true);
        }}
        class="min-h-0 flex-1 px-1 py-1"
      />
    </div>
  );
}

function TerminalTitle(props: { text: string }) {
  let el: HTMLSpanElement | undefined;
  const [cut, setCut] = createSignal(false);
  onMount(() => {
    const measure = () => {
      if (el) setCut(el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (el) observer.observe(el);
    onCleanup(() => observer.disconnect());
  });
  return (
    <Tip label={props.text} disabled={!cut()} class="min-w-0 flex-1">
      <span ref={el} data-terminal-title={props.text} class="block w-full truncate text-left">
        {props.text}
      </span>
    </Tip>
  );
}

function termFont(): string {
  const css = getComputedStyle(document.documentElement);
  const terminal = css.getPropertyValue("--font-terminal").trim();
  const mono = css.getPropertyValue("--font-mono").trim();
  return terminal || mono || "ui-monospace, monospace";
}

function contentSize(): number {
  const raw = document.documentElement.dataset.contentSize;
  const n = raw ? Number(raw) : 13;
  return Number.isFinite(n) && n >= 12 && n <= 16 ? n : 13;
}

function termTheme(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const css = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: pick("--background", "#111"),
    foreground: pick("--foreground", "#ddd"),
    cursor: pick("--foreground", "#ddd"),
    selectionBackground: pick("--muted", "#333"),
  };
}
