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
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import "@xterm/xterm/css/xterm.css";
import {
  closeTerminal,
  listTerminals,
  openTerminal,
  resizeTerminal,
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

export function TerminalPane(props: { sessionId: string; onEmpty?: () => void }) {
  const [tabs, setTabs] = createSignal<PtySession[]>([]);
  const [active, setActive] = createSignal<string | undefined>();
  const [shells, setShells] = createSignal<PtyShell[]>([]);
  const [err, setErr] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [ready, setReady] = createSignal(false);
  let host: HTMLDivElement | undefined;
  let opening = false;

  const fail = (e: unknown) => setErr(e instanceof Error ? e.message : t("terminal.failed"));

  const load = async () => {
    const listed = await listTerminals(props.sessionId);
    setTabs(listed.sessions);
    setShells(listed.shells ?? []);
    applyFallback(listed.shells ?? []);
    return listed.sessions;
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
    opening = true;
    setErr("");
    try {
      const created = await openTerminal(props.sessionId, { title: nextTitle(), shell });
      setTabs((rows) => [...rows.filter((row) => row.id !== created.id), created]);
      setActive(created.id);
    } catch (e) {
      fail(e);
    } finally {
      opening = false;
    }
  };

  const close = async (id: string) => {
    setErr("");
    const next = tabs().filter((row) => row.id !== id);
    setTabs(next);
    if (active() === id) setActive(next[0]?.id);
    // Nothing left to show — an empty shell pane is chrome without content,
    // so the panel folds itself away rather than waiting for a new tab.
    if (next.length === 0) props.onEmpty?.();
    try {
      await closeTerminal(props.sessionId, id);
    } catch (e) {
      fail(e);
    }
  };

  createEffect(() => {
    const session = props.sessionId;
    setErr("");
    void load()
      .then((rows) => {
        if (session !== props.sessionId) return;
        const current = rows.find((row) => row.id === active());
        if (current) return;
        if (rows[0]) setActive(rows[0].id);
        else void create(defaultShell());
      })
      .catch(fail);
  });

  createEffect(() => {
    if (!ready()) return;
    const id = active();
    const el = host;
    if (!id || !el) return;
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
    const applySize = () => {
      fit.fit();
      if (term.cols < 1 || term.rows < 1) return;
      void resizeTerminal(props.sessionId, id, term.rows, term.cols).catch(() => {});
    };
    void terminalSocket(props.sessionId, id).then((url) => {
      if (wsClosed) return;
      const socket = new WebSocket(url);
      ws = socket;
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        fitted = true;
        applySize();
      };
      socket.onmessage = (ev) => {
        if (typeof ev.data === "string") term.write(ev.data);
        else term.write(new Uint8Array(ev.data as ArrayBuffer));
      };
      socket.onclose = () => term.write(`\r\n${t("terminal.closed")}\r\n`);
      term.onData((data) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(data);
      });
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
    window.addEventListener("strata-fonts", onFonts);
    onCleanup(() => {
      window.removeEventListener("strata-fonts", onFonts);
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
    <div class="flex h-64 shrink-0 flex-col border-t border-border bg-background">
      <div class="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
        <For each={tabs()}>
          {(tab) => (
            <div
              class={`flex max-w-40 items-center rounded-md ${
                active() === tab.id ? "bg-secondary text-foreground" : "text-muted-foreground"
              }`}
            >
              <Button
                type="button"
                variant="quiet"
                size="xs"
                class="truncate text-xs"
                onClick={() => setActive(tab.id)}
              >
                {tab.title}
              </Button>
              {/* Same bar, same 24px box, same hover — the close and the new-tab
                  button used to disagree on whether hovering drew a fill. */}
              <Button
                type="button"
                variant="icon"
                size="icon-xs"
                aria-label={t("terminal.close")}
                onClick={() => void close(tab.id)}
              >
                ×
              </Button>
            </div>
          )}
        </For>
        {/* Same bar, same 24px box, same hover as the close button above — a
            bare "+" that opened a menu now has to look like the × it sits next
            to, not like a button that happens to be elsewhere. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            class="size-6 text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label={t("terminal.new")}
          >
            +
          </DropdownMenuTrigger>
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
          <Button
            type="button"
            variant="quiet"
            size="xs"
            class="shrink-0 text-2xs"
            onClick={() => setNotice("")}
          >
            {t("terminal.shellDismiss")}
          </Button>
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
