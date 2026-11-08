import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiFetch, streamUrlFor } from "./api";
import { Button } from "@/components/ui/button";
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
    // `devicePixelRatio` is what makes the frame sharp on a retina display:
    // the page lays out at the panel's CSS size and is captured at the
    // display's own resolution, so one bitmap pixel is one screen pixel.
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
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
      // forwards at this rate. 12 is where scrolling stops looking like a
      // slideshow without turning the rail into a video stream.
      fps: 12,
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
    void open();
    void start();
    onCleanup(() => {
      socket?.close();
      socket = undefined;
      observer?.disconnect();
      observer = undefined;
      clearTimeout(debounce);
      void post("/panel/stop", { session: props.sessionId() }).catch(() => {});
    });
  });

  // The canvas is sized to the picture, not the pane: scaled by CSS so a
  // click's fractions are of the page, and the page's aspect ratio survives.
  const paint = (image: HTMLImageElement) => {
    const c = canvas;
    if (!c) return;
    c.width = image.naturalWidth;
    c.height = image.naturalHeight;
    const ctx = c.getContext("2d");
    ctx?.drawImage(image, 0, 0);
  };

  const input = (kind: string, event: MouseEvent | WheelEvent, extra: Record<string, unknown> = {}) => {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    void post("/panel/input", {
      session: props.sessionId(),
      kind,
      x: Math.min(Math.max(x, 0), 1),
      y: Math.min(Math.max(y, 0), 1),
      ...extra,
    }).catch(() => {});
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-2xs text-muted-foreground">
        <span class="h-1.5 w-1.5 rounded-full" classList={{ "bg-emerald-500": state() === "live", "bg-amber-500": state() === "connecting", "bg-muted-foreground/40": state() === "idle" }} />
        <span class="min-w-0 flex-1 truncate">{frame()?.url ?? error() ?? t("panel.plugin.waiting")}</span>
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
              class="relative h-full w-full overflow-hidden bg-background"
              onPointerDown={(e) => {
                e.preventDefault();
                input("click", e);
              }}
              onWheel={(e) => {
                e.preventDefault();
                input("wheel", e, { delta: e.deltaY });
              }}
              onContextMenu={(e) => e.preventDefault()}
            >
              <canvas
                ref={(el) => {
                  canvas = el;
                }}
                class="block h-full w-full select-none"
                style={{ "object-fit": "contain" }}
                data-frame
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

