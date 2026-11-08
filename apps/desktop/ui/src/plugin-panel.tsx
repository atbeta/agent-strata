import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiFetch, streamUrlFor } from "./api";
import { Button } from "@/components/ui/button";
import { TextFieldInput } from "@/components/ui/text-field";
import { panelContributions, type PanelContribution } from "./plugin-registry";
import { pluginDisplayName } from "./plugin-display";
import { t } from "./i18n";

/**
 * Panels a plugin contributes, as tabs beside the builtin ones.
 *
 * The kinds are deliberately few and each one is a component here. A plugin
 * cannot ship a component — that would be arbitrary code in this window — it
 * picks a shape from this table and fills it with data over its own routes.
 *
 * `screencast` is the interesting one and the reason the browser plugin is the
 * first real tenant: frames arrive on the plugin's event stream, and pointer,
 * wheel and key input go back through the plugin's private route. The panel
 * never learns what a page is.
 */
export function pluginPanelTab(panel: PanelContribution): string {
  return `plugin:${panel.plugin}`;
}

/** The tab ids a session's rail should offer, given what is running. */
export function pluginPanelTabs(): { id: string; label: string; panel: PanelContribution }[] {
  return panelContributions().map((panel) => ({
    id: pluginPanelTab(panel),
    label: pluginDisplayName(panel.plugin, panel.title),
    panel,
  }));
}

/** The panel a tab id names, when it names one. */
export function panelForTab(tab: string): PanelContribution | undefined {
  if (!tab.startsWith("plugin:")) return undefined;
  const plugin = tab.slice("plugin:".length);
  return panelContributions().find((p) => p.plugin === plugin);
}

/** Whether a tab id is a plugin panel this build can draw. */
export function isPluginPanelTab(tab: string): boolean {
  const panel = panelForTab(tab);
  if (!panel) return false;
  // `component` is a compile-time registration and none exist in this build;
  // `iframe` is third-party-only. A tab that pointed at either would be blank,
  // so it is not offered at all.
  return panel.kind === "screencast" || panel.kind === "logs" || panel.kind === "status";
}

/**
 * A plugin's panel, whichever kind it is.
 *
 * One component rather than three tabs' worth of routing: the kinds differ in
 * how they get data, not in where they sit, and the rail should not have to
 * know which plugin declared which.
 */
export function PluginPanel(props: { panel: PanelContribution; sessionId: () => string }) {
  return (
    <Show when={props.panel.kind === "screencast"} fallback={<DataPanel panel={props.panel} sessionId={props.sessionId} />}>
      <ScreencastPanel panel={props.panel} sessionId={props.sessionId} />
    </Show>
  );
}

interface Frame {
  tab: string;
  url: string;
  mime: string;
  data: string;
}

/**
 * Frames from a plugin, drawn as they arrive.
 *
 * An EventSource, because that is the shape the host serves and because a
 * panel that reconnects on its own is worth more than a hand-rolled socket.
 * The URL carries the token in the query: an EventSource cannot set a header,
 * which is why the service whitelists exactly this route.
 */
