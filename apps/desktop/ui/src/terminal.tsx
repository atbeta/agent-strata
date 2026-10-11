import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import "@xterm/xterm/css/xterm.css";
import {
  closeTerminal,
  listTerminals,
  openTerminal,
  resizeTerminal,
  terminalSocket,
  type PtySession,
} from "./api";
import { t } from "./i18n";

export function TerminalPane(props: { sessionId: string }) {
  const [tabs, setTabs] = createSignal<PtySession[]>([]);
  const [active, setActive] = createSignal<string | undefined>();
  const [err, setErr] = createSignal("");
  const [ready, setReady] = createSignal(false);
  let host: HTMLDivElement | undefined;
  let opening = false;

  const fail = (e: unknown) => setErr(e instanceof Error ? e.message : t("terminal.failed"));

  const load = async () => {
    const listed = await listTerminals(props.sessionId);
    setTabs(listed.sessions);
    return listed.sessions;
  };

  const create = async () => {
    if (opening) return;
    opening = true;
    setErr("");
    try {
      const created = await openTerminal(props.sessionId);
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
    setTabs((rows) => {
      const next = rows.filter((row) => row.id !== id);
      if (active() === id) setActive(next[0]?.id);
      return next;
    });
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
        else void create();
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
      fontFamily: codeFont(),
      fontSize: codeSize(),
      theme: termTheme(),
      scrollback: 2000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    const ws = new WebSocket(terminalSocket(props.sessionId, id));
    ws.binaryType = "arraybuffer";
    let fitted = false;
    const applySize = () => {
      fit.fit();
      if (term.cols < 1 || term.rows < 1) return;
      void resizeTerminal(props.sessionId, id, term.rows, term.cols).catch(() => {});
    };
    ws.onopen = () => {
      fitted = true;
      applySize();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") term.write(ev.data);
      else term.write(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onclose = () => term.write(`\r\n${t("terminal.closed")}\r\n`);
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });
    const observer = new ResizeObserver(() => {
      if (fitted) applySize();
    });
    observer.observe(el);
    onCleanup(() => {
      observer.disconnect();
      ws.onclose = null;
      ws.close();
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
              <button
                type="button"
                class="truncate px-2 py-1 text-xs"
                onClick={() => setActive(tab.id)}
              >
                {tab.title}
              </button>
              <button
                type="button"
                class="grid h-6 w-6 place-items-center text-muted-foreground hover:text-foreground"
                aria-label={t("terminal.close")}
                onClick={() => void close(tab.id)}
              >
                ×
              </button>
            </div>
          )}
        </For>
        <button
          type="button"
          class="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label={t("terminal.new")}
          onClick={() => void create()}
        >
          +
        </button>
        <Show when={err()}>
          <p class="truncate px-2 text-2xs text-destructive">{err()}</p>
        </Show>
      </div>
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

function codeFont(): string {
  const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  return mono || "ui-monospace, monospace";
}

function codeSize(): number {
  const raw = document.documentElement.dataset.codeSize;
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