function ScreencastPanel(props: { panel: PanelContribution; sessionId: () => string }) {
  const [frame, setFrame] = createSignal<Frame>();
  const [state, setState] = createSignal<"connecting" | "live" | "idle" | "error">("connecting");
  const [error, setError] = createSignal<string>();
  let canvas: HTMLCanvasElement | undefined;
  let socket: EventSource | undefined;
  /** The surface the frame is drawn into; its size is the page's size. */
  let surface: HTMLElement | undefined;
  let observer: ResizeObserver | undefined;
  /** The element the frame is drawn in; input is measured against it. */
  let frameBox: HTMLElement | undefined;
  /** The focus target for keys and IME: a real field, kept invisible. */
  let field: HTMLTextAreaElement | undefined;
  let pointerDown = false;
  let composing = false;
  let lastMove = 0;
  /** The last cursor probe, so a hover costs one round trip every ~120ms. */
  let lastProbe = 0;
  let hoverCursor = "";
  /** The size last sent to the service, so a re-layout does not re-send it. */
  let sent: { width: number; height: number; scale: number } | undefined;

  const post = (path: string, body: unknown) =>
    apiFetch(`/plugins/${encodeURIComponent(props.panel.plugin)}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  /**
   * The panel's own size in CSS pixels.
   *
   * That, not a fixed desktop size, is what the page should be laid out at:
   * the rail is narrow, and a page sized for 1280 then scaled down turns into
   * the unreadable thumbnail this panel exists to replace.
   */
  const panelSize = () => {
    const rect = surface?.getBoundingClientRect();
    if (!rect || rect.width < 1 || rect.height < 1) return undefined;
    // What is actually on screen, not what the box claims. A rail that
    // overflows the window by even thirty pixels puts the page's fixed footer
    // — a dev toolbar, a cookie bar — behind the window edge, where it cannot
    // be seen or clicked.
    const visibleHeight = Math.floor(Math.min(rect.height, window.innerHeight - rect.top));
    const visibleWidth = Math.floor(Math.min(rect.width, window.innerWidth - rect.left));
    if (visibleHeight < 1 || visibleWidth < 1) return undefined;
    // `devicePixelRatio` is what makes the frame sharp on a retina display:
    // the page lays out at the panel's CSS size and is captured at the
    // display's own resolution, so one bitmap pixel is one screen pixel.
    return {
      width: visibleWidth,
      height: visibleHeight,
      scale: Math.min(Math.max(window.devicePixelRatio || 1, 1), 2),
    };
  };

  const start = async () => {
    setState("connecting");
    setError(undefined);
    const size = panelSize();
    sent = size;
    // No size yet is a real case: the panel has not been laid out, and the
    // service picks a default. Spreading undefined adds nothing, so the
    // fields are only added when there is something to say.
    const res = await post("/panel/cast", {
      session: props.sessionId(),
      // Chrome pushes a frame per paint; the service acks all of them and
      // forwards at this rate. 20 is where typing stops feeling like a
      // slideshow, and the service drops (and acks) the rest.
      fps: 20,
      ...(size ? { width: size.width, height: size.height, scale: size.scale } : {}),
    }).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
      return undefined;
    });
    if (!res) return;
    if (!res.ok) {
      // No tab yet is not an error: the panel says so and waits for the agent
      // to navigate. Anything else is worth showing.
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? t("panel.plugin.noPage"));
      setState("idle");
      return;
    }
    setState("live");
  };

  onMount(() => {
    // The rail is resizable and the window is too; a page laid out for the
    // old width would reflow late. Re-announcing the size restarts the cast at
    // the new one, which is cheaper than carrying a second "resize" verb.
    let debounce: ReturnType<typeof setTimeout> | undefined;
    observer = new ResizeObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const size = panelSize();
        if (!size) return;
        if (
          sent &&
          sent.scale === size.scale &&
          Math.abs(sent.width - size.width) < 8 &&
          Math.abs(sent.height - size.height) < 8
        ) {
          return;
        }
        void start();
      }, 250);
    });
    if (surface) observer.observe(surface);
    const open = async () => {
      const url = await streamUrlFor(
        `/plugins/${encodeURIComponent(props.panel.plugin)}/events?session=${encodeURIComponent(props.sessionId())}`,
      );
      socket = new EventSource(url);
      socket.onmessage = (event) => {
        let payload: { type?: string; data?: unknown } | undefined;
        try {
          payload = JSON.parse((event as MessageEvent<string>).data) as typeof payload;
        } catch {
          return;
        }
        if (payload?.type !== "frame") return;
        setFrame(payload.data as Frame);
        setState("live");
      };
      socket.onerror = () => {
        // EventSource reconnects by itself; the frame stays on screen.
        if (state() === "live") setState("connecting");
      };
    };
    // A hidden window still receives frames and still decodes them. Stopping
    // the stream is cheaper than painting into a canvas nobody can see, and it
    // is what keeps a backgrounded session from holding the rail busy.
    const onVisibility = () => {
      if (document.visibilityState === "visible") void start();
      else void post("/panel/stop", { session: props.sessionId() }).catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisibility);
    void open();
    void start();
    onCleanup(() => {
      document.removeEventListener("visibilitychange", onVisibility);
      socket?.close();
      socket = undefined;
      observer?.disconnect();
      observer = undefined;
      clearTimeout(debounce);
      void post("/panel/stop", { session: props.sessionId() }).catch(() => {});
    });
  });

  /**
   * Draw one frame into a canvas whose size does not depend on the frame.
   *
   * The stream and the settled still arrive at different pixel sizes — the
   * stream at the page's CSS size, the still at the display's ratio. Sizing
   * the canvas to the picture meant it was resized on every frame that came
   * from the other source: a 1400x1800 backing store allocated twenty times a
   * second, which is what made the rail flash and then stop answering. The
   * canvas is now fixed to the panel's own pixels and each frame is drawn into
   * it, so the two sources differ in sharpness and not in geometry.
   */
  const paint = (image: HTMLImageElement) => {
    const c = canvas;
    const size = panelSize();
    if (!c || !size) return;
    const w = Math.round(size.width * size.scale);
    const h = Math.round(size.height * size.scale);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    // Contained, not stretched: a frame from before a resize has a different
    // aspect, and one bad frame should letterbox rather than squash the page.
    const scale = Math.min(w / image.naturalWidth, h / image.naturalHeight);
    const dw = image.naturalWidth * scale;
    const dh = image.naturalHeight * scale;
    ctx.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
  };

  /**
   * One input event, as fractions of the frame.
   *
   * Fractions rather than pixels because the rail is resizable and the page is
   * laid out at whatever size it last reported; the service turns them back
   * into page coordinates with the viewport it is driving.
   */
  const input = (kind: string, extra: Record<string, unknown> = {}) => {
    const rect = frameBox?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    const x = typeof extra.x === "number" ? extra.x : 0.5;
    const y = typeof extra.y === "number" ? extra.y : 0.5;
    void post("/panel/input", {
      session: props.sessionId(),
      kind,
      x: Math.min(Math.max(x, 0), 1),
      y: Math.min(Math.max(y, 0), 1),
      ...extra,
    }).catch(() => {});
  };

  const atPoint = (event: MouseEvent | PointerEvent) => {
    const rect = frameBox?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return undefined;
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  };

  const buttonOf = (event: PointerEvent): "left" | "right" | "middle" =>
    event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";

  const modifiersOf = (event: KeyboardEvent | MouseEvent) =>
    (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-2xs text-muted-foreground">
        <span
          class="h-1.5 w-1.5 shrink-0 rounded-full"
          classList={{
            "bg-emerald-500": state() === "live",
            "bg-amber-500": state() === "connecting",
            "bg-muted-foreground/40": state() === "idle",
          }}
        />
        {/*
          Where the page is, not a place to go. Navigation belongs to the
          agent: it is the thing deciding what to open and why, and a reader
          who typed a URL here would be driving a page the agent is not
          looking at. Clicks and keys still reach the page — signing in or
          answering a dialog is the reader's, not a second driver.
        */}
        {/*
          The address bar is a read-out, not an input: navigation belongs to
          the agent, which is the thing deciding what to open. It still looks
          like what it is — the page's address — because a bare sentence
          floating in the header reads as a caption to nothing.
        */}
        <TextFieldInput
          bare
          mono
          readonly
          size="sm"
          type="url"
          class="pointer-events-none min-w-0 flex-1 select-all truncate px-1 py-0.5 text-2xs text-muted-foreground"
          value={frame()?.url ?? error() ?? t("panel.plugin.waiting")}
          tabindex={-1}
          aria-label={t("panel.plugin.address")}
          title={frame()?.url ?? undefined}
        />
        <Button type="button" variant="quiet" size="sm" class="shrink-0" onClick={() => void start()}>
          {t("panel.plugin.refresh")}
        </Button>
      </div>
      <div
        ref={(el) => {
          surface = el;
          // Observe once the element exists; `onMount` runs before the rail
          // has laid the panel out, so the size is only known from here.
          if (observer && el) {
            observer.disconnect();
            observer.observe(el);
          }
        }}
        class="min-h-0 flex-1 overflow-hidden bg-muted/30"
      >
        <Show
          when={frame()}
          fallback={
            <p class="px-1 py-3 text-xs text-muted-foreground">
              {error() ?? t("panel.plugin.noPage")}
            </p>
          }
        >
          {(f) => (
            <div
              // Fills the surface: the page was laid out at this size, so the
              // frame is 1:1 rather than a picture scaled to fit a box.
              ref={(el) => {
                frameBox = el;
              }}
              class="relative h-full w-full overflow-hidden bg-background outline-none"
              tabindex={0}
              onPointerDown={(e) => {
                e.preventDefault();
                frameBox?.focus?.();
                field?.focus({ preventScroll: true });
                pointerDown = true;
                const at = atPoint(e);
                if (!at) return;
                (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                input("down", { ...at, button: buttonOf(e), modifiers: modifiersOf(e) });
              }}
              onPointerMove={(e) => {
                if (!pointerDown) {
                  // A canvas cannot change cursor per element, so ask the page
                  // what it would show here. Throttled: a hover is not worth a
                  // round trip per pixel, and the answer changes rarely.
                  const now = Date.now();
                  if (now - lastProbe > 120) {
                    lastProbe = now;
                    const at = atPoint(e);
                    if (at) {
                      void post("/panel/input", { session: props.sessionId(), kind: "cursor", ...at })
                        .then(async (res) => {
                          if (!res.ok) return;
                          const body = (await res.json().catch(() => ({}))) as { cursor?: string | null };
                          const next = body.cursor ?? "";
                          if (next === hoverCursor) return;
                          hoverCursor = next;
                          if (frameBox) frameBox.style.cursor = next || "default";
                        })
                        .catch(() => {});
                    }
                  }
                  return;
                }
                // A drag is a move the page sees with a button held; without
                // the flag every drag reads as a hover.
                const now = Date.now();
                if (now - lastMove < 16) return;
                lastMove = now;
                const at = atPoint(e);
                if (at) input("move", { ...at, dragging: true, modifiers: modifiersOf(e) });
              }}
              onPointerUp={(e) => {
                if (!pointerDown) return;
                pointerDown = false;
                (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
                const at = atPoint(e);
                if (at) input("up", { ...at, button: buttonOf(e), modifiers: modifiersOf(e) });
              }}
              onPointerCancel={() => {
                pointerDown = false;
              }}
              onWheel={(e) => {
                e.preventDefault();
                const at = atPoint(e);
                if (at) input("wheel", { ...at, delta: e.deltaY });
              }}
              onKeyDown={(e) => {
                if (composing) return;
                // A printable key goes through the field below, so it arrives
                // as inserted text and an IME can compose it. Everything else
                // — Enter, Tab, arrows, shortcuts — is a key event the page
                // has to see as itself.
                const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
                if (printable) return;
                e.preventDefault();
                input("key", { key: e.key, modifiers: modifiersOf(e) });
              }}
              onContextMenu={(e) => {
                // The page's own menu cannot be drawn here; the click is still
                // the page's to handle.
                e.preventDefault();
              }}
            >
              <canvas
                ref={(el) => {
                  canvas = el;
                }}
                class="block h-full w-full select-none"
                style={{ "object-fit": "contain" }}
                data-frame
              />
              {/*
                The focus target, invisible on purpose: a canvas cannot receive
                text or IME composition, and a real textarea can. It sits over
                the frame so clicking focuses it, and every insertion is
                forwarded whole — a composed Chinese word arrives as one string,
                not as the keystrokes that made it.
              */}
              <textarea
                ref={(el) => {
                  field = el;
                }}
                aria-label={t("panel.plugin.input")}
                autocomplete="off"
                autocapitalize="off"
                spellcheck={false}
                class="absolute inset-0 h-full w-full cursor-default resize-none bg-transparent text-transparent caret-transparent outline-none"
                onInput={(e) => {
                  if (composing) return;
                  const value = e.currentTarget.value;
                  if (!value) return;
                  input("text", { text: value });
                  e.currentTarget.value = "";
                }}
                onCompositionStart={() => {
                  composing = true;
                }}
                onCompositionEnd={(e) => {
                  composing = false;
                  const value = e.data;
                  if (value) input("text", { text: value });
                  if (field) field.value = "";
                }}
                onPaste={(e) => {
                  e.preventDefault();
                  const value = e.clipboardData?.getData("text") ?? "";
                  if (value) input("text", { text: value });
                }}
              />
              <img
                src={`data:${f().mime};base64,${f().data}`}
                alt=""
                class="hidden"
                onLoad={(e) => paint(e.currentTarget)}
              />
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}

/**
 * `logs` and `status`: a plugin's resource, read on a timer.
 *
 * Polling rather than a stream because both are small and slow-moving; a
 * stream here would be a socket held open to re-read a page of JSON once a
 * second.
 */
function DataPanel(props: { panel: PanelContribution; sessionId: () => string }) {
  const [text, setText] = createSignal("");
  const [error, setError] = createSignal<string>();
  const refresh = () => {
    const resource = props.panel.kind === "logs" ? "console" : "tabs";
    void fetchResource(props.panel.plugin, resource, props.sessionId())
      .then((body) => {
        setText(body);
        setError(undefined);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  onMount(() => {
    refresh();
    const timer = setInterval(refresh, 4_000);
    onCleanup(() => clearInterval(timer));
  });
  return (
    <div class="min-h-0 flex-1 overflow-auto p-3">
      <Show when={!error()} fallback={<p class="text-xs text-destructive">{error()}</p>}>
        <pre class="whitespace-pre-wrap break-words font-mono text-2xs text-muted-foreground">{text()}</pre>
      </Show>
    </div>
  );
}

async function fetchResource(plugin: string, key: string, sessionId: string): Promise<string> {
  const res = await apiFetch(
    `/plugins/${encodeURIComponent(plugin)}/resources/${encodeURIComponent(key)}?session=${encodeURIComponent(sessionId)}`,
  );
  if (!res.ok) throw new Error(t("api.err.service", { status: res.status }));
  return res.text();
}

